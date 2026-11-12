# Used area

Owner: used (Design System v2 stage 3, label P4). The used marketplace, the trade-in wizard and its tracking page
(brief §3.11, §5, §12, §14 "used device listing shows real condition evidence; trade-in offer requires
inspection/approval"; v2 spec §6.8, §6.14, §4.12, §4.24, §9). Files: `app/routes/storefront/used/**` (incl.
`used.css`, `wizard.ts`), `app/routes/api/upload-tradein.ts` (+ its line in `app/routes/api/_routes.ts`),
`app/server/services/used.server.ts`, `app/server/services/tradein.server.ts`, `app/i18n/messages/used.ts`,
`tests/used.test.ts`, `tests/tradein.test.ts`.

## Routes

| Path | Shell | What |
|---|---|---|
| `/used` | store | «مستعمل ومفحوص»: a title row (h1 + how many units + «كل جهاز مفحوص، وله درجة حالة وتقرير فحص»); phones: platform dot chips (links, with counts), a toolbar (live count · «الفلاتر (n)» · «الترتيب») and two sheets (filters: chips for short facets, checkbox rows for models, the price fields + «طبّق», foot «امسح الكل» + the primary «اعرض 3 أجهزة»; sort: 52px rows); from 1024 a 264px sticky sidebar of checkbox rows with counts and the sort select. Results are **used rows** (`UsedUnitCard layout="row"`: 96px well, name, grade badge, battery · warranty · storage, price, «صورة توضيحية» when the picture is not the unit, «اعرض تقرير الفحص»; two columns of rows from 1024 as §4.12 says — at 1024–1279 each row stacks its link under the text, see `used.css`). Below 1024, once the toolbar has scrolled away, «الفلاتر \| الترتيب» floats above the tab bar as a solid paper pill (§6.3; gone again near the top; the scroll padding grows by it). Pages accumulate (`?page=2` shows the first 48) with the kit's `ShowMore`. Then the trade-in `EntryCard` and «كيف نجهّز الجهاز المستعمل» (three facts + the four grades in words). Filters in the URL: platform, model, grade, storage, location (repeatable), `min`/`max` IQD, `warranty` (≥ days), `sort`, `page` |
| `/used/:slug` | store, `tabBar: false` | The product template for one unit: the kit `Gallery evidence="used"` (full bleed below 768; the illustration line under the stage), platform label, h1, the variant line only when it adds to the name, the grade badge + legend + its hint, `PriceTag size="page"` (price xl + «سعر ومخزون تجريبيان» in demo mode, «● متوفر · التوصيل 5,000 د.ع لكل المحافظات», «قطعة واحدة · ضمان …»), «سعره جديداً في المتجر …» + the new product's page, condition notes; `BuyControls` from 1024; then the `InspectionCard`, a facts card (payment methods that are on, guest checkout, returns + policy link), the model's hub (`DeviceHubLink`), accessories verified on the model (`RecommendationShelves`), other units (`ShelfRail` of grid cards). Phones/tablets: a `<TaskBar>` with the kit's `.buybar` anatomy [price + «A+ · كالجديد» \| «أضف إلى السلة»]; after the add «✓ في السلة» + «عرض السلة (n)». Keyboard focus on a card of the other-units rail scrolls that card to the rail's start (the kit rail's mandatory snap left every other card ~80% off-screen — see Requests) |
| `/trade-in` | **task** (`chrome: "task"`) | The wizard, one URL per step (Back, reload, shared links, no-script GET forms): الجهاز → الحالة → الصور → التقدير → الفحص. Step rail (`ProgressSteps`); one centred 720px column, from 1280 a 340px sticky aside (device, answers so far with edit links, the estimate, «بعد إرسال الطلب», `ContactCard` or «تحدّث مع موظف»). Keys: «رجوع» \| the step's primary (grows) in a `<TaskBar>` below 1024 — «تابع» as §5.7 says, «أرسل الطلب» on the last step (the step names ran off phone screens in English and Sorani) — and under the column from 1024 with the full names («تابع إلى التقدير», «تابع إلى حجز الفحص», «أرسل طلب الاستبدال»); they spin while the next step loads. Step 1: h1 «استبدل جهازك», the journey «قدّر السعر ← افحص الجهاز ← استلم رصيداً أو نقداً», a device search (client filter as you type; `?q=` on the server without script), device tiles with «حتى 350,000 د.ع · تقديري». Questions: the question is the screen's h1 inside the legend, «السؤال 1 من 5», `OptionCard`s with a line of explanation, «اختر إجابة واحدة للمتابعة.» (with script it shows without a round trip and focus goes to the first option). Before a question's form moves on, the page rewrites its own history entry to "this question with this answer" (`answeredQuestionSearch`), so the browser's Back shows the choice made. Photos: the kit's proof drop area pattern. Estimate: the range (price lg) under «سعر تقديري», «● بانتظار الفحص», «صالح حتى 19/11/2026», the grade span, the deduction reasons, how the money is paid. Inspection: contact (رقم الموبايل, name), the period `PreferencePicker` (no day cells: the owner has not set days), notes, the ownership box, the error summary, the demo line; the address only when the store configured one |
| `/trade-in/:ref` | store | Tracking: h1, the reference (type-code) and status in words (+ «طلب تجريبي»); «استلمنا طلبك» + copy link just after sending; **the final offer with what the inspection found** (grade + legend, «بنود الفحص السليمة: 11 من 12» and the checks that found a problem by name, every line behind «كل بنود الفحص (12)», what was handed over) and, while open and opened with the link or by its account, the payout `OptionCard`s + «اقبل العرض» (the view's one primary) / «ارفض العرض» (confirm dialog; after either answer focus goes to the offer's heading); an open offer past its date reads «انتهت صلاحية العرض» with «لطلب عرض جديد: تحدّث مع موظف» even before the daily job closes it; the estimate; device + answers; the inspection time the store set (its own card) and the preferred time; «ما الذي يحدث بعد ذلك»; history. Without the link: the lookup card (`components/TradeInLookup.tsx`), reference + phone, one sentence for a wrong reference or phone |
| `GET/POST /api/upload/tradein` | — | Draft photos (cookie `tt_tradein`, httpOnly, 2 days): `POST intent=add file` → `{ ok, photo: { id, name, previewUrl }, count, limit }`; `intent=remove fileId`; `GET ?file=` serves the draft's own photo (private, `no-store`, 404 for anyone else); `GET` lists them. Rate-limited per IP |

Every page: no `<main>` (h1 first), `shellMeta` (the list's canonical is `/used` whatever the filters; unit pages: `og:image` = a real public photo or the product's share image; the tracking page and wizard steps after the first are `noindex`). Page CSS: `used.css` (components layer; placement-only rules in the utilities layer for the row card in narrow columns and for the wizard's five-step rail on phones, which overflowed — see Requests). Strings: `used` (+ `errors`). Motion: list ↔ unit is the card's zoom (`used-image:<id>`); rows that arrive after the first paint (other filters, «اعرض المزيد») bubble in; wizard steps push sideways in order (`handle.order` from the query, own `group`), questions too.

## States (spec §6.17)

| | |
|---|---|
| loading | the list dims (`aria-busy`, «نحدّث النتائج») while filters apply, new rows bubble in — no skeleton; wizard keys spin while the next step loads (and the shell's progress bar runs); photos show an ink bar and % each |
| empty | nothing listed («لا أجهزة مستعملة معروضة الآن» → «استبدل جهازك» + «تسوّق الأجهزة الجديدة») · no match («لا أجهزة بهذه الفلاتر» → «امسح الفلاتر») · a device search without a match · no devices bought online |
| validation | a question sent without an answer (client first, the server without script); phone (on blur, again on input, from the server) and the ownership box with the `FormErrorSummary` and focus on the first invalid field — the server reports every contact field at once too (an unreadable phone together with a missing ownership box); photo type/size/empty per photo |
| API failure | upload failures say why beside the photo (danger callout) with a retry when it can help; removal failure keeps the photo; form-level errors (rate limit, device no longer bought, a reused key) above the keys; filters or other units failing → `ErrorState` with retry, the page still shows; an add to cart that fails rolls back with a sentence (kit) |
| offline | the shell's banner (form copy on the wizard); on `/used` the filters, chips, sort, the pill and «امسح الكل» are disabled with «لا يوجد اتصال. تعمل الفلاتر والترتيب حين يعود.» under the toolbar (the list stays); the wizard's «رجوع» \| «تابع» / «أرسل الطلب», the unit's «أضف إلى السلة», the offer's «اقبل العرض» / «ارفض العرض» and the lookup's «اعرض الطلب» go flat with the reason beside them (wifi-slash + one sentence) and their forms do not submit (Enter included) — before the review a submit offline replaced the page with the bare error page and lost what was typed; uploads fail beside the photo with a retry that works once back online |
| success | the request page opens with «استلمنا طلبك.», where the inspection time will show, and a copy-link key (no SMS provider: said plainly); after adding a unit, «✓ في السلة» + «عرض السلة (n)» |
| pending review | «بانتظار الفحص» on every estimate until the device is inspected (after that the tracking page shows only «التقدير المبدئي» and its range beside the offer); the staff steps listed as «لاحقاً» until they happen |
| unauthorized | `/trade-in/:ref` without the link: reference + phone, rate-limited, one answer for a wrong reference or phone (a 200 with the sentence) |
| sold / reserved | status callout, no add key, «شاهد أجهزة أخرى» → the other units; sold answers 410 (both rendered in `tests/used.test.ts`: no seeded unit is reserved or sold) |
| demo | units and guides are seed data: «صورة توضيحية» on every illustration, «سعر ومخزون تجريبيان» beside the unit's price, «طلب تجريبي» on a demo request, the demo line on the contact step |

## Real, demo, boundary

- **Real:** every rule above, the estimate maths, the request, its history, the draft photos (stored privately), the offer
  answer (`respondToOffer`) and the inspection result beside the offer (admin module 13 writes the `offered` event and the
  inspection; the tracking page reads them) — tested against a local D1, and walked in the browser end to end.
- **Demo:** the 6 seeded units and 24 price guides (`is_demo`); the units only have the maker's photo of the model, flagged
  as an illustration. Requests made while `STORE_MODE=demo` are `is_demo`.
- **Boundary:** no SMS/WhatsApp provider (the tracking link is shown, not sent); no branches entered (the location filter
  stays hidden); store credit needs an account (guests can only choose cash); the inspection place shows only when the
  owner fills `store.contact.address`; preferred days are not offered until the owner configures days (period only).

## Decisions worth knowing

- The estimate is a **range** (grade span × guide multipliers − missing accessories, both ends rounded down to 5,000 IQD,
  valid `tradein.estimate_valid_days`). Faults or damage → no figure. The device tile's «حتى …» (`TradeInDevice.upToIqd`) is
  the top of that range for the best description — the one guide figure that leaves the server, and the same the wizard
  shows for those answers.
- The tracking page's inspection result (`TradeInView.inspection`) is the newest `offered` event's snapshot (grade, passed,
  failed, included) plus the recorded checklist lines in the template's words, kept only when their pass/fail counts are
  the snapshot's. Never the inspector's notes, the serial, who inspected, the guide or the offer's internal reason.
- `trade_ins` has no idempotency column: the id is derived from the form's one-time key; token = sha256(id, key), only its
  hash stored.
- Amounts inside sentences use the first-strong isolate (U+2068): a left-to-right isolate (U+2066) puts «د.ع» before the
  figure in Arabic (measured). References, grades and phone numbers use U+2066; photo file names in upload messages U+2068.
- The wizard's aside starts at 1280 (`2xl`), not the 1200 of §6.14: §5.6 keeps `xl` (1200) for the admin.
- `TradeInView.status` is the status as the shopper sees it: an `offered` row whose offer is past its date reads
  `expired` (as the admin shows it) until the daily `expireTradeInOffers` job writes the row; `canRespond` is false.

## Exports others use (signatures kept)

`listUsedUnits`, `getUsedFacets`, `getUsedUnitDetail`, `getOtherUsedUnits`, `parseUsedFilters`, `activeFilterCount`,
`USED_PAGE_SIZE`, `MAX_USED_PAGE_SIZE` (now 240) (used.server); `createTradeIn`, `getTradeInByRef`, `lookupTradeIn`,
`respondToOffer`, `listTradeInDevices`, `getTradeInDevice`, `estimateTradeIn`, `normalizeTradeInRef`,
`purgeStaleTradeInDrafts`, `TRADE_IN_ERROR_KEYS`, `TRADE_IN_DRAFT_*` (tradein.server). Added, optional for readers:
`TradeInDevice.upToIqd`, `TradeInView.inspection`, `bestCaseIqd`, `TradeInInspectionView`.

## Verify

`npx vitest run tests/used.test.ts tests/tradein.test.ts` (15 + 28) · `npm run typecheck` · `node scripts/lint-design.mjs
app/routes/storefront/used app/i18n/messages/used.ts` · review (2026-11-12, scratch `after/P4-used-review/` and
`work/pages-P4-used-review/`): a 154-shot matrix (11 screens × 360–1440 × light/dark in Arabic, 390/1440 in English and
Sorani) measured for overflow by the screenshot's own width (a phone viewport widens `innerWidth` to the content, which
is how the step rail's 400px page slipped through), the offline script, the flow with Back, the no-script run, the focus
walk and the rail-focus check · earlier, by the builder, in the stage-3 scratch folders (P4-used):
the matrix (360–1440 × light/dark × ar, 390/1440 en/ckb), the end-to-end flow (wizard with a real photo upload, estimate,
contact errors, creation, lookup with a wrong and the right phone), offered requests made through the admin services
(grade, checklist, accept with cash, decline through the dialog), the offline states (upload fails and retries, filters
wait), the census (focus walk: every stop shows its ring; one stop off-screen — a card of the «أجهزة مستعملة أخرى» rail
that keyboard focus does not scroll into view, kit Rail/UsedUnitCard; contrast; targets — the small ones left are the
shell's header/footer links) and a probe (one primary per view, Arabic under 13px only in tags). Chromium
only; the Sorani strings need a native reader.
