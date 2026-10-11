/** Profit sweep (every 15 min): revenue wallet → PROFIT_ADDRESS once profit ≥ $20, or every 24 h. */
import { sweepProfit } from '@smartrouter/core'
import type { JobDeps } from './index.js'

const usd = (m: bigint) => (Number(m) / 1e6).toFixed(2)

export async function profitSweep({ cfg, db, sessions }: JobDeps) {
  if (!sessions) return
  const r = await sweepProfit(cfg, db, sessions)
  if (r.sweep) console.log(`[sweep] sent $${usd(r.profit)} profit to ${cfg.revenue.profitAddress} (${r.reason}); tx ${r.txHash}`)
  else if (r.balance > 0n) console.log(`[sweep] skipped (${r.reason}): balance $${usd(r.balance)}, profit $${usd(r.profit)}`)
}
