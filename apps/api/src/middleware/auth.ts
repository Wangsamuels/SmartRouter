/**
 * Session cookie: HMAC-signed `<userId>.<expiresAtMs>`, httpOnly, 7 days.
 * The frontend lives on another origin, so in production the cookie is SameSite=None; Secure.
 */
import type { Context } from 'hono'
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie'
import { createMiddleware } from 'hono/factory'
import { eq, schema } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { AppError } from './error.js'

export const SESSION_COOKIE = 'sr_session'
export const SESSION_TTL_MS = 7 * 24 * 3600_000

export type AuthUser = typeof schema.users.$inferSelect
export type AuthVars = { Variables: { user: AuthUser; requestId: string } }

export async function startSession(c: Context, ctx: AppContext, userId: string) {
  const exp = Date.now() + SESSION_TTL_MS
  await setSignedCookie(c, SESSION_COOKIE, `${userId}.${exp}`, ctx.cfg.sessionSecret, {
    httpOnly: true,
    secure: ctx.cfg.isProd,
    sameSite: ctx.cfg.isProd ? 'None' : 'Lax',
    path: '/',
    maxAge: SESSION_TTL_MS / 1000,
  })
}

export function endSession(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: '/' })
}

export function requireAuth(ctx: AppContext) {
  return createMiddleware<AuthVars>(async (c, next) => {
    const raw = await getSignedCookie(c, ctx.cfg.sessionSecret, SESSION_COOKIE)
    if (!raw) throw new AppError('UNAUTHENTICATED', 'Sign in first')
    const [userId, exp] = raw.split('.')
    if (!userId || !exp || Number(exp) < Date.now()) throw new AppError('UNAUTHENTICATED', 'Session expired')
    const [user] = await ctx.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
    if (!user) throw new AppError('UNAUTHENTICATED', 'Unknown user')
    c.set('user', user)
    await next()
  })
}
