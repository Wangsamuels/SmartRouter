import { serve } from '@hono/node-server'
import { createApp } from './app.js'
import { createContext } from './context.js'

const ctx = createContext()
const app = createApp(ctx)

const server = serve({ fetch: app.fetch, port: ctx.cfg.port }, (info) => {
  console.log(`smartrouter-api listening on :${info.port} (${ctx.cfg.network.label}, ${ctx.cfg.version})`)
})

// Heroku sends SIGTERM on restarts/deploys and allows 30s to finish.
const shutdown = async (signal: string) => {
  console.log(`${signal} received, draining`)
  server.close()
  await Promise.allSettled([ctx.sql.end({ timeout: 5 }), ctx.redis?.quit()])
  process.exit(0)
}
process.on('SIGTERM', () => void shutdown('SIGTERM'))
process.on('SIGINT', () => void shutdown('SIGINT'))
