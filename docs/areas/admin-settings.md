# Admin 22 — Settings & Administration (`/admin/settings/…`)

Owner: admin settings. Blueprint module 22 (22.01–22.06). The editor of every key of the settings registry
(`app/server/settings.server.ts`, extended here additively), the two-person changes of the money-control limits, and
the store-wide pages around them. Services: `app/server/services/admin/settings/*` (`catalog.ts` and `policy-text.ts`
are client-safe: editors, units, template catalogue, the policy line syntax).

## Routes

| Path | What | Loader permission |
|---|---|---|
| `/admin/settings` | Requests waiting for this employee, then every key by group (controls, payments, checkout, policies, service, shipping, store, locale) with its value in force, default or changed by whom, `<ModuleFunctions moduleId="22">` | `settings.read` |
| `/admin/settings/keys/:key` | One key: value, pending request (approve / reject / withdraw), editor (or where it is edited), its history | `settings.read` (writes: the key's permission) |
| `/admin/settings/changes` | The log of every `settings.*` action (values, requests, decisions, fields, templates, policies), by key, 40 a page; open requests | `settings.read` |
| `/admin/settings/currency` | IQD (fixed), the store USD rate in force with its date, scheduled rates, history — entered on `/admin/pricing/fx` | `settings.read` |
| `/admin/settings/policies` · `/policies/:slug` | Shipping fee and overrides (→ `/admin/shipping/zones`), tax rates (→ module 10), return window, trade-in validity, hardware without warranty months, the six policies; the returns and warranty texts: start draft, edit as lines, approve, withdraw | `settings.read` (edit `cms.page.manage`, approve `cms.page.publish`) |
| `/admin/settings/fields` · `/fields/:fieldId` (`new`) | Custom product fields with use counts; create / edit / on-off with the products affected | `settings.read` (writes and `new`: `settings.custom_field.manage`) |
| `/admin/settings/templates` · `/templates/:key` | The ten queued text messages × ar/en/ckb, outbox counts (30 days); edit with preview | `settings.read` (writes `settings.template.manage`) |
| `/admin/settings/files` | Uploads by kind and visibility, the latest 30, uploads nothing refers to | `settings.file.manage` |
| `/admin/settings/locale` | Baghdad time now, date samples per language, numerals, direction | `settings.read` |
| `/admin/settings/environment` | `STORE_MODE` / `APP_ENV` (deploy variables, read-only), demo records per table | `settings.read` |

## Functions → status (`app/routes/admin/blueprint-status.ts`)

| Id | Status | Missing / note |
|---|---|---|
| 22.01 | implemented | The rate itself is entered on module 03's `/admin/pricing/fx` |
| 22.02 | partial | Checkout adds no tax (owner decision); the store's own warranty terms are undecided |
| 22.03 | partial | No min / max / pattern rules (type, options, required only — used by the catalog's form and completeness) |
| 22.04 | partial | No SMS provider; sending does not read `message_templates` yet; invoices are module 05's printing |
| 22.05 | partial | `locale.numbering` and translation overrides are stored but unread — not offered |
| 22.06 | partial | No separate test deployment; the store mode is a deploy variable |

## Keys added to the registry (additive)

| Key | Default (= the constant it replaces) | Permission / approver | Read by |
|---|---|---|---|
| `pricing.drop_approval_bps` | 1000 (`DROP_APPROVAL_BPS`) | `settings.manage` / `settings.change.approve` | pricing `prices.server`, `special.server` (`evaluatePriceChange({ dropApprovalBps })`) |
| `purchasing.po_approval_limit_iqd` | 1,000,000 (`PO_SPENDING_LIMIT_IQD`) | same | purchasing `orders.server` (`limitCheckOf`), order pages |
| `finance.topup_second_approval_iqd` | 500,000 (`TOPUP_SECOND_APPROVAL_ABOVE_IQD`) | same | finance `wallets.server` |
| `finance.expense_second_approval_iqd` | 500,000 (`EXPENSE_SECOND_APPROVAL_ABOVE_IQD`) | same | `accounting/expenses.server` (`expenseApprovalLimit`), `expense-views.server` |
| `returns.sla` | `{48 h, 48 h, 7 d, 14 d, 30 d}` (`SLA`) | `settings.manage`, no approver | returns `shared.server` (`slaTargets`) → rma, inspect, warranty, repair |

Exported signatures of those modules are unchanged (the constants stay as defaults). `setSetting(…, { expected })`
(`null` = "the stored value was broken"), `settingChangeStatements` and `readSettingState` are new, additive parts of
the core.

## Rules

- **Every change** posts the value the form showed (`expected`): refused when the value in force differs — ONE read,
  compared and then guarded inside the batch on the same stored text (`SETTING_CHANGED` → `setting_changed`, 409; two
  reads let a change landing between them win silently — review 2026-11-11). The key's permission is checked before
  anything else the form carries (403, never "write the reason"). A reason (≥ 3) always; audited before/after
  (`settings.setting.update`). Saving the value in force is `no_change`; asking for a value someone already set is
  answered "already in force" (nothing written); an unchanged form never offers its key.
- **A stored value that no longer fits its schema** (`readSettingState`): every other reader still refuses it
  (`getSetting` throws); this module shows it as such ("—" and the schema's complaint, never a crash of the whole
  module) and replaces it — the form starts from the default and says it saw "broken" (`expected: null`, which matches
  only a broken stored value, guarded on its text).
- **Money-control limits** (`approver` in the registry): changed directly only with `settings.change.approve` (owner);
  `setSetting` itself refuses others (`setting_needs_approval`). Anyone else with the key's permission REQUESTS:
  an `approvals` row (kind `settings`, id from the form's key — a resend is a replay, other values on the same key
  `idempotency_mismatch`), one open request per key (`change_pending`, guarded), 14 days to decide. Another employee
  holding both permissions approves — never the requester (`approver_is_requester`) — and the approval, the value and
  both audit events are ONE batch guarded on the value asked against (stale → `setting_changed`, nothing written).
  Rejecting needs a note; the requester may withdraw. An EXPIRED request no longer locks the key's editor (`blocked` is
  for a live one) and an approver may close it (`canReject`: rejected with a note) — before, only its requester could.
- **Linked keys** (`shipping.*`) are edited in module 11 (with its impact preview); unused keys
  (`checkout.reservation_minutes`, `locale.numbering`) are shown read-only with why.
- **Custom fields**: one key across all kinds (`key_taken`, guarded); key fixed after creation (`key_locked`); type
  fixed once a product has a value (`type_locked`); an option a product uses cannot be removed (`option_in_use`); the
  form's version (all columns) must match (`field_changed`); switching off keeps the values. All audited.
- **Templates**: only the message's variables (`template_variable_unknown`), the required ones present
  (`template_variable_missing`), ≤ 640 characters, guarded on the row's `updated_at` (`template_changed`).
- **Policies** (returns, warranty — the others are module 17's): start copies the code's draft (today's settings filled
  in) into the CMS row's draft; the editor's line syntax (`policy-text.ts`: `##`, `-`, `1.`, `>`, `[info]`, tables)
  round-trips the real drafts (tested; invisible bidi isolates are dropped, SECURITY §5); approve = published, not demo
  → the storefront serves it (`source: "cms"`); withdraw = archived → the draft is served again. Guarded on
  `updated_at`, audited (`settings.policy.*`).
- Typed amounts and percentages accept Arabic-Indic and Persian digits and thousands marks (`parseWhole`,
  `parsePercentBps`; a decimal in a whole amount is refused, never ×10).

## Invariants (tested — `tests/admin-settings.test.ts`, 19; `tests/admin-settings-review.test.ts`, 5)

Review 2026-11-11 (each failed before its fix): a change landing between the read and the batch is refused, never
overwritten; 403 before any field error (service and route); an expired request unlocks the key and can be closed by
an approver; a broken stored value never crashes the module and is replaced with `expected: null`.

`expected` guard before and inside the batch; the approver rule in `setSetting`; request → approve in one batch,
replay, mismatch, one open request, stale request refused with nothing written, expiry, withdraw, reject note, the
requester never approves (even after gaining the permission); defaults equal the old constants and a changed setting
changes pricing (cut limit), purchasing (PO approval), expenses and returns (SLA); every key has an editor; client-safe
lists equal the schema's; custom field, template and policy rules; routes: 403 without `settings.read`, the key page's
request/approve actions. `tests/server-core.test.ts` lists the new keys.

## Verify

```
npx vitest run tests/admin-settings*.test.ts tests/admin-security*.test.ts   # 19 + 5 + 22 + 8
node scripts/lint-design.mjs app/routes/admin/settings                     # 0 findings
```

Screenshots: `.shots/admin-security/` (`set-*`).

## Requests to other owners

- **Shipping (11)**: pass `{ expected }` (the fee/switch the form showed) to `setSetting` in `zones.server.ts`
  (`setFlatFee`, `setOverridesEnabled`) — the core now refuses a stale change inside the batch.
- **Pricing (03)**: `admin-pricing.ts` strings `drop_over_limit` / `usedLead` say "10 %" — read the setting.
- **Returns (12)**: `routes/admin/returns/index.tsx` and `quarantine.tsx` print the `SLA` constants — use `slaTargets`.
- **STATUS rows 03, 09, 10, 12**: their limits are settings now (rows still say "constant").
- **Catalog (02)**: if min/max/pattern rules are wanted, `custom_fields` needs a column and `customValues` the check.
- **Storefront shell / i18n**: `locale.numbering` as each language's default numerals; translation overrides unread.
- **Commerce core**: `checkout.reservation_minutes` is not read by the reservation code.
- **Outbox sender (21)**: render `message_templates` (active row for key + locale, else the code's text).

## Module follow-up 2026-11-12

Seven keys (additive, defaults = the modules' constants): `customers.rfm_rules`, `customers.flag_rules` (approver), `customers.privacy_due_days`, `promotions.discount_limits`, `promotions.loyalty`, `promotions.referral`, `promotions.gift_card` (approver) — groups `customers`, `promotions`; editor units `count`, `points`; field errors `not_ascending`, `step_1000`. Template `support_reply` (`ticketRef`, `body` — required). `PolicyListItem.contentHref` (/admin/cms/pages/<slug> for whoever may open it); `startPolicyDraft({ from: "approved" })` (`policy_no_approved`), `PolicyEditor.fromApproved`; numbered lines accept Persian digits.

Tests (each failed before its change): `tests/admin-settings-followup.test.ts`, `tests/admin-settings-keys.test.ts`.

Review of the follow-up (2026-11-12): the object editors declare the rules between their fields (`SettingEditor.object.checks` — `ascending`, `notBelow` — and `FieldSpec.int.step`), the same ones the schemas enforce, so the form marks the field that breaks one before anything is sent (`not_ascending`, `below_paired`, `step_1000`); before, the change dialog said "check the highlighted fields" with none highlighted. `promotions.gift_card` refuses a maximum below the minimum with `below_paired`. Test: `tests/admin-followup-review.test.ts`.
