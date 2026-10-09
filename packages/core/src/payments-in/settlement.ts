/**
 * Getting paid: moving what users spent from escrow to the treasury.
 *
 *   settle  — mid-session. The escrow only settles a full signed voucher, so this is used
 *             only when the voucher equals `spent` (no refunded requests in the channel).
 *   close   — operator closes the channel with the latest voucher, capturing exactly
 *             `spent`; the escrow returns deposit − spent to the user. Used for idle
 *             channels, channels with refunds, and when the user asked the chain to close.
 *
 * Every confirmed transaction becomes a treasury_moves row (kind settle|close, amount =
 * what reached the treasury in that tx) and updates user_sessions, so the books can be
 * reconciled against the chain.
 */
import { tempo } from 'mppx/server'
import { Session } from 'mppx/tempo'
import type { Hex } from 'viem'
import { eq, sql, schema, type Db } from '@smartrouter/db'
import type { ChannelState, SessionServer } from './server.js'

const Chain = Session.Precompile.Chain

export async function recordSettlement(
  db: Db,
  token: string,
  e: { channelId: string; txHash: string; kind: 'settle' | 'close'; totalSettled: bigint; delta: bigint },
) {
  const channelId = e.channelId.toLowerCase()
  await db
    .insert(schema.treasuryMoves)
    .values({ kind: e.kind, amountMicro: e.delta, token, txHash: e.txHash, refId: channelId, status: 'confirmed' })
    .onConflictDoNothing()
  await db
    .update(schema.userSessions)
    .set({
      settledMicro: e.totalSettled,
      lastSettleTx: e.txHash,
      lastSettledAt: new Date(),
      ...(e.kind === 'close' ? { status: 'closed' as const } : {}),
    })
    .where(eq(schema.userSessions.channelId, channelId))
  console.log(`[treasury] ${e.kind} ${channelId.slice(0, 10)}… +${Number(e.delta) / 1e6} USD (total ${Number(e.totalSettled) / 1e6}) tx ${e.txHash}`)
}

const voucherAmount = (s: ChannelState) => (s.highestVoucher ? BigInt(s.highestVoucher.cumulativeAmount) : 0n)

/** Settles the channel's voucher to the treasury, if that equals what the user really spent. */
export async function settleChannel(sessions: SessionServer, db: Db, token: string, channelId: string): Promise<{ txHash?: Hex; skipped?: string }> {
  const s = await sessions.getChannel(channelId)
  if (!s) return { skipped: 'unknown channel' }
  if (s.finalized) return { skipped: 'closed' }
  const v = voucherAmount(s)
  if (s.spent <= s.settledOnChain) return { skipped: 'nothing to settle' }
  if (v !== s.spent) return { skipped: 'voucher includes refunded requests; collect on close' }
  const txHash = await tempo.settle(sessions.store, sessions.client, channelId as Hex, {
    account: sessions.operator,
    // Pay the fee in the channel's stablecoin: the operator may hold nothing else (mainnet: USDC.e only).
    feeToken: s.token,
    onSessionSettlement: (e) => recordSettlement(db, token, { channelId: e.channelId, txHash: e.txHash, kind: 'settle', totalSettled: e.amount, delta: e.delta }),
  })
  return { txHash }
}

/**
 * Operator close: treasury gets `spent`, the user gets the rest of the deposit back.
 * Safe to call while the user has a pending on-chain close request (it pre-empts the
 * user's withdraw, which would otherwise take back money they already spent).
 */
export async function closeChannel(sessions: SessionServer, db: Db, token: string, channelId: string): Promise<{ txHash?: Hex; captured?: bigint; refunded?: bigint; skipped?: string }> {
  const s = await sessions.getChannel(channelId)
  if (!s) return { skipped: 'unknown channel' }
  if (s.finalized) return { skipped: 'already closed' }
  const onChain = await Chain.getChannelState(sessions.client, channelId as Hex, s.escrowContract)
  if (onChain.deposit === 0n) {
    // Already closed or withdrawn on-chain (e.g. by the user's own close).
    await sessions.store.update(channelId.toLowerCase(), (cur) => ({ op: 'set', value: { ...(cur as ChannelState), finalized: true }, result: null }))
    await db.update(schema.userSessions).set({ status: 'closed' }).where(eq(schema.userSessions.channelId, channelId.toLowerCase()))
    return { skipped: 'closed on-chain' }
  }
  const v = voucherAmount(s)
  const capture = s.spent > onChain.settled ? s.spent : onChain.settled
  if (!s.highestVoucher || !s.descriptor) {
    // No voucher ever accepted (channel opened, never used): nothing to capture, and no signature to close with.
    return { skipped: 'no voucher' }
  }
  if (capture > v) return { skipped: `spent ${capture} exceeds voucher ${v}` }
  if (capture > onChain.deposit) return { skipped: 'capture exceeds deposit' }

  const txHash = await Chain.closeOnChain(sessions.client, s.descriptor as never, v, capture, s.highestVoucher.signature, s.escrowContract, {
    account: sessions.operator,
    feeToken: s.token,
    candidateFeeTokens: [s.token],
  })
  const receipt = await Chain.waitForSuccessfulReceipt(sessions.client, txHash)
  const closed = Chain.readChannelClosedReceiptFields(Chain.getChannelEvent(receipt, 'ChannelClosed', channelId as Hex))
  await sessions.store.update(channelId.toLowerCase(), (cur) => ({
    op: 'set',
    value: { ...(cur as ChannelState), finalized: true, settledOnChain: onChain.settled + closed.settledToPayee },
    result: null,
  }))
  await recordSettlement(db, token, { channelId, txHash, kind: 'close', totalSettled: onChain.settled + closed.settledToPayee, delta: closed.settledToPayee })
  return { txHash, captured: closed.settledToPayee, refunded: closed.refundedToPayer }
}

/**
 * One pass of the settlement job over open channels:
 *  - user requested a close on-chain → close now (capture spent before their withdraw)
 *  - unused for idleCloseMs → close (user gets the rest back)
 *  - quiet for settleIdleMs and owes ≥ settleMinMicro → settle
 * Channels with a request still running are skipped this pass.
 */
export async function runSettlementPass(
  sessions: SessionServer,
  db: Db,
  opts: { token: string; settleIdleMs: number; settleMinMicro: bigint; idleCloseMs: number; now?: number },
) {
  const now = opts.now ?? Date.now()
  const open = await db.select().from(schema.userSessions).where(eq(schema.userSessions.status, 'open'))
  const out: { channelId: string; action: string; detail?: string }[] = []
  for (const row of open) {
    const id = row.channelId
    try {
      const busy = await db.execute(sql`select 1 from requests where channel_id = ${id} and status in ('pending','running') limit 1`)
      if ((busy as unknown[]).length) {
        out.push({ channelId: id, action: 'skip', detail: 'request in flight' })
        continue
      }
      const s = await sessions.getChannel(id)
      if (!s || s.finalized) {
        await db.update(schema.userSessions).set({ status: 'closed' }).where(eq(schema.userSessions.channelId, id))
        out.push({ channelId: id, action: 'mark-closed' })
        continue
      }
      const onChain = await Chain.getChannelState(sessions.client, id as Hex, s.escrowContract)
      const idleMs = now - row.lastUsedAt.getTime()
      if (onChain.closeRequestedAt !== 0 || idleMs >= opts.idleCloseMs) {
        const r = await closeChannel(sessions, db, opts.token, id)
        out.push({ channelId: id, action: r.txHash ? 'close' : 'skip', detail: r.skipped ?? `captured ${r.captured} refunded ${r.refunded}` })
        continue
      }
      const owed = s.spent - (s.settledOnChain > onChain.settled ? s.settledOnChain : onChain.settled)
      if (idleMs >= opts.settleIdleMs && owed > 0n && owed >= opts.settleMinMicro) {
        const r = await settleChannel(sessions, db, opts.token, id)
        out.push({ channelId: id, action: r.txHash ? 'settle' : 'skip', detail: r.skipped ?? `owed ${owed}` })
      }
    } catch (e) {
      out.push({ channelId: id, action: 'error', detail: (e as Error).message.slice(0, 300) })
    }
  }
  return out
}
