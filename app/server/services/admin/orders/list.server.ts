/**
 * The order list (05.01 / 05.02 entry point) and the module's queue counts.
 *
 *   const page = await listOrders(db, actor, parseListFilters(url.searchParams), ctx.locale, ctx.now);   // orders.order.read
 *   const counts = await orderCounts(db, actor, ctx.now);
 *
 * Filters come from the URL (./types parseListFilters): free text (order reference, a whole phone number, phone
 * digits — only with customer.phone.read_full — or name), status, payment status and method, governorate, Baghdad
 * dates, flags (late / suspicious per the review rules, on hold, pre-order), assigned to me / nobody; sorted by date
 * or total; 25 per page. Phone numbers are masked unless the employee holds customer.phone.read_full. No cost data is
 * ever selected here.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import { normalizeIraqPhone, toLatinDigits } from "~/lib/phone";
import { customerProfileId } from "~/routes/admin/shell/access.server";
import { assertCan, can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { governorates, orders, payments, refunds } from "~/server/db/schema";
import { anyRule, riskFlagsOf, unresolvedFlags } from "./risk.server";
import { employeeNames, governorateNames, phoneFor } from "./shared.server";
import { LATE_RULES, LIST_PAGE_SIZE, OPEN_STATUSES, RISK_RULE_IDS, SUSPICIOUS_RULES, type OrderListFilters, type OrderListPage, type OrderListRow } from "./types";

const HOUR = 60 * 60 * 1000;
const BAGHDAD_OFFSET = 3 * HOUR;

/** Start of a Baghdad calendar day ("2026-11-11") in epoch ms. */
export function baghdadDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - BAGHDAD_OFFSET;
}

const likeEscape = (value: string) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

/** The WHERE of the list for these filters (shared by the list, its count and the CSV export). */
export function listWhere(filters: OrderListFilters, actor: Actor, now: number): SQL | undefined {
  const conditions: SQL[] = [];
  const q = toLatinDigits(filters.q).trim();
  if (q) {
    // D1 refuses LIKE patterns longer than 50 bytes ("pattern too complex"): needles stay short (Arabic = 2 bytes a letter).
    const needle = q.slice(0, 20);
    const upper = needle.toUpperCase();
    const digits = q.replace(/\D/g, "").slice(0, 15);
    const phone = normalizeIraqPhone(q);
    const options: SQL[] = [sql`${orders.ref} LIKE ${`%${likeEscape(upper)}%`} ESCAPE '\\'`];
    if (phone) options.push(eq(orders.contactPhoneE164, phone));
    // Some digits of a number match only for employees who may see whole numbers: for anyone else the list shows
    // "0771 ••• ••52", and a digits search would confirm the hidden digits one query at a time.
    else if (digits.length >= 4 && can(actor, "customer.phone.read_full")) options.push(sql`${orders.contactPhoneE164} LIKE ${`%${likeEscape(digits.replace(/^0/, ""))}%`} ESCAPE '\\'`);
    if (/\p{L}/u.test(needle)) options.push(sql`${orders.contactName} LIKE ${`%${likeEscape(needle)}%`} ESCAPE '\\'`);
    conditions.push(or(...options) as SQL);
  }
  if (filters.status.length) conditions.push(inArray(orders.status, filters.status));
  if (filters.payment.length) conditions.push(inArray(orders.paymentStatus, filters.payment));
  if (filters.method.length) conditions.push(inArray(orders.paymentMethod, filters.method));
  if (filters.governorate) conditions.push(eq(orders.governorateId, filters.governorate));
  if (filters.from) conditions.push(gte(orders.placedAt, baghdadDayStart(filters.from)));
  if (filters.to) conditions.push(lte(orders.placedAt, baghdadDayStart(filters.to) + 24 * HOUR - 1));
  if (filters.flags.includes("late")) conditions.push(anyRule(now, LATE_RULES));
  if (filters.flags.includes("suspicious")) conditions.push(anyRule(now, SUSPICIOUS_RULES));
  if (filters.flags.includes("on_hold")) conditions.push(eq(orders.reviewStatus, "blocked"));
  if (filters.flags.includes("preorder")) conditions.push(eq(orders.isPreorder, true));
  if (filters.assigned === "me" && actor.kind === "employee") conditions.push(eq(orders.assignedTo, actor.id));
  if (filters.assigned === "unassigned") conditions.push(isNull(orders.assignedTo));
  return conditions.length ? and(...conditions) : undefined;
}

function listOrder(filters: OrderListFilters) {
  switch (filters.sort) {
    case "placed_asc":
      return [asc(orders.placedAt), asc(orders.id)];
    case "total_desc":
      return [desc(orders.totalIqd), desc(orders.placedAt)];
    case "total_asc":
      return [asc(orders.totalIqd), desc(orders.placedAt)];
    default:
      return [desc(orders.placedAt), desc(orders.id)];
  }
}

export async function listOrders(db: Db, actor: Actor, filters: OrderListFilters, locale: Locale, now: number): Promise<OrderListPage> {
  assertCan(actor, "orders.order.read");
  const where = listWhere(filters, actor, now);
  const [countRow, govs] = await Promise.all([db.select({ n: sql<number>`count(*)` }).from(orders).where(where).get(), governorateNames(db, locale)]);
  const total = Number(countRow?.n ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / LIST_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await db
    .select({
      id: orders.id,
      ref: orders.ref,
      placedAt: orders.placedAt,
      status: orders.status,
      paymentStatus: orders.paymentStatus,
      paymentMethod: orders.paymentMethod,
      totalIqd: orders.totalIqd,
      paidIqd: orders.paidIqd,
      contactName: orders.contactName,
      customerId: orders.customerId,
      phone: orders.contactPhoneE164,
      governorate: governorates.name,
      assignedTo: orders.assignedTo,
      reviewStatus: orders.reviewStatus,
      isPreorder: orders.isPreorder,
      isDemo: orders.isDemo,
      units: sql<number>`(SELECT coalesce(sum(oi.qty), 0) FROM order_items oi WHERE oi.order_id = ${orders.id})`,
    })
    .from(orders)
    .leftJoin(governorates, eq(governorates.id, orders.governorateId))
    .where(where)
    .orderBy(...listOrder(filters))
    .limit(LIST_PAGE_SIZE)
    .offset((page - 1) * LIST_PAGE_SIZE);

  const [flags, names] = await Promise.all([
    riskFlagsOf(
      db,
      rows.map((row) => row.id),
      now,
    ),
    employeeNames(
      db,
      rows.map((row) => row.assignedTo),
    ),
  ]);
  const out: OrderListRow[] = rows.map((row) => ({
    id: row.id,
    ref: row.ref,
    placedAt: row.placedAt,
    status: row.status,
    paymentStatus: row.paymentStatus,
    paymentMethod: row.paymentMethod,
    totalIqd: row.totalIqd,
    paidIqd: row.paidIqd,
    units: Number(row.units),
    contactName: row.contactName,
    customerProfileId: customerProfileId(actor, row.customerId),
    phone: phoneFor(actor, row.phone),
    governorate: row.governorate ? pick(row.governorate, locale) : null,
    assignedTo: row.assignedTo ? { id: row.assignedTo, name: names.get(row.assignedTo) ?? row.assignedTo } : null,
    reviewStatus: row.reviewStatus,
    isPreorder: row.isPreorder,
    isDemo: row.isDemo,
    // Every flag the rules raise now; the review status says whether a person has looked at them.
    flags: flags.get(row.id) ?? [],
  }));
  return { rows: out, total, page, pageCount, filters: { ...filters, page }, governorates: govs };
}

export type OrderCounts = {
  /** Transfer proofs waiting for a decision (orders.payment.verify). */
  proofs: number | null;
  /** Refunds waiting for a second person — not this employee's own requests (orders.refund.approve). */
  refunds: number | null;
  /** Open orders flagged and not yet reviewed, or on hold (orders.risk.review). */
  review: number | null;
  /** Orders to pack: confirmed or being prepared (orders.fulfillment.pack). */
  toPack: number | null;
  /** …of which assigned to this employee. */
  mine: number | null;
  /** Open orders that a "late" rule flags. */
  late: number;
};

/** The numbers on the module's front page, each only for employees who can act on it. */
export async function orderCounts(db: Db, actor: Actor, now: number): Promise<OrderCounts> {
  assertCan(actor, "orders.order.read");
  const me = actor.kind === "employee" ? actor.id : "";
  const canVerify = can(actor, "orders.payment.verify");
  const canApprove = can(actor, "orders.refund.approve");
  const canPack = can(actor, "orders.fulfillment.pack");
  const [proofs, refundRows, packRows, late] = await Promise.all([
    canVerify ? db.select({ n: sql<number>`count(*)` }).from(payments).where(eq(payments.status, "pending_verification")).get() : Promise.resolve(null),
    canApprove
      ? db
          .select({ n: sql<number>`count(*)` })
          .from(refunds)
          .where(and(eq(refunds.status, "pending"), sql`(${refunds.createdBy} IS NULL OR ${refunds.createdBy} <> ${me})`))
          .get()
      : Promise.resolve(null),
    canPack
      ? db
          .select({ n: sql<number>`count(*)`, mine: sql<number>`coalesce(sum(CASE WHEN ${orders.assignedTo} = ${me} THEN 1 ELSE 0 END), 0)` })
          .from(orders)
          .where(inArray(orders.status, ["confirmed", "preparing"]))
          .get()
      : Promise.resolve(null),
    db
      .select({ n: sql<number>`count(*)` })
      .from(orders)
      .where(and(inArray(orders.status, [...OPEN_STATUSES]), anyRule(now, LATE_RULES)))
      .get(),
  ]);
  let review: number | null = null;
  if (can(actor, "orders.risk.review")) {
    const candidates = await db
      .select({ id: orders.id, reviewStatus: orders.reviewStatus, riskFlags: orders.riskFlags })
      .from(orders)
      .where(and(inArray(orders.status, [...OPEN_STATUSES]), sql`(${anyRule(now, RISK_RULE_IDS)} OR ${orders.reviewStatus} IN ('needs_review', 'blocked'))`))
      .limit(500);
    const flags = await riskFlagsOf(
      db,
      candidates.map((row) => row.id),
      now,
    );
    review = candidates.filter((row) => row.reviewStatus === "blocked" || row.reviewStatus === "needs_review" || unresolvedFlags(flags.get(row.id) ?? [], row.reviewStatus, row.riskFlags).length > 0).length;
  }
  return {
    proofs: proofs ? Number(proofs.n) : null,
    refunds: refundRows ? Number(refundRows.n) : null,
    review,
    toPack: packRows ? Number(packRows.n) : null,
    mine: packRows ? Number(packRows.mine) : null,
    late: Number(late?.n ?? 0),
  };
}
