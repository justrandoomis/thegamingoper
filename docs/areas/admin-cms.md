# Admin 17 — Content & storefront experience (`/admin/cms/…`)

Owner: admin content module. Blueprint module 17 (17.01–17.06) and the two STATUS §4 asks: approving the policy pages
and pinning the home hero. The folder, the permission group and the URL are `cms` (the gate maps `/admin/<group>`).
Services `app/server/services/admin/cms/*` (`rules.ts` is client-safe), strings `admin-cms`, tests
`tests/admin-cms*.test.ts`. Arabic first; every content text has ar/en/ckb fields (Arabic required).

## Routes

| Path | What | Loader permission |
|---|---|---|
| `/admin/cms` | What waits (policies still code drafts, page drafts, waiting pin changes, a menu draft), live figures (demo rows never count), the next 14 days, `<ModuleFunctions moduleId="17">` | any `cms.*` |
| `/admin/cms/home` | Home sections: order, shown/hidden (the privacy panel «اجعل طمطم لك» is locked shown), phone schematic; pinned heroes list | `cms.home.manage` |
| `/admin/cms/home/pins/:pinId` (`new`) | Platform + catalogue product (search, readiness), headline/deck ar/en/ckb, period (Iraq time, ≤ 120 days), live preview, publish / waiting changes / stop, signed preview link | `cms.home.manage` |
| `/admin/cms/banners` · `/:bannerId` (`new`) | Views (live, scheduled, drafts, ended, archived), placement, search; editor: placement (home strip, every category, one category by id, cart), words, catalogue photo picker, link, accent, order, period; publish now / schedule / take off / archive / restore | `cms.banner.manage` |
| `/admin/cms/pages` · `/:slug` | The six policies (returns, warranty → Settings), about, contact, landing pages (create by slug); editor: draft from the approved text or (policies) the code, title, text as lines, SEO description, noindex; approve = publish, schedule (not live only), withdraw/archive, discard; preview | `cms.page.manage` or `cms.page.publish` |
| `/admin/cms/schedule` | Campaigns and releases by Iraq day: banner/page/pin starts and ends, scheduled products, pre-order releases, variant release days; problems named | any of banner/home/page permissions (catalogue dates with `catalog.product.read`) |
| `/admin/cms/navigation` | Menu arrangement (order, hide, feature ≤ 3 per list) draft → publish; listing filter groups: default or a category's own, back to default | `cms.navigation.manage` |
| `/admin/cms/search` · `/search/zero` | Synonym sets (normalised; merges reported; on/off), try a query on the live search; searches with no results (7/30/90 days) with suggestions and one-click "add as synonym" | `cms.search.manage` |
| `/admin/cms/seo` · `/seo/:type/:id` | What search engines get for every product, category and page, issues as filters; product/category editor with phone/desktop result snippets | `cms.seo.manage` |
| `/admin/cms/redirects` | 301/302 redirects, bulk on/off, hits, target state | `cms.redirect.manage` |
| `/admin/cms/preview/:token` | Signed preview (17.06), phone/desktop, ar/en/ckb, stale notice | the kind's permission |

## Functions → status (`blueprint-status.ts`)

| Id | Status | What is missing |
|---|---|---|
| 17.01 | partial | Policies/about/contact are live now; banners, landing pages, home layout and hero pins wait for the storefront to read them |
| 17.02 | partial | Scheduling and the calendar work; what is scheduled reaches the store with 17.01's reads |
| 17.03 | partial | Synonyms are live; the menu arrangement and filters are not read by the storefront yet |
| 17.04 | partial | Product and page SEO live; category SEO not read by the category page; `resolveRedirect` not called yet |
| 17.05 | implemented | Spelling-based suggestions; no AI model (boundary, said on the page) |
| 17.06 | partial | Pages use the store's own renderer; banners and pins use the kit's bands until their slots exist |

## Rules

- **Content never changes a product's status** and never puts forward a product the catalogue would not show
  (`productReadiness`): published with an active variant, or scheduled by the item's start AND complete by the
  catalogue's rules (the publish job sends incomplete ones back to draft). Pins and banners linking to `/p/<slug>` are
  checked at publish, scheduling and every save of a running banner; the storefront reads re-check at read time.
- **Pins**: one published pin per platform per moment — overlap refused in JS and by an `expectThat` guard in the
  batch (two people publishing at once: one wins); the product must be for that platform (the catalogue's
  researched-platform rule) and have a photo; changes to a published pin wait in `draft_config` — stopping the pin
  keeps them as the draft's values.
- **Pages**: the draft (blocks per language + title + SEO words as extra JSON keys) never reaches `body` before
  approval; scheduling is refused while the page is live (`page_live_schedule`); only a landing page may end (approve
  and schedule both refuse an end for a policy, about or contact); a draft starts from the approved text (a policy:
  `from: "approved"`, or the code's draft) — also after a withdrawal; demo pages are never served; returns/warranty →
  module 22. Text uses module 22's line syntax (`settings/policy-text.ts`), never HTML.
- **Banners**: a scheduled banner keeps a start (a start-less one would never run; `liveStateOf` calls it a draft).
- **Redirects**: locale-less, lower case, no trailing slash, one language prefix at most; never from/to `/admin`,
  `/api`, assets or crawler files, never from `/`; no loop, no chain (target not itself redirected, nobody pointing at
  the source) — rules + batch guards; internal targets must open something live; switched off, never deleted. A full
  address of the store itself (`STORE_HOSTS`, or the request's origin passed as `origins`) is the path it names
  (`ownStorePath`), for redirects and banner links alike — so it meets every one of these rules.
- **Lists**: each filter chip counts what the other filters keep — its count is the list it opens; `stored` says
  whether anything exists at all (the empty state). The calendar marks a draft banner's or pin's dates `draft` and a
  demo row `demo` (the storefront never shows it).
- **Navigation** stores entries by id (`platform:<id>`, `category:<id>`, the entity rule); names and links are only a
  snapshot; new catalogue entries appear at the end on their own.
- **Search**: synonyms stored with the index's `normalizeSearchText`; `search_index` is never written here; cache
  invalidated in this isolate, others within `VOCAB_TTL_MS` (said on the page).
- **SEO**: products through the catalogue's `commitStatements` (version guard, version row, audit, search rows last);
  categories guarded on the stored SEO text; noindex needs a reason.
- Every write: POST, zod (Arabic-Indic digits read), a stale-form guard (`content_changed`), an audit event
  (`cms.*`, reason where the store changes), confirm-with-reason dialogs for publishing, withdrawing, stopping,
  switching off. No money, stock or cost data anywhere in the module (tested).

## Storefront reads (for the integration after the redesign)

| Read | Call it from | Notes |
|---|---|---|
| `getHomeHero(db, now)` → `{ pinId, platform, productId, headline, deck }[]` | home loader (`home.server.getHomeData`) | per platform: use the pin when its card is buyable with a photo, else `pickHero` |
| `getHomeLayout(db)` → section kinds in order | home page | the hero stays first; `personal` always included |
| `getActiveBanners(db, locale, placement, { now, categoryId?, includeDemo? })` | home (`home_strip`), category hub (`category_top` + its id), cart (`cart`) | ≤ 3, non-demo by default, dead product links dropped |
| `getLandingPage(db, locale, slug, now)` | a new route `/pages/:slug` (`LANDING_PATH_PREFIX`) | `<Blocks>`; `noindex`; null → 404 |
| `getNavArrangement(db)` + `arrangeBySlug` (rules.ts) | shell, after `getNavTaxonomy` | `featured` flag for styling |
| `getListingFilterOrder(db, categoryId)` | catalog listing | groups to offer, in order |
| `resolveRedirect(db, path)` + `recordRedirectHit` | the `*` 404 route and product/category loaders before their 404 | `throw redirect(localePath(hit.to, locale), hit.code)` (external `to` as is); hit via `waitUntil` |
| categories' `seo` | category page meta | title/description/noindex |

Policies and about/contact need nothing: `getPolicy` / `getCmsText` already read the approved rows.

## Verify

```
npx vitest run tests/admin-cms.test.ts tests/admin-cms-routes.test.ts tests/admin-cms-review.test.ts   # 29 + 21 + 15
node scripts/lint-design.mjs app/routes/admin/cms                      # 0 findings
```

Demo records (`is_demo`): `.shots/admin-cms/seed-cms.ts` (run through `vitest.seed.config.ts`: the services need
Vite); the review's withdrawn demo landing page: `.shots/admin-cms/review/seed-review.ts`. Screenshots
`.shots/admin-cms/` (390/1440, light/dark, ar/en; empty, filled, validation, dialogs, 403) and `.shots/admin-cms/review/`.

## Review 2026-11-12 (adversarial pass; `tests/admin-cms-review.test.ts`, each failed before its fix)

Fixed: a full address of the store (`https://tamtamgames.com/admin/…`, `…/a` ⇄ `…/b`) went around the redirect and
link rules (admin targets, endless loops); «/ckb/en/admin» read as «/en/admin»; switching a redirect off a moment after
someone else did wrote a second audit event; chip counts ignored the other filters (banners, redirects, synonyms, SEO);
a scheduled banner could lose its start yet be called live; a policy could be scheduled with an end; a withdrawn page's
text and an approved policy's edits were lost on the next draft (the editor promised «start from the approved text»);
stopping a pin dropped its waiting changes; the module's home counted a pin whose product had left the store; the
calendar said «starts» for drafts and showed demo rows unmarked; landing slugs refused Arabic-Indic digits; a stale `?filters=` or `?edit=` link
answered 404 for the whole page.

## Not done / limits

- The storefront reads listed above (the redesign team wires them); landing pages have no storefront route yet.
- Policy approval is one person with `cms.page.publish` (the content role has it), as in module 22 — the writer of a
  draft may approve it; whether only the owner (or a second person) may approve legal texts is an owner decision.
- A published demo pin still blocks a real pin of its platform in its window (the overlap rule counts it, the
  storefront read leaves it out): stop the demo pin first.
- `getActiveBanners` drops a banner whose product link died; a link to a category or platform switched off later is
  checked only at publish and save (the editor shows the link's state).
- Banners take catalogue photos only (no upload); no A/B tests or campaign grouping (no campaign table in `cms`).
- Suggested synonyms are spelling-based (no AI model configured). Sorani strings need a native reader.

## Module follow-up 2026-11-12

Hero pins overlap only with pins of the same kind (demo with demo, real with real — the store never shows a demo pin). `getActiveBanners` re-checks every catalogue link as it serves it — product, category, platform, device page, and a category link's `?platform=` filter.

Tests (each failed before its change): `tests/admin-cms-followup.test.ts`.

Review of the follow-up (2026-11-12): `checkStoreLink` applies the same platform-filter rule when a banner is saved live or published (and for redirects and tracked links): a category link whose `?platform=` names no platform, or one switched off, is `missing` / `not_live` (`link_missing`) — before, such a banner was published and then never served. Test: `tests/admin-cms-followup.test.ts` ("never published with a platform filter the store would drop").
