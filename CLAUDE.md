# TamTam Games — working agreement

TamTam Games (طمطم) is an Arabic-first gaming store for Iraq: storefront, guest checkout, used devices and trade-in, device knowledge hubs, maintenance assistant, and a 23-module admin system. Live at tamtamgames.com (Cloudflare Workers).

**Read before writing code**

1. `docs/ARCHITECTURE.md` — the contract: stack, folder ownership, conventions with examples, data model, business invariants. It wins over habit.
2. `docs/DESIGN.md` — the design system: tokens, the two materials (clay, glass), motion grammar, component rules.
3. `docs/STATUS.md` — what is implemented, mocked or blocked. Keep it truthful when you finish work.
4. React Router **v8** is installed (not v7). APIs changed: read `.agents/skills/react-router/references/framework-mode.md` and the version-matched docs in `node_modules/react-router/docs/` instead of relying on memory. View transitions use React's `<ViewTransition>` (React 19.3).

**Hard rules**

- Never run `npm install`, never start/stop a dev server, never run `drizzle-kit`/migrations unless your task says you own them. One dev server is already running at http://localhost:5173 — verify against it with `curl` and `node scripts/shot.mjs`.
- Edit only the files your task owns. Shared files (`app/routes.ts`, `app/root.tsx`, `package.json`, `wrangler.jsonc`, `app/server/db/schema/*`, `app/ui/*`, `app/motion/*`, `app/styles/*`) have one owner each — if you need a change there, report it in your final answer instead of making it.
- Write files with the Write/Edit tools. Shell heredocs mangle backslashes on this Windows machine.
- Money is integer IQD. Every stored fact that is not real is marked `is_demo`. No invented reviews, ratings, customer counts, delivery promises or integrations. If something needs credentials that are not configured, build the boundary and say so — never fake a success.
- Server-only code lives in `*.server.ts` files / `app/server/`. Authorization is enforced in services, never by hiding UI.
- Arabic is the source language. Every user-facing string exists in `ar`, `en` and `ckb` (Kurdish Sorani).
- Finish by running `npm run typecheck` and the tests for your area; report failures you could not fix, with the output.
