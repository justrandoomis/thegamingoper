# Content area — the store's own pages

Owner: content. Brief §3.13. Routes in `app/routes/storefront/content/` (registered in its `routes.ts`, before the
`*` 404), service `app/server/services/content.server.ts`, strings `app/i18n/messages/content.ts`, tests
`tests/content.test.ts`. The design-system and motion-lab files in the same folder belong to other owners.

## Routes

| Path (also `/en/…`, `/ckb/…`) | File | What it shows |
|---|---|---|
| `/about` | `about.tsx` | what TamTam is (no invented history, numbers or awards), five service tiles, the platforms that have products (shell nav), "how we work" lines from settings, links |
| `/contact` | `contact.tsx` | `store.contact` channels (call / message / write / open keys), address, hours, an anti-fraud line, quick help |
| `/accessibility` | `accessibility.tsx` | settings on this device (theme, language, the motion engine's reduce-motion override), what the site supports, what is NOT tested yet, how to report a problem |
| `/policies` | `policies.tsx` | every policy with a one-line summary and "مسودة" / "معتمدة" |
| `/policies/:slug` | `policy.tsx` | one policy: status, "باختصار" facts, the text (`<Blocks>`), related links, all policies (sticky column from 1024) |
| `/sitemap.xml` | `app/routes/api/sitemap.ts` | every public page × ar/en/ckb with hreflang alternates + x-default on PUBLIC_ORIGIN |
| `/robots.txt` | `app/routes/api/robots.ts` | closed unless the store is live on its canonical host |

Slugs: `shipping`, `returns`, `warranty`, `payment`, `privacy`, `terms` (`POLICY_SLUGS` in `content-model.ts`, the
client-safe file the service and the pages share). Moving between them is the sideways push in that order
(`handle = { order, group: "policies" }`); everything else fades. Unknown slug → the shell's 404.

## Policies: CMS first, code drafts until the owner approves

`getPolicy(db, locale, slug, { now, storeMode })` → `PolicyView` (CONTRACTS §3). A policy is **approved** when a
`pages` row exists with `kind = "policy"`, that `slug`, `status = "published"` (or `"scheduled"` with `starts_at`
passed), inside `starts_at`/`ends_at`, `is_demo = 0`, and readable Arabic blocks in `body.ar`. Then `source: "cms"`,
`approved: true`, `updatedAt = published_at`. Otherwise the code **draft** is served: `source: "draft"`,
`approved: false`, `noindex: true`. The page's "مسودة — بانتظار مراجعة صاحب المتجر" notice reads this flag; drafts
are noindex and absent from the sitemap. A CMS page missing the visitor's language is shown in Arabic
(`textLocale: "ar"`, `lang`/`dir` on the text, a one-line note). The owner may publish more policies under new
slugs: they are served and listed after the six.

**Drafts** are `drafts.*` in the namespace (ar/en/ckb, built into blocks on the server — the browser never gets the
dictionary: `contentMessages()`), filled on every read with live data:
- delivery: `shipping.flat_fee_iqd`; the active governorates (`listGovernorates`); with `shipping.overrides_enabled`
  each governorate's real fee (`getShippingFee`) as a table; COD phone confirmation, transfer checks, wallet;
  tracking needs ref + phone; no SMS yet (no provider);
- returns: `returns.window_days` (0 → "not available"); steps; refund rules of the commerce core (never more than
  paid, transfer refunds carry a reference, cash/wallet, staff review); auto-cancel after `checkout.transfer_proof_hours`;
- warranty: **the store's own terms are pending** (STATUS open item 15, `products.warranty_months` empty); the maker's
  warranty is the maker's, mentioned in the product specs; used units state their own warranty days; safety warning;
- payment: only the methods switched on, with the card number / recipient and Zain Cash number from settings;
  the four-step transfer check; fraud rules (no PAN/CVV, only numbers on this site, proofs private);
- privacy: what is stored and why (order, account, security, support), retention from `RETENTION_DAYS` (jobs) and the
  daily rate-limit cleanup, EVERY shopper cookie (`PRIVACY_COOKIES`: `tt_prefs`, `tt_cart`, `tt_sid` from core
  constants; `tt_wish`, `tt_tradein`, `tt_intro`, `tt_consent`, `tt_platforms`, `tt_rs` mirrored from the areas that
  set them — a test compares each name and lifetime with its owner's constant), browser storage (transitions, motion,
  compare list, a guest's consent-gated recently viewed 90 d — moved to the account and removed from the browser at
  sign-in — and recent searches 30 d), the account's recently viewed (consent only, cleared on withdrawal), Cloudflare
  as host, no tracking without consent: signals are DELETED when consent is withdrawn and after 90 days (the daily
  retention job runs `purgeRecommendationEvents` since 2026-11-11 — integration pass), devices connected only through
  the account;
- terms: demo notice while `STORE_MODE=demo`; prices in IQD; orders, holds, stock races, cancellation; wallet ledger;
  trade-in estimates (`tradein.estimate_valid_days`) are not offers; product information.

Each draft lists what the owner has not decided (return conditions, digital codes, return shipping cost, the
store's warranty, order-record retention, the message provider, legal clauses) as **pending** — never guessed.

### How the admin content module (17) should store and approve policies

1. Edit: a `pages` row `{ kind: "policy", slug, title: L10n, body: LocalizedBlocks (ar required), seo? }` with
   `status: "draft"`; unpublished edits of a live page go to `draft`. Permission `cms.page.manage`.
2. Start from the draft: `getPolicyDraftL10n(db, slug, { storeMode })` returns `{ title, body }` in ar/en/ckb with
   today's settings — save it into `draft`. Once saved, its numbers no longer follow settings, so the owner reviews.
3. Approve = publish: `body = draft`, `status = "published"`, `published_at = now`, `updated_by`, with an audit
   event, permission `cms.page.publish` (or schedule with `starts_at`). Archive to fall back to the code draft.
4. The same reader serves `kind: "about"` / `"contact"` (slug `about` / `contact`): the about text replaces the page's
   description; contact text appears above the details. The live facts and contact channels always stay.

## Contact, about, accessibility

- `getContactDetails(db, locale)` → only what `store.contact` holds (phone `tel:+964…`, WhatsApp `wa.me`, email,
  https social and map links, address, hours). Empty (today) → "بيانات التواصل قريباً" + the help centre (`/support`).
  A failed read is the shell's error page, never "coming soon".
- `getStoreFacts(db, locale)` → fee (or "depends on the governorate"), payment switches, whether transfers are checked.
- Accessibility claims are limited to what the shell, kit and engine do; the page states what is untested (Chromium
  only, no real phones, no screen-reader runs, forced-colors unrendered, Sorani unreviewed).

## Sitemap and robots

`getSitemapEntries(db, now)` (one batch): products published with an active variant and not `seo.noindex` (what the
catalogue lists); active categories under active parents with a listed product below; active platforms with products
or devices; published devices on active platforms; listed used units; approved public articles; approved CMS
policies; `/`, `/used`, `/trade-in`, `/support`, `/policies`, `/about`, `/contact`, `/accessibility`. Each × ar/en/ckb,
`lastmod` where the row has a real `updated_at`. Read failure → 503 + Retry-After (never an empty sitemap). Capped at
50,000 URLs (no index file yet — the catalogue is ~200 pages).

`robots.txt`: `STORE_MODE=demo`, `*.workers.dev` or a host other than PUBLIC_ORIGIN's → `Disallow: /`. Live on the
canonical host → `Allow: /`, the sitemap, and closed in every language: `/cart`, `/checkout`, `/order/`, `/account`,
`/wishlist`, `/track`, `/trade-in/<ref>`, `/search`, `/compare`, `/design-system`, `/motion`. `/admin` and `/api/`
are disallowed in every mode.

## States (brief §12)

Default · draft (pending review) vs approved · partial (CMS text in Arabic only; contact with only some fields) ·
empty (contact "coming soon") · API failure (loader throws → shell error panel; sitemap 503) · unknown policy → 404 ·
offline (shell banner; pages are server-rendered) · reduced motion (push → cross-fade, the motion choice applies at
once). No forms here, so no validation states; nothing needs sign-in.

## Integration slots (for the integration pass)

- A NEW shopper cookie or browser-storage key anywhere in the storefront must be added to `PRIVACY_COOKIES` /
  `PRIVACY_STORAGE_DAYS` (purpose string in `drafts.privacy`); the mirrored ones are test-checked against their owners.
- The contact/report links point to `/support` (help centre) and `/support/repair`: point them at the support area's
  ticket form if it lands on its own path.
- `getPolicy(db, locale, "returns" | "warranty")` is ready for checkout/product snippets (`approved`, `summary`, facts).
- About tile "new" links to `/`; a better landing (all products) can replace it.

## Verify

`npx vitest run tests/content.test.ts` · `node scripts/lint-design.mjs app/routes/storefront/content` ·
`curl localhost:5173/robots.txt` · `curl localhost:5173/sitemap.xml` · screenshots in `.shots/content/`.
