# TamTam Games — طمطم

Arabic-first gaming store for Iraq: storefront with guest checkout, used devices and trade-in, device knowledge hubs, a maintenance assistant and a 23-module admin system.

- **Live:** https://tamtamgames.com (preview host: https://tamtam-games.tamtam-zelda.workers.dev)
- **Stack:** React Router 8 (SSR) · React 19.3 · Cloudflare Workers · D1 (SQLite) + Drizzle · KV · Tailwind 4 + design tokens · TamTam Motion Engine
- **Languages:** Arabic (default, RTL), English (`/en`), Kurdish Sorani (`/ckb`)

## Where things are written down

| File | What it is |
|---|---|
| `docs/ARCHITECTURE.md` | The contract: stack, folders, conventions, data model, business invariants |
| `docs/DESIGN.md` | Design system: tokens, clay and glass materials, components |
| `docs/MOTION.md` | Motion grammar and the motion engine API |
| `docs/SECURITY.md` | Application security model and the Cloudflare edge configuration |
| `docs/STATUS.md` | Truthful implementation status: implemented / partial / mocked / blocked |
| `docs/admin-blueprint.json` | The 23 admin modules and 176 functions from the admin guide |

## Run it locally

```bash
npm install
npm run db:reset     # creates the local database, loads reference + DEMO data
npm run dev          # http://localhost:5173 — real Workers runtime, local D1 and KV
```

`.dev.vars` holds local secrets (see `.dev.vars.example`). Nothing local needs a Cloudflare account.

## Check it

```bash
npm run typecheck
npm test
node scripts/shot.mjs http://localhost:5173/ .shots/home.png 390 844
```

## Deploy

```bash
npm run db:migrate:remote   # apply new migrations to the production D1
npm run deploy              # build + wrangler deploy (tamtamgames.com, www, workers.dev)
```

Production secrets (`SESSION_SECRET`, `DATA_KEY`, `SETUP_TOKEN`) are set with `wrangler secret put`. The first owner account is created at `/admin/setup` using `SETUP_TOKEN`.

## Demo mode

While `STORE_MODE` is `demo` (see `wrangler.jsonc`) the catalogue, prices, stock and exchange rate are placeholders, every seeded row is flagged `is_demo`, the storefront shows a demo ribbon and search engines are told not to index it. Switch to `live` once real catalogue data is in.
