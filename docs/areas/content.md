# Content area — the store's own pages

Owner: content. Brief §3.13. Routes in `app/routes/storefront/content/` (registered in its `routes.ts`, before the
`*` 404), service `app/server/services/content.server.ts`, strings `app/i18n/messages/content.ts` (and the brand strings
in `common.ts`), page CSS `content.css`, tests `tests/content.test.ts`. The design-system and motion-lab files in the
same folder belong to other owners.

**Design System v2 (2026-11-11, spec §6.15–§6.16):** the pages are built from the kit only — `FactList`, `EntryCard`,
`ContactCard`, `Segmented` (via the shell's `ThemeBank` / `LanguageBank` and `MotionChoice`), `Key`, `Blocks`,
`Breadcrumbs`, `Status` — on a 720px reading column at the start line of the wrap (`.ccol`), with an aside from 1024
on /about and /contact (`.csplit`) and the 240px list of policies beside the text (`.cpolicy`). No retired kit names
(the 1.0 `KeyBank` segment became `Segmented`; no clay keys, no tonal panels).

## Routes

| Path (also `/en/…`, `/ckb/…`) | File | What it shows |
|---|---|---|
| `/about` | `about.tsx` | the h1 and lead (no invented history, numbers or awards; a published CMS "about" page replaces the lead) · «ما تجده هنا»: four kit EntryCards (new, used & inspected, trade-in, support; art = each platform's hardware photo from the shell nav, the mascot for support) · «كيف نعمل»: fact rows from settings (fee, payment methods on, manual transfer checks) and fixed rules · aside: the platforms with products, the ContactCard or «اكتب لموظف», «اعرف أكثر» rows (`aboutLinks`: policies, /contact only once a channel exists, accessibility — the hand-off is never offered a second time under its own card). No red key |
| `/contact` | `contact.tsx` | the kit ContactCard first (WhatsApp = the view's one red key, phone, address + map, hours in the owner's words) and e-mail / social rows — or, with no channel (today), «اكتب لموظف» leading with «تحدّث مع موظف» as the red key, under a lead that offers no choice («اكتب لموظف في المتجر من هنا…», `contact.leadHandoff`; «اختر الطريقة الأسهل لك» only with channels); the anti-fraud line; «مساعدة سريعة» rows (aside from 1024) |
| `/accessibility` | `accessibility.tsx` | the aim (WCAG 2.2 AA) · settings on this device (theme, language, the motion engine's reduce-motion override) · six fact rows of what the site supports · ONE short «ما لم نختبره بعد» · «أبلغنا عن مشكلة» → the hand-off form (the red key), plus the ContactCard when there is one |
| `/policies` | `policies.tsx` | the head with ONE status line while any policy is a first version · every policy (icon, title, one line) in a paper card · «لم تجد جوابك؟» → «اكتب لموظف». A row says «نسخة أولى» only when some policies are approved and some not |
| `/policies/:slug` | `policy.tsx` | breadcrumbs, h1, summary, the status line («● نسخة أولى — قد تتغيّر قبل الإطلاق.» · «آخر تحديث 11 تشرين الثاني 2026»), «باختصار» (live facts as kit fact rows), the text (`<Blocks>`), «قد تحتاج أيضاً» rows, all policies (a 240px sticky list at the start from 1024, after the text below it) |
| `*` (`/nope`, an unknown policy) | `not-found.tsx` → the layout's ErrorBoundary | the shell's 404 panel (`shell/ShellError.tsx`, owner shell, v2 §6.16): the mascot, «لم نجد هذه الصفحة», the header's search field (focused from 1024), home + «مركز الدعم», the four compact platform tiles; status 404 |
| `/sitemap.xml` | `app/routes/api/sitemap.ts` | every public page × ar/en/ckb with hreflang alternates + x-default on PUBLIC_ORIGIN |
| `/robots.txt` | `app/routes/api/robots.ts` | closed unless the store is live on its canonical host |

**The hand-off:** while `store.contact` holds no channel, no content page links to /contact (the footer leaves it out
too — the shell): "contact us" rows become «تحدّث مع موظف» → `HANDOFF_PATH` (`/support/assistant?handoff=1#handoff`,
the support area's form; `content-model.ts`), shown by `components/HandoffCard.tsx` («اكتب لموظف», the mascot on
red-tint, one key). Never «قريباً».

Slugs: `shipping`, `returns`, `warranty`, `payment`, `privacy`, `terms` (`POLICY_SLUGS` in `content-model.ts`, the
client-safe file the service and the pages share). Moving between them is the sideways push in that order
(`handle = { order, group: "policies" }`); everything else fades. Unknown slug → the shell's 404.

## Policies: CMS first, code drafts until the owner approves

`getPolicy(db, locale, slug, { now, storeMode })` → `PolicyView` (CONTRACTS §3). A policy is **approved** when a
`pages` row exists with `kind = "policy"`, that `slug`, `status = "published"` (or `"scheduled"` with `starts_at`
passed), inside `starts_at`/`ends_at`, `is_demo = 0`, and readable Arabic blocks in `body.ar`. Then `source: "cms"`,
`approved: true`, `updatedAt = published_at`. Otherwise the code **draft** is served: `source: "draft"`,
`approved: false`, `noindex: true`. The page's one status line reads this flag (v2 §6.15: «نسخة أولى — قد تتغيّر قبل
الإطلاق.» instead of the old builder's note and the six «مسودة» tags); drafts are noindex and absent from the sitemap.
A draft's «آخر تحديث» (`updatedAt`) is the later of `POLICY_DRAFTS_REVISED_AT` (the drafts' last wording change in
code — move it forward with every draft edit) and the last change to a setting that draft quotes (`DRAFT_SETTINGS`;
override fees too for delivery and terms). Governorates carry no change time, so pausing one changes the text at
once but not the date. A CMS page missing the visitor's language is shown in Arabic
(`textLocale: "ar"`, `lang`/`dir` on the text, a one-line note). The owner may publish more policies under new
slugs: they are served and listed after the six.

**Drafts** are `drafts.*` in the namespace (ar/en/ckb, built into blocks on the server — the browser never gets the
dictionary: `contentMessages()`), filled on every read with live data:
- delivery: `shipping.flat_fee_iqd`; the active governorates by name, never counted (the count is the owner's, v2
  §13 #6 — «لكل المحافظات» is the one wording; «باختصار» adds «التوصيل متوقف مؤقتاً إلى بعض المحافظات» only while one is
  paused); with `shipping.overrides_enabled` each governorate's real fee (`getShippingFee`) as a table; "we confirm
  your order before preparing it" for COD (no call promise), transfer checks, wallet; a preferred time is a
  preference, not a confirmed time; tracking needs ref + mobile number; no SMS yet (no provider);
- returns: `returns.window_days` (0 → "not available"); steps; refund rules of the commerce core (never more than
  paid, transfer refunds carry a reference, cash/wallet, staff review); auto-cancel after `checkout.transfer_proof_hours`;
- warranty: a fact or a question (v2 §9.6, §13 #4), never an invented term: the maker's warranty is in the product's
  specs when it is known (a grey import may carry none in Iraq, so the draft never says it applies to everything);
  used units state their own warranty days; the store's own terms are the owner's to set (STATUS open item 15,
  `products.warranty_months` empty), so the draft asks — «اسألنا عن شروط ضمان المتجر قبل أن تطلب» → the hand-off — and
  neither promises nor denies a store warranty; safety warning;
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

Each draft says plainly what is not decided yet (return conditions, digital codes, return shipping cost,
order-record retention, the message provider, legal clauses) — in the store's voice («ما لم نحدده بعد», «ننشرها هنا عند
تحديدها»), never "awaiting the owner", never guessed. Copy rules (v2 §9), checked by `tests/content.test.ts` in all
three languages: no call promise, no «دورك.», no «قريباً» for contact details, no draft tags or owner talk; glossary
terms «رقم الموبايل», «مركز الدعم», «تحدّث مع موظف», «متجر تجريبي».

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
  https social and map links, address, hours) and `card`: the same in the kit's `<ContactCard>` shape (WhatsApp digits,
  E.164 phone, address + map link, hours in the owner's words — no schedule is stored, so no open/closed state), null
  when there is nothing for the card to draw. Empty (today) → the page leads with «اكتب لموظف». A failed read is the
  shell's error page, never "coming soon".
- `getStoreFacts(db, locale)` → fee (or "depends on the governorate"), payment switches, whether transfers are checked.
- Accessibility claims are limited to what the shell, kit and engine do, as measured; ONE short section states what is
  untested (Chromium on a computer only, no real phones, no screen-reader or high-contrast runs, Sorani unreviewed).
  Touch targets: 44 × 44 on phones (except the demo strip), at least 24 × 24 on larger screens — the shell's footer
  links are 40px tall from 768, so the page does not claim 44 there until they grow.

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

## States (brief §12, v2 §6.17)

Default · first version (draft) vs approved (the status line; «آخر تحديث» on both) · partial (CMS text in Arabic only:
`lang`/`dir` + a one-line note; contact with only some fields: the card draws what exists, e-mail/social as rows) ·
empty (contact without channels → «اكتب لموظف», the red key) · API failure (loader throws → shell error panel;
sitemap 503) · unknown page or policy → the shell's 404 (status 404) · offline (the shell's banner; a navigation
that fails offline → the offline panel, never "500" — owner shell / root) · demo (the shell's strip and chip; the terms
open with «متجر تجريبي») · reduced motion (push → cross-fade; the motion choice applies at once and persists in this
browser). No forms here, so no validation states; nothing needs sign-in; no products, so no sold-out or coming-soon.

## Exports other areas use (keep their signatures)

- `content-model.ts`: `POLICY_SLUGS`, `PolicySlug` (shell `chrome.ts`, admin `settings/policies.server.ts`),
  `HANDOFF_PATH`, `aboutLinks`, the view types.
- `content.server.ts`: `getPolicy`, `listPolicies`, `getPolicyDraftL10n` (admin policies module), `getContactDetails`,
  `contactView`, `getStoreFacts`, `getCmsText`, `getSitemapEntries`, `buildSitemapXml`, `buildRobotsTxt`,
  `robotsIndexable`, `resolvePublicOrigin`, `PRIVACY_COOKIES`, `PRIVACY_STORAGE_DAYS`, `contentMessages`,
  `POLICY_DRAFTS_REVISED_AT`. Additions in v2 are new fields only (`ContactView.card`, a draft's `updatedAt`).

## Integration slots (for the integration pass)

- A NEW shopper cookie or browser-storage key anywhere in the storefront must be added to `PRIVACY_COOKIES` /
  `PRIVACY_STORAGE_DAYS` (purpose string in `drafts.privacy`); the mirrored ones are test-checked against their owners.
- The hand-off (`HANDOFF_PATH`) is the support area's form: if it moves, change the constant.
- When the owner publishes channels (`store.contact`), /contact, /about and /accessibility show the ContactCard by
  themselves; a reply time or an opening schedule (for «مفتوح الآن») needs new settings fields first.
- `getPolicy(db, locale, "returns" | "warranty")` is ready for checkout/product snippets (`approved`, `summary`, facts).
- About door "new" links to `/`; a better landing (all products) can replace it.

## Verify

`npx vitest run tests/content.test.ts` · `node scripts/lint-design.mjs app/routes/storefront/content --strict` ·
`curl localhost:5173/robots.txt` · `curl localhost:5173/sitemap.xml` · the v2 matrix (5 widths × 2 themes in Arabic,
390 / 1440 in English and Sorani) and state shots: the redesign scratchpad `ux/after/P9-content/`.

**Review (2026-11-12, `ux/after/P9-content-review/`, scripts in `work/pages-P9-content-review/`):** fixed — the
hand-off key overflowed its card in the 280px aside at 1024 (and would at 360 in Sorani): stacked cards put the key on
its own row (`.chandoff`), the aside keeps 288px; /about repeated «تحدّث مع موظف» under the hand-off card; the
/contact lead offered a choice that does not exist without channels; the warranty draft invented the store's terms and a
maker's warranty for every product; the accessibility page claimed 44px targets everywhere (footer links are 40 from
768); the platform links' second row covered the bottom 8px of the first (`.cplats` row gap); the sticky list of
policies ignored the offline banner (`--shell-top`). Checks: 154-shot matrix, no overflow; hand-off key inside its card
at 360–1440 × ar/en/ckb; census and focus walk (no stop hidden or without a ring, no contrast failure, no Arabic under
13px); no-JS render; 320px reflow and 200% zoom; reduce-motion and theme switches persist; push between policies with
Back/Forward/reload; the filled contact state rendered by rewriting the single-fetch payload in the browser
(`filled-contact.mjs`, the database untouched).

## The content module on the store (wave G wiring, 2026-11-12; `tests/storefront-wiring.test.ts`)

- **Redirects** (admin 17.04): `findStoreRedirect` before a 404 — the `*` route, an unknown one-segment path (the home route under
  an invalid locale), a missing product, category or landing page — through `redirect.server.ts` (`redirectIfMoved`; the hit
  counted in `waitUntil`; a failed lookup leaves the 404). Whatever the row holds, the target must be a same-site storefront
  path: another host, `javascript:`, `//host`, the admin, the API and reserved paths are refused, and so are a loop on itself and
  a target that is redirected again (one hop, always — a chain is how two rows make a loop).
- **Landing pages** `/pages/:slug` (`landing.tsx`, the CMS's `getLandingPage`): a 720px reading column, «آخر تحديث», the text as
  blocks; the Arabic text with lang/dir when the page has none in the visitor's language; noindex honoured; listed in the
  sitemap when live and not noindex. The description has its own fallback (the page's language, else Arabic, else English):
  `content-model.ts textLangOf` tells it from its letters and the lead gets its lang/dir (review 2026-11-12: the Arabic
  fallback read left-to-right on an English page).
- **Banners:** `getStoreBanners` over the CMS's `getActiveBanners` drops any link the store cannot open (`bannerHref`);
  `components/StoreBanners.tsx` draws them as showcase bands (a platform accent its surface, "brand" the crimson; the link a white
  text link, never a second red key). One column on phones, two from 1024 — a third banner then takes the next row whole
  (it stood at half width beside a hole) — and three from 1280.
- **Navigation:** `getArrangedNav(db, nav, now)` / `arrangeNav` — ready for the shell's loader (cached 30 s per isolate); the shell
  owns that call (requested).
- **ContactCard** now draws the e-mail address and the store's pages elsewhere (`card.email`, `card.links`); the page's own rows
  keep only the map link when there is no address.
