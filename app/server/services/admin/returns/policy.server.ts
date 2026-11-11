/**
 * Return eligibility (blueprint 12.02): the store's rules by product kind, category and condition (new / used), the
 * return window from delivery, the seal requirement and the restocking fee — and the verdict for each line of an
 * order. The rules live in `return_policies`; with no rule the general window `returns.window_days` (settings) applies.
 *
 *   const lines = await evaluateOrder(db, order, now, { sealed, reasonCode });   // Map orderItemId → Eligibility & facts
 *   await savePolicy(db, actor, raw, now);                                       // returns.policy.manage, audited
 *
 * WHICH RULE: the most specific ACTIVE rule wins — one on the product's category (or the nearest parent category),
 * then one on its kind, then a catch-all ("*"); a rule for "new" or "used" beats one for both; ties go by `sort`.
 * Rules are never deleted (switched off instead), so an old verdict can still be explained.
 *
 * VERDICT: not delivered → not_delivered · past the window → window_closed · rule says not returnable →
 * not_returnable · the rule requires a sealed item, the item is not sealed and the reason is not the store's fault
 * (defective, damaged in delivery, wrong item, not as described) → seal_required · every unit already in a return or
 * refunded → nothing_left. Opening an RMA despite a problem needs returns.rma.approve and a reason (rma.server).
 */
import { asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { categories, orderItems, orderItemSerials, products, returnPolicies, serials, usedUnits, variants, PRODUCT_KIND_SCOPES, type Order, type ReturnPolicy } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { forbidden, invalid, notFound } from "~/server/errors";
import { newId } from "~/lib/ids";
import { getSetting } from "~/server/settings.server";
import { DAY_MS, lineName, unitsTaken, unitValues } from "./shared.server";
import { isFaultReason, type EligibleLine, type Eligibility, type PolicyView, type ReasonCode } from "./types";

type Facts = { kind: string | null; categoryChain: string[]; isUsed: boolean };

function specificity(rule: ReturnPolicy, facts: Facts): number | null {
  if (!rule.isActive) return null;
  if (rule.itemCondition !== "*" && rule.itemCondition !== (facts.isUsed ? "used" : "new")) return null;
  if (rule.productKind !== "*" && rule.productKind !== facts.kind) return null;
  let score = 0;
  if (rule.categoryId) {
    const at = facts.categoryChain.indexOf(rule.categoryId);
    if (at < 0) return null;
    score += 1000 - at * 10;
  }
  if (rule.productKind !== "*") score += 100;
  if (rule.itemCondition !== "*") score += 1;
  return score;
}

/** The rule that decides for a line, or null (the store's general window then applies). */
export function pickRule(rules: readonly ReturnPolicy[], facts: Facts): ReturnPolicy | null {
  let best: { rule: ReturnPolicy; score: number } | null = null;
  for (const rule of rules) {
    const score = specificity(rule, facts);
    if (score === null) continue;
    if (!best || score > best.score || (score === best.score && (rule.sort < best.rule.sort || (rule.sort === best.rule.sort && rule.id < best.rule.id)))) best = { rule, score };
  }
  return best?.rule ?? null;
}

/** The verdict for one line (pure; the facts are loaded by evaluateOrder). */
export function verdict(input: {
  orderStatus: string;
  deliveredAt: number | null;
  at: number;
  rule: ReturnPolicy | null;
  settingWindowDays: number;
  returnableQty: number;
  sealed?: boolean | null;
  reasonCode?: ReasonCode | null;
  locale: Locale;
}): Eligibility {
  const { rule } = input;
  const windowDays = rule?.windowDays ?? input.settingWindowDays;
  const windowEndsAt = input.deliveredAt === null ? null : input.deliveredAt + windowDays * DAY_MS;
  const problems: Eligibility["problems"] = [];
  if (input.orderStatus !== "delivered" || input.deliveredAt === null) problems.push("not_delivered");
  else if (windowEndsAt !== null && input.at > windowEndsAt) problems.push("window_closed");
  if (rule && !rule.isReturnable) problems.push("not_returnable");
  const requiresSealed = rule?.requiresSealed ?? false;
  if (requiresSealed && input.sealed === false && !isFaultReason(input.reasonCode)) problems.push("seal_required");
  if (input.returnableQty <= 0) problems.push("nothing_left");
  return {
    eligible: problems.length === 0,
    problems,
    windowDays,
    windowEndsAt,
    daysSinceDelivery: input.deliveredAt === null ? null : Math.max(0, Math.floor((input.at - input.deliveredAt) / DAY_MS)),
    requiresSealed,
    restockingFeeBps: rule?.restockingFeeBps ?? 0,
    rule: {
      id: rule?.id ?? null,
      source: !rule ? "setting" : rule.categoryId ? "category" : rule.productKind !== "*" ? "kind" : "catch_all",
      note: rule?.note ? pick(rule.note, input.locale) || null : null,
    },
  };
}

/** Category id → the chain from itself up to the root (closest first). */
async function categoryChains(db: Db, ids: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (ids.length === 0) return out;
  const all = await db.select({ id: categories.id, parentId: categories.parentId }).from(categories);
  const parent = new Map(all.map((row) => [row.id, row.parentId]));
  for (const id of ids) {
    const chain: string[] = [];
    let at: string | null | undefined = id;
    while (at && chain.length < 8 && !chain.includes(at)) {
      chain.push(at);
      at = parent.get(at);
    }
    out.set(id, chain);
  }
  return out;
}

/**
 * Every line of an order with its returnable quantity, value per unit, serials and verdict at `at`. `sealed` (per
 * order item) and `reasonCode` refine the seal rule; `exceptReturnId` leaves one return's own units out of "taken".
 */
export async function evaluateOrder(
  db: Db,
  order: Order,
  at: number,
  locale: Locale,
  options: { sealed?: ReadonlyMap<string, boolean>; reasonCode?: ReasonCode | null; exceptReturnId?: string | null } = {},
): Promise<EligibleLine[]> {
  const lines = await db
    .select({
      id: orderItems.id,
      name: orderItems.nameSnapshot,
      sku: orderItems.sku,
      qty: orderItems.qty,
      usedUnitId: orderItems.usedUnitId,
      variantId: orderItems.variantId,
      kind: products.kind,
      categoryId: products.categoryId,
    })
    .from(orderItems)
    .innerJoin(variants, eq(variants.id, orderItems.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(orderItems.orderId, order.id))
    .orderBy(asc(orderItems.id));
  const ids = lines.map((line) => line.id);
  const [rules, windowDays, taken, values, attached, usedSerials, chains] = await Promise.all([
    db.select().from(returnPolicies).where(eq(returnPolicies.isActive, true)),
    getSetting(db, "returns.window_days"),
    unitsTaken(db, ids, options.exceptReturnId ?? null),
    unitValues(db, order),
    ids.length
      ? db
          .select({ orderItemId: orderItemSerials.orderItemId, id: serials.id, serial: serials.serial, releasedAt: orderItemSerials.releasedAt })
          .from(orderItemSerials)
          .innerJoin(serials, eq(serials.id, orderItemSerials.serialId))
          .where(inArray(orderItemSerials.orderItemId, ids))
      : Promise.resolve([]),
    ids.length
      ? db
          .select({ orderItemId: orderItems.id, id: serials.id, serial: serials.serial })
          .from(orderItems)
          .innerJoin(usedUnits, eq(usedUnits.id, orderItems.usedUnitId))
          .innerJoin(serials, eq(serials.id, usedUnits.serialId))
          .where(inArray(orderItems.id, ids))
      : Promise.resolve([]),
    categoryChains(db, [...new Set(lines.map((line) => line.categoryId).filter((id): id is string => typeof id === "string"))]),
  ]);
  return lines.map((line) => {
    const returnableQty = Math.max(0, line.qty - (taken.get(line.id) ?? 0));
    const rule = pickRule(rules, { kind: line.kind, categoryChain: line.categoryId ? (chains.get(line.categoryId) ?? [line.categoryId]) : [], isUsed: line.usedUnitId !== null });
    const lineSerials = [
      ...attached.filter((row) => row.orderItemId === line.id && row.releasedAt === null).map((row) => ({ id: row.id, serial: row.serial })),
      ...usedSerials.filter((row) => row.orderItemId === line.id).map((row) => ({ id: row.id, serial: row.serial })),
    ];
    return {
      orderItemId: line.id,
      name: lineName(line.name, locale),
      sku: line.sku,
      qty: line.qty,
      returnableQty,
      unitValueIqd: values.get(line.id) ?? 0,
      isUsed: line.usedUnitId !== null,
      productKind: line.kind,
      serials: [...new Map(lineSerials.map((entry) => [entry.id, entry])).values()],
      eligibility: verdict({ orderStatus: order.status, deliveredAt: order.deliveredAt, at, rule, settingWindowDays: windowDays, returnableQty, sealed: options.sealed?.get(line.id) ?? null, reasonCode: options.reasonCode ?? null, locale }),
    };
  });
}

// ───────────────────────────────────────────────────────────────── the rules screen

export async function listPolicies(db: Db, actor: Actor, locale: Locale): Promise<{ rules: PolicyView[]; windowDays: number; categories: { id: string; name: string }[]; canManage: boolean }> {
  if (!canAny(actor, ["returns.rma.read", "returns.rma.create", "returns.policy.manage"])) throw forbidden("returns.rma.read");
  const [rows, windowDays, cats] = await Promise.all([
    db.select().from(returnPolicies).orderBy(asc(returnPolicies.sort), asc(returnPolicies.id)),
    getSetting(db, "returns.window_days"),
    db.select({ id: categories.id, name: categories.name, isActive: categories.isActive }).from(categories).orderBy(asc(categories.sort), asc(categories.slug)),
  ]);
  const catName = new Map(cats.map((cat) => [cat.id, pick(cat.name, locale)]));
  return {
    rules: rows.map((row) => ({
      id: row.id,
      productKind: row.productKind,
      categoryId: row.categoryId,
      categoryName: row.categoryId ? (catName.get(row.categoryId) ?? null) : null,
      itemCondition: row.itemCondition,
      isReturnable: row.isReturnable,
      windowDays: row.windowDays,
      requiresSealed: row.requiresSealed,
      restockingFeeBps: row.restockingFeeBps,
      note: row.note ? { ar: row.note.ar, en: row.note.en ?? null, ckb: row.note.ckb ?? null } : null,
      sort: row.sort,
      isActive: row.isActive,
    })),
    windowDays,
    categories: cats.filter((cat) => cat.isActive).map((cat) => ({ id: cat.id, name: pick(cat.name, locale) })),
    canManage: canAny(actor, ["returns.policy.manage"]),
  };
}

const noteText = z
  .string()
  .trim()
  .max(500, "too_long")
  .optional()
  .transform((value) => value || null);

export const PolicyInput = z.object({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "invalid").optional(),
  productKind: z.enum(PRODUCT_KIND_SCOPES, "invalid"),
  categoryId: z
    .string()
    .trim()
    .max(128)
    .optional()
    .transform((value) => value || null),
  itemCondition: z.enum(["*", "new", "used"], "invalid"),
  isReturnable: z.boolean(),
  /** Empty = the store's general window. */
  windowDays: z.number().int("invalid").min(0, "too_small").max(365, "too_big").nullable(),
  requiresSealed: z.boolean(),
  /** Basis points of the item value kept by the store on a change-of-mind return (at most half). */
  restockingFeeBps: z.number().int("invalid").min(0, "too_small").max(5000, "too_big"),
  note: z.object({ ar: noteText, en: noteText, ckb: noteText }),
  sort: z.number().int("invalid").min(0, "too_small").max(10_000, "too_big"),
  isActive: z.boolean(),
  reason: z.string().trim().min(3, "required").max(500, "too_long"),
});
export type PolicyInput = z.input<typeof PolicyInput>;

/** Creates or changes a rule (returns.policy.manage), with its before and after in the audit trail. */
export async function savePolicy(db: Db, actor: Actor, raw: PolicyInput, now: number): Promise<{ id: string; created: boolean }> {
  assertCan(actor, "returns.policy.manage");
  const input = PolicyInput.parse(raw);
  if (input.categoryId) {
    const cat = await db.select({ id: categories.id }).from(categories).where(eq(categories.id, input.categoryId)).get();
    if (!cat) throw invalid({ categoryId: "invalid" });
  }
  if (input.note.en && !input.note.ar) throw invalid({ "note.ar": "required" });
  const note = input.note.ar ? { ar: input.note.ar, ...(input.note.en ? { en: input.note.en } : {}), ...(input.note.ckb ? { ckb: input.note.ckb } : {}) } : null;
  const values = {
    productKind: input.productKind,
    categoryId: input.categoryId,
    itemCondition: input.itemCondition,
    isReturnable: input.isReturnable,
    windowDays: input.windowDays,
    requiresSealed: input.requiresSealed,
    restockingFeeBps: input.restockingFeeBps,
    note,
    sort: input.sort,
    isActive: input.isActive,
  };
  if (input.id) {
    const before = await db.select().from(returnPolicies).where(eq(returnPolicies.id, input.id)).get();
    if (!before) throw notFound("return_policy");
    await runBatch(db, [
      db.update(returnPolicies).set(values).where(eq(returnPolicies.id, input.id)),
      auditStatement(db, { actor, action: "returns.policy.update", entityType: "return_policy", entityId: input.id, before, after: values, reason: input.reason, at: now }),
    ]);
    return { id: input.id, created: false };
  }
  const id = newId("rpl");
  await runBatch(db, [
    db.insert(returnPolicies).values({ id, ...values }),
    auditStatement(db, { actor, action: "returns.policy.create", entityType: "return_policy", entityId: id, after: values, reason: input.reason, at: now }),
  ]);
  return { id, created: true };
}
