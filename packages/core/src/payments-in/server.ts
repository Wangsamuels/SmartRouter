/**
 * Incoming payments: users pay SmartRouter per request over an MPP session (a TIP-20
 * escrow channel on Tempo). The user deposits once (their allocation), then each /run
 * carries a signed cumulative voucher. Funds stay in escrow until the operator settles
 * `spent` to the treasury; the unspent rest returns to the user on close.
 *
 *   payer     = the user's Tempo account
 *   recipient = TREASURY_ADDRESS (payee)
 *   operator  = OPERATOR_PRIVATE_KEY (sends settle/close, sponsors open/top-up fees)
 *
 * Accounting rule ("never charged for failed results"): mppx deducts the request amount
 * from `spent` when it accepts the voucher, before the model runs. If the run fails we
 * hand it back with refund(), so settlement and close (which capture `spent`, not the
 * voucher) never take money for a failed result.
 */
import { Mppx, tempo } from 'mppx/server'
import { createClient, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo as tempoChain, tempoModerato } from 'viem/chains'
import type { Config } from '@smartrouter/config'
import type { Db } from '@smartrouter/db'
import { pgSessionStore } from './store.js'
import { recordSettlement } from './settlement.js'
import { tempoTransport } from '../rpc.js'

/** The fields of mppx's persisted channel state that SmartRouter reads (ChannelStore.State). */
export type ChannelState = {
  channelId: Hex
  payer: `0x${string}`
  payee: `0x${string}`
  authorizedSigner: `0x${string}`
  token: `0x${string}`
  chainId: number
  deposit: bigint
  highestVoucherAmount: bigint
  spent: bigint
  units: number
  settledOnChain: bigint
  closeRequestedAt: bigint
  finalized: boolean
  createdAt: string
  operator?: `0x${string}`
  escrowContract?: `0x${string}`
  descriptor?: Record<string, unknown>
  highestVoucher?: { cumulativeAmount: bigint | string; signature: Hex } | null
  lastSettlementAt?: string
}

/** mppx keys channel state by the lowercase channel id (ChannelStore.normalizeChannelId). */
const channelKey = (id: string) => {
  if (!/^0x[0-9a-fA-F]{64}$/.test(id)) throw new Error('invalid channel id')
  return id.toLowerCase()
}

export type SessionServer = ReturnType<typeof createSessionServer>

export const toDecimal = (micro: bigint) => {
  const neg = micro < 0n
  const v = neg ? -micro : micro
  const s = `${v / 1_000_000n}.${(v % 1_000_000n).toString().padStart(6, '0')}`.replace(/\.?0+$/, '')
  return (neg ? '-' : '') + (s || '0')
}

export function createSessionServer(cfg: Config, db: Db) {
  if (!cfg.treasury.address) throw new Error('TREASURY_ADDRESS is required for paid runs')
  if (!cfg.mpp.operatorKey) throw new Error('OPERATOR_PRIVATE_KEY (or HOT_WALLET_PRIVATE_KEY) is required for paid runs')
  if (!cfg.mpp.secretKey) throw new Error('MPP_SECRET_KEY is required for paid runs')

  const operator = privateKeyToAccount(cfg.mpp.operatorKey)
  const chain = cfg.network.name === 'tempo' ? tempoChain : tempoModerato
  // Public Tempo RPCs rate-limit bursts ("Request exceeds defined limit"); batch calls and back
  // off instead of failing a payment. Production should set a dedicated TEMPO_RPC_URL.
  const client = createClient({
    chain,
    account: operator,
    transport: tempoTransport(cfg),
  })
  const store = pgSessionStore(db, { keyPrefix: `mpp:${cfg.network.chainId}:` })

  const mppx = Mppx.create({
    secretKey: cfg.mpp.secretKey,
    realm: 'smartrouter',
    methods: [
      tempo.session({
        account: operator,
        recipient: cfg.treasury.address,
        operator: operator.address,
        currency: cfg.tokens.payment,
        decimals: 6,
        chainId: cfg.network.chainId,
        getClient: () => client,
        store,
        unitType: 'request',
        // Fees for server-sent txs (user close, sponsored open/top-up) in the payment token.
        feeToken: cfg.tokens.payment,
        suggestedDeposit: String(cfg.pricing.defaultAllocationUsd),
        ...(cfg.mpp.sponsorFees ? { feePayer: true as const } : {}),
        // No automatic settlement: the worker settles idle channels in batches (fewer txs).
        // User-initiated closes still capture `spent` here; record them like the worker's.
        onSessionSettlement: (e) => recordSettlement(db, cfg.tokens.payment, { channelId: e.channelId, txHash: e.txHash, kind: e.trigger === 'close' ? 'close' : 'settle', totalSettled: e.amount, delta: e.delta }),
      }),
    ],
  })

  return {
    mppx,
    store,
    client,
    operator,
    chainId: cfg.network.chainId,

    /** Per-request payment gate. amountMicro is the quote price; meta binds the voucher to the quote. */
    charge(request: Request, amountMicro: bigint, meta?: Record<string, string>) {
      return mppx.session({ amount: toDecimal(amountMicro), unitType: 'request', ...(meta ? { meta } : {}) })(request)
    },

    async getChannel(channelId: string): Promise<ChannelState | null> {
      return (await store.get(channelKey(channelId))) as ChannelState | null
    },

    /**
     * Gives back a charge for a failed request. Never takes spent below what is already
     * settled on-chain (that money has moved; the caller records it as owed instead).
     * Returns the amount actually refunded.
     */
    async refund(channelId: string, amountMicro: bigint): Promise<bigint> {
      return store.update(channelKey(channelId), (raw) => {
        const cur = raw as ChannelState | null
        if (!cur) return { op: 'noop', result: 0n }
        const floor = cur.settledOnChain > 0n ? cur.settledOnChain : 0n
        const next = cur.spent - amountMicro < floor ? floor : cur.spent - amountMicro
        return { op: 'set', value: { ...cur, spent: next, units: Math.max(0, cur.units - 1) }, result: cur.spent - next }
      }) as Promise<bigint>
    },
  }
}

/** Remaining prepaid balance on a channel (deposit not yet spent), micro-USD. */
export function channelRemaining(state: Pick<ChannelState, 'deposit' | 'spent'>): bigint {
  const r = state.deposit - state.spent
  return r > 0n ? r : 0n
}
