# Database migrations

SQL migrations for the `DB` D1 database, applied in file-name order by wrangler:

```
npm run db:migrate          apply to the local D1 (the one `npm run dev` uses)
npm run db:migrate:remote   apply to the production D1 (owner only)
npm run db:reset            local only: drop everything, migrate, seed reference data, roles (+ demo) data
```

| File | Written by | Contains |
|---|---|---|
| `0000_base.sql` | drizzle-kit | every table, index, foreign key and CHECK from `app/server/db/schema/` |
| `0001_invariants.sql` | hand | `_tx_guard` and the invariant triggers (`TT:<CODE>:<detail>`) |
| `0002_search.sql` | hand | the FTS5 table `search_index` |
| `0003_append_only_no_replace.sql` | hand | `_replace_guard` and the `<table>_no_replace` triggers: append-only tables refuse `INSERT OR REPLACE` (section below) |
| `0004_accounts_access_ops.sql` | drizzle-kit + hand | admin wave D (2026-11-12): tables `incident_links` (an incident's findings, runs and errors) and `employee_password_links` (one-time password-set links, hashes only); columns `roles.requires_mfa`, `consistency_findings.assigned_to` / `.incident_id`, `is_demo` on `error_reports` and `perf_rollups` (not in its key — a demo row needs a key of its own); then, hand-written, the system accounts `employee_advances` (1300), `gift_card_liability` (2150) and `salaries_payable` (2200) for a database whose chart was seeded before it (section below). No table rebuild, no trigger |
| `meta/` | drizzle-kit | its journal and schema snapshots — do not edit |

Tests build their own database from these files (`tests/helpers/db.ts`), so a migration that does
not apply cleanly fails `npm test` before it reaches anyone's data.

## Changing the schema

1. Edit the table in `app/server/db/schema/<group>.ts`.
2. `npm run db:generate -- --name=<what_changed>` writes the next `NNNN_<name>.sql`. Read it.
3. Hand-written SQL (triggers, FTS, data fixes): `npm run db:generate -- --custom --name=<what>`
   creates an empty file that is registered in drizzle's journal; write the SQL into it.
4. `npm test -- tests/db-invariants.test.ts`, then `npm run db:migrate`.

Never edit a migration that has been applied to production — add a new one.

## Rules for migration files

- **One statement per chunk, separated by a line containing only the drizzle statement-breakpoint
  marker** (see the existing files). The test helper splits on that marker, wrangler splits with
  its own SQL parser; a test checks that both produce the same statements. Do not write the marker
  text inside a comment, and do not write the words "BEGIN TRANSACTION" anywhere (wrangler strips them).
- **Each file runs as one transaction** (a D1 batch): it applies completely or not at all. Do not
  write `BEGIN` / `COMMIT`.
- **A table rebuild drops that table's triggers.** SQLite cannot alter most things in place, so
  drizzle-kit often generates `CREATE TABLE __new_x … INSERT … DROP TABLE x … RENAME`. Dropping
  `x` silently drops every trigger on it. When a generated migration rebuilds a table that has
  triggers in `0001_invariants.sql` (or later files), append the `CREATE TRIGGER` statements for
  that table to the same migration. `tests/db-invariants.test.ts` compares the installed triggers
  with its expected list and fails if one is missing.
- **Foreign keys are always on in D1.** A rebuild of a table that other tables reference must start
  with `PRAGMA defer_foreign_keys = on;` as its first statement (drizzle-kit writes
  `PRAGMA foreign_keys=OFF`, which D1 ignores).
- **Trigger messages** have the form `TT:<CODE>:<detail>`: `CODE` in UPPER_SNAKE_CASE, `detail`
  the id the caller needs. Add new codes to `TRIGGER_ERROR_CODES` in `app/server/db/tx.server.ts`,
  to the list in `tests/db-invariants.test.ts`, and to `docs/ARCHITECTURE.md` §7.
- **Validation triggers on INSERT are `AFTER INSERT`**, so `INSERT … ON CONFLICT DO NOTHING / DO
  UPDATE` keeps working as written (a `BEFORE INSERT` trigger also fires for rows that end up as a
  conflict).
- **Append-only tables** (`[A]` in the schema comments) need three triggers: `_no_update`,
  `_no_delete` and `_no_replace` (next section). The `_no_replace` trigger names every UNIQUE key of
  its table, so a migration that adds a UNIQUE index to an `[A]` table re-creates that trigger too.
- **`search_index` is a virtual table.** `wrangler d1 export` cannot export databases that contain
  one: drop it before an export and re-run `0002_search.sql` afterwards (it is derived data and can
  be rebuilt from products).
- **`search_index` writes distort change counts in a batch.** D1 reports the rows FTS5 writes to its
  shadow tables as changes (one insert ≈ 9–12), and FTS5 flushes its buffer when the NEXT write
  statement starts, so those changes are also counted for whatever statement follows. Put
  `searchIndexStatements(...)` last in a batch, never guard them (or the statement after them) with
  `expectChanged()`, and count index rows with `SELECT count(*)` if you need the number (see
  `Plan.measure` in `app/server/db/seed/demo.ts`).

## `INSERT OR REPLACE` on append-only tables (`0003_append_only_no_replace.sql`)

SQLite settles a PRIMARY KEY or UNIQUE conflict of `INSERT OR REPLACE` (also written `REPLACE INTO`)
by deleting the old row, and D1 fires no DELETE trigger for that delete (`recursive_triggers` is off).
With only `_no_update` / `_no_delete`, one such statement could rewrite a ledger row. Since `0003`
every `[A]` table has a `BEFORE INSERT` trigger `<table>_no_replace` that fires only when the new row
meets an existing row on the primary key or on another UNIQUE key, and then runs one probe:

    INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('<table>', NULL)

SQLite runs a trigger's statements with the conflict clause of the statement that fired it when that
statement names one (`OR REPLACE`, `OR IGNORE`, …), and with their own clause otherwise (plain `INSERT`
and upserts). The `NULL` breaks `NOT NULL` on purpose:

| The insert is written as | The probe | Result (for a row that meets an existing key) |
|---|---|---|
| `INSERT` | skipped (its own `OR IGNORE`) | SQLite's error, as before: `UNIQUE constraint failed: <table>.<column>` |
| `ON CONFLICT DO NOTHING`, `INSERT OR IGNORE` | skipped | the row is skipped, `changes()` = 0, as before |
| `ON CONFLICT DO UPDATE` | skipped | the update meets `<table>_no_update`: `TT:IMMUTABLE:<table>`, as before |
| `INSERT OR REPLACE`, `REPLACE INTO` | runs as `OR REPLACE`, which fills the `NULL` with the default: a guard row is inserted | `_replace_guard_check` aborts the statement and its batch: `TT:IMMUTABLE:<table>` |
| `INSERT OR ABORT`, `OR FAIL` | runs with that clause | still refused, but the error names `_replace_guard.probe` (nothing uses these clauses; `OR ROLLBACK` is an internal error on D1 anyway) |

`_replace_guard` never keeps a row (a row written to it directly is refused the same way), and the
guard writes nothing on any statement that succeeds. That matters because D1 counts rows written by
triggers in `meta.changes`: `expectChanged()`, the demo seed's "written" counts and its `--sql` replay
see exactly what they saw before. A row that meets no existing key is not affected at all.

**Why not `RAISE(ABORT)` or `RAISE(IGNORE)` per table.** A `BEFORE INSERT` trigger fires before the
conflict check and cannot see the conflict clause, so a direct `RAISE` changes every insert that meets
an existing key. `RAISE(ABORT, 'TT:IMMUTABLE…')` would replace the UNIQUE error that the replay paths
read, and make `ON CONFLICT DO NOTHING` fail; `RAISE(IGNORE)` would drop a duplicate in silence while
the rest of its batch commits. The table-by-table check:

| Table | UNIQUE keys the guard checks | Written today by | What either `RAISE` would have broken |
|---|---|---|---|
| `wallet_ledger` | `id`, `idempotency_key` | `creditWallet()`; debits and refund credits inside their batches | ABORT: `creditWallet` reads `UNIQUE wallet_ledger.idempotency_key` to return `{ entryId, replayed: true }`. IGNORE: a replayed credit would post its journal entry twice |
| `journal_entries` | `id`, `idempotency_key`, `reverses_id` | `journalEntryStatements()` (header last) | ABORT: `mapPostingError` reads the UNIQUE error as `already_posted`. IGNORE: a replayed header would leave its lines without a header |
| `journal_lines` | `id` | `journalEntryStatements()` (ids `<entry>.<n>`) | IGNORE: a duplicate line would be dropped without an error instead of failing its batch |
| `audit_seals` | `id`, `from_seq`, `to_seq` | `sealAudit()` | ABORT: a concurrent run reads the UNIQUE error and continues from the new head. IGNORE: the losing run would count a seal it never wrote |
| `stock_movements` | `id` | stock and returns services (new ids); the demo seed with `ON CONFLICT (id) DO NOTHING` | ABORT: the seed's second run and its `--sql` file applied twice would fail |
| `audit_events` | `seq`, `id` | `auditStatement()`, `audit()` (new ids) | IGNORE: an audit event could vanish while the change it records commits |
| `consents`, `order_events` | `id` | `placeOrder()`, order, payment and refund services (new ids) | IGNORE: as for audit events |
| `loyalty_ledger`, `cash_movements` | `id`, `idempotency_key` | no writer yet; replays are meant to be detected by the UNIQUE key | the same as `wallet_ledger` |
| `product_versions` | `id`, (`product_id`, `version`) | no writer yet | ABORT: a concurrent save would get IMMUTABLE instead of the UNIQUE `version` error. IGNORE: it would be dropped in silence |
| `price_changes`, `shipment_events`, `repair_events`, `trade_in_events` | `id` | no writer yet | IGNORE: silent loss of history |

`tests/db-invariants.test.ts` proves, for all fifteen tables and every UNIQUE key: `INSERT OR REPLACE`
and `REPLACE INTO` are refused and leave the row as it was; `ON CONFLICT DO NOTHING` (with and without a
target) and `INSERT OR IGNORE` change 0 rows; a plain duplicate fails with the same UNIQUE error; a
refused REPLACE rolls its batch back; and each trigger names every UNIQUE key of its table.

## Reference data in a migration (`0004`: new system accounts)

The chart of accounts is reference data (`seedReference`, `CHART_OF_ACCOUNTS` in `app/server/db/seed/reference.ts`): a
new database gets it from `/admin/setup` (`createFirstOwner`) or `db:reset`, never from a migration — a freshly migrated
production database must stay EMPTY until setup (`tests/server-core.test.ts`, "an empty production database"). A new
system account therefore goes in two places: the chart (for new databases) and a hand-written `INSERT … SELECT … WHERE`
in the migration for databases whose chart already exists:

- only `WHERE EXISTS (… system_key = 'cash')` — an empty database gets nothing;
- never twice — `AND NOT EXISTS (… system_key = '<key>' OR id = 'acc_<key>')`, so a replay or a later seed changes nothing;
- never failing on a renumbered chart — the code is `CASE WHEN EXISTS (code taken) THEN 'SYS-<key>' ELSE '<code>' END`:
  services find accounts by `system_key`, so the key must exist after the migration, whatever its code;
- the same names as the chart (`tests/db-invariants.test.ts`, "migration 0004" checks the statements on an empty
  database, on a seeded one with a taken code, and replayed).

## What the database enforces

See the header of `0001_invariants.sql` for the full list, and `app/server/db/tx.server.ts`
(`TRIGGER_ERROR_CODES`, `mapDbError`) for how services read the errors.
