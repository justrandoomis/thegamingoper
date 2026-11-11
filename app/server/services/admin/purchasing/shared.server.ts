/**
 * Admin module 09 (purchasing) — helpers shared by its services: who may do what (field access), ids derived from
 * idempotency keys, SKU / barcode lookup, locations with the branch limit, form-value schemas, and the names a view
 * needs. Reads only; [P] cost data is never selected here.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { sha256Hex } from "~/lib/ids";
import type { Locale } from "~/lib/locales";
import { assertBranch, can, canAny, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { AppError, forbidden, notFound } from "~/server/errors";
import { PERMISSIONS, PERMISSION_DEFS, type Permission } from "~/server/permissions";
import { employeeNames, labelOf, type VariantLabel } from "../inventory/shared.server";

export { employeeNames, type VariantLabel };

/** Every permission of the purchasing group: any one of them opens the module. */
export const PURCHASING_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter((permission) => PERMISSION_DEFS[permission].group === "purchasing");

export function canUsePurchasing(actor: Actor): boolean {
  return canAny(actor, PURCHASING_PERMISSIONS);
}

export function assertPurchasing(actor: Actor): void {
  if (!canUsePurchasing(actor)) throw forbidden(PURCHASING_PERMISSIONS[0]);
}

/** What the purchasing pages may show or offer this actor (hints for the UI — the services check again). */
export type PurchasingAccess = {
  supplierRead: boolean;
  supplierManage: boolean;
  supplierRate: boolean;
  rfq: boolean;
  poRead: boolean;
  poCreate: boolean;
  poApprove: boolean;
  receive: boolean;
  invoice: boolean;
  landed: boolean;
  claim: boolean;
  /** [P] supplier prices, order totals, landed cost (field-level). */
  cost: boolean;
  /** Stock may leave through adjustStock (returns to the supplier). */
  adjust: boolean;
  serials: boolean;
  stock: boolean;
};

export function purchasingAccess(actor: Actor): PurchasingAccess {
  const cost = can(actor, "cost.read");
  return {
    supplierRead: can(actor, "purchasing.supplier.read"),
    supplierManage: can(actor, "purchasing.supplier.manage"),
    supplierRate: can(actor, "purchasing.supplier.rate"),
    rfq: can(actor, "purchasing.rfq.manage"),
    poRead: can(actor, "purchasing.po.read"),
    poCreate: can(actor, "purchasing.po.create"),
    poApprove: can(actor, "purchasing.po.approve"),
    receive: can(actor, "purchasing.receipt.create"),
    invoice: can(actor, "purchasing.invoice.manage") && cost,
    landed: can(actor, "purchasing.landed_cost.allocate") && cost,
    claim: can(actor, "purchasing.claim.manage"),
    cost,
    adjust: can(actor, "inventory.stock.adjust"),
    serials: can(actor, "inventory.serial.read"),
    stock: can(actor, "inventory.stock.read"),
  };
}

/** Throws 403 unless the actor holds every permission (the first missing one is named). */
export function assertAll(actor: Actor, permissions: readonly Permission[]): void {
  for (const permission of permissions) if (!can(actor, permission)) throw forbidden(permission);
}

export const actorId = (actor: Actor): string | null => (actor.kind === "employee" || actor.kind === "customer" ? actor.id : actor.kind === "system" ? `system:${actor.job}` : null);

// ───────────────────────────────────────────────────────────────── form values

export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const idField = z.string({ error: "required" }).trim().min(1, "required").regex(ID_PATTERN, "invalid");
export const keyField = z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid");
export const reasonField = z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long");
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, "too_long")
    .optional()
    .transform((value) => (value ? value : null));

/** A record id derived from (who, form key): a double submit of one form finds the first row instead of a second. */
export async function idFromKey(prefix: string, actor: Actor, key: string): Promise<string> {
  return `${prefix}_${(await sha256Hex(`${actorId(actor) ?? "anonymous"}:${prefix}:${key}`)).slice(0, 26)}`;
}

// ───────────────────────────────────────────────────────────────── variants by code

export type PurchasableVariant = VariantLabel & { isBundle: boolean };

/**
 * Variants for typed or scanned codes: a SKU (any letter case), a barcode, or a variant id. Returns each code's
 * variant (by the code as typed, trimmed) and the codes nothing matched.
 */
export async function resolveVariantCodes(db: Db, codes: readonly string[], locale: Locale): Promise<{ found: Map<string, PurchasableVariant>; unknown: string[] }> {
  const typed = [...new Set(codes.map((code) => code.trim()).filter(Boolean))].slice(0, 500);
  const found = new Map<string, PurchasableVariant>();
  if (typed.length === 0) return { found, unknown: [] };
  const rows = await db.all<{ id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number; isBundle: number }>(sql`
    SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive,
           EXISTS (SELECT 1 FROM bundle_items AS b WHERE b.bundle_variant_id = v.id) AS isBundle
    FROM variants AS v JOIN products AS p ON p.id = v.product_id
    WHERE upper(v.sku) IN (SELECT upper(value) FROM json_each(${JSON.stringify(typed)}))
       OR v.barcode IN (SELECT value FROM json_each(${JSON.stringify(typed)}))
       OR v.id IN (SELECT value FROM json_each(${JSON.stringify(typed)}))`);
  for (const code of typed) {
    const upper = code.toUpperCase();
    const row = rows.find((candidate) => candidate.id === code) ?? rows.find((candidate) => candidate.sku.toUpperCase() === upper) ?? rows.find((candidate) => candidate.barcode === code);
    if (row) found.set(code, { ...labelOf(row, locale), isBundle: Boolean(row.isBundle) });
  }
  return { found, unknown: typed.filter((code) => !found.has(code)) };
}

/** Labels of variants by id (product name, title, SKU), in the admin's language. */
export async function variantsById(db: Db, ids: readonly string[], locale: Locale): Promise<Map<string, VariantLabel>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, VariantLabel>();
  if (unique.length === 0) return out;
  const rows = await db.all<{ id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number }>(sql`
    SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive
    FROM variants AS v JOIN products AS p ON p.id = v.product_id
    WHERE v.id IN (SELECT value FROM json_each(${JSON.stringify(unique)}))`);
  for (const row of rows) out.set(row.id, labelOf(row, locale));
  return out;
}

// ───────────────────────────────────────────────────────────────── locations and branches

export type LocationFacts = { id: string; code: string; name: string; branchId: string | null; isActive: boolean };

/** A location the actor may receive at or ship from: it exists, is active and is in their branch (403 otherwise). */
export async function usableLocation(db: Db, actor: Actor, locationId: string | null | undefined, field = "locationId"): Promise<LocationFacts> {
  if (!locationId) throw new AppError("location_invalid", 409, { fields: { [field]: "required" } });
  const rows = await db.all<{ id: string; code: string; name: string; branchId: string | null; isActive: number }>(sql`
    SELECT id, code, name, branch_id AS branchId, is_active AS isActive FROM inventory_locations WHERE id = ${locationId}`);
  const row = rows[0];
  if (!row || !row.isActive) throw new AppError("location_invalid", 409, { fields: { [field]: "location_invalid" } });
  assertBranch(actor, row.branchId);
  return { id: row.id, code: row.code, name: row.name, branchId: row.branchId, isActive: Boolean(row.isActive) };
}

/** SQL condition limiting rows to the employee's branch through a location column (true for everyone else). */
export function branchCondition(actor: Actor, locationColumn: SQL): SQL {
  if (actor.kind !== "employee" || !actor.branchId) return sql`1 = 1`;
  return sql`${locationColumn} IN (SELECT id FROM inventory_locations WHERE branch_id = ${actor.branchId})`;
}

/** The branch of a location (null = no branch). */
export async function branchOfLocation(db: Db, locationId: string | null): Promise<string | null> {
  if (!locationId) return null;
  const rows = await db.all<{ branchId: string | null }>(sql`SELECT branch_id AS branchId FROM inventory_locations WHERE id = ${locationId}`);
  return rows[0]?.branchId ?? null;
}

/** 404 unless the record exists; for records kept at a location, 403 outside the employee's branch. */
export async function assertRecordBranch(db: Db, actor: Actor, locationId: string | null): Promise<void> {
  if (actor.kind !== "employee" || !actor.branchId) return;
  assertBranch(actor, await branchOfLocation(db, locationId));
}

export function mustExist<T>(row: T | undefined | null, what: string): T {
  if (row === undefined || row === null) throw notFound(what);
  return row;
}

// ───────────────────────────────────────────────────────────────── text search, paging

export const PAGE_SIZE = 25;

export function pageOf(value: string | null | undefined): number {
  const page = Number.parseInt(value ?? "1", 10);
  return Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
}

export function cleanQuery(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
}

/** A LIKE pattern (use with ESCAPE '\'); D1 refuses long patterns, so the text is kept short. */
export function likePattern(q: string): string {
  return `%${q.trim().slice(0, 40).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** Recent audit events of one record: who did what, when and why (the module's own history panels). */
export type HistoryEntry = { at: number; action: string; actor: string | null; reason: string | null; summary: string | null };

export async function historyOf(db: Db, entityType: string, entityId: string, limit = 30): Promise<HistoryEntry[]> {
  const rows = await db.all<{ at: number; action: string; actorKind: string; actorId: string | null; actorLabel: string | null; reason: string | null; summary: string | null }>(sql`
    SELECT at, action, actor_kind AS actorKind, actor_id AS actorId, actor_label AS actorLabel, reason, summary
    FROM audit_events WHERE entity_type = ${entityType} AND entity_id = ${entityId} ORDER BY seq DESC LIMIT ${Math.max(1, Math.min(limit, 100))}`);
  const names = await employeeNames(db, rows.filter((row) => row.actorKind === "employee").map((row) => row.actorId));
  return rows.map((row) => ({
    at: row.at,
    action: row.action,
    actor: row.actorKind === "employee" ? ((row.actorId && names.get(row.actorId)) ?? row.actorLabel ?? null) : row.actorKind === "system" ? (row.actorId ?? "system") : null,
    reason: row.reason,
    summary: row.summary,
  }));
}
