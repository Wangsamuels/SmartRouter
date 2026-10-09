/**
 * Wallet alerts (every 15 min): the hot wallet that pays providers (mainnet USDC.e), the
 * operator that pays settlement and sponsored fees, and the hot wallet's daily spend cap.
 * Alerts go to the logs as `[alert]` lines and to Sentry as warnings.
 */
import { createPublicClient, erc20Abi, http, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { tempo, tempoModerato } from 'viem/chains'
import { alert, pgSpendLimiter, tempoTransport } from '@smartrouter/core'
import type { JobDeps } from './index.js'

const USDCE = '0x20c000000000000000000000b9537d11c60e8b50' as const
const usd = (m: bigint) => (Number(m) / 1e6).toFixed(2)

export async function walletAlerts({ cfg, db, sessions }: JobDeps) {
  const balance = (chain: typeof tempo | typeof tempoModerato, rpc: string, token: Address, who: Address) =>
    createPublicClient({ chain, transport: http(rpc, { timeout: 10_000 }) }).readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [who] })

  if (cfg.treasury.hotWalletKey) {
    const hot = privateKeyToAccount(cfg.treasury.hotWalletKey).address
    const bal = await balance(tempo, 'https://rpc.tempo.xyz', USDCE, hot)
    if (bal < cfg.alerts.hotWalletMinMicro) alert(`hot wallet ${hot} low: $${usd(bal)} USDC.e (min $${usd(cfg.alerts.hotWalletMinMicro)}) — paid runs will fail when it runs out`)
    const spent = await pgSpendLimiter(db, { dailyLimitMicro: cfg.treasury.hotWalletDailyLimitMicro, token: USDCE }).spentToday()
    if (spent * 10n >= cfg.treasury.hotWalletDailyLimitMicro * 8n) alert(`hot wallet spent $${usd(spent)} of its $${usd(cfg.treasury.hotWalletDailyLimitMicro)} daily cap`)
  }
  if (sessions) {
    const chain = cfg.network.name === 'tempo' ? tempo : tempoModerato
    const bal = await createPublicClient({ chain, transport: tempoTransport(cfg) }).readContract({ address: cfg.tokens.payment, abi: erc20Abi, functionName: 'balanceOf', args: [sessions.operator.address] })
    if (bal < cfg.alerts.operatorMinMicro) alert(`operator ${sessions.operator.address} low: $${usd(bal)} (min $${usd(cfg.alerts.operatorMinMicro)}) — settlement and sponsored fees need it`)
  }
}
