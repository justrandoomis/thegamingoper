/**
 * Admin 08 — the module's one queue of decisions: coupon and rule terms beyond the limits, flash sales whose prices
 * need a second person by pricing's rules, large gift cards and large point adjustments. Each card links to the page
 * that decides it; the requester sees their own requests (to withdraw them) and never a decide button.
 *
 *   listApprovals(db, actor, locale) → { decide: ApprovalCard[]; mine: ApprovalCard[] }
 *   countDecidable(db, actor) → number | null       for the admin bell (null: this employee decides none of them)
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { pick, type Locale } from "~/lib/locales";
import { can, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { approvals, coupons, customers, flashSales, promotions, type Approval } from "~/server/db/schema";
import { DECIDE_PERMISSIONS, PROMOTIONS_PERMISSIONS, assertAny, canDecideApproval, employeeNames, num } from "./shared.server";
import { APPROVAL_KINDS, type ApprovalCard, type PromotionApprovalKind } from "./types";

const kindsOf = (actor: Actor) => APPROVAL_KINDS.filter((kind) => DECIDE_PERMISSIONS[kind].every((permission) => can(actor, permission)));

async function pendingRows(db: Db): Promise<Approval[]> {
  return db
    .select()
    .from(approvals)
    .where(and(inArray(approvals.kind, [...APPROVAL_KINDS]), eq(approvals.status, "pending")))
    .orderBy(desc(approvals.createdAt))
    .limit(500);
}

/** For the bell: how many of the module's requests this employee may decide now. */
export async function countDecidable(db: Db, actor: Actor): Promise<number | null> {
  if (actor.kind !== "employee" || kindsOf(actor).length === 0) return null;
  const rows = await pendingRows(db);
  return rows.filter((row) => canDecideApproval(actor, row)).length;
}

export async function listApprovals(db: Db, actor: Actor, locale: Locale, format: { iqd: (value: number) => string; percent: (bps: number) => string; points: (value: number) => string }): Promise<{ decide: ApprovalCard[]; mine: ApprovalCard[] }> {
  assertAny(actor, PROMOTIONS_PERMISSIONS);
  const rows = (await pendingRows(db)).filter((row) => canDecideApproval(actor, row) || (actor.kind === "employee" && row.requestedBy === actor.id));
  const ids = (kind: PromotionApprovalKind) => [...new Set(rows.filter((row) => row.kind === kind && row.entityId).map((row) => row.entityId as string))];
  // D1 binds at most 100 parameters per statement: names are read in parts (up to 500 requests wait at once)
  const inParts = async <T>(list: string[], read: (part: string[]) => Promise<T[]>): Promise<T[]> => {
    const out: T[] = [];
    for (let i = 0; i < list.length; i += 90) out.push(...(await read(list.slice(i, i + 90))));
    return out;
  };
  const [couponRows, ruleRows, saleRows, customerRows, names] = await Promise.all([
    inParts(ids("coupon"), (part) => db.select({ id: coupons.id, code: coupons.code }).from(coupons).where(inArray(coupons.id, part))),
    inParts(ids("promotion_rule"), (part) => db.select({ id: promotions.id, name: promotions.name }).from(promotions).where(inArray(promotions.id, part))),
    inParts(ids("flash_sale"), (part) => db.select({ id: flashSales.id, name: flashSales.name }).from(flashSales).where(inArray(flashSales.id, part))),
    inParts(ids("loyalty_adjustment"), (part) => db.select({ id: customers.id, name: customers.name }).from(customers).where(inArray(customers.id, part))),
    employeeNames(db, rows.map((row) => row.requestedBy)),
  ]);
  const couponOf = new Map(couponRows.map((row) => [row.id, row.code]));
  const ruleOf = new Map(ruleRows.map((row) => [row.id, pick(row.name, locale)]));
  const saleOf = new Map(saleRows.map((row) => [row.id, pick(row.name, locale)]));
  const customerOf = new Map(customerRows.map((row) => [row.id, row.name]));
  const margins = can(actor, "cost.read") && can(actor, "profit.read");
  const cards = rows.map((row): ApprovalCard => {
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const kind = row.kind as PromotionApprovalKind;
    const entity = row.entityId ?? "";
    const facts: ApprovalCard["facts"] = [];
    let title = entity;
    let href = "/admin/promotions/approvals";
    switch (kind) {
      case "coupon": {
        title = couponOf.get(entity) ?? entity;
        href = `/admin/promotions/coupons/${entity}`;
        const terms = payload.terms as { kind?: string; value?: number; maxDiscountIqd?: number | null } | undefined;
        if (terms?.kind === "percent" && typeof terms.value === "number") facts.push({ label: "percent", value: format.percent(terms.value) });
        if (terms?.kind === "fixed" && typeof terms.value === "number") facts.push({ label: "amount", value: format.iqd(terms.value) });
        if (typeof terms?.maxDiscountIqd === "number") facts.push({ label: "ceiling", value: format.iqd(terms.maxDiscountIqd) });
        if (typeof payload.action === "string") facts.push({ label: "action", value: payload.action });
        break;
      }
      case "promotion_rule":
        title = ruleOf.get(entity) ?? entity;
        href = `/admin/promotions/rules/${entity}`;
        if (typeof payload.action === "string") facts.push({ label: "action", value: payload.action });
        break;
      case "flash_sale":
        title = saleOf.get(entity) ?? entity;
        href = `/admin/promotions/flash/${entity}`;
        facts.push({ label: "items", value: String(num(payload.items)) });
        // "under the cost or the minimum margin" is a cost fact: pricing 03 shows it with profit.read only
        if (payload.needsOverride && margins) facts.push({ label: "override", value: "1" });
        break;
      case "gift_card":
        title = format.iqd(num(payload.amountIqd));
        href = "/admin/promotions/gift-cards";
        facts.push({ label: "amount", value: format.iqd(num(payload.amountIqd)) });
        break;
      case "loyalty_adjustment":
        title = customerOf.get(entity) ?? entity;
        href = `/admin/promotions/points/${entity}`;
        facts.push({ label: "points", value: format.points(num(payload.points)) });
        break;
    }
    return { id: row.id, kind, title, href, requestedBy: names.get(row.requestedBy) ?? null, requestedAt: row.createdAt, reason: row.reason, facts, mine: actor.kind === "employee" && row.requestedBy === actor.id, canDecide: canDecideApproval(actor, row) };
  });
  return { decide: cards.filter((card) => card.canDecide), mine: cards.filter((card) => card.mine) };
}
