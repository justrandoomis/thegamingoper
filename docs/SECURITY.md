# TamTam Games — security model

What protects the store, **as implemented in the code today**. Sections 1–12 describe the application (owner: server core). Section 13 is the Cloudflare edge (owner: the lead). Section 14 lists what is not done. If a control changes, change this file in the same commit. If the code and this file disagree, the code is what runs, and this file is wrong.

Code map: `app/server/context.server.ts` and `security.server.ts` (request handling, headers), `app/server/auth/*` (accounts and sessions), `actor.ts` and `permissions.ts` (authorization), `crypto.server.ts`, `audit.server.ts`, `ratelimit.server.ts`, `settings.server.ts`, `storage.server.ts` and `uploads.server.ts` (files), `outbox.server.ts` (outgoing messages), `drizzle/0001_invariants.sql` (database rules). Tests: `tests/server-core.test.ts`, `tests/db-invariants.test.ts`.

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
- **Headers on every response:** `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin`, and a `Permissions-Policy` that allows the camera on our own origin (for scanning) and turns off the microphone, geolocation, payment and USB.
- **Content-Security-Policy** on HTML, in production only (`APP_ENV=production`). It is off under `npm run dev` because Vite's dev client needs inline scripts. The policy:
  - `default-src 'self'`
  - `script-src 'self' 'nonce-<per request>'`
  - `style-src 'self' 'unsafe-inline'` (React writes style attributes)
  - `img-src 'self' data: blob:`
  - `connect-src 'self'`
  - `frame-src 'none'` and `frame-ancestors 'none'`
  - `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`
  - `upgrade-insecure-requests` on HTTPS
- **Caching.** HTML gets `Cache-Control: private, no-cache` unless the route sets its own. `/api/health` sends `no-store`.
- **HSTS** is sent only when `HSTS_MAX_AGE` is above 0. The owner decides, because HSTS is hard to undo.
- **No indexing.** `X-Robots-Tag: noindex, nofollow` is sent in demo mode, on `/admin`, `/api`, the account, checkout, cart, order and track pages, and on `*.workers.dev`.
- **Client identity.** The IP is `CF-Connecting-IP`, which Cloudflare sets. In local development there is no client IP, so per-IP rate limits do not apply. The request id is `cf-ray`. Actors carry both into the audit trail.
- **Error responses.** Expected failures become `{ ok: false, code, fields }` (`actionError`) or a status with `{ error: code }` (`throwAsResponse`). An AppError's internal `detail` (ids, column names) never goes into a response body. The one exception is `requireEmployee`'s 403, which tells a signed-in employee which permission they lack. Unexpected errors reach the error boundary.

## 4. Secrets and configuration

Secrets are Worker secrets (`wrangler secret put`). Locally they live in `.dev.vars`, which git ignores. No code reads them at module load: they are passed as parameters, so tests inject their own.

| Secret | Used for | What happens if it changes |
|---|---|---|
| `SESSION_SECRET` (≥ 32 characters) | HMAC of one-time codes (`requestOtp` / `verifyOtp` require it and throw without it), and signed tokens (`signToken`) | Codes still waiting (5 min) and signed tokens stop working. Harmless. |
| `DATA_KEY` (32 random bytes, base64) | AES-256-GCM encryption of TOTP secrets (later also digital codes and integration credentials) | Every encrypted value becomes unreadable: employees with two-step verification must have it reset (`resetEmployeeMfa`) and enrol again. **There is no re-encryption tool yet.** |
| `SETUP_TOKEN` (≥ 16 characters) | The one-time first-owner setup at `/admin/setup` | Shorter than 16 characters or missing means setup is switched off (`setup_disabled`). After the first owner exists it is never accepted again. Delete it after setup. |

`APP_ENV=production` turns on the CSP. `STORE_MODE=demo` turns on `noindex` and the demo ribbon. `HSTS_MAX_AGE` turns on HSTS.

## 5. Customer accounts (`auth/customer.server.ts`, `auth/otp.server.ts`)

- **Guests never need an account.** Checkout works without one (CONTRACTS §1).
- **Sign-up and sign-in** use an Iraqi mobile number, normalized to E.164, and a password. A new password must be 8 to 256 characters.
- **Sign-in failures look the same.** An unknown number, a wrong password or an account without a password all give the same `invalid_credentials` (401), after the same amount of hashing work. A blocked account gets `account_blocked`, but only after the correct password. Merged and deleted accounts get `invalid_credentials`.
- **Sign-up reveals that a number is registered** (`phone_taken`). No sign-up flow can avoid this without SMS verification. Sign-ups are limited per IP.
- **Phone numbers are not verified at sign-up.** No SMS provider is configured, so anyone can register any number. `customer.phoneVerified` is true only after a one-time code confirmed the number (`confirmCustomerPhone`). Services must not attach guest orders to an account, or show order data by phone number, unless it is true.
- **Sessions use the `tt_sid` cookie.** It holds a random 256-bit token and is HttpOnly, SameSite=Lax, `Path=/`, and Secure on HTTPS. The database keeps only `sha256(token)` as the primary key. Each session lasts 30 days from the last visit; the expiry slides, and is written at most once an hour.
  - Every request checks the database, so revoking a session or blocking an account takes effect on the next request, and the dead cookie is cleared.
  - Signing in or signing up replaces any session the browser already had, which prevents session fixation.
  - Customers can list their sessions and revoke one or all of them.
  - Changing the password signs every other device out.
- **One-time codes** have 6 digits, are valid for 5 minutes, and allow at most 5 guesses.
  - A new request cancels the previous code for the same phone and purpose.
  - A code is bound to its phone, its purpose and an optional `ref`, and succeeds only once, even when two correct attempts arrive at the same time.
  - Only `HMAC-SHA256(SESSION_SECRET, id | phone | purpose | code)` is stored.
  - Every failure is the same `otp_invalid`.
  - **No SMS provider is configured.** The message is stored in the outbox with status `held`, without the code, and `requestOtp` returns `delivery: "held"`. Screens must say the code was not sent. The code itself (`devCode`) is returned only when `ctx.isDev` is true, and never in production.

## 6. Staff accounts (`auth/admin.server.ts`)

**Sign-in**
- Email (lower-cased) and password. A staff password must be 12 to 256 characters when it is set or changed.
- An unknown email, a wrong password, a missing password and a disabled account all give the same `invalid_credentials`.

**Lockout**
- 5 failed passwords for one email lock that email until its 15-minute window ends (`locked_out` with `retryAfterSec`). During the lock the correct password is refused too.
- A successful sign-in clears the earlier failures.
- Attempts are also limited per IP, across all accounts.
- Anyone who knows a staff email can trigger the lock. This is accepted: the edge challenge on `/admin/login` makes it slow to abuse.

**Two-step verification (TOTP)**
- When on, the password opens only a half-open session. For 10 minutes, that session can do nothing but submit the code.
- The code is RFC 6238 (SHA-1, 6 digits, 30 seconds), accepted with ±1 step of clock drift.
- Each step can be used once per employee, even inside the window: a replay is refused. The `claimOnce` marker for this lives in `rate_limits`.
- After 6 attempts, the next one ends the half-open session, and the password is needed again.
- Success replaces the session with a new token.
- Enrolment stores the secret encrypted with the context `employee:<id>:totp` and does not turn it on until a valid code proves the app has it. Enrolling signs every other device out and returns 10 recovery codes once.
- A recovery code works once. Two simultaneous uses are resolved with compare-and-swap.
- An employee can turn it off with their password and a code. An administrator with `security.mfa.manage` can reset it with a reason, for example after a lost phone; that signs the employee out everywhere.

**Sessions**
- The `tt_adm` cookie holds a random 256-bit token and is HttpOnly, SameSite=Strict and Secure on HTTPS. Only its SHA-256 is stored.
- It is set for `Path=/admin` and for `Path=/admin.data`. React Router fetches the data of the `/admin` index route from `/admin.data`, which a `/admin` cookie path does not cover.
- A session lasts 12 hours at most, and ends after 2 hours without use.
- Every request checks the database. Revoking a session, or disabling the employee, locks them out on the very next request.
- Employees can list and revoke their own sessions. Revoking someone else's needs `security.session.revoke`. Both are audited.
- Changing the password signs the employee's other devices out.

**Disabling an employee**
- Needs `staff.manage` and a reason.
- Refused for yourself and for the last active owner.
- Revokes every session, and is audited.

**Admin routes**
- Every admin loader and action starts with `requireEmployee(ctx, db, "<permission>")`.
- With no session, it sends a document redirect (`redirectDocument`) to `/admin/login?next=…`. The `next` value is limited to `/admin` paths by `safeNextPath`.
- With a session but without the permission, it answers 403.

**SameSite=Strict side effect:** a link from outside the site (an email, a chat) arrives without the cookie, so the employee lands on `/admin/login`. The login page should call `getEmployee` and forward to `next` when the employee is already signed in.

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
1. **Size**: 8 MB at most. The declared size is checked before the body is read.
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

**Rate limits:** the `upload` preset (20 per 10 minutes per IP or per account) is applied by the upload routes, not by this module.

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
- **Scheduled jobs run since 2026-11-11** (`workers/app.ts` `scheduled` handler, crons in `wrangler.jsonc`, jobs in `app/server/jobs.server.ts`): daily `sealAudit` with its `headHash` written to the Workers logs (outside the database), `cleanupRateLimits`, retention of sessions, trusted devices, one-time codes, `auth_events` (180 days) and the outbox (90 days), and consistency checks; every 5 minutes, unpaid transfer orders and stale reservations expire. Gap: Workers logs are kept for a limited time, so the owner should copy the daily `audit_seal` lines somewhere durable (a Logpush destination or a weekly export). Retention periods are constants, not settings yet.
- **No re-encryption tool for `DATA_KEY` rotation** (§4).
- **Staff sessions are not bound to an IP or device.** A stolen cookie works until the idle (2 h) or absolute (12 h) limit, or until it is revoked. HttpOnly, SameSite=Strict and `Path=/admin` limit how it can be stolen.
- **Content-Security-Policy:** it is off in development, and `style-src` allows inline styles.
- **Public files** may stay in caches after being made private (§9).
- **Two-person refunds are enforced** (since 2026-11-11): above `refunds.approval_threshold_iqd` (default 0, so every refund) a refund waits for `approveRefund`, which needs `orders.refund.approve` and refuses the employee who requested it (`approver_is_requester`). Refunds created by a cancellation always wait for approval.
- **Append-only tables can be rewritten with `INSERT OR REPLACE`.** The UPDATE/DELETE triggers on ledgers and history do not fire on SQLite's REPLACE conflict resolution, so a statement written that way could replace a wallet ledger row (`tests/commerce-adversarial.test.ts`, marked `.fails`). No code path issues REPLACE today; the fix is a BEFORE INSERT trigger that refuses an existing id or idempotency key (data layer, open).

## 15. Go-live checklist (application side)

1. Set the secrets with `wrangler secret put`: `SESSION_SECRET` (64 random characters), `DATA_KEY` (32 random bytes, base64) and `SETUP_TOKEN` (32 random characters). Set `APP_ENV=production`.
2. Run `npm run db:migrate:remote`.
3. Open `/admin/setup` and create the owner. This also installs the reference data and the roles. Then delete the `SETUP_TOKEN` secret.
4. The owner turns on two-step verification and keeps the recovery codes offline.
5. Create staff accounts with the narrowest role that fits. Only owner, manager and finance see cost and profit.
6. Check the cron triggers ran (`job_runs`, or the `scheduled_jobs` / `audit_seal` lines in the Workers logs) and keep the daily `audit_seal` head hashes somewhere outside Cloudflare.
7. Confirm §13 and decide on HSTS.
