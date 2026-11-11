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
- **Append-only tables** (`[A]` in the schema comments) need both a `_no_update` and a `_no_delete`
  trigger. Never use `INSERT OR REPLACE` on them: SQLite deletes the replaced row without firing
  DELETE triggers.
- **`search_index` is a virtual table.** `wrangler d1 export` cannot export databases that contain
  one: drop it before an export and re-run `0002_search.sql` afterwards (it is derived data and can
  be rebuilt from products).
- **`search_index` writes distort change counts in a batch.** D1 reports the rows FTS5 writes to its
  shadow tables as changes (one insert ≈ 9–12), and FTS5 flushes its buffer when the NEXT write
  statement starts, so those changes are also counted for whatever statement follows. Put
  `searchIndexStatements(...)` last in a batch, never guard them (or the statement after them) with
  `expectChanged()`, and count index rows with `SELECT count(*)` if you need the number (see
  `Plan.measure` in `app/server/db/seed/demo.ts`).

## What the database enforces

See the header of `0001_invariants.sql` for the full list, and `app/server/db/tx.server.ts`
(`TRIGGER_ERROR_CODES`, `mapDbError`) for how services read the errors.
