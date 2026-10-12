/**
 * Wallet end to end on Tempo testnet, with a throwaway faucet-funded user:
 *
 *   API_URL=https://smartrouter-testnet-….herokuapp.com pnpm wallet:test
 *
 * sign in → GET /wallet → email code (echoed on testnet) → send $0.05 on Tempo with the operator paying the fee (/relay) →
 * user loses exactly $0.05 → a call the relay must refuse is not sponsored → paid run opens the
 * AI balance → close it → activity shows send, AI balance in/out (and the faucet deposit once the
 * worker's tracker has run). Exits non-zero on the first failure.
 */
import { sessionManager } from 'mppx/client'
import { createClient, createPublicClient, encodeFunctionData, erc20Abi, http, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { sendTransactionSync } from 'viem/actions'
import { tempoModerato } from 'viem/chains'
import { Actions, withRelay } from 'viem/tempo'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const RPC = process.env.TEMPO_RPC_URL ?? 'https://rpc.moderato.tempo.xyz'
const TOKEN = '0x20c0000000000000000000000000000000000000' as const
let session = ''

const ok = (name: string, data?: unknown) => console.log(`✔ ${name}${data === undefined ? '' : ' ' + JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
const fail = (msg: string): never => {
  console.error(`✘ ${msg}`)
  process.exit(1)
}
async function call(method: string, path: string, body?: unknown, allow: number[] = []) {
  const res = await fetch(API + path, { method, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(session ? { 'x-session-token': session } : {}) }, body: body ? JSON.stringify(body) : undefined })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok && !allow.includes(res.status)) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return allow.length ? { status: res.status, ...json } : json
}

const user = privateKeyToAccount((process.env.PAYER_KEY as Hex) ?? generatePrivateKey())
const pub = createPublicClient({ chain: tempoModerato, transport: http(RPC) })
const bal = (a: `0x${string}`) => pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [a] })
await Actions.faucet.fundSync(createClient({ chain: tempoModerato, account: user, transport: http(RPC) }), { account: user, timeout: 60_000 })
ok(`user ${user.address} funded`)

const { message } = await call('POST', '/auth/challenge', { address: user.address, origin: ORIGIN })
session = (await call('POST', '/auth/verify', { message, signature: await user.signMessage({ message }) })).token
const w0 = await call('GET', '/wallet')
if (w0.address.toLowerCase() !== user.address.toLowerCase()) fail('wallet address mismatch')
ok('GET /wallet', { main: w0.main, ai: w0.ai, fees: w0.networkFees, features: w0.features })
const opts = await call('GET', '/wallet/options')
ok('GET /wallet/options', { deposit: opts.deposit.map((o: any) => `${o.chain}:${o.token}`), send: opts.send.map((o: any) => `${o.chain}:${o.token}`) })
const dep = await call('POST', '/wallet/deposit-address', { chain: 'tempo' })
if (dep.address.toLowerCase() !== user.address.toLowerCase()) fail('tempo deposit address should be the wallet itself')
ok('Tempo deposit address = main wallet')

// ---- send on Tempo, fee paid by the operator through /relay ----
const relayClient = createClient({
  chain: tempoModerato,
  account: user,
  transport: withRelay(http(RPC), http(API + '/relay', { fetchOptions: { headers: { 'x-session-token': session, origin: ORIGIN } } }), { policy: 'sign-only' }),
})
const to = privateKeyToAccount(generatePrivateKey()).address
const q = await call('POST', '/wallet/send/quote', { chain: 'tempo', to, amountUsd: 0.05 })
ok('send quote', q)
// Without the email code there's nothing to sign; the code is bound to amount + recipient.
const noCode = await call('POST', '/wallet/send', { chain: 'tempo', to, amountUsd: 0.05 }, [400])
if (noCode.status !== 400) fail('a send without a code should be refused')
const vc = await call('POST', '/wallet/send/code', { chain: 'tempo', to, amountUsd: 0.05 })
if (!vc.devCode) fail('testnet API needs SEND_CODE_ECHO=true for this test')
const wrongCode = String((Number(vc.devCode) + 1) % 1_000_000).padStart(6, '0')
const bad = await call('POST', '/wallet/send', { chain: 'tempo', to, amountUsd: 0.05, verificationId: vc.verificationId, code: wrongCode }, [400])
if (bad.code !== 'SEND_CODE_INVALID' || bad.details?.attemptsLeft !== 4) fail(`wrong code: ${JSON.stringify(bad)}`)
const other = await call('POST', '/wallet/send', { chain: 'tempo', to, amountUsd: 0.06, verificationId: vc.verificationId, code: vc.devCode }, [410])
if (other.code !== 'SEND_CODE_EXPIRED') fail(`a code for $0.05 must not confirm $0.06: ${JSON.stringify(other)}`)
const vc2 = await call('POST', '/wallet/send/code', { chain: 'tempo', to, amountUsd: 0.05 }, [429])
if (vc2.status !== 429) fail('a second code within 30 s should be rate limited')
await new Promise((r) => setTimeout(r, 31_000))
const vc3 = await call('POST', '/wallet/send/code', { chain: 'tempo', to, amountUsd: 0.05 })
const stale = await call('POST', '/wallet/send', { chain: 'tempo', to, amountUsd: 0.05, verificationId: vc.verificationId, code: vc.devCode }, [410])
if (stale.code !== 'SEND_CODE_EXPIRED') fail('an older code should stop working once a new one is sent')
ok('send code: required, wrong code counted, bound to amount, rate limited, only the newest works')
const send = await call('POST', '/wallet/send', { chain: 'tempo', to, amountUsd: 0.05, verificationId: vc3.verificationId, code: vc3.devCode })
const reuse = await call('POST', '/wallet/send', { chain: 'tempo', to, amountUsd: 0.05, verificationId: vc3.verificationId, code: vc3.devCode }, [410])
if (reuse.code !== 'SEND_CODE_EXPIRED') fail('a used code must not work twice')
const operator = (await call('GET', '/sessions/current')).network.operator as `0x${string}`
const [u0, o0] = [await bal(user.address), await bal(operator)]
const rcpt = await sendTransactionSync(relayClient as never, { calls: send.calls, feePayer: true } as never)
const [u1, o1] = [await bal(user.address), await bal(operator)]
if ((rcpt as any).status !== 'success') fail('send reverted')
if (u0 - u1 !== 50_000n) fail(`user should lose exactly $0.05, lost ${Number(u0 - u1) / 1e6}`)
if (!(o0 > o1)) fail('operator should have paid the fee')
ok('send $0.05: user paid exactly $0.05, operator paid the fee', { feeUsd: Number(o0 - o1) / 1e6, recipient: Number(await bal(to)) / 1e6 })
const sub = await call('POST', `/wallet/send/${send.sendId}/submitted`, { txHash: (rcpt as any).transactionHash })
if (sub.status !== 'completed') fail(`send status ${sub.status}`)
ok('send recorded as completed')

// ---- the relay refuses calls it shouldn't pay for (falls back to the user paying) ----
const [u2, o2] = [await bal(user.address), await bal(operator)]
const rogue = privateKeyToAccount(generatePrivateKey()).address
await sendTransactionSync(relayClient as never, { calls: [{ to: rogue, data: '0x' }], feePayer: true } as never).catch(() => undefined)
// A plain transfer that skipped the email code isn't sponsored either.
const unconfirmed = { to: TOKEN, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [rogue, 10_000n] }) }
const sponsoredUnconfirmed = await sendTransactionSync(relayClient as never, { calls: [unconfirmed], feePayer: true } as never).then(() => true, () => false)
const [u3, o3] = [await bal(user.address), await bal(operator)]
if (o3 !== o2) fail('operator paid for a call outside the allowlist / an unconfirmed transfer')
ok('unconfirmed transfer and calls outside the allowlist not sponsored', { userPaidFee: Number(u2 - u3) / 1e6, unconfirmedWentThrough: sponsoredUnconfirmed })

// ---- AI balance: open with a paid run, then close ----
const manager = sessionManager({ account: user, client: createClient({ chain: tempoModerato, account: user, transport: http(RPC) }) as never, maxDeposit: '0.5', fetch: (url, init) => fetch(url, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), origin: ORIGIN, 'x-session-token': session } }) })
const chat = await call('POST', '/chats', { taskType: 'chat', slider: 'cheapest' })
const quote = await call('POST', `/chats/${chat.chatId}/quote`, { prompt: 'Say hi in five words.' })
const run = await manager.fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: quote.quoteId, prompt: 'Say hi in five words.' }) })
const text = await run.text()
if (!text.includes('event: done')) fail(`paid run failed: ${text.slice(0, 300)}`)
const w1 = await call('GET', '/wallet')
if (!w1.ai || w1.ai.depositUsd !== 0.5) fail(`AI balance should be $0.50, got ${JSON.stringify(w1.ai)}`)
ok('main → AI balance (deposit $0.50) and a paid answer', { ai: w1.ai, main: w1.main })
await manager.close()
await new Promise((r) => setTimeout(r, 3000))
const w2 = await call('GET', '/wallet')
if (w2.ai) fail('AI balance should be closed')
ok('AI balance → main (closed)', { main: w2.main })

const act = await call('GET', '/wallet/activity')
const types = act.items.map((i: any) => `${i.type}:${i.status}:${i.amountUsd}`)
for (const want of ['send:completed:0.05', 'to_ai_balance:completed:0.5']) if (!types.includes(want)) fail(`activity missing ${want}: ${types.join(', ')}`)
if (!types.some((t: string) => t.startsWith('from_ai_balance:completed'))) fail(`activity missing from_ai_balance: ${types.join(', ')}`)
ok('activity', types)
console.log('\nWALLET TEST OK')
