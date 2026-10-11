/**
 * Wallet tracker (every minute):
 *  1. Scans Tempo for payment-token transfers into and out of users' main wallets and records
 *     them in wallet_moves (the activity feed): bridge and card deposits, direct Tempo
 *     deposits, sends made outside the app. AI-balance moves (to/from the escrow) are skipped;
 *     they come from user_sessions.
 *  2. Follows cross-chain sends through Relay until the recipient has the money.
 */
import { createPublicClient, parseAbiItem, type Address } from 'viem'
import { tempo, tempoModerato } from 'viem/chains'
import { createRelayApi, relayMoveStatus, tempoTransport } from '@smartrouter/core'
import { and, eq, inArray, schema, sql } from '@smartrouter/db'
import type { JobDeps } from './index.js'

const TRANSFER = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 amount)')
const CURSOR = 'wallet-transfers'
/** Max blocks per run (~0.56 s blocks: 20k ≈ 3 h of catch-up). */
const MAX_SPAN = 20_000n
/** Payment-channel escrow contracts (mppx defaults); channel state may name others. */
const ESCROWS = ['0x33b901018174ddabe4841042ab76ba85d4e24f25', '0xe1c4d3dce17bc111181ddf716f75bae49e61a336']
const isSystem = (a: string) => a.startsWith('0xfeec') // Tempo fee manager

export async function trackWallets({ cfg, db }: JobDeps) {
  const chain = cfg.network.name === 'tempo' ? tempo : tempoModerato
  const client = createPublicClient({ chain, transport: tempoTransport(cfg, { timeoutMs: 20_000, retryCount: 2 }) })
  const token = cfg.tokens.payment
  const symbol = cfg.network.name === 'tempo' ? 'USDC.e' : 'pathUSD'

  // ---- 1. on-chain transfers ----
  const head = await client.getBlockNumber()
  const [cur] = await db.select().from(schema.chainCursors).where(eq(schema.chainCursors.name, CURSOR))
  const from = cur ? cur.block + 1n : head - 2_000n
  const to = from + MAX_SPAN < head ? from + MAX_SPAN : head
  if (from <= to) {
    const users = await db.select({ id: schema.users.id, address: schema.users.tempoAddress }).from(schema.users)
    const byAddr = new Map(users.map((u) => [u.address.toLowerCase(), u.id]))
    const escrows = new Set([...ESCROWS, ...(await channelEscrows(db))])
    const addrs = [...byAddr.keys()] as Address[]
    for (let i = 0; i < addrs.length; i += 200) {
      const chunk = addrs.slice(i, i + 200)
      const [incoming, outgoing] = await Promise.all([
        client.getLogs({ address: token, event: TRANSFER, args: { to: chunk }, fromBlock: from, toBlock: to }),
        client.getLogs({ address: token, event: TRANSFER, args: { from: chunk }, fromBlock: from, toBlock: to }),
      ])
      for (const log of incoming) {
        const sender = log.args.from!.toLowerCase()
        const userId = byAddr.get(log.args.to!.toLowerCase())
        if (!userId || escrows.has(sender) || isSystem(sender) || byAddr.get(sender) === userId) continue
        const at = await blockTime(client, log.blockNumber)
        await db
          .insert(schema.walletMoves)
          .values({ userId, kind: 'deposit', status: 'completed', amountMicro: log.args.amount!, deliveredMicro: log.args.amount!, chain: 'tempo', token: symbol, counterparty: sender, txHash: log.transactionHash, externalId: `${log.transactionHash}:${log.logIndex}`, createdAt: at, updatedAt: at })
          .onConflictDoNothing()
      }
      for (const log of outgoing) {
        const recipient = log.args.to!.toLowerCase()
        const userId = byAddr.get(log.args.from!.toLowerCase())
        if (!userId || escrows.has(recipient) || isSystem(recipient)) continue
        // A send started in the app: mark it done (Tempo) or leave it to the Relay check (cross-chain).
        const [mine] = await db
          .select()
          .from(schema.walletMoves)
          .where(and(eq(schema.walletMoves.userId, userId), inArray(schema.walletMoves.kind, ['send', 'send_cross_chain']), eq(schema.walletMoves.txHash, log.transactionHash)))
        if (mine) {
          if (mine.kind === 'send' && mine.status === 'pending') await db.update(schema.walletMoves).set({ status: 'completed', deliveredMicro: log.args.amount!, updatedAt: new Date() }).where(eq(schema.walletMoves.id, mine.id))
          continue
        }
        const at = await blockTime(client, log.blockNumber)
        await db
          .insert(schema.walletMoves)
          .values({ userId, kind: 'send', status: 'completed', amountMicro: log.args.amount!, deliveredMicro: log.args.amount!, chain: 'tempo', token: symbol, counterparty: recipient, txHash: log.transactionHash, externalId: `${log.transactionHash}:${log.logIndex}`, detail: { outsideApp: true }, createdAt: at, updatedAt: at })
          .onConflictDoNothing()
      }
    }
    await db
      .insert(schema.chainCursors)
      .values({ name: CURSOR, block: to })
      .onConflictDoUpdate({ target: schema.chainCursors.name, set: { block: to, updatedAt: new Date() } })
  }

  // ---- 2. cross-chain sends in flight ----
  if (cfg.network.name !== 'tempo') return
  const relay = createRelayApi({ apiKey: cfg.relay.apiKey, baseUrl: cfg.relay.url })
  const sends = await db
    .select()
    .from(schema.walletMoves)
    .where(and(eq(schema.walletMoves.kind, 'send_cross_chain'), inArray(schema.walletMoves.status, ['pending', 'refunding']), sql`${schema.walletMoves.txHash} is not null`, sql`${schema.walletMoves.externalId} is not null`))
    .limit(50)
  for (const s of sends) {
    try {
      const st = await relay.status(s.externalId!)
      const status = relayMoveStatus(st.status)
      if (status !== s.status)
        await db
          .update(schema.walletMoves)
          .set({ status, ...(status === 'completed' ? { deliveredMicro: BigInt(String(s.detail?.expectedReceiveMicro ?? s.amountMicro)) } : {}), detail: { ...(s.detail ?? {}), relayStatus: st.status, destinationTx: st.txHashes?.[0] }, updatedAt: new Date() })
          .where(eq(schema.walletMoves.id, s.id))
    } catch (e) {
      console.warn(`[wallet] relay status ${s.externalId} failed: ${(e as Error).message}`)
    }
  }
}

const times = new Map<bigint, Date>()
async function blockTime(client: { getBlock: (a: { blockNumber: bigint }) => Promise<{ timestamp: bigint }> }, n: bigint) {
  const hit = times.get(n)
  if (hit) return hit
  const b = await client.getBlock({ blockNumber: n })
  const d = new Date(Number(b.timestamp) * 1000)
  if (times.size > 500) times.clear()
  times.set(n, d)
  return d
}

/** Escrow contracts named in stored channel state (mppx keeps it per channel). */
async function channelEscrows(db: JobDeps['db']): Promise<string[]> {
  const rows = (await db.execute(sql`select distinct substring(value from '"escrowContract":"(0x[0-9a-fA-F]{40})"') as e from session_store where value like '%escrowContract%' limit 20`)) as unknown as { e: string | null }[]
  return rows.map((r) => r.e?.toLowerCase()).filter((e): e is string => Boolean(e))
}
