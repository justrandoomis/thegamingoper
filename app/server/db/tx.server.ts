/**
 * Atomic writes on D1 — guards for `db.batch([...])` and parsers for database errors.
 *
 * D1 has no interactive transactions. A multi-statement mutation is ONE `db.batch([...])`: D1 runs
 * the statements in order inside a single transaction and rolls ALL of them back if any fails.
 * Decisions that would normally be an `if` between two statements are expressed in SQL instead:
 *
 *   1. conditional writes      UPDATE serials SET status = 'sold' WHERE id = ? AND status IN ('in_stock','reserved')
 *   2. a guard right after it  expectChanged(db, 1, "SERIAL_NOT_AVAILABLE:" + serialId)
 *   3. invariant triggers      (drizzle/0001_invariants.sql) which abort with TT:<CODE>:<detail>
 *
 *   await runBatch(db, [
 *     db.update(serials).set({ status: "sold" }).where(and(eq(serials.id, id), inArray(serials.status, ["in_stock", "reserved"]))),
 *     expectChanged(db, 1, { code: "SERIAL_NOT_AVAILABLE", detail: id }),
 *     db.insert(orderItemSerials).values({ orderItemId, serialId: id }),
 *     auditStatement(db, …),
 *   ]).catch((error) => { const info = mapDbError(error); … });
 *
 * EXACT SEMANTICS OF expectChanged (verified against local D1 by tests/db-invariants.test.ts)
 *   · It reads SQLite's changes(): the number of rows INSERTed, UPDATEd or DELETEd by the most
 *     recently completed data-changing statement on the connection — inside a batch, the statement
 *     placed directly before the guard.
 *   · Rows changed by triggers or foreign-key actions of that statement are NOT counted.
 *   · A SELECT between the statement and its guard does not reset the count, but another guard
 *     does: put exactly one guard directly after the statement it protects.
 *   · `INSERT … ON CONFLICT DO NOTHING` that hits a conflict counts as 0 rows, so a guard after it
 *     means "must have been newly inserted".
 *   · When the count is below `min` the guard raises TT:<code>:<detail> (default
 *     TT:NO_ROWS_CHANGED:), the batch rejects and nothing in it is committed.
 *   · Only meaningful inside db.batch: between two separate calls another request may run.
 *   · The guard never stores a row (`_tx_guard` stays empty), so it costs no writes.
 *
 * THREE THINGS TO KNOW ABOUT BATCHES ON D1
 *   · Foreign keys are enforced immediately: insert parents before children inside a batch.
 *     Do not use `PRAGMA defer_foreign_keys` — a violation then surfaces at commit as an opaque
 *     "internal error" with no constraint name.
 *   · Raw statements with parameters — db.run(sql`… ${value}`) — crash Drizzle's D1 batch
 *     ("Cannot read properties of undefined (reading 'bind')", drizzle-orm 0.45). Query builders
 *     are fine. For raw SQL in a batch use batchSql(db, sql`…`), or run the batch through
 *     runBatch(), which repairs raw statements on the way.
 *   · D1 allows 100 bound parameters per statement: split multi-row inserts with chunkRows().
 *
 * This module must not import "cloudflare:workers" (tests run it against a local D1).
 */
import { entityKind, getTableColumns, sql, type SQL } from "drizzle-orm";
import { integer, sqliteTable, text, type SQLiteTable } from "drizzle-orm/sqlite-core";
import type { BatchStatement, Db } from "./drizzle.server";

export type { BatchStatement };

/**
 * `_tx_guard` (created in drizzle/0001_invariants.sql together with its trigger). Declared here and
 * not in the schema folder on purpose: drizzle-kit must not manage it, and nothing but the guards
 * below should write to it.
 */
const txGuard = sqliteTable("_tx_guard", {
  ok: integer("ok").notNull(),
  code: text("code"),
  detail: text("detail"),
});

/** D1 rejects a statement with more bound parameters than this. */
export const D1_MAX_BOUND_PARAMS = 100;

/** How a failed guard reports itself: "CODE", "CODE:detail" or `{ code, detail }`. Codes are UPPER_SNAKE_CASE. */
export type GuardFailure = string | { code: string; detail?: string | number | null };

const CODE_PATTERN = /^[A-Z][A-Z0-9_]*$/;

function parseFailure(failure: GuardFailure | undefined, fallbackCode: string): { code: string; detail: string } {
  let code = fallbackCode;
  let detail = "";
  if (typeof failure === "string") {
    const colon = failure.indexOf(":");
    code = colon === -1 ? failure : failure.slice(0, colon);
    detail = colon === -1 ? "" : failure.slice(colon + 1);
  } else if (failure) {
    code = failure.code;
    detail = failure.detail == null ? "" : String(failure.detail);
  }
  if (!CODE_PATTERN.test(code)) throw new Error(`Guard code must be UPPER_SNAKE_CASE, got "${code}"`);
  // The detail travels inside a one-line error message: keep it to one short line.
  return { code, detail: detail.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200) };
}

/**
 * Batch guard: aborts the whole batch unless the statement directly before it changed at least
 * `min` rows. See the semantics in the header of this file.
 */
export function expectChanged(db: Db, min = 1, failure?: GuardFailure): BatchStatement {
  if (!Number.isSafeInteger(min) || min < 1) throw new Error(`expectChanged: min must be a positive integer, got ${min}`);
  const { code, detail } = parseFailure(failure, "NO_ROWS_CHANGED");
  // INSERT INTO _tx_guard (ok, code, detail) VALUES (changes() >= ?, ?, ?) — the trigger aborts unless ok = 1.
  return db.insert(txGuard).values({ ok: sql<number>`changes() >= ${min}`, code, detail });
}

/**
 * Batch guard that does not depend on the previous statement: aborts the batch unless `condition`
 * (any SQL boolean expression, usually an EXISTS or a comparison of scalar subqueries) is true at
 * that point of the batch.
 *
 *   expectThat(db, sql`(SELECT count(*) FROM coupon_redemptions WHERE coupon_id = ${id} AND voided_at IS NULL) <= ${limit}`, "COUPON_LIMIT_REACHED:" + id)
 */
export function expectThat(db: Db, condition: SQL, failure?: GuardFailure): BatchStatement {
  const { code, detail } = parseFailure(failure, "GUARD_FAILED");
  return db.insert(txGuard).values({ ok: sql<number>`CASE WHEN (${condition}) THEN 1 ELSE 0 END`, code, detail });
}

/**
 * Empties `_tx_guard`. Guards do not leave rows behind, so this is only housekeeping for rows
 * written by other means; safe to append to any batch.
 */
export function clearGuards(db: Db): BatchStatement {
  return db.delete(txGuard);
}

/** A raw statement as Drizzle's D1 batch sees it: it reads `stmt`, which raw statements do not have. */
type RawItem = { constructor: { [entityKind]?: string }; getQuery(): { sql: string; params: unknown[] }; stmt?: D1PreparedStatement };

/** Gives a raw statement the prepared D1 statement that Drizzle's batch forgets to create for it. */
function repairRaw<T extends BatchStatement>(db: Db, statement: T): T {
  const item = statement as unknown as RawItem;
  if (item.constructor[entityKind] === "SQLiteRaw" && item.stmt === undefined) {
    item.stmt = db.$client.prepare(item.getQuery().sql);
  }
  return statement;
}

/**
 * A raw SQL statement that is safe to put in a batch, with or without parameters:
 *
 *   batchSql(db, sql`UPDATE sequences SET value = value + 1 WHERE name = ${name}`)
 *
 * (Plain db.run(sql`…`) with parameters breaks inside db.batch — see the header of this file.)
 */
export function batchSql(db: Db, query: SQL): BatchStatement {
  return repairRaw(db, db.run(query));
}

/**
 * `db.batch` for statement lists built at runtime: accepts plain arrays, skips the round trip for
 * an empty list, and makes raw statements batch-safe. One transaction: all or nothing.
 */
export async function runBatch(db: Db, statements: readonly BatchStatement[]): Promise<unknown[]> {
  if (statements.length === 0) return [];
  const repaired = statements.map((statement) => repairRaw(db, statement));
  return db.batch(repaired as unknown as [BatchStatement, ...BatchStatement[]]);
}

/**
 * Splits rows for multi-row inserts so no statement exceeds D1's bound-parameter limit.
 * Drizzle writes every column of the table for each row (literal defaults are bound too), so the
 * safe size is ⌊100 / column count⌋ rows per statement.
 */
export function chunkRows<T>(table: SQLiteTable, rows: readonly T[], maxParams = D1_MAX_BOUND_PARAMS): T[][] {
  const perRow = Math.max(1, Object.keys(getTableColumns(table)).length);
  const size = Math.max(1, Math.floor(maxParams / perRow));
  const chunks: T[][] = [];
  for (let i = 0; i < rows.length; i += size) chunks.push(rows.slice(i, i + size));
  return chunks;
}

// ───────────────────────────────────────────────────────────────── error parsing

/** Codes raised by the invariant triggers and guards (TT:<CODE>:<detail>), with what `detail` holds. */
export const TRIGGER_ERROR_CODES = {
  INSUFFICIENT_STOCK: "variant id",
  SERIAL_NOT_AVAILABLE: "serial id",
  USED_UNIT_NOT_AVAILABLE: "used unit id",
  USED_UNIT_NOT_LISTABLE: "used unit id",
  WALLET_OVERDRAFT: "customer id",
  LOYALTY_OVERDRAFT: "customer id",
  REFUND_EXCEEDS_PAYMENT: "payment id",
  REFUND_QTY_EXCEEDS: "order item id",
  REFUND_PAYMENT_MISMATCH: "refund id",
  REFUND_ITEM_MISMATCH: "order item id",
  ORDER_REFUND_EXCEEDS_PAID: "order id",
  PAYMENT_NOT_VERIFIED: "payment id",
  TRADE_IN_OFFER_NOT_ALLOWED: "trade-in id",
  PERIOD_CLOSED: "fiscal period (YYYY-MM)",
  JOURNAL_UNBALANCED: "journal entry id",
  JOURNAL_SEALED: "journal entry id",
  IMMUTABLE: "table name",
  NO_ROWS_CHANGED: "label given to expectChanged, if any",
  GUARD_FAILED: "label given to expectThat, if any",
} as const;
export type TriggerErrorCode = keyof typeof TRIGGER_ERROR_CODES;

export type DbErrorKind = "trigger" | "unique" | "foreign_key" | "not_null" | "check";

/** A database failure in a shape that maps directly onto AppError(code, status, …). */
export type DbErrorInfo = {
  /** A trigger code (e.g. "INSUFFICIENT_STOCK"), or "UNIQUE" | "FOREIGN_KEY" | "NOT_NULL" | "CHECK". */
  code: TriggerErrorCode | "UNIQUE" | "FOREIGN_KEY" | "NOT_NULL" | "CHECK" | (string & {});
  /** Trigger: the id named by the trigger. UNIQUE / NOT_NULL: "table.column[, table.column]". CHECK: constraint name. */
  detail: string;
  kind: DbErrorKind;
  /** UNIQUE / NOT_NULL: the table… */
  table?: string;
  /** …and the column(s) of the violated constraint. */
  columns?: string[];
  /** CHECK: the constraint name. UNIQUE on an expression index: the index name. */
  constraint?: string;
  /** Suggested HTTP status: 409 for state conflicts, 422 for values the database refuses. */
  status: 409 | 422;
  /** The database's own message, for logs. */
  message: string;
};

/** Removes D1's wrapper text: "D1_ERROR: <message>: SQLITE_CONSTRAINT (extended: …)" → "<message>". */
function cleanMessage(raw: string): string {
  let text = raw.split("\n", 1)[0] ?? "";
  if (text.startsWith("D1_ERROR: ")) text = text.slice("D1_ERROR: ".length);
  const suffix = text.search(/: SQLITE_[A-Z_]+/);
  if (suffix !== -1) text = text.slice(0, suffix);
  return text.trim();
}

/** Parses "TT:<CODE>:<detail>" out of an error message. */
export function parseTriggerMessage(message: string): { code: string; detail: string } | null {
  const start = message.indexOf("TT:");
  if (start === -1) return null;
  const body = cleanMessage(message.slice(start));
  const match = /^TT:([A-Z][A-Z0-9_]*):?(.*)$/.exec(body);
  if (!match) return null;
  return { code: match[1], detail: match[2].trim() };
}

/** Parses SQLite's built-in constraint messages (UNIQUE, NOT NULL, CHECK, FOREIGN KEY). */
export function parseConstraintMessage(message: string): Omit<DbErrorInfo, "message"> | null {
  const text = cleanMessage(message);

  let match = /UNIQUE constraint failed: (.+)$/.exec(text);
  if (match) {
    const target = match[1].trim();
    const byIndex = /^index '(.+)'$/.exec(target);
    if (byIndex) return { code: "UNIQUE", kind: "unique", detail: byIndex[1], constraint: byIndex[1], status: 409 };
    const parts = target.split(",").map((part) => part.trim());
    const table = parts[0]?.split(".")[0];
    const columns = parts.map((part) => part.slice(part.indexOf(".") + 1));
    return { code: "UNIQUE", kind: "unique", detail: parts.join(", "), table, columns, status: 409 };
  }

  match = /NOT NULL constraint failed: (.+)$/.exec(text);
  if (match) {
    const target = match[1].trim();
    const dot = target.indexOf(".");
    return { code: "NOT_NULL", kind: "not_null", detail: target, table: target.slice(0, dot), columns: [target.slice(dot + 1)], status: 422 };
  }

  match = /CHECK constraint failed: (.+)$/.exec(text);
  if (match) return { code: "CHECK", kind: "check", detail: match[1].trim(), constraint: match[1].trim(), status: 422 };

  if (/FOREIGN KEY constraint failed/.test(text)) return { code: "FOREIGN_KEY", kind: "foreign_key", detail: "", status: 409 };

  return null;
}

/** Messages along the `cause` chain, innermost (closest to the database) first. */
function errorMessages(error: unknown): string[] {
  const messages: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 8; depth++) {
    if (typeof current === "string") {
      messages.push(current);
      break;
    }
    const message = (current as { message?: unknown }).message;
    if (typeof message === "string") messages.push(message);
    current = (current as { cause?: unknown }).cause;
  }
  return messages.reverse();
}

/**
 * Turns an error thrown by a query or batch into `{ code, detail, … }`, or null when it is not a
 * recognised database rule (let those bubble — never swallow an unknown error).
 * Understands trigger and guard messages (TT:<CODE>:<detail>) and SQLite constraint failures, with
 * or without the wrappers added by D1 and Drizzle.
 */
export function mapDbError(error: unknown): DbErrorInfo | null {
  // Drizzle's wrapper message ("Failed query: <sql>") repeats the SQL text; never parse that one.
  const messages = errorMessages(error).filter((message) => !message.startsWith("Failed query:"));
  for (const message of messages) {
    const trigger = parseTriggerMessage(message);
    if (trigger) return { code: trigger.code, detail: trigger.detail, kind: "trigger", status: 409, message };
  }
  for (const message of messages) {
    const constraint = parseConstraintMessage(message);
    if (constraint) return { ...constraint, message };
  }
  return null;
}

/** True when `error` is the database rule `code` (and, if given, concerns `detail`). */
export function isDbError(error: unknown, code: DbErrorInfo["code"], detail?: string): boolean {
  const info = mapDbError(error);
  return info !== null && info.code === code && (detail === undefined || info.detail === detail);
}

/**
 * True when `error` is a UNIQUE violation, optionally of a specific column given as "table.column"
 * — the test for idempotent retries: `isUniqueViolation(error, "orders.idempotency_key")`.
 */
export function isUniqueViolation(error: unknown, column?: string): boolean {
  const info = mapDbError(error);
  if (!info || info.kind !== "unique") return false;
  if (column === undefined) return true;
  const dot = column.indexOf(".");
  const table = dot === -1 ? undefined : column.slice(0, dot);
  const name = dot === -1 ? column : column.slice(dot + 1);
  return (table === undefined || info.table === table) && (info.columns?.includes(name) ?? false);
}
