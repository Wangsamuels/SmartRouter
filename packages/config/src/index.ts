import { z } from 'zod'
import { NETWORKS, type NetworkName } from './networks.js'

export * from './networks.js'

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 0x address')
const optionalStr = z.string().trim().optional().transform((v) => (v ? v : undefined))

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  TEMPO_NETWORK: z.enum(['moderato', 'tempo']).default('moderato'),
  /** Primary RPC (e.g. your dRPC key URL). Defaults to the network's public RPC. */
  TEMPO_RPC_URL: optionalStr,
  /** Comma-separated backup RPCs; defaults to the public endpoints for the network. */
  TEMPO_RPC_FALLBACK_URLS: optionalStr,
  PAYMENT_TOKEN: optionalStr.pipe(address.optional()),
  TREASURY_ADDRESS: optionalStr.pipe(address.optional()),
  /** Hot wallet that pays providers: a dedicated EOA holding only a few days of float. */
  HOT_WALLET_PRIVATE_KEY: optionalStr.pipe(z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex key').optional()),
  HOT_WALLET_DAILY_LIMIT_USD: z.coerce.number().positive().default(20),
  /** Use the mock provider for every paid model (automatic on testnet). */
  MOCK_PROVIDERS: z.enum(['auto', 'true', 'false']).default('auto'),
  /** Testnet/CI only: mock models wait this long before the first token (streaming/heartbeat tests). */
  MOCK_FIRST_TOKEN_MS: z.coerce.number().int().nonnegative().optional(),
  FEE_PAYER_URL: optionalStr,
  /** HMAC key that binds MPP challenges to this server (32+ chars). Same value on every dyno. */
  MPP_SECRET_KEY: optionalStr.pipe(z.string().min(32).optional()),
  /** Operator: signs settle/close for user channels and sponsors their open/top-up fees. Falls back to the hot wallet. */
  OPERATOR_PRIVATE_KEY: optionalStr.pipe(z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex key').optional()),
  /** Pay users' channel open/top-up fees from the operator wallet. */
  SPONSOR_FEES: z.enum(['true', 'false']).default('true'),
  /** Settle a channel's unsettled spend once it has been quiet this long… */
  SETTLE_IDLE_MINUTES: z.coerce.number().positive().default(10),
  /** …and owes at least this much (USD). Idle close collects anything smaller. */
  SETTLE_MIN_USD: z.coerce.number().nonnegative().default(0.05),
  /** Close channels unused this long: we get what was spent, the user gets the rest back. */
  IDLE_CLOSE_HOURS: z.coerce.number().positive().default(2),
  /** Size of each automatic deposit into the payment contract (capped by what's left of the user's caps). */
  DEPOSIT_CHUNK_USD: z.coerce.number().positive().default(1),
  /** Lifetime of the spending key (Tempo access key) the app asks users to authorize. */
  SPENDING_KEY_DAYS: z.coerce.number().int().positive().default(7),
  /** Alert thresholds (USD) for the wallets the server spends from. */
  HOT_WALLET_MIN_USD: z.coerce.number().nonnegative().default(2),
  OPERATOR_MIN_USD: z.coerce.number().nonnegative().default(0.25),
  /**
   * Where users' payments land. 'operator' = the operator wallet (on mainnet that is the hot
   * wallet): it pays providers and every network fee first, and the profit-sweep job sends the
   * excess to PROFIT_ADDRESS. 'treasury' = straight to TREASURY_ADDRESS (the old behaviour).
   */
  REVENUE_TO: z.enum(['operator', 'treasury']).default('operator'),
  /** Profit goes here (defaults to TREASURY_ADDRESS). */
  PROFIT_ADDRESS: optionalStr.pipe(address.optional()),
  /** The revenue wallet keeps this much for provider payments and fees; the rest is profit. */
  HOT_WALLET_FLOAT_USD: z.coerce.number().nonnegative().default(10),
  /** Sweep as soon as profit reaches this much… */
  PROFIT_SWEEP_MIN_USD: z.coerce.number().positive().default(20),
  /** …or at least this often (anything above PROFIT_SWEEP_DUST_USD). */
  PROFIT_SWEEP_INTERVAL_HOURS: z.coerce.number().positive().default(24),
  PROFIT_SWEEP_DUST_USD: z.coerce.number().nonnegative().default(0.1),
  /** Relay (cross-chain deposits and sends). Optional key: adds Solana deposits and higher rate limits. */
  RELAY_API_KEY: optionalStr,
  RELAY_API_URL: z.string().default('https://api.relay.link'),
  /** Network fees the operator pays for each user's own wallet transactions (sends, transfers). */
  SPONSOR_TX_PER_DAY: z.coerce.number().int().nonnegative().default(20),
  /** Largest single send a user can make from the app (USD). */
  SEND_MAX_USD: z.coerce.number().positive().default(1000),
  /** Email for the 6-digit codes that confirm money leaving a user's wallet: Brevo (brevo.com) if set, else Resend (resend.com). */
  BREVO_API_KEY: optionalStr,
  RESEND_API_KEY: optionalStr,
  EMAIL_FROM: z.string().default('SmartRouter <onboarding@resend.dev>'),
  /** Minutes a send code stays valid. */
  SEND_CODE_TTL_MIN: z.coerce.number().int().positive().default(10),
  /** Testnet only: return the code in the API response instead of requiring email (automated tests). Ignored on mainnet. */
  SEND_CODE_ECHO: z.enum(['true', 'false']).default('false'),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: optionalStr,
  SESSION_SECRET: z.string().min(32),
  /** Privy app id (public): sign-in with email / Google, embedded Tempo wallets. */
  PRIVY_APP_ID: optionalStr,
  S3_ENDPOINT: optionalStr,
  S3_BUCKET: optionalStr,
  S3_ACCESS_KEY_ID: optionalStr,
  S3_SECRET_ACCESS_KEY: optionalStr,
  /** Public base URL for the bucket (R2 public bucket URL or custom domain). */
  S3_PUBLIC_URL: optionalStr,
  /** Private bucket for users' uploaded files (same R2 account and keys as S3_*). */
  UPLOADS_BUCKET: z.string().default('smartrouter-upload'),
  UPLOAD_MAX_MB: z.coerce.number().positive().default(20),
  UPLOADS_PER_DAY: z.coerce.number().int().positive().default(30),
  /** Must match the bucket's R2 lifecycle rule. */
  UPLOAD_TTL_DAYS: z.coerce.number().int().positive().default(30),
  /** File text a paid / free model gets per message (tokens); longer files are cut, and the user is told. */
  ATTACH_TOKENS_PAID: z.coerce.number().int().positive().default(32_000),
  ATTACH_TOKENS_FREE: z.coerce.number().int().positive().default(2_500),
  AA_API_KEY: optionalStr,
  SENTRY_DSN: optionalStr,
  MAX_PROVIDER_PRICE_MULTIPLIER: z.coerce.number().positive().default(2),
  FEE_PCT: z.coerce.number().min(0).max(100).default(10),
  DEFAULT_ALLOCATION_USD: z.coerce.number().positive().default(2),
  // Free fallback model (Cloudflare Workers AI; Groq free tier as backup)
  CLOUDFLARE_ACCOUNT_ID: optionalStr,
  CLOUDFLARE_AI_TOKEN: optionalStr,
  /** fp8-fast: same Llama 3.1 8B, ~3–4× more free messages per day than the full-precision model. */
  FREE_MODEL: z.string().default('@cf/meta/llama-3.1-8b-instruct-fp8-fast'),
  GROQ_FREE_API_KEY: optionalStr,
  FREE_DAILY_MESSAGES: z.coerce.number().int().nonnegative().default(30),
  FREE_GLOBAL_DAILY_USD: z.coerce.number().nonnegative().default(3),
  FREE_CONTEXT_TOKENS: z.coerce.number().int().positive().default(4000),
  FREE_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(512),
  // Chats: history sent to paid models is capped; older turns are summarized
  CHAT_CONTEXT_TOKENS: z.coerce.number().int().positive().default(8000),
  /** Frontend origins allowed by CORS; the first one's host is the SIWE domain. */
  APP_ORIGINS: z.string().default('http://localhost:5173'),
  /** Multiplies every per-IP rate limit (e.g. 10 during a load test). */
  RATE_LIMIT_SCALE: z.coerce.number().positive().default(1),
  HEROKU_SLUG_COMMIT: optionalStr,
})

export type Env = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = EnvSchema.safeParse(env)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  const e = parsed.data
  const network = NETWORKS[e.TEMPO_NETWORK as NetworkName]
  return {
    env: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    port: e.PORT,
    version: e.HEROKU_SLUG_COMMIT?.slice(0, 7) ?? 'dev',
    network: {
      name: e.TEMPO_NETWORK as NetworkName,
      label: network.name,
      chainId: network.chainId,
      rpcUrl: e.TEMPO_RPC_URL ?? network.rpcUrl,
      /** Primary first, then backups; duplicates removed. */
      rpcUrls: [
        ...new Set([
          e.TEMPO_RPC_URL ?? network.rpcUrl,
          ...(e.TEMPO_RPC_FALLBACK_URLS ? e.TEMPO_RPC_FALLBACK_URLS.split(',').map((u) => u.trim()).filter(Boolean) : [network.rpcUrl, ...network.fallbackRpcUrls]),
        ]),
      ] as string[],
      /** Tempo's own node. Some third-party RPCs (dRPC) lack Tempo methods like eth_fillTransaction, which the fee relay needs. */
      nodeRpcUrl: network.rpcUrl as string,
      explorer: network.explorer,
      feePayerUrl: e.FEE_PAYER_URL ?? network.feePayerUrl,
    },
    tokens: {
      payment: (e.PAYMENT_TOKEN ?? network.tokens.payment).toLowerCase() as `0x${string}`,
    },
    treasury: {
      address: e.TREASURY_ADDRESS as `0x${string}` | undefined,
      hotWalletKey: e.HOT_WALLET_PRIVATE_KEY as `0x${string}` | undefined,
      hotWalletDailyLimitMicro: BigInt(Math.round(e.HOT_WALLET_DAILY_LIMIT_USD * 1e6)),
    },
    mpp: {
      secretKey: e.MPP_SECRET_KEY,
      operatorKey: (e.OPERATOR_PRIVATE_KEY ?? e.HOT_WALLET_PRIVATE_KEY) as `0x${string}` | undefined,
      sponsorFees: e.SPONSOR_FEES === 'true',
      settleIdleMs: e.SETTLE_IDLE_MINUTES * 60_000,
      settleMinMicro: BigInt(Math.round(e.SETTLE_MIN_USD * 1e6)),
      idleCloseMs: e.IDLE_CLOSE_HOURS * 3_600_000,
    },
    revenue: {
      to: e.REVENUE_TO,
      profitAddress: (e.PROFIT_ADDRESS ?? e.TREASURY_ADDRESS) as `0x${string}` | undefined,
      floatMicro: BigInt(Math.round(e.HOT_WALLET_FLOAT_USD * 1e6)),
      sweepMinMicro: BigInt(Math.round(e.PROFIT_SWEEP_MIN_USD * 1e6)),
      sweepIntervalMs: e.PROFIT_SWEEP_INTERVAL_HOURS * 3_600_000,
      sweepDustMicro: BigInt(Math.round(e.PROFIT_SWEEP_DUST_USD * 1e6)),
    },
    relay: { apiKey: e.RELAY_API_KEY, url: e.RELAY_API_URL.replace(/\/+$/, '') },
    wallet: {
      sponsorTxPerDay: e.SPONSOR_TX_PER_DAY,
      sendMaxMicro: BigInt(Math.round(e.SEND_MAX_USD * 1e6)),
      sendCodeTtlMin: e.SEND_CODE_TTL_MIN,
      sendCodeEcho: e.SEND_CODE_ECHO === 'true' && e.TEMPO_NETWORK !== 'tempo',
    },
    email: { brevoApiKey: e.BREVO_API_KEY, resendApiKey: e.RESEND_API_KEY, from: e.EMAIL_FROM, configured: Boolean(e.BREVO_API_KEY || e.RESEND_API_KEY) },
    alerts: {
      hotWalletMinMicro: BigInt(Math.round(e.HOT_WALLET_MIN_USD * 1e6)),
      operatorMinMicro: BigInt(Math.round(e.OPERATOR_MIN_USD * 1e6)),
    },
    /** Mainnet MPP providers can't be paid on testnet, so paid models run on the mock adapter. */
    mockProviders: e.MOCK_PROVIDERS === 'auto' ? e.TEMPO_NETWORK === 'moderato' : e.MOCK_PROVIDERS === 'true',
    mockFirstTokenMs: e.MOCK_FIRST_TOKEN_MS,
    app: {
      // Normalised to scheme://host[:port] so 'https://app.example.com/' (trailing slash) still matches the browser's Origin.
      origins: e.APP_ORIGINS.split(',').map((o) => o.trim()).filter(Boolean).map((o) => new URL(o).origin),
      /** Hosts a SIWE message may name as its domain. */
      siweDomains: e.APP_ORIGINS.split(',').map((o) => new URL(o.trim()).host),
    },
    db: { url: e.DATABASE_URL },
    redis: { url: e.REDIS_URL },
    sessionSecret: e.SESSION_SECRET,
    privy: { appId: e.PRIVY_APP_ID },
    s3: {
      endpoint: e.S3_ENDPOINT,
      bucket: e.S3_BUCKET,
      accessKeyId: e.S3_ACCESS_KEY_ID,
      secretAccessKey: e.S3_SECRET_ACCESS_KEY,
      publicUrl: e.S3_PUBLIC_URL?.replace(/\/+$/, ''),
    },
    uploads: {
      bucket: e.UPLOADS_BUCKET,
      maxBytes: Math.round(e.UPLOAD_MAX_MB * 1024 * 1024),
      perDay: e.UPLOADS_PER_DAY,
      ttlDays: e.UPLOAD_TTL_DAYS,
      attachTokensPaid: e.ATTACH_TOKENS_PAID,
      attachTokensFree: e.ATTACH_TOKENS_FREE,
    },
    aaApiKey: e.AA_API_KEY,
    sentryDsn: e.SENTRY_DSN,
    pricing: {
      maxProviderPriceMultiplier: e.MAX_PROVIDER_PRICE_MULTIPLIER,
      feePct: e.FEE_PCT,
      defaultAllocationUsd: e.DEFAULT_ALLOCATION_USD,
      depositChunkMicro: BigInt(Math.round(e.DEPOSIT_CHUNK_USD * 1e6)),
      spendingKeyDays: e.SPENDING_KEY_DAYS,
    },
    free: {
      cloudflareAccountId: e.CLOUDFLARE_ACCOUNT_ID,
      cloudflareToken: e.CLOUDFLARE_AI_TOKEN,
      model: e.FREE_MODEL,
      groqKey: e.GROQ_FREE_API_KEY,
      dailyMessages: e.FREE_DAILY_MESSAGES,
      globalDailyUsd: e.FREE_GLOBAL_DAILY_USD,
      contextTokens: e.FREE_CONTEXT_TOKENS,
      maxOutputTokens: e.FREE_MAX_OUTPUT_TOKENS,
    },
    chat: { contextTokens: e.CHAT_CONTEXT_TOKENS },
    rateLimitScale: e.RATE_LIMIT_SCALE,
  } as const
}

export type Config = ReturnType<typeof loadConfig>

let cached: Config | undefined
/** Lazily loaded singleton for app code. Scripts/tests can call loadConfig() directly. */
export function config(): Config {
  return (cached ??= loadConfig())
}

/** True when a Postgres/Redis URL points at a managed host (Heroku) that needs TLS. */
export function needsTls(url: string): boolean {
  return !/@(localhost|127\.0\.0\.1)(:|\/)/.test(url) && !url.startsWith('postgres://localhost')
}
