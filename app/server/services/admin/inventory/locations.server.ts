/**
 * Admin module 04 — warehouses, shops and the aisles, shelves and bins inside them, with storage-location barcodes
 * (04.02).
 *
 *   const tree = await listLocations(db, actor);
 *   const { locationId } = await createLocation(db, actor, { kind: "bin", parentId, code: "MAIN-A01", name: "الممر A" }, now);
 *   await updateLocation(db, actor, { locationId, name, isSellable: false }, now);
 *
 * Model (inventory_locations): a top-level location is a warehouse or a shop (`kind` warehouse | store); everything
 * inside it is kind 'bin', and its level comes from its depth — directly inside a warehouse or shop it is an aisle,
 * inside an aisle a shelf, inside a shelf a bin (three levels at most). Stock can sit at any of them; a transfer
 * moves it between them (put-away is a transfer from the warehouse to a bin).
 *
 * Rules: codes are unique, upper-case Latin letters, digits, "-", "_" and "." (they are printed and scanned) and never
 * change once created (labels and history refer to them); the barcode defaults to the code and is unique too. A
 * location that holds stock, has stock promised to orders, is the destination of a transfer in transit, is being
 * counted or has active children cannot be switched off (`location_in_use`). Every change is audited with before
 * and after. Needs inventory.location.manage; reading needs inventory.stock.read.
 */
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { assertBranch, assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { branches, inventoryLocations } from "~/server/db/schema";
import { expectThat, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { MAX_LOCATION_DEPTH, locationTree, type LocationNode } from "./shared.server";

export const LOCATION_ERROR_KEYS = ["location_in_use", "location_too_deep", "location_parent_invalid", "location_code_invalid", "code_taken", "barcode_taken"] as const;

const CODE = /^[A-Z0-9][A-Z0-9._-]{1,31}$/;
const idSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid");

export const CreateLocationInput = z.object({
  kind: z.enum(["warehouse", "store", "bin"]),
  /** Required for 'bin' (aisle, shelf or bin inside another location); not allowed for warehouses and shops. */
  parentId: idSchema.nullish(),
  code: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .pipe(z.string().regex(CODE, "location_code_invalid")),
  name: z.string().trim().min(1, "required").max(100, "too_long"),
  /** Defaults to the code. */
  barcode: z
    .string()
    .trim()
    .max(64, "too_long")
    .regex(/^[\x20-\x7e]*$/, "location_code_invalid")
    .optional(),
  isSellable: z.boolean().optional(),
  branchId: idSchema.nullish(),
  sort: z.number().int().min(0).max(100_000).optional(),
});
export type CreateLocationInput = z.input<typeof CreateLocationInput>;

export const UpdateLocationInput = z.object({
  locationId: idSchema,
  name: z.string().trim().min(1, "required").max(100, "too_long").optional(),
  barcode: z
    .string()
    .trim()
    .min(1, "required")
    .max(64, "too_long")
    .regex(/^[\x20-\x7e]*$/, "location_code_invalid")
    .optional(),
  isSellable: z.boolean().optional(),
  isActive: z.boolean().optional(),
  sort: z.number().int().min(0).max(100_000).optional(),
  /** Why (required when switching a location off or out of sale). */
  reason: z.string().trim().max(500, "too_long").optional(),
});
export type UpdateLocationInput = z.input<typeof UpdateLocationInput>;

export type LocationStats = { units: number; skus: number; reserved: number; inTransitTo: number; openCounts: number };
export type LocationListItem = LocationNode & LocationStats & { children: number; branchName: string | null };

/** Every location with what it holds. */
export async function listLocations(db: Db, actor: Actor): Promise<LocationListItem[]> {
  assertCan(actor, "inventory.stock.read");
  const [tree, stats, branchRows] = await Promise.all([locationTree(db), locationStats(db, null), db.select({ id: branches.id, name: branches.name, code: branches.code }).from(branches)]);
  const branchName = new Map(branchRows.map((row) => [row.id, row.code]));
  return tree.map((node) => ({
    ...node,
    ...(stats.get(node.id) ?? { units: 0, skus: 0, reserved: 0, inTransitTo: 0, openCounts: 0 }),
    children: tree.filter((child) => child.parentId === node.id).length,
    branchName: node.branchId ? (branchName.get(node.branchId) ?? null) : null,
  }));
}

async function locationStats(db: Db, locationId: string | null): Promise<Map<string, LocationStats>> {
  const only = locationId ? sql`AND location_id = ${locationId}` : sql``;
  const onlyTo = locationId ? sql`AND t.to_location_id = ${locationId}` : sql``;
  const onlyCount = locationId ? sql`AND location_id = ${locationId}` : sql``;
  const [levels, transfers, counts] = await Promise.all([
    db.all<{ locationId: string; units: number; skus: number; reserved: number }>(sql`
      SELECT location_id AS locationId, coalesce(sum(on_hand), 0) AS units, sum(CASE WHEN on_hand <> 0 THEN 1 ELSE 0 END) AS skus, coalesce(sum(reserved), 0) AS reserved
      FROM stock_levels WHERE 1 = 1 ${only} GROUP BY location_id`),
    db.all<{ locationId: string; qty: number }>(sql`
      SELECT t.to_location_id AS locationId, coalesce(sum(i.qty - i.qty_received), 0) AS qty FROM stock_transfers AS t JOIN stock_transfer_items AS i ON i.transfer_id = t.id
      WHERE t.status = 'in_transit' ${onlyTo} GROUP BY t.to_location_id`),
    db.all<{ locationId: string; n: number }>(sql`
      SELECT location_id AS locationId, count(*) AS n FROM cycle_counts WHERE status IN ('draft', 'counting', 'review') ${onlyCount} GROUP BY location_id`),
  ]);
  const out = new Map<string, LocationStats>();
  const get = (id: string) => {
    let entry = out.get(id);
    if (!entry) {
      entry = { units: 0, skus: 0, reserved: 0, inTransitTo: 0, openCounts: 0 };
      out.set(id, entry);
    }
    return entry;
  };
  for (const row of levels) Object.assign(get(row.locationId), { units: Number(row.units), skus: Number(row.skus), reserved: Number(row.reserved) });
  for (const row of transfers) get(row.locationId).inTransitTo = Number(row.qty);
  for (const row of counts) get(row.locationId).openCounts = Number(row.n);
  return out;
}

export type LocationDetail = {
  location: LocationNode & LocationStats;
  parent: LocationNode | null;
  children: (LocationNode & LocationStats)[];
  ancestors: LocationNode[];
};

export async function getLocation(db: Db, actor: Actor, locationId: string): Promise<LocationDetail> {
  assertCan(actor, "inventory.stock.read");
  const tree = await locationTree(db);
  const node = tree.find((entry) => entry.id === locationId);
  if (!node) throw notFound("location");
  const stats = await locationStats(db, null);
  const empty: LocationStats = { units: 0, skus: 0, reserved: 0, inTransitTo: 0, openCounts: 0 };
  const ancestors: LocationNode[] = [];
  let parentId = node.parentId;
  while (parentId) {
    const parent = tree.find((entry) => entry.id === parentId);
    if (!parent || ancestors.includes(parent)) break;
    ancestors.unshift(parent);
    parentId = parent.parentId;
  }
  return {
    location: { ...node, ...(stats.get(node.id) ?? empty) },
    parent: ancestors[ancestors.length - 1] ?? null,
    children: tree.filter((entry) => entry.parentId === node.id).map((child) => ({ ...child, ...(stats.get(child.id) ?? empty) })),
    ancestors,
  };
}

function uniqueError(error: unknown): never {
  if (isUniqueViolation(error, "inventory_locations.code")) throw new AppError("code_taken", 409, { fields: { code: "code_taken" }, cause: error });
  if (isUniqueViolation(error, "inventory_locations.barcode")) throw new AppError("barcode_taken", 409, { fields: { barcode: "barcode_taken" }, cause: error });
  throw error;
}

/** Adds a warehouse, a shop, or an aisle / shelf / bin inside one. */
export async function createLocation(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ locationId: string; code: string }> {
  assertCan(actor, "inventory.location.manage");
  const input = CreateLocationInput.parse(raw);
  const tree = await locationTree(db);
  let parent: LocationNode | null = null;
  if (input.kind === "bin") {
    parent = tree.find((node) => node.id === input.parentId) ?? null;
    if (!parent || !parent.isActive) throw invalid({ parentId: "location_parent_invalid" });
    if (parent.depth + 1 > MAX_LOCATION_DEPTH) throw new AppError("location_too_deep", 409, { fields: { parentId: "location_too_deep" } });
  } else if (input.parentId) {
    throw invalid({ parentId: "location_parent_invalid" });
  }
  // A position inside a branch belongs to that branch; employees limited to a branch work inside it only.
  const branchId = parent ? parent.branchId : (input.branchId ?? null);
  assertBranch(actor, branchId);
  if (branchId && !parent) {
    const branch = await db.select({ id: branches.id }).from(branches).where(eq(branches.id, branchId)).limit(1);
    if (!branch[0]) throw invalid({ branchId: "not_found" });
  }
  const barcode = input.barcode && input.barcode.length > 0 ? input.barcode : input.code;
  // Name the field that clashes (the database would report whichever unique index it checks first).
  if (tree.some((node) => node.code === input.code)) throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
  if (tree.some((node) => node.barcode === barcode)) throw new AppError("barcode_taken", 409, { fields: { barcode: "barcode_taken" } });
  const locationId = newId("loc");
  const row = {
    id: locationId,
    code: input.code,
    name: input.name,
    kind: input.kind,
    parentId: parent?.id ?? null,
    barcode,
    // Positions inherit whether their stock is for sale unless told otherwise.
    isSellable: input.isSellable ?? parent?.isSellable ?? true,
    branchId,
    isActive: true,
    sort: input.sort ?? 0,
  };
  try {
    await runBatch(db, [
      db.insert(inventoryLocations).values(row),
      auditStatement(db, { actor, action: "inventory.location.create", entityType: "inventory_location", entityId: locationId, summary: `${row.code} · ${row.name}`, after: row, at: now }),
    ]);
  } catch (error) {
    uniqueError(error);
  }
  return { locationId, code: input.code };
}

/** Renames, re-labels, takes out of sale or switches off a location (refused while it is in use). */
export async function updateLocation(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "inventory.location.manage");
  const input = UpdateLocationInput.parse(raw);
  const current = await db.select().from(inventoryLocations).where(eq(inventoryLocations.id, input.locationId)).limit(1);
  const before = current[0];
  if (!before) throw notFound("location");
  assertBranch(actor, before.branchId);

  const patch: Partial<typeof inventoryLocations.$inferInsert> = {};
  if (input.name !== undefined && input.name !== before.name) patch.name = input.name;
  if (input.barcode !== undefined && input.barcode !== before.barcode) patch.barcode = input.barcode;
  if (input.isSellable !== undefined && input.isSellable !== before.isSellable) patch.isSellable = input.isSellable;
  if (input.isActive !== undefined && input.isActive !== before.isActive) patch.isActive = input.isActive;
  if (input.sort !== undefined && input.sort !== before.sort) patch.sort = input.sort;
  if (Object.keys(patch).length === 0) return { changed: false };

  const sensitive = patch.isActive === false || patch.isSellable === false;
  if (sensitive && (input.reason ?? "").length < 3) throw invalid({ reason: "too_short" });
  if (patch.isActive === false) {
    const [stats, activeChildren] = await Promise.all([
      locationStats(db, before.id),
      db
        .select({ id: inventoryLocations.id })
        .from(inventoryLocations)
        .where(and(eq(inventoryLocations.parentId, before.id), eq(inventoryLocations.isActive, true)))
        .limit(1),
    ]);
    const mine = stats.get(before.id);
    const negative = await db.all<{ n: number }>(sql`SELECT count(*) AS n FROM stock_levels WHERE location_id = ${before.id} AND on_hand <> 0`);
    if ((mine && (mine.reserved > 0 || mine.inTransitTo > 0 || mine.openCounts > 0)) || Number(negative[0]?.n ?? 0) > 0 || activeChildren.length > 0) {
      throw new AppError("location_in_use", 409, { fields: { isActive: "location_in_use" } });
    }
  }
  const fields = Object.keys(patch) as (keyof typeof patch)[];
  const pickFields = (source: Record<string, unknown>) => Object.fromEntries(fields.map((key) => [key, source[key]]));
  // Switching off: still not in use when the change is written — a transfer shipped to it, a receipt, a reservation or a
  // count started since the checks above would otherwise strand stock at an inactive location (nobody can receive there).
  const stillUnused = expectThat(
    db,
    sql`NOT EXISTS (SELECT 1 FROM stock_levels WHERE location_id = ${before.id} AND (on_hand <> 0 OR reserved <> 0))
        AND NOT EXISTS (SELECT 1 FROM stock_transfers WHERE to_location_id = ${before.id} AND status = 'in_transit')
        AND NOT EXISTS (SELECT 1 FROM cycle_counts WHERE location_id = ${before.id} AND status IN ('draft', 'counting', 'review'))
        AND NOT EXISTS (SELECT 1 FROM inventory_locations WHERE parent_id = ${before.id} AND is_active = 1)`,
    { code: "LOCATION_IN_USE", detail: before.id },
  );
  try {
    await runBatch(db, [
      ...(patch.isActive === false ? [stillUnused] : []),
      db.update(inventoryLocations).set(patch).where(eq(inventoryLocations.id, before.id)),
      auditStatement(db, {
        actor,
        action: patch.isActive === false ? "inventory.location.deactivate" : "inventory.location.update",
        entityType: "inventory_location",
        entityId: before.id,
        summary: `${before.code} · ${before.name}`,
        before: pickFields(before as unknown as Record<string, unknown>),
        after: pickFields(patch as Record<string, unknown>),
        reason: input.reason || null,
        at: now,
      }),
    ]);
  } catch (error) {
    if (isDbError(error, "LOCATION_IN_USE")) throw new AppError("location_in_use", 409, { fields: { isActive: "location_in_use" }, cause: error });
    uniqueError(error);
  }
  return { changed: true };
}

export type LabelData = { id: string; code: string; name: string; path: string; barcode: string; level: LocationNode["level"] };

/** Labels to print for the given locations (or for a location and everything inside it). */
export async function locationLabels(db: Db, actor: Actor, ids: readonly string[], options: { withChildren?: boolean } = {}): Promise<LabelData[]> {
  assertCan(actor, "inventory.stock.read");
  const tree = await locationTree(db);
  const wanted = new Set(ids);
  if (options.withChildren) {
    let grew = true;
    while (grew) {
      grew = false;
      for (const node of tree) {
        if (node.parentId && wanted.has(node.parentId) && !wanted.has(node.id)) {
          wanted.add(node.id);
          grew = true;
        }
      }
    }
  }
  return tree
    .filter((node) => wanted.has(node.id))
    .slice(0, 200)
    .map((node) => ({ id: node.id, code: node.code, name: node.name, path: node.path, barcode: node.barcode || node.code, level: node.level }));
}

/** Branches for the "belongs to" select (code and Arabic/English name). */
export async function branchOptions(db: Db): Promise<{ id: string; code: string }[]> {
  return db.select({ id: branches.id, code: branches.code }).from(branches).where(eq(branches.isActive, true));
}
