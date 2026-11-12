/**
 * Admin 18.06 — saved reports (`saved_reports`): a report's view kept under a name, for oneself or shared.
 *
 *   await saveReport(db, actor, { reportKey: "sales", name: "مبيعات الشهر حسب المنصة", search: "?period=2026-11&by=platform", shared: false, idempotencyKey }, now);
 *   await listSavedReports(db, actor);           // mine + shared, only of reports this employee may open
 *   await updateSavedReport(db, actor, { id, name, shared, expectedUpdatedAt }, now);
 *   await deleteSavedReport(db, actor, { id, reason, expectedUpdatedAt }, now);
 *
 * Rules: saving needs reports.saved.manage AND the report's own permission (one never saves what one cannot open);
 * only what the report's page accepts is kept (savedParamsOf — the range, demo switch and the report's choices, never
 * a page number); the id derives from the form's key, so a double submit finds the first record (`replayed`); only the
 * owner renames, shares or deletes (403 `saved_not_owner`); a change is guarded on the `updated_at` the form showed
 * (409 `saved_changed`); deleting needs a reason; every change is ONE batch with its audit event (`reports.saved.*`).
 * A shared report appears to everyone who may open its report — it carries no figures, only the choices, and opens
 * with the viewer's own permissions (cost and profit stay theirs). An employee limited to a branch may open no report
 * (the whole-company rule), so none is listed for them either.
 * Free text (the name, a saved search, the reason) loses control, bidi-override and invisible characters before it is
 * judged and stored (text.server cleanLine): a shared name shows colleagues what it says (review 2026-11-12).
 * Scheduled delivery is NOT offered: no e-mail provider is configured (a boundary, never a pretend schedule).
 */
import { and, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { savedReports } from "~/server/db/schema";
import { expectChanged, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, notFound } from "~/server/errors";
import { cleanLine } from "~/server/text.server";
import { actorIdOf, assertReport, idFromKey, mayOpenReport, num } from "./shared.server";
import { REPORT_KEYS, savedParamsOf, savedReportHref, type ReportKey } from "./types";

export const SAVED_ERROR_KEYS = ["saved_changed", "saved_not_owner", "idempotency_mismatch"] as const;

/** A saved report's parameters, each value cleaned as one line of text (an empty value is left out). */
function cleanParams(params: Record<string, unknown> | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(params ?? {})) {
    if (typeof value !== "string") continue;
    const clean = cleanLine(value).trim();
    if (clean !== "") out[name] = clean;
  }
  return out;
}

export type SavedReportView = {
  id: string;
  reportKey: ReportKey;
  name: string;
  params: Record<string, string>;
  href: string;
  shared: boolean;
  mine: boolean;
  owner: { id: string | null; name: string | null };
  createdAt: number;
  updatedAt: number;
};

const name = z.string({ error: "required" }).overwrite(cleanLine).trim().min(2, "too_short").max(80, "too_long");
const key = z.string({ error: "required" }).regex(/^[A-Za-z0-9_-]{16,128}$/, "invalid");

export const SaveReportInput = z.object({
  reportKey: z.enum(REPORT_KEYS, { error: "invalid" }),
  name,
  /** The report's query string as the page had it ("?period=…&by=…"). */
  search: z.string().max(2000, "too_long").default(""),
  shared: z.boolean().default(false),
  idempotencyKey: key,
});

export const UpdateSavedInput = z.object({ id: z.string().min(1).max(64), name, shared: z.boolean(), expectedUpdatedAt: z.number().int() });
export const DeleteSavedInput = z.object({ id: z.string().min(1).max(64), reason: z.string({ error: "reason_required" }).overwrite(cleanLine).trim().min(3, "reason_required").max(500, "too_long"), expectedUpdatedAt: z.number().int() });

function viewOf(row: typeof savedReports.$inferSelect, actor: Actor, ownerName: string | null): SavedReportView | null {
  if (!(REPORT_KEYS as readonly string[]).includes(row.reportKey)) return null;
  const reportKey = row.reportKey as ReportKey;
  // cleaned on the way out too: a record saved before the rule was in place shows what it says
  const params = cleanParams(row.params);
  const me = actorIdOf(actor);
  return {
    id: row.id,
    reportKey,
    name: cleanLine(row.name).trim() || row.id,
    params,
    href: savedReportHref(reportKey, params),
    shared: row.isShared,
    mine: me !== null && row.ownerId === me,
    owner: { id: row.ownerId, name: ownerName },
    createdAt: num(row.createdAt),
    updatedAt: num(row.updatedAt),
  };
}

/** Mine and shared ones, newest first — only those of reports this employee may open (none for a branch-limited one). */
export async function listSavedReports(db: Db, actor: Actor, options: { limit?: number } = {}): Promise<SavedReportView[]> {
  const me = actorIdOf(actor);
  const allowed = REPORT_KEYS.filter((reportKey) => mayOpenReport(actor, reportKey));
  if (allowed.length === 0) return [];
  const rows = await db
    .select()
    .from(savedReports)
    .where(and(me ? or(eq(savedReports.ownerId, me), eq(savedReports.isShared, true)) : eq(savedReports.isShared, true), sql`${savedReports.reportKey} IN (SELECT value FROM json_each(${JSON.stringify(allowed)}))`))
    .orderBy(sql`${savedReports.updatedAt} DESC`, savedReports.id)
    .limit(Math.min(options.limit ?? 200, 200));
  const owners = [...new Set(rows.map((row) => row.ownerId).filter((id): id is string => Boolean(id)))];
  const names = owners.length
    ? new Map(
        (await db.all<{ id: string; name: string }>(sql`SELECT id, name FROM employees WHERE id IN (SELECT value FROM json_each(${JSON.stringify(owners)}))`)).map((row) => [row.id, row.name]),
      )
    : new Map<string, string>();
  return rows.map((row) => viewOf(row, actor, row.ownerId ? (names.get(row.ownerId) ?? null) : null)).filter((view): view is SavedReportView => view !== null);
}

/** Saves the view (a new record, or the first one again for the same form key). */
export async function saveReport(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string; replayed: boolean }> {
  assertCan(actor, "reports.saved.manage");
  const input = SaveReportInput.parse(raw);
  assertReport(actor, input.reportKey);
  const owner = actorIdOf(actor);
  const params = cleanParams(savedParamsOf(input.reportKey, new URLSearchParams(input.search.startsWith("?") ? input.search.slice(1) : input.search), now));
  const id = await idFromKey("svr", actor, input.idempotencyKey);
  const existing = await db.select().from(savedReports).where(eq(savedReports.id, id)).get();
  if (existing) {
    if (existing.reportKey === input.reportKey && existing.name === input.name) return { id, replayed: true };
    throw new AppError("idempotency_mismatch", 409);
  }
  const values = { id, reportKey: input.reportKey, name: input.name, params, schedule: null, recipients: null, format: "csv" as const, ownerId: owner, isShared: input.shared, lastRunAt: null, createdAt: now, updatedAt: now };
  try {
    await runBatch(db, [
      db.insert(savedReports).values(values),
      auditStatement(db, { actor, action: "reports.saved.create", entityType: "saved_report", entityId: id, after: { reportKey: input.reportKey, name: input.name, params, shared: input.shared }, at: now }),
    ]);
  } catch (error) {
    // two submits of the same form at once: the second meets the first's primary key
    const again = await db.select().from(savedReports).where(eq(savedReports.id, id)).get();
    if (again && again.reportKey === input.reportKey && again.name === input.name) return { id, replayed: true };
    throw error;
  }
  return { id, replayed: false };
}

async function ownRecord(db: Db, actor: Actor, id: string) {
  const row = await db.select().from(savedReports).where(eq(savedReports.id, id)).get();
  const me = actorIdOf(actor);
  // a record the employee cannot see is not found; one they see (shared) but do not own is refused
  const visible = row && (row.ownerId === me || row.isShared) && (REPORT_KEYS as readonly string[]).includes(row.reportKey) && mayOpenReport(actor, row.reportKey as ReportKey);
  if (!row || !visible) throw notFound("saved_report");
  if (row.ownerId !== me) throw new AppError("saved_not_owner", 403);
  return row;
}

/** Renames or (un)shares one's own saved report. */
export async function updateSavedReport(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "reports.saved.manage");
  const input = UpdateSavedInput.parse(raw);
  const row = await ownRecord(db, actor, input.id);
  if (num(row.updatedAt) !== input.expectedUpdatedAt) throw new AppError("saved_changed", 409);
  if (row.name === input.name && row.isShared === input.shared) return { changed: false };
  const updatedAt = Math.max(now, num(row.updatedAt) + 1);
  await runBatch(db, [
    db
      .update(savedReports)
      .set({ name: input.name, isShared: input.shared, updatedAt })
      .where(and(eq(savedReports.id, row.id), eq(savedReports.updatedAt, input.expectedUpdatedAt))),
    expectChanged(db, 1, { code: "SAVED_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "reports.saved.update", entityType: "saved_report", entityId: row.id, before: { name: row.name, shared: row.isShared }, after: { name: input.name, shared: input.shared }, at: now }),
  ]).catch((error: unknown) => {
    throw changedOr(error);
  });
  return { changed: true };
}

/** Deletes one's own saved report, with a reason (audited with what it held). */
export async function deleteSavedReport(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ deleted: true }> {
  assertCan(actor, "reports.saved.manage");
  const input = DeleteSavedInput.parse(raw);
  const row = await ownRecord(db, actor, input.id);
  if (num(row.updatedAt) !== input.expectedUpdatedAt) throw new AppError("saved_changed", 409);
  await runBatch(db, [
    db.delete(savedReports).where(and(eq(savedReports.id, row.id), eq(savedReports.updatedAt, input.expectedUpdatedAt))),
    expectChanged(db, 1, { code: "SAVED_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "reports.saved.delete", entityType: "saved_report", entityId: row.id, before: { reportKey: row.reportKey, name: row.name, params: row.params, shared: row.isShared }, reason: input.reason, at: now }),
  ]).catch((error: unknown) => {
    throw changedOr(error);
  });
  return { deleted: true };
}

/** The batch's guard (the record moved on since the form read it) as saved_changed; anything else unchanged. */
function changedOr(error: unknown): unknown {
  return isDbError(error, "SAVED_CHANGED") ? new AppError("saved_changed", 409) : error;
}
