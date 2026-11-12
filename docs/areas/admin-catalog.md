# Admin module 02 — Product catalogue

Owner: admin catalogue. Blueprint 02.01–02.10 (docs/admin-blueprint.json), Arabic-first RTL with English. Plugs into
the admin shell (docs/areas/admin-shell.md). Services: `app/server/services/admin/catalog/*`; routes:
`app/routes/admin/catalog/*`; strings: `app/i18n/messages/admin-catalog.ts` (ar source, en, ckb).

## Routes

| Path | What | Permission (loader / action) |
|---|---|---|
| `/admin/catalog` | Product list: search (name, SKU, barcode, model number — a scanned barcode with one match opens its product), status chips (draft · review · scheduled · published · hidden · archived) with counts, platform / category / kind / sort / incomplete filters in the URL (GET form), readiness per product, price range (no price = "—"), stock; bulk field edit and bulk publishing moves; CSV export; `<ModuleFunctions moduleId="02">` | `catalog.product.read` / per intent: `.import`+`.update`, `.update`, `.publish`, `.archive` |
| `/admin/catalog/new` | New draft: kind, name ar/en/ckb, slug, category, platform, brand, first SKU (no price) | `catalog.product.create` |
| `/admin/catalog/products/:id` | Frame: name, status, readiness, publishing actions (confirm + reason + impact), tabs. Index = details: texts ar (required) / en / ckb, kind, slug (locked once live), brand, category, platform, device, store warranty, age rating, region, licence, format, search words, specs by key, custom fields, readiness checklist, prices and stock read-only | `.read` / `.update` (details), workflow per action |
| `…/variants` | SKU variants: platform, colour, capacity, edition, region, condition, model number, barcodes (GS1 check digit; Enter in the field = scanner, moves on), extra barcodes, serial tracking, default; stop/activate with reason. Landed cost and margin only with `cost.read` / `profit.read` | `.read` / `.create`, `.update` |
| `…/media` | Gallery: upload (upload service → public `product_image`), catalogue photo keys (suggested per slug), order, main picture, alt text ×3, variant owner, illustration flag, remove with reason | `.read` / `catalog.media.manage` |
| `…/bundle` | Components per variant (SKU or barcode), qty 1–20, availability per component from `getAvailability`, the limiting one marked | `.read` / `catalog.bundle.manage` |
| `…/related` | Accessories, step-up, alternatives, upgrades, setup; pin, order; products pointing here; compatible accessories suggested | `.read` / `catalog.relation.manage` |
| `…/compatibility` | Rules of the product and its variants | `.read` / `catalog.compatibility.manage` (+ `.verify` for verified) |
| `…/history` | Versions (who, when, why, what), compare with now (`?compare=N`), safe restore; price history read-only | `.read` / `catalog.version.restore` |
| `/admin/catalog/categories` | Tree (≤ 4 levels): add, edit, move, switch off, delete empty | `.read` / `catalog.category.manage` |
| `/admin/catalog/devices`, `/devices/:id` (`new`) | Platforms, generations, device models with spec sheets; tick 2–4 → compare | `.read` / `catalog.platform.manage` |
| `/admin/catalog/compare?m=…&diff=1` | Spec comparison + compatibility across generations | `.read` |
| `/admin/catalog/compatibility` | All rules by device and status (URL filters, paged) | `.read` |
| `/admin/catalog/import`, `/import/:jobId` | CSV preview (dry run) → apply → rollback; recent jobs; exports | `.read` / `catalog.product.import` |
| `/admin/catalog/export?level=products\|variants` | CSV download (audited; cost columns only with `cost.read`/`profit.read`) | `catalog.product.export` |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

02.01 implemented · 02.02 implemented · 02.03 implemented · 02.04 **partial** (no video, no crop/focal hints) ·
02.05 implemented (the 5-minute job `catalog.publish_due` lists due products) · 02.06 implemented · 02.07 implemented · 02.08 implemented ·
02.09 implemented · 02.10 implemented.

## Rules the services enforce

- **Statuses.** Stored: draft, review, scheduled, published, archived. "Hidden" = `draft` with `published_at` set (hiding
  keeps `published_at`, so showing again is not a new arrival). Transitions, permissions, reasons: `rules.ts WORKFLOW`.
- **Completeness (02.03).** Base: Arabic name and description, active category, active variant, a price on every
  active variant (0 = not set, module 03 sets it), a picture. Per kind: console warranty · game compatibility, age
  rating, format · controller/headset/storage/accessory/part compatibility, warranty · digital compatibility, licence,
  region (product or every variant) · bundle components. Plus required custom fields (`custom_fields`, module 22).
  Warranty 0 = "no store warranty"; empty = not decided (owner decision, STATUS item 15). Incomplete → no publish,
  no schedule; a save, a variant edit or switch (off or ON), media removal, rule deletion, component removal, a bulk
  move or a restore never makes a published/scheduled product less complete (`regression`). The last picture, the
  last compatible rule and the last component are checked again INSIDE the batch (two tabs removing the last two at
  once: one wins, the other gets `regression`).
- **New variants of a live product start switched off.** A variant is created with price 0 (module 03 prices it);
  on a published or scheduled product it is saved inactive (never the default), because the cart sells any active
  variant of a live product that has stock — at 0 IQD. Switching it on is refused (`regression`: prices) until it
  has a price.
- **Barcodes: one code, one variant.** A code another variant holds — its own column or the extra codes recorded
  for its SKU (`attributes.variantBarcodes`) — is refused (`barcode_taken`) by the variant editor (checked again in
  the batch), the CSV import (database and file) and the safe restore (codes stay as they are; the rest is
  restored). Receiving, counts, transfers and packing find the variant by the scanned code.
- **One write path** (`common.server.ts commitStatements`): product row guarded by its version (double submit / two
  tabs → `product_changed`), baseline version for seeded products, new `product_versions` snapshot (no cost data),
  audit event with before/after and reason, `search_index` rows LAST in the same batch (listed = published or
  scheduled; otherwise removed). Builder: `search-index.server.ts` (same rows as the seed — tested for all products).
- **Never here:** prices, compare-at prices, costs (module 03), stock (stock core), deleting variants or products
  (versions are append-only; variants are stopped, created-by-import products archived).
- **Permission first.** Every loader and action calls `requireEmployee` with its permission (`catalogRequest`), every
  service `assertCan` — before the input is parsed or the product's version compared (a role without it gets 403,
  never field errors or `product_changed`). Each editor tab loads beside the frame, so each answers 404 for a missing
  product (`answered()` in `catalog.server.ts`), never a logged server error.
- **Categories.** Switching off a category takes it and its whole branch out of the store's menus; with products on
  sale or scheduled under it (`subtreeLive`) it needs a reason (`invalid { reason: reason_required }`, checked again in
  the batch); the page asks for it in a confirmation showing the products, the subcategories and "prices and stock
  unchanged". The reason lands in the audit event.
- **Upload limit.** Gallery uploads and CSV files share `RATE_LIMITS.upload` (20 per 10 minutes) per employee
  (`enforceUploadLimit`, key `upload:employee:<id>`), counted after the permission and before the file is read: 429
  `rate_limited` with `Retry-After`; the forms say what was saved and to wait.
- **Safe restore** brings back texts, facts, category/platform/device (if they still exist), specs, attributes,
  search words, variant titles/options/barcodes — never price, cost, stock, status, SKU, slug, activity, serial
  tracking or removed variants; written as a new version.
- **Compatibility.** One rule per edge; verified needs source + `catalog.compatibility.verify` (verifier recorded);
  partial/incompatible need a note; lowering a rule needs only `.manage`. Most specific rule wins in the comparison.
- **Bundles.** One level: a component is never a bundle, a bundle never a component; availability = min(⌊free/qty⌋).
  Components go only on variants of a product of kind `bundle` (`bundle_kind`) that hold no units, reservations or
  serials of their own (`bundle_stocked`, guard in the batch) — the stock core treats ANY variant with components as
  a bundle and would strand its own units. A bundle with components keeps its kind (`kind_has_components`, editor
  and CSV).
- **Serial tracking** changes only when the variant has no stock, reservation or live serial (guard in the batch).
- **Uploads** go through `uploads.server.ts` (type by bytes, ≤ 8 MB, metadata stripped), stored public; the same
  picture twice (same cleaned-bytes hash) is not added again.
- **CSV.** Exported cells starting with `= + - @`, tab or CR get a leading apostrophe (plain numbers such as a
  negative margin excepted); the import strips it again. Columns `rules.ts CSV_PRODUCT_COLUMNS`; empty cell =
  unchanged, `-` clears; ≤ 200 rows / 1 MB; file stored
  private (`catalog_import`); preview stores row errors in `import_jobs`; apply in chunks of 20 with a guard on
  `applied_rows` (double apply refused); rows whose product changed after the preview are skipped; rollback restores
  each product's previous values as a new version and archives created products, leaving products changed since.
- **Demo mode.** Products created in the admin or by import while `STORE_MODE=demo` are `is_demo`.
- Two-person rules: none required by the blueprint here (publishing is split from editing by permission).

## Defects fixed by the adversarial review (2026-11-11; tests in the "adversarial review" describes)

- A variant added to a live product was active at price 0 (sold at 0 IQD once stock arrived) → starts switched off.
- A variant edit or switch-on could strip a live product's requirement (a code's region, an unpriced variant).
- Components could go on a variant selling its own stock, or on a non-bundle product (stock core would strand units);
  a bundle with components could change kind (editor, CSV).
- One barcode could name two variants (editor, import, restore).
- Bulk-moving live products into a switched-off category stripped them.
- Two tabs could remove a live product's last picture / compatible rule / component (now guarded inside the batch).
- Exports left formula cells starting with "-" live; new variants' serial tracking ignored the kind.
- Uploads (pictures, CSV) had no rate limit (SECURITY §9).
- A category with products in the store could be switched off without a reason or a word of what it does.
- A role without the permission got field errors or `product_changed` instead of 403 (variant save, publishing moves).
- Every editor tab of a missing product logged a server error (`AppError not_found`) beside the frame's 404.
- Field errors already translated by the server were looked up again as keys (console "missing key" per field); an
  empty category on a new product said "check the marked fields" instead of "required".
- UI: the category confirm key and sheet footers truncated at 390; the current section tab off-screen on phones; the
  import list's "open" link out of view on phones; the phone variant card's switch-off key not marked destructive.

## QA fix 2026-11-12: per-language fields keep their own direction

The kit's `TextField` keeps only its `ltr` flag and drops a `dir` it is given, so the one-line per-language fields (name,
short line, search words, a custom field's text, a variant's title, a device's name and summary, the spec sheet) took the
admin's direction: «007 First Light» read «First Light 007» in the Arabic admin, Arabic lines ran left to right in the English
one. `inputDir(dir)` (components/ui.tsx) gives English `ltr` (dir="ltr" from the server) and Arabic/Sorani a right-to-left
class from the first paint plus the attribute once the page runs; `L10nFields` and `SpecsEditor` spread it. The product
name in the editor's h1 and on the list sits in a `<bdi>` (its own order, the page's alignment). Tests: "per-language fields
keep their own direction" in `tests/admin-catalog-routes.test.ts`. The kit's owner is asked to honour `dir` (then the class
and the attribute-setting ref become redundant, harmlessly). The same dropped `dir="ltr"` sat on the English one-line fields
of other modules (channels' branch and sales-channel names, devices' templates and used-unit notes, promotions' flash, rule
and VIP names, the CMS's per-language fields): they now pass the kit's `ltr` flag (and `lang="en"`). Still waiting on the kit:
Arabic and Sorani one-line fields of the CMS in the English admin, and automation's `dir="auto"` rule name.

## Boundaries

- Video and crop/focal hints: the upload service takes JPEG/PNG/WebP only and `media` has no URL, crop or focal
  columns → 02.04 partial; schema change requested.
- Scheduled publishing: product page and cart treat a due `scheduled` product as live; category lists, search and
  menus read `published` only → the 5-minute job `catalog.publish_due` (`publishDueProducts`, app/server/jobs.server.ts since 2026-11-11) lists them within five minutes.
- Barcode scanners: keyboard-wedge input only (list search, variant barcode, bundle component, relation target).
- Store warranty terms: owner decision; until then hardware shows "warranty" as missing.
- Not yet checked: an import ROLLBACK restores the values a live product had before the import without the
  completeness check (only if a category was switched off or a custom field made required in between).
- Validation answers are HTTP 400 by contract, so the browser console logs "Failed to load resource: 400" for them.

## Requests to other owners

- ~~**Lead / jobs:** add job `catalog.publish_due` → `publishDueProducts(db, now)` to the `*/5` schedule in
  `app/server/jobs.server.ts`.~~ Done 2026-11-11.
- **Storefront catalog (listing, search, nav):** treat `scheduled` with `publish_at <= now` as live, like
  `product.server.ts` and `cart.server.ts` do.
- **Data:** `media`: `url` (video), `crop` json and `focal_x`/`focal_y`; optionally a stored `hidden` status.
- **Settings (module 22):** the custom-field editor (`custom_fields`); required fields there already block publishing.

## Verify

```
npx vitest run tests/admin-catalog.test.ts tests/admin-catalog-routes.test.ts   # services + routes
node scripts/lint-design.mjs app/routes/admin/catalog                          # 0 findings
```
Browser: `.shots/admin-catalog/` (every page at 1440/390, light/dark, ar/en in `matrix/`; flows: create → validation
error → save → variant → review; owner publish blocked, hide dialog with impact; cashier 403; import → apply →
rollback). Review pass: `.shots/admin-catalog/review/` (`review-shots.mjs`: 136-shot matrix, dialogs with keyboard
focus, category switch-off, 403/404 per role, the upload limit as staff see it). Chromium (Edge) only.
