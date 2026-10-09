import { z } from 'zod'

/** Stable error codes the frontend maps to screens. */
export const ErrorCode = z.enum([
  'ALLOCATION_EXHAUSTED', // show "Top up" or "Continue free" (details.freeFallback)
  'FREE_LIMIT_REACHED', // free model daily cap hit (per user or global)
  'QUOTE_EXPIRED', // re-recommend
  'PROVIDER_UNAVAILABLE', // retry on next model
  'RATE_LIMITED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'VALIDATION_FAILED',
  'INTERNAL',
])
export type ErrorCode = z.infer<typeof ErrorCode>

/** One error shape everywhere: { code, message, details? } */
export const ApiError = z.object({
  code: ErrorCode,
  message: z.string(),
  details: z.unknown().optional(),
})
export type ApiError = z.infer<typeof ApiError>

export const ERROR_STATUS: Record<ErrorCode, number> = {
  ALLOCATION_EXHAUSTED: 402,
  FREE_LIMIT_REACHED: 429,
  QUOTE_EXPIRED: 410,
  PROVIDER_UNAVAILABLE: 503,
  RATE_LIMITED: 429,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_FAILED: 400,
  INTERNAL: 500,
}
