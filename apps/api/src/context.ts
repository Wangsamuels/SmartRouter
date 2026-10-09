import { Redis } from 'ioredis'
import { createPublicClient, http } from 'viem'
import { tempo, tempoModerato } from 'viem/chains'
import { config, needsTls } from '@smartrouter/config'
import { createProviderRuntime } from '@smartrouter/core'
import { createDb } from '@smartrouter/db'

/** Process-wide singletons. No request state lives here (dynos restart daily). */
export function createContext() {
  const cfg = config()
  const { db, sql } = createDb(cfg.db.url)

  const redis = cfg.redis.url
    ? new Redis(cfg.redis.url, {
        // Heroku Key-Value Store uses TLS with a self-signed cert.
        tls: cfg.redis.url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        enableOfflineQueue: false,
      })
    : undefined
  redis?.on('error', (e) => console.warn('[redis]', e.message))
  redis?.connect().catch(() => {})

  // Chain-aware client: verifies Tempo passkey signature envelopes as well as plain EOA signatures.
  const chain = cfg.network.name === 'tempo' ? tempo : tempoModerato
  const rpc = createPublicClient({ chain, transport: http(cfg.network.rpcUrl, { timeout: 5_000, retryCount: 1 }) })

  const providers = createProviderRuntime(cfg, { db })

  return { cfg, db, sql, redis, rpc, providers, needsTls }
}

export type AppContext = ReturnType<typeof createContext>
