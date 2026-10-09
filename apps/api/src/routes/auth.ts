/**
 * Sign-In with Ethereum (EIP-4361) against the user's Tempo account.
 * POST /auth/challenge {address} → {message}; the wallet signs it (passkey envelope or EOA);
 * POST /auth/verify {message, signature} → session cookie.
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { getAddress } from 'viem'
import { createSiweMessage, generateSiweNonce, parseSiweMessage } from 'viem/siwe'
import { z } from 'zod'
import { and, eq, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { endSession, requireAuth, startSession, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'

const NONCE_TTL_MS = 10 * 60_000
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/)

export function authRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()

  app.post('/auth/challenge', zValidator('json', z.object({ address: Address, origin: z.string().url().optional() })), async (c) => {
    const { address, origin } = c.req.valid('json')
    const domainOrigin = origin && ctx.cfg.app.origins.includes(origin) ? origin : ctx.cfg.app.origins[0]!
    const nonce = generateSiweNonce()
    const expiresAt = new Date(Date.now() + NONCE_TTL_MS)
    await ctx.db.insert(schema.authNonces).values({ nonce, address: address.toLowerCase(), expiresAt })
    // Housekeeping: drop expired nonces opportunistically.
    await ctx.db.delete(schema.authNonces).where(sql`${schema.authNonces.expiresAt} < now() - interval '1 hour'`)
    const message = createSiweMessage({
      domain: new URL(domainOrigin).host,
      address: getAddress(address),
      statement: 'Sign in to SmartRouter.',
      uri: domainOrigin,
      version: '1',
      chainId: ctx.cfg.network.chainId,
      nonce,
      issuedAt: new Date(),
      expirationTime: expiresAt,
    })
    return c.json({ message, nonce, expiresAt: expiresAt.toISOString() })
  })

  app.post('/auth/verify', zValidator('json', z.object({ message: z.string().min(20).max(4_000), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) })), async (c) => {
    const { message, signature } = c.req.valid('json')
    const parsed = parseSiweMessage(message)
    if (!parsed.address || !parsed.nonce || !parsed.domain) throw new AppError('UNAUTHENTICATED', 'Malformed sign-in message')
    if (!ctx.cfg.app.siweDomains.includes(parsed.domain)) throw new AppError('UNAUTHENTICATED', `Unexpected domain ${parsed.domain}`)
    if (parsed.chainId !== ctx.cfg.network.chainId) throw new AppError('UNAUTHENTICATED', 'Wrong network')
    const address = parsed.address.toLowerCase()

    // One-time nonce, bound to this address.
    const [nonce] = await ctx.db
      .delete(schema.authNonces)
      .where(and(eq(schema.authNonces.nonce, parsed.nonce), eq(schema.authNonces.address, address), sql`${schema.authNonces.expiresAt} > now()`))
      .returning()
    if (!nonce) throw new AppError('UNAUTHENTICATED', 'Sign-in request expired; try again')

    // Handles plain EOA signatures and Tempo passkey signature envelopes (via the chain's verifier).
    const ok = await ctx.rpc.verifySiweMessage({ message, signature: signature as `0x${string}`, address: parsed.address, nonce: parsed.nonce, domain: parsed.domain }).catch(() => false)
    if (!ok) throw new AppError('UNAUTHENTICATED', 'Signature check failed')

    const [user] = await ctx.db
      .insert(schema.users)
      .values({ tempoAddress: address, allocationMicro: BigInt(Math.round(ctx.cfg.pricing.defaultAllocationUsd * 1e6)) })
      .onConflictDoUpdate({ target: schema.users.tempoAddress, set: { tempoAddress: address } })
      .returning()
    await startSession(c, ctx, user!.id)
    return c.json({ userId: user!.id, address })
  })

  app.post('/auth/logout', (c) => {
    endSession(c)
    return c.json({ ok: true })
  })

  // Settings & profile
  app.get('/me', requireAuth(ctx), async (c) => {
    const u = c.get('user')
    const [session] = await ctx.db
      .select()
      .from(schema.userSessions)
      .where(and(eq(schema.userSessions.userId, u.id), eq(schema.userSessions.status, 'open')))
      .orderBy(sql`${schema.userSessions.lastUsedAt} desc`)
      .limit(1)
    const used = session ? session.countedMicro : 0n
    return c.json({
      id: u.id,
      address: u.tempoAddress,
      country: u.country,
      settings: { slider: u.slider, allocationUsd: Number(u.allocationMicro) / 1e6, weeklyLimitUsd: Number(u.weeklyLimitMicro) / 1e6, autoFreeFallback: u.autoFreeFallback },
      allocation: session
        ? { channelId: session.channelId, depositUsd: Number(session.depositMicro) / 1e6, usedUsd: Number(used) / 1e6, remainingUsd: Number(session.depositMicro - used) / 1e6 }
        : null,
    })
  })

  app.patch(
    '/me/settings',
    requireAuth(ctx),
    zValidator(
      'json',
      z.object({
        slider: z.enum(['cheapest', 'balanced', 'best']).optional(),
        allocationUsd: z.number().min(0.5).max(100).optional(),
        weeklyLimitUsd: z.number().min(0).max(1_000).optional(),
        autoFreeFallback: z.boolean().optional(),
        country: z.string().length(2).optional(),
      }),
    ),
    async (c) => {
      const b = c.req.valid('json')
      const [u] = await ctx.db
        .update(schema.users)
        .set({
          ...(b.slider ? { slider: b.slider } : {}),
          ...(b.allocationUsd !== undefined ? { allocationMicro: BigInt(Math.round(b.allocationUsd * 1e6)) } : {}),
          ...(b.weeklyLimitUsd !== undefined ? { weeklyLimitMicro: BigInt(Math.round(b.weeklyLimitUsd * 1e6)) } : {}),
          ...(b.autoFreeFallback !== undefined ? { autoFreeFallback: b.autoFreeFallback } : {}),
          ...(b.country ? { country: b.country.toUpperCase() } : {}),
        })
        .where(eq(schema.users.id, c.get('user').id))
        .returning()
      return c.json({ slider: u!.slider, allocationUsd: Number(u!.allocationMicro) / 1e6, weeklyLimitUsd: Number(u!.weeklyLimitMicro) / 1e6, autoFreeFallback: u!.autoFreeFallback, country: u!.country })
    },
  )

  return app
}
