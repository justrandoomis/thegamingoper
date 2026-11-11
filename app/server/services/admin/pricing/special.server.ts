/**
 * Separate pricing for bundle offers, clearance and used devices (admin 03.07).
 *
 *   bundles     a bundle SKU against what its components cost bought one by one, and against the sum of the
 *               components' landed costs when it has no cost of its own (facts.server costBasisFor)
 *   clearance   stock on hand with no sale for 90 days (and older than 90 days by its FIFO layers): the candidates.
 *               A clearance price is a price change in mode "clearance" (prices.server): its floor is the landed
 *               cost instead of the minimum margin, it ALWAYS needs a second person, and under the landed cost it
 *               needs pricing.discount.override as well
 *   used        each used unit has its own price (used_units.price_iqd); its cost is what the store paid for it
 *               (acquisition cost, cost.read). Changing it needs pricing.used.update and follows the SKU rules of
 *               03.05 (rules.ts → evaluatePriceChange): a rise, or a cut of at most 10 % from the highest price of the
 *               last 30 days (since the last approved change), above the acquisition cost, applies at once; a deeper
 *               cut, a price under the acquisition cost or a price for a unit without a recorded cost waits for a
 *               second person (`approvals` row, kind "used_price"): pricing.price.approve, plus
 *               pricing.discount.override under the cost. The requester never decides and may withdraw. One request
 *               per unit at a time. Units reserved for an order or sold keep their price (the order has its own
 *               snapshot anyway). Not a price_changes row (those are per SKU): the audit trail has it, and the 30-day
 *               reference is read from it (`pricing.used.price` / `pricing.used.approve`). An employee limited to a
 *               branch sees and prices the devices kept at that branch's locations only
 *
 * Error codes: forbidden (403), not_found (404), invalid (400), override_required (403), unit_not_priceable (409),
 * price_changed (409), change_pending (409), change_not_pending (409), approver_is_requester (403), not_requester (403),
 * note_required (400).
 */
import { and, desc, eq, gt, inArray, notInArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { assertBranch, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, auditEvents, employees, inventoryLocations, products, usedUnits, variants, USED_UNIT_STATUSES, type UsedGrade, type UsedUnitStatus } from "~/server/db/schema";
import { expectChanged, expectThat, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import type { Permission } from "~/server/permissions";
import { getSetting } from "~/server/settings.server";
import { actorId, assertAny, fieldAccess, type FieldAccess } from "./access";
import { bundleComponentsFor, chunks, costBasisFor, oldestStockDaysFor, salesFor } from "./facts.server";
import { formIqd, marginStateOf, querySkuRows, toSkuRow, visibleReasons, type MarginState, type PriceFilters, type SkuRow } from "./prices.server";
import { DAY_MS, DROP_WINDOW_DAYS, evaluatePriceChange, isOnStep, marginBps, MAX_PRICE_IQD, PRICE_STEP_IQD, SLOW_STOCK_DAYS, type ChangeReason, type CostBasis } from "./rules";

/** Who may open the special-pricing page (the route asks for the same list, so others get a 403, never a 500). */
export const SPECIAL_READERS = ["pricing.price.update", "pricing.price.approve", "pricing.used.update", "pricing.discount.override", "pricing.simulation.run", "pricing.suggestion.read", "pricing.cost.update", "pricing.margin.manage"] as const satisfies readonly Permission[];
const READERS = SPECIAL_READERS;

const allSkus = (view: PriceFilters["view"]): PriceFilters => ({ q: "", kind: null, platform: null, status: null, view, sort: "sku", dir: "asc", page: 1 });

// ───────────────────────────────────────────────────────────────── bundles

export type BundleView = SkuRow & {
  components: { variantId: string; sku: string; name: string; qty: number; priceIqd: number }[];
  /** What the components cost one by one (price × qty, summed). */
  separateIqd: number;
  /** separate − bundle price (positive = the bundle is cheaper). */
  savingIqd: number;
};

export async function listBundles(db: Db, actor: Actor, locale: Locale): Promise<{ bundles: BundleView[]; access: FieldAccess }> {
  assertAny(actor, READERS);
  const access = fieldAccess(actor);
  const rows = await querySkuRows(db, allSkus("bundles"), locale, 500);
  const parts = await bundleComponentsFor(db, rows.map((row) => row.variantId));
  const componentIds = [...new Set([...parts.values()].flatMap((list) => list.map((part) => part.componentVariantId)))];
  const componentRows = componentIds.length
    ? await db.select({ id: variants.id, sku: variants.sku, priceIqd: variants.priceIqd, name: products.name }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(inArray(variants.id, componentIds))
    : [];
  return {
    bundles: rows.map((row) => {
      const components = (parts.get(row.variantId) ?? []).map((part) => {
        const component = componentRows.find((candidate) => candidate.id === part.componentVariantId);
        return { variantId: part.componentVariantId, sku: component?.sku ?? part.componentVariantId, name: component ? pick(component.name, locale) : "", qty: part.qty, priceIqd: component?.priceIqd ?? 0 };
      });
      const separateIqd = components.reduce((sum, part) => sum + part.priceIqd * part.qty, 0);
      return { ...toSkuRow(row, access, locale), components, separateIqd, savingIqd: separateIqd - row.priceIqd };
    }),
    access,
  };
}

// ───────────────────────────────────────────────────────────────── clearance

export type ClearanceView = SkuRow & { lastSoldAt: number | null; oldestStockDays: number | null };

/**
 * SKUs with stock on hand and no sale in the last 90 days whose oldest stock is at least `minAgeDays` old (90 by
 * default; 0 lists every unsold SKU with stock). Demo orders do not count as sales.
 */
export async function listClearance(db: Db, actor: Actor, options: { minAgeDays?: number }, locale: Locale, now: number): Promise<{ items: ClearanceView[]; access: FieldAccess; minAgeDays: number }> {
  assertAny(actor, READERS);
  const access = fieldAccess(actor);
  const minAgeDays = Math.max(0, Math.min(options.minAgeDays ?? SLOW_STOCK_DAYS, 3650));
  const rows = (await querySkuRows(db, allSkus("all"), locale, 5_000)).filter((row) => row.onHand > 0 && row.isActive);
  const ids = rows.map((row) => row.variantId);
  const [sales, ages] = await Promise.all([salesFor(db, ids, now - SLOW_STOCK_DAYS * DAY_MS), oldestStockDaysFor(db, ids, now)]);
  const items = rows
    .filter((row) => (sales.get(row.variantId)?.unitsSold ?? 0) === 0)
    .filter((row) => (ages.get(row.variantId) ?? 0) >= minAgeDays)
    .map((row) => ({ ...toSkuRow(row, access, locale), lastSoldAt: sales.get(row.variantId)?.lastSoldAt ?? null, oldestStockDays: ages.get(row.variantId) ?? null }))
    .sort((a, b) => (b.oldestStockDays ?? 0) - (a.oldestStockDays ?? 0) || a.sku.localeCompare(b.sku));
  return { items, access, minAgeDays };
}

// ───────────────────────────────────────────────────────────────── used units

export const PRICEABLE_USED: readonly UsedUnitStatus[] = ["intake", "testing", "ready", "listed"];

/** `approvals.kind` of a used-unit price change waiting for a second person. */
const USED_KIND = "used_price";
type UsedPayload = { usedUnitId: string; slug: string; fromIqd: number; toIqd: number; reasons: ChangeReason[] };

/** A used-unit price change waiting for a second person. */
export type UsedPriceRequest = {
  id: string;
  fromIqd: number;
  toIqd: number;
  /** Reasons the viewer may see (the cost-based ones only with profit.read). */
  reasons: ChangeReason[];
  /** profit.read only: deciding it also needs pricing.discount.override. */
  needsOverride?: boolean;
  requestedBy: { id: string; name: string } | null;
  reason: string | null;
  createdAt: number;
  /** The viewer asked for it: they may withdraw it, never decide it. */
  mine: boolean;
};

export type UsedView = {
  id: string;
  slug: string;
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  grade: UsedGrade;
  status: UsedUnitStatus;
  priceIqd: number;
  /** The new SKU's price, for reference. */
  newPriceIqd: number;
  /** Used price as a share of the new price, basis points. */
  ofNewBps: number | null;
  isDemo: boolean;
  priceable: boolean;
  /** cost.read only. */
  acquisitionCostIqd?: number | null;
  /** profit.read only. */
  margin?: { bps: number | null; state: MarginState };
  /** A price change of this unit waiting for a second person. */
  pending: UsedPriceRequest | null;
};

export async function listUsedForPricing(
  db: Db,
  actor: Actor,
  options: { status?: UsedUnitStatus | null },
  locale: Locale,
): Promise<{ units: UsedView[]; access: FieldAccess; canEdit: boolean; canApprove: boolean; canOverride: boolean }> {
  assertAny(actor, READERS);
  const access = fieldAccess(actor);
  // An employee limited to a branch sees the devices kept at that branch's locations only (SECURITY §7).
  const branch = actor.kind === "employee" && actor.branchId ? eq(inventoryLocations.branchId, actor.branchId) : undefined;
  const rows = await db
    .select({ unit: usedUnits, sku: variants.sku, newPriceIqd: variants.priceIqd, productId: products.id, name: products.name })
    .from(usedUnits)
    .innerJoin(variants, eq(variants.id, usedUnits.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(inventoryLocations, eq(inventoryLocations.id, usedUnits.locationId))
    .where(and(options.status ? eq(usedUnits.status, options.status) : notInArray(usedUnits.status, ["sold"]), branch))
    .orderBy(desc(usedUnits.updatedAt))
    .limit(300);
  const viewer = actorId(actor);
  const waiting = new Map<string, UsedPriceRequest>();
  for (const part of chunks(rows.map((row) => row.unit.id))) {
    const requests = await db
      .select({ approval: approvals, name: employees.name })
      .from(approvals)
      .leftJoin(employees, eq(employees.id, approvals.requestedBy))
      .where(and(eq(approvals.kind, USED_KIND), eq(approvals.status, "pending"), inArray(approvals.entityId, part)));
    for (const { approval, name } of requests) {
      const payload = approval.payload as UsedPayload | null;
      if (!approval.entityId || !payload) continue;
      const request: UsedPriceRequest = {
        id: approval.id,
        fromIqd: payload.fromIqd,
        toIqd: payload.toIqd,
        reasons: visibleReasons(payload.reasons ?? [], access),
        requestedBy: { id: approval.requestedBy, name: name ?? approval.requestedBy },
        reason: approval.reason,
        createdAt: approval.createdAt,
        mine: viewer !== null && approval.requestedBy === viewer,
      };
      if (access.profit) request.needsOverride = approval.requiredPermission === "pricing.discount.override";
      waiting.set(approval.entityId, request);
    }
  }
  return {
    units: rows.map(({ unit, sku, newPriceIqd, productId, name }) => {
      const view: UsedView = {
        id: unit.id,
        slug: unit.slug,
        variantId: unit.variantId,
        productId,
        sku,
        name: pick(name, locale),
        grade: unit.grade,
        status: unit.status,
        priceIqd: unit.priceIqd,
        newPriceIqd,
        ofNewBps: newPriceIqd > 0 ? Math.round((unit.priceIqd * 10_000) / newPriceIqd) : null,
        isDemo: unit.isDemo,
        priceable: PRICEABLE_USED.includes(unit.status),
        pending: waiting.get(unit.id) ?? null,
      };
      if (access.cost) view.acquisitionCostIqd = unit.acquisitionCostIqd;
      if (access.profit) {
        const cost = unit.acquisitionCostIqd;
        view.margin = { bps: cost === null ? null : marginBps(unit.priceIqd, cost), state: marginStateOf(unit.priceIqd, cost === null ? null : { landedIqd: cost, minMarginBps: null, targetMarginBps: null, source: "own" }) };
      }
      return view;
    }),
    access,
    canEdit: can(actor, "pricing.used.update"),
    canApprove: can(actor, "pricing.price.approve"),
    canOverride: can(actor, "pricing.discount.override"),
  };
}

/** A branch-limited employee works only on devices kept at their branch's locations (no location = no branch). */
async function assertUnitBranch(db: Db, actor: Actor, locationId: string | null): Promise<void> {
  if (actor.kind !== "employee" || !actor.branchId) return;
  const location = locationId ? await db.select({ branchId: inventoryLocations.branchId }).from(inventoryLocations).where(eq(inventoryLocations.id, locationId)).get() : undefined;
  assertBranch(actor, location?.branchId ?? null);
}

/** The unit's acquisition cost as the cost basis of the SKU rules (no margin rules for used units). */
const usedBasis = (unit: typeof usedUnits.$inferSelect): CostBasis | null => (unit.acquisitionCostIqd === null ? null : { landedIqd: unit.acquisitionCostIqd, minMarginBps: null, targetMarginBps: null, source: "own" });

/**
 * The price a cut of a used unit is measured from: its highest price of the last DROP_WINDOW_DAYS, read from the audit
 * trail (`before` of each direct change), the window starting again at the last approved change.
 */
async function usedReferencePrice(db: Db, unitId: string, currentIqd: number, now: number): Promise<number> {
  let from = now - DROP_WINDOW_DAYS * DAY_MS;
  const events = await db
    .select({ action: auditEvents.action, at: auditEvents.at, before: auditEvents.before })
    .from(auditEvents)
    .where(and(eq(auditEvents.entityType, "used_unit"), eq(auditEvents.entityId, unitId), inArray(auditEvents.action, ["pricing.used.price", "pricing.used.approve"]), gt(auditEvents.at, from)));
  for (const event of events) if (event.action === "pricing.used.approve" && event.at > from) from = event.at;
  let highest = currentIqd;
  for (const event of events) {
    if (event.action !== "pricing.used.price" || event.at <= from) continue;
    const before = (event.before as { priceIqd?: unknown } | null)?.priceIqd;
    if (typeof before === "number" && before > highest) highest = before;
  }
  return highest;
}

async function evaluateUsed(db: Db, unit: typeof usedUnits.$inferSelect, newPriceIqd: number, now: number) {
  return evaluatePriceChange({ oldPriceIqd: unit.priceIqd, newPriceIqd, oldCompareAtIqd: null, newCompareAtIqd: null, cost: usedBasis(unit), mode: "standard", referencePriceIqd: await usedReferencePrice(db, unit.id, unit.priceIqd, now), dropApprovalBps: await getSetting(db, "pricing.drop_approval_bps") });
}

const usedPendingSql = (unitId: string) => sql`exists (select 1 from approvals a where a.kind = ${USED_KIND} and a.entity_id = ${unitId} and a.status = 'pending')`;

const usedPriceUpdate = (db: Db, unitId: string, fromIqd: number, toIqd: number, now: number): BatchStatement[] => [
  db
    .update(usedUnits)
    .set({ priceIqd: toIqd, updatedAt: now })
    .where(and(eq(usedUnits.id, unitId), eq(usedUnits.priceIqd, fromIqd), inArray(usedUnits.status, [...PRICEABLE_USED]))),
  expectChanged(db, 1, { code: "PRICE_CHANGED", detail: unitId }),
];

export const UsedPriceInput = z.object({
  usedUnitId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  price: z.preprocess(formIqd, z.number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") }).int("invalid").min(PRICE_STEP_IQD, "too_small").max(MAX_PRICE_IQD, "too_big").refine(isOnStep, "price_step")),
  /** The price shown when the form was opened: a newer change is never overwritten silently. */
  expectedPriceIqd: z.preprocess((value) => (typeof value === "string" ? Number(value) : value), z.number().int()),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
});

export type UsedPriceResult = {
  /** True when the unit's price changed now. */
  changed: boolean;
  /** "applied" now, "pending" for a second person, "unchanged" (the price already is the one asked for). */
  status: "applied" | "pending" | "unchanged";
  requestId: string | null;
  /** The same request sent again (a double submit) — answered with the first one. */
  replayed: boolean;
  /** Why it waits, as far as the person may see (cost-based reasons only with profit.read). */
  reasons: ChangeReason[];
};

const settle = (error: unknown): never => {
  throw toAppError(error) ?? error;
};

/**
 * Sets a used unit's price (pricing.used.update) under the 03.05 rules: applied at once within the limits, otherwise a
 * request a second person decides (decideUsedPrice). A repeat of the same request is recognised, not refused.
 */
export async function setUsedUnitPrice(db: Db, actor: Actor, raw: unknown, now: number): Promise<UsedPriceResult> {
  assertCan(actor, "pricing.used.update");
  const input = UsedPriceInput.parse(raw);
  const unit = await db.select().from(usedUnits).where(eq(usedUnits.id, input.usedUnitId)).get();
  if (!unit) throw notFound("used_unit");
  await assertUnitBranch(db, actor, unit.locationId);
  if (!PRICEABLE_USED.includes(unit.status)) throw new AppError("unit_not_priceable", 409, { detail: unit.status });
  const access = fieldAccess(actor);
  // A double submit: the price is already the one asked for, or this person's request for it is waiting.
  if (unit.priceIqd === input.price) return { changed: false, status: "unchanged", requestId: null, replayed: false, reasons: [] };
  const waiting = await db.select().from(approvals).where(and(eq(approvals.kind, USED_KIND), eq(approvals.entityId, unit.id), eq(approvals.status, "pending"))).get();
  if (waiting) {
    const payload = waiting.payload as UsedPayload | null;
    if (waiting.requestedBy === actorId(actor) && payload?.toIqd === input.price) return { changed: false, status: "pending", requestId: waiting.id, replayed: true, reasons: visibleReasons(payload.reasons ?? [], access) };
    throw new AppError("change_pending", 409, { detail: waiting.id });
  }
  if (unit.priceIqd !== input.expectedPriceIqd) throw new AppError("price_changed", 409, { detail: unit.id });
  const evaluation = await evaluateUsed(db, unit, input.price, now);
  const noPending = expectThat(db, sql`not ${usedPendingSql(unit.id)}`, { code: "CHANGE_PENDING", detail: unit.id });
  const before = { priceIqd: unit.priceIqd, status: unit.status };
  if (!evaluation.needsApproval) {
    await runBatch(db, [
      noPending,
      ...usedPriceUpdate(db, unit.id, unit.priceIqd, input.price, now),
      auditStatement(db, { actor, action: "pricing.used.price", entityType: "used_unit", entityId: unit.id, summary: unit.slug, before, after: { priceIqd: input.price }, reason: input.reason, at: now }),
    ]).catch(settle);
    return { changed: true, status: "applied", requestId: null, replayed: false, reasons: [] };
  }
  const requestId = newId("apr");
  const payload: UsedPayload = { usedUnitId: unit.id, slug: unit.slug, fromIqd: unit.priceIqd, toIqd: input.price, reasons: evaluation.reasons };
  await runBatch(db, [
    noPending,
    expectThat(db, sql`(select price_iqd from used_units where id = ${unit.id}) = ${unit.priceIqd}`, { code: "PRICE_CHANGED", detail: unit.id }),
    db.insert(approvals).values({
      id: requestId,
      kind: USED_KIND,
      entityType: "used_unit",
      entityId: unit.id,
      requestedBy: actorId(actor) ?? "system",
      payload,
      status: "pending",
      reason: input.reason,
      createdAt: now,
      requiredPermission: evaluation.needsOverride ? "pricing.discount.override" : "pricing.price.approve",
    }),
    auditStatement(db, { actor, action: "pricing.used.request", entityType: "used_unit", entityId: unit.id, summary: unit.slug, before, after: { priceIqd: input.price, requestId, reasons: evaluation.reasons }, reason: input.reason, at: now }),
  ]).catch(settle);
  return { changed: false, status: "pending", requestId, replayed: false, reasons: visibleReasons(evaluation.reasons, access) };
}

async function loadUsedRequest(db: Db, approvalId: string) {
  const request = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.kind, USED_KIND))).get();
  const payload = request?.payload as UsedPayload | null | undefined;
  if (!request || !payload) throw notFound("used_price");
  return { request, payload };
}

export const DecideUsedInput = z.object({
  approvalId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  decision: z.enum(["approve", "reject"], { error: "invalid" }),
  note: z.string().trim().max(500, "too_long").optional().default(""),
});

/**
 * Approves (applies) or rejects a waiting used-unit price (pricing.price.approve; under the acquisition cost — checked
 * again now — also pricing.discount.override). Never by its requester. Repeating the same decision returns it again.
 */
export async function decideUsedPrice(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "applied" | "rejected"; replayed: boolean }> {
  assertCan(actor, "pricing.price.approve");
  const input = DecideUsedInput.parse(raw);
  const { request, payload } = await loadUsedRequest(db, input.approvalId);
  const decider = actorId(actor);
  if (request.status !== "pending") {
    if (input.decision === "approve" && request.status === "approved") return { status: "applied", replayed: true };
    if (input.decision === "reject" && request.status === "rejected" && request.decidedBy === decider) return { status: "rejected", replayed: true };
    throw new AppError("change_not_pending", 409, { detail: request.status });
  }
  if (actor.kind === "employee" && request.requestedBy === actor.id) throw new AppError("approver_is_requester", 403, { detail: request.id });
  const unit = await db.select().from(usedUnits).where(eq(usedUnits.id, payload.usedUnitId)).get();
  if (!unit) throw notFound("used_unit");
  await assertUnitBranch(db, actor, unit.locationId);
  const close = (status: "approved" | "rejected", note: string | null): BatchStatement[] => [
    db
      .update(approvals)
      .set({ status, decidedBy: decider, decidedAt: now, decisionNote: note })
      .where(and(eq(approvals.id, request.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: request.id }),
  ];
  if (input.decision === "reject") {
    if (input.note.length < 3) throw invalid({ note: "note_required" });
    await runBatch(db, [
      ...close("rejected", input.note),
      auditStatement(db, { actor, action: "pricing.used.reject", entityType: "used_unit", entityId: payload.usedUnitId, summary: payload.slug, before: { status: "pending", requestId: request.id }, after: { status: "rejected", priceIqd: payload.fromIqd }, reason: input.note, at: now }),
    ]).catch(settle);
    return { status: "rejected", replayed: false };
  }
  if (!PRICEABLE_USED.includes(unit.status)) throw new AppError("unit_not_priceable", 409, { detail: unit.status });
  if (unit.priceIqd !== payload.fromIqd) throw new AppError("price_changed", 409, { detail: unit.id });
  // The rules again, against today's acquisition cost.
  const evaluation = await evaluateUsed(db, unit, payload.toIqd, now);
  if (evaluation.needsOverride && !can(actor, "pricing.discount.override")) throw new AppError("override_required", 403, { detail: "pricing.discount.override" });
  const note = input.note || null;
  await runBatch(db, [
    ...close("approved", note),
    ...usedPriceUpdate(db, unit.id, payload.fromIqd, payload.toIqd, now),
    auditStatement(db, {
      actor,
      action: "pricing.used.approve",
      entityType: "used_unit",
      entityId: unit.id,
      summary: unit.slug,
      before: { priceIqd: payload.fromIqd, status: unit.status },
      after: { priceIqd: payload.toIqd, requestId: request.id, requestedBy: request.requestedBy, reasons: evaluation.reasons },
      reason: note ?? request.reason,
      at: now,
    }),
  ]).catch(settle);
  return { status: "applied", replayed: false };
}

export const CancelUsedInput = z.object({
  approvalId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  note: z.string().trim().max(500, "too_long").optional().default(""),
});

/** The requester withdraws their waiting used-unit price (pricing.used.update). */
export async function cancelUsedPrice(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "cancelled"; replayed: boolean }> {
  assertCan(actor, "pricing.used.update");
  const input = CancelUsedInput.parse(raw);
  const { request, payload } = await loadUsedRequest(db, input.approvalId);
  const who = actorId(actor);
  if (actor.kind !== "system" && request.requestedBy !== who) throw new AppError("not_requester", 403, { detail: request.id });
  if (request.status !== "pending") {
    if (request.status === "rejected" && request.decidedBy === who && (request.decisionNote ?? "").startsWith("cancelled")) return { status: "cancelled", replayed: true };
    throw new AppError("change_not_pending", 409, { detail: request.status });
  }
  const note = input.note || null;
  await runBatch(db, [
    db
      .update(approvals)
      .set({ status: "rejected", decidedBy: who, decidedAt: now, decisionNote: note ? `cancelled: ${note}` : "cancelled" })
      .where(and(eq(approvals.id, request.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: request.id }),
    auditStatement(db, { actor, action: "pricing.used.cancel", entityType: "used_unit", entityId: payload.usedUnitId, summary: payload.slug, before: { status: "pending", requestId: request.id }, after: { status: "cancelled" }, reason: note, at: now }),
  ]).catch(settle);
  return { status: "cancelled", replayed: false };
}

/** How many used-unit prices wait for a decision this actor may make (not their own). */
export async function countUsedDecidable(db: Db, actor: Actor): Promise<number> {
  if (!can(actor, "pricing.price.approve")) return 0;
  const viewer = actorId(actor);
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(approvals)
    .where(
      and(
        eq(approvals.kind, USED_KIND),
        eq(approvals.status, "pending"),
        viewer ? sql`${approvals.requestedBy} <> ${viewer}` : undefined,
        can(actor, "pricing.discount.override") ? undefined : sql`coalesce(${approvals.requiredPermission}, '') <> 'pricing.discount.override'`,
      ),
    );
  return Number(row?.count ?? 0);
}

export { USED_UNIT_STATUSES };
