/**
 * Usage for the in-app banners ("You've used 75% of your weekly limit · Get more usage").
 * Two meters: the weekly limit (users.weekly_limit_micro, all paid runs in the last 7 days)
 * and the current deposit (the open payment session). Alert levels: 75% warning, 90%
 * critical, 100% exhausted; the banner shows the highest of the two meters.
 */
import { channelRemaining, type ChannelState } from '@smartrouter/core'
import { and, desc, eq, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'

export type AlertLevel = 'warning' | 'critical' | 'exhausted'
export type Usage = {
  weekly: { spentUsd: number; limitUsd: number; usedPct: number }
  deposit: { channelId: string; depositUsd: number; spentUsd: number; remainingUsd: number; usedPct: number } | null
  alert: { level: AlertLevel; meter: 'weekly' | 'deposit'; usedPct: number; message: string; action: 'top_up' | 'raise_limit' } | null
}

const usd = (m: bigint) => Number(m) / 1e6
const pct = (part: bigint, whole: bigint) => (whole > 0n ? Math.min(100, Math.floor(Number((part * 10_000n) / whole) / 100)) : 0)
const level = (p: number): AlertLevel | undefined => (p >= 100 ? 'exhausted' : p >= 90 ? 'critical' : p >= 75 ? 'warning' : undefined)

export async function weeklySpentMicro(ctx: AppContext, userId: string): Promise<bigint> {
  const [row] = await ctx.db
    .select({ total: sql<string>`coalesce(sum(${schema.requests.priceMicro}),0)::text` })
    .from(schema.requests)
    .where(and(eq(schema.requests.userId, userId), sql`${schema.requests.status} in ('pending','running','succeeded')`, sql`${schema.requests.createdAt} > now() - interval '7 days'`))
  return BigInt(row?.total ?? '0')
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

export async function usageFor(ctx: AppContext, user: { id: string; weeklyLimitMicro: bigint }, open?: Awaited<ReturnType<typeof openChannel>> | null): Promise<Usage> {
  const spent = await weeklySpentMicro(ctx, user.id)
  const weekly = { spentUsd: usd(spent), limitUsd: usd(user.weeklyLimitMicro), usedPct: pct(spent, user.weeklyLimitMicro) }
  const ch = open === undefined ? await openChannel(ctx, user.id) : open
  const deposit = ch
    ? {
        channelId: ch.row.channelId,
        depositUsd: usd(ch.state.deposit),
        spentUsd: usd(ch.state.spent),
        remainingUsd: usd(channelRemaining(ch.state)),
        usedPct: pct(ch.state.spent, ch.state.deposit),
      }
    : null
  const candidates = [
    { meter: 'weekly' as const, usedPct: weekly.usedPct },
    ...(deposit ? [{ meter: 'deposit' as const, usedPct: deposit.usedPct }] : []),
  ].sort((a, b) => b.usedPct - a.usedPct)
  const top = candidates[0]
  const lvl = top ? level(top.usedPct) : undefined
  const alert =
    top && lvl
      ? {
          level: lvl,
          meter: top.meter,
          usedPct: top.usedPct,
          action: top.meter === 'deposit' ? ('top_up' as const) : ('raise_limit' as const),
          message:
            top.meter === 'deposit'
              ? lvl === 'exhausted'
                ? 'Your balance is used up'
                : `You've used ${top.usedPct}% of your balance`
              : lvl === 'exhausted'
                ? "You've reached your weekly limit"
                : `You've used ${top.usedPct}% of your weekly limit`,
        }
      : null
  return { weekly, deposit, alert }
}
