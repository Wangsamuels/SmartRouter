/**
 * Collect what users spent: settle quiet channels to the treasury and close idle ones
 * (users get the unspent deposit back). See core/payments-in/settlement.ts for the rules.
 */
import { alert, runSettlementPass } from '@smartrouter/core'
import type { JobDeps } from './index.js'

export async function settleSessions({ cfg, db, sessions }: JobDeps) {
  if (!sessions) return
  const results = await runSettlementPass(sessions, db, {
    token: cfg.tokens.payment,
    settleIdleMs: cfg.mpp.settleIdleMs,
    settleMinMicro: cfg.mpp.settleMinMicro,
    idleCloseMs: cfg.mpp.idleCloseMs,
  })
  for (const r of results.filter((r) => r.action !== 'skip' || r.detail !== 'request in flight')) {
    if (r.action === 'error') alert(`settlement failed for ${r.channelId}: ${r.detail}`, { channelId: r.channelId })
    else console.log(`[settle] ${r.action} ${r.channelId.slice(0, 10)}… ${r.detail ?? ''}`)
  }
}
