/**
 * Admin 20.03 — the tamper-evident audit trail: browse and filter every recorded change (who, what, which record,
 * why, from where, before and after), verify the hash chain, seal what is not sealed yet, and export the same view.
 *
 * Nothing here writes an event's row: `audit_events` is append-only in the database (triggers refuse UPDATE, DELETE and
 * a REPLACE over an existing event) and `audit_seals` chains SHA-256 hashes over it (~/server/audit.server). The
 * daily cron seals and logs the head hash to the Workers logs; the head hash shown here is the one to compare with
 * those off-site copies. Verifying, sealing and exporting are themselves audited.
 *
 * Permissions: audit.read to browse and export; security.audit.verify to verify and seal. Snapshots are cut for
 * employees without cost.read / profit.read (shared.server.ts): the purchasing, landed-cost, cost and books families
 * are withheld whole, cost and margin keys are removed from the rest — absent, never blanked.
 */
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { assertCan, can, type Actor } from "~/server/actor";
import { audit, sealAudit, verifyAuditChain, type AuditChainReport, type SealAuditResult } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, auditSeals } from "~/server/db/schema";
import { notFound } from "~/server/errors";
import { cutSnapshot, snapshotWithheld } from "./shared.server";
import { DAY_MS, baghdadDayStart, type AuditFilters } from "./types";

const PAGE_SIZE = 50;
export const AUDIT_EXPORT_LIMIT = 5_000;

export type AuditRow = {
  id: string;
  seq: number;
  at: number;
  actorKind: string;
  actorId: string | null;
  actorLabel: string | null;
  action: string;
  entityType: string | null;
  entityId: string | null;
  summary: string | null;
  reason: string | null;
  ip: string | null;
  /** The event holds a before or after snapshot. */
  hasChange: boolean;
  /** The snapshot exists but is cost data this employee may not see. */
  withheld: boolean;
};

export type ChainHead = { lastSeal: { toSeq: number; hash: string; createdAt: number } | null; unsealed: number; total: number };

function whereOf(filters: AuditFilters): SQL | undefined {
  const parts: SQL[] = [];
  if (filters.module) parts.push(sql`${auditEvents.action} LIKE ${`${filters.module}.%`}`);
  if (filters.actor) parts.push(filters.actor === "system" ? eq(auditEvents.actorKind, "system") : eq(auditEvents.actorId, filters.actor));
  if (filters.entityType) parts.push(eq(auditEvents.entityType, filters.entityType));
  if (filters.entityId) parts.push(eq(auditEvents.entityId, filters.entityId));
  if (filters.from) parts.push(gte(auditEvents.at, baghdadDayStart(filters.from)));
  if (filters.to) parts.push(lt(auditEvents.at, baghdadDayStart(filters.to) + DAY_MS));
  if (filters.q) {
    const text = `%${filters.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    parts.push(sql`(${auditEvents.action} LIKE ${text} ESCAPE '\\' OR ${auditEvents.entityId} LIKE ${text} ESCAPE '\\' OR ${auditEvents.actorLabel} LIKE ${text} ESCAPE '\\' OR ${auditEvents.summary} LIKE ${text} ESCAPE '\\' OR ${auditEvents.reason} LIKE ${text} ESCAPE '\\')`);
  }
  return parts.length ? and(...parts) : undefined;
}

const rowOf = (actor: Actor, row: typeof auditEvents.$inferSelect): AuditRow => ({
  id: row.id,
  seq: row.seq,
  at: row.at,
  actorKind: row.actorKind,
  actorId: row.actorId,
  actorLabel: row.actorLabel,
  action: row.action,
  entityType: row.entityType,
  entityId: row.entityId,
  summary: row.summary,
  reason: row.reason,
  ip: row.ip,
  hasChange: row.before !== null || row.after !== null,
  withheld: (row.before !== null || row.after !== null) && snapshotWithheld(actor, row.action),
});

export async function chainHead(db: Db): Promise<ChainHead> {
  const [seal, counts] = await Promise.all([
    db.select({ toSeq: auditSeals.toSeq, hash: auditSeals.hash, createdAt: auditSeals.createdAt }).from(auditSeals).orderBy(desc(auditSeals.toSeq)).limit(1).get(),
    db.all<{ total: number; maxSeq: number | null }>(sql`SELECT count(*) AS total, max(seq) AS maxSeq FROM audit_events`),
  ]);
  const total = Number(counts[0]?.total ?? 0);
  const unsealed = seal ? Number((await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM audit_events WHERE seq > ${seal.toSeq}`))[0]?.n ?? 0) : total;
  return { lastSeal: seal ?? null, unsealed, total };
}

export type AuditPage = { rows: AuditRow[]; total: number; page: number; pageCount: number; head: ChainHead; modules: string[]; entityTypes: string[] };

export async function listAuditEvents(db: Db, actor: Actor, filters: AuditFilters): Promise<AuditPage> {
  assertCan(actor, "audit.read");
  const where = whereOf(filters);
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [rows, count, head, modules, types] = await Promise.all([
    db.select().from(auditEvents).where(where).orderBy(desc(auditEvents.seq)).limit(PAGE_SIZE).offset(offset),
    db.select({ n: sql<number>`count(*)` }).from(auditEvents).where(where).get(),
    chainHead(db),
    db.all<{ module: string }>(sql`SELECT DISTINCT substr(action, 1, instr(action, '.') - 1) AS module FROM audit_events ORDER BY module`),
    db.all<{ type: string }>(sql`SELECT DISTINCT entity_type AS type FROM audit_events WHERE entity_type IS NOT NULL ORDER BY type LIMIT 200`),
  ]);
  const total = Number(count?.n ?? 0);
  return {
    rows: rows.map((row) => rowOf(actor, row)),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    head,
    modules: modules.map((row) => row.module).filter(Boolean),
    entityTypes: types.map((row) => row.type),
  };
}

export type AuditDetail = AuditRow & { requestId: string | null; before: unknown; after: unknown; sealed: boolean; sameRequest: AuditRow[] };

export async function getAuditEvent(db: Db, actor: Actor, eventId: string): Promise<AuditDetail> {
  assertCan(actor, "audit.read");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(eventId)) throw notFound("audit_event");
  const row = await db.select().from(auditEvents).where(eq(auditEvents.id, eventId)).get();
  if (!row) throw notFound("audit_event");
  const [seal, siblings] = await Promise.all([
    db.select({ toSeq: auditSeals.toSeq }).from(auditSeals).orderBy(desc(auditSeals.toSeq)).limit(1).get(),
    row.requestId ? db.select().from(auditEvents).where(and(eq(auditEvents.requestId, row.requestId), sql`${auditEvents.id} <> ${row.id}`)).orderBy(desc(auditEvents.seq)).limit(20) : Promise.resolve([]),
  ]);
  const base = rowOf(actor, row);
  return {
    ...base,
    requestId: row.requestId,
    before: base.withheld ? null : cutSnapshot(actor, row.before),
    after: base.withheld ? null : cutSnapshot(actor, row.after),
    sealed: seal ? row.seq <= seal.toSeq : false,
    sameRequest: siblings.map((sibling) => rowOf(actor, sibling)),
  };
}

/** Recomputes the whole chain (security.audit.verify); the check itself is recorded. */
export async function verifyChain(db: Db, actor: Actor, now: number): Promise<AuditChainReport> {
  assertCan(actor, "security.audit.verify");
  const report = await verifyAuditChain(db);
  await audit(db, { actor, action: "security.audit.verify", entityType: "audit_chain", entityId: report.headHash ?? "none", after: { ok: report.ok, sealsChecked: report.sealsChecked, eventsChecked: report.eventsChecked, problems: report.problems.length, unsealedEvents: report.unsealedEvents }, at: now });
  return report;
}

/** Seals every event not sealed yet (what the daily cron does), then records that it was done. */
export async function sealNow(db: Db, actor: Actor, now: number): Promise<SealAuditResult> {
  assertCan(actor, "security.audit.verify");
  const result = await sealAudit(db, now, { maxSeals: 20 });
  await audit(db, { actor, action: "security.audit.seal", entityType: "audit_chain", entityId: result.headHash ?? "none", after: { ...result }, at: now });
  return result;
}

const CSV_COLUMNS = ["seq", "id", "at_iso", "actor_kind", "actor_id", "actor_label", "action", "entity_type", "entity_id", "summary", "reason", "ip", "request_id", "before", "after"] as const;

const cell = (value: unknown): string => {
  if (value === null || value === undefined) return "";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  // a cell that a spreadsheet would read as a formula starts with a quote
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The filtered events as CSV (at most AUDIT_EXPORT_LIMIT, newest first), snapshots cut as on screen; audited. */
export async function exportAuditCsv(db: Db, actor: Actor, filters: AuditFilters, now: number): Promise<{ csv: string; rows: number; truncated: boolean }> {
  assertCan(actor, "audit.read");
  const rows = await db.select().from(auditEvents).where(whereOf(filters)).orderBy(desc(auditEvents.seq)).limit(AUDIT_EXPORT_LIMIT + 1);
  const truncated = rows.length > AUDIT_EXPORT_LIMIT;
  const body = rows.slice(0, AUDIT_EXPORT_LIMIT).map((row) => {
    const withheld = snapshotWithheld(actor, row.action);
    return [row.seq, row.id, new Date(row.at).toISOString(), row.actorKind, row.actorId, row.actorLabel, row.action, row.entityType, row.entityId, row.summary, row.reason, row.ip, row.requestId, withheld ? null : cutSnapshot(actor, row.before), withheld ? null : cutSnapshot(actor, row.after)].map(cell).join(",");
  });
  await audit(db, { actor, action: "security.audit.export", entityType: "audit_events", entityId: null, after: { rows: Math.min(rows.length, AUDIT_EXPORT_LIMIT), truncated, filters: { ...filters, page: undefined }, costIncluded: can(actor, "cost.read") }, at: now });
  return { csv: `\ufeff${[CSV_COLUMNS.join(","), ...body].join("\r\n")}\r\n`, rows: body.length, truncated };
}
