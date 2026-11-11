/**
 * Admin module 04 — periodic and selective stock counts whose differences a supervisor approves (04.05).
 *
 *   const { countId } = await createCount(db, actor, { locationId, mode: "all" | "skus" | "sample", skus, sampleSize, idempotencyKey }, now);
 *   await recordCounts(db, actor, { countId, lines: [{ variantId, countedQty: 7 }, { variantId: tracked, serials: ["SN1"] }] }, now);
 *   await submitCount(db, actor, { countId }, now);                       // counting → review
 *   await approveCount(db, supervisor, { countId, reason, allowOversell }, now);   // review → approved: differences posted
 *
 * Flow and rules
 *   · Periodic = every item at the location ("all"); selective = chosen SKUs ("skus") or a random sample of the items
 *     held there ("sample"). One open count per location at a time (two would post the same difference twice) —
 *     checked again inside the creating batch, so two counts started at the same moment cannot both open.
 *   · Blind counting: while a count is open, the expected quantity is shown only to employees who may approve counts;
 *     for everyone else nothing that reveals it leaves the server (on hand now, differences, oversell flags, missing
 *     or unexpected serials). The stock pages still show on-hand quantities to holders of inventory.stock.read.
 *   · The expected quantity of a line is captured WHEN IT IS COUNTED (on hand at that moment), so sales and receipts
 *     that happen while the shelf is being counted do not turn into false differences. Items found that were not on
 *     the list are added as lines.
 *   · Differences are posted only by a supervisor (inventory.count.approve + inventory.stock.adjust) who neither
 *     started the count nor counted any of its lines — the counter never approves their own count (two-person rule),
 *     also when a colleague counted the same line again afterwards (the audit trail keeps every recording).
 *     Each difference goes through the commerce core's adjustStock with the count's reference, the line and the
 *     approver's reason in the movement reason. A difference that would take available stock below zero (units
 *     promised to orders are missing) needs inventory.oversell.authorize and an explicit request (allowOversell);
 *     otherwise the approval is refused BEFORE anything is posted.
 *   · Posting is resumable and double-submit safe: a line whose CURRENT count is already posted (an adjustment
 *     carrying "[<line id>]" at least as recent as the line's last counting) is skipped, and each counting of a line
 *     is claimed once while it is being posted. An approval stopped half way (stock changed, connection lost) keeps
 *     what it posted: approving again posts the rest; after a send-back, a recounted line is counted against the
 *     stock as it is then (the earlier posting included) and posts only its new difference. A count with posted
 *     differences cannot be cancelled (count_partially_posted, checked again inside the cancelling batch): it is
 *     finished by an approval, after a recount if needed. The approval re-reads the count's status before each line,
 *     so a send-back or cancel that lands meanwhile stops it (at most the line in flight is posted).
 *   · Serial-tracked items are counted by scanning serial numbers. Their differences (serials missing from the shelf,
 *     serials found that the system places elsewhere or does not know) are shown and recorded with the approval,
 *     but not posted: the commerce core has no operation that writes off or re-registers a single serial yet
 *     (docs/areas/admin-inventory.md, "Requests").
 *   · Every step writes an audit event.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { serverT } from "~/i18n/i18n.server";
import { publicRef, sha256Hex } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { actorRef, assertBranch, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { cycleCountLines, cycleCounts, type NewCycleCountLine } from "~/server/db/schema";
import { chunkRows, expectChanged, expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { claimOnce, resetRateLimit } from "~/server/ratelimit.server";
import { takeFifo, costOfSlices } from "~/server/services/inventory/fifo";
import { adjustStock } from "~/server/services/inventory/stock.server";
import { idempotencyKeySchema } from "~/server/services/inventory/transfers.server";
import { PAGE_SIZE, employeeNames, labelOf, locationTree, pageOf, type LocationNode, type VariantLabel } from "./shared.server";

export const COUNT_ERROR_KEYS = [
  "count_location_busy",
  "count_not_open",
  "count_not_in_review",
  "count_self_approval",
  "count_nothing_counted",
  "count_empty",
  "count_stock_changed",
  "count_oversell_needs_authorization",
  "count_unknown_skus",
  "count_partially_posted",
] as const;

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid");
export const COUNT_MODES = ["all", "skus", "sample"] as const;
export type CountMode = (typeof COUNT_MODES)[number];

export const CreateCountInput = z.object({
  locationId: idSchema,
  mode: z.enum(COUNT_MODES),
  /** SKUs or barcodes (mode "skus"). */
  skus: z.array(z.string().trim().min(1).max(100)).max(500).optional(),
  /** How many items to draw at random (mode "sample"). */
  sampleSize: z.number().int("invalid").min(1, "too_small").max(500, "too_big").optional(),
  notes: z.string().trim().max(500, "too_long").optional(),
  idempotencyKey: idempotencyKeySchema,
});

export const RecordCountsInput = z.object({
  countId: idSchema,
  lines: z
    .array(
      z.object({
        variantId: idSchema,
        countedQty: z.number().int("invalid").min(0, "too_small").max(100_000, "too_big").optional(),
        serials: z.array(z.string().trim().min(1).max(100)).max(10_000).optional(),
        note: z.string().trim().max(300, "too_long").optional(),
      }),
    )
    .min(1, "required")
    .max(500, "too_big"),
});

export const ApproveCountInput = z.object({
  countId: idSchema,
  reason: z.string().trim().min(3, "too_short").max(300, "too_long"),
  /** Explicit request to post differences that take available stock below zero (needs inventory.oversell.authorize). */
  allowOversell: z.boolean().optional(),
});

export const CountReasonInput = z.object({ countId: idSchema, reason: z.string().trim().min(3, "too_short").max(300, "too_long") });

type CountRow = typeof cycleCounts.$inferSelect;
type LineRow = typeof cycleCountLines.$inferSelect;

async function loadCount(db: Db, countId: string): Promise<{ count: CountRow; lines: LineRow[]; location: { id: string; code: string; isActive: boolean; branchId: string | null } }> {
  const [countRows, lineRows] = await db.batch([
    db.select().from(cycleCounts).where(eq(cycleCounts.id, countId)),
    db.select().from(cycleCountLines).where(eq(cycleCountLines.countId, countId)),
  ]);
  const count = countRows[0];
  if (!count) throw notFound("cycle_count");
  const locations = await db.all<{ id: string; code: string; isActive: number; branchId: string | null }>(sql`SELECT id, code, is_active AS isActive, branch_id AS branchId FROM inventory_locations WHERE id = ${count.locationId}`);
  const location = locations[0];
  if (!location) throw notFound("location");
  return { count, lines: lineRows, location: { id: location.id, code: location.code, isActive: Boolean(location.isActive), branchId: location.branchId } };
}

const normalizeSerials = (values: readonly string[]) => [...new Set(values.map((value) => value.trim().toUpperCase()).filter(Boolean))];

/**
 * Whether an employee took part in a count: started it, or recorded any of its lines — now or before a colleague
 * counted that line again (the line keeps only its last counter; the audit trail keeps every recording).
 */
async function tookPart(db: Db, actorId: string | null, count: Pick<CountRow, "id" | "startedBy">, lines: readonly Pick<LineRow, "countedBy">[]): Promise<boolean> {
  if (actorId === null) return false;
  if (count.startedBy === actorId || lines.some((line) => line.countedBy === actorId)) return true;
  const recorded = await db.all<{ id: string }>(sql`
    SELECT id FROM audit_events
    WHERE entity_type = 'cycle_count' AND entity_id = ${count.id} AND action = 'inventory.count.record' AND actor_kind = 'employee' AND actor_id = ${actorId}
    LIMIT 1`);
  return recorded.length > 0;
}

/** The adjustments posted for a count: "<ref> [<line id>]: …" at the count's location (the core's adjustStock rows). */
const postingsWhere = (count: Pick<CountRow, "ref" | "locationId">) => sql`location_id = ${count.locationId} AND ref_type = 'adjustment' AND reason LIKE ${`${count.ref} [%`}`;

/** When each line of a count was last posted (line id → movement time). */
async function postingsOf(db: Db, count: Pick<CountRow, "ref" | "locationId">): Promise<Map<string, number>> {
  const rows = await db.all<{ reason: string; at: number }>(sql`SELECT reason, at FROM stock_movements WHERE ${postingsWhere(count)}`);
  const latest = new Map<string, number>();
  for (const row of rows) {
    const lineId = /\[([^\]]+)\]/.exec(row.reason)?.[1];
    if (lineId) latest.set(lineId, Math.max(latest.get(lineId) ?? 0, Number(row.at)));
  }
  return latest;
}

/**
 * Whether a line's CURRENT count is posted: an adjustment for it is at least as recent as its last counting. After a
 * send-back and a recount, an earlier posting no longer covers the line — its new difference (counted against the
 * stock as it is then, the earlier posting included) still has to be posted.
 */
const isPosted = (postings: ReadonlyMap<string, number>, line: Pick<LineRow, "id" | "countedAt">) => {
  const at = postings.get(line.id);
  return at !== undefined && at >= (line.countedAt ?? 0);
};

// ───────────────────────────────────────────────────────────────── start

export async function createCount(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ countId: string; ref: string; lines: number; replayed: boolean }> {
  assertCan(actor, "inventory.count.perform");
  const input = CreateCountInput.parse(raw);
  const { actorKind, actorId } = actorRef(actor);
  const countId = `cnt_${(await sha256Hex(`count:${actorKind}:${actorId ?? ""}:${input.idempotencyKey}`)).slice(0, 26)}`;
  const existing = await db.select({ ref: cycleCounts.ref }).from(cycleCounts).where(eq(cycleCounts.id, countId)).limit(1);
  if (existing[0]) return { countId, ref: existing[0].ref, lines: 0, replayed: true };

  const locations = await db.all<{ id: string; code: string; isActive: number; branchId: string | null }>(sql`SELECT id, code, is_active AS isActive, branch_id AS branchId FROM inventory_locations WHERE id = ${input.locationId}`);
  const location = locations[0];
  if (!location || !location.isActive) throw new AppError("location_invalid", 409, { fields: { locationId: "location_invalid" } });
  assertBranch(actor, location.branchId);
  const open = await db.all<{ ref: string }>(sql`SELECT ref FROM cycle_counts WHERE location_id = ${location.id} AND status IN ('draft', 'counting', 'review') LIMIT 1`);
  if (open[0]) throw new AppError("count_location_busy", 409, { fields: { locationId: "count_location_busy" }, detail: open[0].ref });

  let variantIds: string[] = [];
  if (input.mode === "all") {
    const rows = await db.all<{ variantId: string }>(sql`SELECT variant_id AS variantId FROM stock_levels WHERE location_id = ${location.id} AND (on_hand <> 0 OR reserved <> 0)`);
    variantIds = rows.map((row) => row.variantId);
  } else if (input.mode === "sample") {
    const size = input.sampleSize ?? 10;
    const rows = await db.all<{ variantId: string }>(sql`SELECT variant_id AS variantId FROM stock_levels WHERE location_id = ${location.id} AND on_hand <> 0 ORDER BY random() LIMIT ${size}`);
    variantIds = rows.map((row) => row.variantId);
  } else {
    const codes = [...new Set((input.skus ?? []).map((value) => value.trim()).filter(Boolean))];
    if (codes.length === 0) throw invalid({ skus: "required" });
    const rows = await db.all<{ id: string; sku: string; barcode: string | null }>(sql`
      SELECT id, sku, barcode FROM variants WHERE upper(sku) IN (SELECT upper(value) FROM json_each(${JSON.stringify(codes)})) OR barcode IN (SELECT value FROM json_each(${JSON.stringify(codes)}))`);
    const unknown = codes.filter((code) => !rows.some((row) => row.sku.toUpperCase() === code.toUpperCase() || row.barcode === code));
    if (unknown.length > 0) throw new AppError("count_unknown_skus", 400, { fields: { skus: "count_unknown_skus" }, detail: unknown.slice(0, 20).join(", ") });
    variantIds = [...new Set(rows.map((row) => row.id))];
  }
  if (input.mode !== "all" && variantIds.length === 0) throw new AppError("count_empty", 409, { fields: { mode: "count_empty" } });

  const levels = variantIds.length
    ? await db.all<{ variantId: string; onHand: number }>(sql`SELECT variant_id AS variantId, on_hand AS onHand FROM stock_levels WHERE location_id = ${location.id} AND variant_id IN (SELECT value FROM json_each(${JSON.stringify(variantIds)}))`)
    : [];
  const onHand = new Map(levels.map((row) => [row.variantId, row.onHand]));
  const ref = publicRef("CC");
  const lines: NewCycleCountLine[] = variantIds.map((variantId, index) => ({ id: `${countId}.${index + 1}`, countId, variantId, expectedQty: onHand.get(variantId) ?? 0, countedQty: null, reason: null, serialsSeen: null, countedBy: null, countedAt: null }));
  const statements: BatchStatement[] = [
    db.insert(cycleCounts).values({ id: countId, ref, locationId: location.id, scope: input.mode === "all" ? "full" : "partial", status: "counting", notes: input.notes ?? null, startedBy: actorId, createdAt: now, startedAt: now }),
    // One open count per location also when two are started at the same moment (both would post the same difference).
    expectThat(db, sql`(SELECT count(*) FROM cycle_counts WHERE location_id = ${location.id} AND status IN ('draft', 'counting', 'review')) <= 1`, { code: "COUNT_LOCATION_BUSY", detail: location.id }),
    ...chunkRows(cycleCountLines, lines).map((chunk) => db.insert(cycleCountLines).values(chunk)),
    auditStatement(db, { actor, action: "inventory.count.start", entityType: "cycle_count", entityId: countId, summary: `${ref} · ${location.code}`, after: { ref, locationId: location.id, mode: input.mode, lines: lines.length }, reason: input.notes ?? null, at: now }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isUniqueViolation(error, "cycle_counts.id")) return { countId, ref: (await db.select({ ref: cycleCounts.ref }).from(cycleCounts).where(eq(cycleCounts.id, countId)).limit(1))[0]?.ref ?? ref, lines: 0, replayed: true };
    if (isDbError(error, "COUNT_LOCATION_BUSY")) throw new AppError("count_location_busy", 409, { fields: { locationId: "count_location_busy" }, cause: error });
    throw error;
  }
  return { countId, ref, lines: lines.length, replayed: false };
}

// ───────────────────────────────────────────────────────────────── counting

/** Saves counted quantities (or scanned serials) for lines of an open count; unknown items found are added. */
export async function recordCounts(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ saved: number; added: number }> {
  assertCan(actor, "inventory.count.perform");
  const input = RecordCountsInput.parse(raw);
  const { actorId } = actorRef(actor);
  const { count, lines, location } = await loadCount(db, input.countId);
  if (count.status !== "counting") throw new AppError("count_not_open", 409, { detail: count.ref });
  assertBranch(actor, location.branchId);
  const variantIds = [...new Set(input.lines.map((line) => line.variantId))];
  const [variantRows, levelRows] = await Promise.all([
    db.all<{ id: string; trackSerials: number }>(sql`SELECT id, track_serials AS trackSerials FROM variants WHERE id IN (SELECT value FROM json_each(${JSON.stringify(variantIds)}))`),
    db.all<{ variantId: string; onHand: number }>(sql`SELECT variant_id AS variantId, on_hand AS onHand FROM stock_levels WHERE location_id = ${location.id} AND variant_id IN (SELECT value FROM json_each(${JSON.stringify(variantIds)}))`),
  ]);
  const tracked = new Map(variantRows.map((row) => [row.id, Boolean(row.trackSerials)]));
  const onHand = new Map(levelRows.map((row) => [row.variantId, row.onHand]));
  const statements: BatchStatement[] = [];
  let added = 0;
  let next = lines.reduce((max, line) => Math.max(max, Number(line.id.slice(line.id.lastIndexOf(".") + 1)) || 0), 0);
  for (const line of input.lines) {
    if (!tracked.has(line.variantId)) throw invalid({ lines: "not_found" }, line.variantId);
    const isTracked = tracked.get(line.variantId) === true;
    const seen = isTracked ? normalizeSerials(line.serials ?? []) : null;
    if (!isTracked && line.countedQty === undefined) throw invalid({ lines: "required" }, line.variantId);
    if (!isTracked && (line.serials ?? []).length > 0) throw invalid({ lines: "serials_not_tracked" }, line.variantId);
    const counted = isTracked ? (seen as string[]).length : (line.countedQty as number);
    const values = { expectedQty: onHand.get(line.variantId) ?? 0, countedQty: counted, serialsSeen: seen, reason: line.note || null, countedBy: actorId, countedAt: now };
    const existing = lines.find((candidate) => candidate.variantId === line.variantId);
    if (existing) {
      statements.push(db.update(cycleCountLines).set(values).where(eq(cycleCountLines.id, existing.id)));
    } else {
      added++;
      statements.push(db.insert(cycleCountLines).values({ id: `${count.id}.${++next}`, countId: count.id, variantId: line.variantId, ...values }));
    }
  }
  statements.unshift(
    // The count must still be open when the lines land (another device may have submitted it).
    db.update(cycleCounts).set({ notes: count.notes }).where(and(eq(cycleCounts.id, count.id), eq(cycleCounts.status, "counting"))),
    expectChanged(db, 1, { code: "COUNT_CHANGED", detail: count.id }),
  );
  statements.push(auditStatement(db, { actor, action: "inventory.count.record", entityType: "cycle_count", entityId: count.id, summary: count.ref, after: { lines: input.lines.length, added }, at: now }));
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "COUNT_CHANGED")) throw new AppError("count_not_open", 409, { detail: count.ref, cause: error });
    throw error;
  }
  return { saved: input.lines.length, added };
}

export async function submitCount(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "inventory.count.perform");
  const input = z.object({ countId: idSchema }).parse(raw);
  const { count, lines, location } = await loadCount(db, input.countId);
  if (count.status === "review") return { replayed: true };
  if (count.status !== "counting") throw new AppError("count_not_open", 409, { detail: count.ref });
  assertBranch(actor, location.branchId);
  if (!lines.some((line) => line.countedQty !== null)) throw new AppError("count_nothing_counted", 409);
  try {
    await runBatch(db, [
      db.update(cycleCounts).set({ status: "review", submittedAt: now }).where(and(eq(cycleCounts.id, count.id), eq(cycleCounts.status, "counting"))),
      expectChanged(db, 1, { code: "COUNT_CHANGED", detail: count.id }),
      auditStatement(db, { actor, action: "inventory.count.submit", entityType: "cycle_count", entityId: count.id, summary: count.ref, before: { status: "counting" }, after: { status: "review", counted: lines.filter((line) => line.countedQty !== null).length, lines: lines.length }, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "COUNT_CHANGED")) throw new AppError("count_not_open", 409, { detail: count.ref, cause: error });
    throw error;
  }
  return { replayed: false };
}

// ───────────────────────────────────────────────────────────────── review

export type CountLineView = {
  id: string;
  variant: VariantLabel;
  expected: number | null;
  counted: number | null;
  difference: number | null;
  note: string | null;
  countedBy: string | null;
  countedAt: number | null;
  tracked: boolean;
  /**
   * Serial-tracked lines (with inventory.serial.read): what was scanned and, once the count is not blind for this
   * employee, what the shelf should hold (missing / unexpected stay empty while it is).
   */
  serials?: { seen: string[]; missing: string[]; unexpected: { serial: string; status: string | null; locationCode: string | null }[] };
  /** Now, at the count's location; null while the count is blind for this employee (the system quantity is the answer). */
  onHandNow: number | null;
  reservedNow: number | null;
  /** The difference would take available below zero: units promised to orders are not on the shelf (false while blind). */
  oversell: boolean;
  /** The line's current count is posted (an adjustment newer than its last counting exists); false while blind. */
  posted: boolean;
  /** [P] Estimated value of the difference (FIFO layers for missing units, standard cost for found ones); cost.read only. Null = unknown. */
  valueIqd?: number | null;
};

export type CountView = {
  id: string;
  ref: string;
  location: Pick<LocationNode, "id" | "code" | "name" | "path">;
  scope: "full" | "partial";
  status: CountRow["status"];
  notes: string | null;
  startedBy: string | null;
  startedById: string | null;
  approvedBy: string | null;
  createdAt: number;
  submittedAt: number | null;
  approvedAt: number | null;
  /**
   * Expected quantities are shown: approvers always; everyone once the count is no longer being counted. While it is
   * blind, nothing that reveals them leaves the server: expected, differences, on hand now, oversell flags, missing
   * or unexpected serials and the summary's differences are null / empty.
   */
  showExpected: boolean;
  lines: CountLineView[];
  /** `differences` … `unitsFound` are null while the count is blind for this employee. */
  summary: { lines: number; counted: number; differences: number | null; serialDifferences: number | null; oversell: number | null; unitsMissing: number | null; unitsFound: number | null };
  /** Who may approve (UI hint; approveCount checks again): approve permission and not a counter or the starter. */
  canApprove: boolean;
  selfInvolved: boolean;
  /**
   * Lines with a difference already posted while the count is not approved (an approval stopped half way): the count
   * can no longer be cancelled — it is finished by an approval, after a recount if needed. 0 otherwise.
   */
  postedLines: number;
};

export async function getCount(db: Db, actor: Actor, countId: string, locale: Locale): Promise<CountView> {
  assertCan(actor, "inventory.stock.read");
  const { count, lines } = await loadCount(db, countId);
  const tree = await locationTree(db);
  const byId = new Map(tree.map((node) => [node.id, node]));
  const node = byId.get(count.locationId);
  const variantIds = lines.map((line) => line.variantId);
  const json = JSON.stringify(variantIds);
  const withCost = can(actor, "cost.read");
  const withSerials = can(actor, "inventory.serial.read");
  const [labelRows, levelRows, postings] = await Promise.all([
    db.all<{ id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number }>(sql`
      SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive
      FROM variants AS v JOIN products AS p ON p.id = v.product_id WHERE v.id IN (SELECT value FROM json_each(${json}))`),
    db.all<{ variantId: string; onHand: number; reserved: number }>(sql`SELECT variant_id AS variantId, on_hand AS onHand, reserved FROM stock_levels WHERE location_id = ${count.locationId} AND variant_id IN (SELECT value FROM json_each(${json}))`),
    postingsOf(db, count),
  ]);
  const labels = new Map(labelRows.map((row) => [row.id, labelOf(row, locale)]));
  const levels = new Map(levelRows.map((row) => [row.variantId, row]));
  const names = await employeeNames(db, [count.startedBy, count.approvedBy, ...lines.map((line) => line.countedBy)]);
  const showExpected = can(actor, "inventory.count.approve") || count.status !== "counting";

  // Serial-tracked lines: the serials the system places on this shelf now, against what was scanned.
  const serialInfo = new Map<string, CountLineView["serials"]>();
  const trackedLines = lines.filter((line) => labels.get(line.variantId)?.trackSerials);
  if (withSerials && trackedLines.length > 0 && !showExpected) {
    // Blind: what was scanned, nothing about what the shelf should hold.
    for (const line of trackedLines) serialInfo.set(line.variantId, { seen: normalizeSerials(line.serialsSeen ?? []), missing: [], unexpected: [] });
  } else if (withSerials && trackedLines.length > 0) {
    const trackedJson = JSON.stringify(trackedLines.map((line) => line.variantId));
    const seenAll = normalizeSerials(trackedLines.flatMap((line) => line.serialsSeen ?? []));
    const [expectedRows, seenRows] = await Promise.all([
      db.all<{ variantId: string; serial: string }>(sql`SELECT variant_id AS variantId, serial FROM serials WHERE location_id = ${count.locationId} AND status = 'in_stock' AND variant_id IN (SELECT value FROM json_each(${trackedJson}))`),
      seenAll.length ? db.all<{ serial: string; status: string; locationId: string | null }>(sql`SELECT serial, status, location_id AS locationId FROM serials WHERE upper(serial) IN (SELECT value FROM json_each(${JSON.stringify(seenAll)}))`) : Promise.resolve([]),
    ]);
    const known = new Map(seenRows.map((row) => [row.serial.toUpperCase(), row]));
    for (const line of trackedLines) {
      const expected = expectedRows.filter((row) => row.variantId === line.variantId).map((row) => row.serial.toUpperCase());
      const seen = normalizeSerials(line.serialsSeen ?? []);
      serialInfo.set(line.variantId, {
        seen,
        missing: line.countedQty === null ? [] : expected.filter((serial) => !seen.includes(serial)),
        unexpected: seen
          .filter((serial) => !expected.includes(serial))
          .map((serial) => {
            const row = known.get(serial);
            return { serial, status: row?.status ?? null, locationCode: row?.locationId ? (byId.get(row.locationId)?.code ?? null) : null };
          }),
      });
    }
  }

  // [P] value of the differences
  let layerQueues = new Map<string, { id: string; qtyRemaining: number; unitCostIqd: number }[]>();
  let standard = new Map<string, number | null>();
  if (withCost && lines.length > 0) {
    const [layerRows, standardRows] = await Promise.all([
      db.all<{ id: string; variantId: string; qtyRemaining: number; unitCostIqd: number }>(sql`
        SELECT id, variant_id AS variantId, qty_remaining AS qtyRemaining, unit_cost_iqd AS unitCostIqd FROM cost_layers
        WHERE location_id = ${count.locationId} AND qty_remaining > 0 AND variant_id IN (SELECT value FROM json_each(${json})) ORDER BY received_at, id`),
      db.all<{ variantId: string; landed: number | null }>(sql`SELECT variant_id AS variantId, landed_cost_iqd AS landed FROM variant_costs WHERE variant_id IN (SELECT value FROM json_each(${json}))`),
    ]);
    layerQueues = new Map();
    for (const row of layerRows) {
      const list = layerQueues.get(row.variantId) ?? [];
      list.push({ id: row.id, qtyRemaining: row.qtyRemaining, unitCostIqd: row.unitCostIqd });
      layerQueues.set(row.variantId, list);
    }
    standard = new Map(standardRows.map((row) => [row.variantId, row.landed]));
  }

  const lineViews: CountLineView[] = lines
    .map((line) => {
      const label = labels.get(line.variantId) ?? { id: line.variantId, sku: line.variantId, barcode: null, name: line.variantId, productName: line.variantId, variantTitle: "", trackSerials: false, isActive: false };
      const level = levels.get(line.variantId) ?? { onHand: 0, reserved: 0 };
      const difference = line.countedQty === null ? null : line.countedQty - line.expectedQty;
      const posted = isPosted(postings, line);
      // A posted difference is already in the stock: it cannot oversell any more.
      const oversell = !posted && difference !== null && difference < 0 && !label.trackSerials && level.onHand + difference - level.reserved < 0;
      const view: CountLineView = {
        id: line.id,
        variant: label,
        expected: showExpected ? line.expectedQty : null,
        counted: line.countedQty,
        difference: showExpected ? difference : null,
        note: line.reason,
        countedBy: line.countedBy ? (names.get(line.countedBy) ?? null) : null,
        countedAt: line.countedAt ?? null,
        tracked: label.trackSerials,
        onHandNow: showExpected ? level.onHand : null,
        reservedNow: showExpected ? level.reserved : null,
        oversell: showExpected && oversell,
        posted: showExpected && posted,
      };
      if (label.trackSerials && withSerials) view.serials = serialInfo.get(line.variantId);
      if (withCost && showExpected) view.valueIqd = differenceValue(difference, layerQueues.get(line.variantId) ?? [], standard.get(line.variantId) ?? null);
      return view;
    })
    .sort((a, b) => a.variant.sku.localeCompare(b.variant.sku));

  const counted = lineViews.filter((line) => line.counted !== null);
  const differences = counted.filter((line) => !line.tracked && (lines.find((row) => row.id === line.id)?.countedQty ?? 0) !== (lines.find((row) => row.id === line.id)?.expectedQty ?? 0));
  const serialDifferences = counted.filter((line) => line.tracked && line.serials && (line.serials.missing.length > 0 || line.serials.unexpected.length > 0));
  const raw = (line: CountLineView) => {
    const row = lines.find((candidate) => candidate.id === line.id);
    return row && row.countedQty !== null ? row.countedQty - row.expectedQty : 0;
  };
  const selfInvolved = await tookPart(db, actorRef(actor).actorId, count, lines);
  return {
    id: count.id,
    ref: count.ref,
    location: { id: count.locationId, code: node?.code ?? count.locationId, name: node?.name ?? "", path: node?.path ?? "" },
    scope: count.scope,
    status: count.status,
    notes: count.notes,
    startedBy: count.startedBy ? (names.get(count.startedBy) ?? null) : null,
    startedById: count.startedBy,
    approvedBy: count.approvedBy ? (names.get(count.approvedBy) ?? null) : null,
    createdAt: count.createdAt,
    submittedAt: count.submittedAt ?? null,
    approvedAt: count.approvedAt ?? null,
    showExpected,
    lines: lineViews,
    summary: {
      lines: lines.length,
      counted: counted.length,
      differences: showExpected ? differences.length : null,
      serialDifferences: showExpected ? serialDifferences.length : null,
      oversell: showExpected ? lineViews.filter((line) => line.oversell).length : null,
      unitsMissing: showExpected ? differences.reduce((sum, line) => sum + Math.max(0, -raw(line)), 0) : null,
      unitsFound: showExpected ? differences.reduce((sum, line) => sum + Math.max(0, raw(line)), 0) : null,
    },
    canApprove: can(actor, "inventory.count.approve") && can(actor, "inventory.stock.adjust") && !selfInvolved,
    selfInvolved,
    postedLines: count.status === "approved" ? 0 : postings.size,
  };
}

/**
 * [P] What a difference is worth: missing units at the FIFO cost of the oldest layers at the location (negative),
 * found units at the standard landed cost. Null when any unit's cost is unknown — never a made-up zero.
 */
export function differenceValue(difference: number | null, layers: readonly { id: string; qtyRemaining: number; unitCostIqd: number }[], standardCostIqd: number | null): number | null {
  if (difference === null || difference === 0) return 0;
  if (difference > 0) return standardCostIqd === null ? null : difference * standardCostIqd;
  const cost = costOfSlices(takeFifo(layers.map((layer) => ({ ...layer })), -difference, standardCostIqd));
  return cost === null ? null : -cost;
}

// ───────────────────────────────────────────────────────────────── approve, send back, cancel

export type ApproveResult = { posted: number; alreadyPosted: number; serialLines: number; replayed: boolean };

/** `locale`: the language of the reason written on each posted adjustment (the approver's admin language). */
export async function approveCount(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale = "ar"): Promise<ApproveResult> {
  assertCan(actor, "inventory.count.approve");
  assertCan(actor, "inventory.stock.adjust");
  const input = ApproveCountInput.parse(raw);
  const { actorId } = actorRef(actor);
  const { count, lines, location } = await loadCount(db, input.countId);
  if (count.status === "approved") return { posted: 0, alreadyPosted: 0, serialLines: 0, replayed: true };
  if (count.status !== "review") throw new AppError("count_not_in_review", 409, { detail: count.ref });
  assertBranch(actor, location.branchId);
  // Two people: whoever started or counted cannot approve — also after a colleague counted their lines again.
  if (await tookPart(db, actorId, count, lines)) throw new AppError("count_self_approval", 403);

  const variantIds = lines.map((line) => line.variantId);
  const [variantRows, levelRows, postings] = await Promise.all([
    db.all<{ id: string; trackSerials: number }>(sql`SELECT id, track_serials AS trackSerials FROM variants WHERE id IN (SELECT value FROM json_each(${JSON.stringify(variantIds)}))`),
    db.all<{ variantId: string; onHand: number; reserved: number }>(sql`SELECT variant_id AS variantId, on_hand AS onHand, reserved FROM stock_levels WHERE location_id = ${location.id} AND variant_id IN (SELECT value FROM json_each(${JSON.stringify(variantIds)}))`),
    postingsOf(db, count),
  ]);
  const tracked = new Map(variantRows.map((row) => [row.id, Boolean(row.trackSerials)]));
  const levels = new Map(levelRows.map((row) => [row.variantId, row]));
  const toPost = lines.filter((line) => line.countedQty !== null && !tracked.get(line.variantId) && line.countedQty !== line.expectedQty);
  const serialLines = lines.filter((line) => line.countedQty !== null && tracked.get(line.variantId)).length;

  // Check every difference against the stock as it is NOW, before anything is posted.
  let needsOversell = false;
  for (const line of toPost) {
    if (isPosted(postings, line)) continue;
    const delta = (line.countedQty as number) - line.expectedQty;
    const level = levels.get(line.variantId) ?? { onHand: 0, reserved: 0 };
    if (level.onHand + delta < 0) throw new AppError("count_stock_changed", 409, { detail: line.variantId });
    if (delta < 0 && level.onHand + delta - level.reserved < 0) needsOversell = true;
  }
  if (needsOversell && (input.allowOversell !== true || !can(actor, "inventory.oversell.authorize"))) {
    if (input.allowOversell === true) throw forbidden("inventory.oversell.authorize");
    throw new AppError("count_oversell_needs_authorization", 409);
  }

  let postedNow = 0;
  for (const line of toPost) {
    if (isPosted(postings, line)) continue;
    const delta = (line.countedQty as number) - line.expectedQty;
    // A send-back, a cancel or a colleague's approval that landed meanwhile stops the posting here.
    const status = (await db.select({ status: cycleCounts.status }).from(cycleCounts).where(eq(cycleCounts.id, count.id)).limit(1))[0]?.status;
    if (status === "approved") return { posted: postedNow, alreadyPosted: toPost.length - postedNow, serialLines, replayed: true };
    if (status !== "review") throw new AppError("count_not_in_review", 409, { detail: count.ref });
    // One claim per counting of the line: a recount after a send-back is a new difference to post.
    const claim = `inv-count:${line.id}:${line.countedAt ?? 0}`;
    if (!(await claimOnce(db, claim, 0))) continue;
    try {
      await adjustStock(
        db,
        actor,
        {
          variantId: line.variantId,
          locationId: location.id,
          delta,
          kind: "adjust",
          reason: serverT(locale, "admin-inventory")("count.postReason", { ref: count.ref, line: line.id, counted: line.countedQty as number, expected: line.expectedQty, reason: input.reason }).slice(0, 500),
          allowOversell: input.allowOversell === true ? true : undefined,
        },
        now,
      );
      postedNow++;
    } catch (error) {
      await resetRateLimit(db, claim);
      throw error;
    }
  }

  try {
    await runBatch(db, [
      db.update(cycleCounts).set({ status: "approved", approvedBy: actorId, approvedAt: now }).where(and(eq(cycleCounts.id, count.id), eq(cycleCounts.status, "review"))),
      expectChanged(db, 1, { code: "COUNT_CHANGED", detail: count.id }),
      auditStatement(db, {
        actor,
        action: "inventory.count.approve",
        entityType: "cycle_count",
        entityId: count.id,
        summary: `${count.ref} · ${location.code}`,
        before: { status: "review" },
        after: { status: "approved", differencesPosted: postedNow, postedBefore: toPost.length - postedNow, serialLinesNotPosted: serialLines, oversell: needsOversell },
        reason: input.reason,
        at: now,
      }),
    ]);
  } catch (error) {
    if (!isDbError(error, "COUNT_CHANGED")) throw error;
    // A colleague's approval got there first (a repeat); anything else (sent back, cancelled) is not an approval.
    const status = (await db.select({ status: cycleCounts.status }).from(cycleCounts).where(eq(cycleCounts.id, count.id)).limit(1))[0]?.status;
    if (status === "approved") return { posted: postedNow, alreadyPosted: toPost.length - postedNow, serialLines, replayed: true };
    throw new AppError("count_not_in_review", 409, { detail: count.ref, cause: error });
  }
  return { posted: postedNow, alreadyPosted: toPost.length - postedNow, serialLines, replayed: false };
}

/** Sends a count back for a recount (review → counting). Needs inventory.count.approve and a reason. */
export async function sendBackCount(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "inventory.count.approve");
  const input = CountReasonInput.parse(raw);
  const { count, location } = await loadCount(db, input.countId);
  if (count.status === "counting") return { replayed: true };
  if (count.status !== "review") throw new AppError("count_not_in_review", 409, { detail: count.ref });
  assertBranch(actor, location.branchId);
  await runBatch(db, [
    db.update(cycleCounts).set({ status: "counting", submittedAt: null }).where(and(eq(cycleCounts.id, count.id), eq(cycleCounts.status, "review"))),
    expectChanged(db, 1, { code: "COUNT_CHANGED", detail: count.id }),
    auditStatement(db, { actor, action: "inventory.count.send_back", entityType: "cycle_count", entityId: count.id, summary: count.ref, before: { status: "review" }, after: { status: "counting" }, reason: input.reason, at: now }),
  ]);
  return { replayed: false };
}

/**
 * Cancels an open count — only while none of its differences is posted (a cancelled count posts nothing).
 * Needs inventory.count.perform or inventory.count.approve, and a reason. A count whose approval stopped half way is
 * refused (count_partially_posted), also when that posting lands just before the cancel is written.
 */
export async function cancelCount(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  if (!can(actor, "inventory.count.perform") && !can(actor, "inventory.count.approve")) throw forbidden("inventory.count.perform");
  const input = CountReasonInput.parse(raw);
  const { count, location } = await loadCount(db, input.countId);
  if (count.status === "cancelled") return { replayed: true };
  if (count.status !== "counting" && count.status !== "review" && count.status !== "draft") throw new AppError("count_not_open", 409, { detail: count.ref });
  assertBranch(actor, location.branchId);
  const partiallyPosted = () => new AppError("count_partially_posted", 409, { detail: count.ref });
  if ((await postingsOf(db, count)).size > 0) throw partiallyPosted();
  try {
    await runBatch(db, [
      db.update(cycleCounts).set({ status: "cancelled" }).where(and(eq(cycleCounts.id, count.id), inArray(cycleCounts.status, ["draft", "counting", "review"]))),
      expectChanged(db, 1, { code: "COUNT_CHANGED", detail: count.id }),
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM stock_movements WHERE ${postingsWhere(count)})`, { code: "COUNT_POSTED", detail: count.id }),
      auditStatement(db, { actor, action: "inventory.count.cancel", entityType: "cycle_count", entityId: count.id, summary: count.ref, before: { status: count.status }, after: { status: "cancelled" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "COUNT_POSTED")) throw partiallyPosted();
    if (isDbError(error, "COUNT_CHANGED")) throw new AppError("count_not_open", 409, { detail: count.ref, cause: error });
    throw error;
  }
  return { replayed: false };
}

// ───────────────────────────────────────────────────────────────── list

export const COUNT_STATUS_FILTERS = ["open", "review", "approved", "cancelled", "all"] as const;
export type CountStatusFilter = (typeof COUNT_STATUS_FILTERS)[number];
/** `differences` is null while the count is blind for this employee (being counted, and they may not approve counts). */
export type CountListRow = { id: string; ref: string; locationCode: string; locationName: string; scope: "full" | "partial"; status: CountRow["status"]; lines: number; counted: number; differences: number | null; startedBy: string | null; createdAt: number; approvedBy: string | null; approvedAt: number | null };

export function parseCountFilters(params: URLSearchParams): { status: CountStatusFilter; location: string | null; page: number } {
  const status = params.get("status") as CountStatusFilter | null;
  return {
    status: status && COUNT_STATUS_FILTERS.includes(status) ? status : "open",
    location: params.get("location")?.match(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/) ? params.get("location") : null,
    page: pageOf(params.get("page")),
  };
}

export async function listCounts(db: Db, actor: Actor, filters: { status: CountStatusFilter; location: string | null; page: number }): Promise<{ rows: CountListRow[]; total: number; page: number; pageCount: number }> {
  assertCan(actor, "inventory.stock.read");
  const parts = [] as ReturnType<typeof sql>[];
  if (filters.status === "open") parts.push(sql`c.status IN ('draft', 'counting', 'review')`);
  else if (filters.status !== "all") parts.push(sql`c.status = ${filters.status}`);
  if (filters.location) parts.push(sql`c.location_id = ${filters.location}`);
  const where = parts.length ? sql.join(parts, sql` AND `) : sql`1 = 1`;
  const [rows, totals, tree] = await Promise.all([
    db.all<{ id: string; ref: string; locationId: string; scope: "full" | "partial"; status: CountRow["status"]; lines: number; counted: number; differences: number; startedBy: string | null; createdAt: number; approvedBy: string | null; approvedAt: number | null }>(sql`
      SELECT c.id AS id, c.ref AS ref, c.location_id AS locationId, c.scope AS scope, c.status AS status,
             (SELECT count(*) FROM cycle_count_lines AS l WHERE l.count_id = c.id) AS lines,
             (SELECT count(*) FROM cycle_count_lines AS l WHERE l.count_id = c.id AND l.counted_qty IS NOT NULL) AS counted,
             (SELECT count(*) FROM cycle_count_lines AS l WHERE l.count_id = c.id AND l.counted_qty IS NOT NULL AND l.counted_qty <> l.expected_qty) AS differences,
             c.started_by AS startedBy, c.created_at AS createdAt, c.approved_by AS approvedBy, c.approved_at AS approvedAt
      FROM cycle_counts AS c WHERE ${where} ORDER BY c.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${(filters.page - 1) * PAGE_SIZE}`),
    db.all<{ n: number }>(sql`SELECT count(*) AS n FROM cycle_counts AS c WHERE ${where}`),
    locationTree(db),
  ]);
  const names = await employeeNames(db, rows.flatMap((row) => [row.startedBy, row.approvedBy]));
  const byId = new Map(tree.map((node) => [node.id, node]));
  const total = Number(totals[0]?.n ?? 0);
  // Blind counting, as on the count's page: how many lines differ would let a counter count to the system's figure.
  const approver = can(actor, "inventory.count.approve");
  return {
    rows: rows.map((row) => ({
      ...row,
      lines: Number(row.lines),
      counted: Number(row.counted),
      differences: approver || (row.status !== "counting" && row.status !== "draft") ? Number(row.differences) : null,
      locationCode: byId.get(row.locationId)?.code ?? row.locationId,
      locationName: byId.get(row.locationId)?.name ?? "",
      startedBy: row.startedBy ? (names.get(row.startedBy) ?? null) : null,
      approvedBy: row.approvedBy ? (names.get(row.approvedBy) ?? null) : null,
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}
