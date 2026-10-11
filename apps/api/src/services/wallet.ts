/**
 * The user's wallet, in two parts:
 *  - main wallet: their own Tempo address (Privy embedded wallet). Deposits land here; sends
 *    leave from here. Balances are read from Tempo, never stored.
 *  - AI balance: the open payment session (escrow deposit) that pays for answers. Moving money
 *    main → AI opens a deposit; AI → main closes it (both through the mppx client).
 * Cross-chain deposits and sends go through Relay (mainnet only).
 */
import { createRelayApi, TEMPO_CHAIN_ID, type RelayApi, type RelayChain } from '@smartrouter/core'
import { erc20Abi } from 'viem'
import type { AppContext } from '../context.js'

export const usd = (m: bigint) => Number(m) / 1e6
export const micro = (usdAmount: number) => BigInt(Math.round(usdAmount * 1e6))

export const TRANSFER_SELECTOR = '0xa9059cbb' // transfer(address,uint256)
export const TRANSFER_WITH_MEMO_SELECTOR = '0x95777d59' // transferWithMemo(address,uint256,bytes32)
export const APPROVE_SELECTOR = '0x095ea7b3' // approve(address,uint256)

const EVM = /^0x[0-9a-fA-F]{40}$/
const SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/

/** Address format each network expects. */
export function validAddress(vmType: string, address: string) {
  if (vmType === 'evm') return EVM.test(address)
  if (vmType === 'svm') return SOLANA.test(address)
  return false
}

let relayApi: RelayApi | undefined
export function relay(ctx: AppContext) {
  return (relayApi ??= createRelayApi({ apiKey: ctx.cfg.relay.apiKey, baseUrl: ctx.cfg.relay.url }))
}

export async function tokenBalance(ctx: AppContext, address: `0x${string}`): Promise<bigint> {
  return (await ctx.rpc.readContract({ address: ctx.cfg.tokens.payment, abi: erc20Abi, functionName: 'balanceOf', args: [address] })) as bigint
}

/** Networks offered in Deposit and Send, in display order. */
const CHAINS = ['base', 'arbitrum', 'optimism', 'polygon', 'bsc', 'avalanche', 'ethereum', 'solana'] as const
const TOKENS = ['USDC', 'USDT'] as const

export type ChainOption = {
  chain: string // relay chain name, e.g. base
  chainId: number
  chainName: string
  vmType: string
  token: string // USDC / USDT
  tokenAddress: string
  decimals: number
  /** Deposits from this chain need RELAY_API_KEY (Solana). */
  depositAvailable: boolean
}

let cache: { at: number; options: ChainOption[] } | undefined
const CACHE_MS = 60 * 60_000

/** Cross-chain routes in and out of Tempo (mainnet only — Relay doesn't serve the testnet). */
export async function chainOptions(ctx: AppContext): Promise<ChainOption[]> {
  if (ctx.cfg.network.name !== 'tempo') return []
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.options
  try {
    const chains = await relay(ctx).chains()
    const tempo = chains.find((c) => c.id === TEMPO_CHAIN_ID)
    const paymentToken = ctx.cfg.tokens.payment.toLowerCase()
    if (!tempo?.erc20Currencies?.some((c) => c.address.toLowerCase() === paymentToken && c.supportsBridging)) throw new Error('Relay does not bridge the payment token')
    const byName = new Map<string, RelayChain>(chains.map((c) => [c.name, c]))
    const options: ChainOption[] = []
    for (const name of CHAINS) {
      const c = byName.get(name)
      if (!c || c.disabled || !c.depositEnabled) continue
      for (const symbol of TOKENS) {
        const t = c.erc20Currencies?.find((x) => x.symbol === symbol && x.supportsBridging)
        if (!t) continue
        options.push({
          chain: c.name,
          chainId: c.id,
          chainName: c.displayName,
          vmType: c.vmType,
          token: symbol,
          tokenAddress: t.address,
          decimals: t.decimals,
          depositAvailable: c.vmType === 'evm' || relay(ctx).hasKey,
        })
      }
    }
    cache = { at: Date.now(), options }
    return options
  } catch (e) {
    console.warn('[wallet] Relay chain list unavailable:', (e as Error).message)
    return cache?.options ?? []
  }
}

export async function findOption(ctx: AppContext, chain: string, token: string) {
  return (await chainOptions(ctx)).find((o) => o.chain === chain && o.token === token.toUpperCase())
}
