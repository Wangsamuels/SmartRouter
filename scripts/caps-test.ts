/**
 * Spending caps + spending key end to end on Tempo testnet:
 *
 *   API_URL=https://smartrouter-testnet-….herokuapp.com pnpm caps:test
 *
 * sign in → authorize a spending key (Tempo access key, on-chain daily limit) with the fee paid
 * through /relay → register it → paid answers signed by the key with automatic deposits sized by
 * the caps → daily cap blocks the next answer (402 daily_limit) → on-chain limit refuses a
 * deposit beyond it → "return locked money" sends the unspent rest back. Exits non-zero on failure.
 */
import { sessionManager } from 'mppx/client'
import { createClient, createPublicClient, erc20Abi, http, type Hex } from 'viem'
import { generatePrivateKey } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Account, Actions, WebCryptoP256, withRelay } from 'viem/tempo'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const RPC = process.env.TEMPO_RPC_URL ?? 'https://rpc.moderato.tempo.xyz'
const TOKEN = '0x20c0000000000000000000000000000000000000' as const
let session = ''
const ok = (name: string, data?: unknown) => console.log(`✔ ${name}${data === undefined ? '' : ' ' + JSON.stringify(data)}`)
const fail = (msg: string): never => {
  console.error(`✘ ${msg}`)
  process.exit(1)
}
async function call(method: string, path: string, body?: unknown, allow: number[] = []) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(session ? { 'x-session-token': session } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return { status: res.status, ...json }
}

// root = the user's wallet (Privy in the app); the key lives in the browser
const root = Account.fromSecp256k1((process.env.PAYER_KEY as Hex) ?? generatePrivateKey())
const pub = createPublicClient({ chain: tempoModerato, transport: http(RPC) })
const bal = () => pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [root.address] })
await Actions.faucet.fundSync(createClient({ chain: tempoModerato, account: root, transport: http(RPC) }) as never, { account: root, timeout: 60_000 })
const { message } = await call('POST', '/auth/challenge', { address: root.address, origin: ORIGIN })
session = (await call('POST', '/auth/verify', { message, signature: await root.signMessage({ message }) })).token
await call('PATCH', '/me/settings', { dailyLimitUsd: 0.5, weeklyLimitUsd: 2 })

const w0 = await call('GET', '/wallet')
if (w0.spendingKey.status !== 'missing') fail(`expected no spending key, got ${w0.spendingKey.status}`)
const setup = w0.spendingKey.setup
ok('caps + key setup', { daily: w0.caps.daily.limitUsd, weekly: w0.caps.weekly.limitUsd, next: w0.caps.nextDepositUsd, setup })

// ---- authorize the spending key, fee paid by the operator through /relay ----
// Non-extractable WebCrypto P256 key, as the browser should create it.
const key = Account.fromWebCryptoP256(await WebCryptoP256.createKeyPair({ extractable: false }), { access: root })
const rootRelay = createClient({
  chain: tempoModerato,
  account: root,
  transport: withRelay(http(RPC), http(API + '/relay', { fetchOptions: { headers: { 'x-session-token': session, origin: ORIGIN } } }), { policy: 'sign-only' }),
})
const b0 = await bal()
await Actions.accessKey.authorizeSync(rootRelay as never, {
  accessKey: key,
  expiry: Math.floor(Date.now() / 1000) + setup.expiryDays * 86_400,
  limits: [{ token: setup.token, limit: BigInt(Math.round(setup.limitUsd * 1e6)), period: setup.periodSeconds }],
  scopes: setup.scopes,
  feePayer: true,
} as never)
if ((await bal()) !== b0) fail('authorizing the key should cost the user nothing')
const reg = await call('POST', '/wallet/spending-key', { accessKeyAddress: key.accessKeyAddress })
if (reg.status !== 'active' && reg.status !== 200) fail(`key not active: ${JSON.stringify(reg)}`)
const w1 = await call('GET', '/wallet')
if (w1.spendingKey.status !== 'active') fail(`spending key ${w1.spendingKey.status}`)
ok('spending key authorized (fee paid by SmartRouter) and registered', w1.spendingKey.onChain)

// ---- paid answers signed by the key, automatic deposit sized by the caps ----
const keyClient = createClient({ chain: tempoModerato, account: key, transport: http(RPC) })
const fetchAuthed: typeof fetch = (u, i) => fetch(u, { ...i, headers: { ...Object.fromEntries(new Headers(i?.headers)), origin: ORIGIN, 'x-session-token': session } })
async function answer(manager: ReturnType<typeof sessionManager>) {
  const chat = await call('POST', '/chats', { taskType: 'chat', slider: 'cheapest' })
  const q = await call('POST', `/chats/${chat.chatId}/quote`, { prompt: 'Say hi.' })
  const res = await manager.fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q.quoteId, prompt: 'Say hi.' }) })
  return { status: res.status, text: await res.text() }
}
const next = (await call('GET', '/sessions/current')).suggestedDepositUsd
if (next !== 0.5) fail(`automatic deposit should be capped at today's $0.50, got ${next}`)
const manager = sessionManager({ account: key as never, client: keyClient as never, maxDeposit: String(next), fetch: fetchAuthed })
const a1 = await answer(manager)
if (!a1.text.includes('event: done')) fail(`paid answer failed: ${a1.text.slice(0, 200)}`)
const w2 = await call('GET', '/wallet')
if (w2.locked?.depositUsd !== 0.5) fail(`expected $0.50 locked, got ${JSON.stringify(w2.locked)}`)
ok('paid answer signed by the spending key; $0.50 locked automatically', { locked: w2.locked, daily: w2.caps.daily })

// ---- daily cap: drop it below what's spent, the next answer is refused ----
await call('PATCH', '/me/settings', { dailyLimitUsd: 0.001 })
const a2 = await answer(manager).catch((e) => ({ status: 0, text: String(e) }))
if (!/daily_limit/.test(a2.text)) fail(`expected daily_limit refusal, got ${a2.status} ${a2.text.slice(0, 200)}`)
ok('daily cap refuses the next paid answer')
await call('PATCH', '/me/settings', { dailyLimitUsd: 0.5 })

// ---- on-chain limit: a deposit beyond the key's daily limit is refused by Tempo ----
const b1 = await bal()
const big = sessionManager({ account: key as never, client: keyClient as never, maxDeposit: '1.5', fetch: fetchAuthed })
const a3 = await answer(big).catch((e) => ({ status: 0, text: String(e) }))
if (a3.text.includes('event: done')) fail('a $1.50 deposit beyond the on-chain daily limit went through')
if ((await bal()) !== b1) fail('money moved despite the on-chain limit')
ok('on-chain limit refused a deposit beyond it', { error: a3.text.match(/SpendingLimitExceeded|[A-Za-z ]+limit[A-Za-z ]*/)?.[0] })

// ---- return locked money now ----
const before = await bal()
const ret = await call('POST', '/wallet/locked/return')
const after = await bal()
if (!(after > before) || Math.abs(Number(after - before) / 1e6 - ret.returnedUsd) > 1e-6) fail(`return mismatch: ${JSON.stringify(ret)} balance +${Number(after - before) / 1e6}`)
const w3 = await call('GET', '/wallet')
if (w3.locked) fail('still locked after return')
ok('locked money returned to the main wallet', { returnedUsd: ret.returnedUsd })
console.log('\nCAPS TEST OK')
