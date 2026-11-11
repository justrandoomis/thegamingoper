# TamTam Games — security model

What protects the store, **as implemented in the code today**. Sections 1–12 describe the application (owner: server core). Section 13 is the Cloudflare edge (owner: the lead). Section 14 lists what is not done. If a control changes, change this file in the same commit. If the code and this file disagree, the code is what runs, and this file is wrong.

Code map: `app/server/context.server.ts` and `security.server.ts` (request handling, headers), `body.server.ts` (request body limits), `app/server/auth/*` (accounts and sessions), `actor.ts` and `permissions.ts` (authorization), `crypto.server.ts`, `audit.server.ts`, `ratelimit.server.ts`, `settings.server.ts`, `storage.server.ts` and `uploads.server.ts` (files), `text.server.ts` (shopper free text), `outbox.server.ts` (outgoing messages), `drizzle/0001_invariants.sql` (database rules). Tests: `tests/server-core.test.ts`, `tests/db-invariants.test.ts`; the storefront review: `tests/storefront-adversarial.test.ts`, `tests/storefront-adversarial-input.test.ts` (§16) and its second pass `tests/storefront-adversarial-verify.test.ts` (§17).

## 1. What we protect, and from whom

| Asset | Main controls |
|---|---|
| Money and stock (orders, payments, refunds, wallet, inventory, serials) | Database triggers and constraints (ARCHITECTURE §7), atomic batches, permissions checked in services, audit trail |
| Customer data (phone numbers, names, addresses, orders, payment-proof images) | Sessions, ownership checks in services, masking, private file storage, `customer.phone.read_full` and `payment_proof.read` |
| Protected business data (supplier cost, landed cost, margins: the `[P]` columns) | Selected only after `can(actor, "cost.read")` / `"profit.read"`. For other actors the data is left out of responses, exports and APIs (not just hidden in the UI) |
| The admin, which can move money and stock | Staff sessions, two-step verification, least-privilege roles, lockout, audit trail |
| Secrets (session tokens, TOTP secrets, recovery codes, one-time codes) | Stored only hashed or encrypted (see §12) |

Threats this design covers:
- Anonymous attackers on the internet: credential stuffing, password spraying, account enumeration, CSRF, open redirects, malicious uploads, scraping of guest orders.
- A customer trying to reach another customer's data.
- An employee doing more than their role allows.
- Someone who gets a copy of the database: they find no usable session, password, code or TOTP secret.
- Someone with direct database access who rewrites history. The audit chain **detects** this but does not prevent it (§10).

Out of scope: a compromised Cloudflare account or Worker secrets, a compromised owner device, and malware in uploads beyond the strict format checks (§9).

## 2. Layers

```
browser ─► Cloudflare edge          TLS, WAF, bot and rate rules                      §13 (lead)
        ─► Worker root middleware   canonical host, CSRF check, security headers      context.server.ts, security.server.ts
        ─► loader / action          requireEmployee / getCustomer, input parsing       app/server/auth/*
        ─► service                  assertCan, zod validation, audit, one db.batch     app/server/services/*
        ─► D1                       constraints, append-only and invariant triggers    drizzle/0001_invariants.sql
```

Each layer enforces its rules again, whatever the layers before it did. Hiding a button is never the control: services call `assertCan(actor, "<permission>")` themselves.

## 3. Request handling

These protections run in the root middleware (`requestContextMiddleware`) for every route, including resource routes:

- **Canonical host.** A GET or HEAD request to `www.` gets a 301 to the apex domain.
- **CSRF.** A request with any method other than GET, HEAD or OPTIONS must carry an `Origin` equal to the site's origin. Without `Origin`, it must carry `Sec-Fetch-Site: same-origin`. Otherwise it gets 403 `cross_site_request_blocked`. The site has no unauthenticated cross-origin write API. As a second line of defence, the session cookies are SameSite: Lax for customers, Strict for staff.
- **Request bodies** (`body.server.ts`, since the 2026-11 review). A write whose declared `Content-Length` is above its path's limit gets 413 `payload_too_large` before anything reads it: 256 KB for every storefront form and API, one image plus framing (8 MB + 64 KB) for `/api/upload/*` and `/account/wallet/proof`, three images for `/support/repair` and `/support/assistant`, 32 MB for the admin (its endpoints check their own files). Those upload routes also read the body with a running count (`readFormData`), so a body sent without a `Content-Length` is cut off at the limit with `upload_too_large` instead of being read to its end. Other actions still read an undeclared body whole, up to the platform's 100 MB (§14).
- **Headers on every response:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy` that allows the camera on our own origin (for scanning) and turns off the microphone, geolocation, payment and USB.
- **Content-Security-Policy** on HTML, everywhere but development. Development is `APP_ENV` exactly `development` (`.dev.vars`); any other value, or none, runs as production — since the 2026-11 review, before which anything but `production` was development. It is off under `npm run dev` because Vite's dev client needs inline scripts. The policy:
  - `default-src 'self'`
  - `script-src 'self' 'nonce-<per request>'`
  - `style-src 'self' 'unsafe-inline'` (React writes style attributes)
  - `img-src 'self' data: blob:`
  - `connect-src 'self'`
  - `frame-src 'none'` and `frame-ancestors 'none'`
  - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`
  - `upgrade-insecure-requests` on HTTPS
- **Caching.** HTML and a page's single-fetch data (`/p/x.data`, `/_.data` — the same loader data, the shell's included) get `Cache-Control: private, no-cache` unless the route sets its own; for a request that carries a customer session cookie they are `private, no-store` whatever the route says (the shell data names the customer). Private areas — `/admin`, `/api`, the account, checkout, cart, order and track pages and a trade-in's tracking page `/trade-in/<ref>` — are `no-store`, their data and error pages included. `/api/health` sends `no-store`; `/api/search/suggest` is `public, max-age=60` and carries no cookie. A stricter `Referrer-Policy` set by a route (`no-referrer`, `same-origin`: pages with a link token in their URL) is kept; everything else gets `strict-origin-when-cross-origin`.
- **HSTS** is sent only when `HSTS_MAX_AGE` is above 0. The owner decides, because HSTS is hard to undo.
- **No indexing.** `X-Robots-Tag: noindex, nofollow` is sent in demo mode, on `/admin`, `/api`, the account, checkout, cart, order and track pages, a trade-in's tracking page, and on `*.workers.dev`.
- **Client identity.** The IP is `CF-Connecting-IP`, which Cloudflare sets. In local development there is no client IP, so per-IP rate limits do not apply. Per-IP limits count an IPv6 address by its /64, and by its /48 with 16 times the limit (§11). The request id is `cf-ray`. Actors carry both into the audit trail.
- **Error responses.** Expected failures become `{ ok: false, code, fields }` (`actionError`) or a status with `{ error: code }` (`throwAsResponse`). An AppError's internal `detail` (ids, column names) never goes into a response body. The one exception is `requireEmployee`'s 403, which tells a signed-in employee which permission they lack. Unexpected errors reach the error boundary.

## 4. Secrets and configuration

Secrets are Worker secrets (`wrangler secret put`). Locally they live in `.dev.vars`, which git ignores. No code reads them at module load: they are passed as parameters, so tests inject their own.

| Secret | Used for | What happens if it changes |
|---|---|---|
| `SESSION_SECRET` (≥ 32 characters) | HMAC of one-time codes (`requestOtp` / `verifyOtp` require it and throw without it), and signed tokens (`signToken`) | Codes still waiting (5 min) and signed tokens stop working. Harmless. |
| `DATA_KEY` (32 random bytes, base64) | AES-256-GCM encryption of TOTP secrets (later also digital codes and integration credentials) | Every encrypted value becomes unreadable: employees with two-step verification must have it reset (`resetEmployeeMfa`) and enrol again. **There is no re-encryption tool yet.** |
| `SETUP_TOKEN` (≥ 16 characters) | The one-time first-owner setup at `/admin/setup` | Shorter than 16 characters or missing means setup is switched off (`setup_disabled`). After the first owner exists it is never accepted again. Delete it after setup. |

Only `APP_ENV=development` (exactly) turns development mode on: no CSP, development one-time codes shown on screen, an empty shell when the local database is missing. Any other value — `production`, a misspelling, or none at all (a named wrangler environment does not inherit the top-level `vars`) — runs as production. `STORE_MODE=demo` turns on `noindex` and the demo ribbon. `HSTS_MAX_AGE` turns on HSTS.

## 5. Customer accounts (`auth/customer.server.ts`, `auth/otp.server.ts`)

- **Guests never need an account.** Checkout works without one (CONTRACTS §1).
- **Sign-up and sign-in** use an Iraqi mobile number, normalized to E.164, and a password. A new password must be 8 to 256 characters.
- **Sign-in failures look the same.** An unknown number, a wrong password or an account without a password all give the same `invalid_credentials` (401), after the same amount of hashing work. A blocked account gets `account_blocked`, but only after the correct password. Merged and deleted accounts get `invalid_credentials`.
- **Sign-up reveals that a number is registered** (`phone_taken`). No sign-up flow can avoid this without SMS verification. Sign-ups are limited per IP.
- **Phone numbers are not verified at sign-up.** No SMS provider is configured, so anyone can register any number. `customer.phoneVerified` is true only after a one-time code confirmed the number (`confirmCustomerPhone`). Services must not attach guest orders to an account, or show order data by phone number, unless it is true.
- **Sessions use the `tt_sid` cookie.** It holds a random 256-bit token and is HttpOnly, SameSite=Lax, `Path=/`, and Secure on HTTPS. The database keeps only `sha256(token)` as the primary key. Each session lasts 30 days from the last visit; the expiry slides, and is written at most once an hour.
  - Every request checks the database, so revoking a session or blocking an account takes effect on the next request, and the dead cookie is cleared — except for 30 seconds after the session was revoked (`REVOKED_COOKIE_GRACE_MS`): a request that left the browser before a rotation or a new sign-in must not delete the successor's cookie with its late answer. The old token is refused all the same; a later request clears it. The hourly slide of the expiry never re-sets a cookie whose session was revoked between its read and its write.
  - Signing in or signing up replaces any session the browser already had, which prevents session fixation.
  - Customers can list their sessions and revoke one or all of them.
  - Changing the password signs every other device out, and moves this device to a new token: the old cookie, and any copy of it, stops working at once (the change's answer sets the new `tt_sid`; the session keeps its start date).
  - Confirming the phone number with a one-time code (`confirmCustomerPhone`) moves this device to a new token too: a confirmed number gives the account more reach, so a copied cookie must not carry it. Other devices stay signed in.
- **One-time codes** have 6 digits, are valid for 5 minutes, and allow at most 5 guesses.
  - A new request cancels the previous code for the same phone and purpose.
  - A code is bound to its phone, its purpose and an optional `ref`, and succeeds only once, even when two correct attempts arrive at the same time.
  - Only `HMAC-SHA256(SESSION_SECRET, id | phone | purpose | code)` is stored.
  - Every failure is the same `otp_invalid`.
  - **No SMS provider is configured.** The message is stored in the outbox with status `held`, without the code, and `requestOtp` returns `delivery: "held"`. Screens must say the code was not sent. The code itself (`devCode`) is returned only when `ctx.isDev` is true (`APP_ENV` exactly `development`, §4), and never in production; there, password reset and phone confirmation answer `otp_unavailable` (503) and create nothing (`tests/storefront-adversarial.test.ts`, "production never hands out a one-time code").
- **Free text** (names, addresses, notes, references — `~/server/text.server`): control characters (NUL, ESC sequences…), the bidirectional override and isolate controls (U+202A–U+202E, U+2066–U+2069), zero-width space, word joiner and a stray BOM are removed before validation, in every shopper-facing schema (checkout, addresses, profile, sign-up, trade-in, repairs, tickets, the assistant's hand-off, proofs, top-ups); since the second pass (§17) also from the question typed into the maintenance assistant before a hand-off stores it, and from the original name of every uploaded file (`sanitizeFileName`). ZWNJ/ZWJ (Sorani and Persian spelling) and LRM/RLM stay. Passwords are never touched.

## 6. Staff accounts (`auth/admin.server.ts`)

**Sign-in**
- Email (lower-cased) and password. A staff password must be 12 to 256 characters when it is set or changed.
- An unknown email, a wrong password, a missing password and a disabled account all give the same `invalid_credentials`.

**Lockout**
- 5 failed passwords for one email lock that email until its 15-minute window ends (`locked_out` with `retryAfterSec`). During the lock the correct password is refused too.
- A successful sign-in clears the earlier failures.
- Each attempt is counted atomically **before** the password is checked, so parallel guesses cannot slip past the limit (a 40-way race lets exactly 5 through; `tests/admin-auth-adversarial.test.ts`).
- Attempts are also limited per IP, across all accounts.
- Anyone who knows a staff email can trigger the lock. This is accepted: the edge challenge on `/admin/login` makes it slow to abuse.

**Two-step verification (TOTP)**
- When on, the password opens only a half-open session. For 10 minutes, that session can do nothing but submit the code.
- The code is RFC 6238 (SHA-1, 6 digits, 30 seconds), accepted with ±1 step of clock drift.
- Each step can be used once per employee, even inside the window: a replay is refused. The `claimOnce` marker for this lives in `rate_limits`.
- After 6 attempts, the next one ends the half-open session, and the password is needed again.
- Success replaces the session with a new token.
- Enrolment stores the secret encrypted with the context `employee:<id>:totp` and does not turn it on until a valid code proves the app has it. Enrolling signs every other device out, moves this device to a new token (see Sessions) and returns 10 recovery codes once.
- Starting enrolment needs the password again unless the session was opened with it in the last 15 minutes, so a stolen cookie cannot enrol the attacker's phone and lock the employee out (a cookie younger than 15 minutes still can — accepted).
- A recovery code works once. Two simultaneous uses are resolved with compare-and-swap.
- An employee can turn it off with their password and a code; refused attempts are written to `auth_events`. An administrator with `security.mfa.manage` can reset it with a reason, for example after a lost phone; that signs the employee out everywhere.

**Sessions**
- The `tt_adm` cookie holds a random 256-bit token and is HttpOnly, SameSite=Strict and Secure on HTTPS. Only its SHA-256 is stored.
- It is set for `Path=/admin` and for `Path=/admin.data`. React Router fetches the data of the `/admin` index route from `/admin.data`, which a `/admin` cookie path does not cover.
- A session lasts 12 hours at most, and ends after 2 hours without use.
- Every request checks the database. Revoking a session, or disabling the employee, locks them out on the very next request. As for customers, a cookie whose session was revoked less than 30 seconds ago is refused but not deleted, so a request in flight during a rotation cannot delete the successor's cookie.
- Employees can list and revoke their own sessions. Revoking someone else's needs `security.session.revoke`. Both are audited.
- Changing the password signs the employee's other devices out.
- **A credential change rotates the token** (since 2026-11-11): changing the password, or turning two-step verification on or off, ends every session of the employee — this device's included — and starts this device's successor with a new token, the same start and the same absolute end (a change never lengthens a session) and the right second-step state. The answer of the change sets the new `tt_adm` on both cookie paths; a copy of the old cookie stops working at once. The rest of that request runs on the new session, so nothing later in it clears the new cookie. Tests: `tests/auth-rotation.test.ts`, `tests/admin-auth-adversarial.test.ts` ("was open").

**Disabling an employee**
- Needs `staff.manage` and a reason.
- Refused for yourself and for the last active owner.
- Revokes every session, and is audited.

**Admin routes**
- Every admin loader and action starts with `requireEmployee(ctx, db, "<permission>")`.
- With no session, it sends a document redirect (`redirectDocument`) to `/admin/login?next=…`. The `next` value is limited to `/admin` paths by `safeNextPath`.
- With a session but without the permission, it answers 403.
- The admin layout's gate (`routes/admin/shell/gate.server.ts`) refuses, before any loader runs, a module whose permission group the employee holds nothing of, and every admin route outside `/admin/<module>/` that has no rule of its own. Such a refusal is rendered by the root error boundary (React Router renders the highest boundary with a loader when middleware throws before `next()`); `applySecurityHeaders` still marks it `no-store`.

**SameSite=Strict side effect:** a link from outside the site (an email, a chat) arrives without the cookie. The sign-in page forwards an employee who is already signed in to `next`, and a cross-site arrival without a visible cookie gets one same-site hop (the page reloads itself from its own origin, so the Strict cookie is sent).

**First owner** (`createFirstOwner(db, { setupToken, email, name, password }, now, env, origin)`):
- Works only while the `employees` table is empty. This is checked before the reference data or the roles are written, and again inside the transaction that inserts the owner.
- Needs `SETUP_TOKEN`, compared in constant time. Attempts are limited to 5 per IP per hour.
- Before creating the owner, it installs the reference data (`seedReference`: governorates, districts, settings defaults, the main location, channels, chart of accounts, inspection templates). A fresh production database has no other way to get them. It also installs the built-in roles. Both steps are idempotent and overwrite nothing.
- A refused attempt writes nothing except its rate-limit count.
- It does not sign anyone in.

## 7. Authorization (`actor.ts`, `permissions.ts`)

**Actors**
- `guest`, `customer` (id), `employee` (id, permissions, optional branch) and `system` (job).
- Only employees hold permissions.
- What a customer may do is decided by ownership inside the service, for example `order.customerId === actor.id`.
- `system` passes every check. It is built only by server code (scheduled jobs, setup, seeds), never from request input.

**Permissions**
- 246 permissions in 24 groups: one group per admin module 01–23, plus field-level permissions.
- Names follow `<module>.<resource>.<action>`. A few are shorter: `settings.read`, `settings.manage`, `staff.manage`, `audit.read`.
- Each has an Arabic and an English label for the role editor.
- Field-level permissions decide whether protected data leaves the server at all: `cost.read`, `profit.read`, `customer.phone.read_full` (others see `0771 ••• ••52`), `payment_proof.read` and `digital_code.reveal`.

**Default roles** (`seedRoles`, idempotent):

| Role | Count | Holds |
|---|---|---|
| owner | all (the `*` wildcard) | Everything, including permissions added later. No other role may hold `*` |
| manager | 232 | Everything except staff and role management, payroll approval, payment destinations, settings approvals, manual journal posting, the chart of accounts, period closing, MFA resets, backups, retention, access reviews, API keys, webhooks and integrations |
| finance | 65 | Books, settlements, transfer verification (`orders.payment.verify`), refunds, `cost.read`, `profit.read`, `payment_proof.read`, `audit.read` |
| inventory | 29 | Receiving, counts, transfers, serials, used-device intake and inspection. **No cost, and no oversell** |
| fulfillment | 18 | Packing, shipping, delivery, and `customer.phone.read_full` for labels and calls |
| support | 28 | Tickets, returns, repairs, refund *requests*, and `customer.phone.read_full` |
| cashier | 14 | Point of sale and shifts |
| content | 23 | CMS, product content and media. Cannot publish products or change prices |

Rules that hold for the defaults:
- Cashier, support, content, fulfillment and inventory never hold `cost.read` or `profit.read`.
- Only the owner can change roles, payment destinations or integrations.
- `orders.payment.override` (approving a transfer whose amount does not match) belongs to owner and manager only, not finance, so that verifying and overriding stay with different people.

Existing roles keep their edits when `seedRoles` runs again: a permission an owner removed is not granted back. The owner role always gets its wildcard back.

Branch limits: `canAccessBranch` / `assertBranch` restrict an employee who has a `branchId` to that branch.

## 8. Cryptography (`crypto.server.ts`)

All of it uses WebCrypto, so it runs the same in Workers, Node tests and scripts.

**Passwords**
- PBKDF2-HMAC-SHA256 with a random 16-byte salt per password and a 32-byte hash. Stored as `pbkdf2-sha256$<iterations>$<salt>$<hash>`, with the iteration count also in `password_iters`.
- Input is NFKC-normalized, and the hash is compared in constant time.
- A missing hash, an empty password or an over-long one still costs one full derivation.
- `needsRehash` upgrades weaker hashes at the next successful sign-in.
- **Iterations: 100,000.** This is the most Cloudflare Workers allows, and below OWASP's current advice of 600,000 for PBKDF2-SHA256. Per-account lockout, rate limits and the edge rules compensate. If the platform limit rises, raise `PASSWORD_ITERATIONS` and `needsRehash` will migrate accounts.

**Secrets at rest**
- AES-256-GCM with a random 12-byte IV, stored as `v1.<iv>.<ciphertext+tag>`.
- The value is bound to where it lives through additional authenticated data (for example `employee:<id>:totp`). A value copied to another row fails to decrypt, and so does altered data.

**Signed tokens**
- `<payload>.<HMAC-SHA256>`, with a purpose and an expiry. Readable by whoever holds them, so never put a secret in one.
- Nothing uses them yet.

**TOTP**
- 20-byte secrets in base32, and an `otpauth://` URI for the QR code.
- Verified against the RFC 6238 test vectors in the tests.

**Recovery codes**
- 10 codes of 10 characters from a 30-character alphabet without look-alike characters (about 49 bits each).
- Stored as domain-separated SHA-256, and every stored hash is compared on use.

**Random values** come from `crypto.getRandomValues`, with rejection sampling so digits and code characters are uniformly random.

## 9. Uploaded files (`uploads.server.ts`, `storage.server.ts`)

**Checks on every upload, in this order:**
1. **Size**: 8 MB at most. The declared size is checked before the body is read (the root middleware and the route), and the upload routes count the body as they read it, so an undeclared (chunked) body is cut off at the limit (§3 "Request bodies").
2. **Type by content**: JPEG, PNG or WebP only, decided by the first bytes. The file name and the type the browser claims are ignored. HTML, SVG, PDF, GIF, executables, archives and anything else are refused, whatever they are called.
3. **Structure**: the file is parsed from start to end, and anything that does not parse is refused (`upload_corrupt`).
4. **Dimensions**: at most 16,384 px per side and 50 megapixels.
5. **Metadata is removed without re-encoding** (the pixels are untouched):
   - JPEG: every APPn segment except JFIF density, ICC profile and Adobe colour data. That covers APP1 Exif and XMP (GPS position, device, dates, thumbnails), APP13 IPTC, and COM comments. A 34-byte Exif block holding only the orientation is written back, so rotated photos still display upright.
   - PNG: tEXt, zTXt, iTXt, eXIf, tIME, and every other chunk a decoder does not need. An unknown critical chunk is refused.
   - WebP: EXIF, XMP and unknown chunks are removed, and the VP8X flags and the RIFF size are corrected.
   - In all three formats, bytes after the end of the image are cut off.
6. **Hash**: SHA-256 of the cleaned bytes, so the same picture with different metadata gets the same hash. Duplicate payment-proof detection relies on this.

**Malware scanning is not done, and is not available on this platform.** Cloudflare Workers has no antivirus engine, and no scanning service is connected. The defence is:
- the narrow list of three image types, checked by structure and not by name;
- metadata and trailing bytes removed;
- the way files are served (below): a stored file is never served as active content.

A file that passes these checks can still exploit a bug in a viewer's image decoder; that risk stays with the browser.

**Storage.** Bytes live in a `BlobStore`, which today is the KV binding (values up to 25 MB, eventually consistent). An R2 bucket can replace it behind the same interface. Facts about each file live in the `files` table: type, size, hash, dimensions, owner and creator. A key is `pub_` or `prv_` plus 144 random bits.

**Private files** (payment proofs, unlisted device photos, documents):
- Never served by `/media`.
- Served only by routes that first authorize the actor (owner check, or `payment_proof.read`) and then call `fileResponse`.
- Sent with `Cache-Control: private, no-store` and `Cross-Origin-Resource-Policy: same-origin`.

**Public files** (`GET /media/:key`):
- Served only when the key is well-formed, starts with `pub_`, and the metadata stored with the bytes also says `public`.
- No database query is involved.
- Sent with `Cache-Control: public, max-age=31536000, immutable`.

**Headers on every served file:**
- The type recorded at upload, plus `nosniff`.
- `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`.
- `Content-Disposition: inline` for the three image types. Every other type is `attachment`, and an unknown type is sent as `application/octet-stream`.

**Changing visibility moves the bytes to a new key.** A private URL therefore never becomes public. But a file that was public **may still sit in browser and CDN caches** under its old URL after it is made private or deleted. Publish only what may stay public.

**Rate limits:** the `upload` preset (20 per 10 minutes per IP or per account) is applied by the upload routes, not by this module. A wallet top-up proof counts against both its IP and its account (§17: accounts cost nothing). **Unused uploads** are deleted by the daily retention: trade-in draft photos after 2 days, top-up proofs that no request uses after a day (`purgeUnusedTopupProofs`, §17).

## 10. Audit trail (`audit.server.ts`)

**What is recorded.** Every change to stock, wallet, price, refund, permission or settings writes an event with:
- who (kind, id, and their name at the time);
- what (action and entity);
- before and after;
- the reason;
- the IP and the request id.

**Atomic with the change.** `auditStatement` is a query builder that goes into the same `db.batch` as the change it describes, so both are stored or neither is. `audit()` is for events that stand alone.

**Append-only.** Database triggers reject UPDATE and DELETE on `audit_events` and `audit_seals`.

**Redaction on the way in:**
- Values under secret-looking keys become `[redacted]`. That covers passwords, tokens, secrets, `*hash`, `*enc`, OTP and dev codes, recovery codes, API keys, cookies, card numbers and CVV.
- Iraqi mobile numbers in any form are masked (`0771 ••• ••52`), including Arabic-Indic digits and numbers inside free text.
- Values under identifier keys (serial, SKU, barcode, IMEI, tracking, reference, ids) are left readable.
- Oversized values are shortened.
- A settings change keeps the store's own payment and contact numbers readable, because they are public business data.

**Hash chain.**
- `sealAudit` folds consecutive events into SHA-256 seals in `audit_seals`, each linked to the previous seal. Each event's hash covers all of its stored columns, its order and the event count.
- `verifyAuditChain` recomputes the chain and reports `seal_hash` (an event was edited, removed or inserted), `seal_gap` (seals are missing or overlap) and `seal_link` (a broken link).
- The tests drop the triggers and tamper directly, and every kind of tampering is detected.

**What the chain cannot see:**
- Events deleted before they were sealed.
- A chain rebuilt from start to end by someone with full database access. To catch that, log the `headHash` that `sealAudit` returns somewhere outside the database.

**Sealing is not scheduled yet.** It needs a cron (see §14).

**Security log.** `auth_events` records sign-ins, failures with their reason, lockouts, codes, two-step changes and password changes. Its `identifier` column holds the typed phone number or email **in full**. Screens must mask it for actors without `customer.phone.read_full`.

## 11. Rate limits (`ratelimit.server.ts`)

Counters are fixed windows in D1 (`rate_limits`), not KV, because KV's free tier allows very few writes.
- One atomic upsert per check, and a blocked caller costs no write.
- Identifiers are stored only as hashes: `scope:kind:<sha256 prefix>`.
- An IP identifier (kind `ip`) is the address's identity (`ipIdentity`): IPv4 as it is, an IPv4-mapped IPv6 address as its IPv4, any other IPv6 address by its /64 — one subscriber line gets a whole /64 and could otherwise rotate addresses to multiply every per-IP limit (fixed in the 2026-11 review). An IPv6 caller is counted a second time, by the /48 around it, against `WIDE_NETWORK_FACTOR` (16) times the limit: a home or business line often holds a /56 or a /48, and a tunnel broker hands out a /48 for free — 65,536 /64s (second pass, §17). `limitKey` returns both parts in one opaque key (`…:ip:<hash>|…:ip48:<hash>`) and `rateLimit`, `peekRateLimit` and `resetRateLimit` handle each part; a blocked /64 costs no write.
- Endpoint limits outside the presets: `/api/cart` 60/min per IP and per cart; `/api/wishlist` and the `/wishlist` form 60/min per IP together (`WISHLIST_CHANGES_PER_IP`); `/api/events` 120/min per IP; `/api/recently-viewed` writes 60/min per IP; `/api/search/suggest` 120/min per IP; consent answers 12 per HOUR per customer, the account settings and the home panel together (`CONSENT_CHANGES_PER_CUSTOMER`; per minute until the second pass); profile changes 10 per hour per customer (`PROFILE_CHANGES_PER_CUSTOMER`: each one is an audit event); wallet top-up proofs 20 / 10 min per IP (`upload_topup`) and per account; trade-in requests and lookups, repair and ticket creation and repair lookups per IP and per phone or reference (their services).
- Not a rate limit, a bound: `search_query_stats` takes at most `MAX_COUNTED_QUERIES_PER_DAY` (2,000) distinct queries per day and language — it is written by anonymous GETs that any web page can trigger, so a per-IP limit would not hold it; queries already counted that day keep counting (§17).
- `cleanupRateLimits` deletes windows older than a day. It is not scheduled yet.

| Preset | Limit | Applied by |
|---|---|---|
| `signIn` | 8 / 15 min per phone (also per account for password changes) | customer sign-in, password change |
| `signInIp` | 40 / 15 min per IP | customer sign-in |
| `signUpIp` | 10 / hour per IP | customer sign-up |
| `adminSignInFailures` | 5 failures / 15 min per email, then `locked_out` | staff sign-in |
| `adminSignInIp` | 20 / 15 min per IP | staff sign-in |
| `mfaVerify` | 6 / 10 min per employee | second step, enrolment, turning it off |
| `setup` | 5 / hour per IP | first-owner setup |
| `otpRequest` / `otpRequestIp` | 3 / 10 min per phone; 12 / hour per IP | `requestOtp` |
| `orderLookup` / `orderLookupRef` | 10 / 15 min per IP; 10 / hour per order reference | guest order lookup (commerce core) |
| `checkout` | 10 / 10 min per IP or phone | checkout (commerce core) |
| `upload` | 20 / 10 min per IP or account | upload routes |

Cloudflare's edge rate limiting (§13) sits in front of these limits and absorbs floods before they reach the Worker.

## 12. Settings, outgoing messages, data at rest

**Settings** (`settings.server.ts`):
- Every key has a zod schema, a default and the permission needed to change it.
- Payment destinations (bank card number, Zain Cash number) and the refund approval threshold need `settings.payment.manage`, which only the owner holds by default.
- A change needs a reason. The value and its audit event are stored in one batch.
- A stored value that no longer fits its schema raises an error instead of being guessed around, so a wrong payment account is never shown as if it were right.
- Only keys marked public reach the storefront.

**Outgoing messages** (`outbox.server.ts`):
- **No SMS, WhatsApp or email provider is configured.** Every message is stored as `held` and nothing claims it was delivered.
- One-time codes travel to a provider in memory only. The stored row never contains them.

**What is stored, and how:**

| Stored as a hash | Stored encrypted | Stored in plain text, on purpose |
|---|---|---|
| Session ids (customer and staff), cart tokens, guest access tokens, one-time codes (HMAC), recovery codes, passwords (PBKDF2), rate-limit identifiers | TOTP secrets (AES-256-GCM with `DATA_KEY`) | Phone numbers, names and addresses (needed for delivery). Access goes through services and masking. Cloudflare encrypts D1 storage at rest |

## 13. Cloudflare edge configuration (owner: lead)

> **This section belongs to the lead.** The server core did not configure or check anything in the Cloudflare dashboard. What follows is what the application expects from the edge. The lead records the actual state and the date it was checked.

The application relies on the edge for:
1. **HTTPS only.** SSL/TLS Full (strict), minimum TLS 1.2, Always Use HTTPS. Session cookies get `Secure` only when the request reached the Worker over HTTPS, so plain HTTP must never get through.
2. **A managed challenge on `/admin/login` and `/admin/setup`.** The app sends staff there with document redirects, so the challenge can be shown. After the challenge, the `cf_clearance` cookie covers the sign-in form's data request (`/admin/login.data`).
3. **Rate-limit rules on paths that contain these segments**, so that React Router's `.data` variants (`/checkout.data`) are covered too: `/login`, `/signup`, `/otp`, `/track`, `/checkout`, `/admin/setup`, `/api/upload`.
4. **WAF rules that block scanner paths** (`/wp-admin`, `/.env`, `/.git`, `*.php`, …). The app serves none of them.
5. **Bot Fight Mode and leaked-credential detection.** The app does not read Cloudflare's leaked-credential header yet; that is a possible follow-up.
6. **No caching of `/api/*` or HTML.** `/media/pub_*` may be cached at the edge: it is immutable.
7. **DNSSEC.** HSTS (`HSTS_MAX_AGE`) and SPF/DMARC records await the owner's decision.

| Setting | Expected | Actual state | Checked on |
|---|---|---|---|
| SSL/TLS mode, minimum TLS, Always Use HTTPS | Full (strict), 1.2, on | *(lead)* | |
| DNSSEC | on | *(lead)* | |
| Bot Fight Mode, leaked-credential detection | on | *(lead)* | |
| WAF: block scanner and exploit paths | on | *(lead)* | |
| WAF: managed challenge on `/admin/login`, `/admin/setup` | on | *(lead)* | |
| Rate-limit rule on the paths in item 3 | on | *(lead)* | |
| HSTS | owner's decision | *(lead)* | |
| SPF / DMARC | owner's decision | *(lead)* | |

## 14. Known gaps and follow-ups

- **No malware scanning** (§9). The platform has none and no service is connected.
- **No message provider.** One-time codes are held, phone numbers are unverified, and customers have no self-service password reset. Connecting a provider means implementing `MessageProvider` and passing it in, using credentials from Worker secrets.
- **Staff two-step verification is optional.** Nothing forces enrolment yet. Before go-live, at least the owner and anyone with money permissions should enrol. A future setting could require it for some roles.
- **PBKDF2 is capped at 100,000 iterations by the platform** (§8).
- **Scheduled jobs run since 2026-11-11** (`workers/app.ts` `scheduled` handler, crons in `wrangler.jsonc`, jobs in `app/server/jobs.server.ts`): daily `sealAudit` with its `headHash` written to the Workers logs (outside the database), `cleanupRateLimits`, retention of sessions, trusted devices, one-time codes, `auth_events` (180 days), the outbox (90 days) and `job_runs` (90 days, each job's latest run kept), and consistency checks; every 5 minutes, unpaid transfer orders and stale reservations expire. Gap: Workers logs are kept for a limited time, so the owner should copy the daily `audit_seal` lines somewhere durable (a Logpush destination or a weekly export). Retention periods are constants, not settings yet.
- **No re-encryption tool for `DATA_KEY` rotation** (§4).
- **Staff sessions are not bound to an IP or device.** A stolen cookie works until the idle (2 h) or absolute (12 h) limit, or until it is revoked. HttpOnly, SameSite=Strict and `Path=/admin` limit how it can be stolen.
- **Content-Security-Policy:** it is off in development, and `style-src` allows inline styles.
- **Public files** may stay in caches after being made private (§9).
- ~~**Session token after a credential change** (§6): the device that changes its password or two-step setting keeps its token.~~ Closed 2026-11-11 (server pass): staff rotate on a password change and on two-step on/off, customers on a password change and on a confirmed phone number (§5, §6); `tests/auth-rotation.test.ts`. ~~What remains: a request this device sent with the old cookie just before the change and answered just after it can still clear the new cookie.~~ Closed in the 2026-11 storefront review (§16): a just-revoked session's cookie is refused but not deleted for 30 seconds, for customers and staff alike (sign-in's replacement of a session included).
- **Undeclared request bodies to ordinary actions** (§3): a body sent without a `Content-Length` to an action other than the upload and support-photo routes (sign-in, checkout, the JSON APIs…) is read whole, up to the platform's 100 MB per request, before the action rejects it. Only the edge can refuse those cheaply: a WAF rule limiting the body size (or requiring a `Content-Length`) on storefront `POST`s is requested from the lead (§13 is the lead's).
- **Per-IP limits and shared addresses.** Iraqi mobile carriers put many subscribers behind one IPv4 address (CGNAT), so per-IP limits (uploads 20 / 10 min, sign-ups 10 / hour, lookups) can refuse real people who share an address; IPv6 is counted per /64 and, at 16 times the limit, per /48 (§11) — a provider that puts many subscribers' /64s in one /48 shares that larger budget. The per-phone and per-account limits do not have this problem. If it shows up in practice, raise the per-IP numbers (or `WIDE_NETWORK_FACTOR`) rather than drop them.
- **What only a per-IP limit (and the edge) bounds** (second pass, §17). Phone numbers are not verified, so per-phone limits stop nobody who types other numbers: placing orders (cash-on-delivery orders hold their stock until staff act — order flooding is a stock-holding attack, bounded by `checkout` 10 / 10 min per IP and the edge rule on `/checkout`), trade-in, repair and ticket creation, a coupon's per-customer limit for guests (counted by phone). Guest carts and guest favourites are rows per cart token that no job deletes (60 changes / min per IP); `search_query_stats` has a daily cap but no retention (catalog area). The cart answers how many units it added (`added`), so it tells anyone the stock of an item up to 10 — the usual trade-off of a cart that caps at stock.
- **Search statistics carry the time of the last search** (`search_query_stats.last_at`, the request time in ms): no identity is stored, but a rare query searched by a signed-in customer in the request that slides their session (once an hour) shares that exact time with `customer_sessions.last_seen_at`. Coarsening `last_at` (for example to the hour) would remove the coincidence; its exact value is asserted by the catalog area's tests, so it is left to that owner.
- **A consenting guest's purchase signal is timed like the order** (`recommendation_events.at` = `orders.placed_at`): a database reader can join the guest's `tt_rs` signals to the order, and so to its contact and the audit trail's IP. This is what a purchase signal is, and it only exists with personalization consent; nothing joins it in the code.
- **Admin JavaScript is public** (it is served to anyone who asks, the blueprint catalogue included): it contains no data, costs or secrets — every number comes from loaders behind `requireEmployee`.
- **Two-person refunds are enforced** (since 2026-11-11): above `refunds.approval_threshold_iqd` (default 0, so every refund) a refund waits for `approveRefund`, which needs `orders.refund.approve` and refuses the employee who requested it (`approver_is_requester`). Refunds created by a cancellation always wait for approval.
- ~~**Append-only tables can be rewritten with `INSERT OR REPLACE`.**~~ Closed 2026-11-11 by `drizzle/0003_append_only_no_replace.sql`: each of the 15 append-only tables refuses an `INSERT OR REPLACE` / `REPLACE INTO` that meets an existing id or other UNIQUE key (idempotency key, seal range, reversal) with `TT:IMMUTABLE:<table>`, and the whole batch rolls back. Plain inserts, `ON CONFLICT DO NOTHING` and the idempotent retries behave exactly as before (`drizzle/README.md`). Production gets it with `npm run db:migrate:remote`. What remains: someone with direct database access can drop triggers. For audit events the hash chain, whose head hash is logged outside the database, shows that; for the ledgers only the daily consistency checks (wallet ledger vs journal, stock vs movements) would notice a change that breaks those totals.

## 15. Go-live checklist (application side)

1. Set the secrets with `wrangler secret put`: `SESSION_SECRET` (64 random characters), `DATA_KEY` (32 random bytes, base64) and `SETUP_TOKEN` (32 random characters). Set `APP_ENV=production`.
2. Run `npm run db:migrate:remote`.
3. Open `/admin/setup` and create the owner. This also installs the reference data and the roles. Then delete the `SETUP_TOKEN` secret.
4. The owner turns on two-step verification and keeps the recovery codes offline.
5. Create staff accounts with the narrowest role that fits. Only owner, manager and finance see cost and profit.
6. Check the cron triggers ran (`job_runs`, or the `scheduled_jobs` / `audit_seal` lines in the Workers logs) and keep the daily `audit_seal` head hashes somewhere outside Cloudflare.
7. Confirm §13 and decide on HSTS.

## 16. Storefront review 2026-11

An adversarial review of the storefront's server surface (every `app/routes/api/**` endpoint, every storefront loader and action, the services behind them), run on 2026-11-11 by the security pass. Each attack is a test that runs the request the way a browser's runs — through the real root middleware and route modules against a throw-away local D1 + KV — in `tests/storefront-adversarial.test.ts` (web layer, "web" below) and `tests/storefront-adversarial-input.test.ts` (what shoppers send and what the services return, "input"). Rate-limit and brute-force attacks ran only there, never against the shared dev server. Response-level checks (headers, status codes, bodies, a crawl of every page and its `.data` as a guest and as a signed-in customer) ran against the dev server.

**Fixed** (each confirmed on the unfixed code first — by its test failing, or for the free-text, garbage-multipart and consent-toggle rows by a probe and the code):

| Attack | What was wrong | Fix | Test |
|---|---|---|---|
| Open redirect: `/account/login?next=/en//evil.example` (also `/ckb//…`, `/en/..//…`), on the sign-in and sign-up pages (signed-in visitor) and after signing in or up | `nextFrom` checked `next`, then cut the language prefix off: `/en//evil.example` became `//evil.example`, another site | `nextFrom` (account.server) works on the canonical form — one more decoding checked, dot segments resolved, non-ASCII percent-encoded — and checks again after the prefix is dropped; `localeRedirect` refuses any target that is not a single-slash ASCII path | web › "next= after signing in or up never leaves the site" (24 vectors × loader and action) |
| A `next` with raw Unicode (`/c/ألعاب`) | the Location header was not a valid header value → unexpected error (500) | the same canonical form (`/c/%D8%A3…`) | web › "a good next keeps its page and query…" |
| `APP_ENV` fail-open | development was "anything but `production`": a deploy without the variable (a named wrangler environment does not inherit `vars`), `staging` or a typo ran without CSP and showed password-reset codes to whoever asked for any number — account takeover | `isDev` only for `APP_ENV === "development"` (context.server) | web › "production never hands out a one-time code" (7 values × reset, confirmation, CSP) |
| Personal data in caches | single-fetch `.data` responses carried no `Cache-Control` (the shell data names the signed-in customer); pages rendered for a signed-in customer were `private, no-cache`; a trade-in's tracking page (name, masked phone, offer) was `private, no-cache` and indexable | security.server: page data cached like its HTML; a request with a customer session → `private, no-store`; `/trade-in/<ref>` is a private page (`no-store`, `noindex`) | web › "cache headers — personal pages and page data…" |
| A route's `Referrer-Policy: no-referrer` (pages with a link token) | overwritten by the default | a stricter route value is kept | web › "a page that asks for no Referer…" |
| IPv6 rotation | per-IP limits counted each IPv6 address: one subscriber's /64 gave 2^64 fresh budgets (order, trade-in and repair lookups, sign-in, sign-up, codes, uploads, checkout) | `limitKey` counts kind `ip` by `ipIdentity` (/64; IPv4-mapped → IPv4) | web › "per-IP limits — one IPv6 subscriber is one caller"; input › "tracking a trade-in or a repair…" |
| Oversized and undeclared bodies | only the upload routes compared a declared `Content-Length`; a chunked body was read to its end (up to 100 MB) before the 8 MB check, on every route | middleware 413 on a declared length above the path's limit (body.server); `readFormData` with a running count on the proof, trade-in photo, top-up proof, repair and hand-off forms | web › "request bodies — limits hold before a body is read…", "support forms: …" |
| Garbage multipart to `/api/upload/tradein` | unexpected error (500) | 400 `upload_missing` | web › "error answers — a malformed body is a 400…" |
| A request in flight during a session rotation | its late answer deleted the successor's cookie (customers and staff; also at sign-in) — §14's open item | a just-revoked (< 30 s) session's cookie is refused but not deleted; the expiry slide never re-sets a cookie revoked in between | web › "a request sent with the old cookie…", "staff: …" |
| `/wishlist` form | no rate limit (the API had 60/min per IP): unlimited guest rows | one per-IP budget for both | web › "favourites — the page's form counts like the API" |
| Consent toggling in the account settings | unlimited rows in the append-only `consents` table | 12/min per customer, shared with the home panel | input › "consent answers (append-only rows) are limited…" |
| Unicode tricks in free text | NUL, ESC sequences, bidi overrides/isolates, ZWSP and BOM were stored as typed in names, addresses, notes and references (spoofing on order pages, labels, CSV) | text.server (`cleanLine` / `cleanBlock`) in the checkout, address, profile, sign-up, trade-in, repair, ticket, hand-off, proof and top-up schemas | input › "free text — …" |

**Held** (attacked, nothing to fix):

- **CSRF and methods** — for 13 write endpoints, another origin, `Origin: null`, another port or scheme, `Sec-Fetch-Site: same-site`/`cross-site` and no header at all get 403 before the action runs; PUT/PATCH/DELETE likewise; write-only resource routes answer GET with 405; `/api/files` has no action. web › "method and CSRF posture…".
- **Session fixation** — a planted cookie (an invented token or a live session of the attacker) never survives sign-in or sign-up, and the planted session is ended; cookie flags HttpOnly, SameSite=Lax, Path=/. A password change kills the old cookie and its copies and signs the other devices out; "sign out everywhere" too. web › "sessions — …".
- **Private files** — `/api/files/:fileId` serves a proof only to its order's signed-in owner or with its token; a guest, another customer, a revoked session, a wrong token or another order's token, trade-in and repair photos, public files and path tricks (`..`, `%00`, encoded slashes, storage keys) all get the same 404 `no-store`; served files are `private, no-store`, CORP same-origin, `nosniff`, sandboxed, `inline` images only. web › "GET /api/files/:fileId — …".
- **Access control (IDOR)** — another customer's address (edit, delete, default), top-up (cancel, its proof file, its idempotency key → `idempotency_mismatch`), notification, session (`session_unknown`), order (account and order pages: the same 404 with the same keys as an unknown reference; a proof to it is `not_found`), trade-in draft photo (read, remove), and an answer to someone's trade-in offer without their link (404; with the link it works). Lookups by reference + phone answer a wrong reference and a wrong phone alike (orders, trade-ins, repairs); every token is compared in constant time. input › "IDOR — …".
- **Validation** — arrays, objects and numbers where ids are expected; event kinds an allowlist (`purchase` is server-only); cart quantities in every spelling (`1e3`, `-1`, `1.5`, `Infinity`, `11`); prices, totals and discounts in a body ignored; the device list of recently viewed bounded and typed; onboarding answers; the checkout total a plain whole number; a wallet for a guest 403; proof amounts. input › "shapes and types — …".
- **Uploads** — SVG named `.png`, HTML named `.jpg`, a GIF/HTML polyglot, a PDF, zero bytes and a truncated PNG are refused and nothing is stored; HTML appended after a PNG is cut off; a text field in place of the file is `upload_missing`; the top-up proof needs a session. input › "uploads — …".
- **Consent** — without a yes a view signal stores nothing and sets no cookie; a consenting guest's key is random (two visits from one IP get two keys) and `recommendation_events` has no IP, user-agent or contact column; an account's "no" wins over the device's "yes"; withdrawing (home panel, account settings) deletes the signals, the `tt_rs` key and the account's recently viewed; no purchase signal without consent. input › "consent — …".
- **Money** — hostile checkout fields (unit price, totals, shipping, discount, coupon, payment status, status, paid amount, customer) are ignored; a total the shopper did not see is `totals_changed` and writes nothing; an attempt key replayed from another cart is `idempotency_conflict` and reveals nothing; the same customer replaying it with a changed cart gets the first order, unchanged; four simultaneous submits make one order; three simultaneous wallet checkouts charge once. input › "money — …"; the core's own races (overdraft, a single-use coupon used three times at once) in `tests/commerce-adversarial.test.ts`.
- **Data leaks** — every published product (page and quick look), device hub and listed used unit, and an order, trade-in and repair as their shopper sees them carry no cost, margin, supplier, serial, staff, hash, IP or private storage key (input › "what the shopper-facing read services return…"; `repair_tickets.cost_iqd` is the customer's price). The dev-server crawl (339 pages and their `.data`, as a guest and as a signed-in customer) found no private key, e-mail address or phone number other than the store's published Zain Cash number and the shopper's own; every signed-in answer was `no-store` and every `.data` answer had a `Cache-Control`.
- **XSS** — product and breadcrumb JSON-LD escape `<`, `>`, `&`, U+2028 and U+2029 (input › "text … never becomes markup"); reflected `?q`, references, `next`, assistant and filter parameters never appear raw in the HTML (dev-server check); staff-entered links are limited (notifications: local paths; carrier tracking: https; contact links: https by the settings schema).
- **Search** — FTS5 syntax (`"`, `NEAR(`, `*`, `-`, column filters, `^`), NUL, 300 characters, emoji and RLO in `/search` and `/api/search/suggest`: all 200, no error.
- **Rate limits and double submits** — proof uploads 20 / 10 min per IP then 429 with `Retry-After`; repairs, tickets and top-ups sent three times at once are one request. input › "rate limits and double submits at the other doors".
- **Error bodies** — refusals carry a code and field keys only (`actionError` never includes `detail`); unexpected errors are sanitized by React Router's production mode.

Residuals are in §14: undeclared bodies to ordinary actions, per-IP limits behind CGNAT, the search statistics' `last_at`, and the timing of a consenting guest's purchase signal.

## 17. Second pass 2026-11

An independent review of §16 on 2026-11-11 (owner: security), with a different method: each fix §16 claims was attacked again, then every storefront route module and every `*.server.ts` the storefront reaches was read input by input — where each user-controlled value is stored or shown, and what bounds each write a shopper (or any web page, through a shopper's browser) can cause. Tests: `tests/storefront-adversarial-verify.test.ts` (each failed on the code before its repair; rate-limit attacks only there, never against the shared dev server). Response-level checks (headers, statuses, bodies of the private pages and their `.data`, CSRF answers, the private-file routes, reflected `?q`/`ref` values) ran against the dev server.

**§16's fixes, attacked again**

| Fix (§16) | Result | What broke, and the repair | Test |
|---|---|---|---|
| IPv6 rotation (per /64) | **did not fully hold** | a subscriber with a /48 (common for home and business lines; free from tunnel brokers) still had 65,536 budgets for every per-IP limit — checkout (cash-on-delivery orders hold stock), sign-up, sign-in, lookups, uploads. `limitKey` now also names the /48 and `rateLimit` counts it against 16 × the limit; the /64 keeps its own budget first | verify › "rotating /64s inside one /48…", "guest order lookups… refused at the 161st" |
| `next=` open redirect | **held**, one claim restored | `nextFrom` checked one more decoding of the value it was given, then dropped the language prefix: `/en/%2F%2Fevil.example` came out as `/%2F%2Fevil.example`, which one more decoding makes `///evil.example` — the invariant §16 claims. No sink decodes it today (browsers keep `%2F` in a path); the value that leaves is now checked decoded too | verify › "the redirect, decoded once more…" |
| Hidden characters in free text | **two doors missed** | the question typed into the maintenance assistant (URL state `q`: only C0 controls removed) reached `assistant_messages` and the ticket's internal note with bidi overrides, C1 controls and zero-width spaces — now cleaned with `cleanLine` before the hand-off stores it; an uploaded file's original name kept bidi overrides ("IMG&lt;RLO&gt;gnp.exe" shown as "IMGexe.png" in upload lists) — `sanitizeFileName` cleans it | verify › "the assistant: the question…", "an uploaded photo's file name…" |
| Consent toggles limited | **held, too loose** | 12 per MINUTE still let one account write 17,280 answers a day (34,560 rows from the settings form, two per request) into a table that refuses DELETE; now 12 per hour | verify › "consent answers: the per-customer budget is per hour…" |
| `APP_ENV` fail-open, caching, request bodies, rotation race, `/wishlist` limit | **held** | `isDev` is read nowhere else (CSP, codes and the empty shell all follow `ctx.isDev`); `.data` answers of the trade-in, repair-status, assistant-receipt, wishlist and order pages carry `no-store` (or the route's stricter policy) on the dev server; counted reads on all five upload forms; a just-revoked cookie is refused, never accepted, inside the 30-second grace | — |

**Missed by §16, found by tracing every write**

| Door | What was wrong | Repair | Test |
|---|---|---|---|
| Profile changes (`/account/profile`) | no limit; each change is an audit event in the append-only `audit_events` — a signed-in script alternating two names grew it without end | `PROFILE_CHANGES_PER_CUSTOMER`: 10 per hour per customer (saving what is already stored writes nothing and is not counted) | verify › "profile changes…" |
| Wallet top-up proof uploads (`/account/wallet/proof`) | counted per ACCOUNT only: sign-ups are free (10 an hour per IP), so each new account brought 20 more 8 MB uploads per 10 minutes from the same address; and an upload no request used stayed in the private file store for good | per IP as well (`upload_topup`, 20 / 10 min); `purgeUnusedTopupProofs` in the daily retention deletes proofs no request uses a day after upload (`stats.topupProofs`) | verify › "one IP shares one upload budget…", "a proof no request uses is deleted…" |
| Search statistics (`/search?q=`) | every new query an anonymous GET carried became a row for good — and any web page can make its visitors' browsers send such GETs, so no per-IP limit could hold it | `MAX_COUNTED_QUERIES_PER_DAY` (2,000 per day and language), decided in the same statement; known queries keep counting | verify › "a flood of distinct queries…" |

**Held** (traced, attacked, nothing to fix): every id the client sends is checked against its owner — cart lines (by cart), addresses, top-ups, notifications, sessions, saved devices, trade-in drafts, files (`/api/files`, `/account/wallet/proof`, `/api/upload/tradein?file=`); every id that reaches the client is the shopper's own (order item, file, top-up, address, session hash on the settings page, keyset cursors); a guest order's proof can be read only with that order's token; lookups by reference + phone answer a wrong reference and a wrong phone alike; no route redirects to a value from the request other than `next` (`withCursorFallback` keeps the path — React Router does not match a `//`-prefixed path to a page); no `dangerouslySetInnerHTML` outside the two escaped JSON-LD builders and the root's constant scripts; notification links (local paths), carrier tracking links (https) and contact links (https) are limited where they are built; raw SQL takes values as bound parameters only.

Residuals are in §14 ("What only a per-IP limit (and the edge) bounds", "Per-IP limits and shared addresses").
