/**
 * Profit sweep. With REVENUE_TO=operator, users' payments land in the operator wallet (on
 * mainnet that is the hot wallet). It pays providers and every network fee first; whatever is
 * above HOT_WALLET_FLOAT_USD is profit and goes to PROFIT_ADDRESS (the treasury):
 *   - as soon as profit reaches PROFIT_SWEEP_MIN_USD ($20), or
 *   - once every PROFIT_SWEEP_INTERVAL_HOURS (24 h) if there is more than dust.
 */
import { encodeFunctionData, erc20Abi, type Hex } from 'viem'
import { readContract, sendTransactionSync } from 'viem/actions'
import type { Config } from '@smartrouter/config'
import { desc, eq, schema, type Db } from '@smartrouter/db'
import type { SessionServer } from '../payments-in/server.js'

export type SweepPlan = { sweep: false; reason: string; balance: bigint; profit: bigint } | { sweep: true; reason: string; balance: bigint; profit: bigint }

/** Pure decision, unit-tested. */
export function planSweep(p: { balance: bigint; floatMicro: bigint; minMicro: bigint; dustMicro: bigint; intervalMs: number; lastSweepAt?: Date; now?: Date }): SweepPlan {
  const profit = p.balance > p.floatMicro ? p.balance - p.floatMicro : 0n
  if (profit >= p.minMicro) return { sweep: true, reason: 'threshold', balance: p.balance, profit }
  const now = (p.now ?? new Date()).getTime()
  const due = !p.lastSweepAt || now - p.lastSweepAt.getTime() >= p.intervalMs
  if (due && profit > p.dustMicro) return { sweep: true, reason: 'interval', balance: p.balance, profit }
  return { sweep: false, reason: due ? 'below dust' : 'not due', balance: p.balance, profit }
}

export async function sweepProfit(cfg: Config, db: Db, sessions: SessionServer): Promise<SweepPlan & { txHash?: Hex }> {
  const to = cfg.revenue.profitAddress
  if (cfg.revenue.to !== 'operator') return { sweep: false, reason: 'REVENUE_TO=treasury', balance: 0n, profit: 0n }
  if (!to) return { sweep: false, reason: 'no PROFIT_ADDRESS / TREASURY_ADDRESS', balance: 0n, profit: 0n }
  if (to.toLowerCase() === sessions.operator.address.toLowerCase()) return { sweep: false, reason: 'profit address is the operator', balance: 0n, profit: 0n }
  const token = cfg.tokens.payment
  const balance = (await readContract(sessions.client as never, { address: token, abi: erc20Abi, functionName: 'balanceOf', args: [sessions.operator.address] })) as bigint
  const [last] = await db.select({ at: schema.treasuryMoves.createdAt }).from(schema.treasuryMoves).where(eq(schema.treasuryMoves.kind, 'sweep')).orderBy(desc(schema.treasuryMoves.createdAt)).limit(1)
  const plan = planSweep({ balance, floatMicro: cfg.revenue.floatMicro, minMicro: cfg.revenue.sweepMinMicro, dustMicro: cfg.revenue.sweepDustMicro, intervalMs: cfg.revenue.sweepIntervalMs, lastSweepAt: last?.at })
  if (!plan.sweep) return plan
  // The fee comes out of the same token, so leave a little headroom below the float.
  const receipt = await sendTransactionSync(sessions.client as never, {
    calls: [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, plan.profit] }) }],
    feeToken: token,
  } as never)
  const ok = (receipt as { status: string }).status === 'success'
  const txHash = (receipt as { transactionHash: Hex }).transactionHash
  await db.insert(schema.treasuryMoves).values({ kind: 'sweep', amountMicro: plan.profit, token, txHash, refId: to.toLowerCase(), status: ok ? 'confirmed' : 'failed' }).onConflictDoNothing()
  if (!ok) throw new Error(`profit sweep tx ${txHash} reverted`)
  return { ...plan, txHash }
}
