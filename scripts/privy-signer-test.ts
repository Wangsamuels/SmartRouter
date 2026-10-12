/**
 * Simulates the Privy embedded wallet: the only thing it can do is sign a raw hash
 * (provider.request({ method: 'secp256k1_sign', params: [hash] })). We build a Tempo root
 * account from that, then authorize a spending key through /relay with SmartRouter paying.
 */
import { createClient, createPublicClient, erc20Abi, http, recoverPublicKey, keccak256, toHex, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Account, Actions, WebCryptoP256, withRelay } from 'viem/tempo'

const API = (process.env.API_URL ?? 'http://localhost:3000').replace(/\/+$/, ''),
  ORIGIN = 'http://localhost:5173',
  RPC = 'https://rpc.moderato.tempo.xyz'
const TOKEN = '0x20c0000000000000000000000000000000000000'
const secret = privateKeyToAccount(generatePrivateKey())
// ---- the Privy stand-in: raw hash signing only ----
const privyProvider = {
  request: async ({ method, params }: { method: string; params: [Hex] }) => {
    if (method !== 'secp256k1_sign') throw new Error('unsupported')
    return secret.sign({ hash: params[0] })
  },
}

// ---- what the frontend should do ----
async function tempoAccountFromPrivy(provider: typeof privyProvider) {
  const sign = ({ hash }: { hash: Hex }) => provider.request({ method: 'secp256k1_sign', params: [hash] })
  const probe = keccak256(toHex('smartrouter:public-key'))
  const pk = await recoverPublicKey({ hash: probe, signature: await sign({ hash: probe }) }) // 0x04 ‖ x ‖ y
  const publicKey = { prefix: 4, x: BigInt('0x' + pk.slice(4, 68)), y: BigInt('0x' + pk.slice(68, 132)) } as const
  return Account.from({ publicKey, sign } as never) as ReturnType<typeof Account.fromSecp256k1>
}
const root = await tempoAccountFromPrivy(privyProvider)
if (root.address.toLowerCase() !== secret.address.toLowerCase()) throw new Error('address mismatch')

let session = ''
const call = async (m: string, p: string, b?: unknown) =>
  (
    await fetch(API + p, { method: m, headers: { 'content-type': 'application/json', origin: ORIGIN, ...(session ? { 'x-session-token': session } : {}) }, body: b ? JSON.stringify(b) : undefined })
  ).json() as Promise<any>
const { message } = await call('POST', '/auth/challenge', { address: root.address, origin: ORIGIN })
session = (await call('POST', '/auth/verify', { message, signature: await secret.signMessage({ message }) })).token
const w = await call('GET', '/wallet')
const pub = createPublicClient({ chain: tempoModerato, transport: http(RPC) })
const bal = () => pub.readContract({ address: TOKEN, abi: erc20Abi, functionName: 'balanceOf', args: [root.address] })
console.log('user balance before:', Number(await bal()) / 1e6, '(empty wallet: only works if SmartRouter pays)')
const rootRelay = createClient({
  chain: tempoModerato,
  account: root,
  transport: withRelay(http(RPC), http(API + '/relay', { fetchOptions: { headers: { 'x-session-token': session, origin: ORIGIN } } }), { policy: 'sign-only' }),
})
const key = Account.fromWebCryptoP256(await WebCryptoP256.createKeyPair({ extractable: false }), { access: root })
const s = w.spendingKey.setup
const r = await Actions.accessKey.authorizeSync(
  rootRelay as never,
  {
    accessKey: key,
    expiry: Math.floor(Date.now() / 1000) + s.expiryDays * 86400,
    limits: [{ token: s.token, limit: BigInt(Math.round(s.limitUsd * 1e6)), period: s.periodSeconds }],
    scopes: s.scopes,
    calls: [{ to: '0x0000000000000000000000000000000000000000', data: '0x' }],
    feePayer: true,
  } as never,
)
console.log('authorized:', (r as any).receipt?.status ?? 'ok', '| registered:', (await call('POST', '/wallet/spending-key', { accessKeyAddress: key.accessKeyAddress })).status ?? 'ok')
console.log('PRIVY-STYLE SIGNER OK')
