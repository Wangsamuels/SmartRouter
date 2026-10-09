import type PgBoss from 'pg-boss'
import type { Config } from '@smartrouter/config'
import { buildCatalog, createProviderRuntime, writeCatalog } from '@smartrouter/core'
import type { Db } from '@smartrouter/db'

/**
 * Job registry. Each entry: queue name, cron (UTC), handler.
 * Step 7 adds: settle-user-sessions (every 5 min), close-idle-sessions (15 min),
 * provider-health (5 min), hot-wallet-alert (15 min), treasury-swap (daily),
 * reconciliation (03:00 UTC). Suno/StableStudio polling is enqueued per job, not cron.
 */
export type JobDeps = { cfg: Config; db: Db; boss: PgBoss }
export type JobDef = { name: string; cron: string; handler: (deps: JobDeps) => Promise<void> }

export async function refreshCatalog({ cfg, db }: Pick<JobDeps, 'cfg' | 'db'>) {
  const runtime = createProviderRuntime(cfg) // quotes only: reads 402 prices, never pays
  const report = await buildCatalog({ adapters: runtime.adapters })
  await writeCatalog(db, report)
  console.log(`[catalog] ${report.rows.filter((r) => r.active).length}/${report.rows.length} active; ${report.warnings.length} warnings`)
  for (const w of report.warnings) console.log(`[catalog] warn: ${w}`)
}

export const jobs: JobDef[] = [
  {
    name: 'heartbeat',
    cron: '*/5 * * * *',
    handler: async () => {
      console.log(`[heartbeat] worker alive ${new Date().toISOString()}`)
    },
  },
  { name: 'catalog-refresh', cron: '0 2 * * *', handler: refreshCatalog },
]
