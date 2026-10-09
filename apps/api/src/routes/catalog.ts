import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { estimateTokens, FREE_MODEL_ID, classifyTask } from '@smartrouter/core'
import { schema } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthVars } from '../middleware/auth.js'
import { activeModels, findModel, publicModel } from '../services/catalog.js'
import { recommendOptions } from '../services/quotes.js'

const TaskTypeZ = z.enum(['chat', 'writing', 'coding', 'research', 'translation', 'image', 'music'])

export function catalogRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()

  app.get('/catalog', zValidator('query', z.object({ taskType: TaskTypeZ.optional() })), async (c) => {
    const { taskType } = c.req.valid('query')
    const models = (await activeModels(ctx)).filter((m) => !taskType || m.taskTypes.includes(taskType))
    return c.json({
      models: models.map(publicModel),
      attribution: 'Quality data: LMArena (CC BY 4.0). Prices: live from each provider via MPP.',
    })
  })

  /** One-off recommendation without a chat (chats use POST /chats and /chats/:id/quote). */
  app.post(
    '/recommend',
    requireAuth(ctx),
    zValidator('json', z.object({ prompt: z.string().min(1).max(8_000), slider: z.enum(['cheapest', 'balanced', 'best']).optional(), taskType: TaskTypeZ.optional() })),
    async (c) => {
      const user = c.get('user')
      const b = c.req.valid('json')
      const free = await findModel(ctx, FREE_MODEL_ID)
      const cls = await classifyTask(b.prompt, free ? { adapter: ctx.providers.adapterFor(free.ref), model: free.ref } : undefined)
      const taskType = b.taskType ?? cls.taskType
      const input = { taskType, complexity: cls.complexity, prompt: b.prompt, contextTokens: estimateTokens(b.prompt) + 10 }
      const { options, freeRemainingToday } = await recommendOptions(ctx, { userId: user.id, input, slider: b.slider ?? user.slider, withQuotes: true })
      return c.json({ taskType, complexity: cls.complexity, classifiedBy: cls.source, options, freeRemainingToday })
    },
  )

  app.post('/waitlist', zValidator('json', z.object({ email: z.string().email().max(200), interest: z.enum(['naira', 'credits']), country: z.string().length(2).optional() })), async (c) => {
    const b = c.req.valid('json')
    await ctx.db.insert(schema.waitlist).values({ email: b.email.toLowerCase(), interest: b.interest, country: b.country?.toUpperCase() }).onConflictDoNothing()
    return c.json({ ok: true })
  })

  return app
}
