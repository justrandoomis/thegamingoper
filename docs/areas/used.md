# Used area

Owner: used. The used marketplace, the trade-in wizard and its tracking page (brief §3.11, §5, §12, §14 "used device
listing shows real condition evidence; trade-in offer requires inspection/approval"; DESIGN.md §8.3–8.4, §8.10, §9.5,
§9.6, §9.18, §9.20, §9.21, §11). Files: `app/routes/storefront/used/**`, `app/routes/api/upload-tradein.ts` (+ its line in
`app/routes/api/_routes.ts`), `app/server/services/used.server.ts`, `app/server/services/tradein.server.ts`,
`app/i18n/messages/used.ts`, `tests/used.test.ts`, `tests/tradein.test.ts`.

## Routes

| Path | What |
|---|---|
| `/used` | Listed units only, as `UsedUnitCard`s (grade tag, storage · battery · warranty, and always what the picture is). Filters in the URL — platform, model, grade, storage, location (repeatable), `min`/`max` IQD, `warranty` (≥ days), `sort`, `page`: a GET form in the sidebar (≥ 1024) or a side sheet (< 1024) that applies each chip at once, platform link-chips (work without script), removable active-filter chips, `Pagination` (24 a page). Trade-in row link; "how we prepare a used device" with the four grades in words |
| `/used/:slug` | `Gallery evidence="used"` (unlit, every picture labelled), grade tag + legend, platform LED, price + delivery + "قطعة واحدة · ضمان …", the new variant's store price as a plain comparison (only when higher), condition notes, `InspectionCard` (checklist in the template's words, battery or "غير قابلة للقياس", defects with their severity in words, what is included, warranty, return window from `returns.window_days`, ownership and data-wipe checks), other listed units (same platform first). Buy: `AddToCartKey` (`usedUnitId`) in a `TaskBar` on phones/tablets, `BuyControls` in the column from 1024 |
| `/trade-in` | Wizard, one URL per step: device (models with an active model-wide price guide, by platform) → condition (one question per screen: power, body, screen if it has one, accessories from the guide's deductions, accounts) → photos (optional, private) → estimate → inspection (contact + preferred time) |
| `/trade-in/:ref` | Tracking: status in words, estimate or "priced after the inspection", device + description, preferred time (a preference), photo count (private), history, what happens next (staff steps marked upcoming), the final offer when staff made one (accept = the page's one red key; decline confirms first). No `?t=` → lookup by phone |
| `GET/POST /api/upload/tradein` | Draft photos (cookie `tt_tradein`, httpOnly, 2 days): `POST intent=add file` → `{ ok, photo: { id, name, previewUrl }, count, limit }`; `intent=remove fileId`; `GET ?file=` serves the draft's own photo (private, `no-store`, 404 for anyone else); `GET` lists them. Rate-limited per IP (`RATE_LIMITS.upload`) |

Every page: no `<main>` (h1 first), `shellMeta` (unit pages: `og:image` = a real public photo or the product's share
image; the tracking page and wizard steps after the first are `noindex`). Strings: `used` (+ `errors`); this area's error
codes are under `used:errors.*` (`combinedErrorT` on the server, `useErrorText` in the browser) — the only copy: since
2026-11-11 the shared `errors` namespace adopts them by import (`TRADE_IN_ERROR_KEYS`, except `idempotency_conflict`,
which keeps the checkout wording there), so keep `used:errors.*` exactly in step with `TRADE_IN_ERROR_KEYS`
(`tests/commerce-money.test.ts` checks it). Motion: list ↔ unit is
the card's zoom (`used-image:<id>`, the kit's default); wizard steps push sideways in order (`handle.order` from the
query, own `group`), questions too.

## States (brief §12)

| | |
|---|---|
| default · partial | list + filters; filters failing to load → `ErrorState` with retry, the list still shows; other units failing → `ErrorState`, the page still shows |
| loading | the list dims (`aria-busy`, "نحدّث النتائج") while filters apply — no skeleton; keys spin while a form posts; photos show an ink progress bar each |
| empty | nothing listed (`EmptyState` "… دورك." → trade in) · no match (→ show every device) · a page past the end (→ first page) · no devices bought online |
| validation | a question sent without an answer; phone (on blur, again on input, and from the server), ownership box, preferred day; photo type/size/empty per photo |
| API failure | upload failures say why beside the photo with a retry when it can help; removal failure keeps the photo; form-level errors (rate limit, device no longer bought, a reused key) above the key |
| success | the request page opens with "استلمنا طلبك.", where we call, and a copy-link key (no SMS provider: said plainly) |
| pending review | "بانتظار الفحص" on every estimate; the staff steps listed as "لاحقاً" until they happen |
| unauthorized | `/trade-in/:ref` without the link: reference + phone, rate-limited, one answer for a wrong reference or phone |
| refused | a device locked to an account the shopper cannot remove: no request, the way to change the answer |
| reserved / sold unit | status line, no add key, other units; sold answers 410 |
| reduced motion / offline | the engine's fallbacks; the shell's offline banner (uploads fail honestly with retry) |

## Real, demo, boundary

- **Real:** every rule above, the estimate maths, the request, its history, the draft photos (stored privately through the
  upload pipeline), the offer answer (`respondToOffer`) — tested against a local D1.
- **Demo:** the 6 units and 24 price guides are seed data (`is_demo`); the units only have the maker's photo of the model,
  flagged as an illustration, so cards, gallery and inspection card say "صورة توضيحية — ليست صورة الجهاز نفسه" and that no
  real photo exists yet. Requests made while `STORE_MODE=demo` are `is_demo`.
- **Boundary / not built here:** the staff side (confirm the inspection, inspect, ownership and account-lock checks, the final
  offer, payout as store credit or cash, data wipe, listing) is admin module 13 — nothing creates an offer yet, so the offer
  answer only runs in tests. No SMS/WhatsApp provider: the tracking link is shown, not sent. Branch locations: none are
  entered, so the location filter stays hidden (internal warehouse names are never shown). Store credit needs an account,
  so guests can only choose cash.

## Decisions worth knowing

- The estimate is a **range**: the description maps to a span of two grades (like new → A…A+, light marks → B…A, visible →
  C…B; a scratched screen caps it at B…A), priced by the guide, less missing accessories, both ends rounded **down** to
  5,000 IQD, valid `tradein.estimate_valid_days`. Faults or damage → no figure ("inspection"). The figure is recomputed
  on the server when the request is created; the guide snapshot is kept in the `estimated` event.
- `trade_ins` has no idempotency column: the id is derived from the form's one-time key (`tin_` + base32 of sha256), so a
  double submission or a race returns the first request (same phone only). Token = sha256(id, key), only its hash stored.
- A radio group with nothing chosen is `:indeterminate`, which the kit's checkbox rule paints as chosen:
  `RADIO_GROUP_FIX` (components/TradeInParts.tsx) is a scoped workaround until `app/styles/components.css` limits it.

## Cross-area pieces (wired by the integration pass, 2026-11-11)

- `/used/:slug`: the model's hub as a row link (devices area `getDeviceLink` → `DeviceHubLink`, "كل شيء عن {device}";
  the picture grows into the hub's stage, shared element `device-image:<slug>`; no hub → no link) and the accessories
  VERIFIED on the model (`recommendationsFor(…, { context: "device_hub", deviceModelId })`, streamed, only the
  `device_hub:setup:<slug>` shelf — the hub's fallback of new consoles is not what someone buying this unit asked for).
  Strings `unit.hubTitle`, `unit.hubText`. The new product link (`/p/<slug>`) was already there.
- Exported for others: `listUsedUnits`, `getUsedFacets`, `getUsedUnitDetail`, `getOtherUsedUnits`, `parseUsedFilters`
  (used.server); `createTradeIn`, `getTradeInByRef`, `lookupTradeIn`, `respondToOffer`, `listTradeInDevices`,
  `estimateTradeIn`, `purgeStaleTradeInDrafts` (for the retention job), `TRADE_IN_ERROR_KEYS` (tradein.server).

## Verify

`npx vitest run tests/used.test.ts tests/tradein.test.ts` (13 + 23) · scoped typecheck · `node scripts/lint-design.mjs` ·
screenshots in `.shots/used/` (390 and 1440, light and dark, ar/en/ckb) · the scratch flow script (wizard end to end).
Chromium only; the Sorani strings need a native reader.
