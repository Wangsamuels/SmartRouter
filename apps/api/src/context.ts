import { Redis } from 'ioredis'
import { createPublicClient } from 'viem'
import { tempo, tempoModerato } from 'viem/chains'
import { config, needsTls } from '@smartrouter/config'
import { createMediaStore, createProviderRuntime, createSessionServer, tempoTransport, type SessionServer } from '@smartrouter/core'
import { createDb } from '@smartrouter/db'
import { createPrivyVerifier } from './services/privy.js'

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
  const rpc = createPublicClient({ chain, transport: tempoTransport(cfg, { timeoutMs: 5_000, retryCount: 2 }) })

  const providers = createProviderRuntime(cfg, { db })
  const media = createMediaStore(cfg)

  // Paid runs need the treasury, an operator key and MPP_SECRET_KEY; without them only free runs work.
  let sessions: SessionServer | undefined
  try {
    sessions = createSessionServer(cfg, db)
  } catch (e) {
    console.warn(`[mpp] paid runs disabled: ${(e as Error).message}`)
  }

  const privy = cfg.privy.appId ? createPrivyVerifier(cfg.privy.appId) : undefined

  return { cfg, db, sql, redis, rpc, providers, media, sessions, privy, needsTls }
}

export type AppContext = ReturnType<typeof createContext>
