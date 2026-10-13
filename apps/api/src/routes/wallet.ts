/**
 * Wallet: balances, deposits (Tempo, other chains, card), sends (Tempo or other chains),
 * activity, and the fee relay that lets the operator (hot wallet) pay users' network fees.
 *
 * Transfers between the main wallet and the AI balance are mppx operations on the client
 * (open a deposit / close it); they need no endpoint here.
 */
import { zValidator } from '@hono/zod-validator'
import { Hono } from 'hono'
import { z } from 'zod'
import { createClient, encodeFunctionData, erc20Abi, fallback, http, isAddress, type Hex } from 'viem'
import { tempo as tempoChain, tempoModerato } from 'viem/chains'
import { Actions, Addresses, Relay } from 'viem/tempo'
import { microToBase, relayFeeUsd, RelayError, TEMPO_CHAIN_ID, baseToMicro, closeChannel } from '@smartrouter/core'
import { and, desc, eq, gte, inArray, schema, sql } from '@smartrouter/db'
import type { AppContext } from '../context.js'
import { requireAuth, type AuthVars } from '../middleware/auth.js'
import { AppError } from '../middleware/error.js'
import { openChannel, usageFor } from '../services/usage.js'
import { consumeSendCode, issueSendCode, linkCodeToMove, maskEmail, type SendTarget } from '../services/send-codes.js'
import { chainOptions, findOption, micro, relay, tokenBalance, usd, validAddress } from '../services/wallet.js'

/** Tempo's TIP-1034 payment-channel precompile (where mppx deposits go). */
const ESCROW_PRECOMPILE = '0x4d50500000000000000000000000000000000000'

/** Deposit addresses are created from a quote for this amount; any amount can be sent later. */
const DEPOSIT_QUOTE_MICRO = 10_000_000n
/** Fee relay methods (everything else would turn this into an open RPC proxy). */
const RELAY_METHODS = new Set(['eth_chainId', 'eth_fillTransaction', 'eth_signRawTransaction', 'eth_sendRawTransaction', 'eth_sendRawTransactionSync'])

/** A call to sign; `value` (wei, decimal string) only when non-zero — pass it as BigInt. */
type Call = { to: string; data: string; value?: string }

const SendBody = z.object({
  chain: z.string().min(2).max(40).default('tempo'),
  token: z.string().min(2).max(10).default('USDC'),
  to: z.string().min(20).max(64),
  amountUsd: z.number().positive().max(1_000_000),
})
/** With SEND_CODE_REQUIRED=true, sending money out also needs the 6-digit email code from POST /wallet/send/code. */
const ConfirmedSendBody = SendBody.extend({
  verificationId: z.string().uuid().optional(),
  code: z
    .string()
    .regex(/^\s*\d{6}\s*$/, 'Enter the 6-digit code')
    .optional(),
})

const relayErr = (e: unknown): never => {
  if (e instanceof RelayError) throw new AppError(e.status === 429 ? 'RATE_LIMITED' : 'PROVIDER_UNAVAILABLE', `Bridge: ${e.message}`)
  throw e
}

export function walletRoutes(ctx: AppContext) {
  const app = new Hono<AuthVars>()
  app.use('/wallet', requireAuth(ctx))
  app.use('/wallet/*', requireAuth(ctx))
  app.use('/relay', requireAuth(ctx))

  const token = ctx.cfg.tokens.payment
  const tokenSymbol = ctx.cfg.network.name === 'tempo' ? 'USDC.e' : 'pathUSD'
  const chain = ctx.cfg.network.name === 'tempo' ? tempoChain : tempoModerato
  // The fee relay needs Tempo-specific methods (eth_fillTransaction): Tempo's own node first,
  // then the configured RPC only if it is down. (dRPC answers "method is not available".)
  const relayRpcs = [...new Set([ctx.cfg.network.nodeRpcUrl, ctx.cfg.network.rpcUrl])]
  const relayClient = createClient({
    chain,
    transport: fallback(
      relayRpcs.map((u) => http(u, { timeout: 15_000, retryCount: 2 })),
      { rank: false, retryCount: 1 },
    ),
  })

  const sponsoredToday = async (userId: string) => {
    const [r] = await ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.sponsoredTxs)
      .where(and(eq(schema.sponsoredTxs.userId, userId), gte(schema.sponsoredTxs.createdAt, sql`now() - interval '1 day'`)))
    return r?.n ?? 0
  }

  // ---------- GET /wallet ----------
  app.get('/wallet', async (c) => {
    const user = c.get('user')
    const address = user.tempoAddress as `0x${string}`
    const [balance, open, pending, used, options] = await Promise.all([
      tokenBalance(ctx, address),
      openChannel(ctx, user.id),
      ctx.db
        .select({
          total: sql<string>`coalesce(sum(${schema.walletMoves.amountMicro}),0)::text`,
        })
        .from(schema.walletMoves)
        .where(and(eq(schema.walletMoves.userId, user.id), eq(schema.walletMoves.kind, 'deposit'), eq(schema.walletMoves.status, 'pending'))),
      sponsoredToday(user.id),
      chainOptions(ctx),
    ])
    const [caps, key] = await Promise.all([usageFor(ctx, user, open ?? null, { mainBalanceMicro: balance }), spendingKeyState(user)])
    return c.json({
      address,
      network: {
        chainId: ctx.cfg.network.chainId,
        name: ctx.cfg.network.label,
      },
      token: { address: token, symbol: tokenSymbol, decimals: 6 },
      main: { balanceUsd: usd(balance) },
      ai: open
        ? {
            channelId: open.row.channelId,
            depositUsd: usd(open.state.deposit),
            spentUsd: usd(open.state.spent),
            remainingUsd: usd(open.state.deposit - open.state.spent),
          }
        : null,
      // Same object as `ai`, named for the UI: money locked for answers, moved in and out automatically.
      locked: open ? { depositUsd: usd(open.state.deposit), spentUsd: usd(open.state.spent), remainingUsd: usd(open.state.deposit - open.state.spent) } : null,
      caps,
      spendingKey: key,
      incomingUsd: usd(BigInt(pending[0]?.total ?? '0')),
      networkFees: {
        paidBy: 'smartrouter',
        sponsoredPerDay: ctx.cfg.wallet.sponsorTxPerDay,
        usedToday: used,
        relayUrl: '/relay',
      },
      features: {
        crossChain: options.length > 0,
        card: options.some((o) => o.chain === 'base' && o.token === 'USDC'),
        cashOut: false,
        /** Every send out needs the 6-digit code emailed by POST /wallet/send/code. */
        sendCode: { required: ctx.cfg.wallet.sendCodeRequired, sentTo: user.email ? maskEmail(user.email) : null, ttlMinutes: ctx.cfg.wallet.sendCodeTtlMin },
      },
    })
  })

  // ---------- GET /wallet/options ----------
  app.get('/wallet/options', async (c) => {
    const options = await chainOptions(ctx)
    const tempo = {
      chain: 'tempo',
      chainId: ctx.cfg.network.chainId,
      chainName: ctx.cfg.network.label,
      vmType: 'evm',
      token: tokenSymbol,
      tokenAddress: token,
      decimals: 6,
    }
    return c.json({
      deposit: [{ ...tempo, depositAvailable: true, method: 'direct' }, ...options.map((o) => ({ ...o, method: 'bridge' }))],
      send: [
        { ...tempo, method: 'direct' },
        ...options.map(({ depositAvailable: _d, ...o }) => ({
          ...o,
          method: 'bridge',
        })),
      ],
      card: options.some((o) => o.chain === 'base' && o.token === 'USDC')
        ? {
            via: 'privy',
            chain: 'base',
            token: 'USDC',
            note: 'Card purchase on Base, sent to the Base deposit address, arrives as USDC.e',
          }
        : null,
      cashOut: null,
    })
  })

  // ---------- POST /wallet/deposit-address ----------
  app.post(
    '/wallet/deposit-address',
    // refundAddress: non-EVM chains only (e.g. the Solana wallet the user sends from); refunds of
    // too-small deposits go there. EVM chains refund to the user's own address automatically.
    zValidator(
      'json',
      z.object({
        chain: z.string().min(2).max(40),
        token: z.string().min(2).max(10).default('USDC'),
        refundAddress: z.string().min(20).max(64).optional(),
      }),
    ),
    async (c) => {
      const user = c.get('user')
      const { chain: chainName, token: sym, refundAddress } = c.req.valid('json')
      if (chainName === 'tempo')
        return c.json({
          chain: 'tempo',
          token: tokenSymbol,
          address: user.tempoAddress,
          method: 'direct',
        })
      const opt = await findOption(ctx, chainName, sym)
      if (!opt) throw new AppError('VALIDATION_FAILED', `Deposits from ${chainName} ${sym} aren't supported`)
      if (!opt.depositAvailable) throw new AppError('PROVIDER_UNAVAILABLE', `Deposits from ${opt.chainName} aren't enabled yet`)
      const [existing] = await ctx.db
        .select()
        .from(schema.depositAddresses)
        .where(and(eq(schema.depositAddresses.userId, user.id), eq(schema.depositAddresses.sourceChain, opt.chain), eq(schema.depositAddresses.sourceToken, opt.token)))
      if (existing) return c.json(depositView(existing, opt.chainName))
      if (refundAddress && !validAddress(opt.vmType, refundAddress)) throw new AppError('VALIDATION_FAILED', `Enter a valid ${opt.chainName} address for refunds`)
      const evm = opt.vmType === 'evm'
      // Relay wants an origin-chain address as `user`; the Solana system program stands in when the user gave none.
      const originUser = evm ? user.tempoAddress : (refundAddress ?? '11111111111111111111111111111111')
      const refundTo = evm ? user.tempoAddress : refundAddress
      const q = await relay(ctx)
        .quote({
          user: originUser,
          originChainId: opt.chainId,
          destinationChainId: TEMPO_CHAIN_ID,
          originCurrency: opt.tokenAddress,
          destinationCurrency: token,
          amount: microToBase(DEPOSIT_QUOTE_MICRO, opt.decimals).toString(),
          recipient: user.tempoAddress,
          useDepositAddress: true,
          // EVM: refunds go back to the same address on the source chain (Privy wallets are the same key everywhere).
          ...(refundTo ? { refundTo } : {}),
        })
        .catch(relayErr)
      const step = q.steps.find((s) => s.depositAddress)
      if (!step?.depositAddress) throw new AppError('PROVIDER_UNAVAILABLE', 'The bridge did not return a deposit address — try again')
      const [row] = await ctx.db
        .insert(schema.depositAddresses)
        .values({
          userId: user.id,
          sourceChain: opt.chain,
          sourceChainId: opt.chainId,
          sourceToken: opt.token,
          sourceTokenAddress: opt.tokenAddress,
          sourceTokenDecimals: opt.decimals,
          address: step.depositAddress,
          refundAddress: refundTo ?? null,
          providerRef: step.requestId ?? null,
        })
        .onConflictDoNothing()
        .returning()
      const saved =
        row ??
        (
          await ctx.db
            .select()
            .from(schema.depositAddresses)
            .where(and(eq(schema.depositAddresses.userId, user.id), eq(schema.depositAddresses.sourceChain, opt.chain), eq(schema.depositAddresses.sourceToken, opt.token)))
        )[0]!
      return c.json({
        ...depositView(saved, opt.chainName),
        estimate: {
          sendUsd: usd(DEPOSIT_QUOTE_MICRO),
          receiveUsd: Number(q.details.currencyOut.amountFormatted),
          feeUsd: relayFeeUsd(q),
          etaSeconds: q.details.timeEstimate,
        },
      })
    },
  )

  // ---------- quotes and sends ----------
  async function plan(user: { tempoAddress: string }, body: z.infer<typeof SendBody>) {
    const amount = micro(body.amountUsd)
    if (amount > ctx.cfg.wallet.sendMaxMicro) throw new AppError('VALIDATION_FAILED', `Sends are limited to $${usd(ctx.cfg.wallet.sendMaxMicro)} at a time`)
    if (body.chain === 'tempo') {
      if (!isAddress(body.to)) throw new AppError('VALIDATION_FAILED', 'Enter a valid Tempo address (0x…)')
      if (body.to.toLowerCase() === user.tempoAddress.toLowerCase()) throw new AppError('VALIDATION_FAILED', "That's your own address")
      return {
        kind: 'send' as const,
        amount,
        receive: amount,
        feeUsd: 0,
        etaSeconds: 1,
        calls: [
          {
            to: token,
            data: encodeFunctionData({
              abi: erc20Abi,
              functionName: 'transfer',
              args: [body.to as `0x${string}`, amount],
            }),
          },
        ] as Call[],
        requestId: undefined as string | undefined,
        token: tokenSymbol,
      }
    }
    const opt = await findOption(ctx, body.chain, body.token)
    if (!opt) throw new AppError('VALIDATION_FAILED', `Sending to ${body.chain} ${body.token} isn't supported`)
    if (!validAddress(opt.vmType, body.to)) throw new AppError('VALIDATION_FAILED', `Enter a valid ${opt.chainName} address`)
    const q = await relay(ctx)
      .quote({
        user: user.tempoAddress,
        originChainId: TEMPO_CHAIN_ID,
        destinationChainId: opt.chainId,
        originCurrency: token,
        destinationCurrency: opt.tokenAddress,
        amount: amount.toString(),
        recipient: body.to,
      })
      .catch(relayErr)
    const items = q.steps.flatMap((s) => s.items.map((i) => ({ step: s, item: i })))
    if (!items.length || items.some(({ step, item }) => step.kind !== 'transaction' || Number(item.data.chainId) !== TEMPO_CHAIN_ID))
      throw new AppError('PROVIDER_UNAVAILABLE', 'The bridge returned steps this wallet cannot sign — try another network')
    const out = q.details.currencyOut
    return {
      kind: 'send_cross_chain' as const,
      amount,
      receive: baseToMicro(out.amount, out.currency.decimals),
      receiveMin: out.minimumAmount ? baseToMicro(out.minimumAmount, out.currency.decimals) : undefined,
      feeUsd: relayFeeUsd(q),
      etaSeconds: q.details.timeEstimate,
      calls: items.map(({ item }) => ({
        to: item.data.to,
        data: item.data.data,
        ...(item.data.value && item.data.value !== '0' ? { value: item.data.value } : {}),
      })) as Call[],
      requestId: q.steps.find((s) => s.requestId)?.requestId,
      token: opt.token,
      chainName: opt.chainName,
    }
  }

  app.post('/wallet/send/quote', zValidator('json', SendBody), async (c) => {
    const p = await plan(c.get('user'), c.req.valid('json'))
    return c.json({
      sendUsd: usd(p.amount),
      receiveUsd: usd(p.receive),
      receiveMinUsd: 'receiveMin' in p && p.receiveMin !== undefined ? usd(p.receiveMin) : undefined,
      bridgeFeeUsd: p.feeUsd,
      networkFeeUsd: 0,
      etaSeconds: p.etaSeconds,
    })
  })

  /** What a send's code is bound to (and a cheap check of the send, without a bridge quote). */
  async function sendTarget(user: { tempoAddress: string }, body: z.infer<typeof SendBody>): Promise<SendTarget & { chainName: string }> {
    const amountMicro = micro(body.amountUsd)
    if (amountMicro > ctx.cfg.wallet.sendMaxMicro) throw new AppError('VALIDATION_FAILED', `Sends are limited to $${usd(ctx.cfg.wallet.sendMaxMicro)} at a time`)
    if (body.chain === 'tempo') {
      if (!isAddress(body.to)) throw new AppError('VALIDATION_FAILED', 'Enter a valid Tempo address (0x…)')
      if (body.to.toLowerCase() === user.tempoAddress.toLowerCase()) throw new AppError('VALIDATION_FAILED', "That's your own address")
      return { chain: 'tempo', token: tokenSymbol, recipient: body.to, amountMicro, chainName: 'Tempo' }
    }
    const opt = await findOption(ctx, body.chain, body.token)
    if (!opt) throw new AppError('VALIDATION_FAILED', `Sending to ${body.chain} ${body.token} isn't supported`)
    if (!validAddress(opt.vmType, body.to)) throw new AppError('VALIDATION_FAILED', `Enter a valid ${opt.chainName} address`)
    return { chain: opt.chain, token: opt.token, recipient: body.to, amountMicro, chainName: opt.chainName }
  }

  /** Step 1 of a send: email a 6-digit code bound to this amount and recipient. */
  app.post('/wallet/send/code', zValidator('json', SendBody), async (c) => {
    const user = c.get('user')
    const { chainName, ...target } = await sendTarget(user, c.req.valid('json'))
    const balance = await tokenBalance(ctx, user.tempoAddress as `0x${string}`)
    if (balance < target.amountMicro) throw new AppError('VALIDATION_FAILED', `Not enough in your main wallet ($${usd(balance).toFixed(2)})`)
    return c.json(await issueSendCode(ctx, user, target, { amountUsd: usd(target.amountMicro), chainName, token: target.token }))
  })

  /** The calls to sign for a send (the fee relay only pays for these exact calls). Needs the email code only when SEND_CODE_REQUIRED=true. */
  app.post('/wallet/send', zValidator('json', ConfirmedSendBody), async (c) => {
    const user = c.get('user')
    const { verificationId, code, ...body } = c.req.valid('json')
    const { chainName: _n, ...target } = await sendTarget(user, body)
    const balance = await tokenBalance(ctx, user.tempoAddress as `0x${string}`)
    if (balance < target.amountMicro) throw new AppError('VALIDATION_FAILED', `Not enough in your main wallet ($${usd(balance).toFixed(2)})`)
    if ((await sponsoredToday(user.id)) >= ctx.cfg.wallet.sponsorTxPerDay)
      throw new AppError('RATE_LIMITED', `You've made ${ctx.cfg.wallet.sponsorTxPerDay} wallet transactions today; try again tomorrow`)
    // Quote before using the code up, so a bridge hiccup doesn't cost the user their code.
    const p = await plan(user, body)
    let codeId: string | undefined
    if (ctx.cfg.wallet.sendCodeRequired) {
      if (!verificationId || !code) throw new AppError('VALIDATION_FAILED', 'Enter the 6-digit code we emailed you')
      codeId = await consumeSendCode(ctx, user.id, verificationId, code, target)
    }
    const [move] = await ctx.db
      .insert(schema.walletMoves)
      .values({
        userId: user.id,
        kind: p.kind,
        status: 'pending',
        amountMicro: p.amount,
        deliveredMicro: null,
        chain: body.chain,
        token: p.token,
        counterparty: body.to,
        externalId: p.requestId ?? null,
        allowedTargets: [...new Set(p.calls.map((x) => x.to.toLowerCase()))],
        detail: {
          expectedReceiveMicro: p.receive.toString(),
          bridgeFeeUsd: p.feeUsd,
          submitted: false,
          verifiedBy: codeId ? 'email_code' : 'app',
          calls: p.calls.map((x) => ({ to: x.to.toLowerCase(), data: x.data.toLowerCase(), value: x.value ?? '0' })),
        },
      })
      .returning()
    if (codeId) await linkCodeToMove(ctx, codeId, move!.id)
    return c.json({
      sendId: move!.id,
      chainId: ctx.cfg.network.chainId,
      // Sign these as ONE Tempo transaction with feePayer: true through the /relay transport.
      calls: p.calls,
      feePayer: true,
      sendUsd: usd(p.amount),
      receiveUsd: usd(p.receive),
      bridgeFeeUsd: p.feeUsd,
      etaSeconds: p.etaSeconds,
    })
  })

  app.post('/wallet/send/:id/submitted', zValidator('json', z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })), async (c) => {
    const user = c.get('user')
    const id = c.req.param('id')
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new AppError('NOT_FOUND', 'Send not found')
    const [move] = await ctx.db
      .select()
      .from(schema.walletMoves)
      .where(and(eq(schema.walletMoves.id, id), eq(schema.walletMoves.userId, user.id)))
    if (!move || (move.kind !== 'send' && move.kind !== 'send_cross_chain')) throw new AppError('NOT_FOUND', 'Send not found')
    const { txHash } = c.req.valid('json')
    const receipt = await ctx.rpc.waitForTransactionReceipt({ hash: txHash as Hex, timeout: 20_000 }).catch(() => undefined)
    if (!receipt) throw new AppError('VALIDATION_FAILED', 'Transaction not found on Tempo yet — retry in a few seconds')
    if (receipt.from.toLowerCase() !== user.tempoAddress.toLowerCase()) throw new AppError('FORBIDDEN', 'That transaction was not sent from your wallet')
    const ok = receipt.status === 'success'
    const status = !ok ? 'failed' : move.kind === 'send' ? 'completed' : 'pending'
    await ctx.db
      .update(schema.walletMoves)
      .set({
        txHash,
        status,
        ...(move.kind === 'send' && ok ? { deliveredMicro: move.amountMicro } : {}),
        detail: { ...(move.detail ?? {}), submitted: true },
        updatedAt: new Date(),
      })
      .where(eq(schema.walletMoves.id, move.id))
    return c.json({ sendId: move.id, status, txHash })
  })

  // ---------- GET /wallet/activity ----------
  app.get(
    '/wallet/activity',
    zValidator(
      'query',
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(30),
        before: z.string().datetime().optional(),
      }),
    ),
    async (c) => {
      const user = c.get('user')
      const { limit, before } = c.req.valid('query')
      const beforeTs = before ? new Date(before) : new Date(Date.now() + 60_000)
      const moves = await ctx.db
        .select()
        .from(schema.walletMoves)
        .where(
          and(
            eq(schema.walletMoves.userId, user.id),
            sql`${schema.walletMoves.createdAt} < ${beforeTs.toISOString()}`,
            sql`not (${schema.walletMoves.status} = 'pending' and ${schema.walletMoves.detail}->>'submitted' = 'false' and ${schema.walletMoves.createdAt} < now() - interval '1 hour')`,
          ),
        )
        .orderBy(desc(schema.walletMoves.createdAt))
        .limit(limit)
      const sessions = await ctx.db
        .select()
        .from(schema.userSessions)
        .where(and(eq(schema.userSessions.userId, user.id), sql`${schema.userSessions.createdAt} < ${beforeTs.toISOString()}`))
        .orderBy(desc(schema.userSessions.createdAt))
        .limit(limit)
      const items = [
        ...moves.map((m) => ({
          id: m.id,
          type: m.kind === 'deposit' ? 'deposit' : 'send',
          status: m.status,
          amountUsd: usd(m.amountMicro),
          deliveredUsd: m.deliveredMicro != null ? usd(m.deliveredMicro) : null,
          chain: m.chain,
          token: m.token,
          counterparty: m.counterparty,
          txHash: m.txHash,
          at: m.createdAt.toISOString(),
        })),
        ...(
          await Promise.all(
            sessions.map(async (s) => {
              // user_sessions doesn't track the deposit; the channel state does.
              const st = await ctx.sessions?.getChannel(s.channelId).catch(() => null)
              const deposit = st && st.deposit > s.depositMicro ? st.deposit : s.depositMicro
              const spent = st?.spent ?? s.countedMicro
              const closed = s.status === 'closed' || Boolean(st?.finalized)
              return [
                {
                  id: `${s.channelId}:open`,
                  type: 'to_ai_balance',
                  status: 'completed',
                  amountUsd: usd(deposit),
                  deliveredUsd: null,
                  chain: 'tempo',
                  token: tokenSymbol,
                  counterparty: null,
                  txHash: null,
                  at: s.createdAt.toISOString(),
                },
                ...(closed
                  ? [
                      {
                        id: `${s.channelId}:close`,
                        type: 'from_ai_balance',
                        status: 'completed',
                        amountUsd: usd(deposit - spent),
                        deliveredUsd: null,
                        chain: 'tempo',
                        token: tokenSymbol,
                        counterparty: null,
                        txHash: s.lastSettleTx,
                        at: (s.lastSettledAt ?? s.lastUsedAt).toISOString(),
                        spentUsd: usd(spent),
                      },
                    ]
                  : []),
              ]
            }),
          )
        ).flat(),
      ]
        .sort((a, b) => b.at.localeCompare(a.at))
        .slice(0, limit)
      return c.json({
        items,
        nextBefore: items.length === limit ? items.at(-1)!.at : null,
      })
    },
  )

  // ---------- POST /relay: the operator pays the network fee for the user's own transactions ----------
  // ---------- spending key (Tempo access key with an on-chain daily limit) ----------
  /** On-chain state of the user's spending key, plus what the frontend should authorize. */
  async function spendingKeyState(user: { tempoAddress: string; dailyLimitMicro: bigint; spendingKeyAddress: string | null; spendingKeyExpiresAt: Date | null }) {
    const limitMicro = user.dailyLimitMicro + ctx.cfg.pricing.depositChunkMicro
    const setup = {
      token,
      limitUsd: usd(limitMicro),
      periodSeconds: 86_400,
      expiryDays: ctx.cfg.pricing.spendingKeyDays,
      // The key may only call Tempo's payment-channel precompile: a stolen key can't transfer
      // tokens to anyone or touch any other contract (tested: direct transfers → CallNotAllowed).
      scopes: [{ address: ESCROW_PRECOMPILE }],
    }
    if (!user.spendingKeyAddress) return { status: 'missing' as const, setup }
    try {
      const [meta, left] = await Promise.all([
        Actions.accessKey.getMetadata(ctx.rpc as never, { account: user.tempoAddress as `0x${string}`, accessKey: user.spendingKeyAddress as `0x${string}` }),
        Actions.accessKey.getRemainingLimit(ctx.rpc as never, { account: user.tempoAddress as `0x${string}`, accessKey: user.spendingKeyAddress as `0x${string}`, token }),
      ])
      const expired = Number(meta.expiry) * 1000 < Date.now() + 86_400_000 // renew a day early
      const status = meta.isRevoked ? 'revoked' : expired ? 'expiring' : 'active'
      return {
        status,
        address: user.spendingKeyAddress,
        expiresAt: new Date(Number(meta.expiry) * 1000).toISOString(),
        onChain: { remainingTodayUsd: usd(left.remaining), periodEndsAt: left.periodEnd ? new Date(Number(left.periodEnd) * 1000).toISOString() : null },
        setup,
      }
    } catch (e) {
      console.warn('[wallet] spending key read failed:', (e as Error).message)
      return { status: 'unknown' as const, address: user.spendingKeyAddress, setup }
    }
  }

  app.post('/wallet/spending-key', zValidator('json', z.object({ accessKeyAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })), async (c) => {
    const user = c.get('user')
    const key = c.req.valid('json').accessKeyAddress.toLowerCase() as `0x${string}`
    const account = user.tempoAddress as `0x${string}`
    const meta = await Actions.accessKey.getMetadata(ctx.rpc as never, { account, accessKey: key }).catch(() => undefined)
    if (!meta || meta.isRevoked || Number(meta.expiry) * 1000 < Date.now()) throw new AppError('VALIDATION_FAILED', 'That spending key is not authorized on your wallet (or has expired)')
    if (meta.spendPolicy !== 'limited') throw new AppError('VALIDATION_FAILED', 'The spending key must have a daily limit')
    const expiresAt = new Date(Number(meta.expiry) * 1000)
    await ctx.db.update(schema.users).set({ spendingKeyAddress: key, spendingKeyExpiresAt: expiresAt }).where(eq(schema.users.id, user.id))
    return c.json(await spendingKeyState({ ...user, spendingKeyAddress: key, spendingKeyExpiresAt: expiresAt }))
  })

  // ---------- return locked money now (instead of waiting for the idle close) ----------
  app.post('/wallet/locked/return', async (c) => {
    const user = c.get('user')
    if (!ctx.sessions) throw new AppError('PROVIDER_UNAVAILABLE', 'Paid runs are not configured')
    const rows = await ctx.db
      .select()
      .from(schema.userSessions)
      .where(and(eq(schema.userSessions.userId, user.id), eq(schema.userSessions.status, 'open')))
    let returned = 0n
    const skipped: string[] = []
    for (const r of rows) {
      const busy = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.requests)
        .where(and(eq(schema.requests.channelId, r.channelId), sql`${schema.requests.status} in ('pending','running')`))
      if (busy[0]?.n) {
        skipped.push(`${r.channelId}: an answer is still running`)
        continue
      }
      const out = await closeChannel(ctx.sessions, ctx.db, token, r.channelId)
      if (out.refunded !== undefined) returned += out.refunded
      else if (out.skipped) skipped.push(`${r.channelId}: ${out.skipped}`)
    }
    return c.json({ returnedUsd: usd(returned), skipped })
  })

  app.post('/relay', async (c) => {
    const user = c.get('user')
    const body = (await c.req.json().catch(() => null)) as { method?: string; id?: unknown; jsonrpc?: string } | unknown[] | null
    if (!body || Array.isArray(body) || typeof body.method !== 'string') throw new AppError('VALIDATION_FAILED', 'Send one JSON-RPC request')
    if (!RELAY_METHODS.has(body.method)) {
      console.warn(`[relay] user=${user.id} refused method ${body.method}`)
      return c.json({
        jsonrpc: '2.0',
        id: body.id ?? null,
        error: {
          code: -32601,
          message: `${body.method} is not available on this relay`,
        },
      })
    }
    if (!ctx.sessions) throw new AppError('PROVIDER_UNAVAILABLE', 'Fee sponsorship is not configured')

    const userAddr = user.tempoAddress.toLowerCase()
    const relayFor = Relay.create({
      client: relayClient as never,
      plugins: [
        Relay.feePayer({
          account: ctx.sessions.operator,
          feeToken: token,
          name: 'SmartRouter',
          validate: async (req) => {
            const verdict = await decide(req)
            const r0 = req as { from?: string; calls?: { to?: string; data?: string }[]; keyAuthorization?: unknown }
            console.log(
              `[relay] user=${user.id} method=${body.method} from=${r0.from} keyAuth=${Boolean(r0.keyAuthorization)} calls=${(r0.calls ?? []).map((x) => `${x.to}:${x.data?.slice(0, 10)}`).join(',')} → ${verdict}`,
            )
            return verdict
          },
          onSponsored: async (e) => {
            await ctx.db
              .insert(schema.sponsoredTxs)
              .values({
                userId: user.id,
                signPayload: e.signPayload,
                method: e.method,
              })
              .onConflictDoNothing()
          },
        }),
      ],
    })
    async function decide(req: unknown): Promise<boolean | 'spend_limit_exceeded'> {
      const r = req as {
        from?: string
        calls?: { to?: string; data?: string }[]
        to?: string
        data?: string
      }
      if (r.from?.toLowerCase() !== userAddr) return false
      const calls = r.calls?.length ? r.calls : r.to ? [{ to: r.to, data: r.data }] : []
      // Authorizing the spending key: a transaction that carries a key authorization and only an
      // empty call (viem sends one to the zero address).
      const noop = (x: { to?: string; data?: string }) => /^0x0{40}$/i.test(x.to ?? '') && (!x.data || x.data === '0x')
      if ((req as { keyAuthorization?: unknown }).keyAuthorization && calls.every(noop)) return (await sponsoredToday(user.id)) < ctx.cfg.wallet.sponsorTxPerDay
      if (!calls.length) return false
      if ((await sponsoredToday(user.id)) >= ctx.cfg.wallet.sponsorTxPerDay) return 'spend_limit_exceeded'
      // Money leaving the wallet: only the exact calls of a send the app prepared through
      // POST /wallet/send (pending, not yet submitted). Anything else isn't sponsored.
      const confirmed = await confirmedCalls(user.id)
      return calls.every((call) => {
        const to = call.to?.toLowerCase()
        if (!to) return false
        if (to === Addresses.accountKeychain.toLowerCase()) return true // update the key's limit, or revoke it
        return confirmed.has(`${to}:${(call.data ?? '0x').toLowerCase()}`)
      })
    }
    const res = await relayFor.fetch(
      new Request('http://relay/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    )
    const text = await res.text()
    if (text.includes('"error"')) console.warn(`[relay] user=${user.id} method=${body.method} error ${text.slice(0, 300)}`)
    return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } })
  })

  /** `to:data` of every call in this user's app-prepared sends that are still waiting to be signed. */
  async function confirmedCalls(userId: string) {
    const rows = await ctx.db
      .select({ d: schema.walletMoves.detail })
      .from(schema.walletMoves)
      .where(
        and(
          eq(schema.walletMoves.userId, userId),
          inArray(schema.walletMoves.kind, ['send', 'send_cross_chain']),
          eq(schema.walletMoves.status, 'pending'),
          sql`${schema.walletMoves.txHash} is null`,
          sql`${schema.walletMoves.detail}->>'verifiedBy' in ('email_code', 'app')`,
          gte(schema.walletMoves.createdAt, sql`now() - interval '30 minutes'`),
        ),
      )
    return new Set(rows.flatMap((r) => ((r.d?.calls as { to: string; data: string }[] | undefined) ?? []).map((x) => `${x.to}:${x.data}`)))
  }

  return app
}

function depositView(row: typeof schema.depositAddresses.$inferSelect, chainName: string) {
  return {
    chain: row.sourceChain,
    chainName,
    token: row.sourceToken,
    tokenAddress: row.sourceTokenAddress,
    address: row.address,
    method: 'bridge',
    note: `Send only ${row.sourceToken} on ${chainName} to this address. It arrives in your Tempo wallet as USDC.e, minus the bridge fee.`,
  }
}
