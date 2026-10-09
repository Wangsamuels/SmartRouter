# SmartRouter backend

AI model marketplace on Tempo: describe a task, get the best model for your budget, pay per use over MPP.
This repo is the backend (Hono API + worker). See the Backend Architecture doc for the full design.

## Layout

```
apps/api          Hono HTTP API (auth, catalog, chats, quotes, paid /run over MPP sessions)
apps/worker       pg-boss scheduled jobs (settlement, close-out, health, catalog)
packages/config   env loading + per-network chain/token constants
packages/db       Drizzle schema, migrations, migrator
packages/shared   zod schemas/types shared with the frontend
packages/core     domain logic (providers, payments, recommend, treasury)
```

## Local dev

```bash
pnpm install
cp .env.example .env          # set DATABASE_URL, REDIS_URL, SESSION_SECRET
pnpm db:migrate
pnpm dev:api                  # http://localhost:3000/health
pnpm dev:worker
```

Useful scripts:

```bash
pnpm catalog:build [--dry-run]   # rebuild the model catalog from LMArena + live 402 prices (spends nothing)
pnpm smoke:providers             # read every provider's live price (spends nothing)
pnpm smoke:providers --pay --budget=2 --write   # one real paid call per model; marks working ones verified
API_URL=http://localhost:3000 pnpm e2e:api      # sign in with a throwaway wallet and exercise chats/quotes
API_URL=http://localhost:3000 pnpm testnet:session   # paid /run on Moderato: 402 → open session → SSE → voucher → top-up → close
API_URL=… NETWORK=tempo PAYER_KEY_FILE=.test-user-wallet pnpm treasury:check   # proves spend reaches the treasury, rest returns to the user
TEST_DATABASE_URL=postgres://… pnpm test         # also runs the Postgres session-store concurrency tests
pnpm test                        # unit tests
```

On testnet (`TEMPO_NETWORK=moderato`) paid models run on the mock provider (MPP providers are mainnet-only);
set `MOCK_PROVIDERS=false` to get real 402 quotes locally. The free model always runs on Cloudflare.

## Paid runs (MPP sessions)

Users pay per request from an escrowed Tempo session (their allocation). `POST /run { quoteId, prompt }`
answers 402 with an MPP challenge for exactly the quoted price; the mppx client opens the channel (or
signs the next voucher) and retries, and the answer streams back as SSE (`meta`, `delta`, `fallback`,
`done`, `pending`, `error`). A failed model is retried once on the next-best model at no extra cost;
if that fails too the charge is refunded. Body-less POSTs to `/run` carrying a Payment credential are
channel management (open without content, top-up, close).

Needs `TREASURY_ADDRESS` (payee), `OPERATOR_PRIVATE_KEY` (sends settle/close, sponsors open/top-up fees;
falls back to the hot wallet) and `MPP_SECRET_KEY`. Without them only the free model runs.
Channel state lives in Postgres (`session_store`), never Redis.

Getting paid (worker `settle-sessions`, every 2 min): a channel quiet for `SETTLE_IDLE_MINUTES` that owes
≥ `SETTLE_MIN_USD` is settled to the treasury; one unused for `IDLE_CLOSE_HOURS` (or whose user asked the
chain to close) is closed by the operator — the treasury captures exactly what was spent and the user gets
the rest back. Channels with refunded requests are only collected on close (the escrow can only settle a
full voucher). Every settle/close is a `treasury_moves` row; `reconcile` checks them nightly.

Schema change: edit `packages/db/src/schema.ts`, run `pnpm db:generate`, and commit the new file in `packages/db/migrations/`.

## Deploy (Heroku, from GitHub)

Two apps in the `smartrouter` pipeline:

- `smartrouter-testnet` (staging, `TEMPO_NETWORK=moderato`)
- `smartrouter-mainnet` (production, `TEMPO_NETWORK=tempo`)

Heroku builds with `pnpm build`, the `release` phase runs migrations, and the `Procfile` starts `web` and `worker`.
Going to mainnet = promote the tested testnet build in the pipeline.

`infra/heroku-setup.sh` creates/updates the apps, add-ons, config vars and pipeline idempotently.
