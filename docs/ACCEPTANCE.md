# Acceptance — the client's brief §14 and §12, proven

Run: **2026-11-12**, acceptance agent, against the local dev server (http://localhost:5173, `STORE_MODE=demo`, the clean demo
catalogue) and a throw-away local D1 for the automated tests. Every criterion of the brief (`TamTam_Fable_Master_Prompt.md`
§14 "Acceptance tests" and §12 "Screen/state matrix") that applies to the storefront and the admin is a check:

- **automated** — `tests/acceptance-*.test.ts` (vitest on `tests/helpers`, real local D1, real services and route modules,
  staff holding exactly the permissions of a built-in role): **63 tests, all green** (`npx vitest run tests/acceptance-*.test.ts`).
- **in the browser** — puppeteer flows against the dev server, kept with their results and screenshots in
  `C:/Users/levon/AppData/Local/Temp/claude/2771cc8b857f7e52/f7de9c1b-8343-4c70-bd04-00bb84d9fe52/scratchpad/work/acceptance/`
  (`flow-*.mjs`, `admin-*.mjs`; each writes `data/<flow>.json` — every check with its detail and screenshots in `shots/`).
  Totals: see "Counts" below. Admin flows sign in **once per role** (the owner hired one demo employee per built-in role
  through the staff module's own UI) and reuse the cookies.

Result legend: **pass** · **fail** (with its owner and cause) · **n/a** (does not apply to storefront/admin, with the reason).
Evidence names: `T:` an automated test (file › test title prefix), `F:` a browser check id (`data/<flow>.json`), `S:` a
screenshot in `shots/`.

## Counts

| Scope | pass | fail | n/a |
|---|---|---|---|
| Brief §14 — 14 criteria | 13 | 0 | 1 (LCP/INP of #14 — no production build on real devices here) |
| Brief §12 — 23 states and conditions, plus the 44 px census | 23 | 1 (F2) | 0 |
| Admin — 23 modules (the owning role's main workflow + the 403 for a role without it) | 23 | 0 (F1 fixed by the lead, 2026-11-12) | 0 |
| Admin — 5 blueprint workflows | 5 | 0 | 0 |
| Automated tests `tests/acceptance-*.test.ts` | 63 | 0 | — |
| Browser checks recorded (`node summarize.mjs`) | 1,905 | 103 — 99 are F2 (the same demo strip on every page × language at 390 px), 1 is F1, 3 are the two layout-shift regressions as first measured (fixed; re-measured: pass) | — |

The failures, each with its owner and exact cause, are in "Failures" below. Two failures found during the run were small
and inside storefront page files; they are fixed ("Fixes made").

## Brief §14 — acceptance tests

| # | Criterion | How it is proven | Result |
|---|---|---|---|
| 1 | Guest can purchase without registering, with required phone/governorate/area/address and optional notes/preferred delivery time | T: acceptance-checkout › 14.1a, 14.1b, 14.1c · F: `checkout.{cod,bank_transfer,zaincash}.*` (no forced sign-in, required fields named with `aria-invalid` + summary, optional fields kept, the time explained as a preference, marketing consent never pre-ticked, editable review, confirmation with the reference, an account offered never forced, guest tracking by reference **and** phone — a wrong phone reveals nothing) · S: `checkout-*-2-required`, `-5-review`, `-6-confirmation`, `-11-track` | **pass** |
| 2 | Every governorate applies exactly 5,000 IQD unless an explicitly configured override is enabled | T: 14.2a (an order placed to each of the 19 governorates: 5,000 on the page data, the cart and the stored order), 14.2b (an override only applies once an employee with `settings.shipping.manage` switches overrides on; fulfillment is refused) · F: `checkout.*.review.shipping`, `content.policy.shipping.*` | **pass** |
| 3 | Wallet payment deducts only after a safe atomic ledger transaction; guests cannot access another user's wallet | T: 14.3a (one purchase row in the order's batch, balance down by exactly the total), 14.3b (insufficient → nothing debited, no order), 14.3c (two concurrent orders: one placed, never an overdraft), 14.3d (a guest is refused; a posted customer id is ignored) · F: `wallet.*` (top-up with proof → «awaiting verification» → finance approves in admin 10 → the wallet pays an order at once, ledger and balance exact), `checkout.*.methods` (wallet disabled for a guest) · S: `wallet-7-payment-390`, `wallet-9-order-390` | **pass** |
| 4 | Mastercard/Zain Cash transfers require amount and proof; the order stays pending until an authorized person approves | T: 14.4a (both methods: unpaid → proof without amount refused → pending verification → fulfillment/support/cashier/a customer cannot approve → finance approves → paid with the verifier recorded), 14.4b (a different amount needs the override; rejected → corrected → re-reviewed), W1 step 2 · F: `checkout.{bank_transfer,zaincash}.instructions/copy/proof.*` (Mastercard 9269317427 · علي خليفة, Zain Cash 07719061852, one-tap copy, fraud warning, private file, «بانتظار التحقق من الدفع»), `admin.proofs.*` (finance approves one, rejects the other with a reason the shopper then reads; a re-used receipt is flagged as a duplicate) · S: `checkout-*-4b-instructions`, `admin-flow-1-proofs-queue`, `admin-flow-2-proof-review` | **pass** |
| 5 | The flying add-to-cart never delays the cart update; reduced motion stays fully functional | F: `motion.flycart.{390,1440}.*` (the count is up while the bead is in the air; it lands on the cart bead; the key becomes «عرض السلة»; three rapid taps leave the badge equal to the stored cart; reduced motion: no flight, the count changes at once and is announced) · S: `motion-flycart-*` | **pass** |
| 6 | Product card → detail → back: seamless transitions without breaking URL, history, accessibility or scroll | F: `motion.card.{390,1440}.*` (the product's own URL, one history entry, exactly one view transition with a shared element, Back restores the list's scroll and runs one back transition), `motion.variant.*` (`?v=<sku>` without a reload, deep link opens it, a colour choice replaces the history entry by design), `keyboard.*`, `focus.*` · S: `motion-card-detail-*`, `motion-card-back-*` | **pass** |
| 7 | Language, theme and currency switch with coherent animations and preserved cart/form state | F: `prefs.*` (ar → en → ckb: the checkout's typed phone/area/address and the cart kept; a filtered, sorted list keeps its URL state; dark theme kept across languages; the chosen variant kept; USD shown as a labelled approximation with the rate's source and date while the payable total stays IQD) · S: `prefs-*` | **pass** — the checkout page itself is a focused page with no language/theme control (by design): the shopper switches from the cart and comes back to the same draft |
| 8 | Recommendations respect verified compatibility and stock; guest privacy controls are honoured | T: acceptance-discovery › R1 (every device hub of the demo catalogue: add-ons VERIFIED on that device, never out of stock), R2 (an admin pin of an incompatible product is ignored), R3 (no consent → nothing recorded; with consent keyed by a hash, no IP/UA column; withdrawal forgets) | **pass** |
| 9 | A used listing shows real condition evidence; a trade-in offer requires inspection/approval | T: U1 (grade, checklist, defects, battery, warranty/returns in ar/en/ckb; a maker's photo labelled an illustration; no serial or cost), U2 (the database refuses listing a real unit without evidence), U3 (an estimate range that expires, no offer; the trigger refuses an offer before inspection), W2 · F: `tradein.*` (the estimate shown as a range «not an offer»; sent → a reference and a status page; a wrong phone reveals nothing) | **pass** |
| 10 | The repair AI escalates safely and never claims an unverified definitive diagnosis | T: AI1 (no AI model claimed; danger words in ar/en stop at once with a warning and a repair outcome), AI2 (every approved tree outcome that sends to repair is "needs a check"), AI3 (a hand-off needs consent, then a ticket with the conversation summary) · F: `assistant.*`, `repair.*` · S: `service-assistant-*`, `service-repair-*` | **pass** |
| 11 | Admin roles cannot see hidden supplier costs through UI, export or API | T: acceptance-admin › C1 (the order page's data: cost/margin for the manager, NO cost key for fulfillment/support/inventory — service and the route loader behind the middleware), C2 (CSV: cost columns only with `cost.read` — catalogue variants, orders, inventory value), C3 (the read API's products and orders carry no cost; a key can never hold `cost.read`) · F: `export.*` | **pass** (F1, a broken export and never a leak, is fixed) |
| 12 | No serial sold twice, no negative available stock without authorization, no double refund, no duplicated order/payment on retries | T: acceptance-integrity › I1–I4 (services AND direct writes refused by the database), acceptance-admin › B04 (oversell needs `inventory.oversell.authorize`), W1, W3, acceptance-checkout › 14.12-retry, 12.cart · F: `cart.race.*` (two shoppers, one last unit) | **pass** |
| 13 | All financial numbers reconcile without NaN/Infinity; audit trails are immutable | T: I5 (the daily consistency job finds nothing after sales, a refund and cancellations), I6 (trial balance balances; P&L and cash flow finite; no fraction of a dinar anywhere), I7 (audit and ledgers refuse UPDATE/DELETE/REPLACE; the hash chain seals and verifies), W5 (daily report finite and consistent) | **pass** |
| 14 | Real-world mobile scrolling stays fluid with progressive images; measure Core Web Vitals and fix regressions | F: `sweep.*.cls` — lab CLS while loading and scrolling every storefront page (30) at 360–1440 px in three languages: two regressions found — the empty cart (CLS 0.16–0.22) and the empty compare page (0.13–0.26) — and **fixed** (see "Fixes made"); after the fixes every page < 0.1 (`sweep-light-360_390_768_1440-ar_en_ckb-compare_cartEmpty`) · LCP and INP **not measured**: the shared server is the Vite dev server (unbundled modules), not a production build on a real phone and network | **n/a** for LCP/INP here (needs a production build measured on real devices / field data — owner: lead / performance); the CLS part passes after the fixes |

## Brief §12 — screen/state matrix

| State or condition | Evidence | Result |
|---|---|---|
| default | F: `sweep.*.status` — 30 storefront pages answer 200 (the unknown page 404) at 390 px in ar/en/ckb and at 360/768/1024/1440 px in ar (720/720 checks at those widths) | pass |
| loading | reserved geometry: `sweep.*.cls` < 0.1 on every page after the two fixes (empty cart, empty compare); streamed shelves are server-rendered where they sit on the first screen; no grey skeletons in any screenshot | pass |
| partial data | compare: «غير موثّق» where a product's research is silent (F: `compare.table`, S: `compare-table-390`); used units without a battery figure; currency panel names its demo rate | pass |
| empty | empty cart with the store's picks (S: `sweep-cartEmpty-*`), empty compare (S: `sweep-compare-*`), zero search results with ways on in three languages (F: `search.zero.*`) | pass |
| offline | F: `offline.*` — a banner says the cart is kept on the device; add to cart refused with a sentence (no fake count); navigation keeps the page; back online works | pass |
| validation error | F: `checkout.*.required`, `tradein.required`, `tradein.contact.required`, `repair.required`, `cart.coupon.*`; T: 14.1b | pass |
| API failure | F: `cart.apifailure` (HTTP 500 from the cart service: a sentence, the count unchanged), `checkout.bank_transfer.proof.interrupted`, `offline.add` | pass |
| success | order confirmation, trade-in/repair/ticket references, top-up sent, proof approved (F: `checkout.*.confirmation`, `tradein.sent`, `repair.sent`, `assistant.handoff`, `wallet.*`) | pass |
| pending review | transfer «بانتظار التحقق من الدفع», top-up «awaiting verification», trade-in estimate before inspection (F: `checkout.*.proof.status`, `wallet.topup.request`, `tradein.sent`) | pass |
| unauthorized | admin: 23 modules × 8 roles, each refusal the 403 page before any module code (F: `admin-matrix-1440` 129/129; T: A1–A3); storefront: account pages send a guest to sign in and back (F: `account.unauthorized`) | pass |
| reduced motion | F: `motion.flycart.*.reduced`, `reduced.motion` (reduced tier, no endless animation, navigation without a transition) | pass |
| phone and desktop | F: `sweep.*.overflow` — no horizontal overflow at 360/390/768/1024/1440 | pass |
| Arabic, English, Kurdish coherent | F: `sweep.*.dir` (dir/lang per language), `rtl.*` (logo at the start edge, numbers isolated LTR), policies/about/contact/accessibility in three languages (`content.*`), search in three languages | pass |
| light and dark | F: `sweep-dark-*`, `prefs.theme.dark` · S: `prefs-4-checkout-ckb-dark-390` | pass |
| different currencies | F: `prefs.currency.*` | pass |
| long product names | cards and product pages with the longest names (Zelda 40th Anniversary bundle, «Nintendo Switch 2 + Nintendo Switch Sports Resort Bundle») in the sweep: no overflow, clamped cards | pass |
| unavailable items | F: `cart.soldout` (released, no stock: no add key, the API refuses `out_of_stock`), `cart.comingsoon` (pre-release colour says when it comes) | pass |
| quantity changes | F: `cart.overstock` (stops at the stock and says why), `motion.flycart.*.rapid` | pass |
| coupon rejection | F: `cart.coupon.unknown`, `cart.coupon.minimum`, `cart.coupon.valid`; T: 12.coupon | pass |
| stock race | F: `cart.race.cart`, `cart.race.checkout`; T: 12.cart, I4 | pass |
| interrupted transfer proof upload | F: `checkout.bank_transfer.proof.interrupted` (the connection drops during the upload: a sentence, nothing recorded, the retry works) | pass |
| canceled checkout | leaving the checkout keeps its draft (F: `prefs.language.en`); an unpaid order cancelled by staff releases its stock (T: I1, I2) | pass |
| back navigation | F: `motion.card.*.back`, `motion.variant.*.history`, `keyboard.*` | pass |
| 44 px touch targets | F: `sweep.*.targets` at 390 px in ar/en/ckb — every control is ≥ 44×44 **except the demo strip link** (390×28) on every page | **pass with the documented exception** — F2 (the 28 px demo strip, spec §5.1/§12 row K; still above WCAG 2.5.8's 24 px minimum) |

(The 44 px row is the brief's §10 "sufficient touch targets", listed here because it is measured on every page.)

## Admin — the 23 modules: the owning role's main workflow, and the 403 for a role without it

UI: F: `admin.module.<module>.owner` (the module opens for its owning role, h1 present, no console errors) and
`admin.module.<module>.403` (a role without any of its permissions gets the 403 page; nothing in the console but the
403) from `admin-matrix.mjs`, signed in once per role; the full 23 × 8 grid is `data/admin-matrix-table-1440.md` (all as
the permission model says; the navigation never offers a module that refuses, and offers every one that opens).
Main workflows: T: acceptance-admin › B01–B23 and the blueprint workflows; browser: `admin-setup` (hiring), `admin-flows`
(proofs, confirm → pack → ship → deliver), `wallet.*` (a top-up approved by finance).

| Module | Owning role | Main workflow proven | Refused (403) |
|---|---|---|---|
| 01 dashboard | manager | B01 sales KPIs finite; UI home per role | cashier: no sales figures (field-level, B01) |
| 02 catalog | content | B02 draft product, audited; C2 exports | fulfillment — **pass** (F1 fixed: the whole variant export works for cost.read holders) |
| 03 pricing | manager | B03 price change within limits; W4 landed cost | support |
| 04 inventory | inventory | B04 damage + oversell rule; W4 reorder alert, forecast, receipt | content |
| 05 orders | fulfillment (finance for proofs) | W1; F: `admin.order.*`, `admin.pack.*`, `admin.proofs.*` | content |
| 06 pos | cashier | W5 shift, blind count, sale | support |
| 07 customers | support | B07 customer note | content |
| 08 promotions | manager | B08 coupon; F: `wallet.coupon` | support |
| 09 purchasing | manager (inventory receives, finance matches invoices) | W4 RFQ comparison, PO approval by a second manager, partial receipt, invoice match | support |
| 10 finance | finance | W5 COD settlement, variance review; F: `wallet.topup.approve`; I6 | fulfillment |
| 11 shipping | fulfillment | W5 waybill, pickup, delivery; 14.2b fee override (manager) | content |
| 12 returns | support (inventory inspects, finance refunds) | W3 | content |
| 13 devices | inventory / manager | W2 inspection, offer, wipe, payout, relisting | cashier |
| 14 support | support | B14 staff ticket; AI3 hand-off ticket | cashier |
| 15 staff | owner | B15 hire with a one-time link; F: `admin.hire.*` (seven employees hired and signed in through the UI) | fulfillment |
| 16 marketing | manager | B16 SMS campaign draft | cashier |
| 17 cms | content | B17 banner | cashier |
| 18 reports | finance | W5 daily sales report (finite, consistent); 403 for fulfillment in W5 | fulfillment |
| 19 automation | manager | B19 rule + dry run | cashier |
| 20 security | owner | B20 audit chain verified; I7 | cashier |
| 21 channels | owner | B21 branch; C3 API key (no cost scope) | cashier |
| 22 settings | owner | B22 setting change with reason | cashier |
| 23 ops | manager | B23 incident; I5 consistency job | cashier |

## Admin — the five end-to-end workflows of `docs/admin-blueprint.json`

| Workflow | Steps (blueprint) | Proof | Result |
|---|---|---|---|
| new-device-purchase | Order → Payment verification → Reserve SKU → Assign Serial → Scan-verified fulfillment → Shipping → Delivery → Warranty start → Profit entry | T: acceptance-workflows › W1 (inventory receives serials; guest transfer order; reservation; finance verifies; fulfillment scans the serial — a SKU instead is refused; the same serial never reaches a second order; shipped commits stock; warranty from delivery; sale and COGS posted, each balanced, COGS = the unit's landed cost) · F: `admin.order.*`, `admin.pack.*` in the browser | pass |
| used-device-trade-in | Preliminary valuation → Inspection and ownership check → Price offer → Approval → Receipt and data wipe → Cost entry → Relisting for sale | T: W2 (estimate range, no offer; support cannot inspect; manager inspects with ownership/lock checks; offer; the customer accepts; no payout before the wipe; store credit — one wallet entry, Dr inventory / Cr wallet liability, a repeated payout pays nothing; priced (a second manager decides when the price needs approval), graded, a photo confirmed as this unit, listed — refused for inventory, and refused before the evidence is complete) · F: `tradein.*` | pass |
| game-or-device-return | RMA request → Policy check → Approval → Receipt and inspection → Stock update → Matching refund → Warranty update | T: W3 (support opens, policy window, never approved by its opener, inspection with the sold serial, stock back, refund ≤ the item and by a second person, once; warranty void) | pass |
| stock-repurchase | Minimum-level alert → Demand forecast → Supplier comparison → PO approval → Partial receipt → Invoice matching → Landed cost | T: W4 (reorder point by inventory, cashier refused; below-reorder with a forecast; two quotes compared, the cheaper awarded; the order is above the 1,000,000 IQD spending limit, so a second manager approves — the submitter and inventory are refused; 20 of 40 received once the freight bill is spread (landed cost 29,000 + 2,000 per unit); the invoice bills 40 → three-way mismatch approved with a reason by another person) | pass |
| daily-close | POS/COD/gateway settlements → Variance check → Review of discounts and refunds → Daily report → Shift lock | T: W5 (blind count; COD statement settled once; variance approved by a second person, posted once; a refund reviewed by someone not involved; daily report finite and consistent; the reviewed shift is final) | pass |

## Coverage of the lead's list

| Asked | Where |
|---|---|
| guest checkout with each payment method; confirmation and tracking | §14 #1, #3, #4 — `flow-checkout.mjs` (COD, Mastercard transfer, Zain Cash), `flow-wallet.mjs` (wallet, signed in) |
| the cart's failure states | §12 rows unavailable / quantity / coupon / stock race / API failure — `flow-cart.mjs`; T: 12.cart |
| promotions and points at checkout | T: 12.coupon, 12.points; F: `cart.coupon.*`, `wallet.coupon`, `wallet.pay` (coupon on the order) |
| search in ar/en/ckb (typos, synonyms, zero results) | T: S1–S3; F: `search.*` (`flow-discovery.mjs`), the header's suggestions |
| filters and paging without JavaScript | F: `nojs.*` (GET filter form, sort, next-page link, search form) |
| product page (variants in the URL, Back keeps scroll, shared element) | §14 #6 — `flow-motion.mjs` |
| compare; wishlist as guest then signed in | F: `compare.*`, `wishlist.*`, `account.signup` (`flow-compare-wishlist.mjs`) |
| trade-in wizard; support assistant; repair request | `flow-service.mjs`; T: U3, AI1–AI3 |
| policies, sitemap and robots | `flow-content.mjs` (`seo.*`, `content.*`): drafts are noindex and kept out of the sitemap by design |
| language and theme switches keeping state; reduced motion; offline | `flow-prefs.mjs`, `flow-a11y.mjs` |
| keyboard-only use | F: `keyboard.*` (skip link; add with Enter; cart → checkout filled to the review step with the keyboard), `focus.*` (40 Tab stops on home, product, cart, checkout at 390/1440: every stop visibly marked, none under a sticky bar) |
| 44 px targets; RTL correctness | `sweep.*.targets` (fail F2: demo strip), `rtl.*`, `sweep.*.dir` |
| no layout shift on images; no hydration warnings; no console errors | `sweep.*.cls`, `sweep.*.hydration`, `sweep.*.console` and every flow's `*.console` check |
| 360–1440 px without horizontal overflow | `sweep.*.overflow` |
| admin: each module's main workflow once, the 403, the five workflows | the two admin sections above |

## Failures

| | Failure | Owner | Exact cause |
|---|---|---|---|
| F1 — **FIXED 2026-11-12** (one json_each parameter; T: acceptance-admin › C2b now passes) | The catalogue's **whole variant export** (`/admin/catalog/export?level=variants`, no filter) answers **500** for every role with `cost.read` (owner, manager, finance); filtered sheets and roles without cost work | admin module 02 catalog — `app/server/services/admin/catalog/import.server.ts` `exportVariantsCsv` | the cost lookup is one `inArray(variant_costs.variant_id, variantIds)` over every exported variant: 245 demo variants → "too many SQL variables" (D1 binds at most 100 parameters a statement). Chunk the ids (`chunkRows`) or select through `json_each` like the rows query above it. Pinned by T: acceptance-admin › C2b (flip it when fixed); F: `export.catalog.variants.owner` |
| F2 — **documented exception** (spec §5.1 chrome budget and §12 row K list the 28 px strip as the one target under 44 px; 28 px still meets WCAG 2.2 2.5.8, minimum 24 px; it exists in demo mode only) | The **demo strip** at the top of every storefront page below 1024 px is a link 390×28 px — under the 44×44 target | design system kit — `app/ui/DemoNote.tsx` (`demo-strip` rendered as a `LocaleLink`) and `app/styles/components.css` `.demo-strip { min-block-size: var(--h-strip) }` | a 28 px bar made a link; give it a 44 px hit area (or render it as a non-link notice). Demo mode only: the strip disappears with `STORE_MODE=live` |

Not failures, noted for owners:
- `app/motion/__checks__/check-cart.mjs` (owner: motion) stops with "no add-to-cart key on screen" on the redesigned
  product page (its lookup runs before the sticky buy bar's key is there); the same behaviour passes in `flow-motion.mjs`.
- A coupon below its minimum says «مجموع سلتك أقل من الحد الأدنى لهذا الرمز» without the amount still needed (cart copy).
- The checkout page has no language/theme control by design (a focused page); switching happens on the cart.
- After the sold-out race the losing shopper's checkout shows «الإجمالي 0 د.ع» with «تابع إلى الدفع» still active under
  the notice that sends them to edit the cart (placing is refused by the server) — checkout copy/state.
- The Arabic empty `/compare` keeps a small footer-internal shift after hydration (0.057, under the 0.1 line; the footer's
  own columns, `NAV.shell-fcol`) — shell owner.
- In development the failing variant export (F1) answers with the raw query text in the error body; production hides it.

## Fixes made

| File | Change | Why |
|---|---|---|
| `app/routes/storefront/checkout/cart.tsx` | the EMPTY cart's four picks are awaited in the loader (`await emptyCartShelves(…)` — it never rejects); a cart with lines still streams its suggestions | streamed in after the first paint, the picks pushed the footer — on the first screen of an empty cart — down by a whole shelf: CLS 0.22 (ar) / 0.16 (en) at 390 px. After the change the shelf is server-rendered before the footer and CLS is 0 at 360–1440 in ar/en/ckb; `tests/checkout-flow.test.ts`, `integration-wiring`, `storefront-wiring` and `tsc -b` stay green |
| `app/routes/storefront/catalog/compare.tsx` | before hydration the script-only block of an empty `/compare` holds the empty state's own geometry, invisible and `aria-hidden` (it rendered nothing in a 320 px reserve) | the empty state is 332–361 px tall, so the footer — on the first screen — moved when it appeared: CLS 0.13–0.26 at 390 px. Now the block has the same height before and after hydration (measured 360–1440 in ar/en) and CLS is 0 (en, ckb) / 0.057 (ar, a footer-internal shift) — under 0.1 everywhere; no wrong content is ever shown beside a saved list (the copy is unseen); `tests/catalog-listing`, `catalog-cards` and `tsc -b` stay green |

## Re-run

```
npx vitest run tests/acceptance-checkout.test.ts tests/acceptance-workflows.test.ts tests/acceptance-admin.test.ts tests/acceptance-discovery.test.ts tests/acceptance-integrity.test.ts

# browser flows (scratchpad …/work/acceptance; the dev server must be up)
node admin-setup.mjs                      # once: the owner hires one demo employee per role and each signs in once
node flow-checkout.mjs cod,bank_transfer,zaincash 390 ar
node admin-flows.mjs <bankRef> <zainRef>  # finance approves / rejects the proofs
node admin-flows.mjs "" "" <codRef>       # manager confirms, fulfillment packs, ships, delivers
node flow-wallet.mjs · flow-cart.mjs · flow-prefs.mjs · flow-discovery.mjs · flow-compare-wishlist.mjs
node flow-service.mjs · flow-content.mjs · flow-motion.mjs · flow-a11y.mjs · admin-matrix.mjs · admin-export.mjs
node flow-sweep.mjs 390 ar,en,ckb · flow-sweep.mjs 360,768,1024,1440 ar · flow-sweep.mjs 390,1440 ar <pages> dark
node summarize.mjs --failures
```

Orders, customers, employees and requests created by these flows are DEMO rows in the local database (demo store mode).
