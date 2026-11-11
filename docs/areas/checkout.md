# Checkout area

Owner: checkout. Cart, guest checkout, order confirmation, guest tracking and the transfer proof upload (brief §4,
§12, §14; DESIGN.md §8.5–8.6, §9.17–9.18). UI over the commerce core only (CONTRACTS §1): nothing here writes a
commerce table, prices anything or decides access — `checkout.server.ts` reads, `placeOrder` / `submitPaymentProof`
write. Files: `app/routes/storefront/checkout/**`, `app/routes/api/upload-proof.ts`, `app/i18n/messages/checkout.ts`,
`tests/checkout-flow.test.ts`.

## Routes

| Path | What |
|---|---|
| `/cart` | `CartLineRow` list (stepper, remove + undo, out-of-stock / unavailable / quantity reduced / price changed), discount code with the server's exact refusal (`errors.coupon_<reason>`), `OrderSummary`, one commit key "إتمام الطلب" (glass task bar < 1024px, under the summary ≥ 1024px), the shelves that complete the cart (devices area, streamed). Empty: "سلتك فارغة. دورك." + one key back to the shop. Edits through `~/ui/cart-client` (optimistic, rolled back with a sentence) |
| `/checkout?step=address\|payment\|review` | Guest by default ("أكمل الطلب بدون حساب", sign-in is a link). Address: phone (Iraq-aware, instant: "ينقص الرقم 5 أرقام…"), recipient (optional), governorate (19, fee stated), district (or "not in the list"), area, full address, notes, preferred day/time chips with "هذا وقت مفضّل وليس موعداً مؤكداً. نتصل بك لتأكيده.". Payment: only methods switched on in settings — COD, wallet (signed-in only, balance and what remains), Mastercard transfer and Zain Cash with the account/number from settings, copy keys, fraud warning, "upload the proof within N hours after confirming"; never a card field. Review: editable blocks (links back to each step and to the cart), problem lines, unticked marketing consent, "أكّد الطلب" |
| `/order/:ref` | `?t=<accessToken>` (guest) or the signed-in owner; anyone else gets the same 404 "cannot open" page with a link to /track. Status + next step per method, transfer instructions + deadline + `ProofSection` (amount typed first, reference, note, `ProofUploader`), "بانتظار التحقق" after upload, the reviewer's reason and the uploader again after a rejection, timeline, items and totals, delivery (preference disclaimer), shipments, refunds, save-the-link panel, optional account panel |
| `/track` | Reference + phone (POST, never in the URL) → `lookupGuestOrder` (rate-limited; one sentence for a wrong reference or a wrong phone) → the same order view, read-only (uploading needs the confirmation link) |
| `POST /api/upload/proof` | multipart `ref`, `t?`, `declaredAmountIqd`, `reference?`, `note?`, `file` → `{ ok: true, previewUrl }` or `{ ok: false, code, fields? }` (what `sendProof` reads). Order of work in `proof.server.ts`: size + per-IP limit → fields → access (customer or token; 404 otherwise) → per-order limit → `canUploadProof` (409 `proof_not_expected` / `payment_window_closed`) → `saveImageUpload` private, kind `payment_proof` (type by bytes, ≤ 8 MB, metadata stripped) → `submitPaymentProof`; a refusal after storing deletes the file. `duplicateOf` never leaves the server. `previewUrl` (server pass, 2026-11-11) = `shopperFilePath(fileId, token)` → `GET /api/files/<fileId>[?t=<token>]`, the shoppers' private-file route (server core): the order's token or the owner's session on every request, `private, no-store`, 404 for anyone else — so the URL keeps working after a reload |

All four pages: `shellMeta(…, { noindex: true })`, `Cache-Control: no-store`, strings in `checkout` + `errors`.
Cart and checkout replace the tab bar (`handle.shell.tabBar = false` + `<TaskBar>`); cart → checkout steps → order is
one sideways-push group (`handle = { nav: "push", order, group: "checkout" }`).

## How the checkout behaves

- **State:** the draft lives in the page (a language switch keeps the route mounted) and in this tab's
  `sessionStorage` (`tt:checkout`: a reload, Back from the cart); the order page clears it. Moving between steps is a
  `?step=` change with no loader call (`shouldRevalidate`), Back walks the steps, deep links to a later step fall back
  to the first unfinished one.
- **Checks:** on blur, again on every keystroke once a problem shows; "continue" checks the step and focuses the first
  bad field. The server checks everything again; its field errors land on the right step (`errors.<key>`).
- **Totals:** the summary is always the server's CartView. Choosing a governorate re-prices through
  `GET /api/cart?governorateId=` (an override fee would show; pending/failed states say so). `expectedTotalIqd` = the
  total on screen; `totals_changed` shows the fresh cart and asks again.
- **Idempotency:** one attempt key per checkout and per cart (kept with the draft and the cart id; a new cart gets a
  new key), resent on any retry; a lost answer offers "اعرض طلبي" on the empty cart, which asks again with the same key
  (the core answers with the order it placed). A refusal (`totals_changed`, a coupon this phone already used, sold
  out, rate limit…) is shown at the top of the review, scrolled into view, with the fresh cart and the coupon's reason.
- **Without script:** all three steps show, one plain post places the order through the same action, refusals come
  back with the posted values. The district list and the proof upload need script.
- **Offline:** the commit key goes flat with "لا يوجد اتصال. تفاصيلك محفوظة…"; uploads that drop say where they stopped.

## Real, demo, boundary

- Real: guest checkout, all four methods as switched in settings, stock holds, idempotency, proof upload to private
  storage, tracking, rate limits (the core's presets: checkout 10/10 min per IP and phone, lookups, uploads 20/10 min).
- Demo: prices and stock (the shell's ribbon); orders placed in demo mode say "طلب تجريبي…" on the order page.
- Boundary: linking a guest order to an account needs a phone code — no SMS provider, the order page says so. No
  notification is sent when staff approve or reject a proof (no provider); the shopper sees it on the order page.
  The stored proof can be shown back to its shopper: the upload answers with `previewUrl` (the private-file route
  `GET /api/files/:fileId`, server core). The order page itself does not show the stored picture after a reload yet —
  the slot for this area: in the order page's loader, `latestProofFileId(db, ref)` (payments) + `shopperFilePath(fileId,
  access === "token" ? token : null)` (storage) → `ProofUploader`'s `current.previewUrl` / the "بانتظار التحقق" panel;
  until then the picture just sent is shown from the browser's own copy.

## Verified (2026-11-11, headless Edge against the dev server; scripts in the session scratchpad `work/checkout/`)

- `npx vitest run tests/checkout-flow.test.ts` — 16 tests on a real local D1 + KV: phone rules, step checks, amounts,
  attempt keys; guest COD with the confirmation link; double submit = one order; totals changed with the fresh cart;
  field errors; wallet refused for guests; sold-out race; proof upload stored private without its metadata, order →
  `payment_review`; refusals store nothing (wrong token/ref, no amount, not an image, > 8 MB, already under review,
  COD); rejected proof replaced, reused picture flagged but never in the answer; owner without token; closed window;
  tracking answers a wrong ref and a wrong phone identically; page data (19 governorates at 5,000, settings); one
  Zain Cash order over the demo catalogue (product chosen by properties).
- `flow.mjs` (0 failures): empty cart; cart; refused and applied coupon; empty-step errors + focus; "ينقص الرقم 5 أرقام";
  missing district; payment required; Back keeps the form; COD order, badge 0, draft cleared; bank transfer (en,
  1440) with settings' card/recipient, amount-first uploader, "Pending verification"; Zain Cash (ckb, dark) with a
  refused non-image, an oversized photo refused before upload, success; /track wrong phone vs right phone; totals
  changed; a coupon already used with this phone dropped with its reason; double submit over HTTP → one `Location`;
  order link without token → 404; language switch keeps the form. `interrupt.mjs`: upload cut at 10 % → "توقّف الرفع
  عند 10%" → "أكمل الرفع" lands; a lost answer → retry shows "بانتظار التحقق" (no second proof). `nojs.mjs`: no script.
- Screenshots `.shots/checkout/` (390 and 1440, light and dark, ar / en / ckb, reduced motion); no horizontal
  overflow; no console errors or hydration warnings besides the contract's own 4xx answers.
- Not checked: Safari, Firefox, real phones; the wallet path in a browser (needs a signed-in customer with balance —
  covered by the core's tests and the guest refusal here). The browser checks left about 24 demo orders
  (TT-WVMBNFEE … TT-WMSVSYCF) in the dev database; COD ones hold their stock until staff cancel them.

## Cross-area pieces (wired by the integration pass, 2026-11-11)

- Recommendation shelves (devices area): the cart's loader streams `cartShelves` (context "cart", anchored on every
  line — a used unit through its catalogue variant), the order page's `orderShelves` (context "post_purchase", the
  order's variants, read only after access was granted) — `checkout.server.ts`, never awaited, never rejecting.
  `components/RecommendationsSlot.tsx` draws them with the shared `devices/components/RecommendationShelves`
  (`layout="column"`: four cards across in the main column from 1024). Placement keeps the funnel rule: on phones after
  the summary (cart) and after the order's own panels (order page — saving the link comes first); from 1024 under the
  lines / the order, beside the sticky summary column. The engine hides what is already in the cart, drops sold-out
  products and recommends add-ons only when VERIFIED on a device in the cart / order ("يكمّل Switch 2 الذي في سلتك").
- The purchase signal (devices area): `checkout.tsx` action → `recordPurchase` (checkout.server) after `placeOrder`
  returned a NEW order (`replayed: false`): one "purchase" event per product, only with personalization consent (the
  account's answer, else `tt_consent`); a consenting guest without a `tt_rs` key gets one there. Never inside the
  commerce core; a failure is logged and never touches the order or its redirect.
- Saved address (account area): a signed-in customer's checkout starts from `getDefaultAddress` (`addressPrefill`: only
  a governorate the checkout serves; a district no longer listed is left to choose; recipient/phone from the address,
  else the account's) — every field stays editable, the address step says "بدأنا بعنوانك المحفوظ «…»…" with "ابدأ بعنوان
  فارغ", the address book is never changed. A tab's own stored draft wins; one without any delivery details (begun
  before signing in) takes the saved address.
- Sign-in links go to `/account/login?next=…`; the account offer links `/account` (account area).
