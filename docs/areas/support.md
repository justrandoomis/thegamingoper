# Support area — support centre, guides, maintenance assistant, repairs

Owner: storefront area "support". Brief §7, Design System v2 spec §6.13 (templates), §6.17 (states), §9 (copy);
CONTRACTS.md §3 (support row). Files: `app/routes/storefront/support/**` (pages, `components/`, `support.css`),
`app/server/services/support/**`, `app/i18n/messages/support.ts`, `tests/support.test.ts`. No API route: photos travel
with the form that needs them.

## Routes (Design v2.1 «Clay & Glass», client feedback round 1 — note 9: the before's support page)

| Path | Shell | What | States |
|---|---|---|---|
| `/support` | store | the before's arrangement: the support tabs; h1 «الدعم والمساعدة» and its line (document title «مركز الدعم»); **the problem search** on the soft raised card over a soft ambient light (`./components/HelpSearch.tsx`, below); the before's list cards (the kit's `EntryCard` rows: clay icon disc, title, one line, arrow) in two short groups — «مشكلة في جهازك؟» (شخّص المشكلة خطوة بخطوة → the assistant · احجز صيانة · تابع طلب صيانة) and «طلبك وأسئلتك» (تتبّع طلبك → `/track` · الإرجاع والضمان → `/policies/returns` · تحدّث مع موظف → the hand-off), one column on phones, two from 768; «اختر جهازك»: every platform's devices under its colour line (`PlatformLed bar`), name and count — a rail with 2.5 tiles below 768, a wrapping `auto-fill minmax(150px)` grid from 768, whole model names, no script needed; `?device=<slug>` opens the device's panel (photo, assistant / repair keys, the devices area's hub link, its guides); six suggested guides in staff order (`?guides=all`); the store's `ContactCard` («تواصل مع المتجر») only when the owner configured channels (the hand-off is already a list card). From 1024 the store's mascot (it wears a headset) sits on a disc of real glass at the end of the head, the ambient light behind it | search: danger · code with / without a guide · guides · policies · nothing found · a platform filter; device chosen · device without guides; no guides at all; demo line |
| `/support/article/:slug` | store | the tabs (مركز المساعدة marked), then one approved public guide in the reading column (`<Blocks>`, ≤ 70ch; breadcrumbs from 768) + "still not solved?" (primary «ابدأ المساعد», secondary «احجز صيانة») + related guides in the aside | Arabic fallback (an info `Note`) · "not yet reviewed by a store technician" · demo line · 404 |
| `/support/assistant` | task | compact head (title, demo tag, «ليس تشخيصاً» — the kit's clay `Chip` as the summary of a disclosure that opens how the assistant works on a calm `Note`), the safety note collapsed to «للسلامة: لا تفتح الجهاز» (the kit's `Disclosure` panel, the warning on its tinted disc; opens by itself on a danger stop, battery, the power tree or any warning), the conversation (shopper bubbles on `--niche` at the inline end, assistant bubbles on the soft card at the start; warnings as the calm safety note), replies as clay chips (platform chips with dots, 88×88 device image chips), «تحدّث مع موظف» (secondary) + «ابدأ من جديد» (quiet link); the composer in the glass task bar below 1024, at the end of the chat column from 1024 with the device card and its guides in a sticky aside; `?handoff=1#handoff` = the hand-off form; `?ticket=SP-…&tk=…` = its receipt (the check that draws itself, «انسخ رابط الصفحة») | device · model · problem · steps · done (resolved / guide / part / repair / staff) · danger stop (typed before or after the device) · error code with / without a guide · unmatched words · a problem typed before the device (`need_device`) · a name that only points at a platform · hand-off form (validation summary, offline, network failure kept in place) · receipt (status, staff replies or «لا ردّ بعد.», copy link) |
| `/support/repair` | task | three steps `?step=device|photos|contact`, one form (fields stay mounted between steps; `shouldRevalidate` skips the loader for step changes); step rail (compact below 768); "what happens next" (4 steps on clay number discs) and the facts that are true today as quiet note lines (`Note variant="line"`: الدفع · صورك والرقم التسلسلي) above the form on step 1 below 1024, in a sticky aside from 1024; from the assistant, an info `Note`; the task bar «رجوع \| تابع» below 1024, the same keys at the end of the form from 1024 (`stepBack`); hand-over as OptionCards; the preferred time as `PreferencePicker` | per-step validation with the error summary; server field errors take the shopper to the step of the first one; uploading photos; offline; network failure (form kept); rate limited; without JavaScript every step shows and the key sends the form |
| `/support/repair/status` | store | a 560px lookup card, then the request card: reference (type-code, LTR, copy key), status in words on an inset well, quote, device, sent, photos, hand-over, preferred time, the shopper's description, the status timeline on clay discs (a check for a stage passed, an ink dot for the current one); just created: the check that draws itself, «استلمنا طلب الصيانة» (an h2 that takes focus) and «انسخ رابط الصفحة». Headers (`repairStatusHeaders`): the private card `no-referrer`; the lookup form `same-origin` | lookup · not found (same answer for a wrong reference or phone) · rate limited · created · replayed · every repair status, quote pending / approved · the lookup without script |

Every support page starts with the same tabs across the page (`SupportNav`: the kit's link `Tabs` — «مركز المساعدة ·
مساعد الصيانة · احجز صيانة · تابع طلب», en "Help centre · Assistant · Book a repair · Track", one ink underline that
slides between them; they sit at the same place on every page, so they never jump), then the page: on the task pages a
main column from the page's start edge and a sticky 380px aside at the end from 1024 (the before's proportions). The
route handles (`nav: "push"`, `order` 0 · 1 · 2 (+ step/10) · 3, `group: "support"`) give the sideways push between
them and between the repair steps. One "talk to a person" destination everywhere: `/support/assistant?handoff=1#handoff`,
«تحدّث مع موظف» / "Talk to a person", copy «نرسل محادثتك إلى موظف مع رقم طلب تتابع به ردّه.».

### The problem search (`components/HelpSearch.tsx`, `server/services/support/helpsearch.ts`)

One GET form (`?q=`, `?platform=`) — it works without JavaScript; the search key inside the field is the view's one red
primary.

- **Suggestions while typing** (debounced 150 ms, computed in the page — no request per key) from the index the loader
  sends (`getHelpIndex`: every approved public guide's title, summary, device and platform names in all three languages,
  its tags, its platform and the error codes its text names — never its body), ranked by the results page's own rules
  (`rankEntries`). Order: a danger sign first and alone («توقف…» → احجز صيانة), an error code (the guides that name it —
  the row is active, so Enter opens the guide — or «لا يذكره أي دليل بعد» → a person), else guides and store policies
  (the content area's `listPolicies`, matched by their titles and the words people use: «استرجاع», "refund"…), the typed
  words marked (`<mark class="sup-hit">`), the last row «اعرض كل النتائج». Device names the shopper's way find their
  Latin titles («تجهيز البلايستيشن» → "تجهيز PlayStation 5 لأول مرة"; `matcher.aliasWords`). A frosted glass panel;
  on phones the field rises to the top of the screen when the list opens.
- **Keyboard:** combobox + listbox with groups; ↓ ↑ walk the rows (field → first … last → field), Enter opens the active
  row or searches, Escape closes; the rows keep the focus in the field; a polite status says how many rows there are.
- **Device chips** «كل الأجهزة · Nintendo · PlayStation · Xbox · المحمولة»: native radios in the form (`platform`): they
  keep suggestions and results to one platform's guides and the guides about every device (`searchHelp(…, { platform })`);
  with script a change re-runs a search already on screen and leaves the focus on the chips (`KEEP_FOCUS` navigation
  state — the arrow keys walk on; the results' status line says the outcome). The chosen chip stays in view in the rail
  (`useKeepInView`), after a reload too.
- **Common problems** («مشكلات شائعة»): link chips `?q=<their words>` (with the chosen `platform`); each one's words (in
  ar, en and ckb) lead to the guides of one tag (tested); offered only while such a guide exists — for the chosen
  platform, its guides and the guides about every device (`commonProblemsFor(index, platform)`, tested per platform).
  Never called "popular": the store has no search statistics.
- **Offline:** the suggestions still come (computed in the page); the search key goes flat with the reason under the
  field («لا يوجد اتصال. ما كتبته باقٍ هنا…», the composer's way) and nothing navigates — no swap to the offline panel.
- **Results** grouped — a danger stop (the calm safety note in --danger with «احجز صيانة» and «تحدّث مع موظف»), an error
  code (the guides that name it, or an honest note with «تحدّث مع موظف» and the assistant), «الأدلة» (two columns from
  1024) and «سياسات المتجر», the searched words marked — then «لم تجد ما تبحث عنه؟» (the assistant, a repair, a person). Nothing
  found: the kit's empty state on the soft card — key «احجز صيانة», link «تحدّث مع موظف», and «ابحث في كل الأجهزة» when a
  device chip kept the search to one platform and the same words find guides on other devices (the loader searches
  again: `elsewhere`). One status line stays from search to search (shown with the count, read out otherwise). The
  shopper's words sit in a first-strong isolate inside every sentence («نتائج «CE-108255-1»» keeps the code's order).
- **Choosing a device** (`?device=<slug>#device-help`): the panel's heading takes focus (the tile pressed sits below it).

One red primary per view: the search key (support centre), the composer's send key (assistant), «أرسل إلى موظف»
(hand-off form), «تابع» / «أرسل طلب الصيانة» (repair), «اعرض حالة الطلب» (status lookup), «ابدأ المساعد» (article).
The two result views — the hand-off receipt and a repair's status card — have no forward action, so no primary.

## Components (`app/routes/storefront/support/components/`)

| File | Exports |
|---|---|
| `parts.tsx` | `SupportNav` (the kit's link `Tabs`; `section` accepted — see "Open"), `Name` (the kit's `BidiLabel`), `Highlighted` (a text with the searched words marked, bidi-isolated like `BidiLabel`), `guideIcon`, `PlatformName`, `GuideRow`/`GuideList` (rows in the soft raised card, the kind's icon on a clay disc, 16px title and two lines of 16px summary; `plain`; `highlight`; `.sup-guides--cols` = two columns from 1024), `DeviceArt`, `DeviceTile`, `deviceFit`, `SafetyNote` (the kit's `Note`: the warning on its tinted disc, the tone's word for screen readers; `danger` tints disc and title --danger; `action`; `flat` inside a bubble), `CopyKey`, `CopyLinkKey`, `UpdatedOn` |
| `HelpSearch.tsx` | `HelpSearchForm` (the problem search, above), `HelpResults` (the grouped results), `searchHref`, `staffHrefFor`, `assistantHrefFor`, `ltr` |
| `Conversation.tsx` | `Conversation({ view, replies })` — `replies={false}` hides the reply chips while the hand-off form or its receipt shows |
| `HandoffPanel.tsx` | `HandoffForm`, `HandoffReceiptCard` (status + staff replies), `HandoffReceipt` |
| `PhotoPicker.tsx` | `PhotoPicker` (the proof-uploader look: dashed paper area, 96px thumbnails, 32px remove keys); chosen files are read one at a time before they join the form (`../photo-check`) |

Photo check (`photo-check.ts`, client-safe; the trade-in uploader uses it too): `acceptPhotos(current, incoming,
found?)`, `checkPhotoFile(file)` → `upload_type` (the first bytes are no JPEG/PNG/WebP — the store's own signature rule),
`upload_corrupt` (the browser cannot draw it), `upload_dimensions` (past 16,384 px a side or 50 MP) or null,
`photoFormat(bytes)`, `claimsPhoto`, `PHOTO_TYPES`, `PHOTO_MAX_BYTES`.

Client helpers (`client.ts`): `keepFormOnFailure` (clientAction), `revalidateAfter` (shouldRevalidate: a request that
never reached the store reloads nothing — assistant, repair and status routes; neither does a refusal of fields or a
lookup that found nothing), `answerStatus` (fields the shopper can fix answer 200, everything else keeps its 4xx),
`withServerErrors` (the store's field sentences kept in the page's own state), `stepBack`, `isFailure`,
`fieldMessage`, `formMessage`, `phoneProblem`. GET and lookup forms carry `action="."` (React Router otherwise writes the
address bar's query into `action`, spelled differently from the server's, and hydration fails on `?q=` with spaces).

Page CSS: `support.css` (`.sup-*`, components layer, tokens only, logical properties, `--r-*` radii; the soft card is
`--card-face` + `--e-surface`, so dark cards are the see-through faux glass over the floor's light — no section paints a
background). Kit components used: Tabs, Note, EntryCard, Chip (also `as="summary"`), Disclosure, SuccessMark, Glass
(panel), Key, IconKey, Niche, Render, TextField/TextArea/Select/Checkbox/OptionCard/FieldGroup/FormErrorSummary,
PreferencePicker, ProgressSteps, SectionHead, ContactCard, EmptyState, DemoNote, Status, Price, TextLink, Breadcrumbs,
Blocks, BidiLabel, PlatformLed (`bar`), Logo (mark); classes `.clay-disc`, `.glow`, `.surface--glass`; `revealProps()`
on the devices and guides sections; shell: TaskBar, `chrome: "task"`. No retired kit names remain.

## Services (`app/server/services/support/`) — signatures kept, additions only

| Module | Exports |
|---|---|
| `kb.server.ts` | `getSupportDirectory`, `listArticlesForDevice(db, locale, deviceModelId, { related? })` (contract), `listArticlesForPlatform`, `listArticlesByTag`, `listHelpArticles`, `findArticlesMentioning`, `getArticle`, `listRelatedArticles`, `findDevice`, `findPlatform`; `searchHelp(db, locale, q, { platform? })` → `HelpSearch \| null` (round 1: the optional platform, ranked by `helpsearch.rankEntries`); **new** `getHelpIndex(db)` → `HelpIndexEntry[]` (no bodies) |
| `helpsearch.ts` (new, client-safe) | `rankEntries`, `scoreEntry`, `queryWords`, `meantTag`, `suggestHelp`, `forPlatform`, `matchPolicies`, `highlightParts`, `COMMON_PROBLEMS`, `commonProblemsFor`, `SYMPTOM_TAGS`, `NOISE`, `MIN_SUGGEST_CHARS`; types `HelpIndexEntry`, `PolicyEntry`, `HelpSuggestions`, `HelpEntryText`, `TextPart` |
| `assistant.server.ts` | `runAssistant(db, locale, state, { model? })` → `AssistantView` — now also reads words typed before a device: a danger sign stops at once, a device's name chooses it (its words are dropped when they only name it), a platform's name asks for the model, a problem waits for the device (turn kind `need_device`); `handOffToStaff`; `AssistantModel` + `configuredAssistantModel()` (null); `checkTree` |
| `tickets.server.ts` | `createSupportTicket` (contract); `getTicketByAccessToken` → `TicketReceipt` now with `replies` (staff, non-internal, oldest first); `planSupportTicket`; `SUPPORT_ERROR_KEYS` |
| `repairs.server.ts` | `createRepairTicket` (contract); `getRepairByAccessToken`; `lookupRepair` |
| `matcher.ts` | `interpretText`, `findErrorCode`, `normalizeForMatch`, `matchDevice(text, directory)`, `hasDangerSign`, `describesProblem`, `tokenMatches`, `KNOWN_SYMPTOMS`; **new** `findErrorCodes(text)` (every code a text names) and `aliasWords(text)` (the catalogue's words for device names spelled the shopper's way, «البلايستيشن» included) |
| `state.ts`, `summary.ts`, `types.ts` | client-safe: URL state, the conversation summary, view models (+ `HelpSearch` with the optional `platform`, turn kind `need_device`) |
| `common.server.ts` | `SupportWho`, refs, idempotency → access token, preferred day (Baghdad, today … +30), rate limits, private photos |

## Real, demo, boundary

- **Real:** D1 with zod validation, one `db.batch` per creation (an `expectThat` guard on the access-token hash makes
  double submissions one row), audit events, per-IP and per-phone rate limits, private photos through the server's
  upload pipeline (type by bytes, ≤ 8 MB, metadata removed).
- **Demo:** the 8 articles and the trees are seeded, approved without a reviewer: pages say "demo" and "not yet reviewed
  by a store technician". Tickets and repairs made while `STORE_MODE=demo` are `is_demo` and say so («طلب تجريبي»).
- **Boundary — AI:** no model configured; `AssistantModel.interpret` may only return existing keys; danger signs and
  error codes are never left to it; the «ليس تشخيصاً» panel says answers come from verified guides.
- **Boundary — contact:** no SMS/WhatsApp provider and no owner-confirmed contact process, so the pages promise neither a
  message nor a call (v2 §9): the phone is "used only about your request", a preferred time is "a preference, not a
  confirmed time", the shopper follows a repair on its status page and a hand-off on its receipt page (status + staff
  replies). The admin modules already write what these pages read: replies as `ticket_messages` (`employee`, not
  internal; admin support 14) and repair status changes as `repair_events` kind `status` with `data.to` (admin returns 12).
- **Not promised:** pick-up availability («قد لا يتوفر في كل المناطق»), appointment times, repair prices, warranty cover;
  no inspection fee or repair warranty is shown until the owner configures one.

## Stored data

- Assistant: nothing until "talk to a person" with consent → `assistant_sessions` (escalated, `log_consent`, expires after
  365 days; the daily retention job deletes it), `assistant_messages`, `consents` (`support_log`), `support_tickets`
  (channel `assistant`, internal note = Arabic summary rebuilt on the server), `ticket_messages`.
- Repair: `repair_tickets` + a `repair_events` "submitted" row with hand-over, preferred window (and day, when sent),
  photo ids. The status page reads staff changes from `repair_events` kind `status` with `data.to`.

## Integration slots

- The device panel shows the devices area's `DeviceHubLink` (import only).
- The devices area can call `listArticlesForDevice` for hub guides; product/order pages can call `createSupportTicket`.
- Staff replies appear on the hand-off receipt as soon as the admin support module writes `ticket_messages` with
  `author_kind = 'employee'` and `is_internal = 0`.

## Verify

```
npx vitest run tests/support.test.ts        56 tests: URL state, refs, days, matcher (+ device names, danger, problem),
                                            KB visibility, help search (+ round 1: suggestions, codes, platform chips,
                                            common problems, marks, the page's render), tree replay and safety, words typed before a
                                            device, a name that only points at a platform, model boundary, hand-off
                                            (consent, storage, idempotency, race, photos, limits, receipt replies), copy
                                            rules (no call promise, glossary, key parity, phone examples and RP- codes
                                            isolated and unbreakable in ar/ckb), kept forms (`revalidateAfter`),
                                            status-page headers (`repairStatusHeaders`), repair steps' «رجوع»
                                            (`stepBack`), repairs
node scripts/lint-design.mjs app/routes/storefront/support app/server/services/support     0 findings
```

**Review of round 1, wave B (2026-11-13)** — my own probes in `…/a312dfb7-…/scratchpad/fb1/work/support-review/`,
pictures in `…/fb1/shots/support-review/` (`compare/` = before · v2 · now). Fixed: under a device chip, 6 of the common-
problem chips led to «لم نجد دليلاً» (e.g. «الجهاز يسخن» under Xbox) — offered per platform now; the first arrow key on
the device chips moved the focus to the results' heading (out of the radio group); the chosen chip was cut by the card's
edge or out of sight (`?platform=handheld`); choosing a device left the focus on the tile, below the panel; the
suggestions' group titles were paragraphs owned by the listbox (now `aria-hidden`, still naming their group); offline,
a search swapped the whole page for the offline panel (now: key flat + reason, words kept); «جويكون» found nothing where
"joycon" found the drift guides (`matcher` stick_drift terms); the danger turn was a bold paragraph (G7: the danger
note above it marks it); two 14px descriptions (article «لم تُحل المشكلة؟», the quote state) → 16px reading text. Added:
«ابحث في كل الأجهزة» in the empty state when other devices answer; one persistent results status line. Tests 52 → 56
(4 new, written failing first where they test behaviour: chips per platform in ar/en/ckb, the empty state's way out and
status, `keepsFocus`, the Arabic spelling of Joy-Con).

**Client feedback round 1, wave B (2026-11-13, v2.1 «Clay & Glass»)** — scripts in
`…/a312dfb7-…/scratchpad/fb1/work/support/`, pictures in `…/fb1/shots/support/` (`compare/` = before · v2 · now):

- `tests/support.test.ts` — 52 tests (8 new: error codes and device names the shopper's way; whole-word marks; policies by
  title and vocabulary; suggestions answer as the results page does; an error code a guide names — indexed, suggested,
  searched, kept to its platform; the device chips; every common-problem chip's words lead to its tag in ar/en/ckb and a
  chip without a guide is not offered; the support centre renders the before's tabs and title, a GET search form with
  radios and link chips, the list cards, the devices by platform, one red primary). Changed on purpose: the glossary
  test no longer forbids «مركز المساعدة» / «الدعم والمساعدة» (note 9 brings the before's tabs and title back) and checks
  the four tab labels and the new h1.
- `flow-search.mjs` (390): 20/20 — suggestions while typing (an Arabic spelling finds "PlayStation 5" and marks it), ↓ /
  Enter opens a guide, Escape closes, an error code (honest row → its search, focus on the results heading), danger first,
  a policy, a common-problem chip, a device chip that keeps suggestions and the search to PlayStation, nothing found
  (repair key + person link), the GET form without JavaScript.
- `flows.mjs` (the v2 round's, adapted): 26/26 at 390 and 1440 — search (code, words, danger, nothing), six list cards,
  four platforms under their colour line, device panel, typed device, safety note opening on power, focus on the newest
  answer, danger before a device, error code, hand-off validation → `SP-…`, repair three steps with a photo → `RP-…`,
  status wrong phone → same answer, right phone → card, focus on the result. Console clean.
- `shots.mjs` matrix: 7 views × 360/390/768/1024/1440 × light/dark (ar) + 390/1440 en/ckb = 98 shots — one h1 each, no
  overflow, no console error or hydration warning. `ltr.mjs`: /en mirrors /ar (h1, tabs, search key, list cards, chips,
  platform heads, bubbles, step key, rail). `focus.mjs` (14 views × 390/1440): 0 focused stops hidden or under a bar
  inside the page, every stop ringed (at 1440 the shell's utility-strip links are focusable while scrolled away above the
  sticky header — the shell's). `contrast.mjs` (14 views × light/dark): 0 text runs below AA. No-JS: every platform's
  devices, 5 radios, 7 chip links, the results.

**Review 2026-11-12** (`…/scratchpad/work/pages-P8-support-review/`, pictures `…/scratchpad/ux/after/P8-support-review/`):
fixed a hydration mismatch on `/support?q=` and the composer (`action="."`); phone examples read «4567 123 0770» in
Arabic and Sorani hints and errors (now isolated, no-break spaces); «PS5 Slim» → model chip answered «لم أجد دليلاً
معتمداً يطابق ما كتبت» (the name was re-read as the problem); a dropped connection replaced the form with an error panel
(the route part — the root part is the lead's, see below); the repair «رجوع» pushed history (the browser's Back then went
forward); without script only Nintendo's devices were reachable on `/support`, and the status lookup was refused (400,
`Origin: null` under `no-referrer`); device names clamped mid-name; the contact section's hand-off sentence beside a
ContactCard; no way from `/support` (or a guide on a phone) to the assistant or repair tracking — the four-segment
navigation is back on the support centre and added to the guide page. Added «انسخ رابط الصفحة» on the receipt and a
created repair. Flows 43/43 at 390 and 1440 + 8/8 without
script; states 8/8; focus walk: no focused control hidden (390, 768, 1440, dark en; the 154px «ماذا يحدث؟» box at 768
is two-thirds above the task bar, which WCAG 2.4.11 allows); contrast 0 below AA (34 views); /en mirrors /ar to the
pixel; no overflow 320–1440 in ar/en/ckb; 306 matrix views: sizes on the scale (≤ 8 per view), Kufi 700 + Plex 400/600,
radii {6, 8, 12, 20, full}, ≤ 2 shadows, no image filter, one red primary on every view but the two result views.

Browser checks (Edge headless against the dev server, 2026-11-12; scripts in `…/scratchpad/work/pages-P8-support/`,
pictures in `…/scratchpad/ux/after/P8-support/`):

- `flows.mjs` — 26/26 at 390 and at 1440: help search (code, words, danger, nothing), task tiles, platform switch,
  device panel; assistant (typed device, safety note opening on power, focus on the newest answer, danger before a
  device, error code); hand-off (focus, validation summary, ticket `SP-…`); repair (step validation, photo, three
  steps, created `RP-…`, one photo counted); status (wrong phone → the same answer, right phone, focus on the result).
- `states.mjs` — 9/9 (§6.17): loading (busy key + «نرسل الطلب مع صورة واحدة…»), API failure (POST aborted: the
  sentence, everything typed kept), offline (the shell's form banner, keys flat with their reason, composer reason).
- `shots.mjs` + `matrix.mjs` — 13 states × 360/390/768/1024/1440 × light/dark (Arabic) + 390/1440 English and
  Sorani, contact sheets in `m1/sheets/`; no horizontal overflow anywhere.
- `probe.mjs` (390): exactly one visible red primary per view, no target under 44, no Arabic run under 13px.
- `census.mjs` (K's census on `#main`): ≤ 7 sizes per view, all on the §2.6 scale; Noto Kufi 700 + Plex 400/600 only;
  radii ⊆ {8, 12, 20, 28, full}; ≤ 2 shadow recipes; no image filters; measured text contrast passes (two census
  artefacts: the 1×1 `sr-only` file inputs beside their 44px label keys, and the task bar's label measured after the
  census hides fixed chrome).
- H's `focus.mjs`: 0 focused stops under a bar (390, 768, 1440, dark). `ltr.mjs`: `/en` mirrors `/ar` exactly (same
  distance from the start edge for the h1, nav, bubbles, keys, step rail), no overflow.

Chromium only; no phone; Sorani strings need a native reader.

## Not done / open

- The receipt page is how a shopper follows a hand-off; there is no lookup of an `SP-` reference by number + phone (the
  status page looks up `RP-` repairs only).
- A shopper cannot approve a repair quote online: the status card says to write to a person.
- Error codes: no guide mentions one yet, so the search and the assistant say so and offer a person. The search index
  already lists every code a guide names (`getHelpIndex` → `codes`): the day staff publish a guide that names
  "CE-108255-1", typing the code suggests that guide (the active row — Enter opens it) and the results list it.
- Round 1 (v2.1): the support pages' words are the before's — tabs «مركز المساعدة · مساعد الصيانة · احجز صيانة ·
  تابع طلب», h1 «الدعم والمساعدة» — as the task asked; DESIGN.md's glossary row ("not: المساعدة") and the store's other
  links («مركز الدعم» in the header, footer and home) are the lead's to settle; the document title stays «مركز الدعم».
- Round 1 (v2.1), waiting for the kit: link `Tabs` mark the chosen tab `aria-current="page"` — a guide and the ticket
  page should say "true" (v2's Segmented could); `Breadcrumbs phone` wraps its crumbs inside the one line on phones, so
  the guide page keeps the trail from 768; no `Note tone="danger"` (the safety stop sets the note's disc and title to
  --danger with its own class); the kit's tab labels are 13px where the before's support tabs were ~16px.
- The guides are demo content no store technician has reviewed: every surface calls them «أدلة طمطم» / "TamTam's
  guides" (never «المعتمدة» / "approved" / "verified"), and each page says once what they are (`help.demo`,
  `assistant.demo`, `article.notReviewed`). Once a technician reviews them, a reviewed flag in `kb.server` can bring the
  word back where it is true.
- The matcher and the device-name aliases are keyword-based; Sorani vocabulary needs a native reader.
- No SLA policies are seeded, so new tickets carry no due times until the admin sets policies.
- A dropped connection during a send: the support routes keep the form, but `app/root.tsx` `shouldRevalidate` always
  reloads the root after a POST, and that reload fails too — the root's error panel replaces the page (lead's file).
- Opaque photos (Nintendo Switch Lite, PS5 2020) keep their white box on the light ground: `.render { isolation:
  isolate }` (and the slot's size containment) stop the `multiply` blend (styles owner).
- At 320px the last repair step's «أرسل طلب الصيانة» is cut with an ellipsis in the task bar (fits from 360).

## Wave G wiring (2026-11-12; `tests/storefront-wiring.test.ts`)

- **/support/ticket** — a message to staff ("SP-…") followed by its number AND the phone it was sent with (`lookupTicket`: rate
  limited per IP and per number, a wrong number and a wrong phone read the same), or by the receipt's link (`?ref&tk`). A repair
  number typed there says where it is followed (and the repair status page says the same of an SP number).
- **The satisfaction rating** (admin 14.05 asked for it): once staff resolved or closed the request — five rows 1–5 with words,
  an optional comment — `rateTicket` writes `csat_rating` / `csat_comment` ONCE (a guarded update; a second answer reads
  «قيّمت هذه المساعدة من قبل»), audited `support.ticket.rate`; never a default. The hand-off receipt links to it («قيّم المساعدة»,
  else «تابع طلبك لاحقاً برقمه ورقم موبايلك»).
- **Review fixes (2026-11-12, `tests/storefront-wiring-review.test.ts`):** a rating that never reached the store (offline, a
  dropped connection) keeps its card, the choice and the comment, and says so in the rating part — the page's `clientAction`
  adds the form's `intent` and words to such a failure (never the token or the phone) and `client.ts ticketView` places it (the
  card used to turn into the lookup form, the words gone). The private link's card that holds the rating form is served
  `Referrer-Policy: same-origin` (`ticketPageHeaders`): under `no-referrer` a browser posts it with `Origin: null` and the
  store refused it — the rating failed without script (400). A card without a form keeps `no-referrer`.
- **From an order's page** (`/support/assistant?handoff=1&order=TT-…#handoff`): the form says «عن الطلب TT-…» and sends it; the
  ticket is category "order", its subject names the order, and it is LINKED (`order_id`) only when the order is the shopper's (its
  phone, or their account) — else the internal note says it was named but not verified (`ticketOrderOf`). The order pages still
  link the plain hand-off: asked to add `&order=<ref>`.
- **Routing on arrival:** right after a hand-off's answer (`waitUntil`), `routeOnArrival` runs the support module's `routeTicket`
  as the system; failures only log (the scheduled job routes what it misses).
- **Kit requests applied:** `SupportNav section` → `aria-current="true"` (a guide, the ticket page); the support.css scroll
  workaround is gone (the kit's link Segmented scrolls); the repair form's hand-over group carries the summary's `id`
  (`FieldGroup id`), the time preference uses `PreferencePicker label/id`.

## QA fixes (2026-11-12, fix-pages-service; pictures and logs `…/scratchpad/ux/after/Q-fix-pages-service/`)

- **A photo the store refuses** (major): the picker reads each chosen file before it joins the form (`photo-check.ts`:
  the first bytes, a decode, the pixel size — the store's rules), so a renamed text file stays out at once with the
  store's sentence («نقبل صور JPG أو PNG أو WebP فقط.») instead of a broken thumbnail. When the store still refuses a
  photo, the repair form keeps the store's sentences in its own state (`withServerErrors`: the move to the photo step is a
  navigation, which clears the action's answer — the step used to show no reason and no summary), shows the error
  summary «تحقّق من حقل واحد: صور المشكلة», focuses the photo field, and waits until the photos change before moving on
  (the photos' two inputs share one name: focus goes to their fieldset — `focusNamed`; the old `.focus()` on the
  RadioNodeList threw).
- **"Approved guides"** (major): dropped from every support string in ar/en/ckb («أدلة طمطم» / "TamTam's guides") — the
  help centre and every guide say they are demo and unreviewed; one demo line per page stays.
- **Answers, not failed requests:** a refused field (`invalid` with field codes) answers 200 (`answerStatus`, also the
  ticket rating, the wrong-kind references and the trade-in pages); a body that is not a form (400), too large (413) or
  rate-limited (429) keeps its status. `revalidateAfter` reloads nothing after such an answer.
- **Focus after sending a repair:** the status page's «استلمنا طلب الصيانة» is an h2 that takes focus (it was a newly
  mounted `role=status`, focus fell to `<body>`).
- **English composer hint** «Your device or the problem» (193px in the 236px field at 360; was 286px, clipped).
