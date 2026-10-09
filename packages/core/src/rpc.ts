/**
 * Tempo RPC transport: primary endpoint first, public backups after it. Each endpoint backs off
 * on rate limits ("Request exceeds defined limit"); if it keeps failing, viem's fallback moves
 * to the next one. No JSON-RPC batching: payment opens use eth_sendRawTransactionSync, which
 * waits for inclusion, and batching those made every request wait for the slowest (and dRPC
 * rejects such batches with a 500).
 */
import { fallback, http, type Transport } from 'viem'
import type { Config } from '@smartrouter/config'

export function tempoTransport(cfg: Config, opts: { timeoutMs?: number; retryCount?: number } = {}): Transport {
  const one = (url: string) => http(url, { timeout: opts.timeoutMs ?? 15_000, retryCount: opts.retryCount ?? 4, retryDelay: 250 })
  const urls = cfg.network.rpcUrls
  return urls.length === 1 ? one(urls[0]!) : fallback(urls.map(one), { rank: false, retryCount: 1 })
}
