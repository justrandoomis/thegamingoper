# Admin shell

Owner: admin shell. The secure, separate admin experience the 23 blueprint modules plug into (brief §8, DESIGN.md §10,
SECURITY.md §6–7, CONTRACTS.md §4). Arabic first (right to left), English as the second admin language.

## What exists

| Path | What | Who |
|---|---|---|
| `/admin/setup` | First owner, once, with `SETUP_TOKEN` (`createFirstOwner`). Password typed twice. A plain 404 as soon as any employee exists (GET and POST); "switched off" while the token is missing or under 16 characters | nobody signed in |
| `/admin/login` | Email + password, then the authenticator code or a recovery code. Lockout and rate-limit messages name the email, never whether it exists (unknown emails are locked exactly like real ones). `?next=` = a same-origin path under `/admin` only. Signed-in employees go straight to `next`; a cross-site arrival (the Strict cookie is withheld) gets one same-site hop | anyone |
| `/admin/logout` | `POST scope=one\|all` → document redirect to the sign-in page, which says what happened | signed in |
| `/admin/locale` | `POST locale=ar\|en, back=<admin path>` → `tt_admin_locale` cookie (Path=/), document redirect | anyone |
| `/admin` | Minimal home until module 01 is built: what waits for this employee (raised clay cards only for things that need a decision), the two-step nudge, the employee's sections, module 01's blueprint status | signed in |
| `/admin/me` | My security: two-step verification (QR + typed key, recovery codes shown once with copy/download, turn off), password change, own sessions with "end" and "sign out the other devices". A password change and turning two-step on or off sign the other devices out and move this one to a new `tt_adm` token (both cookie paths, same session end; server pass 2026-11-11): a copy of the old cookie stops working | signed in |
| `/admin/blueprint` | 176 functions × status: legend with counts, sections × status matrix (counts link to the filtered list), filters in the URL (status, priority, section, text) | signed in, with at least one admin permission |
| `/admin/<slug>` | Landing page of a module that has no page yet: blueprint number, priority, title, status of its functions. 403 inside the shell when the role cannot see the module, 404 for an unknown name | signed in |
| `/admin/*` | 404 inside the shell | signed in |

Shell chrome (`shell/AdminShell.tsx`): a 248px rail at the inline start from 1200px (static glass, caption-headed
groups P0 first, the active module is a held ink key, queue rows carry a red bead, collapsible to 64px of icons — kept
in the `tt_admin_rail` cookie so the server renders it collapsed); a solid tool bar (search field that opens the
palette, notifications bell, employee menu); a "sections" sheet on tablets; a glass tab bar on phones with the queue
first (waiting · first module · search · sections). Command palette on Ctrl/⌘ K (also by key position, so it works with
an Arabic layout): sections, actions and blueprint functions the employee may use, Arabic/English matching that
ignores diacritics and alef/taa forms. Employee menu: My security, blueprint status, language, theme (light, dark,
device), sign out, sign out on every device. `data-density="admin"` on the whole shell; no page transitions.

## For module owners — how to plug in

1. **Routes** live under `/admin/<slug>/…` (`<slug>` = your folder = your permission group) in your own
   `routes/admin/<slug>/routes.ts`, paths relative to `/admin`. Give your module an index (`route("orders", …, [index(…)])`
   or `route("orders", …)`): it then wins over the shell's landing page automatically.
2. **The gate is coarse, you are precise.** The layout middleware (`shell/gate.server.ts`) refuses every request of a
   module whose permission group the employee holds nothing of — by the matched route pattern, before your loaders
   run. Your loaders and actions still start with `requireEmployee(ctx, getDb(), "<permission>")`, and your services
   with `assertCan`. A route registered outside `/admin/<slug>/` is refused (403) for everyone unless the gate has a rule for it — ask the shell owner.
3. **Page skeleton:** no `<main>` of your own (the shell's is the landmark); start with
   `<h1 className="adm-title">`; section heads `adm-h2` / `adm-h3` (Kufam only for page titles and KPI figures, §10);
   `export const meta = (args) => adminMeta(args, (t) => t("modules.orders"))` from `shell/meta` (keeps noindex and the
   admin suffix). A sticky bottom bar sits at `inset-block-end: var(--adm-bottom)`.
4. **Links:** react-router `<Link to="/admin/…">` — never `LocaleLink` (the admin's language is a cookie, not a URL
   prefix). Since 2026-11-11 `localePath` never prefixes `/admin` or `/api`, so `LocaleLink` and `Menu` items of
   `kind: "link"` keep admin paths as they are too — plain `<Link>` is still the clearer choice in admin code.
5. **Status:** update your own entries in `app/routes/admin/blueprint-status.ts` in the same change as the code —
   `implemented` only when staff can do it in the admin completely (with `route`), `partial` with the missing part in
   `note` (ar + en), `boundary` when only a provider/credential/owner decision is missing. Render
   `<ModuleFunctions moduleId="05" />` on your module's page (or `<ModuleLanding moduleId="05">…</ModuleLanding>` from
   `shell/ModuleLanding` until your first screen). `tests/admin-shell.test.ts` checks every route you name exists.
6. **Strings:** `useT("admin")` gives the module names (`modules.<slug>`), status words (`status.<status>`) and
   priorities; put your own in `app/i18n/messages/admin-<slug>.ts`.
7. **Queues** (the bell, the home cards, the beads): `shell/queues.server.ts` counts, each only for holders of the
   permission to act and never something the employee may not decide themselves: transfer proofs awaiting
   verification → `/admin/orders/proofs`; refunds awaiting a second approval, not the employee's own →
   `/admin/orders/refunds`; price changes awaiting a decision, not the employee's own request (`countDecidable`) →
   `/admin/pricing/changes`; stock counts submitted for approval that the employee neither started nor counted →
   `/admin/inventory/counts?status=review`; transfers in transit → `/admin/inventory/transfers?status=in_transit`
   (`QUEUE_HREF`, icons in `TopBar.tsx`, words `notices.<id>` in `messages/admin.ts`; proof:
   `npx vitest run tests/admin-shell.test.ts -t queues`). Ask the shell owner to add yours.

## Security notes

- Every admin response: `Cache-Control: no-store`, `X-Robots-Tag: noindex, nofollow`, `<meta name="robots">`.
- The gate's 403 for a module the role cannot see is thrown in middleware, so React Router renders it with the ROOT
  error boundary (Arabic, no shell): that is the price of refusing before any module code runs. The landing page's 403
  renders inside the shell. Asked of the lead: let `root.tsx`'s ErrorBoundary hand `/admin` paths to the shell's
  `AdminErrorPage` (`shell/ErrorPage.tsx`).
- `next`: `adminNextPath()` = `safeNextPath(…, "/admin")` + a second decode check + never back to login/setup/logout.
- The hop: only when `Sec-Fetch-Site: cross-site`, no session cookie visible and no `hop` marker yet; the page then
  `location.replace`s itself from its own origin (a link for no-JS). Browsers without fetch metadata just see the form.
- Secrets reach the auth services through `shell/env.server.ts` (route modules never import `cloudflare:workers`).

## Local demo accounts

`npx tsx --tsconfig tsconfig.cloudflare.json scripts/dev-accounts.ts` — one demo owner and one demo customer (both
`is_demo`) in the LOCAL database, idempotent (re-run after every `npm run db:reset`); credentials only in
`.dev.seed-credentials` (git-ignored, reused across resets, never printed). `--reset-mfa` turns the owner's two-step
verification off again; `--credentials-only` writes the file without touching the database (to create the owner
through `/admin/setup`). Refuses any other argument (`--remote`, …) and `APP_ENV=production`.

## Verify

```
npx vitest run tests/admin-shell.test.ts      # 25 tests: registry vs blueprint JSON, next validation, visibility per role,
                                              # navigation, gate (redirect with next, 403 before loaders, POST too), setup once,
                                              # sign-in (same failure for unknown/wrong, lockout wording, TOTP, replay, recovery
                                              # code once, hop), queues, My security, sign-out, language
npx vitest run tests/i18n.test.ts             # admin and admin-auth namespaces complete in ar, en, ckb
node scripts/lint-design.mjs app/routes/admin # 0 findings
```

Browser checks (puppeteer, Chromium): setup once then 404; sign-in; enrolment with QR and recovery codes; sign-in with
the app code and with a recovery code; a link from another site reaching its page through the hop; palette (Enter,
Escape returns focus); rail collapse over a reload; theme and language from the menu. Screenshots of every page at 390
and 1440, light and dark, ar and en (`.shots/admin/`), no horizontal overflow, no console errors.

## Not done / limits

- The queue cards and beads were checked with tests, not seen in the browser (the dev database has no pending proofs).
- Records (orders, customers, SKUs, serials, tickets) are not searchable from the palette (blueprint 01.06, module 01).
- Trusted devices, requiring two-step verification for a role, other employees' sessions, disabling staff: modules 15/20.
- Recovery codes cannot be regenerated without turning two-step verification off and on (no service for it).
- The admin offers Arabic and English only; the Sorani strings exist for the catalogue test and need a native reader.
- Chromium only (no Safari/Firefox/real phones).
