/**
 * 21.01 Branches — the store's physical branches (`branches`), which the other modules already point at: stock
 * locations (04, `inventory_locations.branch_id`), registers (06, `pos_registers.branch_id`), employees limited to a
 * branch (20, `employees.branch_id`), price lists for a branch (03, `price_lists.branch_id`) and POS sales
 * (`orders.branch_id`, set by the core from the register). This file writes ONLY the branch rows; what belongs to a
 * branch is shown here and changed in its own module (the page links there).
 *
 *   listBranches(db, actor, view, locale)                       channels.branch.manage
 *   getBranch(db, actor, branchId, locale, now)                 + each module's own read permission for its part
 *   branchFormOptions(db, locale)                               governorates and districts
 *   createBranch(db, actor, raw, now) → { branchId, replayed }  whole-store employees only; the id comes from the form's key
 *   updateBranch(db, actor, raw, now) → { changed }             refused when the branch changed since the form was built
 *   setBranchActive(db, actor, raw, now) → { changed }          switching off is refused while active records still use it
 *
 * Every change is one batch: the guarded write (every column compared with what was read — the table has no version
 * column) and its audit event. A branch-limited employee sees and edits only their own branch and never creates or
 * switches one. Errors: branch_changed (409), branch_in_use (409), code_taken (409), invalid (fields), forbidden,
 * not_found. Must not import "cloudflare:workers".
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, canAccessBranch, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { branches, districts, governorates } from "~/server/db/schema";
import { expectChanged, expectThat, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { IdSchema, IdempotencyKey, OptionalReason, Reason, assertWholeStore, baghdadDay, fingerprintOf, guardError, keyedId, linkIf } from "./shared.server";
import { BRANCH_CODE_PATTERN, latinDigits, type BranchDetail, type BranchRow, type BranchView } from "./types";

const MANAGE = "channels.branch.manage";
const POS_READERS = ["pos.sale.create", "pos.sale.refund", "pos.discount.apply", "pos.shift.open", "pos.shift.close", "pos.shift.review", "pos.cash.move", "pos.receipt.reprint", "pos.register.manage"] as const;
const PRICE_READERS = ["pricing.price_list.manage", "pricing.price.update", "pricing.price.approve", "pricing.discount.override", "pricing.simulation.run"] as const;
const SALES_READERS = ["pos.shift.review", "pos.receipt.reprint", "pos.sale.create"] as const;

const GUARDS: Record<string, [string, number]> = { BRANCH_CHANGED: ["branch_changed", 409], BRANCH_IN_USE: ["branch_in_use", 409] };

// The employee may only work on their own branch; a whole-store change (create, switch) needs no branch limit
// (assertWholeStore, shared.server.ts).

function assertReach(actor: Actor, branchId: string): void {
  if (!canAccessBranch(actor, branchId)) throw notFound("branch");
}

// ───────────────────────────────────────────────────────────────── input

const text = (max: number) => z.string().trim().max(max, "too_long");

/** "07xx…" mobiles become +9647…; a landline keeps its digits (Latin); anything else is refused. */
function normalizePhone(raw: string | undefined): string | null | "invalid" {
  const value = latinDigits(raw ?? "").trim();
  if (!value) return null;
  const mobile = normalizeIraqPhone(value);
  if (mobile) return mobile;
  const digits = value.replace(/[\s()-]/g, "");
  return /^\+?\d{6,15}$/.test(digits) ? digits : "invalid";
}

const BranchFields = z.object({
  code: z
    .string({ error: "required" })
    .trim()
    .transform((value) => latinDigits(value).toUpperCase())
    .pipe(z.string().min(1, "required").regex(BRANCH_CODE_PATTERN, "code_invalid")),
  nameAr: z.string({ error: "required" }).trim().min(1, "required").max(80, "too_long"),
  nameEn: text(80).optional(),
  governorateId: z.string().trim().max(100).optional(),
  districtId: z.string().trim().max(100).optional(),
  addressText: text(300).optional(),
  phone: text(40).optional(),
  hoursAr: text(200).optional(),
  hoursEn: text(200).optional(),
});

const CreateBranchInput = BranchFields.extend({ idempotencyKey: IdempotencyKey, reason: OptionalReason });
const UpdateBranchInput = BranchFields.extend({ branchId: IdSchema, fingerprint: z.string().trim().min(1, "required").max(64), reason: Reason });
const SetActiveInput = z.object({ branchId: IdSchema, active: z.boolean(), reason: Reason });

function parse<T extends z.ZodType>(schema: T, raw: unknown): z.output<T> {
  const result = schema.safeParse(raw);
  if (!result.success) throw invalid(zodFieldErrors(result.error));
  return result.data;
}

type BranchValues = {
  code: string;
  name: L10n;
  governorateId: string | null;
  districtId: string | null;
  addressText: string | null;
  phone: string | null;
  hours: L10n | null;
};

/** The parsed form as the row's values, after the governorate and district were checked against the database. */
async function valuesOf(db: Db, input: z.output<typeof BranchFields>): Promise<BranchValues> {
  const fields: Record<string, string> = {};
  const phone = normalizePhone(input.phone);
  if (phone === "invalid") fields.phone = "phone_invalid";
  const governorateId = input.governorateId || null;
  const districtId = input.districtId || null;
  if (governorateId) {
    const row = await db.select({ id: governorates.id }).from(governorates).where(eq(governorates.id, governorateId)).get();
    if (!row) fields.governorateId = "not_found";
  }
  if (districtId) {
    const row = await db.select({ governorateId: districts.governorateId }).from(districts).where(eq(districts.id, districtId)).get();
    if (!row) fields.districtId = "not_found";
    else if (!governorateId || row.governorateId !== governorateId) fields.districtId = "district_mismatch";
  }
  if (Object.keys(fields).length) throw invalid(fields);
  const hoursAr = input.hoursAr || "";
  const hoursEn = input.hoursEn || "";
  return {
    code: input.code,
    name: input.nameEn ? { ar: input.nameAr, en: input.nameEn } : { ar: input.nameAr },
    governorateId,
    districtId,
    addressText: input.addressText || null,
    phone: phone === "invalid" ? null : phone,
    hours: hoursAr || hoursEn ? { ar: hoursAr || hoursEn, ...(hoursEn ? { en: hoursEn } : {}) } : null,
  };
}

// ───────────────────────────────────────────────────────────────── reading

/** The row exactly as stored (JSON columns as their text), for fingerprints and guarded writes. */
type RawBranch = {
  id: string;
  code: string;
  nameRaw: string;
  governorateId: string | null;
  districtId: string | null;
  addressText: string | null;
  phone: string | null;
  hoursRaw: string | null;
  isActive: number;
  createdAt: number;
};

async function rawBranch(db: Db, branchId: string): Promise<RawBranch | null> {
  const rows = await db.all<RawBranch>(sql`
    SELECT id, code, name AS nameRaw, governorate_id AS governorateId, district_id AS districtId, address_text AS addressText, phone,
           hours AS hoursRaw, is_active AS isActive, created_at AS createdAt
    FROM branches WHERE id = ${branchId}`);
  return rows[0] ?? null;
}

const fingerprint = (row: RawBranch) => fingerprintOf([row.code, row.nameRaw, row.governorateId, row.districtId, row.addressText, row.phone, row.hoursRaw, Number(row.isActive)]);

function parseL10n(raw: string | null): L10n | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && typeof (value as L10n).ar === "string" ? (value as L10n) : null;
  } catch {
    return null;
  }
}

/** Every column of the row compared with what was read: a change by anyone in between makes the write touch nothing. */
function unchangedSince(row: RawBranch): SQL {
  const same = (column: SQL, value: string | number | null) => (value === null ? sql`${column} IS NULL` : sql`${column} = ${value}`);
  return sql.join(
    [
      sql`id = ${row.id}`,
      same(sql`code`, row.code),
      same(sql`name`, row.nameRaw),
      same(sql`governorate_id`, row.governorateId),
      same(sql`district_id`, row.districtId),
      same(sql`address_text`, row.addressText),
      same(sql`phone`, row.phone),
      same(sql`hours`, row.hoursRaw),
      same(sql`is_active`, Number(row.isActive)),
    ],
    sql` AND `,
  );
}

type Usage = { locations: number; registers: number; employees: number; priceLists: number };

async function usageCounts(db: Db, branchIds: readonly string[]): Promise<Map<string, Usage>> {
  const out = new Map<string, Usage>(branchIds.map((id) => [id, { locations: 0, registers: 0, employees: 0, priceLists: 0 }]));
  if (branchIds.length === 0) return out;
  const ids = sql.join(
    branchIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = await db.all<{ branchId: string; kind: keyof Usage; n: number }>(sql`
    SELECT branch_id AS branchId, 'locations' AS kind, count(*) AS n FROM inventory_locations WHERE is_active = 1 AND branch_id IN (${ids}) GROUP BY branch_id
    UNION ALL SELECT branch_id, 'registers', count(*) FROM pos_registers WHERE is_active = 1 AND branch_id IN (${ids}) GROUP BY branch_id
    UNION ALL SELECT branch_id, 'employees', count(*) FROM employees WHERE status = 'active' AND branch_id IN (${ids}) GROUP BY branch_id
    UNION ALL SELECT branch_id, 'priceLists', count(*) FROM price_lists WHERE is_active = 1 AND branch_id IN (${ids}) GROUP BY branch_id`);
  for (const row of rows) {
    const usage = out.get(row.branchId);
    if (usage) usage[row.kind] = Number(row.n);
  }
  return out;
}

/** The same rule inside a batch: nothing active points at the branch any more. */
function notInUse(branchId: string): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM inventory_locations WHERE branch_id = ${branchId} AND is_active = 1)
    AND NOT EXISTS (SELECT 1 FROM pos_registers WHERE branch_id = ${branchId} AND is_active = 1)
    AND NOT EXISTS (SELECT 1 FROM employees WHERE branch_id = ${branchId} AND status = 'active')
    AND NOT EXISTS (SELECT 1 FROM price_lists WHERE branch_id = ${branchId} AND is_active = 1)`;
}

async function placeNames(db: Db, locale: Locale): Promise<{ governorates: Map<string, string>; districts: Map<string, string> }> {
  const [govs, dists] = await Promise.all([
    db.select({ id: governorates.id, name: governorates.name }).from(governorates),
    db.select({ id: districts.id, name: districts.name }).from(districts),
  ]);
  return { governorates: new Map(govs.map((row) => [row.id, pick(row.name, locale)])), districts: new Map(dists.map((row) => [row.id, pick(row.name, locale)])) };
}

function rowOf(raw: RawBranch, usage: Usage, places: { governorates: Map<string, string>; districts: Map<string, string> }, locale: Locale): BranchRow {
  const name = parseL10n(raw.nameRaw) ?? { ar: raw.code };
  return {
    id: raw.id,
    code: raw.code,
    name: pick(name, locale) || raw.code,
    nameAr: name.ar,
    nameEn: name.en ?? "",
    governorate: raw.governorateId ? (places.governorates.get(raw.governorateId) ?? null) : null,
    district: raw.districtId ? (places.districts.get(raw.districtId) ?? null) : null,
    phone: raw.phone,
    isActive: Boolean(raw.isActive),
    createdAt: Number(raw.createdAt),
    ...usage,
  };
}

export async function listBranches(db: Db, actor: Actor, view: BranchView, locale: Locale): Promise<{ rows: BranchRow[]; counts: Record<BranchView, number> }> {
  assertCan(actor, MANAGE);
  const limited = actor.kind === "employee" ? (actor.branchId ?? null) : null;
  const all = await db.all<RawBranch>(sql`
    SELECT id, code, name AS nameRaw, governorate_id AS governorateId, district_id AS districtId, address_text AS addressText, phone,
           hours AS hoursRaw, is_active AS isActive, created_at AS createdAt
    FROM branches ${limited ? sql`WHERE id = ${limited}` : sql``} ORDER BY is_active DESC, code`);
  const counts = { active: all.filter((row) => row.isActive).length, inactive: all.filter((row) => !row.isActive).length, all: all.length };
  const shown = all.filter((row) => view === "all" || (view === "active" ? Boolean(row.isActive) : !row.isActive));
  const [usage, places] = await Promise.all([usageCounts(db, shown.map((row) => row.id)), placeNames(db, locale)]);
  return { rows: shown.map((row) => rowOf(row, usage.get(row.id) ?? { locations: 0, registers: 0, employees: 0, priceLists: 0 }, places, locale)), counts };
}

export type BranchFormOptions = { governorates: { id: string; name: string }[]; districts: { id: string; governorateId: string; name: string }[] };

export async function branchFormOptions(db: Db, locale: Locale): Promise<BranchFormOptions> {
  const [govs, dists] = await Promise.all([
    db.select({ id: governorates.id, name: governorates.name }).from(governorates).orderBy(asc(governorates.sort)),
    db.select({ id: districts.id, governorateId: districts.governorateId, name: districts.name }).from(districts).where(eq(districts.isActive, true)).orderBy(asc(districts.sort)),
  ]);
  return {
    governorates: govs.map((row) => ({ id: row.id, name: pick(row.name, locale) })),
    districts: dists.map((row) => ({ id: row.id, governorateId: row.governorateId, name: pick(row.name, locale) })),
  };
}

export async function getBranch(db: Db, actor: Actor, branchId: string, locale: Locale, now: number): Promise<BranchDetail> {
  assertCan(actor, MANAGE);
  const raw = await rawBranch(db, branchId);
  if (!raw) throw notFound("branch");
  assertReach(actor, raw.id);
  const [usage, places, print] = await Promise.all([usageCounts(db, [raw.id]), placeNames(db, locale), fingerprint(raw)]);
  const counts = usage.get(raw.id) ?? { locations: 0, registers: 0, employees: 0, priceLists: 0 };
  const hours = parseL10n(raw.hoursRaw);

  const seeStock = can(actor, "inventory.stock.read");
  const seeRegisters = POS_READERS.some((permission) => can(actor, permission));
  const seeEmployees = can(actor, "security.session.read") || can(actor, "staff.employee.read");
  const seeLists = PRICE_READERS.some((permission) => can(actor, permission));
  const seeSales = can(actor, "orders.order.read");
  const monthStart = Date.parse(`${baghdadDay(now).slice(0, 7)}-01T00:00:00+03:00`);

  const [locations, stock, registers, people, lists, sales] = await Promise.all([
    seeStock
      ? db.all<{ id: string; code: string; name: string; kind: string; isSellable: number; isActive: number }>(sql`
          SELECT id, code, name, kind, is_sellable AS isSellable, is_active AS isActive FROM inventory_locations WHERE branch_id = ${raw.id} ORDER BY is_active DESC, code LIMIT 50`)
      : Promise.resolve(null),
    seeStock
      ? db.all<{ skus: number; onHand: number; available: number }>(sql`
          SELECT count(DISTINCT s.variant_id) AS skus, coalesce(sum(s.on_hand), 0) AS onHand, coalesce(sum(max(s.on_hand - s.reserved, 0)), 0) AS available
          FROM stock_levels AS s JOIN inventory_locations AS l ON l.id = s.location_id
          WHERE l.branch_id = ${raw.id} AND l.is_active = 1 AND l.is_sellable = 1 AND s.on_hand > 0`)
      : Promise.resolve(null),
    seeRegisters
      ? db.all<{ id: string; code: string; name: string; isActive: number }>(sql`SELECT id, code, name, is_active AS isActive FROM pos_registers WHERE branch_id = ${raw.id} ORDER BY is_active DESC, code LIMIT 50`)
      : Promise.resolve(null),
    seeEmployees ? db.all<{ id: string; name: string; status: string }>(sql`SELECT id, name, status FROM employees WHERE branch_id = ${raw.id} ORDER BY status, name LIMIT 50`) : Promise.resolve(null),
    seeLists
      ? db.all<{ id: string; code: string; name: string; isActive: number }>(sql`SELECT id, code, name, is_active AS isActive FROM price_lists WHERE branch_id = ${raw.id} ORDER BY is_active DESC, code LIMIT 50`)
      : Promise.resolve(null),
    seeSales
      ? db.all<{ n: number; total: number }>(sql`
          SELECT count(*) AS n, coalesce(sum(total_iqd), 0) AS total FROM orders
          WHERE branch_id = ${raw.id} AND channel = 'pos' AND status <> 'cancelled' AND is_demo = 0 AND placed_at >= ${monthStart} AND placed_at < ${now + 1}`)
      : Promise.resolve(null),
  ]);

  return {
    ...rowOf(raw, counts, places, locale),
    governorateId: raw.governorateId,
    districtId: raw.districtId,
    addressText: raw.addressText,
    hoursAr: hours?.ar ?? "",
    hoursEn: hours?.en ?? "",
    fingerprint: print,
    usage: {
      locations: locations ? locations.map((row) => ({ id: row.id, code: row.code, name: row.name, kind: row.kind, isSellable: Boolean(row.isSellable), isActive: Boolean(row.isActive) })) : null,
      stock: stock ? { skus: Number(stock[0]?.skus ?? 0), onHand: Number(stock[0]?.onHand ?? 0), available: Number(stock[0]?.available ?? 0) } : null,
      registers: registers ? registers.map((row) => ({ id: row.id, code: row.code, name: row.name, isActive: Boolean(row.isActive) })) : null,
      employees: people,
      priceLists: lists ? lists.map((row) => ({ id: row.id, code: row.code, name: pick(parseL10n(row.name) ?? { ar: row.code }, locale), isActive: Boolean(row.isActive) })) : null,
      sales: sales ? { orders: Number(sales[0]?.n ?? 0), totalIqd: Number(sales[0]?.total ?? 0), from: baghdadDay(monthStart), to: baghdadDay(now) } : null,
    },
    inUse: counts,
    links: {
      locations: linkIf(actor, ["inventory.stock.read"], "/admin/inventory/locations"),
      registers: linkIf(actor, POS_READERS, "/admin/pos/registers"),
      employees: linkIf(actor, ["security.session.read"], "/admin/security/staff"),
      priceLists: linkIf(actor, PRICE_READERS, "/admin/pricing/lists"),
      sales: linkIf(actor, SALES_READERS, "/admin/pos/sales"),
    },
  };
}

// ───────────────────────────────────────────────────────────────── changes

function audit(db: Db, actor: Actor, action: string, branchId: string, now: number, values: { before?: unknown; after?: unknown; reason?: string | null }): BatchStatement {
  // a branch's phone is the store's own business number, kept readable like the store's contact settings
  return auditStatement(db, { actor, action, entityType: "branch", entityId: branchId, before: values.before, after: values.after, reason: values.reason ?? null, at: now, redact: { phones: false } });
}

export async function createBranch(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ branchId: string; replayed: boolean }> {
  assertCan(actor, MANAGE);
  assertWholeStore(actor);
  const input = parse(CreateBranchInput, raw);
  const branchId = await keyedId("brn", actor, input.idempotencyKey);
  const existing = await db.select({ id: branches.id, code: branches.code }).from(branches).where(eq(branches.id, branchId)).get();
  if (existing) {
    if (existing.code !== input.code) throw new AppError("idempotency_mismatch", 409);
    return { branchId, replayed: true };
  }
  const values = await valuesOf(db, input);
  try {
    await runBatch(db, [
      db.insert(branches).values({ id: branchId, ...values, isActive: true, createdAt: now }),
      audit(db, actor, "channels.branch.create", branchId, now, { after: values, reason: input.reason ?? null }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "branches.id")) return { branchId, replayed: true };
    if (isUniqueViolation(error, "branches.code")) throw invalid({ code: "code_taken" });
    throw error;
  }
  return { branchId, replayed: false };
}

export async function updateBranch(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  const input = parse(UpdateBranchInput, raw);
  const before = await rawBranch(db, input.branchId);
  if (!before) throw notFound("branch");
  assertReach(actor, before.id);
  if ((await fingerprint(before)) !== input.fingerprint) throw new AppError("branch_changed", 409);
  const values = await valuesOf(db, input);
  const beforeValues: BranchValues = {
    code: before.code,
    name: parseL10n(before.nameRaw) ?? { ar: before.code },
    governorateId: before.governorateId,
    districtId: before.districtId,
    addressText: before.addressText,
    phone: before.phone,
    hours: parseL10n(before.hoursRaw),
  };
  if (JSON.stringify(beforeValues) === JSON.stringify(values)) return { changed: false };
  try {
    await runBatch(db, [
      db
        .update(branches)
        .set({ ...values })
        .where(unchangedSince(before)),
      expectChanged(db, 1, { code: "BRANCH_CHANGED", detail: before.id }),
      audit(db, actor, "channels.branch.update", before.id, now, { before: beforeValues, after: values, reason: input.reason }),
    ]);
  } catch (error) {
    if (isUniqueViolation(error, "branches.code")) throw invalid({ code: "code_taken" });
    throw guardError(error, GUARDS);
  }
  return { changed: true };
}

export async function setBranchActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, MANAGE);
  assertWholeStore(actor);
  const input = parse(SetActiveInput, raw);
  const before = await rawBranch(db, input.branchId);
  if (!before) throw notFound("branch");
  if (Boolean(before.isActive) === input.active) return { changed: false };
  const statements: BatchStatement[] = [
    db
      .update(branches)
      .set({ isActive: input.active })
      .where(and(eq(branches.id, before.id), eq(branches.isActive, !input.active))),
    expectChanged(db, 1, { code: "BRANCH_CHANGED", detail: before.id }),
  ];
  // switching off: nothing active may still point at it — re-checked here, inside the write
  if (!input.active) statements.push(expectThat(db, notInUse(before.id), { code: "BRANCH_IN_USE", detail: before.id }));
  statements.push(audit(db, actor, input.active ? "channels.branch.activate" : "channels.branch.deactivate", before.id, now, { before: { isActive: Boolean(before.isActive) }, after: { isActive: input.active }, reason: input.reason }));
  try {
    await runBatch(db, statements);
  } catch (error) {
    throw guardError(error, GUARDS);
  }
  return { changed: true };
}

/** Active branches as options (code · name), e.g. for a filter. */
export async function branchNames(db: Db, ids: readonly string[], locale: Locale): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db.select({ id: branches.id, code: branches.code, name: branches.name }).from(branches).where(inArray(branches.id, unique));
  return new Map(rows.map((row) => [row.id, pick(row.name, locale) || row.code]));
}
