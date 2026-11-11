/**
 * Device warranties (blueprint 12.06): the store's warranty of each sold unit with its dates, its service history
 * (repair tickets on that warranty or serial) and the parts replaced, next to the MAKER's warranty from the product's
 * specs — shown separately, because the maker honours that one, not the store.
 *
 * A warranty row exists only when the order recorded one: the commerce core starts it at delivery from
 * order_items.warranty_months (new items) or warranty_days (used units). products.warranty_months is empty until the
 * store decides its own terms (docs/STATUS.md open item 15), so new items have none yet; this module never invents one.
 *
 *   const page = await listWarranties(db, actor, parseWarrantyFilters(params), locale, now);   // returns.warranty.read
 *   await extendWarranty(db, actor, { warrantyId, endsOn: "2027-12-31", reason }, now);       // returns.warranty.manage
 *   await voidWarranty(db, actor, { warrantyId, reason }, now);
 *
 * The state shown is computed from the dates (a row past its end reads "expired" before any job updates it).
 * Errors: forbidden (403), not_found (404), invalid (400; endsOn = invalid | not_later, reason), warranty_void (409).
 */
import { and, asc, desc, eq, gte, inArray, lt, lte, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { auditEvents, orderItems, orders, products, repairTickets, returnItems, returns, serials, variants, warranties, type RepairPart } from "~/server/db/schema";
import { expectChanged, isDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { normalizeOrderRef } from "~/server/services/orders/manage.server";
import { DAY_MS, HOUR_MS, employeeNames, lineName, phoneView, slaTargets } from "./shared.server";
import { SLA, type RepairStatusKey, type RmaStatus, type WarrantyDetail, type WarrantyFilters, type WarrantyRow, type WarrantyState } from "./types";

const PAGE_SIZE = 25;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export const stateOf = (row: { status: string; endsAt: number }, now: number): WarrantyState => (row.status === "void" ? "void" : row.endsAt < now ? "expired" : "active");

function readable(actor: Actor): void {
  if (!canAny(actor, ["returns.warranty.read", "returns.warranty.manage"])) throw forbidden("returns.warranty.read");
}

function viewCondition(filters: WarrantyFilters, now: number, endingDays: number = SLA.warrantyEndingDays): SQL | undefined {
  switch (filters.view) {
    case "active":
      return and(eq(warranties.status, "active"), gte(warranties.endsAt, now));
    case "ending":
      return and(eq(warranties.status, "active"), gte(warranties.endsAt, now), lte(warranties.endsAt, now + endingDays * DAY_MS));
    case "expired":
      return or(eq(warranties.status, "expired"), and(eq(warranties.status, "active"), lt(warranties.endsAt, now)));
    case "void":
      return eq(warranties.status, "void");
    default:
      return undefined;
  }
}

function searchCondition(actor: Actor, q: string): SQL | undefined {
  const text = q.trim();
  if (!text) return undefined;
  const ref = normalizeOrderRef(text);
  if (ref) return sql`${warranties.orderItemId} IN (SELECT oi.id FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.ref = ${ref})`;
  const phone = normalizeIraqPhone(text);
  if (phone) return eq(warranties.phoneE164, phone);
  // A serial as printed on the unit (exact, any case).
  const serial = text.toUpperCase().replace(/\s+/g, "");
  void actor;
  return sql`${warranties.serialId} IN (SELECT id FROM serials WHERE upper(serial) = ${serial.slice(0, 60)})`;
}

export async function listWarranties(db: Db, actor: Actor, filters: WarrantyFilters, locale: Locale, now: number): Promise<{ rows: WarrantyRow[]; total: number; page: number; pageCount: number; filters: WarrantyFilters; canManage: boolean }> {
  readable(actor);
  const where = and(viewCondition(filters, now, (await slaTargets(db)).warrantyEndingDays), searchCondition(actor, filters.q));
  const [rows, count] = await Promise.all([
    db
      .select({
        id: warranties.id,
        startsAt: warranties.startsAt,
        endsAt: warranties.endsAt,
        status: warranties.status,
        phone: warranties.phoneE164,
        serialId: warranties.serialId,
        usedUnitId: warranties.usedUnitId,
        serial: serials.serial,
        name: orderItems.nameSnapshot,
        orderRef: orders.ref,
        contactName: orders.contactName,
      })
      .from(warranties)
      .innerJoin(orderItems, eq(orderItems.id, warranties.orderItemId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .leftJoin(serials, eq(serials.id, warranties.serialId))
      .where(where)
      .orderBy(filters.view === "ending" ? asc(warranties.endsAt) : desc(warranties.startsAt), desc(warranties.id))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: sql<number>`count(*)` }).from(warranties).where(where).get(),
  ]);
  const ids = rows.map((row) => row.id);
  const serialIds = rows.map((row) => row.serialId).filter((value): value is string => typeof value === "string");
  const repairs = ids.length
    ? await db
        .select({ warrantyId: repairTickets.warrantyId, serialId: repairTickets.serialId })
        .from(repairTickets)
        .where(or(inArray(repairTickets.warrantyId, ids), serialIds.length ? inArray(repairTickets.serialId, serialIds) : sql`0`))
    : [];
  const total = Number(count?.n ?? 0);
  return {
    rows: rows.map((row) => ({
      id: row.id,
      itemName: lineName(row.name, locale),
      orderRef: row.orderRef,
      serial: row.serial ?? null,
      customerName: row.contactName ?? null,
      phone: phoneView(actor, row.phone),
      startsAt: row.startsAt,
      endsAt: row.endsAt,
      state: stateOf(row, now),
      repairs: repairs.filter((repair) => repair.warrantyId === row.id || (row.serialId !== null && repair.serialId === row.serialId)).length,
      isUsed: row.usedUnitId !== null,
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    filters,
    canManage: can(actor, "returns.warranty.manage"),
  };
}

/** The maker's warranty as the product's specs state it (researched; the maker honours it), or null. */
function makerWarranty(specs: unknown, locale: Locale): string | null {
  const value = (specs as Record<string, unknown> | null)?.warranty;
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof (value as { ar?: unknown }).ar === "string") return pick(value as L10n, locale) || null;
  return null;
}

const partsOf = (parts: unknown): RepairPart[] => (Array.isArray(parts) ? (parts as RepairPart[]).filter((part) => part && typeof part.name === "string") : []);

export async function getWarranty(db: Db, actor: Actor, warrantyId: string, locale: Locale, now: number): Promise<WarrantyDetail> {
  readable(actor);
  if (typeof warrantyId !== "string" || !ID.test(warrantyId)) throw notFound("warranty");
  const row = await db
    .select({
      id: warranties.id,
      orderItemId: warranties.orderItemId,
      serialId: warranties.serialId,
      startsAt: warranties.startsAt,
      endsAt: warranties.endsAt,
      status: warranties.status,
      terms: warranties.terms,
      voidReason: warranties.voidReason,
      phone: warranties.phoneE164,
      usedUnitId: warranties.usedUnitId,
      serial: serials.serial,
      name: orderItems.nameSnapshot,
      orderRef: orders.ref,
      contactName: orders.contactName,
      specs: products.specs,
    })
    .from(warranties)
    .innerJoin(orderItems, eq(orderItems.id, warranties.orderItemId))
    .innerJoin(orders, eq(orders.id, orderItems.orderId))
    .innerJoin(variants, eq(variants.id, orderItems.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(serials, eq(serials.id, warranties.serialId))
    .where(eq(warranties.id, warrantyId))
    .get();
  if (!row) throw notFound("warranty");
  const [tickets, rmas, history] = await Promise.all([
    db
      .select()
      .from(repairTickets)
      .where(or(eq(repairTickets.warrantyId, row.id), row.serialId ? eq(repairTickets.serialId, row.serialId) : sql`0`))
      .orderBy(desc(repairTickets.createdAt)),
    db
      .selectDistinct({ rma: returns.rma, status: returns.status, createdAt: returns.createdAt })
      .from(returnItems)
      .innerJoin(returns, eq(returns.id, returnItems.returnId))
      .where(and(eq(returnItems.orderItemId, row.orderItemId), row.serialId ? eq(returnItems.serialId, row.serialId) : undefined))
      .orderBy(desc(returns.createdAt)),
    db
      .select()
      .from(auditEvents)
      .where(and(eq(auditEvents.entityType, "warranty"), eq(auditEvents.entityId, row.id)))
      .orderBy(asc(auditEvents.seq))
      .limit(100),
  ]);
  const names = await employeeNames(
    db,
    history.map((event) => event.actorId),
  );
  return {
    id: row.id,
    itemName: lineName(row.name, locale),
    orderRef: row.orderRef,
    serial: row.serial ?? null,
    customerName: row.contactName ?? null,
    phone: phoneView(actor, row.phone),
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    state: stateOf(row, now),
    repairs: tickets.length,
    isUsed: row.usedUnitId !== null,
    terms: row.terms ? pick(row.terms, locale) || null : null,
    voidReason: row.voidReason,
    makerWarranty: makerWarranty(row.specs, locale),
    orderItemId: row.orderItemId,
    serialId: row.serialId,
    service: tickets.map((ticket) => ({
      id: ticket.id,
      ref: ticket.ref,
      status: ticket.status as RepairStatusKey,
      createdAt: ticket.createdAt,
      deliveredAt: ticket.deliveredAt,
      issue: ticket.issue,
      diagnosis: ticket.diagnosis,
      parts: partsOf(ticket.parts).map((part) => ({ variantId: part.variantId ?? null, name: part.name, qty: part.qty, priceIqd: part.priceIqd, fromStock: false })),
    })),
    replacedParts: tickets.flatMap((ticket) => partsOf(ticket.parts).map((part) => ({ ticketRef: ticket.ref, name: part.name, qty: part.qty, at: ticket.completedAt ?? ticket.updatedAt }))),
    returns: rmas.map((entry) => ({ rma: entry.rma, status: entry.status as RmaStatus, createdAt: entry.createdAt })),
    history: history.map((event) => ({
      id: event.id,
      at: event.at,
      action: event.action,
      actor: { kind: event.actorKind, name: event.actorKind === "employee" && event.actorId ? (names.get(event.actorId) ?? event.actorLabel ?? null) : (event.actorLabel ?? null) },
      reason: event.reason,
      summary: null,
    })),
    can: { manage: can(actor, "returns.warranty.manage") },
  };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const BAGHDAD_MS = 3 * HOUR_MS;

/** The last millisecond of a Baghdad calendar day, or null for anything that is not a real date. */
export function endOfBaghdadDay(day: string): number | null {
  if (!DAY.test(day)) return null;
  const [y, m, d] = day.split("-").map(Number);
  const start = Date.UTC(y, m - 1, d);
  const check = new Date(start);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== m - 1 || check.getUTCDate() !== d) return null;
  return start - BAGHDAD_MS + DAY_MS - 1;
}

export const ExtendInput = z.object({ warrantyId: z.string().regex(ID, "invalid"), endsOn: z.string().trim().min(1, "required").max(10, "invalid"), reason: z.string().trim().min(3, "required").max(500, "too_long") });

/** Moves a warranty's end later (goodwill, a repair's own warranty, a decision by the owner). Never earlier; never a void one. */
export async function extendWarranty(db: Db, actor: Actor, raw: z.input<typeof ExtendInput>, now: number): Promise<{ endsAt: number }> {
  assertCan(actor, "returns.warranty.manage");
  const input = ExtendInput.parse(raw);
  const endsAt = endOfBaghdadDay(input.endsOn.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0)));
  if (endsAt === null) throw invalid({ endsOn: "invalid" });
  const row = await db.select().from(warranties).where(eq(warranties.id, input.warrantyId)).get();
  if (!row) throw notFound("warranty");
  if (row.status === "void") throw new AppError("warranty_void", 409, { detail: row.id });
  if (endsAt <= row.endsAt || endsAt <= now) throw invalid({ endsOn: "not_later" });
  try {
    await runBatch(db, [
      db
        .update(warranties)
        .set({ endsAt, status: "active" })
        .where(and(eq(warranties.id, row.id), eq(warranties.endsAt, row.endsAt), inArray(warranties.status, ["active", "expired"]))),
      expectChanged(db, 1, { code: "WARRANTY_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "returns.warranty.extend", entityType: "warranty", entityId: row.id, before: { endsAt: row.endsAt, status: row.status }, after: { endsAt, status: "active" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "WARRANTY_CHANGED")) throw new AppError("warranty_changed", 409, { detail: row.id, cause: error });
    throw error;
  }
  return { endsAt };
}

export const VoidInput = z.object({ warrantyId: z.string().regex(ID, "invalid"), reason: z.string().trim().min(3, "required").max(500, "too_long") });

/** Ends a warranty for a reason (tampering, a unit returned outside an RMA…). The customer keeps the reason on record. */
export async function voidWarranty(db: Db, actor: Actor, raw: z.input<typeof VoidInput>, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "returns.warranty.manage");
  const input = VoidInput.parse(raw);
  const row = await db.select().from(warranties).where(eq(warranties.id, input.warrantyId)).get();
  if (!row) throw notFound("warranty");
  if (row.status === "void") return { replayed: true };
  await runBatch(db, [
    db
      .update(warranties)
      .set({ status: "void", voidReason: input.reason })
      .where(and(eq(warranties.id, row.id), inArray(warranties.status, ["active", "expired"]))),
    expectChanged(db, 1, { code: "WARRANTY_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "returns.warranty.void", entityType: "warranty", entityId: row.id, before: { status: row.status }, after: { status: "void" }, reason: input.reason, at: now }),
  ]);
  return { replayed: false };
}
