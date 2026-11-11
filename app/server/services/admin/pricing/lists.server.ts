/**
 * Price lists (admin 03.04) — prices per sales channel, branch and customer segment, with quantity breaks and a
 * validity window. The variant price is the fallback everywhere.
 *
 * HONEST BOUNDARY: the storefront cart, checkout and point of sale price every line with `variants.price_iqd`; they
 * do not read price lists yet. `resolveListPrice()` below is the rule they would call (request to the commerce core,
 * docs/areas/admin-pricing.md). Until then a list is a prepared, reviewed price set — the screens say so.
 * The product's condition (new / used / open box) is not a list dimension in the schema: used devices are priced
 * one unit at a time (special.server.ts).
 *
 *   await savePriceList(db, actor, { code: "POS-VIP", name: "…", channel: "pos", segmentId, priority: 10, reason }, now);
 *   await setListItem(db, actor, { listId, sku: "PS5-SLIM-DISC", minQty: 1, price: "735,000", reason }, now);
 *   const prices = await resolveListPrice(db, { variantIds, qty: 1, channel: "web", branchId: null, segmentIds: [], at: now });
 *
 * Needs pricing.price_list.manage to change; reading needs a pricing permission. A list price under the SKU's
 * minimum margin or landed cost needs pricing.discount.override (checked on the server; the reason is audited).
 * A list's "was" price may only be the SKU's own price, and only when that price has been charged for 90 days.
 * Error codes: forbidden (403), not_found (404), invalid (400), code_taken (409), override_required (403),
 * compare_at_not_charged (409), list_changed (409).
 */
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertBranch, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { branches, channels, customerSegments, priceChanges, priceListItems, priceLists, products, variants } from "~/server/db/schema";
import { expectChanged, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound } from "~/server/errors";
import { actorId, assertAny, fieldAccess, type FieldAccess } from "./access";
import { costBasisFor } from "./facts.server";
import { parseBaghdadDateTime } from "./fx.server";
import { formIqd, marginStateOf, type MarginState } from "./prices.server";
import { compareAtCheck, isOnStep, marginBps, MAX_PRICE_IQD, priceSegments, PRICE_STEP_IQD } from "./rules";

const READERS = ["pricing.price_list.manage", "pricing.price.update", "pricing.price.approve", "pricing.discount.override", "pricing.simulation.run"] as const;

export type ListState = "active" | "scheduled" | "ended" | "inactive";

export function listStateOf(list: { isActive: boolean; startsAt: number | null; endsAt: number | null }, now: number): ListState {
  if (!list.isActive) return "inactive";
  if (list.endsAt !== null && list.endsAt <= now) return "ended";
  if (list.startsAt !== null && list.startsAt > now) return "scheduled";
  return "active";
}

export type ListOption = { value: string; label: string };
export type ListOptions = { channels: ListOption[]; branches: ListOption[]; segments: ListOption[] };

export async function listOptions(db: Db, locale: Locale): Promise<ListOptions> {
  const [channelRows, branchRows, segmentRows] = await Promise.all([
    db.select({ key: channels.key, name: channels.name }).from(channels).where(eq(channels.isActive, true)).orderBy(asc(channels.key)),
    db.select({ id: branches.id, name: branches.name, code: branches.code }).from(branches).where(eq(branches.isActive, true)).orderBy(asc(branches.code)),
    db.select({ id: customerSegments.id, name: customerSegments.name }).from(customerSegments).orderBy(asc(customerSegments.key)),
  ]);
  return {
    channels: channelRows.map((row) => ({ value: row.key, label: pick(row.name, locale) || row.key })),
    branches: branchRows.map((row) => ({ value: row.id, label: pick(row.name, locale) || row.code })),
    segments: segmentRows.map((row) => ({ value: row.id, label: pick(row.name, locale) })),
  };
}

export type PriceListSummary = {
  id: string;
  code: string;
  name: string;
  nameL10n: L10n;
  channel: string | null;
  branchId: string | null;
  segmentId: string | null;
  scopeLabels: { channel: string | null; branch: string | null; segment: string | null };
  priority: number;
  startsAt: number | null;
  endsAt: number | null;
  isActive: boolean;
  state: ListState;
  items: number;
  updatedAt: number;
};

export async function listPriceLists(db: Db, actor: Actor, locale: Locale, now: number): Promise<{ lists: PriceListSummary[]; options: ListOptions; canManage: boolean }> {
  assertAny(actor, READERS);
  const [rows, options] = await Promise.all([
    db
      .select({ list: priceLists, items: sql<number>`(select count(*) from price_list_items i where i.price_list_id = ${priceLists.id})` })
      .from(priceLists)
      .orderBy(desc(priceLists.isActive), desc(priceLists.priority), asc(priceLists.code)),
    listOptions(db, locale),
  ]);
  return { lists: rows.map((row) => summary(row.list, Number(row.items), options, locale, now)), options, canManage: can(actor, "pricing.price_list.manage") };
}

function summary(list: typeof priceLists.$inferSelect, items: number, options: ListOptions, locale: Locale, now: number): PriceListSummary {
  const label = (entries: ListOption[], value: string | null) => (value === null ? null : (entries.find((entry) => entry.value === value)?.label ?? value));
  return {
    id: list.id,
    code: list.code,
    name: pick(list.name, locale),
    nameL10n: list.name,
    channel: list.channel,
    branchId: list.branchId,
    segmentId: list.segmentId,
    scopeLabels: { channel: label(options.channels, list.channel), branch: label(options.branches, list.branchId), segment: label(options.segments, list.segmentId) },
    priority: list.priority,
    startsAt: list.startsAt,
    endsAt: list.endsAt,
    isActive: list.isActive,
    state: listStateOf(list, now),
    items,
    updatedAt: list.updatedAt,
  };
}

export type ListItemView = {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  minQty: number;
  basePriceIqd: number;
  priceIqd: number;
  compareAtIqd: number | null;
  /** Price list price vs the SKU's own price, basis points (negative = cheaper). */
  diffBps: number | null;
  margin?: { bps: number | null; state: MarginState };
  cost?: { landedIqd: number | null };
};

export async function getPriceList(db: Db, actor: Actor, listId: string, locale: Locale, now: number): Promise<{ list: PriceListSummary; items: ListItemView[]; options: ListOptions; access: FieldAccess; canManage: boolean }> {
  assertAny(actor, READERS);
  const row = await db.select().from(priceLists).where(eq(priceLists.id, listId)).get();
  if (!row) throw notFound("price_list");
  const [itemRows, options] = await Promise.all([
    db
      .select({ item: priceListItems, sku: variants.sku, basePriceIqd: variants.priceIqd, productId: products.id, name: products.name })
      .from(priceListItems)
      .innerJoin(variants, eq(variants.id, priceListItems.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(priceListItems.priceListId, listId))
      .orderBy(asc(variants.sku), asc(priceListItems.minQty)),
    listOptions(db, locale),
  ]);
  const access = fieldAccess(actor);
  const costs = access.cost || access.profit ? await costBasisFor(db, itemRows.map((entry) => entry.item.variantId)) : null;
  return {
    list: summary(row, itemRows.length, options, locale, now),
    items: itemRows.map((entry): ListItemView => {
      const view: ListItemView = {
        variantId: entry.item.variantId,
        productId: entry.productId,
        sku: entry.sku,
        name: pick(entry.name, locale),
        minQty: entry.item.minQty,
        basePriceIqd: entry.basePriceIqd,
        priceIqd: entry.item.priceIqd,
        compareAtIqd: entry.item.compareAtIqd,
        diffBps: entry.basePriceIqd > 0 ? Math.trunc(((entry.item.priceIqd - entry.basePriceIqd) * 10_000) / entry.basePriceIqd) : null,
      };
      const basis = costs?.get(entry.item.variantId) ?? null;
      if (access.cost) view.cost = { landedIqd: basis?.landedIqd ?? null };
      if (access.profit) view.margin = { bps: basis ? marginBps(entry.item.priceIqd, basis.landedIqd) : null, state: marginStateOf(entry.item.priceIqd, basis) };
      return view;
    }),
    options,
    access,
    canManage: can(actor, "pricing.price_list.manage"),
  };
}

// ───────────────────────────────────────────────────────────────── writing lists

const optionalId = z.preprocess((value) => (value === "" || value === undefined ? null : value), z.string().trim().max(120, "invalid").nullable());
const optionalDate = z.preprocess((value) => (value === "" || value === undefined ? null : value), z.string().trim().max(20, "invalid").nullable());

export const PriceListInput = z.object({
  id: z.preprocess((value) => (value === "" ? undefined : value), z.string().trim().max(120).optional()),
  code: z
    .string({ error: "required" })
    .trim()
    .toUpperCase()
    .min(2, "required")
    .max(32, "too_long")
    .regex(/^[A-Z0-9][A-Z0-9_-]*$/, "code_format"),
  nameAr: z.string({ error: "required" }).trim().min(2, "required").max(80, "too_long"),
  nameEn: z.string().trim().max(80, "too_long").optional().default(""),
  channel: optionalId,
  branchId: optionalId,
  segmentId: optionalId,
  priority: z.preprocess((value) => (value === "" || value === undefined ? 0 : typeof value === "string" ? Number(value) : value), z.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(1000, "too_big")),
  startsOn: optionalDate,
  endsOn: optionalDate,
  isActive: z.preprocess((value) => value === true || value === "on" || value === "true" || value === "1", z.boolean()),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
  /** The list's updated_at when the form was opened (edits only). */
  expectedUpdatedAt: z.preprocess((value) => (value === "" || value === undefined ? undefined : Number(value)), z.number().optional()),
});

/**
 * Creates or edits a list. Channel, branch and segment must exist (or be empty = everyone). An employee limited to a
 * branch (SECURITY §7) manages that branch's lists only — not another branch's, and not a list for every branch.
 */
export async function savePriceList(db: Db, actor: Actor, raw: unknown, locale: Locale, now: number): Promise<{ id: string; created: boolean }> {
  assertCan(actor, "pricing.price_list.manage");
  const input = PriceListInput.parse(raw);
  assertBranch(actor, input.branchId);
  const options = await listOptions(db, locale);
  const fields: Record<string, string> = {};
  if (input.channel && !options.channels.some((entry) => entry.value === input.channel)) fields.channel = "invalid";
  if (input.branchId && !options.branches.some((entry) => entry.value === input.branchId)) fields.branchId = "invalid";
  if (input.segmentId && !options.segments.some((entry) => entry.value === input.segmentId)) fields.segmentId = "invalid";
  const startsAt = input.startsOn ? parseBaghdadDateTime(input.startsOn) : null;
  const endsAt = input.endsOn ? parseBaghdadDateTime(input.endsOn) : null;
  if (input.startsOn && startsAt === null) fields.startsOn = "invalid";
  if (input.endsOn && endsAt === null) fields.endsOn = "invalid";
  if (startsAt !== null && endsAt !== null && endsAt <= startsAt) fields.endsOn = "ends_before_start";
  if (Object.keys(fields).length) throw invalid(fields);
  const name: L10n = input.nameEn ? { ar: input.nameAr, en: input.nameEn } : { ar: input.nameAr };
  const values = { code: input.code, name, channel: input.channel, branchId: input.branchId, segmentId: input.segmentId, priority: input.priority, startsAt, endsAt, isActive: input.isActive, updatedAt: now };
  try {
    if (input.id) {
      const current = await db.select().from(priceLists).where(eq(priceLists.id, input.id)).get();
      if (!current) throw notFound("price_list");
      assertBranch(actor, current.branchId);
      if (input.expectedUpdatedAt !== undefined && current.updatedAt !== input.expectedUpdatedAt) throw new AppError("list_changed", 409, { detail: current.id });
      await runBatch(db, [
        db.update(priceLists).set(values).where(and(eq(priceLists.id, current.id), eq(priceLists.updatedAt, current.updatedAt))),
        expectChanged(db, 1, { code: "LIST_CHANGED", detail: current.id }),
        auditStatement(db, {
          actor,
          action: "pricing.price_list.update",
          entityType: "price_list",
          entityId: current.id,
          summary: input.code,
          before: { code: current.code, name: current.name, channel: current.channel, branchId: current.branchId, segmentId: current.segmentId, priority: current.priority, startsAt: current.startsAt, endsAt: current.endsAt, isActive: current.isActive },
          after: values,
          reason: input.reason,
          at: now,
        }),
      ]);
      return { id: current.id, created: false };
    }
    const id = newId("prl");
    await runBatch(db, [
      db.insert(priceLists).values({ id, ...values, createdBy: actorId(actor), createdAt: now }),
      auditStatement(db, { actor, action: "pricing.price_list.create", entityType: "price_list", entityId: id, summary: input.code, after: values, reason: input.reason, at: now }),
    ]);
    return { id, created: true };
  } catch (error) {
    if (isUniqueViolation(error, "price_lists.code")) throw new AppError("code_taken", 409, { fields: { code: "code_taken" } });
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────── items

export const ListItemInput = z.object({
  listId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  /** The SKU as typed or scanned (a barcode works too); stored by variant id. */
  sku: z.string({ error: "required" }).trim().min(1, "required").max(80, "too_long"),
  minQty: z.preprocess((value) => (value === "" || value === undefined ? 1 : typeof value === "string" ? Number(value) : value), z.number({ error: "invalid" }).int("invalid").min(1, "too_small").max(1000, "too_big")),
  price: z.preprocess(formIqd, z.number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") }).int("invalid").min(PRICE_STEP_IQD, "too_small").max(MAX_PRICE_IQD, "too_big").refine(isOnStep, "price_step")),
  compareAt: z.preprocess((value) => (value === "" || value === undefined ? null : formIqd(value)), z.number({ error: "invalid" }).int("invalid").nullable()),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
});

async function variantBySku(db: Db, code: string) {
  return db
    .select({ id: variants.id, sku: variants.sku, priceIqd: variants.priceIqd, createdAt: variants.createdAt, productStatus: products.status, publishedAt: products.publishedAt, productCreatedAt: products.createdAt })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(or(eq(sql`upper(${variants.sku})`, code.toUpperCase()), eq(variants.barcode, code)))
    .get();
}

/** Adds or replaces one list price (list × SKU × minimum quantity). */
export async function setListItem(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ variantId: string; created: boolean }> {
  assertCan(actor, "pricing.price_list.manage");
  const input = ListItemInput.parse(raw);
  const list = await db.select({ id: priceLists.id, code: priceLists.code, branchId: priceLists.branchId }).from(priceLists).where(eq(priceLists.id, input.listId)).get();
  if (!list) throw notFound("price_list");
  assertBranch(actor, list.branchId);
  const variant = await variantBySku(db, input.sku);
  if (!variant) throw invalid({ sku: "sku_unknown" });
  if (input.compareAt !== null) {
    if (input.compareAt <= input.price) throw invalid({ compareAt: "compare_at_not_higher" });
    if (input.compareAt !== variant.priceIqd) throw invalid({ compareAt: "compare_at_base_only" });
    const history = await db
      .select({ at: priceChanges.createdAt, oldPriceIqd: priceChanges.oldPriceIqd, newPriceIqd: priceChanges.newPriceIqd })
      .from(priceChanges)
      .where(and(eq(priceChanges.variantId, variant.id), eq(priceChanges.status, "applied")));
    const onSaleFrom = variant.productStatus === "published" || variant.publishedAt !== null ? (variant.publishedAt ?? variant.productCreatedAt) : null;
    const check = compareAtCheck(input.compareAt, priceSegments(variant.priceIqd, variant.createdAt, history, now), onSaleFrom, now);
    if (!check.ok) throw new AppError("compare_at_not_charged", 409, { fields: { compareAt: "compare_at_not_charged" }, detail: String(check.days) });
  }
  const basis = (await costBasisFor(db, [variant.id])).get(variant.id) ?? null;
  const state = marginStateOf(input.price, basis);
  if ((state === "below_min" || state === "below_cost") && !can(actor, "pricing.discount.override")) throw new AppError("override_required", 403, { fields: { price: "override_required" }, detail: "pricing.discount.override" });
  const current = await db
    .select()
    .from(priceListItems)
    .where(and(eq(priceListItems.priceListId, list.id), eq(priceListItems.variantId, variant.id), eq(priceListItems.minQty, input.minQty)))
    .get();
  await runBatch(db, [
    db
      .insert(priceListItems)
      .values({ priceListId: list.id, variantId: variant.id, minQty: input.minQty, priceIqd: input.price, compareAtIqd: input.compareAt })
      .onConflictDoUpdate({ target: [priceListItems.priceListId, priceListItems.variantId, priceListItems.minQty], set: { priceIqd: input.price, compareAtIqd: input.compareAt } }),
    db.update(priceLists).set({ updatedAt: now }).where(eq(priceLists.id, list.id)),
    auditStatement(db, {
      actor,
      action: "pricing.price_list.item_set",
      entityType: "price_list",
      entityId: list.id,
      summary: `${list.code} ${variant.sku}`,
      before: current ? { variantId: variant.id, minQty: current.minQty, priceIqd: current.priceIqd, compareAtIqd: current.compareAtIqd } : null,
      // The margin state is recorded so a price under the floor shows who allowed it and why.
      after: { variantId: variant.id, sku: variant.sku, minQty: input.minQty, priceIqd: input.price, compareAtIqd: input.compareAt, override: state === "below_min" || state === "below_cost" },
      reason: input.reason,
      at: now,
    }),
  ]);
  return { variantId: variant.id, created: !current };
}

export const RemoveItemInput = z.object({
  listId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  variantId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  minQty: z.preprocess((value) => (typeof value === "string" ? Number(value) : value), z.number().int().min(1)),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
});

export async function removeListItem(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "pricing.price_list.manage");
  const input = RemoveItemInput.parse(raw);
  const list = await db.select({ branchId: priceLists.branchId }).from(priceLists).where(eq(priceLists.id, input.listId)).get();
  if (!list) throw notFound("price_list");
  assertBranch(actor, list.branchId);
  const current = await db
    .select()
    .from(priceListItems)
    .where(and(eq(priceListItems.priceListId, input.listId), eq(priceListItems.variantId, input.variantId), eq(priceListItems.minQty, input.minQty)))
    .get();
  if (!current) return;
  await runBatch(db, [
    db.delete(priceListItems).where(and(eq(priceListItems.priceListId, input.listId), eq(priceListItems.variantId, input.variantId), eq(priceListItems.minQty, input.minQty))),
    db.update(priceLists).set({ updatedAt: now }).where(eq(priceLists.id, input.listId)),
    auditStatement(db, { actor, action: "pricing.price_list.item_remove", entityType: "price_list", entityId: input.listId, before: { variantId: current.variantId, minQty: current.minQty, priceIqd: current.priceIqd, compareAtIqd: current.compareAtIqd }, after: null, reason: input.reason, at: now }),
  ]);
}

// ───────────────────────────────────────────────────────────────── resolving (for the commerce core)

export type ResolveContext = { variantIds: readonly string[]; qty?: number; channel?: string | null; branchId?: string | null; segmentIds?: readonly string[]; at: number };
export type ListPrice = { priceIqd: number; compareAtIqd: number | null; listId: string; listCode: string };

/**
 * The list price that applies to each SKU in a context, or null (= the variant's own price). Matching lists: active,
 * inside their window, and each of channel / branch / segment either empty or equal to the context's. The highest
 * priority wins, then the more specific list (more dimensions set), then the larger quantity break (the largest
 * minimum quantity not above `qty`), then the lower price. A list price never applies when it is not lower than the SKU's price.
 * Read-only; no permission (callers are the cart / checkout / POS of the commerce core).
 */
export async function resolveListPrice(db: Db, context: ResolveContext): Promise<Map<string, ListPrice | null>> {
  const out = new Map<string, ListPrice | null>(context.variantIds.map((id) => [id, null]));
  if (context.variantIds.length === 0) return out;
  const qty = Math.max(1, Math.floor(context.qty ?? 1));
  const segments = [...(context.segmentIds ?? [])];
  const rows = await db
    .select({ list: priceLists, item: priceListItems, basePriceIqd: variants.priceIqd })
    .from(priceListItems)
    .innerJoin(priceLists, eq(priceLists.id, priceListItems.priceListId))
    .innerJoin(variants, eq(variants.id, priceListItems.variantId))
    .where(
      and(
        inArray(priceListItems.variantId, [...context.variantIds]),
        lte(priceListItems.minQty, qty),
        eq(priceLists.isActive, true),
        or(isNull(priceLists.startsAt), lte(priceLists.startsAt, context.at)),
        or(isNull(priceLists.endsAt), gt(priceLists.endsAt, context.at)),
        context.channel ? or(isNull(priceLists.channel), eq(priceLists.channel, context.channel)) : isNull(priceLists.channel),
        context.branchId ? or(isNull(priceLists.branchId), eq(priceLists.branchId, context.branchId)) : isNull(priceLists.branchId),
        segments.length ? or(isNull(priceLists.segmentId), inArray(priceLists.segmentId, segments)) : isNull(priceLists.segmentId),
      ),
    );
  const specificity = (list: typeof priceLists.$inferSelect) => Number(list.channel !== null) + Number(list.branchId !== null) + Number(list.segmentId !== null);
  const best = new Map<string, (typeof rows)[number]>();
  for (const row of rows) {
    if (row.item.priceIqd >= row.basePriceIqd) continue;
    const current = best.get(row.item.variantId);
    if (!current) {
      best.set(row.item.variantId, row);
      continue;
    }
    const a = [row.list.priority, specificity(row.list), row.item.minQty, -row.item.priceIqd];
    const b = [current.list.priority, specificity(current.list), current.item.minQty, -current.item.priceIqd];
    const better = a.findIndex((value, index) => value !== b[index]);
    if (better !== -1 && a[better] > b[better]) best.set(row.item.variantId, row);
  }
  for (const [variantId, row] of best) out.set(variantId, { priceIqd: row.item.priceIqd, compareAtIqd: row.item.compareAtIqd, listId: row.list.id, listCode: row.list.code });
  return out;
}

/** The lists that carry a SKU, with its price there (the SKU page). */
export async function listsForVariant(db: Db, actor: Actor, variantId: string, locale: Locale, now: number): Promise<{ listId: string; code: string; name: string; state: ListState; minQty: number; priceIqd: number; compareAtIqd: number | null }[]> {
  assertAny(actor, READERS);
  const rows = await db
    .select({ list: priceLists, item: priceListItems })
    .from(priceListItems)
    .innerJoin(priceLists, eq(priceLists.id, priceListItems.priceListId))
    .where(eq(priceListItems.variantId, variantId))
    .orderBy(desc(priceLists.priority), asc(priceLists.code), asc(priceListItems.minQty));
  return rows.map(({ list, item }) => ({ listId: list.id, code: list.code, name: pick(list.name, locale), state: listStateOf(list, now), minQty: item.minQty, priceIqd: item.priceIqd, compareAtIqd: item.compareAtIqd }));
}
