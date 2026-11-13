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
| `/used` | store | «المستعمل والمفحوص» (the glossary's title — round-1 fixes; it said «مستعمل ومفحوص»): a title row (h1 + how many units + «كل جهاز مفحوص، وله درجة حالة وتقرير فحص»); phones: platform dot chips (links, with counts), a toolbar (live count · «الفلاتر (n)» · «الترتيب») and two sheets (filters: chips for short facets, checkbox rows for models, the price fields + «طبّق», foot «امسح الكل» + the primary «اعرض 3 أجهزة»; sort: 52px rows); from 1024 a 264px sticky sidebar of checkbox rows with counts and the sort select. Results are **used rows** (`UsedUnitCard layout="row"`: 96px well, name, grade badge, battery · warranty · storage, price, «صورة توضيحية» when the picture is not the unit, «اعرض تقرير الفحص»; two columns of rows from 1024 as §4.12 says — at 1024–1279 each row stacks its link under the text, see `used.css`). Below 1024, once the toolbar has scrolled away, «الفلاتر \| الترتيب» floats above the tab bar as a solid paper pill (§6.3; gone again near the top; the scroll padding grows by it). Pages accumulate (`?page=2` shows the first 48) with the kit's `ShowMore`. Then the trade-in `EntryCard` and «كيف نجهّز الجهاز المستعمل» (three facts + the four grades in words). Filters in the URL: platform, model, grade, storage, location (repeatable), `min`/`max` IQD, `warranty` (≥ days), `sort`, `page` |
| `/used/:slug` | store, `tabBar: false` | The product template for one unit: the stage as the product page's soft card (round-1 fixes: `.used-stage` — edge to edge under the header on phones with its lower corners round, every corner from 768, the platform's ambient light in the stage's own ground, the round clay back · share keys over it below 1024 beside the kit's full-screen key), then the kit's breadcrumb bar (`Breadcrumbs phone`, v2.1 — the before's bar above the name, client note 5; after the stage on phones and at the top of the buy box from 1024, as on the product page), the kit `Gallery evidence="used"` (full bleed below 768; the illustration line under the stage; from 1024 the platform's ambient light behind it — `.glow-layer`, kept inside the gutter), the brand line (`PlatformLabel bar`: the platform's colour line and name right above the name, v2.1), h1 (a spaced dash bound to the word before it), the variant line — only what the variant adds to the name («أبيض»; `variantLine`) —, the grade badge + legend + its hint, `PriceTag size="page"` (price xl + «سعر ومخزون تجريبيان» in demo mode, «● متوفر · التوصيل 5,000 د.ع لكل المحافظات», «قطعة واحدة · ضمان …»), «سعره جديداً في المتجر …» + the new product's page, condition notes; `BuyControls` from 1024; then the `InspectionCard`, a facts card (payment methods that are on, guest checkout, returns + policy link), the model's hub (`DeviceHubLink`), accessories verified on the model (`RecommendationShelves`), other units (`ShelfRail` of grid cards) — the hub link and the other units fade up as they arrive (`revealProps`). Phones/tablets: a `<TaskBar>` with the kit's `.buybar` anatomy [price + «A+ · كالجديد» \| «أضف إلى السلة»]; after the add «✓ في السلة» + «عرض السلة (n)» |
| `/trade-in` | **task** (`chrome: "task"`) | The wizard, one URL per step (Back, reload, shared links, no-script GET forms): الجهاز → الحالة → الصور → التقدير → الفحص. **The before's labelled rail** (v2.1, client note 10): five numbered discs, each step's word under its disc on every width (`ProgressSteps` + `.used-rail` in `used.css`, placement only — see Requests). One centred 720px column, from 1280 a 340px sticky aside (steps: device, answers so far with edit links, the estimate, «بعد إرسال الطلب», `ContactCard` or «تحدّث مع موظف»; the start: the track card). Keys: «رجوع» \| the step's primary (grows) in a `<TaskBar>` below 1024 — «تابع» as §5.7 says, «أرسل الطلب» on the last step — and under the column from 1024 with the full names; they spin while the next step loads. **Step 1 is the start page, in the before's order** (client note 10: the before wins, v2's search kept): h1 «استبدل جهازك» and the before's line («اعرف سعراً تقديرياً لجهازك الآن…»), «أرسلت طلب استبدال من قبل؟ تتبّع طلبك» (to the track card), the labelled rail, «أي جهاز تريد استبداله؟» with the device search (client filter as you type; `?q=` on the server without script; Arabic and Sorani spellings — «بلايستيشن», «اكس بوكس», «سويتش 2», «ستيم ديك», «روغ», a word still being typed — read as the catalogue's names through the support matcher's `nameTerms`, round-1 fixes), the device tiles **three to a row on phones from 375** (two below it, four from 768) under each platform's colour line (`PlatformLabel bar`), the name balanced on two lines (13/600 in a third of a phone, a model's short tokens bound: «PlayStation 5» / «Slim»), a bracketed qualifier on its own meta line, «حتى 350,000 د.ع» on ONE line at the tile's foot (the feet of a row align; the amount an isolated run in its weight) — the section's line says once that the amounts are estimates (`tradein.device.upToNote`), each tile says it to screen readers; then what v2.1 adds: «جهازك غير موجود في القائمة؟» as a `Note` with «تحدّث مع موظف»; «كيف يعمل الاستبدال» — a three-step icon strip (raised clay discs with red line icons, numbered, joined by a line); «ما الذي يغيّر السعر؟» — the estimate's own rules as a `FactList` (التشغيل · الهيكل والشاشة · الملحقات · الحسابات · العلبة الأصلية «لا تدخل في التقدير»: words only, the guide's figures never leave the server); «أسئلة شائعة» — seven answers in an exclusive `Accordion` (the estimate's validity is the store's `tradein.estimate_valid_days`, never a number in the copy); the track card (`components/TradeInTrack.tsx`, below). Questions: the question is the screen's h1 inside the legend, «السؤال 1 من 5», raised `OptionCard`s (`surface`) with a line of explanation, «اختر إجابة واحدة للمتابعة.» (with script it shows without a round trip and focus goes to the first option). Before a question's form moves on, the page rewrites its own history entry to "this question with this answer" (`answeredQuestionSearch`), so the browser's Back shows the choice made. Photos: the kit's proof drop area pattern (a raised clay disc with the camera). **Estimate**: frosted glass over the brand's ambient light (`.glow` + `.surface--glass`) — the range (price lg) under «سعر تقديري», «● بانتظار الفحص», «صالح حتى 19/11/2026» as a pill, the note as a quiet `Note variant="line"`, the grade span, the deduction reasons, how the money is paid. Inspection: contact (رقم الموبايل, name), the period `PreferencePicker` (no day cells: the owner has not set days), notes, the ownership box, the error summary, the demo line; the address only when the store configured one |
| `/trade-in/:ref` | store, `tabBar: false` | **The request's page (v2.1, client note 12 — the new trade-in offer screen):** h1, the reference (type-code) and status in words (+ «طلب تجريبي»); just after sending, «استلمنا طلبك» with the kit's `SuccessMark` (the check draws itself) + copy link. **The final offer on the wallet band** (the reference's red card; deep crimson glass in dark): «العرض النهائي», the amount counting up once (`CountUp` inside the price's own classes — a server-rendered first screen shows it final, no flash), «اعتمد موظف هذا السعر بعد فحص جهازك.», «كان التقدير المبدئي من … إلى …», the validity as a pill; a raised clay disc with the hand-coins icon. **What the inspection found, before the answer**: the grade badge + legend + its hint, the result in one line, every checklist line with its icon (the ones that found a problem first; two columns from 768) arriving one after another (`revealProps({ stagger })`) — below 768 the problems in sight and the whole list in a `Disclosure` «كل بنود الفحص (11)» (review 2026-11-13) —, what was handed over. **The answer** while open and opened with the link or by its account: «كيف تستلم المبلغ؟» as raised option cards each with its clay icon disc (wallet · cash; credit disabled with the reason for a guest's request), accepting without a payout is said at the cards before anything is sent (focus on the first card); «اقبل العرض» (the view's one red primary) / «ارفض العرض» (confirm dialog) in the page's task bar below 1024 (short words: «اقبل العرض» / «ارفض»; the tab bar gives way); from 1024 the answer card heads the request's column beside the offer band, the keys whole-width with the primary on top (round-1 fixes: «اقبل العرض» sat at y≈1276 under the checklist at 1440). Answered: the outcome first («قبلت العرض» with the drawn check + the payout chosen, or the declined note), the inspection after it; an offer opened without its link says how to answer; an open offer past its date reads «انتهت صلاحية العرض» with «لطلب عرض جديد: تحدّث مع موظف». Without an offer: the estimate (the glass card above). **One timeline** «مسار الطلب» instead of v2's «ما الذي يحدث بعد ذلك» + «سجل الطلب»: received (+ the first estimate), the appointment (+ the time the store set), the inspection (+ the grade), the offer (+ the amount), the shopper's turn («بانتظار ردك»), the payout — each done step with when it happened, the current one marked (`aria-current="step"`), a declined / expired / cancelled request ending where it ended. Then the device + answers + photo count, «الفحص» (the time the store set, the preferred time — a preference, never an appointment). Phones: offer → timeline → device → inspection time → links (the desktop columns step aside: `contents` + `order`). Without the link: the lookup card (`components/TradeInLookup.tsx`), reference + phone, one sentence for a wrong reference or phone (the phone as typed kept, focus on it), «تتبّع طلباً برقم آخر» back to the start page's track card; the start page's track card posts here too. Offline: the form's words (`offline: "form"`) |
| `GET/POST /api/upload/tradein` | — | Draft photos (cookie `tt_tradein`, httpOnly, 2 days): `POST intent=add file` → `{ ok, photo: { id, name, previewUrl }, count, limit }`; `intent=remove fileId`; `GET ?file=` serves the draft's own photo (private, `no-store`, 404 for anyone else); `GET` lists them. Rate-limited per IP |

Every page: no `<main>` (h1 first), `shellMeta` (the list's canonical is `/used` whatever the filters; unit pages: `og:image` = a real public photo or the product's share image; the tracking page and wizard steps after the first are `noindex`). Page CSS: `used.css` (components layer, tokens only; v2.1: one placement-only block in the utilities layer — `.used-rail`, the before's labelled rail: it out-weighs the kit's `max-md:sr-only` on the step words; see Requests). Strings: `used` (+ `errors`). Motion: list ↔ unit is the card's zoom (`used-image:<id>`); rows that arrive after the first paint (other filters, «اعرض المزيد») bubble in; wizard steps push sideways in order (`handle.order` from the query, own `group`), questions too.

## States (spec §6.17)

| | |
|---|---|
| loading | the list dims (`aria-busy`, «نحدّث النتائج») while filters apply, new rows bubble in — no skeleton; wizard keys spin while the next step loads (and the shell's progress bar runs); photos show an ink bar and % each |
| empty | nothing listed («لا أجهزة مستعملة معروضة الآن» → «استبدل جهازك» + «تسوّق الأجهزة الجديدة») · no match («لا أجهزة بهذه الفلاتر» → the primary «امسح الفلاتر» + «تسوّق الأجهزة الجديدة»; no store-wide count in the title row while a filter is on) · a device search without a match · no devices bought online |
| validation | a question sent without an answer (client first, the server without script); phone (on blur, again on input, from the server) and the ownership box with the `FormErrorSummary` and focus on the first invalid field — the server reports every contact field at once too (an unreadable phone together with a missing ownership box); photo type/size/empty per photo |
| API failure | upload failures say why beside the photo (danger callout) with a retry when it can help; removal failure keeps the photo; form-level errors (rate limit, device no longer bought, a reused key) above the keys; filters or other units failing → `ErrorState` with retry, the page still shows; an add to cart that fails rolls back with a sentence (kit) |
| offline | the shell's banner (form copy on the wizard); on `/used` the filters, chips, sort, the pill and «امسح الكل» are disabled with «لا يوجد اتصال. تعمل الفلاتر والترتيب حين يعود.» under the toolbar (the list stays); the wizard's «رجوع» \| «تابع» / «أرسل الطلب», the unit's «أضف إلى السلة», the offer's «اقبل العرض» / «ارفض العرض» and the lookup's «اعرض الطلب» go flat with the reason beside them (wifi-slash + one sentence) and their forms do not submit (Enter included) — before the review a submit offline replaced the page with the bare error page and lost what was typed; uploads fail beside the photo with a retry that works once back online |
| success | the request page opens with «استلمنا طلبك.», where the inspection time will show, and a copy-link key (no SMS provider: said plainly); after adding a unit, «✓ في السلة» + «عرض السلة (n)» |
| pending review | «بانتظار الفحص» on every estimate until the device is inspected (after that the request's page names the first estimate in a line of the offer band and in the timeline); the staff steps listed as «لاحقاً» until they happen |
| unauthorized | `/trade-in/:ref` without the link: reference + phone, rate-limited, one answer for a wrong reference or phone (a 200 with the sentence); v2.1: the start page's track card asks for both (a number that cannot be a request number is a field error before anything is sent; without script the wizard's action passes the form on with a 307) |
| sold / reserved | status callout, no add key, «شاهد أجهزة أخرى» → the other units; sold answers 410 (both rendered in `tests/used.test.ts`: no seeded unit is reserved or sold) |
| demo | units and guides are seed data: «صورة توضيحية» on every illustration, «سعر ومخزون تجريبيان» beside the unit's price, «طلب تجريبي» / "Demo request" on a demo request, the demo line on the contact step |

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

`npx vitest run tests/used.test.ts tests/tradein.test.ts` (55 since the v2.1 review; 52 after the v2.1 build; 15 + 28 before) · `npm run typecheck` · `node scripts/lint-design.mjs
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

## Wave G wiring (2026-11-12)

- The `used.css` placement overrides for the used row and the five-step rail are gone: the kit stacks a narrow row and fits five
  steps at 320–390 itself.
- The unit page: `InspectionCard illustrationNote={false}` (the gallery says it once); the task bar holds the kit's
  `<BuyBar bare>` for a listed unit (offline and a failed add on its own line — the page's own offline sentences are gone, the
  kit's add key says it); the other-units rail relies on the kit's Rail for keyboard focus (the page's workaround is gone).
- Verified: `/trade-in/:ref` shows the offered grade and the checklist before the shopper answers (P4; `tests/tradein.test.ts`
  «before answering, the shopper sees what the inspection found»; browser lookup by phone of TI-5EBJS49V).

## QA fixes (2026-11-12, fix-pages-service; pictures and logs `…/scratchpad/ux/after/Q-fix-pages-service/`)

- **/used with filters that match nothing:** the title row drops the store-wide count while a filter is on (the toolbar
  says how many match — it said «6 أجهزة» above «لا أجهزة»); the empty state's «امسح الفلاتر» is the primary, with the
  recovery link «تسوّق الأجهزة الجديدة» (§4.23).
- **/used/:slug:** the fact line under the h1 is what the variant adds to the name (`used.server` `variantLine`: «أبيض»,
  "512GB", "Z1 Extreme 16GB / 512GB" — the catalogue's titles repeat the name; the list rows' fallback uses it too); the
  h1 binds a spaced dash to the word before it (`names.ts` `bindDashes`), so the balanced title never starts a line
  with «– OLED Model».
- **/trade-in device tiles:** a trailing bracketed qualifier goes on a meta line of its own (`names.ts`
  `splitQualifier`: «PlayStation 5 Digital Edition» + «الطراز الأصلي 2020» — the two-line clamp cut it); the amount and
  «· تقديري» / "· estimate" are bound with no-break spaces (at 1440 in English the tile reads "Up to" /
  "300,000 IQD · estimate").
- **Wizard focus:** after every move between steps or questions (Back and Forward included) the new step's h1
  (`data-step-heading`, `tabIndex=-1`) takes focus; it stayed on «تابع».
- **/trade-in/:ref:** the demo tag reads «طلب تجريبي» / "Demo request" (`track.demo`; it said "Demo order").
- **Photos:** a chosen file is read before it is shown or sent (`~/routes/storefront/support/photo-check`: first bytes,
  decode, pixel size), so a renamed text file is said at once and never sent to be refused (415 in the console).
- **Answers, not failed requests:** a refused field on the contact step or a lookup without a usable phone answers 200
  (`answerStatus`); a refusal reloads nothing (`shouldRevalidate`). Rate limits, conflicts and closed offers keep 4xx.

## Design v2.1 «Clay & Glass» (wave B, 2026-11-13 — client notes 10 and 12)

The client compared the trade-in start screen and preferred the store before the redesign ("before is better … the
search about the tradable items is good … add some features"), and asked for the new offer screen to be better
arranged, better looking, with features and animation. The kit already brought the font, keys, chips, glass and notes;
this area changed its arrangement and added what was asked.

- **Start page (`/trade-in`), the before's order:** the title and the before's line (`tradein.intro`), a line to the
  track card, the labelled rail (every step's word under its disc), «أي جهاز تريد استبداله؟» with v2's device search, the
  tiles three to a row on phones under each platform's colour line, three lines for a long name (the bracketed qualifier
  on its meta line). The estimate on a tile reads «حتى 365,000 د.ع تقديرياً» / "Up to 365,000 IQD (estimate)" /
  «تا 365,000 د.ع، خەمڵێنراو»: v2's «· تقديري» bound in one run did not fit a 104px tile (the tile test changed on
  purpose: no «·», the amount still one run).
- **Start page, what v2.1 adds:** the "device not on the list" `Note`; «كيف يعمل الاستبدال» as a three-step icon strip;
  «ما الذي يغيّر السعر؟» — the estimate's own rules (`computeEstimate`: power, body and screen → the grade span,
  accessories → a deduction each, the account lock → refused; the box is not asked about) in words, no guide figure;
  «أسئلة شائعة» (seven, every answer one of the store's rules; the validity from `tradein.estimate_valid_days`); the
  track card (`components/TradeInTrack.tsx`, request number + phone; `tradeInRefFromInput` in `wizard.ts` reads a number
  as people type it — any case, spaces, the «TI-» left out, Arabic digits — and a test keeps it in step with
  `normalizeTradeInRef`). With script it posts to `/trade-in/<ref>`; without, `/trade-in`'s action answers a 307 so the
  browser re-sends the phone there. From 1280 the card sits in the aside (sticky); below, after the questions.
- **Steps:** the labelled rail on top; raised option cards (`OptionCard className="surface"`); the photo drop area's clay
  disc; the estimate as frosted glass over the brand's ambient light (`.glow` + `.surface--glass`, its light kept inside
  the column sideways: the kit's default inset scrolled phones by 5px and 768 by 19px — measured), the validity as a
  pill, the note as `Note variant="line"`.
- **Request page (`/trade-in/:ref`, the new screen):** `handle.shell.tabBar = false` (the answer's keys are the page's
  task bar below 1024; the tab bar comes back on a request with nothing to answer); the offer on the wallet band
  (`Band kind="wallet"`) with the amount counting up once (`CountUp` inside the price's classes — 0 → 350,000 eased,
  measured after a lookup; final at once on a server-rendered first screen and under reduced motion), the first
  estimate, the validity pill; what the inspection found (grade, hint, one-line result, every line with its icon,
  problems first, two columns from 768, `revealProps({ stagger })`, what was handed over); the payout as raised option
  cards with clay icon discs (wallet · cash), a missing payout said at the cards before sending; «اقبل العرض» (the one red
  primary) / «ارفض العرض» (confirm dialog) — short words in the bar («ارفض», "Accept"/"Decline", «قبووڵی بکە»/«ڕەتی
  بکەرەوە»: the full ones ran off 360–390 in English and Sorani); answered: the outcome first with the drawn check
  (`SuccessMark`), then the inspection. **One timeline** «مسار الطلب» replaces «ما الذي يحدث بعد ذلك» + «سجل الطلب»: each step
  done / now / later with its date and what it brought (estimate, appointment, grade, offer, the payout chosen). The
  device and the inspection's time («الفحص»: the time the store set, the preferred time) sit beside the timeline from
  1024; on phones the order is offer → timeline → device → time (`contents` + `order`).
- **Used list / unit:** the hairlines between the row cards are gone (each row is a soft card now); the unit page has the
  breadcrumb bar on phones (`Breadcrumbs phone`), the brand line (`PlatformLabel bar`), the platform's ambient light
  behind the stage from 1024 (`.glow-layer` + `.used-stage-light`), and reveals on the hub link, the other units and
  the list's two closing sections.
- **Services untouched:** `used.server.ts`, `tradein.server.ts` and `api/upload-tradein.ts` are as they were — every
  export admin module 13 uses keeps its signature. New client-safe exports: `wizard.ts tradeInRefFromInput`,
  `components/TradeInTrack.tsx TradeInTrack`; `TradeInParts.Journey` is gone (only the start page used it).
- **Opaque catalogue photos** (a white plate in dark wells — the kit's plate treatment kept, no filter): Nintendo Switch
  Lite (`nintendo-switch-lite/1`), PlayStation 5 (2020) (`playstation-5/1`), PlayStation 5 Digital Edition (2020)
  (`playstation-5/2`), the Switch OLED's second photo (`nintendo-switch-oled/2`, unit gallery); on a unit's shelves two
  digital cards (box art: they never blend, by design).

### Requests to other owners (v2.1)

- **foundation — `ProgressSteps`:** a `labels="under"` option (the before's labelled rail: each step a column — disc,
  then its words under it on every width, no `max-md:sr-only` on them —, 32px discs with 13px numbers, the join at the
  discs' middle). The used area then drops the `.used-rail` block (utilities layer) from `used.css`.
- **foundation — `OptionCard`:** the v2.1 clay face (raised white-to-cream face with the soft wall shadow; chosen = the 2px
  ink ring) and an `icon` prop (a clay disc with the icon at the card's end). The used area then drops
  `className="surface"` on its option cards and its `PayIcon` end slot.
- **foundation — `Price`:** a `countUp` prop (the figure counts up once through `CountUp`; the currency, the screen-reader
  text and the tones unchanged), so no page composes `.price__num` by hand (`trade-in-status.tsx` `Offer`).
- **foundation — `.glow`:** the default `--glow-inset: -12% -6%` reaches past the sides of a column-wide element and
  scrolls a phone page sideways; consider `-12% 0` by default (or a clip on the page). The used area sets its own.
- **foundation / photos:** cut-outs for the opaque photos above.
- **shell:** a route's `handle.shell` is one value per route, so the trade-in start page (a landing page now) has the
  task chrome — no tab bar — like the steps; consider letting `shell` be a function of the URL (`/trade-in` without
  `step` → store chrome). At 1440, after the page has scrolled, Tab can land on the utility strip's links while the strip
  is scrolled away (seen in a full keyboard pass that wrapped round to the top).
- **foundation — `Checkbox`:** an option-row form (`row`, like `Radio row`: the paper card with its border, the 2px ink
  ring when chosen, the focus ring on the card) with the v2.1 clay face. The used area then drops `.used-check` (the
  accessories question's cards, review below).
- **foundation — keys in a task bar on narrow screens:** two keys side by side in a `<TaskBar>` at 320–375 (Sorani's
  longer words, 400% zoom) need the bar or the key to tighten itself (padding, the decorative icon); the used area does
  it with `.used-keys` (review below) and drops it once the kit does.

- **foundation — a `type-read` utility:** the kit has the reading role (`--type-read`, 16 / 1.75, G7) but no utility
  class; `className="type-read"` falls back to the inherited body font. The used area uses its own `.used-read`
  (`used.css`) and drops it once the kit has the class. Also: the lead role's line height (`--lh-lead` 1.65) is under
  G7's 1.7 on phones (`.used-lead` sets 1.75 here); the kit's field hint is 13px (the track card's «تجده في صفحة طلبك…»).
- **foundation — a stage card in the kit:** the unit page draws the product page's soft stage card itself (`.used-stage`:
  the ambient light in the stage's ground, the round back · share keys); the product area asked for the same in the kit.

### Review (wave B, 2026-11-13)

Found with my own probes and screenshots (`…/fb1/shots/used-review/`, scripts in `…/fb1/work/used-review/`); each
behaviour fix has a test that failed on the builder's code first (`tests/tradein.test.ts`, «Review 2026-11-13»).

- **What the inspection found:** a second rule 16px under the checklist's last line, above «سلّمت معه» (every width;
  two columns from 768) — the list's last line parts them now (the paragraph draws its own only without a list).
- **The offer screen's arrangement on phones:** eleven checklist lines, mostly green, stood ~950px between the offer and
  the payout choice (the answer sat ~1,650px down a 390 screen). Below 768 the lines that found a problem stay in sight
  under the sentence that announces them and the whole list is one tap away in the kit's `Disclosure` («كل بنود الفحص
  (11)», as v2 had it, now with an icon per line and the stagger when it opens); from 768 the whole list, two columns.
  The payout cards now start inside the first ~1.1 screens. (`tests/tradein.test.ts` offer screen: the row count
  changed on purpose — the page holds the list twice, one copy `display:none` at any width.)
- **The device search:** «امسح البحث» removed itself with the no-match state and focus fell to the page's body — focus
  goes back to the field; and it is a link to `/trade-in` now, so a search sent without script (`?q=`) has a way back
  (it was a button that did nothing without script).
- **The start page's track card → the request's page:** a lookup that found nothing arrives on a page of its own; the
  phone came back empty and focus started at the top, and the reference — that page's address — could not be changed
  there. The action echoes the phone as typed (`phone`, lookups only), the lookup card keeps it and moves focus to it,
  and «تتبّع طلباً برقم آخر» leads back to the start page's card (`/trade-in#ti-track`). Without script, a number the
  wizard's action refuses comes back with what was typed (`values`), so the card is not emptied.
- **Offline on the request's page:** the banner said «سلتك محفوظة على هذا الجهاز.» above the lookup and the answer forms;
  the handle declares `offline: "form"` («ما كتبته باقٍ في الصفحة…»).
- **Payout cards:** store credit on a guest's request is disabled, but its icon stayed brand red (read as a choice that
  works) — it goes quiet with the card's words.
- **The accessories question** was a column of plain checkbox rows between questions of raised option cards: each box is a
  card now (`.surface` + `.used-check`: the paper card, its border, the 2px ink ring when chosen, the focus ring on the
  card — see the request above).
- **Tiles:** the page repeated the kit's 1.03 photo growth on hover for every hover-capable pointer; the kit's own rule
  (fine pointers) is the one now.
- **The task bars at 320–375 (400% zoom, small phones):** in Sorani the primary ran 7px («بەردەوام بە») and 43px («قبووڵی
  بکە» — the check off the screen) past a 320 screen's edge — the keys' grid column grew to their widths — and at 360
  the kit cut «قبووڵی بکە» to «قبووڵی بـ…». The column is the bar's width now (`grid-cols-[minmax(0,1fr)]`), the
  primary may shrink, and `.used-keys` takes the kit's own padding knob (`--px`) down for Sorani below 390 and for every
  language below 360, where the decorative arrow / check also gives the words their room (the loading spinner stays).
  Measured: every key whole and inside the screen at 320, 360, 375 and 390 in ar, en and ckb.
- **The lookup sentence:** at 390 in Sorani the reference broke at its dash («TI-» ending one line, «7KP4S8J9ـت»
  starting the next) — a word joiner after the dash keeps it whole.

## Round-1 fixes (2026-11-13, fix-service; pictures `…/a312dfb7-…/scratchpad/fb1/shots/C-fix-service/`, probes `…/fb1/work/C-fix-service/`)

- **The device search reads Arabic** (major, client note 10 keeps it): `wizard.ts filterGroups` expands the words through
  the support matcher (`nameTerms`: aliases, alef / hamza / ya folding, an article in front, Sorani, Arabic digits, a
  word still being typed). Typed in the browser: «بلايستيشن» 6, «بلي ستيشن» 6, «اكس بوكس» / «إكس بوكس» 5, «سويتش» 4,
  «سويتش 2» 1, «نينتندو» 4, «ستيم» 2, «ستيم ديك» 2, «روغ» 4, «بلايست» 6, «اكس ب» 5 (all 0 before); without script
  `?q=بلايستيشن` shows 6 tiles. New test (failing first) over ar / ckb / en.
- **Reading text (G7)** on the offer and status pages, the estimate step and the start page: `.used-read` (16 / 1.75)
  for the checklist lines (`.used-checklist`), «سلّمت معه», the first estimate, the timeline's details, «يجري موظفو
  المتجر…», «وقت مفضّل وليس موعداً مؤكداً», the estimate's note line, «بعد إرسال الطلب», the question's hint, the track
  and lookup cards' lines; `.used-title` (16 / 600) for the timeline's and the cards' short titles, the answers, the
  fact titles; the FAQ questions and «كل بنود الفحص» at 16px; the how-it-works strip is one step a row below 600px.
  Measured (the auditors' rule, 390): offer ar 19 → 0, ckb 30 → 4 (timestamps), estimated 9 → 0, estimate step 6 → 0,
  start page 6 → 1 (the kit's field hint).
- **Tidy tiles:** «حتى 365,000 د.ع» on one line at each tile's foot, «تقديرياً» once in the section's line; names
  balanced in two lines at 390 (the tile test changed on purpose: no estimate word on the tile's line, the sentence once).
- **The offer's answer on the first desktop screen:** from 1024 it heads the request's column (accept at y≈534 at
  1440×900, ≈550 at 1024×768); the keys whole-width there (side by side, the primary read «اقبل العر…» at 1024). New test.
- **«Joy‑Con» never breaks at its hyphen** (`names.ts keepLatinHyphens` in `useAccessoryLabel`). New test.
- **The unit page's stage** is the soft card with the ambient light and the back · share keys (above).
- **The glossary title** «المستعمل والمفحوص» on `/used`. New test.
- **A flaky security test** (`tests/storefront-adversarial-input.test.ts`, the trade-in near-miss token): the token's last
  character carries 4 bits, so «…A» was the real token one run in sixteen — it now changes the character for another.

