# Admin 20 — Security & Compliance (`/admin/security/…`)

Owner: admin security. Blueprint module 20 (20.01–20.08). Reads and acts on what the core already records — sessions
(`employee_sessions`), sign-ins (`auth_events`), the audit trail (`audit_events` + `audit_seals`), roles
(`roles`, `role_permissions`, `employee_roles`), refunds — through the auth core's own operations
(`revokeEmployeeSession`, `revokeAllEmployeeSessions`, `resetEmployeeMfa`) and `sealAudit` / `verifyAuditChain`.
Services: `app/server/services/admin/security/*` (client-safe constants and URL parsers in `types.ts`).

## Routes

| Path | What | Loader permission |
|---|---|---|
| `/admin/security` | Decisions (staff without two-step, sign-in alerts 24 h, refunds to review, restore test due, role reviews due), figures, honest limits, `<ModuleFunctions moduleId="20">` | signed in (each block by its permission) |
| `/admin/security/staff` | Staff with two-step status, roles, sessions, last sign-in; coverage per role; URL filters (two-step, status, role, text) | `security.session.read` |
| `/admin/security/staff/:employeeId` | Sessions (device, address, last seen; end one / all — `security.session.revoke`), two-step reset (owner, `security.mfa.manage`), sign-in events (`security.auth_event.read`), roles and branch limit (`staff.manage`) | `security.session.read` |
| `/admin/security/roles` · `/roles/:roleId` | Roles with members, permission counts, field permissions, last review; one role's permissions by module (edit with impact), members, access review | `staff.manage` or `security.access_review.perform` or `security.session.read` |
| `/admin/security/audit` · `/audit/:eventId` · `/audit/export` | The trail (module, person, record type and id, days, text; 50 a page), chain panel (verify / seal now — `security.audit.verify`), one event (before/after, same request, seal), CSV ≤ 5,000 rows | `audit.read` |
| `/admin/security/protections` | `#encryption` (`security.audit.verify`): DATA_KEY self-test, readable authenticator secrets, protected-record counts; `#duplicates` (`security.fraud.review`): unique rules present, flagged proofs and top-ups, inbound events | either; 403 with neither |
| `/admin/security/backups` | Recovery plan, wrangler commands, restore tests (record one) | `security.backup.manage` |
| `/admin/security/retention` | Retention periods (read-only, from the jobs' constants) + the retention job's last run; access reviews due | `security.retention.manage` or `security.access_review.perform` or `audit.read` |
| `/admin/security/sign-ins` | Alerts by rule (24 h / 7 d / 30 d) and the sign-in log with filters | `security.auth_event.read` |
| `/admin/security/refunds` | Refunds of 90 days with signals; views flagged / unreviewed / suspicious / all; review | `security.fraud.review` |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Missing / note |
|---|---|---|
| 20.01 | partial | Trusted devices and two-step required per role: the sign-in service has neither (`employee_trusted_devices` exists, unused) |
| 20.02 | partial | No branch exists yet (module 21): the branch limit can only be "none" |
| 20.03 | implemented | Sealed daily by the job; "seal now" for an audit or before a restore |
| 20.04 | partial | No DATA_KEY rotation; digital codes are module 13's |
| 20.05 | partial | Backups/restores are Cloudflare D1 Time Travel (30 days) via wrangler; KV files have no history |
| 20.06 | boundary | No payment provider, so no webhook arrives (21.05) |
| 20.07 | implemented | Periods set in code (`RETENTION_DAYS`, `ASSISTANT_RETENTION_DAYS`, …), shown read-only; customer erasure is 07.04 |
| 20.08 | implemented | Alerts are computed on read (no notification is sent — no provider) |

## Rules

- **Sessions / two-step**: ending a session or all of them and resetting two-step need a reason (≥ 3), are audited
  (`security.session.revoke`, the core's `security.mfa.reset`), and never apply to one's own account here
  (`own_account_here` — /admin/me is for that). A reset also ends every session of that employee, and is refused for
  an employee who holds any permission the resetter does not (`target_more_privileged`, 403 — with a known password,
  removing a stronger account's second factor is taking it over). Ending sessions stays open to `security.session.revoke`
  whatever the target holds (it only ever protects an account).
- **Roles**: the owner role is locked; `*` is the owner's alone (`wildcard_owner_only`); nobody grants a permission they
  do not hold (`grant_exceeds_own`, also for role assignment and for a copied role — what exceeds is skipped and
  counted) and nobody takes away what they could not give (`revoke_exceeds_own`: permissions removed from a role, roles
  taken from an employee — so only an owner takes the owner role from an owner); a branch limit is never set on someone
  who holds more than the actor (`target_more_privileged`); nobody edits a role they hold (`own_role`) or their own
  assignment (`own_roles`); the last active owner keeps the role (`last_owner`, guarded in the batch). Every editor posts
  the fingerprint it saw (sorted permissions, or the sorted role ids) — refused when stale (`role_changed`,
  `roles_changed`), also inside the batch (`group_concat` guard). Confirmation shows added/removed permissions, field
  permissions gained or lost, and the members affected. What the viewer cannot change is shown as a fact (a ticked or a
  dashed box, `Fact`), never as a disabled checkbox — the kit draws a disabled tick invisibly.
- **Audit**: snapshots of cost families (`pricing.cost*`, `pricing.landed*`, `pricing.margin*`, `purchasing.*`,
  `finance.*`) are withheld without `cost.read`; elsewhere cost / margin / profit keys are cut from before/after (also
  in the CSV, whose cells are formula-safe). Verify and seal are recorded (`security.audit.verify`, `.seal`), the export
  too (`security.audit.export`, with its filters).
- **Restore tests**: evidence, not a button: date (not in the future), method, target, minutes, result, checks;
  idempotent per form (`aud_rt_<hash>`); due after 90 days without a passed test.
- **Access reviews**: per role, against what the reviewer saw — the permission fingerprint AND the members
  (`membersFingerprint`, sorted ids; `role_changed` otherwise, so someone given the role after the page opened is never
  "confirmed" unseen); outcome confirmed or changes needed with a note; due 90 days after the last one.
- **Sign-in alerts** (`SIGNIN_THRESHOLDS`): ≥ 5 failures of one identifier, ≥ 10 from one address, ≥ 5 unknown
  identifiers from one address, lockouts, ≥ 3 failed second steps, disabled accounts, a refused attempt to turn two-step
  verification off, a staff
  sign-in from an address unseen in 90 days. Phone identifiers masked without `customer.phone.read_full` — everywhere in
  the page data: an alert's row key is opaque (`rule:index`), never what was typed; searching part of a number needs
  that permission (a whole number is matched exactly).
- **Refund reviews**: signals ≥ 1,000,000 IQD, a method other than the payment's, one person asked and approved, ≥ 3 by
  one person in 24 h, ≥ 2 others for the same customer in 90 days; outcome cleared / suspicious, always with a note;
  never by who created or approved it (`reviewer_involved`). Money never moves here.
- Typed numbers accept Arabic-Indic and Persian digits; days are Baghdad days.

## Permissions and data

Every loader/action: `requireEmployee`; every service: `assertCan` / `assertAny` before reading input. Nothing secret
leaves the server: no session token, password hash, TOTP secret or recovery code; the encryption page returns booleans
and counts. Pages refused by their service answer 403 through `throwAsResponse`.

## Invariants (tested — `tests/admin-security.test.ts`, 22; `tests/admin-security-review.test.ts`, 8)

Review 2026-11-11 (each failed before its fix): no full phone in the sign-in alerts' data (row keys); no two-step reset
of a stronger account; no removal of a role or permission one could not give (the owner role above all); no branch
limit on a stronger account; access reviews refused when the members changed; the retention rows equal the purges'
constants (guard).

Authorization per role on every service; session end idempotent and audited; two-step reset only when on, never on
oneself; role rules above incl. stale fingerprints and the last owner; audit cost withholding on screen and in the CSV;
seal + verify recorded; encryption status never contains a secret (and detects a wrong key); every idempotency rule
present; restore test idempotent and never in the future; access review against a stale role refused; sign-in alerts,
masking and partial-number search; refund signals and the reviewer rule; route loaders 403 for roles without the page;
every error code of modules 20 and 22 has a text in ar, en and ckb.

## Boundaries (honest)

- No notification provider: alerts are shown, not sent. No webhook provider (20.06). Backups run in Cloudflare.
- Trusted devices and per-role two-step enforcement need the auth core (requested below).

## Verify

```
npx vitest run tests/admin-security*.test.ts tests/admin-settings*.test.ts   # 22 + 8 + 19 + 5
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-security/seed-review.ts     # review: demo HR role + employee (non-owner views)
node scripts/lint-design.mjs app/routes/admin/security                     # 0 findings
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-security/seed-security.ts   # demo manager, finance, cashier
npx tsx --tsconfig tsconfig.cloudflare.json .shots/admin-security/inspect.ts         # read-only: what browser runs left in the dev DB
```

Screenshots: `.shots/admin-security/` (390/1440 × light/dark × ar/en; dialogs, validation, 403).

## Requests to other owners

- **Auth core**: enforce two-step per role (a role flag read at sign-in) and the trusted-device step
  (`employee_trusted_devices`); a DATA_KEY rotation tool (re-encrypt TOTP secrets under a new key).
- **Shell** (`queues.server.ts`): bell items for sign-in alerts (`alertCount`), unreviewed flagged refunds
  (`unreviewedCount`) and settings requests (`countDecidableSettingChanges` → `/admin/settings/changes`).
- **Shell gate**: `/admin/security/roles` is reachable with `staff.manage` alone in the service, but the module gate
  needs a `security.*` permission — a custom role with only `staff.manage` gets 403 at the gate.
- **Staff (15)**: link 15.01 (roles) to `/admin/security/roles` instead of building a second editor.
- **SECURITY.md owner**: §10/§12 — identifier masking on the sign-in log, `setSetting({ expected })`, settings approvals;
  §6–7 — the hierarchy rules above (two-step reset, role removal, branch limit need everything the target holds).
- **Kit owner** (`app/styles/components.css`): `.choice:has(> .choice__input:disabled) .choice__box` paints the box
  `--niche` while the tick keeps `--paper` / `--on-sel`, so a disabled CHECKED checkbox looks unchecked in both themes
  (seen on the role editor before it switched to facts). A disabled checked box should keep a visible ink tick.
