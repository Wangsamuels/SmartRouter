/**
 * Proves the money path end to end: every paid run a user makes reaches the treasury,
 * and the user gets back exactly what they didn't spend.
 *
 *   API_URL=… NETWORK=tempo PAYER_KEY_FILE=.test-user-wallet pnpm treasury:check
 *   options: RUNS=3  DEPOSIT=0.5  WAIT_SETTLE=1 (wait for the worker's mid-session settle)
 *            REFUND_TO=0x…  (after the test, send the payer wallet's balance there)
 *            NETWORK=moderato with no key → throwaway faucet wallet
 *
 * Checks: treasury balance rises by exactly the sum of `done.chargedUsd`; the payer's
 * balance falls by exactly that (fees are sponsored by the operator); the server's
 * books (/sessions/current) agree.
 */
import { readFileSync } from 'node:fs'
import { sessionManager } from 'mppx/client'
import { createClient, createPublicClient, erc20Abi, http, publicActions, walletActions, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempo, tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const NET = process.env.NETWORK === 'tempo' ? 'tempo' : 'moderato'
const chain = NET === 'tempo' ? tempo : tempoModerato
const RPC = NET === 'tempo' ? 'https://rpc.tempo.xyz' : 'https://rpc.moderato.tempo.xyz'
const RUNS = Number(process.env.RUNS ?? 3)
const DEPOSIT = process.env.DEPOSIT ?? '0.5'

const keyFromFile = process.env.PAYER_KEY_FILE ? readFileSync(process.env.PAYER_KEY_FILE, 'utf8').match(/0x[0-9a-fA-F]{64}/)?.[0] : undefined
const key = (keyFromFile ?? process.env.PAYER_KEY ?? (NET === 'moderato' ? generatePrivateKey() : undefined)) as `0x${string}` | undefined
if (!key) throw new Error('mainnet needs PAYER_KEY_FILE or PAYER_KEY')
const account = privateKeyToAccount(key)
const client = createClient({ chain, account, transport: http(RPC) }).extend(publicActions).extend(walletActions)
const pub = createPublicClient({ chain, transport: http(RPC) })

let cookie = ''
const withAuth: typeof fetch = async (input, init) => {
  const h = new Headers(init?.headers)
  h.set('origin', ORIGIN)
  if (cookie) h.set('cookie', cookie)
  const r = await fetch(input, { ...init, headers: h })
  const s = r.headers.get('set-cookie')
  if (s) cookie = s.split(';')[0]!
  return r
}
async function call(method: string, path: string, body?: unknown) {
  const r = await withAuth(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const j: any = await r.json().catch(() => ({}))
  if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j)}`)
  return j
}
const usd = (m: bigint) => `$${(Number(m) / 1e6).toFixed(6)}`
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✔' : '✘'} ${msg}`)
  if (!ok) failures++
}

// ---- setup ----
if (NET === 'moderato' && !keyFromFile && !process.env.PAYER_KEY) await Actions.faucet.fundSync(client as never, { account, timeout: 60_000 })
const { message } = await call('POST', '/auth/challenge', { address: account.address, origin: ORIGIN })
await call('POST', '/auth/verify', { message, signature: await account.signMessage({ message }) })
const cfg = await call('GET', '/sessions/current')
if (!cfg.paidRunsEnabled) throw new Error('paid runs disabled on this server')
const token = cfg.network.token as Address
const treasury = cfg.network.recipient as Address
const bal = (who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })
const t0 = await bal(treasury)
const p0 = await bal(account.address)
console.log(`network ${NET} · token ${token}\npayer ${account.address} ${usd(p0)} · treasury ${treasury} ${usd(t0)} · operator ${cfg.network.operator}`)
if (cfg.session) console.log(`note: payer already has an open session ${cfg.session.channelId}; it will be reused`)

// ---- paid runs ----
const manager = sessionManager({ account, client: client as never, maxDeposit: DEPOSIT, fetch: withAuth })
const chat = await call('POST', '/chats', { taskType: 'chat', slider: 'cheapest' })
let charged = 0n
for (let i = 1; i <= RUNS; i++) {
  const prompt = `Treasury check ${i}: reply with one short sentence about Lagos.`
  const q = await call('POST', `/chats/${chat.chatId}/quote`, { prompt })
  let r: Response
  try {
    r = await manager.fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q.quoteId, prompt }) })
  } catch (e) {
    // The mppx client refuses before sending when the deposit can't cover the next voucher.
    if (/exceeds local maxDeposit/.test(String(e))) {
      console.log(`  run ${i}: deposit used up (client refused: ${String((e as Error).message)}) — the app shows the top-up prompt here`)
      break
    }
    throw e
  }
  const text = await r.text()
  const done = text.split('\n\n').find((b) => b.startsWith('event: done'))
  const err = text.split('\n\n').find((b) => b.startsWith('event: error'))
  if (done) {
    const d = JSON.parse(done.split('data: ')[1]!)
    charged += BigInt(Math.round(d.chargedUsd * 1e6))
    console.log(`  run ${i}: ${q.modelId} charged $${d.chargedUsd} — ${String(d.text ?? '').slice(0, 70).replace(/\n/g, ' ')}`)
    if (d.usage?.alert) console.log(`    usage alert: ${d.usage.alert.level} · ${d.usage.alert.message} · action ${d.usage.alert.action}`)
  } else console.log(`  run ${i}: ${r.status} ${err ?? text.slice(0, 200)}`)
}
const s1 = (await call('GET', '/sessions/current')).session
check(Boolean(s1) && BigInt(Math.round(s1.spentUsd * 1e6)) === charged, `server books: spent ${s1 && '$' + s1.spentUsd} = charged ${usd(charged)}`)

// ---- optional: mid-session settle by the worker ----
if (process.env.WAIT_SETTLE) {
  console.log('waiting for the worker to settle (needs the channel idle for SETTLE_IDLE_MINUTES)…')
  const deadline = Date.now() + 25 * 60_000
  let s = s1
  while (Date.now() < deadline && !(s?.settledUsd >= s?.spentUsd)) {
    await sleep(20_000)
    s = (await call('GET', '/sessions/current')).session
    process.stdout.write(`  settled $${s?.settledUsd} of $${s?.spentUsd}\r`)
  }
  const t1 = await bal(treasury)
  check(t1 - t0 === charged, `worker settle: treasury +${usd(t1 - t0)} (expected ${usd(charged)})`)
}

// ---- close: treasury keeps spent, payer gets the rest ----
const closed = await manager.close()
console.log(`closed: tx ${closed?.txHash}`)
await sleep(2_000)
const t2 = await bal(treasury)
const p2 = await bal(account.address)
check(t2 - t0 === charged, `treasury received ${usd(t2 - t0)} = charged ${usd(charged)}`)
check(p0 - p2 === charged, `payer paid ${usd(p0 - p2)} = charged ${usd(charged)} (no fees: operator sponsored them)`)
const s2 = await call('GET', '/sessions/current')
check(!s2.session, 'no open session left')

// ---- optional: sweep the payer wallet ----
if (process.env.REFUND_TO) {
  const to = process.env.REFUND_TO as Address
  const left = await bal(account.address)
  // The transfer's fee is paid in the same token, so leave a small margin, then sweep what's left.
  for (const margin of [3_000n, 1_000n]) {
    const amt = (await bal(account.address)) - margin
    if (amt <= 0n) break
    try {
      const hash = await client.writeContract({ address: token, abi: erc20Abi, functionName: 'transfer', args: [to, amt], feeToken: token } as never)
      await pub.waitForTransactionReceipt({ hash })
      console.log(`sent ${usd(amt)} to ${to} (tx ${hash})`)
    } catch (e) {
      console.log(`sweep with margin ${margin} failed: ${(e as Error).message.slice(0, 160)}`)
    }
  }
  console.log(`payer had ${usd(left)}; now ${usd(await bal(account.address))} (dust left for fees)`)
}

console.log(failures ? `\nTREASURY CHECK FAILED (${failures})` : '\nTREASURY CHECK OK')
process.exit(failures ? 1 : 0)
