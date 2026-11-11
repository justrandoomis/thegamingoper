/**
 * Admin module 04 — receiving goods into a location with inspection, counting and barcode / QR / serial scanning
 * (04.03), and the scan lookup the module's scan fields share.
 *
 *   const hit = await lookupCode(db, actor, "0711719577294", locale);           // a SKU, a barcode, a serial or a location
 *   const line = await receiveLine(db, actor, { sessionRef, locationId, variantId, counted: 10, rejected: 1, rejectReason, serials, reference, idempotencyKey }, now);
 *
 * One line = one call of the commerce core's receiveStock (on_hand += accepted, a FIFO cost layer, one serial row per
 * unit for tracked items, 'receive' movements, an audit event — one batch). The lines of one delivery share a
 * receiving session reference ("RCV-…", the movements' ref_id with ref_type 'stock_receipt'), so a delivery is
 * shown and traced as one. Inspection: counted = accepted + rejected; rejected units never enter stock and are
 * recorded with their reason in the module's own audit event (inventory.receipt.inspect).
 *
 * Cost [P]: an employee with cost.read types the landed unit cost (the page offers the variant's standard landed
 * cost). For everyone else the server uses that standard landed cost without showing it; when the variant has none,
 * the line is refused with `cost_unknown` (someone with cost access must receive it) — a unit is never received at
 * an invented zero cost.
 *
 * Double submit: each submission carries an idempotency key, claimed once (claimOnce) before the core is called; a
 * repeat answers `replayed: true`. An attempt that received nothing releases its claim so the same key can be
 * retried; once the units are in, the claim stays even if the inspection record fails afterwards.
 *
 * Serial numbers: one row per physical unit whatever the letter case — a number already registered in other letters
 * is refused (`serial_duplicate`) before anything moves (blueprint acceptance #1).
 *
 * Purchase-order receipts (partial receiving against a PO, invoice matching, landed-cost allocation) belong to the
 * purchasing module (09). Receipts made here are not posted to the books (receiveStock does not post; see
 * docs/areas/admin-inventory.md "Boundaries").
 */
import { sql } from "drizzle-orm";
import { z } from "zod";
import { serverT } from "~/i18n/i18n.server";
import { publicRef } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { actorRef, assertBranch, assertCan, can, type Actor } from "~/server/actor";
import { audit } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { claimOnce, resetRateLimit } from "~/server/ratelimit.server";
import { receiveStock } from "~/server/services/inventory/stock.server";
import { idempotencyKeySchema } from "~/server/services/inventory/transfers.server";
import { employeeNames, labelOf, locationTree, variantLabels, type LocationNode, type VariantLabel } from "./shared.server";

export const RECEIVING_ERROR_KEYS = ["cost_unknown", "rejected_exceeds", "reject_reason_required", "nothing_to_receive", "replayed"] as const;

const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid");
export const SESSION_REF = /^RCV-[2-9A-HJ-NP-Z]{8}$/;

/** A new receiving session reference for a delivery. */
export function newReceivingSession(): string {
  return publicRef("RCV");
}

// ───────────────────────────────────────────────────────────────── scan lookup

export type ScanHit =
  | { kind: "variant"; variant: VariantLabel; matchedBy: "sku" | "barcode" }
  | { kind: "serial"; serialId: string; serial: string; status: string; variant: VariantLabel; locationId: string | null; locationCode: string | null }
  | { kind: "serial_hidden" }
  | { kind: "location"; location: Pick<LocationNode, "id" | "code" | "name" | "path" | "level" | "isActive"> }
  | { kind: "none" };

/**
 * What a scanned or typed code is: a variant (by SKU, case-insensitive, or by barcode), a serial number (details only
 * with inventory.serial.read — otherwise just "this is a registered serial"), or a storage location (by barcode or
 * code). Needs inventory.stock.read.
 */
export async function lookupCode(db: Db, actor: Actor, raw: unknown, locale: Locale): Promise<ScanHit> {
  assertCan(actor, "inventory.stock.read");
  const code = typeof raw === "string" ? raw.trim().slice(0, 100) : "";
  if (!code) return { kind: "none" };
  const variantRows = await db.all<{ id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number }>(sql`
    SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive
    FROM variants AS v JOIN products AS p ON p.id = v.product_id
    WHERE upper(v.sku) = upper(${code}) OR v.barcode = ${code}
    ORDER BY CASE WHEN upper(v.sku) = upper(${code}) THEN 0 ELSE 1 END LIMIT 1`);
  if (variantRows[0]) return { kind: "variant", variant: labelOf(variantRows[0], locale), matchedBy: variantRows[0].sku.toUpperCase() === code.toUpperCase() ? "sku" : "barcode" };

  const serialRows = await db.all<{ id: string; serial: string; status: string; locationId: string | null; variantId: string }>(sql`
    SELECT id, serial, status, location_id AS locationId, variant_id AS variantId FROM serials WHERE upper(serial) = upper(${code}) LIMIT 1`);
  if (serialRows[0]) {
    if (!can(actor, "inventory.serial.read")) return { kind: "serial_hidden" };
    const serial = serialRows[0];
    const [variant] = await db.all<{ id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number }>(sql`
      SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive
      FROM variants AS v JOIN products AS p ON p.id = v.product_id WHERE v.id = ${serial.variantId}`);
    const tree = serial.locationId ? await locationTree(db) : [];
    return {
      kind: "serial",
      serialId: serial.id,
      serial: serial.serial,
      status: serial.status,
      variant: labelOf(variant, locale),
      locationId: serial.locationId,
      locationCode: serial.locationId ? (tree.find((node) => node.id === serial.locationId)?.code ?? null) : null,
    };
  }

  const tree = await locationTree(db);
  const location = tree.find((node) => node.barcode === code || node.code === code.toUpperCase());
  if (location) return { kind: "location", location: { id: location.id, code: location.code, name: location.name, path: location.path, level: location.level, isActive: location.isActive } };
  return { kind: "none" };
}

// ───────────────────────────────────────────────────────────────── receive one line

export const ReceiveLineInput = z
  .object({
    sessionRef: z.string().regex(SESSION_REF, "invalid"),
    locationId: idSchema,
    variantId: idSchema,
    /** Units counted off the delivery. */
    counted: z.number().int("invalid").min(1, "too_small").max(100_000, "too_big"),
    /** Of those, units refused at inspection (damaged, wrong item…): they do not enter stock. */
    rejected: z.number().int("invalid").min(0, "too_small").max(100_000, "too_big").default(0),
    rejectReason: z.string().trim().max(300, "too_long").optional(),
    /** One serial number per ACCEPTED unit, for serial-tracked items. */
    serials: z.array(z.string().trim().min(1, "required").max(100, "too_long")).max(100_000).optional(),
    /** [P] Landed cost per unit — taken only from employees with cost.read. */
    unitCostIqd: z.number().int("invalid").min(0, "too_small").max(1_000_000_000, "too_big").optional(),
    /** The supplier's delivery note, invoice or any document reference. */
    reference: z.string().trim().max(120, "too_long").optional(),
    note: z.string().trim().max(300, "too_long").optional(),
    idempotencyKey: idempotencyKeySchema,
  })
  .refine((value) => value.rejected <= value.counted, { path: ["rejected"], message: "rejected_exceeds" })
  .refine((value) => value.rejected === 0 || (value.rejectReason ?? "").length >= 3, { path: ["rejectReason"], message: "reject_reason_required" });
export type ReceiveLineInput = z.input<typeof ReceiveLineInput>;

export type ReceiveLineResult = { accepted: number; rejected: number; replayed: boolean };

/** `locale`: the language of the reason written on the movement (the employee's admin language). */
export async function receiveLine(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale = "ar"): Promise<ReceiveLineResult> {
  assertCan(actor, "inventory.stock.receive");
  const input = ReceiveLineInput.parse(raw);
  const accepted = input.counted - input.rejected;

  const [variantRows, locationRows, standardRows] = await Promise.all([
    db.all<{ id: string; trackSerials: number }>(sql`SELECT id, track_serials AS trackSerials FROM variants WHERE id = ${input.variantId}`),
    db.all<{ id: string; code: string; isActive: number; branchId: string | null }>(sql`SELECT id, code, is_active AS isActive, branch_id AS branchId FROM inventory_locations WHERE id = ${input.locationId}`),
    db.all<{ landed: number | null }>(sql`SELECT landed_cost_iqd AS landed FROM variant_costs WHERE variant_id = ${input.variantId}`),
  ]);
  if (!variantRows[0]) throw notFound("variant");
  const location = locationRows[0];
  if (!location || !location.isActive) throw new AppError("location_invalid", 409, { fields: { locationId: "location_invalid" } });
  assertBranch(actor, location.branchId);
  const tracked = Boolean(variantRows[0].trackSerials);
  const serialNumbers = (input.serials ?? []).filter((value) => value.length > 0);
  if (tracked && accepted > 0 && serialNumbers.length !== accepted) throw invalid({ serials: serialNumbers.length === 0 ? "serials_required" : "serials_count" });
  if (!tracked && serialNumbers.length > 0) throw invalid({ serials: "serials_not_tracked" });
  if (tracked && accepted > 0) {
    // One physical unit, one serial row: scans and lookups ignore letter case, the database's unique index does not,
    // so a number already registered in other letters ("sn-1" for "SN-1") is refused here — never a second unit.
    const upper = [...new Set(serialNumbers.map((value) => value.toUpperCase()))];
    const taken = await db.all<{ id: string }>(sql`SELECT id FROM serials WHERE upper(serial) IN (SELECT value FROM json_each(${JSON.stringify(upper)})) LIMIT 1`);
    if (taken.length > 0) throw new AppError("serial_duplicate", 409, { fields: { serials: "serial_duplicate" } });
  }

  // [P] The cost: typed by someone who may see costs, else the standard landed cost, else refused.
  let unitCostIqd: number | null = null;
  if (accepted > 0) {
    if (input.unitCostIqd !== undefined && can(actor, "cost.read")) unitCostIqd = input.unitCostIqd;
    else unitCostIqd = standardRows[0]?.landed ?? null;
    if (unitCostIqd === null) throw new AppError("cost_unknown", 409, { fields: can(actor, "cost.read") ? { unitCostIqd: "cost_unknown" } : undefined });
  }

  const { actorId } = actorRef(actor);
  const claim = `inv-receive:${actorId ?? "system"}:${input.idempotencyKey}`;
  if (!(await claimOnce(db, claim, 0))) return { accepted: 0, rejected: 0, replayed: true };
  const t = serverT(locale, "admin-inventory");
  const inspection = input.rejected > 0 ? t("receive.reasonInspection", { counted: input.counted, rejected: input.rejected, reason: input.rejectReason ?? "" }) : null;
  const reasonParts = [input.sessionRef, input.reference ? `#${input.reference}` : null, inspection, input.note || null].filter(Boolean);
  const reason = reasonParts.join(" · ").slice(0, 500);
  try {
    if (accepted > 0) {
      await receiveStock(
        db,
        actor,
        { variantId: input.variantId, locationId: input.locationId, qty: accepted, unitCostIqd: unitCostIqd as number, serials: tracked ? serialNumbers : undefined, ref: { type: "stock_receipt", id: input.sessionRef }, reason },
        now,
      );
    }
  } catch (error) {
    // Nothing was received: the same submission may be tried again.
    await resetRateLimit(db, claim);
    throw error;
  }
  // The units are in from here on. Should the inspection record fail, the claim stays: sending the same form again
  // answers "replayed" instead of receiving the units a second time (the movements carry the session reference).
  await audit(db, {
    actor,
    action: "inventory.receipt.inspect",
    entityType: "stock_receipt",
    entityId: input.sessionRef,
    summary: `${input.sessionRef} · ${location.code}`,
    after: { sessionRef: input.sessionRef, locationId: input.locationId, variantId: input.variantId, counted: input.counted, accepted, rejected: input.rejected, rejectReason: input.rejectReason ?? null, reference: input.reference ?? null, serials: serialNumbers.length },
    reason: input.rejected > 0 ? (input.rejectReason ?? null) : (input.note ?? null),
    at: now,
  });
  return { accepted, rejected: input.rejected, replayed: false };
}

// ───────────────────────────────────────────────────────────────── what a session holds

export type ReceivedLine = { variant: VariantLabel | null; variantId: string; locationCode: string; counted: number; accepted: number; rejected: number; rejectReason: string | null; reference: string | null; serials: number; at: number; by: string | null };
export type ReceivingSession = { ref: string; lines: ReceivedLine[]; accepted: number; rejected: number; startedAt: number | null };

/** The lines received in one session (from the module's inspection events — one per line). */
export async function getReceivingSession(db: Db, actor: Actor, sessionRef: string, locale: Locale): Promise<ReceivingSession> {
  assertCan(actor, "inventory.stock.read");
  if (!SESSION_REF.test(sessionRef)) return { ref: sessionRef, lines: [], accepted: 0, rejected: 0, startedAt: null };
  const rows = await db.all<{ at: number; after: string | null; actorId: string | null }>(sql`
    SELECT at, after, actor_id AS actorId FROM audit_events WHERE action = 'inventory.receipt.inspect' AND entity_id = ${sessionRef} ORDER BY seq`);
  return sessionFromEvents(db, sessionRef, rows, locale);
}

async function sessionFromEvents(db: Db, ref: string, rows: readonly { at: number; after: string | null; actorId: string | null }[], locale: Locale): Promise<ReceivingSession> {
  type After = { locationId?: string; variantId?: string; counted?: number; accepted?: number; rejected?: number; rejectReason?: string | null; reference?: string | null; serials?: number };
  const parsed = rows.map((row) => {
    let after: After = {};
    try {
      after = row.after ? (JSON.parse(row.after) as After) : {};
    } catch {
      after = {};
    }
    return { ...row, after };
  });
  const [tree, names, labels] = await Promise.all([locationTree(db), employeeNames(db, parsed.map((row) => row.actorId)), variantLabels(db, parsed.map((row) => row.after.variantId ?? ""), locale)]);
  const lines: ReceivedLine[] = parsed.map((row) => ({
    variant: labels.get(row.after.variantId ?? "") ?? null,
    variantId: row.after.variantId ?? "",
    locationCode: tree.find((node) => node.id === row.after.locationId)?.code ?? "—",
    counted: Number(row.after.counted ?? 0),
    accepted: Number(row.after.accepted ?? 0),
    rejected: Number(row.after.rejected ?? 0),
    rejectReason: row.after.rejectReason ?? null,
    reference: row.after.reference ?? null,
    serials: Number(row.after.serials ?? 0),
    at: row.at,
    by: row.actorId ? (names.get(row.actorId) ?? null) : null,
  }));
  return { ref, lines, accepted: lines.reduce((sum, line) => sum + line.accepted, 0), rejected: lines.reduce((sum, line) => sum + line.rejected, 0), startedAt: lines[0]?.at ?? null };
}

/** The latest receiving sessions, newest first. */
export async function listReceivingSessions(db: Db, actor: Actor, locale: Locale, limit = 20): Promise<ReceivingSession[]> {
  assertCan(actor, "inventory.stock.read");
  const refs = await db.all<{ ref: string }>(sql`
    SELECT entity_id AS ref FROM audit_events WHERE action = 'inventory.receipt.inspect' AND entity_id IS NOT NULL
    GROUP BY entity_id ORDER BY max(seq) DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`);
  if (refs.length === 0) return [];
  const rows = await db.all<{ ref: string; at: number; after: string | null; actorId: string | null }>(sql`
    SELECT entity_id AS ref, at, after, actor_id AS actorId FROM audit_events
    WHERE action = 'inventory.receipt.inspect' AND entity_id IN (SELECT value FROM json_each(${JSON.stringify(refs.map((row) => row.ref))})) ORDER BY seq`);
  const out: ReceivingSession[] = [];
  for (const { ref } of refs) out.push(await sessionFromEvents(db, ref, rows.filter((row) => row.ref === ref), locale));
  return out;
}

/** The standard landed cost the receiving form may prefill — [P], only for cost.read. */
export async function standardCostFor(db: Db, actor: Actor, variantId: string): Promise<number | null> {
  if (!can(actor, "cost.read")) throw forbidden("cost.read");
  const rows = await db.all<{ landed: number | null }>(sql`SELECT landed_cost_iqd AS landed FROM variant_costs WHERE variant_id = ${variantId}`);
  return rows[0]?.landed ?? null;
}
