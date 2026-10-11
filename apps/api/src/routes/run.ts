/**
 * POST /run — runs a quote. Free models: checked against the daily free limits, no payment.
 * Paid models: an MPP session payment for exactly the quoted price.
 *
 * Paid flow (mppx client does this automatically):
 *   1. POST /run { quoteId, prompt }            → 402 + WWW-Authenticate challenge (amount = quote price)
 *   2. same request + Authorization: Payment …  → voucher accepted, price charged, answer streams (SSE)
 *   If the model fails, the charge is refunded (never charged for failed results).
 *
 * Body-less POSTs carrying a Payment credential are channel management (open with no
 * content, top-up, close) and are answered by mppx directly (204).
 */
import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { Challenge, Credential, Receipt } from 'mppx'
import { Mppx } from 'mppx/server'
import { FREE_MODEL_ID, channelRemaining, classifyByRules, estimateTokens, type ChannelState, type TaskType } from '@smartrouter/core'
import { and, desc, eq, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthUser, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'
import { findModel, type CatalogModel } from '../services/catalog.js'
import { freeRemaining, freeSpentToday, promptHash, type TaskInput } from '../services/quotes.js'
import { runAndStream, SSE_HEADERS, sseStream, type RunArgs } from '../services/runner.js'
import { concurrency } from '../middleware/rate-limit.js'
import { SYSTEM_PROMPT, turnInput, type ChatRow } from '../services/turns.js'
import { usageFor, weeklySpentMicro } from '../services/usage.js'

const RunBody = z.object({
  quoteId: z.string().uuid(),
  prompt: z.string().min(1).max(32_000),
  /** Set by the frontend's side-by-side compare: both runs share one group id. */
  compareGroup: z.string().uuid().optional(),
})
type QuoteRow = typeof schema.quotes.$inferSelect

const usd = (micro: bigint) => Number(micro) / 1e6
/** Nominal amount for a challenge issued only so the client can open / top up / close. */
const MANAGEMENT_AMOUNT_MICRO = 1_000n
/** Answers one user can have streaming at once (Redis-backed, across dynos). */
const MAX_CONCURRENT_RUNS = 3

export function runRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()
  app.use('/run', requireAuth(ctx))
  app.use('/sessions/*', requireAuth(ctx))

  // ---------- helpers ----------
  const hasPayment = (r: Request) => /^payment\s/i.test(r.headers.get('authorization') ?? '')

  async function currentChannel(userId: string): Promise<{ row: typeof schema.userSessions.$inferSelect; state: ChannelState } | undefined> {
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

  /** Records which user owns a channel (payer must be the signed-in wallet). */
  async function recordChannel(user: AuthUser, channelId: string): Promise<ChannelState | undefined> {
    const state = await ctx.sessions!.getChannel(channelId)
    if (!state || state.payer.toLowerCase() !== user.tempoAddress) return undefined
    const values = {
      payer: state.payer.toLowerCase(),
      authorizedSigner: state.authorizedSigner?.toLowerCase(),
      depositMicro: state.deposit,
      highestVoucherMicro: state.highestVoucherAmount,
      lastUsedAt: new Date(),
      status: state.finalized ? ('closed' as const) : ('open' as const),
    }
    await ctx.db
      .insert(schema.userSessions)
      .values({ channelId: channelId.toLowerCase(), userId: user.id, ...values })
      .onConflictDoUpdate({ target: schema.userSessions.channelId, set: values })
    return state
  }

  async function freeFallbackInfo(user: AuthUser, taskType: TaskType) {
    const free = await findModel(ctx, FREE_MODEL_ID)
    const left = await freeRemaining(ctx, user.id)
    return { available: Boolean(free?.taskTypes.includes(taskType)) && left > 0, modelId: FREE_MODEL_ID, freeRemainingToday: left, auto: user.autoFreeFallback }
  }

  /** 402 that keeps mppx's challenge headers and adds SmartRouter's explanation. */
  async function paymentRequired(user: AuthUser, quote: QuoteRow, challenge: Response): Promise<Response> {
    let reason: string | undefined
    try {
      const t = await challenge.clone().text()
      if (t) {
        const j = JSON.parse(t)
        reason = j.detail ?? j.reason ?? j.message ?? j.title
      }
    } catch {}
    const open = await currentChannel(user.id)
    const remaining = open ? channelRemaining(open.state) : undefined
    const exhausted = remaining !== undefined && remaining < quote.priceMicro
    const body = {
      code: exhausted ? 'ALLOCATION_EXHAUSTED' : 'PAYMENT_REQUIRED',
      message: exhausted
        ? 'Your allocation is used up. Top up to keep going, or continue on the free model.'
        : 'Payment required: open a session (or sign the next voucher) and retry.',
      details: {
        priceUsd: usd(quote.priceMicro),
        channelId: open?.row.channelId,
        remainingUsd: remaining !== undefined ? usd(remaining) : undefined,
        suggestedDepositUsd: Math.max(ctx.cfg.pricing.defaultAllocationUsd, usd(user.allocationMicro)),
        reason,
        freeFallback: await freeFallbackInfo(user, quote.taskType),
      },
    }
    const headers = new Headers(challenge.headers)
    headers.set('content-type', 'application/json')
    return new Response(JSON.stringify(body), { status: 402, headers })
  }

  /** Top-up / close / content-less open. */
  async function management(c: Context<AuthVars>): Promise<Response> {
    const user = c.get('user')
    if (!ctx.sessions) throw new AppError('PROVIDER_UNAVAILABLE', 'Paid runs are not configured on this server')
    let amount = MANAGEMENT_AMOUNT_MICRO
    let meta: Record<string, string> | undefined
    let channelId: string | undefined
    if (hasPayment(c.req.raw)) {
      const cred = Credential.fromRequest<{ channelId?: string }>(c.req.raw)
      amount = BigInt(String((cred.challenge.request as { amount?: string }).amount ?? MANAGEMENT_AMOUNT_MICRO))
      meta = Challenge.meta(cred.challenge)
      channelId = cred.payload?.channelId
    }
    const result = await ctx.sessions.charge(c.req.raw, amount, meta)
    if (result.status === 402) return result.challenge as Response
    try {
      const res = await result.withReceipt()
      if (channelId) await recordChannel(user, channelId)
      return res
    } catch (e) {
      if (Mppx.isMissingReceiptResponseError(e)) throw new AppError('VALIDATION_FAILED', 'Send { quoteId, prompt } to run a model')
      throw e
    }
  }

  async function loadQuote(userId: string, quoteId: string, prompt: string): Promise<QuoteRow> {
    const [q] = await ctx.db
      .select()
      .from(schema.quotes)
      .where(and(eq(schema.quotes.id, quoteId), eq(schema.quotes.userId, userId)))
    if (!q) throw new AppError('NOT_FOUND', 'Quote not found')
    if (q.usedAt) throw new AppError('QUOTE_USED', 'This quote already ran')
    if (q.expiresAt.getTime() < Date.now()) throw new AppError('QUOTE_EXPIRED', 'Quote expired — get a new one')
    if (q.promptHash && q.promptHash !== promptHash(prompt)) throw new AppError('VALIDATION_FAILED', 'Prompt differs from the quoted prompt — get a new quote')
    return q
  }

  /** Atomic: exactly one /run per quote. */
  async function claimQuote(quoteId: string): Promise<boolean> {
    const rows = await ctx.db
      .update(schema.quotes)
      .set({ usedAt: new Date() })
      .where(and(eq(schema.quotes.id, quoteId), sql`${schema.quotes.usedAt} is null`))
      .returning({ id: schema.quotes.id })
    return rows.length === 1
  }

  async function buildInput(quote: QuoteRow, chat: ChatRow | undefined, model: CatalogModel, prompt: string): Promise<TaskInput> {
    const complexity = classifyByRules(prompt).complexity
    const maxOutputTokens = quote.maxOutputTokens ?? undefined
    if (chat) return { ...(await turnInput(ctx, chat, prompt, model, quote.taskType, complexity)), maxOutputTokens }
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: prompt },
    ]
    return { taskType: quote.taskType, complexity, prompt, rawPrompt: prompt, messages, contextTokens: estimateTokens(SYSTEM_PROMPT + prompt), maxOutputTokens }
  }

  async function createRequest(args: {
    user: AuthUser
    quote: QuoteRow
    model: CatalogModel
    chat?: ChatRow
    prompt: string
    channelId?: string
    compareGroup?: string
    isFree: boolean
  }) {
    const { user, quote, model, chat, prompt } = args
    return ctx.db.transaction(async (tx) => {
      let userMessageId: string | undefined
      let assistantMessageId: string | undefined
      // Compare runs stay out of the chat until the user picks a winner (/compare/vote).
      if (chat && !args.compareGroup) {
        const [locked] = await tx
          .select({ n: schema.chats.messageCount, title: schema.chats.title })
          .from(schema.chats)
          .where(eq(schema.chats.id, chat.id))
          .for('update')
        const n = locked!.n
        const [um] = await tx
          .insert(schema.messages)
          .values({ chatId: chat.id, seq: n + 1, role: 'user', content: prompt })
          .returning({ id: schema.messages.id })
        const [am] = await tx
          .insert(schema.messages)
          .values({ chatId: chat.id, seq: n + 2, role: 'assistant', content: '', modelId: model.id, status: 'streaming' })
          .returning({ id: schema.messages.id })
        userMessageId = um!.id
        assistantMessageId = am!.id
        const isMedia = quote.taskType === 'image' || quote.taskType === 'music'
        await tx
          .update(schema.chats)
          .set({
            messageCount: n + 2,
            lastMessageAt: new Date(),
            ...(locked!.title ? {} : { title: prompt.replace(/\s+/g, ' ').trim().slice(0, 60) }),
            ...(isMedia || model.payment === 'free' ? {} : { currentModelId: model.id }),
          })
          .where(eq(schema.chats.id, chat.id))
      }
      const [req] = await tx
        .insert(schema.requests)
        .values({
          userId: user.id,
          quoteId: quote.id,
          channelId: args.channelId?.toLowerCase(),
          chatId: chat?.id,
          userMessageId,
          assistantMessageId,
          modelId: model.id,
          isFree: args.isFree,
          taskType: quote.taskType,
          compareGroup: args.compareGroup,
          status: 'pending',
          priceMicro: quote.priceMicro,
        })
        .returning()
      if (userMessageId)
        await tx
          .update(schema.messages)
          .set({ requestId: req!.id })
          .where(sql`${schema.messages.id} in (${userMessageId}, ${assistantMessageId})`)
      return req!
    })
  }



  type Slot = { release: () => Promise<void>; handedOff: boolean }
  const runSlots = concurrency(ctx.redis, { max: MAX_CONCURRENT_RUNS, ttlMs: 10 * 60_000 })

  function stream(args: Omit<RunArgs, 'sse' | 'onDone'>, meta: Record<string, unknown>, slot: Slot) {
    slot.handedOff = true
    const sse = sseStream()
    sse.comment('started') // first byte right away: Heroku's router wants a response within 30 s
    sse.send('meta', meta)
    void runAndStream(ctx, { ...args, sse, onDone: slot.release })
    return new Response(sse.stream, { status: 200, headers: SSE_HEADERS })
  }

  /**
   * The answer streams before we know it succeeded, so the Payment-Receipt we send reports
   * spend confirmed *before* this request. If the run fails we hand the charge back; a receipt
   * that already counted it would make the mppx client reject the (lower) spend on close.
   * The final charge for the request is in the SSE `done` event.
   */
  function provisionalReceipt(res: Response, priceMicro: bigint): Response {
    const hdr = res.headers.get('payment-receipt')
    if (!hdr) return res
    const r = Receipt.deserialize(hdr) as Receipt.Receipt & { spent?: string; units?: number }
    if (r.spent !== undefined) r.spent = String(BigInt(r.spent) - priceMicro)
    if (typeof r.units === 'number') r.units = Math.max(0, r.units - 1)
    res.headers.set('payment-receipt', Receipt.serialize(r))
    return res
  }

  // ---------- POST /run ----------
  app.post('/run', async (c) => {
    const user = c.get('user')
    // Read a copy: mppx needs the untouched request (it binds the body digest).
    const raw = await c.req.raw.clone().text()
    if (!raw.trim()) return management(c)
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      throw new AppError('VALIDATION_FAILED', 'Body must be JSON')
    }
    const parsed = RunBody.safeParse(json)
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', 'Send { quoteId, prompt }', parsed.error.flatten())
    const { quoteId, prompt, compareGroup } = parsed.data

    const quote = await loadQuote(user.id, quoteId, prompt)
    const model = await findModel(ctx, quote.modelId)
    if (!model) throw new AppError('PROVIDER_UNAVAILABLE', 'That model is no longer available — get a new quote')
    let chat: ChatRow | undefined
    if (quote.chatId) {
      ;[chat] = await ctx.db
        .select()
        .from(schema.chats)
        .where(and(eq(schema.chats.id, quote.chatId), eq(schema.chats.userId, user.id), sql`${schema.chats.archivedAt} is null`))
      if (!chat) throw new AppError('NOT_FOUND', 'Chat not found')
    }
    const input = await buildInput(quote, chat, model, prompt)
    const slider = chat?.slider ?? user.slider

    const release = await runSlots.acquire(user.id)
    if (!release)
      throw new AppError('RATE_LIMITED', `You already have ${MAX_CONCURRENT_RUNS} answers running — wait for one to finish`, { limit: 'concurrent_runs' })
    const slot: Slot = { release, handedOff: false }
    try {
      // ----- free model -----
      if (model.payment === 'free') {
        if ((await freeRemaining(ctx, user.id)) <= 0)
          throw new AppError('FREE_LIMIT_REACHED', `You've used today's ${ctx.cfg.free.dailyMessages} free messages. They reset at 00:00 UTC.`, {
            scope: 'user',
          })
        if ((await freeSpentToday(ctx)) >= BigInt(Math.round(ctx.cfg.free.globalDailyUsd * 1e6)))
          throw new AppError('FREE_LIMIT_REACHED', 'The free model is at capacity for today. Try again tomorrow or use a paid model.', { scope: 'global' })
        if (!(await claimQuote(quote.id))) throw new AppError('QUOTE_USED', 'This quote already ran')
        const day = new Date().toISOString().slice(0, 10)
        await ctx.db
          .insert(schema.freeUsage)
          .values({ userId: user.id, day, messages: 1 })
          .onConflictDoUpdate({ target: [schema.freeUsage.userId, schema.freeUsage.day], set: { messages: sql`${schema.freeUsage.messages} + 1` } })
        const req = await createRequest({ user, quote, model, chat, prompt, compareGroup, isFree: true })
        return stream(
          { req, model, input, slider, estCostMicro: 0n },
          {
            requestId: req.id,
            modelId: model.id,
            label: model.label,
            priceUsd: 0,
            free: true,
            chatId: chat?.id,
            userMessageId: req.userMessageId,
            assistantMessageId: req.assistantMessageId,
          },
          slot,
        )
      }

      // ----- paid model -----
      if (!ctx.sessions) throw new AppError('PROVIDER_UNAVAILABLE', 'Paid runs are not configured on this server')
      if ((await weeklySpentMicro(ctx, user.id)) + quote.priceMicro > user.weeklyLimitMicro)
        throw new AppError(
          'ALLOCATION_EXHAUSTED',
          `This would pass your weekly limit of $${usd(user.weeklyLimitMicro).toFixed(2)}. Raise it in settings or continue free.`,
          {
            reason: 'weekly_limit',
            freeFallback: await freeFallbackInfo(user, quote.taskType),
          },
        )

      const result = await ctx.sessions.charge(c.req.raw, quote.priceMicro, { quote: quote.id })
      if (result.status === 402) return paymentRequired(user, quote, result.challenge as Response)

      // A credential for top-up/close that happened to carry a body: answer as management.
      try {
        const mgmt = await result.withReceipt()
        return mgmt
      } catch (e) {
        if (!Mppx.isMissingReceiptResponseError(e)) throw e
      }

      // The voucher was accepted and the price is now charged to the channel.
      const cred = Credential.fromRequest<{ channelId: string }>(c.req.raw)
      const channelId = cred.payload.channelId
      const state = await recordChannel(user, channelId)
      if (!state) {
        await ctx.sessions.refund(channelId, quote.priceMicro)
        throw new AppError('FORBIDDEN', 'That payment channel belongs to a different wallet than the one signed in')
      }
      if (!(await claimQuote(quote.id))) {
        await ctx.sessions.refund(channelId, quote.priceMicro)
        throw new AppError('QUOTE_USED', 'This quote already ran (you were not charged twice)')
      }
      const req = await createRequest({ user, quote, model, chat, prompt, channelId, compareGroup, isFree: false })
      const res = stream(
        { req, model, input, slider, estCostMicro: quote.estCostMicro },
        {
          requestId: req.id,
          modelId: model.id,
          label: model.label,
          priceUsd: usd(quote.priceMicro),
          free: false,
          chatId: chat?.id,
          userMessageId: req.userMessageId,
          assistantMessageId: req.assistantMessageId,
          remainingUsd: usd(channelRemaining(state)),
          usage: await usageFor(ctx, user),
        },
        slot,
      )
      return provisionalReceipt(await result.withReceipt(res), quote.priceMicro)
    } finally {
      if (!slot.handedOff) await slot.release()
    }
  })

  // ---------- GET /sessions/current ----------
  app.get('/sessions/current', async (c) => {
    const user = c.get('user')
    const open = await currentChannel(user.id)
    return c.json({
      paidRunsEnabled: Boolean(ctx.sessions),
      network: {
        chainId: ctx.cfg.network.chainId,
        token: ctx.cfg.tokens.payment,
        recipient: ctx.cfg.treasury.address,
        operator: ctx.sessions?.operator.address,
      },
      suggestedDepositUsd: Math.max(ctx.cfg.pricing.defaultAllocationUsd, usd(user.allocationMicro)),
      usage: await usageFor(ctx, user, open ?? null),
      session: open
        ? {
            channelId: open.row.channelId,
            depositUsd: usd(open.state.deposit),
            spentUsd: usd(open.state.spent),
            remainingUsd: usd(channelRemaining(open.state)),
            settledUsd: usd(open.state.settledOnChain),
            requests: open.state.units,
            openedAt: open.row.createdAt,
            lastUsedAt: open.row.lastUsedAt,
          }
        : null,
    })
  })

  return app
}
