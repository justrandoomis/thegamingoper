/**
 * Admin module 04 (inventory) — helpers shared by its services: names of variants, locations and employees for
 * views, the location tree, paging, Iraq-time day boundaries and the permission flags a page needs.
 *
 * Reads only. Everything that moves stock goes through the commerce core (~/server/services/inventory/*).
 * [P] cost data is never selected here.
 */
import { inArray, sql } from "drizzle-orm";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { employees } from "~/server/db/schema";

/** Asia/Baghdad is UTC+3 all year (no daylight saving). */
export const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

/** Epoch ms of the start of the Baghdad day that contains `ms`. */
export function baghdadDayStart(ms: number): number {
  return Math.floor((ms + BAGHDAD_OFFSET_MS) / DAY_MS) * DAY_MS - BAGHDAD_OFFSET_MS;
}

/** "YYYY-MM-DD" of the Baghdad day that contains `ms`. */
export function baghdadDate(ms: number): string {
  return new Date(ms + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms of 00:00 Baghdad time of a "YYYY-MM-DD" date, or null when it is not a real date. */
export function parseBaghdadDate(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms - BAGHDAD_OFFSET_MS;
}

export const PAGE_SIZE = 50;

/** A 1-based page number from a URL parameter. */
export function pageOf(value: string | null | undefined): number {
  const page = Number.parseInt(value ?? "1", 10);
  return Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1;
}

/** Text typed into a search box: trimmed, at most 80 characters, LIKE wildcards escaped (use with ESCAPE '\'). */
export function likePattern(q: string): string {
  return `%${q.trim().slice(0, 80).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

export function cleanQuery(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

/** What the inventory pages may show or offer this actor (UI hints only — the services check again). */
export type InventoryAccess = {
  stock: boolean;
  adjust: boolean;
  receive: boolean;
  movements: boolean;
  countPerform: boolean;
  countApprove: boolean;
  transferCreate: boolean;
  transferReceive: boolean;
  locations: boolean;
  serials: boolean;
  serialManage: boolean;
  release: boolean;
  oversell: boolean;
  reorder: boolean;
  reports: boolean;
  cost: boolean;
  jobs: boolean;
  /** May open an order's page in the orders module (05). */
  orders: boolean;
};

export function inventoryAccess(actor: Actor): InventoryAccess {
  return {
    stock: can(actor, "inventory.stock.read"),
    adjust: can(actor, "inventory.stock.adjust"),
    receive: can(actor, "inventory.stock.receive"),
    movements: can(actor, "inventory.movement.read"),
    countPerform: can(actor, "inventory.count.perform"),
    countApprove: can(actor, "inventory.count.approve"),
    transferCreate: can(actor, "inventory.transfer.create"),
    transferReceive: can(actor, "inventory.transfer.receive"),
    locations: can(actor, "inventory.location.manage"),
    serials: can(actor, "inventory.serial.read"),
    serialManage: can(actor, "inventory.serial.manage"),
    release: can(actor, "inventory.reservation.release"),
    oversell: can(actor, "inventory.oversell.authorize"),
    reorder: can(actor, "inventory.reorder.manage"),
    reports: can(actor, "inventory.report.read"),
    cost: can(actor, "cost.read"),
    jobs: can(actor, "ops.job.read"),
    orders: can(actor, "orders.order.read"),
  };
}

// ───────────────────────────────────────────────────────────────── variants

export type VariantLabel = { id: string; sku: string; barcode: string | null; name: string; productName: string; variantTitle: string; trackSerials: boolean; isActive: boolean };

/** Product name, variant title, SKU and barcode of each variant, in the admin's language. */
export async function variantLabels(db: Db, variantIds: readonly string[], locale: Locale): Promise<Map<string, VariantLabel>> {
  const ids = [...new Set(variantIds.filter(Boolean))];
  const out = new Map<string, VariantLabel>();
  if (ids.length === 0) return out;
  const rows = await db.all<{ id: string; sku: string; barcode: string | null; title: string | null; productName: string; trackSerials: number; isActive: number }>(sql`
    SELECT v.id AS id, v.sku AS sku, v.barcode AS barcode, v.title AS title, p.name AS productName, v.track_serials AS trackSerials, v.is_active AS isActive
    FROM variants AS v JOIN products AS p ON p.id = v.product_id
    WHERE v.id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
  for (const row of rows) out.set(row.id, labelOf(row, locale));
  return out;
}

export function parseL10n(value: unknown): L10n | null {
  if (value && typeof value === "object") return value as L10n;
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as L10n) : null;
  } catch {
    return null;
  }
}

export function labelOf(row: { id: string; sku: string; barcode: string | null; title: unknown; productName: unknown; trackSerials: number | boolean; isActive: number | boolean }, locale: Locale): VariantLabel {
  const productName = pick(parseL10n(row.productName), locale);
  const variantTitle = pick(parseL10n(row.title), locale);
  return {
    id: row.id,
    sku: row.sku,
    barcode: row.barcode,
    productName,
    variantTitle,
    // Variant titles often repeat the product name ("007 First Light لجهاز PS5"): then the title alone says it all.
    name: !variantTitle || variantTitle === productName ? productName : variantTitle.includes(productName) ? variantTitle : `${productName} — ${variantTitle}`,
    trackSerials: Boolean(row.trackSerials),
    isActive: Boolean(row.isActive),
  };
}

// ───────────────────────────────────────────────────────────────── locations

export type LocationLevel = "warehouse" | "store" | "aisle" | "shelf" | "bin";
export type LocationNode = {
  id: string;
  code: string;
  name: string;
  kind: "warehouse" | "store" | "bin";
  level: LocationLevel;
  parentId: string | null;
  depth: number;
  /** "MAIN › A1 › S2". */
  path: string;
  barcode: string | null;
  isSellable: boolean;
  isActive: boolean;
  branchId: string | null;
  sort: number;
};

/** Storage positions inside a warehouse or shop: one level down is an aisle, then a shelf, then a bin. */
export const LEVEL_BY_DEPTH: readonly LocationLevel[] = ["warehouse", "aisle", "shelf", "bin"];
export const MAX_LOCATION_DEPTH = 3;

/** Every location with its depth and path, parents before children, siblings by sort and code. */
export async function locationTree(db: Db): Promise<LocationNode[]> {
  const rows = await db.all<{ id: string; code: string; name: string; kind: "warehouse" | "store" | "bin"; parentId: string | null; barcode: string | null; isSellable: number; isActive: number; branchId: string | null; sort: number }>(sql`
    SELECT id, code, name, kind, parent_id AS parentId, barcode, is_sellable AS isSellable, is_active AS isActive, branch_id AS branchId, sort
    FROM inventory_locations ORDER BY sort, code`);
  const children = new Map<string | null, typeof rows>();
  const ids = new Set(rows.map((row) => row.id));
  for (const row of rows) {
    // A parent that does not exist (never expected) makes the row a root rather than hiding it.
    const parent = row.parentId && ids.has(row.parentId) ? row.parentId : null;
    const list = children.get(parent) ?? [];
    list.push(row);
    children.set(parent, list);
  }
  const out: LocationNode[] = [];
  const seen = new Set<string>();
  const visit = (parentId: string | null, depth: number, prefix: string) => {
    for (const row of children.get(parentId) ?? []) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const path = prefix ? `${prefix} › ${row.code}` : row.code;
      const level: LocationLevel = depth === 0 ? (row.kind === "store" ? "store" : "warehouse") : (LEVEL_BY_DEPTH[Math.min(depth, MAX_LOCATION_DEPTH)] ?? "bin");
      out.push({ id: row.id, code: row.code, name: row.name, kind: row.kind, level, parentId: row.parentId, depth, path, barcode: row.barcode, isSellable: Boolean(row.isSellable), isActive: Boolean(row.isActive), branchId: row.branchId, sort: row.sort });
      if (depth < 12) visit(row.id, depth + 1, path);
    }
  };
  visit(null, 0, "");
  return out;
}

export type LocationOption = { value: string; label: string; isActive: boolean; isSellable: boolean };

/** Active locations for a select box: "MAIN · المخزن الرئيسي", nested ones by path. */
export function locationOptions(tree: readonly LocationNode[], options: { includeInactive?: boolean } = {}): LocationOption[] {
  return tree
    .filter((node) => options.includeInactive || node.isActive)
    .map((node) => ({ value: node.id, label: `${node.path} · ${node.name}`, isActive: node.isActive, isSellable: node.isSellable }));
}

// ───────────────────────────────────────────────────────────────── people

/** Names of employees by id (for "who did it" columns). Ids that are not employees are skipped. */
export async function employeeNames(db: Db, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => typeof id === "string" && id.length > 0))];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, unique));
  return new Map(rows.map((row) => [row.id, row.name]));
}

/** Who did it: an employee's name, the system job, or the customer/guest marker. */
export type ActorView = { kind: "employee" | "customer" | "guest" | "system"; name: string | null; id: string | null };

export function actorView(kind: string, id: string | null, names: Map<string, string>): ActorView {
  if (kind === "employee") return { kind, id, name: (id && names.get(id)) ?? null };
  if (kind === "system") return { kind, id, name: id };
  if (kind === "customer") return { kind, id, name: null };
  return { kind: "guest", id: null, name: null };
}

/**
 * The start of the reason a count's approval writes on each difference it posts: "CC-XXXXXXXX [<line id>]: …"
 * (counts.server.ts finds what is posted by it, with LIKE — so in any letter case). Reserved: a reason typed for a
 * manual adjustment may not start like this, or someone who counted could make the approval skip a difference.
 */
export const COUNT_POSTING_REASON = /^\s*cc-[a-z0-9]+\s*\[/i;

/** Rows changed by one statement of a D1 batch result. */
export function changesOf(result: unknown): number {
  const changes = (result as { meta?: { changes?: unknown } } | null)?.meta?.changes;
  return typeof changes === "number" ? changes : 0;
}
