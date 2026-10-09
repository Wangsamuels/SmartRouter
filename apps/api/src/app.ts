import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import type { AppContext } from './context.js'
import { notFound, onError } from './middleware/error.js'
import { requestId } from './middleware/request-id.js'
import { authRoutes } from './routes/auth.js'
import { catalogRoutes } from './routes/catalog.js'
import { chatRoutes } from './routes/chats.js'
import { healthRoutes } from './routes/health.js'

export function createApp(ctx: AppContext) {
  const app = new Hono()
  app.use('*', requestId)
  app.use('*', logger())
  app.use('*', secureHeaders())
  app.use(
    '*',
    cors({
      // Credentials (the session cookie) require an explicit origin, never '*'.
      origin: (o) => (ctx.cfg.app.origins.includes(o) ? o : null),
      credentials: true,
      allowHeaders: ['content-type', 'authorization', 'x-request-id'],
      exposeHeaders: ['Payment-Receipt', 'WWW-Authenticate', 'x-request-id'],
    }),
  )

  app.get('/', (c) => c.json({ name: 'smartrouter-api', network: ctx.cfg.network.name, version: ctx.cfg.version }))
  app.route('/', healthRoutes(ctx))
  app.route('/', authRoutes(ctx))
  app.route('/', catalogRoutes(ctx))
  app.route('/', chatRoutes(ctx))
  // Step 6 mounts: /run, /requests, /sessions, /feedback, /compare

  app.onError(onError)
  app.notFound(notFound)
  return app
}
