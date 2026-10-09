/**
 * Nightly reconciliation (03:15 UTC):
 *  1. Every channel: sum of succeeded paid requests must equal the channel's `spent`.
 *  2. Every finished channel: what reached the treasury must equal `spent`.
 *  3. Yesterday's totals: revenue, provider cost, margin, treasury inflow, refunds.
 * Mismatches are `[alert]` lines.
 */
import { sql } from '@smartrouter/db'
import { alert } from '@smartrouter/core'
import type { JobDeps } from './index.js'

const usd = (m: bigint | string | number) => (Number(m) / 1e6).toFixed(4)

export async function reconcile({ db, sessions }: JobDeps) {
  let problems = 0
  if (sessions) {
    const rows = (await db.execute(sql`
      select s.channel_id, s.status,
             coalesce((select sum(r.price_micro) from requests r where r.channel_id = s.channel_id and r.status = 'succeeded'), 0)::text as billed,
             coalesce((select count(*) from requests r where r.channel_id = s.channel_id and r.status in ('pending','running')), 0)::int as in_flight,
             coalesce((select sum(m.amount_micro) from treasury_moves m where m.ref_id = s.channel_id and m.kind in ('settle','close') and m.status = 'confirmed'), 0)::text as received
      from user_sessions s
      where s.last_used_at > now() - interval '8 days'`)) as unknown as { channel_id: string; status: string; billed: string; in_flight: number; received: string }[]
    for (const r of rows) {
      if (r.in_flight) continue
      const state = await sessions.getChannel(r.channel_id)
      if (!state) continue
      if (state.spent !== BigInt(r.billed)) {
        problems++
        alert(`reconcile ${r.channel_id}: channel spent $${usd(state.spent)} ≠ billed requests $${usd(r.billed)}`)
      }
      if (r.status === 'closed' && BigInt(r.received) !== state.spent) {
        problems++
        alert(`reconcile ${r.channel_id}: closed, treasury received $${usd(r.received)} ≠ spent $${usd(state.spent)}`)
      }
    }
  }
  const [t] = (await db.execute(sql`
    select
      coalesce(sum(price_micro) filter (where status = 'succeeded' and not is_free), 0)::text as revenue,
      coalesce(sum(provider_cost_micro) filter (where status in ('succeeded','failed')), 0)::text as provider_cost,
      count(*) filter (where status = 'failed' and not is_free)::int as refunded_runs,
      count(*) filter (where status = 'succeeded')::int as runs,
      count(*) filter (where is_free and status = 'succeeded')::int as free_runs
    from requests where created_at >= date_trunc('day', now() at time zone 'utc') - interval '1 day'
                    and created_at < date_trunc('day', now() at time zone 'utc')`)) as unknown as Record<string, string | number>[]
  const [m] = (await db.execute(sql`
    select coalesce(sum(amount_micro), 0)::text as inflow from treasury_moves
    where kind in ('settle','close') and status = 'confirmed'
      and created_at >= date_trunc('day', now() at time zone 'utc') - interval '1 day' and created_at < date_trunc('day', now() at time zone 'utc')`)) as unknown as { inflow: string }[]
  console.log(
    `[reconcile] yesterday: runs ${t!.runs} (free ${t!.free_runs}), revenue $${usd(t!.revenue!)}, provider cost $${usd(t!.provider_cost!)}, margin $${usd(BigInt(t!.revenue as string) - BigInt(t!.provider_cost as string))}, treasury inflow $${usd(m!.inflow)}, refunded runs ${t!.refunded_runs}; ${problems} mismatches`,
  )
}
