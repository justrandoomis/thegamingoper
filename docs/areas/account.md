# Account area

Owner: account. Sign-in and sign-up, the customer's account pages, favourites (brief §3.10, §4, §6, §12, §14;
DESIGN.md §8, §9.16, §9.19, §11). Files: `app/routes/storefront/account/**`, `app/routes/api/wishlist.ts` (+ its line in
`app/routes/api/_routes.ts`), `app/server/services/account/**`, `app/server/services/wishlist.server.ts`,
`app/i18n/messages/account.ts`, `tests/account.test.ts`, `tests/wishlist.test.ts`.
Orders, payments and the wallet ledger are the commerce core's (CONTRACTS §1): read through it, never written here.

## Routes

| Path | What |
|---|---|
| `/account/login` | Phone + password (`signInCustomer`). One sentence for a wrong password or an unknown number; rate limits say how long to wait. `?next=` (safe, locale-less) comes back after sign-in; a signed-in visitor goes straight there — so checkout never asks twice. Panel: no account is needed to order (track an order, keep shopping) |
| `/account/signup` | Name (optional), phone, password, an UNTICKED offers box (a consent row only when ticked), "your number stays unconfirmed: no SMS yet", terms/privacy links |
| `/account/forgot` | Password reset by code — the SMS boundary: production says codes cannot be sent and links `/contact`; development creates the code, shows it labelled "وضع التطوير فقط", resets and signs every device out |
| `POST /account/logout` | Ends this session, drops `tt_cart`/`tt_wish` (they point at the account's things now) → `/account/login?signedout=1`. GET only redirects |
| `/account` | Greeting, wallet balance (+ top-ups under review), open orders, latest order, unconfirmed-number line, the section list (phones), recently viewed (consent-aware), sign out |
| `/account/orders`, `/orders/:ref` | `listOrdersForCustomer` (10 at a time, "show more" appends) · `getOrderForCustomer` (another customer's ref = 404 in the account frame): statuses in words, payment and what to do now (transfer details, deadline, rejected-proof reason; upload happens on the checkout area's `/order/:ref`), lines with warranty as sold, `OrderSummary` of the server's totals, delivery with the preference disclaimer, shipments, refunds, help and "ask for a return" links to support |
| `/account/wallet` | `WalletBalance` = ledger sum + ledger (paged) + pending top-ups; top-up REQUEST: method (only those switched on), the store's details from settings with copy keys, fraud note, amount (Arabic digits understood), reference, `ProofUploader` → private file → request `pending_verification`; list with status, the store's reject reason, private proof link, cancel (confirm dialog) |
| `POST /account/wallet/proof`, `GET …/proof/:fileId` | Resource route: upload pipeline → private file `wallet_topup_proof` → `{ ok, fileId, previewUrl }`; the image is served to its uploader only (404 otherwise), `no-store` |
| `/account/addresses` | Cards (default first) + form in the URL (`?new=1`, `?edit=<id>`): label, recipient, phone, governorate → districts of that governorate (the shipping service's lists; all, grouped, without script), area, address, notes, default; every field error at once. Delete asks first |
| `/account/devices` | Published device models by platform (LED labels); each name links to its hub `/device/<slug>`; "أملكه" is a held toggle (announced; a refusal says why) |
| `/account/returns` | General window (`returns.window_days`) + policy link, how to ask (support with the reference — no return form exists), delivered orders inside the window, RMAs staff opened (no staff notes) |
| `/account/warranties` | Warranty rows started at delivery, state from the dates, claim → `/support/repair?order=` |
| `/account/notifications` | In-account messages (paged), read one / all. Nothing produces them yet |
| `/account/profile` | Name, e-mail, language of store messages (audited); phone shown masked with its state, not editable (needs a code) |
| `/account/settings` | Order-message channels (stored; "no provider is connected" said plainly), offers + personalization consents (append-only, never pre-ticked; the device's `tt_consent` follows via home's `saveConsent`), phone confirmation (same boundary as reset), password change (other devices signed out), signed-in devices (one / all others). Since 2026-11-11 (server pass) a password change or a confirmed phone number moves THIS device to a new session token: the action's answer carries the new `tt_sid` (set by `changeCustomerPassword` / `confirmCustomerPhone` on `ctx`, no change at the call sites), the old cookie and any copy of it stop working; the device keeps its "since" date |
| `/wishlist` | Cards from the catalogue read layer, "remove" under each card + undo toast, products no longer sold counted not shown, guest note with sign-in |
| `/api/wishlist` | GET `{ ok, ids }` · POST `intent=toggle\|add\|remove, productId` → `{ ok, wished, count }`; 400 / 404 / 409 `wishlist_full` / 429; what `~/ui/WishlistKey` calls |

Every page: shell meta with `noindex`, no `<main>` (h1 first), `/account/*` is `no-store` (security headers) and
`/wishlist` sets `private, no-store`. Signed-in pages share a layout (side section list from 1024px, `data-motion-persist`
so it stays while sections push sideways; back link on phones) and every loader/action calls `requireSignedIn` itself.
Navigation grammar: sections are push siblings (`handle.order` = their order), order detail rises, the entry pages are a
push group. Strings: the `account` namespace; account error keys live under `account:errors.*` (the only copy: since
2026-11-11 the shared `errors` namespace adopts them by import, so a screen outside this area can say them — keep
`account:errors.*` exactly in step with `ACCOUNT_ERROR_KEYS`; `tests/commerce-money.test.ts` checks it), the rest come from
`errors` — actions translate on the server (`errorT` looks in both) and return sentences, so `errors` never ships.

## States (brief §12)

Default · loading (keys spin in place; "show more" appends, no skeletons) · partial (products no longer sold counted;
unpublished saved devices left out) · empty (orders, wallet, addresses, devices, notifications, returns, warranties,
favourites — one sentence, one key; "دورك." only there) · offline (submit keys go flat with the reason) · validation
(field sentences, values kept, focus on the form sentence) · API failure (sentence + nothing changed; loader failures
render inside the account frame or the shell's panel) · success (notices / toasts) · pending review (top-ups, transfer
proofs) · unauthorized (redirect to sign-in with `next`) · reduced motion (engine).

## Real, demo, boundary

- Real: accounts and sessions (server core), addresses, saved devices, consents history, notification preferences,
  favourites (guest + account + merge), top-up requests with private proofs, reads of orders / wallet / warranties / RMAs.
- Demo: everything the shell marks (prices, stock); orders placed in demo mode say so.
- Boundary: no SMS/WhatsApp/e-mail provider (codes unavailable in production; channel choices stored, not delivered);
  phone numbers stay unconfirmed; no storefront return form or warranty claim service (support links); approving or
  rejecting top-ups is an admin job not built yet; nothing writes notifications yet.

## Guest favourites and the cart cookie

Guest rows carry sha256(`tt_cart`). The cart service mints a new token for a guest's first cart and for the cart after an
order, so a guest without a cart gets a token here kept in `tt_wish`; whenever both cookies differ, the next wishlist
call moves the rows to the cart token (`reconcileGuestWishlist`). Sign-in moves everything into the account and deletes
the guest rows. `getWishlistIds(db, { customerId, cartToken })` (contract) works alone; `wishlistWho(ctx.cookie, id)`
also passes `tt_wish` and sees moved rows at once.

## For other areas (exports)

- `wishlist.server`: `getWishlistIds`, `toggleWishlist`, `setWished`, `isWished`, `wishedAmong`, `mergeGuestWishlist`,
  `wishlistWho`, `rekeyGuestWishlist` (for the cart, should it ever re-key a guest cart in place).
- `account/addresses.server`: `listAddresses`, `getDefaultAddress` (checkout prefill) · `account/saved-devices.server`:
  `listSavedDeviceIds` (recommendations) · `account/recently-viewed.server`: `recordRecentlyViewed(db, who, productId,
  now, { consent })`, `mergeDeviceRecentlyViewed(db, customerId, [{ id, at }], now, { consent })`, `listRecentlyViewed`,
  `clearRecentlyViewed` · `account/notifications.server`: `notificationStatement` (put it in the batch
  of the change it tells about) · `account/topups.server`: `getPendingTopupTotal` (WalletBalance `pendingIqd`),
  `listWalletTopups` · `account/preferences.server`: `getConsent`, `recordConsent`.

## Recently viewed — one store per shopper (integration pass, 2026-11-11)

A signed-in customer's views are kept in the ACCOUNT only (`recently_viewed`, ≤ 30, with consent); a guest's on the
device only (home's `tt:recent`, never sent to the server). The product page writes exactly one of them
(`home/personal.ts → recordProductView`: signed in → `POST /api/recently-viewed` → `recordRecentlyViewed`). After
signing in, the first product page, home visit or this overview hands the device's guest list to the account once
(`mergeDeviceRecentlyViewed`: newest time wins, one row per product) and removes it from the device; the overview reads
the list again when something joined. Withdrawing personalization in the settings (`forgetPersonalData`,
home/personal.server) clears the account's list and the recommendation signals of the account and this device. The
cart-token guest rows the service still supports are only merged at sign-in; nothing writes them now. Full table:
docs/areas/home.md "Recently viewed".

## Integration (wired 2026-11-11)

- ~~Product page: `recordRecentlyViewed`~~ — done (above).
- ~~Product hearts: `WishlistKey initial`~~ — done on the product page (`wishedAmong(db, wishlistWho(ctx.cookie,
  customerId), [id])`); cards carry no heart (one walled key per card, docs/ui/commerce.md).
- ~~Recommendations: saved devices~~ — the devices area's engine reads `saved_devices` for a consenting customer's
  personal shelf (home, search); the devices page now says so ("devices.lead").
- ~~Checkout: prefill from `getDefaultAddress`~~ — done (docs/areas/checkout.md). Open: the wallet option's pending
  line from `getPendingTopupTotal` (not wired).
- Admin (customers/finance): approve = `creditWallet(kind "topup", refType "wallet_topup", refId, idempotencyKey
  "topup:<id>")` + the request's status/verifier/ledger id in the same step; reject with a reason the customer reads.

## Verified

- `npx vitest run tests/account.test.ts tests/wishlist.test.ts` — 27 + 14 pass (services on a real local D1 with the
  demo catalogue; a real order delivered by the commerce core for warranties and the return window; the sign-in,
  sign-out and guard routes and `/api/wishlist` through the real root middleware, CSRF included).
- `npx tsc -b` — nothing in these files; `node scripts/lint-design.mjs app/routes/storefront/account` — 0 findings.
- Browser (headless Edge against the dev server): address add + field errors, top-up upload → request → private
  preview (owner 200, guest 404) → cancel dialog, dev phone code, consents + `tt_consent`, wrong password → sign-in with
  `next`, guest favourites → remove + undo → sign-in merge → sign-out. Screenshots in `.shots/account/` at 390, 768 and
  1440, light and dark, ar / en / ckb; no overflow, one `<main>`, no console errors except the browser's own
  "Failed to load resource" line for 4xx answers to form posts (validation is a 400 by design).
- Not checked: the production "codes unavailable" screen in a browser (unit-tested; the dev server is development);
  Safari, Firefox, real phones. The Sorani strings need a native reader.
