/**
 * Spending caps and usage banners ("You've used 80% of today's cap · Raise cap").
 *
 * The user sets a daily cap (resets 00:00 UTC) and a weekly cap (last 7 days). Both are
 * enforced on every paid answer. The money for answers is moved into Tempo's payment contract
 * automatically, in small deposits (DEPOSIT_CHUNK_USD, never more than what's left of either
 * cap); the user never manages that "agent wallet" by hand. A Tempo access key with an on-chain
 * daily limit (the spending key) backs the caps up at the protocol level.
 *
 * Alert levels: 75% warning, 90% critical, 100% exhausted; the banner shows the fuller cap.
 * A low main-wallet balance (can't fund the next deposit) is its own alert.
 */
import { channelRemaining, type ChannelState } from '@smartrouter/core'
import { and, desc, eq, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'

export type AlertLevel = 'warning' | 'critical' | 'exhausted'
type Meter = { spentUsd: number; limitUsd: number; usedPct: number; remainingUsd: number }
export type Usage = {
  daily: Meter & { resetsAt: string }
  weekly: Meter
  /** Money currently locked in the payment contract for answers (the automatic deposit). */
  deposit: { channelId: string; depositUsd: number; spentUsd: number; remainingUsd: number; usedPct: number } | null
  /** Size of the next automatic deposit: min(chunk, what's left today, what's left this week). */
  nextDepositUsd: number
  alert: { level: AlertLevel; meter: 'daily' | 'weekly' | 'balance'; usedPct: number; message: string; action: 'raise_limit' | 'add_funds' } | null
}

export type CapUser = { id: string; weeklyLimitMicro: bigint; dailyLimitMicro: bigint }

const usd = (m: bigint) => Number(m) / 1e6
const pct = (part: bigint, whole: bigint) => (whole > 0n ? Math.min(100, Math.floor(Number((part * 10_000n) / whole) / 100)) : 100)
const level = (p: number): AlertLevel | undefined => (p >= 100 ? 'exhausted' : p >= 90 ? 'critical' : p >= 75 ? 'warning' : undefined)
const min = (...xs: bigint[]) => xs.reduce((a, b) => (b < a ? b : a))
const pos = (x: bigint) => (x > 0n ? x : 0n)

async function spentSince(ctx: AppContext, userId: string, since: ReturnType<typeof sql>): Promise<bigint> {
  const [row] = await ctx.db
    .select({ total: sql<string>`coalesce(sum(${schema.requests.priceMicro}),0)::text` })
    .from(schema.requests)
    .where(and(eq(schema.requests.userId, userId), sql`${schema.requests.status} in ('pending','running','succeeded')`, sql`${schema.requests.createdAt} > ${since}`))
  return BigInt(row?.total ?? '0')
}

export const weeklySpentMicro = (ctx: AppContext, userId: string) => spentSince(ctx, userId, sql`now() - interval '7 days'`)
export const dailySpentMicro = (ctx: AppContext, userId: string) => spentSince(ctx, userId, sql`date_trunc('day', now() at time zone 'utc') at time zone 'utc'`)

/** What a paid answer of `priceMicro` would breach, if anything. */
export async function capCheck(ctx: AppContext, user: CapUser, priceMicro: bigint): Promise<{ reason: 'daily_limit' | 'weekly_limit'; limitMicro: bigint } | undefined> {
  const [day, week] = await Promise.all([dailySpentMicro(ctx, user.id), weeklySpentMicro(ctx, user.id)])
  if (day + priceMicro > user.dailyLimitMicro) return { reason: 'daily_limit', limitMicro: user.dailyLimitMicro }
  if (week + priceMicro > user.weeklyLimitMicro) return { reason: 'weekly_limit', limitMicro: user.weeklyLimitMicro }
  return undefined
}

/** The user's open, usable payment session (newest first). */
export async function openChannel(ctx: AppContext, userId: string): Promise<{ row: typeof schema.userSessions.$inferSelect; state: ChannelState } | undefined> {
  if (!ctx.sessions) return undefined
  const rows = await ctx.db
    .select()
    .from(schema.userSessions)
    .where(and(eq(schema.userSessions.userId, userId), eq(schema.userSessions.status, 'open')))
    .orderBy(desc(schema.userSessions.lastUsedAt))
    .limit(3)
  for (const row of rows) {
    const state = await ctx.sessions.getChannel(row.channelId)
    if (state && !state.finalized && state.closeRequestedAt === 0n) return { row, state }
  }
  return undefined
}

export async function usageFor(ctx: AppContext, user: CapUser, open?: Awaited<ReturnType<typeof openChannel>> | null, opts: { mainBalanceMicro?: bigint } = {}): Promise<Usage> {
  const [daySpent, weekSpent] = await Promise.all([dailySpentMicro(ctx, user.id), weeklySpentMicro(ctx, user.id)])
  const dayLeft = pos(user.dailyLimitMicro - daySpent)
  const weekLeft = pos(user.weeklyLimitMicro - weekSpent)
  const tomorrow = new Date()
  tomorrow.setUTCHours(24, 0, 0, 0)
  const daily = { spentUsd: usd(daySpent), limitUsd: usd(user.dailyLimitMicro), usedPct: pct(daySpent, user.dailyLimitMicro), remainingUsd: usd(dayLeft), resetsAt: tomorrow.toISOString() }
  const weekly = { spentUsd: usd(weekSpent), limitUsd: usd(user.weeklyLimitMicro), usedPct: pct(weekSpent, user.weeklyLimitMicro), remainingUsd: usd(weekLeft) }
  const ch = open === undefined ? await openChannel(ctx, user.id) : open
  const deposit = ch
    ? { channelId: ch.row.channelId, depositUsd: usd(ch.state.deposit), spentUsd: usd(ch.state.spent), remainingUsd: usd(channelRemaining(ch.state)), usedPct: pct(ch.state.spent, ch.state.deposit) }
    : null
  const next = min(ctx.cfg.pricing.depositChunkMicro, dayLeft, weekLeft)

  const cap = daily.usedPct >= weekly.usedPct ? { meter: 'daily' as const, usedPct: daily.usedPct } : { meter: 'weekly' as const, usedPct: weekly.usedPct }
  const lvl = level(cap.usedPct)
  let alert: Usage['alert'] = lvl
    ? {
        level: lvl,
        meter: cap.meter,
        usedPct: cap.usedPct,
        action: 'raise_limit',
        message:
          lvl === 'exhausted'
            ? cap.meter === 'daily'
              ? "You've reached today's spending cap"
              : "You've reached this week's spending cap"
            : `You've used ${cap.usedPct}% of ${cap.meter === 'daily' ? "today's" : "this week's"} spending cap`,
      }
    : null
  // Can't fund the next automatic deposit (and nothing left locked): ask for funds before the cap matters.
  const lockedLeft = ch ? channelRemaining(ch.state) : 0n
  if (alert?.level !== 'exhausted' && opts.mainBalanceMicro !== undefined && next > 0n && lockedLeft < 10_000n && opts.mainBalanceMicro < next) {
    alert = { level: opts.mainBalanceMicro === 0n ? 'exhausted' : 'critical', meter: 'balance', usedPct: 100, action: 'add_funds', message: opts.mainBalanceMicro === 0n ? 'Your wallet is empty' : 'Your wallet balance is low' }
  }
  return { daily, weekly, deposit, nextDepositUsd: usd(next), alert }
}
