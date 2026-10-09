/** Static per-network constants. Anything secret or deployment-specific lives in env vars. */
export const NETWORKS = {
  moderato: {
    name: 'Tempo Testnet (Moderato)',
    chainId: 42431,
    rpcUrl: 'https://rpc.moderato.tempo.xyz',
    /** Public backups, tried in order when the primary is rate-limited or down. */
    fallbackRpcUrls: ['https://tempo-moderato-testnet.drpc.org'],
    explorer: 'https://explore.testnet.tempo.xyz',
    feePayerUrl: 'https://sponsor.moderato.tempo.xyz',
    tokens: {
      // Testnet has no USDC.e; pathUSD stands in as the payment token.
      payment: '0x20c0000000000000000000000000000000000000',
      pathUSD: '0x20c0000000000000000000000000000000000000',
    },
  },
  tempo: {
    name: 'Tempo Mainnet',
    chainId: 4217,
    rpcUrl: 'https://rpc.tempo.xyz',
    fallbackRpcUrls: ['https://tempo.drpc.org', 'https://tempo-rpc.publicnode.com'],
    explorer: 'https://explore.tempo.xyz',
    feePayerUrl: undefined as string | undefined,
    tokens: {
      // USDC.e — the token every MPP provider accepts.
      payment: '0x20c000000000000000000000b9537d11c60e8b50',
      USDCe: '0x20c000000000000000000000b9537d11c60e8b50',
      pathUSD: '0x20c0000000000000000000000000000000000000',
    },
  },
} as const

export type NetworkName = keyof typeof NETWORKS

/** USDC.e and pathUSD both use 6 decimals; all money is stored as integer micro-USD. */
export const TOKEN_DECIMALS = 6
export const MICRO = 1_000_000
