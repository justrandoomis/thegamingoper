# TamTam Games — architecture contract

This is the agreement every contributor (human or agent) builds against. If code and this file disagree, fix one of them on purpose — do not drift.

## 1. Stack

| Layer | Choice | Notes |
|---|---|---|
| Runtime / host | Cloudflare Workers (`workers/app.ts`), custom domain tamtamgames.com | `npm run dev` runs the real Workers runtime locally with a local D1 + KV — no cloud account needed |
| Framework | React Router **8** framework mode, SSR, React **19.3** | Docs for the installed version: `node_modules/react-router/docs/`; skill: `.agents/skills/react-router/` |
| Language | TypeScript strict, ESM | Path alias `~/*` → `app/*` |
| Database | Cloudflare D1 (SQLite) + Drizzle ORM | Migrations in `drizzle/`; invariants enforced by SQL triggers and constraints |
| Blobs | Cloudflare KV binding `KV` (private) behind `~/server/storage.server` | Payment proofs, used-device photos, uploads. R2 can replace it behind the same interface |
| Styling | Design tokens as CSS custom properties + Tailwind v4 utilities | `docs/DESIGN.md`; logical properties only (RTL/LTR) |
| Motion | TamTam Motion Engine (`app/motion`) on WAAPI + CSS + React `<ViewTransition>` | No animation library |
| Validation | zod 4 on the server | |
| Tests | vitest (Node) against a real local D1 via `wrangler`'s `getPlatformProxy` | `npm test` |

Bindings and vars (see `wrangler.jsonc`, typed in `worker-configuration.d.ts`): `DB` (D1), `KV`, `APP_ENV`, `PUBLIC_ORIGIN`, `STORE_MODE` (`demo`|`live`), `HSTS_MAX_AGE`; secrets `SESSION_SECRET`, `DATA_KEY`, `SETUP_TOKEN` (local values in `.dev.vars`, never committed; their types come from the committed `.dev.vars.example` — `wrangler types --env-file .dev.vars.example` — so a fresh clone typechecks; add every new secret there). Server code reads them with `import { env } from "cloudflare:workers"`.

## 2. Commands

```
npm run dev            dev server (already running at http://localhost:5173 during agent work — do not start another)
npm run typecheck      wrangler types + react-router typegen + tsc -b
npm test               vitest run            (npm test -- tests/checkout.test.ts for one file)
npm run db:generate    drizzle-kit generate  (schema owner only)
npm run db:migrate     apply migrations to the local D1
npm run db:seed        load DEMO seed data into the local D1
npm run db:reset       wipe local D1, migrate, seed
node scripts/shot.mjs <url> <out.png> [w=390] [h=844] [--full] [--dark] [--reduced-motion] [--scroll=y] [--selector=css] [--click=css] [--cookie=a=b,c=d] [--dpr=2]
                       headless screenshot; prints JSON with status, horizontalOverflow and console/page errors.
                       Save shots under .shots/ (git-ignored) and LOOK at them with the Read tool.
```

## 3. Folder map and ownership

```
app/
  root.tsx, entry.server.tsx, routes.ts        spine (owner: lead). Do not edit.
  lib/                                         pure, client-safe helpers: locales, money, phone, ids, prefs
  i18n/                                        translate.ts, react.tsx (hooks), i18n.server.ts, messages/<namespace>.ts
  styles/                                      tokens.css, materials.css, base.css, admin.css   (owner: design system)
  ui/                                          design-system components                          (owner: design system)
  motion/                                      TamTam Motion Engine                              (owner: motion)
  art/                                         product-photo manifests + <Art> image component  (owner: photo pipeline)
  server/
    context.server.ts, security.server.ts, shell.server.ts   request context, headers, shell data (owner: lead / server core)
    db.server.ts, db/schema/*.ts, db/tx.server.ts            database access and schema            (owner: data)
    errors.ts, actor.ts, audit.server.ts, settings.server.ts, storage.server.ts, ratelimit.server.ts, auth/*   (owner: server core)
    services/<domain>.server.ts (+ services/<domain>/*)      business logic, one owner per domain
  routes/
    storefront/_layout.tsx, _routes.ts         storefront shell
    storefront/<area>/routes.ts + *.tsx        home | catalog | product | checkout | account | devices | used | support | content
    admin/_layout.tsx, _routes.ts              admin shell
    admin/<module>/routes.ts + *.tsx           one folder per blueprint module (see docs/admin-blueprint.json)
    api/_routes.ts + *.ts                      resource routes
drizzle/                                       SQL migrations (generated + hand-written triggers)
scripts/                                       seed, db-reset, shot, art pipeline, icons
tests/                                         vitest: helpers/, <domain>.test.ts
docs/                                          ARCHITECTURE.md, DESIGN.md, STATUS.md, SECURITY.md, admin-blueprint.json
public/                                        fonts, generated images, icons
```

Rules that make parallel work safe:

- **One owner per file.** Register routes only in your area's `routes.ts`. Add strings only in your own `app/i18n/messages/<namespace>.ts` (the file name is the namespace; files are discovered automatically). Add tests in your own `tests/<name>.test.ts`.
- **Need something in a file you do not own?** Do not edit it. Use what exists, and list the change you need under "Requests to other owners" in your final answer.
- Feature-local components live next to the route that uses them (`routes/storefront/checkout/components/…`). Promote to `app/ui` only through the design-system owner.

## 4. Request lifecycle

1. `root.tsx` installs `requestContextMiddleware` (`~/server/context.server`): CSRF origin check for non-GET requests, builds `RequestCtx` (locale from the URL, prefs cookie, ip, nonce, `now`), then adds security headers and queued cookies to the response.
2. Loaders/actions call `getCtx(context)`, `getDb()`, and domain services. They are thin: parse input, call a service, shape the result.
3. Services own business rules, authorization (`assertCan`), validation (zod), audit events and atomic writes.
4. The root loader returns shell data (`RootLoaderData`): `locale`, `dir`, `prefs`, `storeMode`, `cart.count`, `customer`, `fx`, `introSeen`, `personalizationConsent`, `i18n.common`.

```tsx
// app/routes/storefront/product/product.tsx — the canonical route module
import { data } from "react-router";
import type { Route } from "./+types/product";
import { messagesFor } from "~/i18n/i18n.server";
import { useT, useFormat, LocaleLink } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getProductBySlug } from "~/server/services/catalog.server";

export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const product = await getProductBySlug(getDb(), params.slug, ctx.locale);
  if (!product) throw data({ error: "not_found" }, { status: 404 });
  return { product, i18n: messagesFor(ctx.locale, "product") };
}

export function meta({ loaderData }: Route.MetaArgs) {          // v8: `loaderData`, not `data`
  return [{ title: loaderData?.product.name }];
}

export default function Product({ loaderData }: Route.ComponentProps) {
  const t = useT("product");
  const f = useFormat();
  return <h1>{loaderData.product.name} — {f.money(loaderData.product.priceIqd)}</h1>;
}
```

```ts
// Actions: validate → service → typed result. Field errors return 400 and never throw.
export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const form = await request.formData();
  const result = await placeOrder(getDb(), ctx, parseCheckoutForm(form));     // returns { ok: true, … } | { ok: false, fields, code }
  if (!result.ok) return data(result, { status: result.code === "invalid" ? 400 : 409 });
  return redirect(localePath(`/order/${result.ref}`, ctx.locale));
}
```

- Mutations that keep the shopper on the page use `useFetcher` (cart, wishlist, quantity). Forms that move the shopper use `<Form method="post">`. Search/filter state lives in the URL (`<Form method="get">`), so it is shareable and survives Back.
- Admin redirects to the sign-in page must use `redirectDocument("/admin/login")` (a Cloudflare managed challenge protects that path; a client-side data fetch cannot pass it).
- Never import a `*.server.ts` module from a component file's client code path; pass data through loaders.

## 5. Conventions

### 5.1 Database

- `getDb()` from `~/server/db.server` returns the Drizzle client (`Db` type). Services take `db` as their **first argument** and never import `cloudflare:workers`, so tests can inject a local D1.
- Primary keys: `newId("<prefix>")` from `~/lib/ids` (time-sortable, text). Human references: `publicRef("TT")` → `TT-7K4M2Q9X`. Secrets (session ids, guest access tokens): `randomToken()`; store only `sha256Hex(token)`.
- Timestamps: integer epoch **milliseconds**, columns named `*_at`. Use `ctx.now` so one request writes one timestamp. Business days and reports use Asia/Baghdad (UTC+3, no DST).
- Money: integer IQD in columns named `*_iqd`. Use `sumIqd`, `bpsOf` from `~/lib/money`; never `parseFloat` a price.
- Localized text: JSON columns of type `L10n` (`{ ar, en?, ckb? }`), read with `pick(value, locale)`.
- **Atomic writes:** D1 has no interactive transactions. Every multi-statement mutation is ONE `db.batch([...])`, which runs as a single transaction and rolls back as a whole. Conditional logic inside a batch is expressed with guards from `~/server/db/tx.server` (`expectChanged()` fails the batch when the previous statement changed no rows) and with the triggers listed in §7, which abort with messages like `TT:INSUFFICIENT_STOCK:<variantId>`. `mapDbError(error)` turns those into `AppError`s.
- Idempotency: creation endpoints accept a client-generated `idempotencyKey` stored in a UNIQUE column; on conflict return the existing row instead of failing.
- Batch rules learned while building the data layer (details in `drizzle/README.md` and `app/server/db/tx.server.ts`):
  - `expectChanged()` reads SQLite `changes()` of the statement directly before it (trigger-made changes do not count; a conflicting `ON CONFLICT DO NOTHING` counts as 0). Use one guard per guarded statement.
  - Never put `db.run(sql\`…${param}\`)` inside `db.batch` (Drizzle 0.45 bug) — use query builders or `batchSql(...)` / `runBatch(...)`.
  - D1 allows at most 100 bound parameters per statement — split bulk inserts with `chunkRows`.
  - Foreign-key violations surface only at commit as an opaque error, so insert parents before children in a batch.
  - Journal entries: insert the lines first and the header last (`journalEntryStatements()`); the header insert checks the balance and seals the entry.
  - `INSERT OR REPLACE` on an `[A]` table that meets an existing key is refused (`TT:IMMUTABLE:<table>`, migration 0003: each `[A]` table has a `<table>_no_replace` guard that probes `_replace_guard`); plain duplicates, `ON CONFLICT DO NOTHING`/`DO UPDATE` and `OR IGNORE` behave exactly as SQLite does. A migration that rebuilds an `[A]` table must re-create its guard (see `drizzle/README.md`).
- Trigger error codes (raised as `TT:<CODE>:<detail>`, parsed by `mapDbError`): `IMMUTABLE`, `INSUFFICIENT_STOCK`, `SERIAL_NOT_AVAILABLE`, `USED_UNIT_NOT_AVAILABLE`, `USED_UNIT_NOT_LISTABLE`, `WALLET_OVERDRAFT`, `LOYALTY_OVERDRAFT`, `PAYMENT_NOT_VERIFIED`, `REFUND_EXCEEDS_PAYMENT`, `REFUND_PAYMENT_MISMATCH`, `REFUND_QTY_EXCEEDS`, `REFUND_ITEM_MISMATCH`, `ORDER_REFUND_EXCEEDS_PAID`, `TRADE_IN_OFFER_NOT_ALLOWED`, `PERIOD_CLOSED`, `JOURNAL_UNBALANCED`, `JOURNAL_SEALED`, `NO_ROWS_CHANGED`, `GUARD_FAILED`.
- Schema facts that differ from a first reading of §6: `order_item_serials.serial_id` is unique only while `released_at IS NULL` (a returned unit can be resold with history kept); price approvals are new `price_changes` rows pointing at the request (`request_id`); a `bank_transfer`/`zaincash` payment cannot become `paid` without `verified_by` and `verified_at`; idempotency keys are NOT NULL on orders, payments, wallet and loyalty ledgers and wallet top-ups; CHECK constraints enforce order total = subtotal − discount + shipping + tax and line total = unit × qty − discount, and web orders must carry a phone; `media.is_illustration` defaults to true; percent coupons store basis points.
- Remote D1 verified on 2026-11-11: migrations 0000–0002 applied to the production database (`tamtam-db`); expression `RAISE` with dynamic messages, `RAISE(IGNORE)` and FTS5 `trigram` all work there as they do locally. New migrations go to production with `npm run db:migrate:remote` before the deploy that needs them.
- Protected data (supplier cost, landed cost, margins, acquisition cost) lives in separate tables/columns and is only selected by services after `can(actor, "cost.read")`. It must be absent — not null-masked in the UI — from every response, export and API for other actors.

### 5.2 Services, actors, errors

```ts
import { z } from "zod";
import type { Db } from "~/server/db.server";
import { assertCan, type Actor } from "~/server/actor";
import { AppError } from "~/server/errors";
import { auditStatement } from "~/server/audit.server";

export const AdjustStockInput = z.object({ variantId: z.string(), locationId: z.string(), delta: z.number().int(), reason: z.string().min(3) });

export async function adjustStock(db: Db, actor: Actor, raw: unknown, now: number) {
  assertCan(actor, "inventory.stock.adjust");                 // throws AppError(403)
  const input = AdjustStockInput.parse(raw);
  await db.batch([ /* movement insert, level update, */ auditStatement(db, { actor, action: "inventory.adjust", entityType: "variant", entityId: input.variantId, reason: input.reason, after: input, at: now }) ]);
}
```

- `Actor` = `{ kind: "guest" } | { kind: "customer", id } | { kind: "employee", id, permissions, branchId? } | { kind: "system", job }`.
- Permissions are strings `<module>.<resource>.<action>` (e.g. `orders.payment.verify`, `catalog.product.publish`). Field-level ones: `cost.read`, `profit.read`, `customer.phone.read_full`, `payment_proof.read`, `digital_code.reveal`.
- Every stock, wallet, price, refund, permission and settings change writes an audit event (actor, action, entity, before/after, reason, ip, request id). Audit, stock-movement, wallet-ledger, order-event and journal tables are append-only (triggers reject UPDATE/DELETE).
- Throw `AppError(code, status, { fields? })` for expected failures; routes turn them into field errors or `data(…, { status })`. Unexpected errors bubble to the error boundary — never swallow them and never show a zero in place of a failed number.

### 5.3 i18n and formatting

- Namespaces: `app/i18n/messages/<namespace>.ts` exporting `defineMessages({ ar: {…}, en: {…}, ckb: {…} })`. Same keys in all three locales (test-enforced). Loaders pass them down: `i18n: messagesFor(ctx.locale, "checkout")`.
- Components: `const t = useT("checkout")`, plural-aware `t("items", { count })`. Server strings (meta, notifications): `serverT(locale, "checkout")`.
- Links: `<LocaleLink to="/cart">` / `useLocalePath()`. Never hard-code `/en/...`.
- Numbers, money, dates, phones: `useFormat()` → `money(iqd)`, `iqd(iqd)`, `number`, `date`, `dateTime`, `relative`, `phone`. Payable totals always use `iqd()`; converted display prices are approximations and must be labelled (the `<Price>` component does this).
- Direction comes from the locale registry (`~/lib/locales`). Use logical CSS (`margin-inline-start`, `inset-inline-end`, Tailwind `ms-*`/`pe-*`/`start-*`), never `left`/`right`. Phone numbers, SKUs, serials, order references and prices are wrapped in `dir="ltr"` / `<bdi>` so they do not reorder inside Arabic text.
- Copy voice: plain, specific, active. A button says exactly what happens ("أضف إلى السلة", "تأكيد الطلب"), keeps the same name through the flow, errors say what went wrong and how to fix it. No filler, no exclamation marks, no invented claims.

### 5.4 UI, motion, images

- Build screens from `app/ui` components and the tokens in `docs/DESIGN.md`. No hard-coded colours, radii or shadows in feature code. Clay = things you can grab; glass = floating chrome you look through. Glass (`backdrop-filter`) is never used on scrolling lists.
- Motion goes through `~/motion` (API in `docs/DESIGN.md` §Motion): press feedback is automatic for elements with `data-press`; `flyToCart(el)`; `<Bubble>` for content that arrives; `<SharedElement name>` for card→page morphs; `<NumberMorph>` for prices. Never delay navigation, data or a state change for an animation; everything must work with `prefers-reduced-motion`.
- Product and category imagery comes from `<Art name=… />` (official product photos, keys `<slug>--<n>`, pre-built responsive AVIF/WebP with dimensions and a placeholder; `scripts/products/images.mjs`) or `<Media>` for uploaded photos (`import { Art, hasArt, artViews, productShareImage } from "~/art"`). Always pass intrinsic width/height; only the first above-the-fold image may be `priority`.
- Every flow designs its states: loading (bubble reveal, no grey skeletons), empty, error, offline, validation error, success, pending review, unauthorized.
- Accessibility floor: semantic landmarks and headings, labels on every control, visible focus, 44px touch targets, `aria-live` for cart and form feedback, focus management in sheets/dialogs, WCAG AA contrast in both themes.

### 5.5 Preferences

- Language: URL prefix (`/`, `/en`, `/ckb`). Switch with `switchLocalePath` — same page, state preserved.
- Theme, display currency, numeral system: `tt_prefs` cookie + client store (`usePrefs`, `setPrefs` from `~/lib/prefs`). Switching is instant and makes no request.
- Other cookies: `tt_cart` (httpOnly cart token), `tt_sid` (httpOnly customer session), `tt_wish` (guest wishlist, 60 days — survives a new cart token), `tt_tradein` (trade-in wizard draft, 2 days), `tt_intro` and `tt_platforms` (home intro seen, chosen platforms), `tt_consent` (personalisation consent), `tt_rs` (hashed recommendation session, only with consent, 90 days); staff: `tt_adm` (httpOnly admin session, `Path=/admin`), `tt_admin_locale`, `tt_admin_rail`. A new shopper cookie must also be listed in `PRIVACY_COOKIES` (`services/content.server.ts`): the privacy policy is built from it and `tests/content.test.ts` checks each entry against its owner's constant.

## 6. Data model

Drizzle schema in `app/server/db/schema/<file>.ts`, re-exported from `schema/index.ts`. `[P]` = protected (cost/profit), `[A]` = append-only.

**core.ts** — `settings(key PK, value json, updated_at, updated_by)`, `audit_events[A](seq INTEGER PK AUTOINCREMENT, id, at, actor_kind, actor_id, actor_label, action, entity_type, entity_id, summary, before json, after json, reason, ip, request_id)`, `audit_seals[A](id, from_seq, to_seq, hash, prev_hash, created_at)`, `files(id, storage_key, visibility 'public'|'private', kind, mime, bytes, sha256, width, height, owner_type, owner_id, created_by, created_at)`, `outbox(id, channel 'sms'|'whatsapp'|'email'|'push', recipient, template, payload json, status 'held'|'queued'|'sent'|'failed', attempts, last_error, created_at, sent_at)`, `rate_limits(key, window_start, count, PK(key, window_start))` (rate limiting lives in D1, not KV — KV's free tier allows very few writes), `job_runs`, `error_reports`, `incidents`, `consistency_findings`, `_tx_guard(ok INTEGER NOT NULL)`, `_replace_guard(tbl, probe NOT NULL)` (migration 0003 only — never holds a row; the probe target of the `<table>_no_replace` guards).

Structured content (knowledge articles, policies, device guides) is stored as localized **block arrays**, never HTML or Markdown: `Block = { type: "h2"|"p"|"ul"|"ol"|"steps"|"callout"|"table"|"art", … }`, rendered by one `<Blocks>` component. This keeps staff-authored content safe by construction.

**catalog.ts** — `platforms(id, slug, name L10n, accent, sort)`, `device_generations(id, platform_id, slug, name L10n, sort)`, `device_models(id, platform_id, generation_id, slug, name L10n, summary L10n, specs json, released_on, status)`, `categories(id, parent_id, slug, name L10n, kind, sort, is_active)`, `products(id, slug UNIQUE, kind 'console'|'game'|'controller'|'headset'|'storage'|'accessory'|'digital'|'part'|'bundle', name L10n, short L10n, description L10n, brand, platform_id, device_model_id, category_id, specs json, attributes json, warranty_months, age_rating, region, license_type, media_format 'physical'|'digital'|null, status 'draft'|'review'|'scheduled'|'published'|'archived', publish_at, is_demo, seo json, created_at, updated_at)`, `product_versions[A](id, product_id, version, snapshot json, changed_by, reason, created_at)`, `variants(id, product_id, sku UNIQUE, barcode, title L10n, options json, price_iqd, compare_at_iqd, is_default, is_active, track_serials, sort)`, `variant_costs[P](variant_id PK, currency, unit_cost_minor, fx_rate_micros, fx_date, landed_cost_iqd, min_margin_bps, target_margin_bps, updated_by, updated_at)`, `price_changes[A](id, variant_id, old_price_iqd, new_price_iqd, reason, requested_by, approved_by, status, created_at)`, `media(id, owner_type, owner_id, file_id, art_key, kind 'image'|'video'|'render', alt L10n, is_illustration, sort)`, `bundle_items(bundle_variant_id, component_variant_id, qty)`, `product_relations(product_id, related_product_id, kind 'accessory'|'upsell'|'alternative'|'upgrade'|'setup', pinned, sort)`, `compatibility_rules(id, subject_type 'product'|'variant', subject_id, target_type 'device_model'|'generation'|'platform', target_id, status 'verified'|'partial'|'incompatible'|'unverified', note L10n, source, verified_by, verified_at)`, `reviews(id, product_id, customer_id, order_item_id, rating, title, body, status 'pending'|'approved'|'rejected', is_verified_purchase, created_at)`, `search_synonyms(id, locale, term, synonyms json)`, plus FTS5 table `search_index` (SQL migration).

**inventory.ts** — `inventory_locations(id, code UNIQUE, name, kind 'warehouse'|'store'|'bin', parent_id, barcode, is_sellable, branch_id)`, `stock_levels(variant_id, location_id, on_hand, reserved, incoming, reorder_point, allow_oversell, PK(variant_id, location_id))`, `stock_movements[A](id, variant_id, location_id, serial_id, kind 'receive'|'reserve'|'release'|'sale'|'transfer_out'|'transfer_in'|'damage'|'adjust'|'return'|'count', qty_delta, reserved_delta, unit_cost_iqd[P], ref_type, ref_id, reason, actor_kind, actor_id, at)`, `serials(id, serial UNIQUE, variant_id, status 'in_stock'|'reserved'|'sold'|'returned'|'in_repair'|'scrapped'|'intake', location_id, cost_iqd[P], source 'purchase'|'trade_in', source_ref, notes)`, `stock_reservations(id, order_id, variant_id, location_id, qty, status 'active'|'committed'|'released'|'expired', expires_at, created_at)`, `stock_transfers`, `stock_transfer_items`, `cycle_counts`, `cycle_count_lines`, `cost_layers[P](id, variant_id, location_id, qty_remaining, unit_cost_iqd, received_at, receipt_item_id)`.

**customers.ts** — `customers(id, phone_e164 UNIQUE, name, email, password_hash, password_iters, status, locale, vip_tier, fraud_flag, notes, created_at)`, `guest_contacts(id, phone_e164, name, created_at)`, `addresses(id, customer_id, label, recipient_name, phone_e164, governorate_id, district_id, area_text, address_text, notes, is_default)`, `customer_sessions(id_hash PK, customer_id, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at)`, `otp_codes(id, phone_e164, purpose, code_hash, attempts, expires_at, consumed_at)`, `consents[A](id, subject_type, subject_id, kind 'marketing'|'personalization'|'analytics'|'support_log', granted, source, at)`, `saved_devices(customer_id, device_model_id)`, `wishlist_items(id, customer_id, cart_token_hash, product_id, created_at)`, `recently_viewed`, `notifications(id, customer_id, kind, title L10n, body L10n, link, read_at, created_at)`, `privacy_requests`.

**commerce.ts** — `carts(id, token_hash UNIQUE, customer_id, coupon_code, created_at, updated_at)`, `cart_items(id, cart_id, variant_id, used_unit_id, qty, added_at)`, `orders(id, ref UNIQUE, idempotency_key UNIQUE, channel 'web'|'pos', customer_id, guest_contact_id, status 'new'|'awaiting_payment'|'payment_review'|'confirmed'|'preparing'|'shipped'|'delivered'|'cancelled'|'returned', payment_status 'unpaid'|'cod_due'|'pending_verification'|'paid'|'rejected'|'partially_refunded'|'refunded', payment_method, subtotal_iqd, discount_iqd, shipping_iqd, total_iqd, paid_iqd, refunded_iqd, coupon_id, contact_name, contact_phone_e164, governorate_id, district_id, area_text, address_text, notes, preferred_day, preferred_window, marketing_consent, locale, access_token_hash, is_demo, risk_flags json, placed_at, confirmed_at, cancelled_at, cancel_reason)`, `order_items(id, order_id, variant_id, used_unit_id, sku, name_snapshot L10n, options_snapshot json, unit_price_iqd, qty, discount_iqd, total_iqd, cost_snapshot_iqd[P], refunded_qty, warranty_months)`, `order_item_serials(order_item_id, serial_id UNIQUE)`, `order_events[A](id, order_id, kind, data json, actor_kind, actor_id, at)`, `payments(id, order_id, method 'cod'|'wallet'|'bank_transfer'|'zaincash'|'pos_cash'|'pos_card', status 'pending'|'pending_verification'|'paid'|'rejected'|'cancelled', amount_iqd, declared_amount_iqd, reference, idempotency_key UNIQUE, verified_by, verified_at, reject_reason, created_at)`, `payment_proofs(id, payment_id, file_id, declared_amount_iqd, note, status 'submitted'|'approved'|'rejected', duplicate_of, sha256, reviewed_by, reviewed_at, review_note, created_at)`, `refunds(id, order_id, payment_id, amount_iqd, method 'original'|'wallet'|'cash', reason, status, approved_by, created_by, created_at)`, `refund_items(refund_id, order_item_id, qty)`, `coupons(id, code UNIQUE, kind 'fixed'|'percent', value, min_subtotal_iqd, max_discount_iqd, usage_limit, per_customer_limit, starts_at, ends_at, conditions json, is_active)`, `coupon_redemptions(id, coupon_id, order_id, customer_id, phone_e164, amount_iqd, at)`, `wallet_ledger[A](id, customer_id, amount_iqd, kind 'topup'|'purchase'|'refund'|'trade_in_credit'|'gift_card'|'adjustment', ref_type, ref_id, reason, actor_kind, actor_id, idempotency_key UNIQUE, at)`, `gift_cards`, `loyalty_ledger[A]`.

**shipping.ts** — `governorates(id, slug, name L10n, sort, is_active)`, `districts(id, governorate_id, name L10n, sort, is_active)`, `shipping_rates(id, governorate_id NULL=all, fee_iqd, is_override, is_active)`, `carriers`, `shipments(id, order_id, carrier_id, tracking_no, status, cod_amount_iqd, cod_settled_at, packed_by, proof_file_id, shipped_at, delivered_at)`, `shipment_items`, `shipment_events[A]`, `delivery_attempts`, `cod_settlements`.

**aftersales.ts** — `returns(id, rma UNIQUE, order_id, customer_id, status, reason, resolution, created_at)`, `return_items(return_id, order_item_id, qty, serial_id, condition 'sellable'|'opened'|'defective'|'damaged', inspected_by, notes)`, `warranties(id, order_item_id, serial_id, customer_id, phone_e164, starts_at, ends_at, terms L10n, status)`, `repair_tickets(id, ref UNIQUE, customer_id, phone_e164, device_model_id, serial_id, warranty_id, issue, status, sla_due_at, assigned_to, parts json, cost_iqd, created_at)`, `repair_events[A]`.

**used.ts** — `used_units(id, slug UNIQUE, variant_id, serial_id, grade 'A+'|'A'|'B'|'C', battery_health_pct, cosmetic_notes L10n, defects json, included json, checklist json, price_iqd, acquisition_cost_iqd[P], warranty_days, location_id, status 'intake'|'testing'|'ready'|'listed'|'reserved'|'sold'|'returned', ownership_checked_at, data_wiped_at, listed_at, is_demo)`, `inspection_templates(id, device_kind, items json)`, `trade_ins(id, ref UNIQUE, customer_id, phone_e164, device_model_id, variant_id, answers json, estimate_min_iqd, estimate_max_iqd, estimate_expires_at, status 'submitted'|'estimated'|'inspection_scheduled'|'inspected'|'offered'|'accepted'|'declined'|'paid'|'cancelled'|'expired', final_offer_iqd, offered_by, offered_at, offer_expires_at, payout_method 'store_credit'|'cash', serial_id, ownership_ok, account_lock_ok, data_wiped, inspection json, access_token_hash, created_at)`, `trade_in_events[A]`, `trade_in_price_guides(id, device_model_id, variant_id, base_iqd, grade_multipliers json, updated_by, updated_at)`.

**support.ts** — `support_tickets`, `ticket_messages`, `canned_replies`, `knowledge_articles(id, slug UNIQUE, kind 'guide'|'troubleshooting'|'faq'|'policy'|'setup', title L10n, body L10n, device_model_id, platform_id, tags json, audience 'public'|'internal', status 'draft'|'review'|'approved'|'archived', approved_by, approved_at, updated_at)`, `troubleshooting_trees(id, device_model_id, symptom_key, title L10n, tree json, status, approved_by)`, `assistant_sessions`, `assistant_messages`.

**purchasing.ts** — `suppliers`, `rfqs`, `rfq_quotes`, `purchase_orders`, `po_items`, `receipts`, `receipt_items`, `supplier_invoices`, `landed_cost_allocations`, `supplier_claims` (all `[P]`).

**accounting.ts** — `accounts(id, code UNIQUE, name L10n, type)`, `journal_entries[A](id, at, period, memo, ref_type, ref_id, created_by, reverses_id)`, `journal_lines[A](id, entry_id, account_id, debit_iqd, credit_iqd, cost_center)`, `fiscal_periods(period PK, status 'open'|'closed', closed_by, closed_at)`, `expenses`, `fx_rates(id, quote 'USD', iqd_per_unit, source, is_demo, effective_at, created_by)`.

**staff.ts** — `employees(id, email UNIQUE, name, phone, password_hash, password_iters, totp_secret_enc, totp_enabled, recovery_codes json, status 'active'|'disabled', branch_id, locale, created_at, disabled_at)`, `roles(id, key UNIQUE, name L10n, is_system)`, `role_permissions(role_id, permission)`, `employee_roles(employee_id, role_id)`, `employee_sessions(id_hash PK, employee_id, mfa_ok, created_at, last_seen_at, expires_at, ip, user_agent, revoked_at)`, `approvals(id, kind, entity_type, entity_id, requested_by, payload json, status 'pending'|'approved'|'rejected', decided_by, decided_at, reason)`, `shifts`, `attendance`, `commissions`, `payroll_runs`.

**pos.ts** — `pos_registers`, `pos_shifts(id, register_id, opened_by, opened_at, opening_float_iqd, closed_by, closed_at, counted_cash_iqd, expected_cash_iqd, variance_iqd, status)`, `cash_movements[A]`.

**growth.ts** — `promotions`, `flash_sales`, `referral_codes`, `memberships`, `campaigns`, `utm_links`, `cart_reminders`, `recommendation_rules(id, kind 'pin'|'exclude'|'boost', context json, product_id, weight, reason, created_by)`, `recommendation_events(id, session_hash, customer_id, kind 'view'|'click'|'add'|'purchase', product_id, source, at)`, `experiments`, `experiment_assignments`.

**cms.ts** — `banners`, `home_sections`, `pages`, `redirects(from_path UNIQUE, to_path, code)`, `nav_menus`.

**ops.ts** — `workflows`, `workflow_runs`, `api_keys`, `webhooks`, `webhook_deliveries`, `inbound_events(id PK = "<provider>:<event id>")`, `branches`, `channels`.

## 7. Business invariants (enforced in the database, verified by tests)

1. **Stock never goes negative** — trigger on `stock_levels` aborts when `on_hand - reserved < 0` and `allow_oversell = 0`; oversell needs the `inventory.oversell.authorize` permission and an audit reason.
2. **A serial is sold once** — `order_item_serials.serial_id` is UNIQUE and `serials.status` only moves `in_stock|reserved → sold` through a guarded update.
3. **Orders and payments are idempotent** — UNIQUE `idempotency_key`; a retry returns the first result. Inbound webhooks dedupe on `inbound_events.id`.
4. **Refunds are bounded** — trigger: total refunds for a payment ≤ amount paid; refunded quantity per order item ≤ quantity bought; every refund references its original payment.
5. **Wallet is a ledger** — no balance column. Balance = SUM(amount_iqd). A trigger rejects a debit that would overdraw. Guests have no wallet.
6. **Manual transfers are never auto-paid** — a bank/Zain Cash order stays `pending_verification` until an employee with `orders.payment.verify` approves a proof whose declared amount matches; duplicates (same sha256 or reference) are flagged.
7. **Shipping is a flat 5,000 IQD** to every governorate unless `shipping.overrides_enabled` is set by an admin.
8. **Append-only history** — `[A]` tables reject UPDATE and DELETE. Corrections are new rows (reversal entries).
9. **Profit is defined once** — revenue − discounts − refunds − landed cost − commissions − shipping subsidy; `docs/metrics.md` is the dictionary reports must follow.
10. **Cost privacy** — `[P]` data never leaves the server for actors without `cost.read` (UI, export, API).
11. **Used units show real evidence** — a used unit cannot be `listed` without at least one non-illustration photo, a completed checklist, `ownership_checked_at` and `data_wiped_at`.
12. **Trade-in estimates are not offers** — only an employee can create `final_offer_iqd`, after inspection.

## 8. Security model

- Edge (Cloudflare): Full (strict) TLS, TLS ≥ 1.2, Always Use HTTPS, DNSSEC, bot fight mode, leaked-credential detection, WAF rules (scanner paths blocked; managed challenge on `/admin/login` and `/admin/setup`), rate limit on sign-in/checkout/tracking/upload paths. Details: `docs/SECURITY.md`.
- App: nonce-based CSP in production, CSRF origin check, httpOnly SameSite cookies, PBKDF2-SHA256 password hashes with per-user salt, TOTP MFA for employees, hashed session ids with server-side revocation, per-phone/IP rate limits, zod validation of every input, uploads validated by magic bytes + size + stripped metadata and stored privately (served only through an authorized route with `Content-Disposition: attachment` semantics for non-images).
- Guest order lookup needs the order reference **and** the phone number (and the access token from the confirmation link when present); never the phone alone. Failed lookups are rate-limited and give one generic message.
- Never collect card PAN/CVV/expiry. Payment destination details shown to shoppers come from settings.

## 9. URL map

Storefront (optional `/en` or `/ckb` prefix): `/`, `/c/:category`, `/platform/:platform`, `/device/:model`, `/search`, `/p/:slug`, `/compare`, `/wishlist`, `/cart`, `/checkout`, `/order/:ref`, `/track`, `/used`, `/used/:slug`, `/trade-in`, `/trade-in/:ref`, `/support`, `/support/assistant`, `/support/repair`, `/support/article/:slug`, `/account/*`, `/about`, `/contact`, `/policies/:slug`, `/accessibility`, `/design-system`, `/motion`.
Resources (registered in `app/routes/api/_routes.ts`): `/api/cart`, `/api/events`, `/api/files/:fileId` (a shopper's own private file — a transfer proof for the order's owner or its `?t=` token, a wallet top-up proof for its uploader; one 404 for everything else; `private, no-store`), `/api/health`, `/api/onboarding`, `/api/product-preview/:slug`, `/api/recently-viewed`, `/api/search/suggest`, `/api/upload/proof`, `/api/upload/tradein`, `/api/wishlist`, `/media/:key` (public files only), `/robots.txt`, `/sitemap.xml`.
Admin: `/admin/login`, `/admin/setup`, `/admin`, `/admin/<module>/…`.

## 10. Settings (table `settings`, seeded)

`shipping.flat_fee_iqd` = 5000 · `shipping.overrides_enabled` = false · `payments.cod` = `{ enabled: true }` · `payments.wallet` = `{ enabled: true }` · `payments.bank_transfer` = `{ enabled: true, account_number: "9269317427", recipient_name: "علي خليفة" }` · `payments.zaincash` = `{ enabled: true, number: "07719061852" }` · `checkout.reservation_minutes` = 30 · `checkout.transfer_proof_hours` = 24 · `returns.window_days` = 7 · `tradein.estimate_valid_days` = 7 · `store.contact` = `{}` (owner fills in) · `locale.numbering` = `{ ar: "latn", en: "latn", ckb: "latn" }`.

## 11. Demo data policy

Seed data (`npm run db:seed` → `scripts/seed.ts`, catalogue from `catalog/products/`) exists so the store can be explored. Every seeded business row has `is_demo = 1`; prices, stock and the USD rate are placeholders. The storefront shows a demo ribbon and sends `noindex` while `STORE_MODE=demo`; orders placed in demo mode are flagged `is_demo`. Seed creates **no** accounts in production — the first owner account is created at `/admin/setup` with `SETUP_TOKEN`. Local development gets one demo employee and one demo customer (`scripts/dev-accounts.ts`, re-run after every reset) whose credentials are written to `.dev.seed-credentials` (git-ignored), never to chat or source.
