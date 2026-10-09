# SmartRouter backend

AI model marketplace on Tempo: describe a task, get the best model for your budget, pay per use over MPP.
This repo is the backend (Hono API + worker). See the Backend Architecture doc for the full design.

## Layout

```
apps/api          Hono HTTP API (+ MPP session endpoint /run, later)
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
pnpm test                        # unit tests
```

On testnet (`TEMPO_NETWORK=moderato`) paid models run on the mock provider (MPP providers are mainnet-only);
set `MOCK_PROVIDERS=false` to get real 402 quotes locally. The free model always runs on Cloudflare.

Schema change: edit `packages/db/src/schema.ts`, run `pnpm db:generate`, and commit the new file in `packages/db/migrations/`.

## Deploy (Heroku, from GitHub)

Two apps in the `smartrouter` pipeline:

- `smartrouter-testnet` (staging, `TEMPO_NETWORK=moderato`)
- `smartrouter-mainnet` (production, `TEMPO_NETWORK=tempo`)

Heroku builds with `pnpm build`, the `release` phase runs migrations, and the `Procfile` starts `web` and `worker`.
Going to mainnet = promote the tested testnet build in the pipeline.

`infra/heroku-setup.sh` creates/updates the apps, add-ons, config vars and pipeline idempotently.
