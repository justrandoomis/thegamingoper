/**
 * Admin 10.02 — payment settlements (cash on delivery, transfers, wallet) and statement reconciliation
 * (finance.settlement.reconcile for every call).
 *
 *   · The overview counts what each payment method owes and has settled, from the payments themselves.
 *   · A bank-card, Zain Cash or carrier statement (CSV) is imported line by line into `statement_lines` — a line seen
 *     before is skipped (dedupe hash), so importing the same file twice adds nothing — and each line is matched to the
 *     PAID payment it proves (a transfer verified by a person, a cash-on-delivery collection). Matching is a guarded
 *     write: the line must still be unmatched and the payment matched to no other line; an amount that differs needs a
 *     note. Nothing here moves money: verifying a transfer is the orders module's job (verifyPayment), and the carriers'
 *     cash settlements are recorded by the shipping module (11.04) — this module shows them.
 *   · A line that proves no order payment (a wallet top-up, a bank fee, the owner's own deposit, money out) is set
 *     aside with a note (status "ignored"); the note is kept in the audit trail.
 */
import { and, eq, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { assertCan, type Actor } from "~/server/actor";
import { auditEvents, payments, statementLines } from "~/server/db/schema";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { chunkRows, expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { employeeNames } from "./shared.server";
import { normalizeReference, parseStatementCsv, type ParsedStatement } from "./statement-csv";
import { PAGE_SIZE, STATEMENT_SOURCES, type RangeFilter, type StatementSource } from "./types";
import { likePattern } from "./ledger.server";

export const SETTLEMENT_ERROR_KEYS = [
  "statement_empty",
  "statement_too_large",
  "statement_too_many_rows",
  "statement_no_date_column",
  "statement_no_amount_column",
  "line_not_unmatched",
  "line_not_matched",
  "line_not_ignored",
  "payment_already_matched",
  "payment_not_paid",
  "payment_method_mismatch",
  "match_note_required",
  "line_money_out",
] as const;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** The payment method a statement source proves. */
const METHOD_OF: Record<StatementSource, "bank_transfer" | "zaincash" | "cod"> = { bank_card: "bank_transfer", zaincash: "zaincash", carrier: "cod" };

const num = (value: unknown) => Number(value ?? 0);

function requireReconcile(actor: Actor): void {
  assertCan(actor, "finance.settlement.reconcile");
}

// ───────────────────────────────────────────────────────────────── overview

export type MoneyCount = { count: number; iqd: number };

export type SettlementOverview = {
  cod: {
    /** Cash on delivery still to collect on orders already shipped or delivered. */
    outstanding: MoneyCount;
    /** Delivered orders whose cash is not recorded yet (in the courier's hands). */
    deliveredUncollected: MoneyCount;
    /** Collected (recordCodCollection) in the range. */
    collected: MoneyCount;
    /** Parcels delivered with cash to collect that no carrier settlement covers yet (shipping 11.04). */
    awaitingCarrier: MoneyCount;
    settlements: { status: string; count: number; expectedIqd: number; receivedIqd: number; varianceIqd: number }[];
  };
  transfers: { method: "bank_transfer" | "zaincash"; waiting: MoneyCount; verified: MoneyCount; matched: MoneyCount; unmatched: MoneyCount }[];
  wallet: { payments: MoneyCount; topups: MoneyCount; refunds: MoneyCount };
  /** Card payments at the point of sale (no online card gateway is configured). */
  card: MoneyCount;
  statements: { source: string; status: string; count: number; iqd: number }[];
};

function demoOrder(range: RangeFilter, alias = "o"): SQL {
  return range.demo ? sql`1 = 1` : sql.raw(`${alias}.is_demo = 0`);
}

/** What each payment method owes and has settled (finance.settlement.reconcile). */
export async function settlementOverview(db: Db, actor: Actor, range: RangeFilter): Promise<SettlementOverview> {
  requireReconcile(actor);
  const demo = demoOrder(range);
  const [codRows, awaiting, settlements, transfers, walletRows, topups, walletRefunds, card, statements] = await Promise.all([
    db.all<{ kind: string; n: number; total: number }>(sql`
      SELECT 'outstanding' AS kind, count(*) AS n, coalesce(sum(p.amount_iqd), 0) AS total FROM payments AS p JOIN orders AS o ON o.id = p.order_id
        WHERE p.method = 'cod' AND p.status = 'pending' AND o.status IN ('shipped', 'delivered') AND ${demo}
      UNION ALL
      SELECT 'delivered', count(*), coalesce(sum(p.amount_iqd), 0) FROM payments AS p JOIN orders AS o ON o.id = p.order_id
        WHERE p.method = 'cod' AND p.status = 'pending' AND o.status = 'delivered' AND ${demo}
      UNION ALL
      SELECT 'collected', count(*), coalesce(sum(p.amount_iqd), 0) FROM payments AS p JOIN orders AS o ON o.id = p.order_id
        WHERE p.method = 'cod' AND p.status = 'paid' AND p.paid_at >= ${range.fromMs} AND p.paid_at < ${range.toMs} AND ${demo}`),
    db.all<{ n: number; total: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(s.cod_amount_iqd), 0) AS total FROM shipments AS s JOIN orders AS o ON o.id = s.order_id
      WHERE s.cod_amount_iqd > 0 AND s.status = 'delivered' AND s.cod_settled_at IS NULL AND ${demo}`),
    db.all<{ status: string; n: number; expected: number; received: number; variance: number }>(sql`
      SELECT status, count(*) AS n, coalesce(sum(expected_iqd), 0) AS expected, coalesce(sum(received_iqd), 0) AS received, coalesce(sum(variance_iqd), 0) AS variance
      FROM cod_settlements WHERE created_at >= ${range.fromMs} AND created_at < ${range.toMs} GROUP BY status`),
    db.all<{ method: "bank_transfer" | "zaincash"; kind: string; n: number; total: number }>(sql`
      SELECT p.method AS method, 'waiting' AS kind, count(*) AS n, coalesce(sum(coalesce(p.declared_amount_iqd, p.amount_iqd)), 0) AS total
        FROM payments AS p JOIN orders AS o ON o.id = p.order_id
        WHERE p.method IN ('bank_transfer', 'zaincash') AND p.status = 'pending_verification' AND ${demo} GROUP BY p.method
      UNION ALL
      SELECT p.method, CASE WHEN EXISTS (SELECT 1 FROM statement_lines AS sl WHERE sl.matched_payment_id = p.id) THEN 'matched' ELSE 'unmatched' END, count(*), coalesce(sum(p.amount_iqd), 0)
        FROM payments AS p JOIN orders AS o ON o.id = p.order_id
        WHERE p.method IN ('bank_transfer', 'zaincash') AND p.status = 'paid' AND p.paid_at >= ${range.fromMs} AND p.paid_at < ${range.toMs} AND ${demo}
        GROUP BY p.method, 2`),
    db.all<{ n: number; total: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(p.amount_iqd), 0) AS total FROM payments AS p JOIN orders AS o ON o.id = p.order_id
      WHERE p.method = 'wallet' AND p.status = 'paid' AND p.paid_at >= ${range.fromMs} AND p.paid_at < ${range.toMs} AND ${demo}`),
    db.all<{ n: number; total: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(t.amount_iqd), 0) AS total FROM wallet_topups AS t JOIN customers AS c ON c.id = t.customer_id
      WHERE t.status = 'approved' AND t.verified_at >= ${range.fromMs} AND t.verified_at < ${range.toMs} AND ${range.demo ? sql`1 = 1` : sql`c.is_demo = 0`}`),
    db.all<{ n: number; total: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(r.amount_iqd), 0) AS total FROM refunds AS r JOIN orders AS o ON o.id = r.order_id
      WHERE r.method = 'wallet' AND r.status = 'paid' AND r.paid_at >= ${range.fromMs} AND r.paid_at < ${range.toMs} AND ${demo}`),
    db.all<{ n: number; total: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(p.amount_iqd), 0) AS total FROM payments AS p JOIN orders AS o ON o.id = p.order_id
      WHERE p.method = 'pos_card' AND p.status = 'paid' AND p.paid_at >= ${range.fromMs} AND p.paid_at < ${range.toMs} AND ${demo}`),
    db.all<{ source: string; status: string; n: number; total: number }>(sql`
      SELECT source, status, count(*) AS n, coalesce(sum(amount_iqd), 0) AS total FROM statement_lines
      WHERE occurred_at >= ${range.fromMs} AND occurred_at < ${range.toMs} GROUP BY source, status ORDER BY source, status`),
  ]);
  const cod = (kind: string): MoneyCount => {
    const row = codRows.find((r) => r.kind === kind);
    return { count: num(row?.n), iqd: num(row?.total) };
  };
  const transfer = (method: "bank_transfer" | "zaincash", kind: string): MoneyCount => {
    const row = transfers.find((r) => r.method === method && r.kind === kind);
    return { count: num(row?.n), iqd: num(row?.total) };
  };
  const one = (rows: { n: number; total: number }[]): MoneyCount => ({ count: num(rows[0]?.n), iqd: num(rows[0]?.total) });
  const sum = (a: MoneyCount, b: MoneyCount): MoneyCount => ({ count: a.count + b.count, iqd: a.iqd + b.iqd });
  return {
    cod: {
      outstanding: cod("outstanding"),
      deliveredUncollected: cod("delivered"),
      collected: cod("collected"),
      awaitingCarrier: one(awaiting),
      settlements: settlements.map((row) => ({ status: row.status, count: num(row.n), expectedIqd: num(row.expected), receivedIqd: num(row.received), varianceIqd: num(row.variance) })),
    },
    transfers: (["bank_transfer", "zaincash"] as const).map((method) => ({
      method,
      waiting: transfer(method, "waiting"),
      verified: sum(transfer(method, "matched"), transfer(method, "unmatched")),
      matched: transfer(method, "matched"),
      unmatched: transfer(method, "unmatched"),
    })),
    wallet: { payments: one(walletRows), topups: one(topups), refunds: one(walletRefunds) },
    card: one(card),
    statements: statements.map((row) => ({ source: row.source, status: row.status, count: num(row.n), iqd: num(row.total) })),
  };
}

// ───────────────────────────────────────────────────────────────── statement lines

export type StatementFilters = RangeFilter & { source: StatementSource | null; status: "unmatched" | "matched" | "ignored" | null; q: string; page: number };

export type MatchedPayment = { id: string; method: string; amountIqd: number; status: string; orderRef: string; paidAt: number | null; reference: string | null };

export type StatementLineRow = {
  id: string;
  source: string;
  occurredAt: number;
  amountIqd: number;
  reference: string | null;
  counterparty: string | null;
  description: string | null;
  status: "unmatched" | "matched" | "ignored";
  payment: MatchedPayment | null;
  /** Matched to a payment of a different amount. */
  differs: boolean;
  by: string | null;
  at: number | null;
  /** The note given when the line was set aside or matched with a difference (from the audit trail). */
  note: string | null;
  importJobId: string | null;
};

export type StatementPage = { rows: StatementLineRow[]; total: number; page: number; pageCount: number; totals: { inIqd: number; outIqd: number } };

function lineWhere(filters: StatementFilters): SQL {
  const parts: SQL[] = [sql`sl.occurred_at >= ${filters.fromMs}`, sql`sl.occurred_at < ${filters.toMs}`];
  if (filters.source) parts.push(sql`sl.source = ${filters.source}`);
  if (filters.status) parts.push(sql`sl.status = ${filters.status}`);
  if (filters.q) {
    const pattern = likePattern(filters.q);
    parts.push(sql`(sl.reference LIKE ${pattern} ESCAPE '\\' OR sl.counterparty LIKE ${pattern} ESCAPE '\\' OR sl.description LIKE ${pattern} ESCAPE '\\')`);
  }
  return sql.join(parts, sql` AND `);
}

async function decorateLines(
  db: Db,
  rows: { id: string; source: string; occurredAt: number; amount: number; reference: string | null; counterparty: string | null; description: string | null; status: "unmatched" | "matched" | "ignored"; paymentId: string | null; matchedBy: string | null; matchedAt: number | null; importJobId: string | null }[],
): Promise<StatementLineRow[]> {
  const paymentIds = rows.map((row) => row.paymentId).filter((id): id is string => Boolean(id));
  const paymentRows = paymentIds.length
    ? await db.all<{ id: string; method: string; amount: number; status: string; ref: string; paidAt: number | null; reference: string | null }>(sql`
        SELECT p.id, p.method, p.amount_iqd AS amount, p.status, o.ref, p.paid_at AS paidAt, p.reference FROM payments AS p JOIN orders AS o ON o.id = p.order_id
        WHERE p.id IN (${sql.join(
          paymentIds.map((id) => sql`${id}`),
          sql`, `,
        )})`)
    : [];
  const byPayment = new Map(paymentRows.map((row) => [row.id, row]));
  const noteIds = rows.filter((row) => row.status !== "unmatched").map((row) => row.id);
  const notes = noteIds.length
    ? await db
        .select({ entityId: auditEvents.entityId, reason: auditEvents.reason, seq: auditEvents.seq })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.entityType, "statement_line"),
            sql`${auditEvents.entityId} IN (${sql.join(
              noteIds.map((id) => sql`${id}`),
              sql`, `,
            )})`,
          ),
        )
    : [];
  const latestNote = new Map<string, { reason: string | null; seq: number }>();
  for (const note of notes) {
    const id = note.entityId ?? "";
    const current = latestNote.get(id);
    if (!current || note.seq > current.seq) latestNote.set(id, { reason: note.reason, seq: note.seq });
  }
  const names = await employeeNames(db, rows.map((row) => row.matchedBy));
  return rows.map((row) => {
    const p = row.paymentId ? byPayment.get(row.paymentId) : undefined;
    return {
      id: row.id,
      source: row.source,
      occurredAt: num(row.occurredAt),
      amountIqd: num(row.amount),
      reference: row.reference,
      counterparty: row.counterparty,
      description: row.description,
      status: row.status,
      payment: p ? { id: p.id, method: p.method, amountIqd: num(p.amount), status: p.status, orderRef: p.ref, paidAt: p.paidAt === null ? null : num(p.paidAt), reference: p.reference } : null,
      differs: Boolean(p && num(p.amount) !== num(row.amount)),
      by: row.matchedBy ? (names.get(row.matchedBy) ?? null) : null,
      at: row.matchedAt === null ? null : num(row.matchedAt),
      note: row.status === "unmatched" ? null : (latestNote.get(row.id)?.reason ?? null),
      importJobId: row.importJobId,
    };
  });
}

const LINE_COLUMNS = sql`sl.id AS id, sl.source AS source, sl.occurred_at AS occurredAt, sl.amount_iqd AS amount, sl.reference AS reference, sl.counterparty AS counterparty,
  sl.description AS description, sl.status AS status, sl.matched_payment_id AS paymentId, sl.matched_by AS matchedBy, sl.matched_at AS matchedAt, sl.import_job_id AS importJobId`;

/** Statement lines in the range, newest first, with what each is matched to. */
export async function listStatementLines(db: Db, actor: Actor, filters: StatementFilters): Promise<StatementPage> {
  requireReconcile(actor);
  const where = lineWhere(filters);
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [rows, count] = await Promise.all([
    db.all<Parameters<typeof decorateLines>[1][number]>(sql`SELECT ${LINE_COLUMNS} FROM statement_lines AS sl WHERE ${where} ORDER BY sl.occurred_at DESC, sl.id DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    db.all<{ n: number; inIqd: number; outIqd: number }>(sql`
      SELECT count(*) AS n, coalesce(sum(CASE WHEN sl.amount_iqd > 0 THEN sl.amount_iqd ELSE 0 END), 0) AS inIqd, coalesce(sum(CASE WHEN sl.amount_iqd < 0 THEN -sl.amount_iqd ELSE 0 END), 0) AS outIqd
      FROM statement_lines AS sl WHERE ${where}`),
  ]);
  const total = num(count[0]?.n);
  return { rows: await decorateLines(db, rows), total, page: filters.page, pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)), totals: { inIqd: num(count[0]?.inIqd), outIqd: num(count[0]?.outIqd) } };
}

export type UnreconciledPayment = { id: string; method: string; amountIqd: number; orderRef: string; paidAt: number; reference: string | null; isDemo: boolean };

/** Paid transfers and collected cash in the range that no statement line proves yet (at most 100, oldest first). */
export async function unreconciledPayments(db: Db, actor: Actor, range: RangeFilter): Promise<{ rows: UnreconciledPayment[]; total: MoneyCount }> {
  requireReconcile(actor);
  const where = sql`p.method IN ('bank_transfer', 'zaincash', 'cod') AND p.status = 'paid' AND p.paid_at >= ${range.fromMs} AND p.paid_at < ${range.toMs} AND ${demoOrder(range)}
    AND NOT EXISTS (SELECT 1 FROM statement_lines AS sl WHERE sl.matched_payment_id = p.id)`;
  const [rows, total] = await Promise.all([
    db.all<{ id: string; method: string; amount: number; ref: string; paidAt: number; reference: string | null; isDemo: number }>(sql`
      SELECT p.id, p.method, p.amount_iqd AS amount, o.ref, p.paid_at AS paidAt, p.reference, o.is_demo AS isDemo FROM payments AS p JOIN orders AS o ON o.id = p.order_id
      WHERE ${where} ORDER BY p.paid_at, p.id LIMIT 100`),
    db.all<{ n: number; total: number }>(sql`SELECT count(*) AS n, coalesce(sum(p.amount_iqd), 0) AS total FROM payments AS p JOIN orders AS o ON o.id = p.order_id WHERE ${where}`),
  ]);
  return {
    rows: rows.map((row) => ({ id: row.id, method: row.method, amountIqd: num(row.amount), orderRef: row.ref, paidAt: num(row.paidAt), reference: row.reference, isDemo: Boolean(row.isDemo) })),
    total: { count: num(total[0]?.n), iqd: num(total[0]?.total) },
  };
}

// ───────────────────────────────────────────────────────────────── import

export type ImportRowView = {
  line: number;
  occurredAt: number | null;
  amountIqd: number | null;
  reference: string | null;
  counterparty: string | null;
  description: string | null;
  state: "new" | "duplicate" | "error";
  error: string | null;
};

export type StatementPreview = {
  source: StatementSource;
  columns: ParsedStatement["columns"];
  rows: ImportRowView[];
  counts: { total: number; fresh: number; duplicate: number; error: number };
  inIqd: number;
  outIqd: number;
};

const ImportInput = z.object({
  source: z.enum(STATEMENT_SOURCES, { error: "required" }),
  csv: z.string({ error: "statement_empty" }).min(1, "statement_empty"),
});

function fileProblem(parsed: ParsedStatement): AppError | null {
  if (!parsed.problem) return null;
  const code = `statement_${parsed.problem}`;
  return new AppError(code, 400, { fields: { file: code } });
}

/** Hashes of the parsed rows (source + instant + amount + reference + who + what + the n-th time that tuple appears). */
async function hashesOf(source: StatementSource, parsed: ParsedStatement): Promise<(string | null)[]> {
  const seen = new Map<string, number>();
  const out: (string | null)[] = [];
  for (const row of parsed.rows) {
    if (row.error || row.occurredAt === null || row.amountIqd === null) {
      out.push(null);
      continue;
    }
    const tuple = [source, row.occurredAt, row.amountIqd, normalizeReference(row.reference), row.counterparty ?? "", row.description ?? ""].join("|");
    const n = (seen.get(tuple) ?? 0) + 1;
    seen.set(tuple, n);
    out.push(await sha256Hex(`${tuple}|${n}`));
  }
  return out;
}

async function existingHashes(db: Db, hashes: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < hashes.length; i += 90) {
    const part = hashes.slice(i, i + 90);
    if (part.length === 0) continue;
    const rows = await db.all<{ h: string }>(sql`SELECT dedupe_hash AS h FROM statement_lines WHERE dedupe_hash IN (${sql.join(
      part.map((h) => sql`${h}`),
      sql`, `,
    )})`);
    for (const row of rows) out.add(row.h);
  }
  return out;
}

/** What importing this file would add: new lines, lines seen before, rows that cannot be read (and why). */
export async function previewStatement(db: Db, actor: Actor, raw: { source: unknown; csv: unknown }): Promise<StatementPreview> {
  requireReconcile(actor);
  const input = ImportInput.parse(raw);
  const parsed = parseStatementCsv(input.csv);
  const problem = fileProblem(parsed);
  if (problem) throw problem;
  const hashes = await hashesOf(input.source, parsed);
  const known = await existingHashes(db, hashes.filter((h): h is string => h !== null));
  const rows: ImportRowView[] = parsed.rows.map((row, i) => ({
    line: row.line,
    occurredAt: row.occurredAt,
    amountIqd: row.amountIqd,
    reference: row.reference,
    counterparty: row.counterparty,
    description: row.description,
    state: row.error ? "error" : known.has(hashes[i] as string) ? "duplicate" : "new",
    error: row.error,
  }));
  const fresh = rows.filter((row) => row.state === "new");
  return {
    source: input.source,
    columns: parsed.columns,
    rows: rows.slice(0, 300),
    counts: { total: rows.length, fresh: fresh.length, duplicate: rows.filter((row) => row.state === "duplicate").length, error: rows.filter((row) => row.state === "error").length },
    inIqd: fresh.reduce((total, row) => total + Math.max(row.amountIqd ?? 0, 0), 0),
    outIqd: fresh.reduce((total, row) => total + Math.max(-(row.amountIqd ?? 0), 0), 0),
  };
}

/**
 * Imports the readable lines of a statement that were not imported before, in one batch, with one audit event.
 * Running it twice with the same file adds nothing the second time (dedupe hash, ON CONFLICT DO NOTHING).
 */
export async function importStatement(db: Db, actor: Actor, raw: { source: unknown; csv: unknown }, now: number): Promise<{ importId: string; inserted: number; skipped: number; errors: number }> {
  requireReconcile(actor);
  const input = ImportInput.parse(raw);
  const parsed = parseStatementCsv(input.csv);
  const problem = fileProblem(parsed);
  if (problem) throw problem;
  const hashes = await hashesOf(input.source, parsed);
  const known = await existingHashes(db, hashes.filter((h): h is string => h !== null));
  const importId = newId("stm");
  const fresh = parsed.rows
    .map((row, i) => ({ row, hash: hashes[i] }))
    .filter((item): item is { row: (typeof parsed.rows)[number]; hash: string } => item.hash !== null && !known.has(item.hash));
  const values = fresh.map(({ row, hash }) => ({
    id: newId("stl"),
    source: input.source,
    occurredAt: row.occurredAt as number,
    amountIqd: row.amountIqd as number,
    reference: row.reference,
    counterparty: row.counterparty,
    description: row.description,
    raw: row.raw,
    dedupeHash: hash,
    status: "unmatched" as const,
    importJobId: importId,
    createdAt: now,
  }));
  const errors = parsed.rows.filter((row) => row.error).length;
  const statements = chunkRows(statementLines, values).map((chunk) => db.insert(statementLines).values(chunk).onConflictDoNothing({ target: statementLines.dedupeHash }));
  await runBatch(db, [
    ...statements,
    auditStatement(db, {
      actor,
      action: "finance.statement.import",
      entityType: "statement_import",
      entityId: importId,
      after: { source: input.source, lines: values.length, skipped: parsed.rows.length - values.length - errors, errors, inIqd: values.reduce((t, v) => t + Math.max(v.amountIqd, 0), 0), outIqd: values.reduce((t, v) => t + Math.max(-v.amountIqd, 0), 0) },
      at: now,
    }),
  ]);
  const inserted = values.length ? num((await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM statement_lines WHERE import_job_id = ${importId}`))[0]?.n) : 0;
  return { importId, inserted, skipped: parsed.rows.length - errors - inserted, errors };
}

// ───────────────────────────────────────────────────────────────── matching

export type MatchCandidate = MatchedPayment & { score: number; reasons: ("amount" | "reference" | "date")[]; matchable: boolean; isDemo: boolean };

export type LineReview = { line: StatementLineRow; candidates: MatchCandidate[]; method: string };

/** One statement line with the payments it may prove, best first (amount, reference, date). */
export async function reviewStatementLine(db: Db, actor: Actor, lineId: string, search: string): Promise<LineReview> {
  requireReconcile(actor);
  if (!ID.test(lineId)) throw notFound("statement_line");
  const rows = await db.all<Parameters<typeof decorateLines>[1][number]>(sql`SELECT ${LINE_COLUMNS} FROM statement_lines AS sl WHERE sl.id = ${lineId}`);
  if (rows.length === 0) throw notFound("statement_line");
  const [line] = await decorateLines(db, rows);
  const method = METHOD_OF[(line.source as StatementSource) in METHOD_OF ? (line.source as StatementSource) : "bank_card"];
  const ref = normalizeReference(line.reference);
  const text = normalizeReference(`${line.reference ?? ""} ${line.description ?? ""}`);
  const q = normalizeReference(search);
  const windowMs = 10 * 24 * 60 * 60 * 1000;
  const candidates = await db.all<{ id: string; method: string; amount: number; status: string; ref: string; paidAt: number | null; createdAt: number; reference: string | null; isDemo: number; matchedElsewhere: number }>(sql`
    SELECT p.id, p.method, p.amount_iqd AS amount, p.status, o.ref, p.paid_at AS paidAt, p.created_at AS createdAt, p.reference, o.is_demo AS isDemo,
           EXISTS (SELECT 1 FROM statement_lines AS sl WHERE sl.matched_payment_id = p.id AND sl.id <> ${lineId}) AS matchedElsewhere
    FROM payments AS p JOIN orders AS o ON o.id = p.order_id
    WHERE p.method = ${method} AND p.status IN ('paid', 'pending_verification', 'pending')
      AND (p.amount_iqd = ${Math.abs(line.amountIqd)} OR coalesce(p.declared_amount_iqd, -1) = ${Math.abs(line.amountIqd)}
           OR (coalesce(p.paid_at, p.created_at) BETWEEN ${line.occurredAt - windowMs} AND ${line.occurredAt + windowMs})
           ${q ? sql`OR replace(upper(o.ref), '-', '') = ${q}` : sql``})
    ORDER BY abs(coalesce(p.paid_at, p.created_at) - ${line.occurredAt}) LIMIT 60`);
  const scored = candidates
    .filter((row) => !row.matchedElsewhere || row.id === line.payment?.id)
    .map((row) => {
      const reasons: MatchCandidate["reasons"] = [];
      let score = 0;
      if (num(row.amount) === Math.abs(line.amountIqd)) {
        score += 50;
        reasons.push("amount");
      }
      const paymentRef = normalizeReference(row.reference);
      const orderRef = normalizeReference(row.ref);
      if ((ref && paymentRef && ref === paymentRef) || (orderRef && text.includes(orderRef)) || (q && (q === orderRef || q === paymentRef))) {
        score += 40;
        reasons.push("reference");
      }
      const when = row.paidAt ?? row.createdAt;
      if (Math.abs(num(when) - line.occurredAt) <= 3 * 24 * 60 * 60 * 1000) {
        score += 10;
        reasons.push("date");
      }
      return {
        id: row.id,
        method: row.method,
        amountIqd: num(row.amount),
        status: row.status,
        orderRef: row.ref,
        paidAt: row.paidAt === null ? null : num(row.paidAt),
        reference: row.reference,
        score,
        reasons,
        matchable: row.status === "paid" && line.amountIqd > 0,
        isDemo: Boolean(row.isDemo),
      };
    })
    .filter((row) => row.score >= 40 || (q !== "" && row.reasons.includes("reference")))
    .sort((a, b) => b.score - a.score || (a.paidAt ?? 0) - (b.paidAt ?? 0))
    .slice(0, 12);
  return { line, candidates: scored, method };
}

const MatchInput = z.object({
  lineId: z.string().regex(ID, "invalid"),
  paymentId: z.string().regex(ID, "invalid"),
  note: z.preprocess((v) => (typeof v === "string" && v.trim() === "" ? undefined : v), z.string().trim().min(3, "required").max(500, "too_long").optional()),
});

/**
 * Matches a money-in line to the paid payment it proves. Guarded in one batch: the line still unmatched, the payment
 * paid and matched to no other line. A different amount needs a note (match_note_required).
 */
export async function matchStatementLine(db: Db, actor: Actor, raw: { lineId: string; paymentId: string; note?: string }, now: number): Promise<{ replayed: boolean }> {
  requireReconcile(actor);
  const input = MatchInput.parse(raw);
  const line = await db.select().from(statementLines).where(eq(statementLines.id, input.lineId)).get();
  if (!line) throw notFound("statement_line");
  if (line.status === "matched" && line.matchedPaymentId === input.paymentId) return { replayed: true };
  if (line.status !== "unmatched") throw new AppError("line_not_unmatched", 409);
  if (line.amountIqd <= 0) throw new AppError("line_money_out", 409);
  const payment = await db.select({ id: payments.id, method: payments.method, status: payments.status, amountIqd: payments.amountIqd }).from(payments).where(eq(payments.id, input.paymentId)).get();
  if (!payment) throw notFound("payment");
  const source = line.source as StatementSource;
  if (METHOD_OF[source] !== payment.method) throw new AppError("payment_method_mismatch", 409);
  if (payment.status !== "paid") throw new AppError("payment_not_paid", 409);
  const differs = payment.amountIqd !== line.amountIqd;
  if (differs && !input.note) throw new AppError("match_note_required", 400, { fields: { note: "match_note_required" } });
  const by = actor.kind === "employee" ? actor.id : null;
  try {
    await runBatch(db, [
      db
        .update(statementLines)
        .set({ status: "matched", matchedPaymentId: payment.id, matchedBy: by, matchedAt: now })
        .where(and(eq(statementLines.id, line.id), eq(statementLines.status, "unmatched"))),
      expectChanged(db, 1, { code: "LINE_NOT_UNMATCHED", detail: line.id }),
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM statement_lines WHERE matched_payment_id = ${payment.id} AND id <> ${line.id})`, { code: "PAYMENT_ALREADY_MATCHED", detail: payment.id }),
      expectThat(db, sql`EXISTS (SELECT 1 FROM payments WHERE id = ${payment.id} AND status = 'paid')`, { code: "PAYMENT_NOT_PAID", detail: payment.id }),
      auditStatement(db, {
        actor,
        action: "finance.statement.match",
        entityType: "statement_line",
        entityId: line.id,
        before: { status: "unmatched" },
        after: { status: "matched", paymentId: payment.id, lineIqd: line.amountIqd, paymentIqd: payment.amountIqd, differenceIqd: line.amountIqd - payment.amountIqd },
        reason: input.note ?? null,
        at: now,
      }),
    ]);
  } catch (error) {
    const code = mapDbError(error)?.code;
    if (code === "LINE_NOT_UNMATCHED") {
      // a second click (or a colleague) matched the same line to the same payment a moment ago: the same result
      const current = await db.select({ status: statementLines.status, paymentId: statementLines.matchedPaymentId }).from(statementLines).where(eq(statementLines.id, line.id)).get();
      if (current?.status === "matched" && current.paymentId === payment.id) return { replayed: true };
      throw new AppError("line_not_unmatched", 409);
    }
    if (code === "PAYMENT_ALREADY_MATCHED") throw new AppError("payment_already_matched", 409);
    if (code === "PAYMENT_NOT_PAID") throw new AppError("payment_not_paid", 409);
    throw error;
  }
  return { replayed: false };
}

const NoteInput = z.object({ lineId: z.string().regex(ID, "invalid"), reason: z.string({ error: "required" }).trim().min(3, "required").max(500, "too_long") });

async function setLineStatus(db: Db, actor: Actor, raw: { lineId: string; reason: string }, now: number, from: "matched" | "unmatched" | "ignored", to: "matched" | "unmatched" | "ignored", action: string, guardCode: string): Promise<{ replayed: boolean }> {
  requireReconcile(actor);
  const input = NoteInput.parse(raw);
  const line = await db.select().from(statementLines).where(eq(statementLines.id, input.lineId)).get();
  if (!line) throw notFound("statement_line");
  if (line.status === to) return { replayed: true };
  if (line.status !== from) throw new AppError(guardCode.toLowerCase(), 409);
  const by = actor.kind === "employee" ? actor.id : null;
  try {
    await runBatch(db, [
      db
        .update(statementLines)
        .set(to === "unmatched" ? { status: "unmatched", matchedPaymentId: null, matchedBy: null, matchedAt: null } : { status: to, matchedBy: by, matchedAt: now })
        .where(and(eq(statementLines.id, line.id), eq(statementLines.status, from))),
      expectChanged(db, 1, { code: guardCode, detail: line.id }),
      auditStatement(db, { actor, action, entityType: "statement_line", entityId: line.id, before: { status: from, paymentId: line.matchedPaymentId }, after: { status: to }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (mapDbError(error)?.code === guardCode) throw new AppError(guardCode.toLowerCase(), 409);
    throw error;
  }
  return { replayed: false };
}

/** Undoes a match (the line is unmatched again; the payment is free), with a reason. */
export function unmatchStatementLine(db: Db, actor: Actor, raw: { lineId: string; reason: string }, now: number) {
  return setLineStatus(db, actor, raw, now, "matched", "unmatched", "finance.statement.unmatch", "LINE_NOT_MATCHED");
}

/** Sets a line aside: it proves no order payment (a top-up, a fee, the owner's deposit, money out). The note is kept. */
export function ignoreStatementLine(db: Db, actor: Actor, raw: { lineId: string; reason: string }, now: number) {
  return setLineStatus(db, actor, raw, now, "unmatched", "ignored", "finance.statement.ignore", "LINE_NOT_UNMATCHED");
}

/** Brings a set-aside line back to the unmatched list. */
export function restoreStatementLine(db: Db, actor: Actor, raw: { lineId: string; reason: string }, now: number) {
  return setLineStatus(db, actor, raw, now, "ignored", "unmatched", "finance.statement.restore", "LINE_NOT_IGNORED");
}

/**
 * Matches every unmatched money-in line of the range that has exactly ONE paid payment of its source's method with the
 * same amount AND the same reference (normalised), not matched elsewhere — the unambiguous ones only. Each match is
 * its own guarded batch; lines that lost a race are counted as skipped.
 */
export async function matchExactLines(db: Db, actor: Actor, range: RangeFilter, now: number): Promise<{ matched: number; skipped: number }> {
  requireReconcile(actor);
  const lines = await db.all<{ id: string; source: string; amount: number; reference: string | null }>(sql`
    SELECT id, source, amount_iqd AS amount, reference FROM statement_lines
    WHERE status = 'unmatched' AND amount_iqd > 0 AND reference IS NOT NULL AND occurred_at >= ${range.fromMs} AND occurred_at < ${range.toMs}
    ORDER BY occurred_at LIMIT 200`);
  let matched = 0;
  let skipped = 0;
  const taken = new Set<string>();
  for (const line of lines) {
    const method = METHOD_OF[line.source as StatementSource];
    const ref = normalizeReference(line.reference);
    if (!method || !ref) continue;
    const candidates = await db.all<{ id: string; reference: string | null; ref: string }>(sql`
      SELECT p.id, p.reference, o.ref FROM payments AS p JOIN orders AS o ON o.id = p.order_id
      WHERE p.method = ${method} AND p.status = 'paid' AND p.amount_iqd = ${num(line.amount)}
        AND NOT EXISTS (SELECT 1 FROM statement_lines AS sl WHERE sl.matched_payment_id = p.id)`);
    const exact = candidates.filter((row) => !taken.has(row.id) && (normalizeReference(row.reference) === ref || normalizeReference(row.ref) === ref));
    if (exact.length !== 1) continue;
    try {
      await matchStatementLine(db, actor, { lineId: line.id, paymentId: exact[0].id }, now);
      taken.add(exact[0].id);
      matched++;
    } catch (error) {
      if (error instanceof AppError) skipped++;
      else throw error;
    }
  }
  return { matched, skipped };
}

/** Lines of the range still to look at (the module's queue). */
export async function countUnmatched(db: Db, actor: Actor): Promise<number> {
  requireReconcile(actor);
  const rows = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM statement_lines WHERE status = 'unmatched'`);
  return num(rows[0]?.n);
}

