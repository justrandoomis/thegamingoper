# Status

What is implemented, partial, mocked or blocked — kept truthful. When you finish work, update your rows in the same change, with the command that proves each "implemented".

Last full check of the foundation: **2026-11-11** (integration pass, local only; nothing was run against remote resources).

| State | Meaning |
|---|---|
| implemented | works, and the command in the last column proves it |
| partial | works, with the gap written next to it |
| mocked | stands in for real data on purpose (demo seed) |
| blocked | needs something outside the code: credentials, a provider, or an owner's decision |

## 1. Foundation

| Area | State | What exists, and what does not | Proof |
|---|---|---|---|
| Data layer: schema, migrations, invariants | implemented | 189 tables (187 Drizzle + `_tx_guard` + FTS5 `search_index`), 56 triggers, migrations `0000`–`0002`; batch helpers (`expectChanged`, `runBatch`, `batchSql`, `chunkRows`, `mapDbError`), journal and search helpers. Rules: `drizzle/README.md`, ARCHITECTURE §5.1 | `npm test -- tests/db-invariants.test.ts` (69 pass) |
| Local database tooling | implemented | `db:reset` = drop → migrate → reference → roles → demo → row counts; `db:seed` is idempotent; `db:seed -- --sql <file>` writes a replay-checked SQL file for remote use | `npm run db:reset` (≈5 s, 189 tables, 56 triggers); `npm run db:seed` (second run writes 0); `npm run db:seed -- --sql x.sql` (314 statements, replay identical) |
| Reference data | implemented | 19 governorates, 124 districts, 12 settings, 19 accounts, 4 inspection templates, 1 stock location, 2 channels. Production gets them from `createFirstOwner` (the `/admin/setup` service), not from a script | `npm run db:reset`; `npm test -- tests/server-core.test.ts -t "empty production database"` |
| Remote D1 | partial | Lead applied `0000`–`0002` to `tamtam-db` and checked expression `RAISE`, `RAISE(IGNORE)` and FTS5 `trigram` there (ARCHITECTURE §5.1). Not checked remotely: `changes()` semantics of `expectChanged()` inside `db.batch`, FTS change counts, the seed SQL file, KV-backed `/media` | — (remote, not re-run in this pass) |
| Request pipeline | implemented | `requestContextMiddleware`: locale from URL, prefs cookie, per-request nonce, CSRF origin check on non-GET, security headers, `noindex` while `STORE_MODE=demo`; CSP is sent in production only. One dev hydration warning remains (open item 1) | `curl -X POST -H "Origin: https://evil.example" http://localhost:5173/api/health` → 403; `curl -I http://localhost:5173/` |
| Errors, actors, permissions, roles | implemented | `AppError`/`toAppError` (wraps `TT:<CODE>` trigger errors), `CORE_ERROR_KEYS`; 246 permissions in 24 groups (23 admin modules + field-level); 8 built-in roles, owner = `*`; cost/profit/proof fields only for owner, manager, finance | `npm test -- tests/server-core.test.ts` (104 pass) |
| Audit log | partial | append-only `audit_events`, hash chain, `sealAudit`, `verifyAuditChain`. Nothing calls `sealAudit` on a schedule (no cron) | `npm test -- tests/server-core.test.ts -t "audit trail"` |
| Settings | implemented | typed settings with defaults (§10 + `refunds.approval_threshold_iqd`), owner-only keys, audited changes | `npm test -- tests/server-core.test.ts -t settings` |
| Rate limits | partial | counters in D1 (`rate_limits`); `cleanupRateLimits` exists but nothing runs it daily | `npm test -- tests/server-core.test.ts -t "rate limiting"` |
| Shell loader | implemented | one batched read (USD rate, cart count, customer); works on a migrated database with no rows at all, in production mode, and with stale cookies | `npm test -- tests/server-core.test.ts -t "shell"` |
| i18n | implemented | `ar` (source), `en`, `ckb`; every namespace has the same keys in all three | `npm test -- tests/i18n.test.ts` (9 pass) |
| Staff sign-in | partial | email + password, optional TOTP, 12 h sessions (2 h idle), lockout, first-owner bootstrap `createFirstOwner`. **No `/admin/login` or `/admin/setup` page yet (both 404)**, so no owner can be created from a browser. Two-step verification is not enforced for anyone | `npm test -- tests/server-core.test.ts` (the "admin authentication" tests build on the owner created by the bootstrap tests before them, so run the whole file, not `-t`) |
| Customer accounts | partial | phone + password accounts, 30-day sessions. **Phone numbers are not verified** (no SMS). No account pages yet | `npm test -- tests/server-core.test.ts -t "customer authentication"` |
| One-time codes, outgoing messages | blocked | codes are generated and stored as keyed hashes; every SMS/WhatsApp/email is stored as `held` and never reported as sent. No provider is configured (needs the owner's provider and credentials) | `npm test -- tests/server-core.test.ts -t "one-time codes|outbox"` |
| Uploads, file storage, `/media` | partial | JPEG/PNG/WebP decided by their bytes, ≤ 8 MB, metadata stripped without re-encoding, SHA-256 for duplicate proofs; private/public keys in KV; `/media/pub_*` serves public files only. **No malware scanning** (none exists on Workers) | `npm test -- tests/server-core.test.ts -t "image uploads|file storage"`; `curl http://localhost:5173/media/pub_x.webp` → 404 |
| Demo catalogue | mocked | 51 products, 72 variants, 68 costs, 114 pictures, stock with 81 movements, 43 serials and 54 cost layers, 85 compatibility rules, 153 search rows, 6 used units, 8 articles, 2 troubleshooting trees, 1 USD rate, 2 coupons — every business row `is_demo`, prices/stock/USD rate are placeholders. No reviews, customers, orders, employees or accounts | `npm test -- tests/seed.test.ts` (40 pass); `npm run db:reset` |
| Clay renders (`<Art>`, `app/art/manifest`) | implemented, retired | 70 pictures of 55 keys (55 hero, 12 front, 3 back); every key the demo seed references exists, and every picture is referenced. DESIGN.md §12 (2026-11-11) retires clay renders for official product photography; the demo seed still points at clay keys (open item 9) | `npm test -- tests/art.test.ts` (153 pass) |
| Product photos (`app/art/photos`) | partial | in progress by the photo pipeline (`scripts/products/images.mjs`, `catalog/products/`): 451 photo manifests for 104 products at the time of this check; `<Art name="<slug>--<n>">` renders them | `npm test -- tests/products-images.test.ts` — 1 failure at the time of this check (an orphaned file in `public/products`, pipeline mid-run) |
| Logo | partial | `<Logo>` in four variants, inline SVG. **Provisional:** traced from a ~200 px logo in a screenshot; the side-by-side `full` lockup is not in the supplied artwork and is unapproved; brand red unconfirmed | `npm test -- tests/brand.test.ts` (18 pass) |
| Icons, favicons, web manifest | partial | 151-symbol sprite + `<Icon>` (RTL mirroring), favicon set, `site.webmanifest`, all served with cache headers. **Not linked from the document head yet** (open item 2) | `npm run icons:check`; `npm test -- tests/brand.test.ts` |
| Motion engine | implemented | DESIGN §7 tokens and grammar, page transitions, shared elements, bubbles, number morph, fly-to-cart, sheets, menus, rails, tiers, head tier script (wired in `root.tsx`). Verified in Chromium only | `npm test -- tests/motion.test.ts` (41 pass); `node app/motion/__checks__/check-fallbacks.mjs` (12/12); `node app/motion/__checks__/check-nav.mjs` |
| Whole project | implemented | — | `npm run typecheck` exit 0; `npm test` (all foundation files green) |

Smoke of the running dev server (2026-11-11): `/`, `/en`, `/ckb`, `/motion` and `/api/health` answer 200 (`{"ok":true,…,"db":true}`); `/media/<missing>` 404; cross-origin POST 403. Screenshots at 390×844 (`.shots/verify/`): no error overlay, no horizontal overflow; the only console error is the hydration warning in open item 1. `/` is still a placeholder page (home area).

## 2. Open items

1. **Hydration warning on every page (lead, `app/root.tsx`).** `<Links />` renders the critical-CSS `<link>` with the request nonce on the server but `nonce={undefined}` on the client (the client's framework context has no nonce). Fix: `<Links nonce={data?.nonce} />` (same for `<Scripts>` and `<ScrollRestoration>`); React 19.3 compares `node.nonce`, so hidden nonces still match.
2. **Brand files not in the head (lead, `app/root.tsx`):** favicon `.ico` + `.svg`, `apple-touch-icon`, `site.webmanifest`, `theme-color` (light `#F3EFEC`, dark from tokens).
3. **No scheduled jobs.** `workers/app.ts` has no `scheduled` handler and `wrangler.jsonc` no cron: `sealAudit` (log its `headHash` outside the database), `cleanupRateLimits`, reservation expiry, and retention of `auth_events`, `otp_codes`, expired sessions and the outbox.
4. **No SMS/WhatsApp/email provider.** Codes and messages are held; phone numbers are unverified; no self-service password reset.
5. **No malware scanning** of uploads (platform limit); defence is the narrow type list and safe serving.
6. **No admin sign-in or setup pages** (`/admin/login`, `/admin/setup` 404); the first owner cannot be created from a browser yet. The local demo employee and customer of ARCHITECTURE §11 (`.dev.seed-credentials`) are created by nobody.
7. **Cloudflare edge settings** (SECURITY.md §13) are unrecorded; HSTS and SPF/DMARC await the owner.
8. **Remote D1:** see the table; the seed SQL file has never been applied remotely.
9. **Product imagery switch.** The demo seed's `media.art_key`, platform, category and device-model pictures are clay keys; DESIGN.md §12 wants official photos (`<slug>--<n>`). Moving the seed needs the catalogue's slugs (`catalog/products/`, e.g. `playstation-5-slim`) to be mapped to the seed's products. `public/products` is about 290 MB in 4,473 files (153 MB of it 720 px PNG fallbacks) — check it against the Workers static-asset limits before deploying.
10. **Logo:** provisional trace; the client should supply the original file, approve or reject the `full` lockup, and confirm the brand red.
11. **Demo data everywhere:** prices, stock and the USD rate are placeholders; `STORE_MODE=demo` keeps `noindex` and the demo flag on.
12. **Security follow-ups** (SECURITY.md §14): PBKDF2 capped at 100,000 iterations by the platform; staff two-step verification optional; no `DATA_KEY` re-encryption tool; `auth_events.identifier` stores full phone numbers.

## 3. Open requests to other owners (from the foundation reports)

| To | Request |
|---|---|
| Lead | items 1–3 and 7 above; ARCHITECTURE §11 names `scripts/seed.mjs`, the file is `scripts/seed.ts`; §5.4 could name the import `import { Art, hasArt, artViews } from "~/art"`; an `errors` messages namespace translating `CORE_ERROR_KEYS`; `public/_headers`: `/products/*` immutable (file names are content-hashed) |
| Admin shell | `/admin/login` and `/admin/setup` pages (setup calls `createFirstOwner`); a signed-in employee opening `/admin/login` goes straight to `next` (the Strict cookie is not sent on links from other sites) |
| Commerce core | refunds: use `refunds.approval_threshold_iqd` and refuse an approval by the refund's creator; amount mismatches on transfer verification need `orders.payment.override` |
| Catalogue / search | write `search_index` with `searchIndexStatements` in the publish batch, **last** in the batch and never followed by `expectChanged()` (drizzle/README.md); normalise synonym terms with `normalizeSearchText` |
| Returns | set `order_item_serials.released_at` when a serialised unit comes back |
| Security module | mask `auth_events.identifier` for anyone without `customer.phone.read_full` |
| Storefront / devices | labels for the `storage_options` spec key |
| Design system | update the old spring-name comment in `app/styles/tokens.css` (the engine now uses the same names); decide on the theme cross-fade contrast dip; reword the tier rule in DESIGN.md §6.5; confirm or replace the two colours in `scripts/logo/assets.mjs` |
| Photo pipeline | the orphan-file failure in `tests/products-images.test.ts`; asset size (item 9); the demo seed switch (item 9) together with the seed owner |
| Deploy | drop `search_index` before `wrangler d1 export` and re-run `0002_search.sql` after |
| Client | original logo file, `full` lockup, brand red; an SMS provider; usage rights for manufacturer images |

## 4. Other areas

Storefront areas, commerce core and the admin modules are not assessed here; their owners add their rows. The admin's 176 blueprint functions will be listed from `app/routes/admin/blueprint-status.ts` (CONTRACTS.md §4) once the admin shell creates it.
