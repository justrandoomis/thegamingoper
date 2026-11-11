/**
 * Applies the SQL migrations in ./drizzle to a D1 database — the same way
 * `wrangler d1 migrations apply` does (one transaction per file, recorded by file name in
 * `d1_migrations`), so a database built here and one built by wrangler are interchangeable.
 *
 * Node-only (reads files). Used by tests/helpers/db.ts and scripts/db-reset.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MIGRATIONS_DIR = path.join(PROJECT_ROOT, "drizzle");
/** wrangler's default bookkeeping table. */
export const MIGRATIONS_TABLE = "d1_migrations";
/** drizzle-kit's statement separator; hand-written migrations use it too. */
export const STATEMENT_BREAKPOINT = "--> statement-breakpoint";

export type Migration = { name: string; statements: string[] };

const leadingNumber = (name: string) => Number.parseInt(name.split("_")[0] ?? "", 10);

/** True when the text is only whitespace and SQL comments (quote-aware). */
function isBlankSql(text: string): boolean {
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n" || ch === "\f") {
      i++;
    } else if (ch === "-" && text[i + 1] === "-") {
      const end = text.indexOf("\n", i);
      if (end === -1) return true;
      i = end + 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) return true;
      i = end + 2;
    } else {
      return false;
    }
  }
  return true;
}

/** Splits a migration file on the statement-breakpoint marker; comment-only chunks are dropped. */
export function splitStatements(sqlText: string): string[] {
  return sqlText
    .split(STATEMENT_BREAKPOINT)
    .map((chunk) => chunk.trim())
    .filter((chunk) => !isBlankSql(chunk));
}

/** Migration files in the order wrangler applies them: by leading number, then by name. */
export function listMigrations(dir: string = MIGRATIONS_DIR): Migration[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort((a, b) => {
      const an = leadingNumber(a);
      const bn = leadingNumber(b);
      if (an !== bn && Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return a < b ? -1 : a > b ? 1 : 0;
    })
    .map((name) => ({ name, statements: splitStatements(readFileSync(path.join(dir, name), "utf8")) }));
}

async function withRetry<T>(run: () => Promise<T>, attempts = 6): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The dev server may hold the database for a moment; anything else is a real failure.
      if (attempt >= attempts || !/SQLITE_BUSY|database is locked/i.test(message)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
  }
}

/**
 * Applies every migration that is not yet recorded in `d1_migrations`. Each file runs as one
 * `d1.batch` (a single transaction): it is applied completely or not at all.
 * Returns the names of the migrations applied by this call.
 */
export async function applyMigrations(d1: D1Database, options: { dir?: string; log?: (message: string) => void } = {}): Promise<string[]> {
  await withRetry(() =>
    d1
      .prepare(
        `CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)`,
      )
      .run(),
  );
  const applied = new Set((await d1.prepare(`SELECT name FROM ${MIGRATIONS_TABLE} ORDER BY id`).all<{ name: string }>()).results.map((row) => row.name));

  const done: string[] = [];
  for (const migration of listMigrations(options.dir)) {
    if (applied.has(migration.name)) continue;
    const statements = migration.statements.map((statement) => d1.prepare(statement));
    statements.push(d1.prepare(`INSERT INTO ${MIGRATIONS_TABLE} (name) VALUES (?)`).bind(migration.name));
    try {
      await withRetry(() => d1.batch(statements));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Migration ${migration.name} failed: ${message}`, { cause: error });
    }
    options.log?.(`applied ${migration.name} (${migration.statements.length} statements)`);
    done.push(migration.name);
  }
  return done;
}

type MasterRow = { type: string; name: string; sql: string | null };

/**
 * Drops every user object (triggers, views, virtual tables, tables) in one transaction, leaving an
 * empty database. Internal objects (`sqlite_*`, D1's `_cf_*`) are left alone. Files stay in place,
 * so a process that has the database open (the dev server) keeps working.
 */
export async function dropEverything(d1: D1Database): Promise<{ tables: number; triggers: number; views: number }> {
  const rows = (
    await d1.prepare(`SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'`).all<MasterRow>()
  ).results;
  const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const triggers = rows.filter((row) => row.type === "trigger");
  const views = rows.filter((row) => row.type === "view");
  const tables = rows.filter((row) => row.type === "table");
  const virtual = tables.filter((row) => /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(row.sql ?? ""));
  const regular = tables.filter((row) => !virtual.includes(row)).map((row) => row.name);

  // DROP TABLE runs the foreign-key actions of the table's rows, and SQLite must be able to
  // compile them: a child table may only still exist while all its parents do. So tables are
  // dropped children-first — a table goes once nothing that remains references it.
  const references = (
    await d1.prepare(`SELECT m.name AS child, fk."table" AS parent FROM sqlite_master m, pragma_foreign_key_list(m.name) fk WHERE m.type = 'table'`).all<{ child: string; parent: string }>()
  ).results;
  const remaining = new Set(regular);
  const dropOrder: string[] = [];
  while (remaining.size > 0) {
    const referrers = new Map<string, number>([...remaining].map((name) => [name, 0]));
    for (const { child, parent } of references) {
      if (child !== parent && remaining.has(child) && remaining.has(parent)) referrers.set(parent, (referrers.get(parent) ?? 0) + 1);
    }
    const free = [...referrers].filter(([, count]) => count === 0).map(([name]) => name);
    // Tables that reference each other in a cycle: take the least-referenced one; its referrers
    // and their parents all still exist, which is all SQLite needs.
    const next = free.length > 0 ? free : [[...referrers].sort((a, b) => a[1] - b[1])[0][0]];
    for (const name of next) {
      remaining.delete(name);
      dropOrder.push(name);
    }
  }

  const statements = [
    // Rows still reference each other while tables disappear; check foreign keys once, at commit.
    "PRAGMA defer_foreign_keys = on",
    ...triggers.map((row) => `DROP TRIGGER IF EXISTS ${quote(row.name)}`),
    ...views.map((row) => `DROP VIEW IF EXISTS ${quote(row.name)}`),
    // Dropping a virtual table removes its shadow tables (which cannot be dropped directly),
    // so the IF EXISTS drops below simply skip them.
    ...virtual.map((row) => `DROP TABLE IF EXISTS ${quote(row.name)}`),
    ...dropOrder.map((name) => `DROP TABLE IF EXISTS ${quote(name)}`),
  ];
  if (statements.length > 1) await withRetry(() => d1.batch(statements.map((statement) => d1.prepare(statement))));
  return { tables: tables.length, triggers: triggers.length, views: views.length };
}
