/**
 * Paid /run end to end on Tempo Moderato (testnet) with a throwaway, faucet-funded wallet:
 *
 *   API_URL=https://smartrouter-testnet-….herokuapp.com pnpm testnet:session
 *
 * sign in → new chat → quote → POST /run without payment (402) → mppx opens a session
 * (escrow deposit) and pays → SSE answer → second turn reuses the channel (voucher only) →
 * double-submit is rejected without a second charge → free model run → top-up → close.
 * Prints each step; exits non-zero on the first failure.
 */
import { sessionManager } from 'mppx/client'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, '')
const ORIGIN = process.env.APP_ORIGIN ?? 'http://localhost:5173'
const RPC = process.env.TEMPO_RPC_URL ?? 'https://rpc.moderato.tempo.xyz'
let cookie = ''

const withAuth: typeof fetch = async (input, init) => {
  const headers = new Headers(init?.headers)
  headers.set('origin', ORIGIN)
  if (cookie) headers.set('cookie', cookie)
  const res = await fetch(input, { ...init, headers })
  const set = res.headers.get('set-cookie')
  if (set) cookie = set.split(';')[0]!
  return res
}

async function call(method: string, path: string, body?: unknown) {
  const res = await withAuth(API + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const json: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json
}
const step = (name: string, data?: unknown) => console.log(`\n✔ ${name}${data === undefined ? '' : '\n' + JSON.stringify(data, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2).slice(0, 1500)}`)
const fail = (msg: string) => {
  console.error(`\n✘ ${msg}`)
  process.exit(1)
}

/** Reads an SSE body into events. */
async function readSse(res: Response) {
  const events: { event: string; data: any }[] = []
  const text = await res.text()
  for (const block of text.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block)?.[1]
    const data = /^data: (.+)$/m.exec(block)?.[1]
    if (ev && data) events.push({ event: ev, data: JSON.parse(data) })
  }
  const deltas = events.filter((e) => e.event === 'delta').map((e) => e.data.text).join('')
  return { events, deltas, done: events.find((e) => e.event === 'done')?.data, error: events.find((e) => e.event === 'error')?.data, meta: events.find((e) => e.event === 'meta')?.data }
}

// ---- wallet ----
const account = privateKeyToAccount((process.env.PAYER_KEY as `0x${string}`) ?? generatePrivateKey())
const client = createClient({ chain: tempoModerato, account, transport: http(RPC) })
await Actions.faucet.fundSync(client, { account, timeout: 60_000 })
step(`payer ${account.address} funded from the faucet`)

// ---- sign in ----
const { message } = await call('POST', '/auth/challenge', { address: account.address, origin: ORIGIN })
await call('POST', '/auth/verify', { message, signature: await account.signMessage({ message }) })
const sess0 = await call('GET', '/sessions/current')
step('signed in; payment config', sess0)
if (!sess0.paidRunsEnabled) fail('server has paid runs disabled (MPP_SECRET_KEY / operator / treasury missing)')

// ---- chat + quote ----
const prompt1 = 'Write a two-sentence welcome message for new SmartRouter users.'
const chat = await call('POST', '/chats', { description: prompt1, slider: 'cheapest' })
const opt = chat.options.find((o: any) => !o.free)
if (!opt?.quoteId) fail('no paid option with a quote')
step('chat created; picked', { chatId: chat.chatId, modelId: opt.modelId, priceUsd: opt.priceUsd })

// ---- unpaid request → 402 with challenge ----
const unpaid = await withAuth(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: opt.quoteId, prompt: prompt1 }) })
const unpaidBody: any = await unpaid.json()
if (unpaid.status !== 402 || !unpaid.headers.get('www-authenticate')) fail(`expected 402 + challenge, got ${unpaid.status}`)
step('unpaid /run → 402', { code: unpaidBody.code, challenge: unpaid.headers.get('www-authenticate')?.slice(0, 120) + '…' })

// ---- paid run (opens the channel) ----
const manager = sessionManager({ account, client, maxDeposit: '1', fetch: withAuth })
const t0 = Date.now()
const paid = await manager.fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: opt.quoteId, prompt: prompt1 }) })
if (paid.status !== 200) fail(`paid run → ${paid.status} ${await paid.text()}`)
const r1 = await readSse(paid)
if (!r1.done) fail(`run 1 did not finish: ${JSON.stringify(r1.error ?? r1.events.slice(-2))}`)
step(`paid run 1 (channel open + answer) in ${Date.now() - t0} ms`, { channelId: paid.channelId, receipt: paid.receipt, answer: r1.deltas.slice(0, 160), done: r1.done })

// ---- second turn on the same channel ----
const q2 = await call('POST', `/chats/${chat.chatId}/quote`, { prompt: 'Now make it one sentence.' })
const t1 = Date.now()
const paid2 = await manager.fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q2.quoteId, prompt: 'Now make it one sentence.' }) })
const r2 = await readSse(paid2)
if (!r2.done) fail(`run 2 did not finish: ${JSON.stringify(r2.error ?? r2.events.slice(-2))}`)
step(`paid run 2 (voucher only) in ${Date.now() - t1} ms`, { sameChannel: paid2.channelId === paid.channelId, cumulative: manager.cumulative, answer: r2.deltas.slice(0, 160) })

// ---- replaying a used quote is refused and not charged ----
const before = (await call('GET', '/sessions/current')).session
const replay = await manager.fetch(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: q2.quoteId, prompt: 'Now make it one sentence.' }) })
const replayBody: any = await replay.json().catch(() => ({}))
const after = (await call('GET', '/sessions/current')).session
if (replay.status !== 409) fail(`replayed quote → ${replay.status} ${JSON.stringify(replayBody)}`)
if (after.spentUsd !== before.spentUsd) fail(`replay changed spent ${before.spentUsd} → ${after.spentUsd}`)
step('replayed quote → 409, spent unchanged', { code: replayBody.code, spentUsd: after.spentUsd })

// ---- free model run (no payment) ----
const qf = await call('POST', `/chats/${chat.chatId}/quote`, { prompt: 'Say thanks in Yoruba.', modelId: 'free:llama-3.1-8b' })
const fr = await withAuth(API + '/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ quoteId: qf.quoteId, prompt: 'Say thanks in Yoruba.' }) })
const rf = await readSse(fr)
step('free run', { status: fr.status, answer: rf.deltas.slice(0, 120), done: Boolean(rf.done), error: rf.error })

// ---- chat history holds every turn, with the model that wrote it ----
const read = await call('GET', `/chats/${chat.chatId}`)
step('chat history', read.messages.map((m: any) => ({ seq: m.seq, role: m.role, modelId: m.modelId, status: m.status, content: m.content.slice(0, 50) })))

// ---- top-up, then close ----
const top = await manager.topUp('0.5')
const s2 = (await call('GET', '/sessions/current')).session
step('top-up 0.5', { receipt: top, depositUsd: s2?.depositUsd, remainingUsd: s2?.remainingUsd })
const closed = await manager.close()
step('channel closed', closed)
const s3 = await call('GET', '/sessions/current')
step('session after close', s3.session)
console.log('\nTESTNET SESSION OK')
process.exit(0)
