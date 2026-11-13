/**
 * Admin 08.03 — flash sales: a start and an end (Baghdad time), a sale price per SKU and a dedicated allowance (the
 * most units sold at that price; `flash_sale_items.qty_sold` can never pass `qty_limit` — a CHECK).
 *
 *   listFlashSales(db, actor, filters, now, locale) · getFlashSale(db, actor, saleId, now, locale)
 *   createFlashSale(db, actor, { nameAr, nameEn?, startsAt, endsAt, idempotencyKey }, now)
 *   updateFlashSale(db, actor, { saleId, nameAr, nameEn?, startsAt, endsAt }, now)            drafts only
 *   setFlashItem(db, actor, { saleId, code, salePrice, qtyLimit?, perCustomerLimit? }, now)   drafts only
 *   removeFlashItem(db, actor, { saleId, itemId }, now)                                       drafts only
 *   submitFlashSale(db, actor, { saleId, reason }, now)   → scheduled, or a request for a second person
 *   decideFlashSale(db, actor, { approvalId, decision, note }, now) · withdrawFlashRequest · cancelFlashSale
 *
 * Prices go through the pricing module's own rules (03): every flash price is evaluated by pricing's
 * `evaluatePriceChange` against the SKU's cost basis (`costBasisFor`) and the store's cut limit
 * (`pricing.drop_approval_bps`) exactly as a price change would be — the cut measured from the highest price of the
 * last 30 days (`dropReferencePrice` over the SKU's applied price changes: a quiet cut of the price followed by a quiet
 * flash cut cannot split the limit) — a cut beyond the limit, an unknown cost, or a price under the minimum margin /
 * the landed cost needs a second person holding pricing.price.approve (and pricing.discount.override for the margin
 * cases), never the person who submitted it; the rules are evaluated again AT the decision (`override_required` when
 * the cost rose meanwhile). Pricing's field rule holds too: without cost.read + profit.read nobody sees the floor, the
 * margins, "needs the override" or the cost-based reasons (also not in the submit answer nor in the approvals queue) —
 * the page says the server decides when the sale is sent. The sale price never touches `variants.price_iqd`: the price
 * in force is unchanged and the "was" price rules stay intact.
 *
 * Stock: an allowance is a ceiling, not a reservation. Units still come from the shared stock through the core's
 * reservations (which refuse a shortage), so an allowance can never oversell; an allowance above the units available
 * now is refused when the sale is submitted and approved, and the page shows what the sale can still sell
 * (min(allowance left, available)).
 *
 * Where a sale applies (since 2026-11-12): the online cart and checkout sell at the running sale's price while its
 * allowance and the shopper's per-customer limit cover the line (orders/promotions.ts flashLineCap), placeOrder claims
 * the units in its batch (orders/promotions.server.ts flashClaimStatements: the same price, qty_sold within
 * qty_limit) and a cancellation gives them back. HONEST BOUNDARY: product pages, lists and search still show the
 * regular price (the sale price shows from the cart on); the point of sale sells at its own prices. A sale counts as
 * running while its status is "scheduled" and starts_at ≤ now < ends_at.
 */
import { and, asc, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, flashSaleItems, flashSales, priceChanges, products, variants, type FlashSale } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { costBasisFor } from "~/server/services/admin/pricing/facts.server";
import { appliedPriceHistory } from "~/server/services/admin/pricing/reference.server";
import { dropReferencePrice, evaluatePriceChange, isOnStep, MAX_PRICE_IQD, OVERRIDE_REASONS, PRICE_STEP_IQD, type AppliedChange, type ChangeReason } from "~/server/services/admin/pricing/rules";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { getSetting } from "~/server/settings.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { flashStateOf, stableText, windowsOverlap } from "./rules";
import { ID, KEY, SECTION_READ, assertAny, assertMayDecide, canDecideApproval, employeeNames, historyOf, idFromKey, noPendingRequest, num, pendingApprovalOf, pendingChangeView } from "./shared.server";
import { DAY_MS, FLASH, PAGE_SIZE, fromBaghdadInput, parseWhole, type FlashDetail, type FlashFilters, type FlashItemCheck, type FlashItemView, type FlashPage, type FlashRow, type FlashState, type FlashView } from "./types";

const KIND = "flash_sale" as const;

/**
 * Pricing 03's field rule (prices.server.ts visibleReasons): without profit.read a person never learns that a price is
 * under the cost or the minimum margin, nor that a SKU has no cost — those reasons, "needs the override" and the floor
 * stay on the server (the page says the server decides when the sale is sent).
 */
const costReason = (reason: ChangeReason) => OVERRIDE_REASONS.has(reason) || reason === "cost_unknown";
const seesMargins = (actor: Actor) => can(actor, "cost.read") && can(actor, "profit.read");

function changedGuard(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "CHANGE_PENDING") throw new AppError("change_pending", 409);
  if (info?.code === "FLASH_CHANGED") throw new AppError("flash_changed", 409);
  if (info?.code === "FLASH_NOT_DRAFT") throw new AppError("flash_not_draft", 409);
  if (info?.code === "CHANGE_NOT_PENDING") throw new AppError("change_not_pending", 409);
  if (info?.kind === "unique" && info.table === "flash_sales") throw new AppError("flash_changed", 409);
  throw error;
}

async function loadSale(db: Db, saleId: string): Promise<FlashSale> {
  if (!ID.test(saleId)) throw notFound("flash_sale");
  const row = await db.select().from(flashSales).where(eq(flashSales.id, saleId)).get();
  if (!row) throw notFound("flash_sale");
  return row;
}

type ItemRow = { id: string; variantId: string; salePriceIqd: number; qtyLimit: number | null; qtySold: number; perCustomerLimit: number | null };

/** What an approval approves: the window and every item's price, allowance and per-customer limit. */
export function saleFingerprint(sale: { startsAt: number; endsAt: number }, items: readonly ItemRow[]): string {
  return stableText({ startsAt: sale.startsAt, endsAt: sale.endsAt, items: [...items].sort((a, b) => (a.variantId < b.variantId ? -1 : 1)).map((item) => `${item.variantId}:${item.salePriceIqd}:${item.qtyLimit ?? ""}:${item.perCustomerLimit ?? ""}`) });
}

/** SQL that is true while the sale's items are still exactly `items` (same text as in JS). */
function itemsUnchanged(saleId: string, items: readonly ItemRow[]) {
  const expected = [...items]
    .sort((a, b) => (a.variantId < b.variantId ? -1 : 1))
    .map((item) => `${item.variantId}:${item.salePriceIqd}:${item.qtyLimit ?? ""}:${item.perCustomerLimit ?? ""}`)
    .join(",");
  return sql`coalesce((SELECT group_concat(line, ',') FROM (SELECT variant_id || ':' || sale_price_iqd || ':' || coalesce(qty_limit, '') || ':' || coalesce(per_customer_limit, '') AS line FROM flash_sale_items WHERE flash_sale_id = ${saleId} ORDER BY variant_id)), '') = ${expected}`;
}

async function itemsOf(db: Db, saleId: string): Promise<ItemRow[]> {
  return db
    .select({ id: flashSaleItems.id, variantId: flashSaleItems.variantId, salePriceIqd: flashSaleItems.salePriceIqd, qtyLimit: flashSaleItems.qtyLimit, qtySold: flashSaleItems.qtySold, perCustomerLimit: flashSaleItems.perCustomerLimit })
    .from(flashSaleItems)
    .where(eq(flashSaleItems.flashSaleId, saleId))
    .orderBy(asc(flashSaleItems.variantId));
}

/** The applied price changes of these SKUs — pricing 03's own helper (follow-up 2026-11-12: this module kept a copy). */
const appliedHistory = appliedPriceHistory;

/**
 * Each item checked: pricing's evaluation exactly as a price change would be (the cut measured from the highest price
 * of the last 30 days — pricing's drop window —, the cost basis, the minimum margin, `pricing.drop_approval_bps`), the
 * stock available now, and the problems that block submitting. `needsApproval` / `needsOverride` are the server's
 * verdict; the views carry pricing's field rules (reasons, the override and the floor only with profit.read).
 */
async function checkItems(db: Db, actor: Actor, sale: FlashSale, items: readonly ItemRow[], locale: Locale, now: number): Promise<{ views: FlashItemView[]; needsApproval: boolean; needsOverride: boolean }> {
  if (items.length === 0) return { views: [], needsApproval: false, needsOverride: false };
  const variantIds = items.map((item) => item.variantId);
  const [facts, basis, stock, dropApprovalBps, others, history] = await Promise.all([
    db.select({ id: variants.id, sku: variants.sku, title: variants.title, priceIqd: variants.priceIqd, compareAtIqd: variants.compareAtIqd, isActive: variants.isActive, createdAt: variants.createdAt, name: products.name }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(inArray(variants.id, variantIds)),
    costBasisFor(db, variantIds),
    getAvailability(db, variantIds),
    getSetting(db, "pricing.drop_approval_bps"),
    db
      .select({ saleId: flashSales.id, variantId: flashSaleItems.variantId, startsAt: flashSales.startsAt, endsAt: flashSales.endsAt })
      .from(flashSaleItems)
      .innerJoin(flashSales, eq(flashSales.id, flashSaleItems.flashSaleId))
      .where(and(inArray(flashSaleItems.variantId, variantIds), ne(flashSales.id, sale.id), inArray(flashSales.status, ["draft", "scheduled", "active"]))),
    appliedHistory(db, variantIds),
  ]);
  const byId = new Map(facts.map((row) => [row.id, row]));
  const withProfit = seesMargins(actor);
  let needsApproval = false;
  let needsOverride = false;
  const views = items.map((item): FlashItemView => {
    const fact = byId.get(item.variantId);
    const available = stock.get(item.variantId)?.available ?? 0;
    const price = fact?.priceIqd ?? 0;
    const referencePriceIqd = fact ? dropReferencePrice(price, fact.createdAt, history.get(item.variantId) ?? [], now) : price;
    const evaluation = evaluatePriceChange({ oldPriceIqd: price, newPriceIqd: item.salePriceIqd, oldCompareAtIqd: fact?.compareAtIqd ?? null, newCompareAtIqd: fact?.compareAtIqd ?? null, cost: basis.get(item.variantId) ?? null, mode: "standard", referencePriceIqd, dropApprovalBps });
    needsApproval ||= evaluation.needsApproval;
    needsOverride ||= evaluation.needsOverride;
    const problems: FlashItemView["problems"] = [];
    if (item.salePriceIqd >= price) problems.push("price_not_lower");
    if (item.qtyLimit !== null && item.qtyLimit - item.qtySold > available) problems.push("allowance_over_stock");
    if (!fact?.isActive) problems.push("variant_inactive");
    if (others.some((other) => other.variantId === item.variantId && windowsOverlap(other, sale))) problems.push("overlap");
    const reasons = evaluation.reasons.filter((reason) => withProfit || !costReason(reason));
    const check: FlashItemCheck = {
      // without profit.read only what the person may see: hidden rules are decided on the server at submit
      needsApproval: withProfit ? evaluation.needsApproval : reasons.length > 0,
      reasons,
      dropBps: evaluation.dropBps,
      referencePriceIqd: evaluation.referencePriceIqd,
      referenceDropBps: evaluation.referenceDropBps,
    };
    if (withProfit) {
      check.needsOverride = evaluation.needsOverride;
      check.floorIqd = evaluation.floorIqd;
      check.marginBeforeBps = evaluation.marginBeforeBps;
      check.marginAfterBps = evaluation.marginAfterBps;
    }
    const left = item.qtyLimit === null ? Number.POSITIVE_INFINITY : Math.max(0, item.qtyLimit - item.qtySold);
    return {
      id: item.id,
      variantId: item.variantId,
      sku: fact?.sku ?? item.variantId,
      name: fact ? [pick(fact.name, locale), pick(fact.title, locale)].filter(Boolean).join(" — ") : item.variantId,
      priceIqd: price,
      salePriceIqd: item.salePriceIqd,
      qtyLimit: item.qtyLimit,
      qtySold: item.qtySold,
      perCustomerLimit: item.perCustomerLimit,
      available,
      canSell: Math.max(0, Math.min(left, available)),
      problems,
      check,
    };
  });
  return { views, needsApproval, needsOverride };
}

// ───────────────────────────────────────────────────────────────── reads

const VIEW_STATES: Record<FlashView, FlashState[] | null> = { all: null, draft: ["draft"], pending: ["pending"], scheduled: ["scheduled"], active: ["active"], ended: ["ended", "cancelled"] };

export async function listFlashSales(db: Db, actor: Actor, filters: FlashFilters, now: number, locale: Locale): Promise<FlashPage> {
  assertAny(actor, SECTION_READ.flash);
  const rows = await db
    .select({
      sale: flashSales,
      items: sql<number>`(SELECT count(*) FROM flash_sale_items AS i WHERE i.flash_sale_id = ${flashSales.id})`,
      allowance: sql<number | null>`(SELECT CASE WHEN count(*) = count(i.qty_limit) THEN sum(i.qty_limit) END FROM flash_sale_items AS i WHERE i.flash_sale_id = ${flashSales.id})`,
      sold: sql<number>`(SELECT coalesce(sum(i.qty_sold), 0) FROM flash_sale_items AS i WHERE i.flash_sale_id = ${flashSales.id})`,
      pending: sql<number>`EXISTS (SELECT 1 FROM approvals AS a WHERE a.kind = 'flash_sale' AND a.entity_id = ${flashSales.id} AND a.status = 'pending')`,
    })
    .from(flashSales)
    .orderBy(desc(flashSales.startsAt))
    .limit(500);
  const all = rows.map((row) => ({ ...row, state: flashStateOf(row.sale, num(row.pending) === 1, now) }));
  const counts: Partial<Record<FlashView, number>> = { all: all.length };
  for (const view of ["draft", "pending", "scheduled", "active", "ended"] as const) counts[view] = all.filter((row) => VIEW_STATES[view]?.includes(row.state)).length;
  const states = VIEW_STATES[filters.view];
  const visible = states ? all.filter((row) => states.includes(row.state)) : all;
  return {
    rows: visible.slice((filters.page - 1) * PAGE_SIZE, filters.page * PAGE_SIZE).map(
      (row): FlashRow => ({
        id: row.sale.id,
        slug: row.sale.slug,
        name: pick(row.sale.name, locale),
        state: row.state,
        startsAt: row.sale.startsAt,
        endsAt: row.sale.endsAt,
        items: num(row.items),
        allowance: row.allowance === null ? null : num(row.allowance),
        sold: num(row.sold),
        isDemo: row.sale.isDemo,
      }),
    ),
    total: visible.length,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(visible.length / PAGE_SIZE)),
    counts,
  };
}

export async function getFlashSale(db: Db, actor: Actor, saleId: string, now: number, locale: Locale): Promise<FlashDetail> {
  assertAny(actor, SECTION_READ.flash);
  const sale = await loadSale(db, saleId);
  const [items, pending, history, creator] = await Promise.all([itemsOf(db, sale.id), pendingApprovalOf(db, KIND, sale.id), historyOf(db, "flash_sale", sale.id), employeeNames(db, [sale.createdBy])]);
  const checked = await checkItems(db, actor, sale, items, locale, now);
  const view = await pendingChangeView(db, actor, pending);
  const withProfit = seesMargins(actor);
  const detail: FlashDetail = {
    id: sale.id,
    slug: sale.slug,
    name: sale.name,
    state: flashStateOf(sale, Boolean(pending), now),
    storedStatus: sale.status,
    startsAt: sale.startsAt,
    endsAt: sale.endsAt,
    isDemo: sale.isDemo,
    createdBy: sale.createdBy ? (creator.get(sale.createdBy) ?? null) : null,
    createdAt: sale.createdAt,
    items: checked.views,
    // what this person may know (pricing's field rule): the server's own verdict only with profit.read
    needsApproval: withProfit ? checked.needsApproval : checked.views.some((item) => item.check.needsApproval),
    decidedOnSubmit: !withProfit,
    pending: view && pending ? { ...view, terms: null, ...(withProfit ? { needsOverride: Boolean((pending.payload as { needsOverride?: boolean } | null)?.needsOverride) } : {}) } : null,
    history,
    withCost: can(actor, "cost.read"),
    withProfit,
    can: { manage: can(actor, "promotions.flash_sale.manage"), decide: pending ? canDecideApproval(actor, pending) : false, override: can(actor, "pricing.discount.override") },
  };
  if (withProfit) detail.needsOverride = checked.needsOverride;
  return detail;
}

// ───────────────────────────────────────────────────────────────── writes

const reasonText = z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long");
const windowFields = {
  nameAr: z.string({ error: "required" }).overwrite(cleanLine).trim().min(2, "required").max(120, "too_long"),
  nameEn: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanLine).trim().max(120, "too_long")),
  startsAt: z.preprocess((value) => fromBaghdadInput(value ?? ""), z.number({ error: "date_invalid" }).int("date_invalid")),
  endsAt: z.preprocess((value) => fromBaghdadInput(value ?? ""), z.number({ error: "date_invalid" }).int("date_invalid")),
};
const windowCheck = (input: { startsAt: number; endsAt: number }, ctx: z.RefinementCtx) => {
  if (!Number.isFinite(input.startsAt) || !Number.isFinite(input.endsAt)) return;
  if (input.endsAt <= input.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "ends_before_start" });
  else if (input.endsAt - input.startsAt > FLASH.maxDays * DAY_MS) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "window_too_long" });
};

export const CreateFlashInput = z.object({ ...windowFields, idempotencyKey: z.string().regex(KEY, "invalid") }).superRefine(windowCheck);
export const UpdateFlashInput = z.object({ ...windowFields, saleId: z.string().regex(ID, "invalid") }).superRefine(windowCheck);

const nameOf = (ar: string, en: string): L10n => (en ? { ar, en } : { ar });

export async function createFlashSale(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ saleId: string; replayed: boolean }> {
  assertCan(actor, "promotions.flash_sale.manage");
  const parsed = CreateFlashInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "flash.create");
  const input = parsed.data;
  if (input.startsAt <= now) throw invalid({ startsAt: "starts_past" });
  const saleId = await idFromKey("fls", actor, input.idempotencyKey);
  const existing = await db.select({ id: flashSales.id }).from(flashSales).where(eq(flashSales.id, saleId)).get();
  if (existing) return { saleId, replayed: true };
  const name = nameOf(input.nameAr, input.nameEn);
  await runBatch(db, [
    db.insert(flashSales).values({ id: saleId, slug: publicRef("fs").toLowerCase(), name, startsAt: input.startsAt, endsAt: input.endsAt, status: "draft", isDemo: options.demo ?? false, createdBy: actor.kind === "employee" ? actor.id : null, createdAt: now }),
    auditStatement(db, { actor, action: "promotions.flash.create", entityType: "flash_sale", entityId: saleId, summary: name.ar, after: { startsAt: input.startsAt, endsAt: input.endsAt }, at: now }),
  ]).catch(changedGuard);
  return { saleId, replayed: false };
}

/** A draft's name and window (refused while a request waits: the request approves exactly what was submitted). */
export async function updateFlashSale(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: boolean }> {
  assertCan(actor, "promotions.flash_sale.manage");
  const parsed = UpdateFlashInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "flash.update");
  const input = parsed.data;
  const sale = await loadSale(db, input.saleId);
  if (sale.status !== "draft") throw new AppError("flash_not_draft", 409);
  if (await pendingApprovalOf(db, KIND, sale.id)) throw new AppError("change_pending", 409);
  if (input.startsAt <= now) throw invalid({ startsAt: "starts_past" });
  const name = nameOf(input.nameAr, input.nameEn);
  if (JSON.stringify(name) === JSON.stringify(sale.name) && input.startsAt === sale.startsAt && input.endsAt === sale.endsAt) return { changed: false };
  await runBatch(db, [
    db
      .update(flashSales)
      .set({ name, startsAt: input.startsAt, endsAt: input.endsAt })
      .where(and(eq(flashSales.id, sale.id), eq(flashSales.status, "draft"), eq(flashSales.startsAt, sale.startsAt), eq(flashSales.endsAt, sale.endsAt))),
    expectChanged(db, 1, { code: "FLASH_CHANGED", detail: sale.id }),
    auditStatement(db, { actor, action: "promotions.flash.update", entityType: "flash_sale", entityId: sale.id, summary: name.ar, before: { name: sale.name, startsAt: sale.startsAt, endsAt: sale.endsAt }, after: { name, startsAt: input.startsAt, endsAt: input.endsAt }, at: now }),
  ]).catch(changedGuard);
  return { changed: true };
}

const optionalWhole = (max: number) => z.preprocess((value) => (value === "" || value === null || value === undefined ? null : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(1, "too_small").max(max, "too_big").nullable());

export const FlashItemInput = z.object({
  saleId: z.string().regex(ID, "invalid"),
  code: z.string({ error: "required" }).trim().min(1, "required").max(64, "too_long"),
  salePrice: z.preprocess((value) => (value === "" || value === null || value === undefined ? undefined : parseWhole(value) ?? Number.NaN), z.number({ error: (issue) => (issue.input === undefined ? "required" : "number_invalid") }).int("number_invalid").min(PRICE_STEP_IQD, "too_small").max(MAX_PRICE_IQD, "too_big")),
  qtyLimit: optionalWhole(FLASH.maxAllowance),
  perCustomerLimit: optionalWhole(FLASH.maxPerCustomer),
});

/** Adds a SKU to a draft (by SKU or barcode — a scanner types it), or changes its price, allowance or per-customer limit. */
export async function setFlashItem(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale): Promise<{ itemId: string; created: boolean }> {
  assertCan(actor, "promotions.flash_sale.manage");
  const parsed = FlashItemInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "flash.item");
  const input = parsed.data;
  const sale = await loadSale(db, input.saleId);
  if (sale.status !== "draft") throw new AppError("flash_not_draft", 409);
  if (await pendingApprovalOf(db, KIND, sale.id)) throw new AppError("change_pending", 409);
  if (!isOnStep(input.salePrice)) throw invalid({ salePrice: "price_step" });
  const code = input.code;
  const variant = await db
    .select({ id: variants.id, sku: variants.sku, priceIqd: variants.priceIqd, isActive: variants.isActive, name: products.name })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(sql`upper(${variants.sku}) = ${code.toUpperCase()} OR ${variants.barcode} = ${code}`)
    .get();
  if (!variant) throw invalid({ code: "unknown_code" });
  if (!variant.isActive) throw invalid({ code: "variant_inactive" });
  if (input.salePrice >= variant.priceIqd) throw invalid({ salePrice: "price_not_lower" });
  const existing = await db.select({ id: flashSaleItems.id, qtySold: flashSaleItems.qtySold }).from(flashSaleItems).where(and(eq(flashSaleItems.flashSaleId, sale.id), eq(flashSaleItems.variantId, variant.id))).get();
  if (!existing) {
    const count = num((await db.select({ n: sql<number>`count(*)` }).from(flashSaleItems).where(eq(flashSaleItems.flashSaleId, sale.id)).get())?.n);
    if (count >= FLASH.maxItems) throw invalid({ code: "too_many" });
  }
  if (input.qtyLimit !== null) {
    const available = (await getAvailability(db, [variant.id])).get(variant.id)?.available ?? 0;
    if (input.qtyLimit > available) throw invalid({ qtyLimit: "allowance_over_stock" });
  }
  const itemId = existing?.id ?? newId("fsi");
  const label = `${variant.sku} · ${pick(variant.name, locale)}`;
  await runBatch(db, [
    expectThat(db, sql`EXISTS (SELECT 1 FROM flash_sales WHERE id = ${sale.id} AND status = 'draft')`, { code: "FLASH_NOT_DRAFT", detail: sale.id }),
    db
      .insert(flashSaleItems)
      .values({ id: itemId, flashSaleId: sale.id, variantId: variant.id, salePriceIqd: input.salePrice, qtyLimit: input.qtyLimit, qtySold: 0, perCustomerLimit: input.perCustomerLimit })
      .onConflictDoUpdate({ target: [flashSaleItems.flashSaleId, flashSaleItems.variantId], set: { salePriceIqd: input.salePrice, qtyLimit: input.qtyLimit, perCustomerLimit: input.perCustomerLimit } }),
    auditStatement(db, { actor, action: "promotions.flash.item", entityType: "flash_sale", entityId: sale.id, summary: label, after: { variantId: variant.id, sku: variant.sku, priceIqd: variant.priceIqd, salePriceIqd: input.salePrice, qtyLimit: input.qtyLimit, perCustomerLimit: input.perCustomerLimit }, at: now }),
  ]).catch(changedGuard);
  return { itemId, created: !existing };
}

export async function removeFlashItem(db: Db, actor: Actor, raw: { saleId: string; itemId: string }, now: number): Promise<{ removed: boolean }> {
  assertCan(actor, "promotions.flash_sale.manage");
  const input = z.object({ saleId: z.string().regex(ID, "invalid"), itemId: z.string().regex(ID, "invalid") }).parse(raw);
  const sale = await loadSale(db, input.saleId);
  if (sale.status !== "draft") throw new AppError("flash_not_draft", 409);
  if (await pendingApprovalOf(db, KIND, sale.id)) throw new AppError("change_pending", 409);
  const item = await db.select().from(flashSaleItems).where(and(eq(flashSaleItems.id, input.itemId), eq(flashSaleItems.flashSaleId, sale.id))).get();
  if (!item) throw notFound("flash_sale_item");
  await runBatch(db, [
    expectThat(db, sql`EXISTS (SELECT 1 FROM flash_sales WHERE id = ${sale.id} AND status = 'draft')`, { code: "FLASH_NOT_DRAFT", detail: sale.id }),
    db.delete(flashSaleItems).where(and(eq(flashSaleItems.id, item.id), eq(flashSaleItems.qtySold, 0))),
    expectChanged(db, 1, { code: "FLASH_CHANGED", detail: sale.id }),
    auditStatement(db, { actor, action: "promotions.flash.item_remove", entityType: "flash_sale", entityId: sale.id, before: { variantId: item.variantId, salePriceIqd: item.salePriceIqd, qtyLimit: item.qtyLimit }, at: now }),
  ]).catch(changedGuard);
  return { removed: true };
}

async function assertSubmittable(db: Db, actor: Actor, sale: FlashSale, items: ItemRow[], now: number, locale: Locale) {
  if (items.length === 0) throw new AppError("flash_empty", 409);
  if (sale.startsAt <= now) throw new AppError("flash_window_past", 409);
  const checked = await checkItems(db, actor, sale, items, locale, now);
  const problems = checked.views.filter((item) => item.problems.length > 0);
  if (problems.length > 0) throw new AppError("flash_item_problem", 409, { detail: problems.map((item) => `${item.sku}:${item.problems.join("|")}`).join(",") });
  return checked;
}

export const SubmitFlashInput = z.object({ saleId: z.string().regex(ID, "invalid"), reason: reasonText });

/**
 * Submits a draft: scheduled at once when no item needs a second person by pricing's rules; otherwise a request
 * (pricing.price.approve, + pricing.discount.override when a price is under the margin floor or the cost).
 * `needsOverride` is in the answer only for someone with profit.read (pricing's field rule).
 */
export async function submitFlashSale(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale): Promise<{ status: "scheduled" | "requested"; needsOverride?: boolean }> {
  assertCan(actor, "promotions.flash_sale.manage");
  const parsed = SubmitFlashInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "flash.submit");
  const input = parsed.data;
  const sale = await loadSale(db, input.saleId);
  if (sale.status !== "draft") throw new AppError("flash_not_draft", 409);
  if (await pendingApprovalOf(db, KIND, sale.id)) throw new AppError("change_pending", 409);
  const items = await itemsOf(db, sale.id);
  const checked = await assertSubmittable(db, actor, sale, items, now, locale);
  const fingerprint = saleFingerprint(sale, items);
  const guard = [
    expectThat(db, sql`EXISTS (SELECT 1 FROM flash_sales WHERE id = ${sale.id} AND status = 'draft' AND starts_at = ${sale.startsAt} AND ends_at = ${sale.endsAt})`, { code: "FLASH_CHANGED", detail: sale.id }),
    expectThat(db, itemsUnchanged(sale.id, items), { code: "FLASH_CHANGED", detail: sale.id }),
  ];
  const actorId = actor.kind === "employee" ? actor.id : "system";
  if (!checked.needsApproval) {
    await runBatch(db, [
      ...guard,
      db.update(flashSales).set({ status: "scheduled" }).where(and(eq(flashSales.id, sale.id), eq(flashSales.status, "draft"))),
      expectChanged(db, 1, { code: "FLASH_NOT_DRAFT", detail: sale.id }),
      auditStatement(db, { actor, action: "promotions.flash.schedule", entityType: "flash_sale", entityId: sale.id, summary: sale.name.ar, after: { items: items.length, fingerprint }, reason: input.reason, at: now }),
    ]).catch(changedGuard);
    return seesMargins(actor) ? { status: "scheduled", needsOverride: false } : { status: "scheduled" };
  }
  await runBatch(db, [
    ...guard,
    // the same draft sent from two tabs at once: one request
    noPendingRequest(db, KIND, sale.id),
    db.insert(approvals).values({
      id: newId("apr"),
      kind: KIND,
      entityType: "flash_sale",
      entityId: sale.id,
      requestedBy: actorId,
      payload: { action: "schedule", fingerprint, needsOverride: checked.needsOverride, items: items.length },
      status: "pending",
      reason: input.reason,
      requiredPermission: checked.needsOverride ? "pricing.discount.override" : null,
      createdAt: now,
    }),
    auditStatement(db, { actor, action: "promotions.flash.request", entityType: "flash_sale", entityId: sale.id, summary: sale.name.ar, after: { items: items.length, needsOverride: checked.needsOverride }, reason: input.reason, at: now }),
  ]).catch(changedGuard);
  return seesMargins(actor) ? { status: "requested", needsOverride: checked.needsOverride } : { status: "requested" };
}

/** `saleId`: the sale whose page sent the decision — a request of another sale is not found there (no IDOR). */
export const DecideFlashInput = z.object({ approvalId: z.string().regex(ID, "invalid"), saleId: z.string().regex(ID, "invalid").optional(), decision: z.enum(["approve", "reject"], { error: "required" }), note: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(500, "too_long")) });

/**
 * A second person approves or rejects a sale's request. Pricing's rules are evaluated again AT the decision (the cost or
 * the price may have changed since the request): a price that now needs the override is approved only by someone
 * holding pricing.discount.override (`override_required`, 403) — as pricing 03's own decisions.
 */
export async function decideFlashSale(db: Db, actor: Actor, raw: unknown, now: number, locale: Locale): Promise<{ status: "approved" | "rejected"; saleId: string }> {
  assertCan(actor, "promotions.flash_sale.manage");
  const parsed = DecideFlashInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "flash.decide");
  const input = parsed.data;
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, KIND))).get();
  if (!approval || !approval.entityId || (input.saleId !== undefined && approval.entityId !== input.saleId)) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  assertMayDecide(actor, approval);
  if (input.decision === "reject" && input.note.length < 3) throw invalid({ note: "reason_short" });
  const sale = await loadSale(db, approval.entityId);
  const items = await itemsOf(db, sale.id);
  const payload = (approval.payload ?? {}) as { fingerprint?: string };
  const actorId = actor.kind === "employee" ? actor.id : "system";
  const statements: BatchStatement[] = [
    db
      .update(approvals)
      .set({ status: input.decision === "approve" ? "approved" : "rejected", decidedBy: actorId, decidedAt: now, decisionNote: input.note || null })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
  ];
  if (input.decision === "approve") {
    if (saleFingerprint(sale, items) !== payload.fingerprint || sale.status !== "draft") throw new AppError("flash_changed", 409);
    const checked = await assertSubmittable(db, actor, sale, items, now, locale);
    if (checked.needsOverride && !can(actor, "pricing.discount.override")) throw new AppError("override_required", 403, { detail: "pricing.discount.override" });
    statements.push(
      expectThat(db, itemsUnchanged(sale.id, items), { code: "FLASH_CHANGED", detail: sale.id }),
      db
        .update(flashSales)
        .set({ status: "scheduled" })
        .where(and(eq(flashSales.id, sale.id), eq(flashSales.status, "draft"), eq(flashSales.startsAt, sale.startsAt), eq(flashSales.endsAt, sale.endsAt))),
      expectChanged(db, 1, { code: "FLASH_CHANGED", detail: sale.id }),
    );
  }
  statements.push(auditStatement(db, { actor, action: input.decision === "approve" ? "promotions.flash.approve" : "promotions.flash.reject", entityType: "flash_sale", entityId: sale.id, summary: sale.name.ar, after: { approvalId: approval.id }, reason: input.note || approval.reason, at: now }));
  await runBatch(db, statements).catch(changedGuard);
  return { status: input.decision === "approve" ? "approved" : "rejected", saleId: sale.id };
}

export async function withdrawFlashRequest(db: Db, actor: Actor, raw: { approvalId: string; saleId?: string }, now: number): Promise<{ saleId: string }> {
  assertCan(actor, "promotions.flash_sale.manage");
  const approvalId = z.string().regex(ID, "invalid").parse(raw.approvalId);
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.kind, KIND))).get();
  if (!approval || !approval.entityId || (raw.saleId !== undefined && approval.entityId !== raw.saleId)) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  if (actor.kind !== "employee" || approval.requestedBy !== actor.id) throw new AppError("forbidden", 403, { detail: "not_requester" });
  await runBatch(db, [
    db.update(approvals).set({ status: "rejected", decidedBy: actor.id, decidedAt: now, decisionNote: "withdrawn" }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
    auditStatement(db, { actor, action: "promotions.flash.withdraw", entityType: "flash_sale", entityId: approval.entityId, after: { approvalId: approval.id }, at: now }),
  ]).catch(changedGuard);
  return { saleId: approval.entityId };
}

export const CancelFlashInput = z.object({ saleId: z.string().regex(ID, "invalid"), reason: reasonText });

/** Cancels a draft or a scheduled sale (also one that is running: it stops at once). A waiting request is closed too. */
export async function cancelFlashSale(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ cancelled: boolean }> {
  assertCan(actor, "promotions.flash_sale.manage");
  const parsed = CancelFlashInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "flash.cancel");
  const input = parsed.data;
  const sale = await loadSale(db, input.saleId);
  if (sale.status === "cancelled") return { cancelled: false };
  if (sale.status !== "draft" && sale.status !== "scheduled" && sale.status !== "active") throw new AppError("flash_not_scheduled", 409);
  if (now >= sale.endsAt && sale.status !== "draft") throw new AppError("flash_not_scheduled", 409);
  const pending = await pendingApprovalOf(db, KIND, sale.id);
  const statements: BatchStatement[] = [
    db
      .update(flashSales)
      .set({ status: "cancelled" })
      .where(and(eq(flashSales.id, sale.id), eq(flashSales.status, sale.status))),
    expectChanged(db, 1, { code: "FLASH_CHANGED", detail: sale.id }),
  ];
  if (pending) statements.push(db.update(approvals).set({ status: "rejected", decidedBy: actor.kind === "employee" ? actor.id : "system", decidedAt: now, decisionNote: "cancelled" }).where(and(eq(approvals.id, pending.id), eq(approvals.status, "pending"))));
  statements.push(auditStatement(db, { actor, action: "promotions.flash.cancel", entityType: "flash_sale", entityId: sale.id, summary: sale.name.ar, before: { status: sale.status }, after: { status: "cancelled", running: sale.status !== "draft" && now >= sale.startsAt }, reason: input.reason, at: now }));
  await runBatch(db, statements).catch(changedGuard);
  return { cancelled: true };
}
