# Support area — support centre, guides, maintenance assistant, repairs

Owner: storefront area "support". Brief §7, Design System v2 spec §6.13 (templates), §6.17 (states), §9 (copy);
CONTRACTS.md §3 (support row). Files: `app/routes/storefront/support/**` (pages, `components/`, `support.css`),
`app/server/services/support/**`, `app/i18n/messages/support.ts`, `tests/support.test.ts`. No API route: photos travel
with the form that needs them.

## Routes (Design System v2, stage 3)

| Path | Shell | What | States |
|---|---|---|---|
| `/support` | store | the four-segment support navigation (الأدلة current: the assistant and repair tracking one tap away); h1 «كيف نساعدك؟» (title «مركز الدعم»); a search box for a problem or an error code (`?q=`: a danger sign first, an error code with the guides that mention it, or guides ranked by the words); four task tiles (تتبّع طلبك → `/track` · صيانة جهاز → `/support/repair` · الإرجاع والضمان → `/policies/returns` · تحدّث مع موظف → the hand-off); the device picker (platform segmented control, then that platform's device tiles — a rail with 2.5 tiles below 768, a wrapping `auto-fill minmax(150px)` grid from 768; whole model names, never clamped; every platform's list is in the page: with script the control shows one, without script the control is hidden and the lists follow one another under their platform's name); `?device=<slug>` opens the device's panel (photo, assistant / repair keys, the devices area's hub link, its guides); six suggested guides in staff order (`?guides=all` lists every one); «تحدّث مع موظف»: the store's `ContactCard` when channels are configured, «اكتب لموظف» (the hand-off, with its sentence) when not | search: danger · code found / not found · results · zero results; device chosen · device without guides; no guides at all; demo line |
| `/support/article/:slug` | store | the four-segment support navigation (الأدلة current; on phones it is the way back — breadcrumbs start at 768), then one approved public guide in a 720px reading column via `<Blocks>` + "still not solved?" (primary «ابدأ المساعد», secondary «احجز صيانة») + related guides | Arabic fallback note · "not yet reviewed by a store technician" · demo line · 404 |
| `/support/assistant` | task | compact head (title, «ليس تشخيصاً» chip that opens how the assistant works, demo tag), the safety note collapsed to «للسلامة: لا تفتح الجهاز» (opens by itself on a danger stop, battery, the power tree or any warning), the conversation (shopper bubbles on `--niche` at the inline end, assistant bubbles on paper at the start, 8px corner on the speaker's side), replies as chips (platform chips with dots, 88×88 device image chips), «تحدّث مع موظف» (secondary) + «ابدأ من جديد» (quiet link); the composer in the glass task bar below 1024 (enabled from the first question, «اكتب اسم جهازك أو المشكلة», the red send key), at the end of a 720px chat column from 1024 with the device card and its guides in a sticky aside; `?handoff=1#handoff` = the hand-off form; `?ticket=SP-…&tk=…` = its receipt, with «انسخ رابط الصفحة» (the link is the only way back to the reply) | device · model · problem · steps · done (resolved / guide / part / repair / staff) · danger stop (typed before or after the device) · error code with / without a guide · unmatched words · a problem typed before the device (`need_device`) · a name that only points at a platform («PS5 Slim» is also the Slim Digital Edition, «Xbox»): the model is asked and the name never comes back as the problem · hand-off form (validation summary, offline, network failure kept in place) · receipt (status, staff replies or «لا ردّ بعد.», copy link) |
| `/support/repair` | task | three steps `?step=device|photos|contact` (الجهاز والمشكلة → الصور → التواصل والتسليم), one form (fields stay mounted between steps; `shouldRevalidate` skips the loader for step changes); step rail (compact below 768); "what happens next" (4 steps) and the fact strip (الدفع: بعد موافقتك على عرض السعر · صورك والرقم التسلسلي: يراها موظفونا فقط) above the form on step 1 below 1024, in a sticky aside from 1024; the task bar «رجوع \| تابع» (the last step «أرسل طلب الصيانة») below 1024, the same keys at the end of the form from 1024 — «رجوع» is the browser's Back when the step was reached by «تابع» (`client.ts` `stepBack`; history stays one line, so the browser's Back / Forward walk the steps in order); hand-over as OptionCards; the preferred time as `PreferencePicker` (the period alone: no day until the owner configures dispatch days) | per-step validation with the error summary; server field errors take the shopper to the step of the first one; uploading photos; offline (key flat + reason); network failure (form kept; nothing of the route reloaded — `revalidateAfter`); rate limited; without JavaScript every step shows and the key sends the form |
| `/support/repair/status` | store | a 560px lookup card (رقم الطلب «مثل ⁦RP-7K4M2Q9X⁩», رقم الموبايل, primary «اعرض حالة الطلب»), then the request card: reference (type-code, LTR, copy key), status in words with its sentence, quote (+ «تحدّث مع موظف» to approve or ask), device, sent, photos, hand-over, preferred time, the shopper's description, the status timeline with dates; just created: «انسخ رابط الصفحة» (without `new=1`). Headers (`support.server.ts` `repairStatusHeaders`): the card behind its private link `no-referrer`; a page that shows the lookup form `same-origin` — under `no-referrer` a script-less lookup posted `Origin: null`, which React Router and the store refuse (400) | lookup · not found (same answer for a wrong reference or phone) · rate limited · created · replayed · every repair status, quote pending / approved · the lookup without script |

Every support page shows the four-segment navigation (`SupportNav`, a link `Segmented`: الأدلة · المساعد · احجز صيانة ·
تتبّع; the support centre and the guides are «الأدلة»); the
route handles (`nav: "push"`, `order` 0 · 1 · 2 (+ step/10) · 3, `group: "support"`) give the sideways push between
them and between the repair steps. One "talk to a person" destination everywhere: `/support/assistant?handoff=1#handoff`,
«تحدّث مع موظف» / "Talk to a person", copy «نرسل محادثتك إلى موظف مع رقم طلب تتابع به ردّه.».

One red primary per view: the search key (support centre), the composer's send key (assistant), «أرسل إلى موظف»
(hand-off form), «تابع» / «أرسل طلب الصيانة» (repair), «اعرض حالة الطلب» (status lookup), «ابدأ المساعد» (article).
The two result views — the hand-off receipt and a repair's status card — have no forward action, so no primary.

## Components (`app/routes/storefront/support/components/`)

| File | Exports |
|---|---|
| `parts.tsx` | `SupportNav`, `Name` (the kit's `BidiLabel`), `PlatformName`, `GuideRow`/`GuideList` (rows between hairlines in a paper card; `plain`; `.sup-guides--cols` = two columns from 1024), `DeviceArt` (a `Niche` well; handheld PCs use the wide fit), `DeviceTile`, `deviceFit`, `SafetyNote` (callout: paper, 3px tone bar, icon + the tone's word), `CopyKey`, `CopyLinkKey` (copies this page's private link; Clipboard API, then a selection, else «لم يُنسخ»), `UpdatedOn` |
| `Conversation.tsx` | `Conversation({ view, replies })` — `replies={false}` hides the reply chips while the hand-off form or its receipt shows |
| `HandoffPanel.tsx` | `HandoffForm`, `HandoffReceiptCard` (status + staff replies), `HandoffReceipt` |
| `PhotoPicker.tsx` | `PhotoPicker` (the proof-uploader look: dashed paper area, 96px thumbnails, 32px remove keys), `acceptPhotos`, `PHOTO_TYPES`, `PHOTO_MAX_BYTES` |

Client helpers (`client.ts`): `keepFormOnFailure` (clientAction), `revalidateAfter` (shouldRevalidate: a request that
never reached the store reloads nothing — assistant, repair and status routes), `stepBack`, `isFailure`,
`fieldMessage`, `formMessage`, `phoneProblem`. GET and lookup forms carry `action="."` (React Router otherwise writes the
address bar's query into `action`, spelled differently from the server's, and hydration fails on `?q=` with spaces).

Page CSS: `support.css` (`.sup-*`, components layer, tokens only, logical properties, `--r-*` radii). Kit components
used: Key, IconKey, Segmented, Chip, Niche, Render, TextField/TextArea/Select/Checkbox/OptionCard/FieldGroup/
FormErrorSummary, PreferencePicker, ProgressSteps, SectionHead, ContactCard, EmptyState, DemoNote, Status, Price,
TextLink, Breadcrumbs, Blocks, BidiLabel; shell: TaskBar, `chrome: "task"`. No retired kit names remain.

## Services (`app/server/services/support/`) — signatures kept, additions only

| Module | Exports |
|---|---|
| `kb.server.ts` | `getSupportDirectory`, `listArticlesForDevice(db, locale, deviceModelId, { related? })` (contract), `listArticlesForPlatform`, `listArticlesByTag`, `listHelpArticles`, `findArticlesMentioning`, `getArticle`, `listRelatedArticles`, `findDevice`, `findPlatform`; **new** `searchHelp(db, locale, q)` → `HelpSearch \| null` |
| `assistant.server.ts` | `runAssistant(db, locale, state, { model? })` → `AssistantView` — now also reads words typed before a device: a danger sign stops at once, a device's name chooses it (its words are dropped when they only name it), a platform's name asks for the model, a problem waits for the device (turn kind `need_device`); `handOffToStaff`; `AssistantModel` + `configuredAssistantModel()` (null); `checkTree` |
| `tickets.server.ts` | `createSupportTicket` (contract); `getTicketByAccessToken` → `TicketReceipt` now with `replies` (staff, non-internal, oldest first); `planSupportTicket`; `SUPPORT_ERROR_KEYS` |
| `repairs.server.ts` | `createRepairTicket` (contract); `getRepairByAccessToken`; `lookupRepair` |
| `matcher.ts` | `interpretText`, `findErrorCode`, `normalizeForMatch`; **new** `matchDevice(text, directory)`, `hasDangerSign`, `describesProblem`, `tokenMatches`, `KNOWN_SYMPTOMS` |
| `state.ts`, `summary.ts`, `types.ts` | client-safe: URL state, the conversation summary, view models (+ `HelpSearch`, turn kind `need_device`) |
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
npx vitest run tests/support.test.ts        38 tests: URL state, refs, days, matcher (+ device names, danger, problem),
                                            KB visibility, help search, tree replay and safety, words typed before a
                                            device, a name that only points at a platform, model boundary, hand-off
                                            (consent, storage, idempotency, race, photos, limits, receipt replies), copy
                                            rules (no call promise, glossary, key parity, phone examples and RP- codes
                                            isolated and unbreakable in ar/ckb), kept forms (`revalidateAfter`),
                                            status-page headers (`repairStatusHeaders`), repair steps' «رجوع»
                                            (`stepBack`), repairs
node scripts/lint-design.mjs app/routes/storefront/support app/server/services/support     0 findings
```

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
- Error codes: no approved guide mentions one yet, so the search and the assistant say so and offer a person.
- The matcher and the device-name aliases are keyword-based; Sorani vocabulary needs a native reader.
- No SLA policies are seeded, so new tickets carry no due times until the admin sets policies.
- A dropped connection during a send: the support routes keep the form, but `app/root.tsx` `shouldRevalidate` always
  reloads the root after a POST, and that reload fails too — the root's error panel replaces the page (lead's file).
- Opaque photos (Nintendo Switch Lite, PS5 2020) keep their white box on the light ground: `.render { isolation:
  isolate }` (and the slot's size containment) stop the `multiply` blend (styles owner).
- At 320px the last repair step's «أرسل طلب الصيانة» is cut with an ellipsis in the task bar (fits from 360).
