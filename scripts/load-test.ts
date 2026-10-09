/**
 * Load + concurrency test on testnet (mock models, real Moderato payments):
 *
 *   API_URL=https://smartrouter-testnet-….herokuapp.com USERS=20 RUNS=5 pnpm load:test
 *
 * 1. USERS throwaway wallets (one faucet wallet funds the rest) each sign in, open a session
 *    and make RUNS paid runs back to back; all users run in parallel.
 * 2. One user fires BURST runs at the same moment: at most 3 may stream at once (the rest
 *    must get 429 RATE_LIMITED, never a double charge).
 * 3. Books must balance for every user: server-side spent == sum of charged `done` events.
 * 4. Every session is closed; the treasury must gain exactly the total charged.
 * Prints latency percentiles (time to first byte, to first token, to done).
 */
import { sessionManager } from 'mppx/client'
import { createClient, createPublicClient, erc20Abi, http, publicActions, walletActions, type Address } from 'viem'
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const RPC = 'https://rpc.moderato.tempo.xyz'
const USERS = Number(process.env.USERS ?? 10)
const RUNS = Number(process.env.RUNS ?? 4)
const BURST = Number(process.env.BURST ?? 6)
const TOKEN = '0x20c0000000000000000000000000000000000000' as Address // pathUSD on Moderato
const pub = createPublicClient({ chain: tempoModerato, transport: http(RPC) })
const bal = (who: Address) => pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [who] })

type Sample = { ttfb: number; ttft?: number; total: number; ok: boolean; status: number; code?: string }
const samples: Sample[] = []
let failures = 0
const check = (ok: boolean, msg: string) => {
  console.log(`${ok ? '✔' : '✘'} ${msg}`)
  if (!ok) failures++
}
const pct = (xs: number[], p: number) => (xs.length ? xs.sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))]! : NaN)

class User {
  cookie = ''
  charged = 0n
  manager
  constructor(public account: PrivateKeyAccount) {
    const client = createClient({ chain: tempoModerato, account, transport: http(RPC) })
    this.manager = sessionManager({ account, client: client as never, maxDeposit: '1', fetch: this.fetch })
  }
  fetch: typeof fetch = async (input, init) => {
    const h = new Headers(init?.headers)
    h.set('origin', ORIGIN)
    if (this.cookie) h.set('cookie', this.cookie)
    const r = await fetch(input, { ...init, headers: h })
    const s = r.headers.get('set-cookie')
    if (s) this.cookie = s.split(';')[0]!
    return r
  }
  async call(method: string, path: string, body?: unknown) {
    const r = await this.fetch(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    const j: any = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(j).slice(0, 200)}`)
    return j
  }
  async signIn() {
    const { message } = await this.call('POST', '/auth/challenge', { address: this.account.address, origin: ORIGIN })
    await this.call('POST', '/auth/verify', { message, signature: await this.account.signMessage({ message }) })
  }
  async run(chatId: string, prompt: string): Promise<Sample> {
    const q = await this.call('POST', `/chats/${chatId}/quote`, { prompt })
    const t0 = performance.now()
    const r = await this.manager.fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q.quoteId, prompt }) })
    const ttfb = performance.now() - t0
    let ttft: number | undefined
    let text = ''
    if (r.body) {
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        text += dec.decode(value, { stream: true })
        if (ttft === undefined && text.includes('event: delta')) ttft = performance.now() - t0
      }
    }
    const done = text.split('\n\n').find((b) => b.startsWith('event: done'))
    let code: string | undefined
    if (done) this.charged += BigInt(Math.round(JSON.parse(done.split('data: ')[1]!).chargedUsd * 1e6))
    else {
      try {
        code = JSON.parse(text).code
      } catch {
        code = text.split('\n\n').find((b) => b.startsWith('event: error'))?.slice(0, 120)
      }
    }
    const s = { ttfb, ttft, total: performance.now() - t0, ok: Boolean(done), status: r.status, code }
    samples.push(s)
    return s
  }
}

// ---- wallets: one faucet wallet funds the rest ----
const funder = privateKeyToAccount(generatePrivateKey())
const funderClient = createClient({ chain: tempoModerato, account: funder, transport: http(RPC) }).extend(publicActions).extend(walletActions)
await Actions.faucet.fundSync(funderClient as never, { account: funder, timeout: 60_000 })
const users = Array.from({ length: USERS + 1 }, () => new User(privateKeyToAccount(generatePrivateKey())))
for (const u of users) {
  const hash = await funderClient.writeContract({ address: TOKEN, abi: erc20Abi, functionName: 'transfer', args: [u.account.address, 5_000_000n] } as never)
  await pub.waitForTransactionReceipt({ hash })
}
console.log(`funded ${users.length} wallets from ${funder.address}`)
const burstUser = users.pop()!
const cfg = await (async () => {
  await users[0]!.signIn()
  return users[0]!.call('GET', '/sessions/current')
})()
const treasury = cfg.network.recipient as Address
const t0 = await bal(treasury)

// ---- 1. parallel users ----
const started = performance.now()
await Promise.all(
  users.map(async (u, i) => {
    if (i > 0) await u.signIn()
    const chat = await u.call('POST', '/chats', { taskType: 'chat', slider: 'cheapest' })
    for (let r = 1; r <= RUNS; r++) {
      const s = await u.run(chat.chatId, `load test user ${i} run ${r}: say hello`)
      if (!s.ok) console.log(`  user ${i} run ${r}: ${s.status} ${s.code}`)
    }
  }),
)
const secs = (performance.now() - started) / 1000
const ok = samples.filter((s) => s.ok)
check(ok.length === USERS * RUNS, `${ok.length}/${USERS * RUNS} paid runs succeeded (${USERS} users in parallel, ${(ok.length / secs).toFixed(1)} runs/s)`)
console.log(
  `  latency ms — first byte p50 ${pct(ok.map((s) => s.ttfb), 50).toFixed(0)} p95 ${pct(ok.map((s) => s.ttfb), 95).toFixed(0)} · first token p50 ${pct(ok.flatMap((s) => (s.ttft ? [s.ttft] : [])), 50).toFixed(0)} p95 ${pct(ok.flatMap((s) => (s.ttft ? [s.ttft] : [])), 95).toFixed(0)} · done p50 ${pct(ok.map((s) => s.total), 50).toFixed(0)} p95 ${pct(ok.map((s) => s.total), 95).toFixed(0)}`,
)

// ---- 2. burst from one user ----
// The mppx client allows one paid request at a time per session, so a burst is what a user
// with several tabs (or a script) does. Free runs need no session, so they make a clean
// burst: at most 3 may stream at once; the rest must get 429 RATE_LIMITED.
await burstUser.signIn()
const bchat = await burstUser.call('POST', '/chats', { taskType: 'chat', slider: 'cheapest' })
await burstUser.run(bchat.chatId, 'open the session first') // so the books check below covers this user too
const quotes = await Promise.all(
  Array.from({ length: BURST }, (_, i) => burstUser.call('POST', `/chats/${bchat.chatId}/quote`, { prompt: `burst ${i}: one word please`, modelId: 'free:llama-3.1-8b' })),
)
const burst = await Promise.all(
  quotes.map(async (q, i) => {
    const r = await burstUser.fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q.quoteId, prompt: `burst ${i}: one word please` }) })
    const text = await r.text()
    const done = text.includes('event: done')
    let code: string | undefined
    if (!done) {
      try {
        code = JSON.parse(text).code
      } catch {
        code = text.split('\n\n').find((b) => b.startsWith('event: error'))?.slice(0, 120) ?? text.slice(0, 80)
      }
    }
    return { status: r.status, ok: done, code }
  }),
)
const limited = burst.filter((b) => b.code === 'RATE_LIMITED').length
const other = burst.filter((b) => !b.ok && b.code !== 'RATE_LIMITED')
console.log(`  burst of ${BURST} at once: ${burst.filter((b) => b.ok).length} answered, ${limited} rate-limited, ${other.length} other ${other.map((o) => `${o.status}:${o.code}`).join(' ')}`)
check(burst.filter((b) => b.ok).length <= 3 && burst.filter((b) => b.ok).length >= 1 && other.length === 0, 'burst: at most 3 answers stream at once, the rest get RATE_LIMITED')

// ---- 3. books per user ----
let mismatches = 0
for (const u of [...users, burstUser]) {
  const s = (await u.call('GET', '/sessions/current')).session
  if (!s || BigInt(Math.round(s.spentUsd * 1e6)) !== u.charged) {
    mismatches++
    console.log(`  ${u.account.address}: server spent ${s?.spentUsd} vs charged ${Number(u.charged) / 1e6}`)
  }
}
check(mismatches === 0, `books balance for all ${users.length + 1} users (server spent = sum of charged answers)`)

// ---- 4. close everything; treasury gains exactly the total ----
const total = [...users, burstUser].reduce((a, u) => a + u.charged, 0n)
const closes = await Promise.allSettled([...users, burstUser].map((u) => u.manager.close()))
check(closes.every((c) => c.status === 'fulfilled'), `all ${closes.length} sessions closed`)
await new Promise((r) => setTimeout(r, 3_000))
const t1 = await bal(treasury)
check(t1 - t0 >= total, `treasury +$${Number(t1 - t0) / 1e6} ≥ charged $${Number(total) / 1e6} (≥ because other sessions may settle concurrently)`)

console.log(failures ? `\nLOAD TEST FAILED (${failures})` : '\nLOAD TEST OK')
process.exit(failures ? 1 : 0)
