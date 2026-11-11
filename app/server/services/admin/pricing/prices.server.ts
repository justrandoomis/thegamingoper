/**
 * Selling prices (admin 03.03, 03.05, 03.07) — the SKU price list, one SKU's pricing facts, and price changes:
 * request → (approval) → applied, with the full history.
 *
 *   const result = await requestPriceChange(db, actor, { variantId, newPriceIqd, newCompareAtIqd, reason, idempotencyKey }, now);
 *   // result.status: "applied" (within the rules) or "pending" (waits for a second person)
 *   await decidePriceChange(db, otherEmployee, { requestId, decision: "approve" | "reject", note }, now);
 *   await cancelPriceChange(db, requester, { requestId, note }, now);
 *
 * RULES (rules.ts → evaluatePriceChange)
 *   · pricing.price.update applies a change at once when it trips no rule; otherwise it is stored as a pending
 *     request with an `approvals` row (kind "price_change") and waits.
 *   · A cut of more than 10 % — counted from the highest price of the last 30 days, or since the last approved change, so
 *     small cuts cannot add up to a deep one — a new or changed "was" price, any new price on a SKU without a cost, and
 *     every clearance price need pricing.price.approve; a price under the SKU's minimum margin or under its landed cost needs
 *     pricing.discount.override as well. The approver is never the requester (four eyes).
 *   · A "was" (compare-at) price must be higher than the new price and must have been charged, exactly, for 90 days
 *     in a row while the product was on sale, within the last year — checked again when the request is approved.
 *   · One pending request per SKU at a time; a direct change waits until it is decided.
 *
 * WRITES — one batch each, with guards: the variant row changes only if its price is still the one the decision
 * was made on (`price_changed`); `price_changes` rows are append-only (a decision is a new row pointing at its
 * request); every change writes an audit event with before/after and the reason. Carts re-price at checkout
 * (`totals_changed`), and orders keep their own price snapshot, so placed orders never change.
 *
 * IDEMPOTENCY — a request's row id is derived from the employee and the form's idempotency key, so a double submit
 * returns the first result (`replayed: true`) instead of a second request.
 *
 * FIELD ACCESS — landed cost only with cost.read; margins, floors and margin-based reasons only with profit.read.
 *
 * Error codes: forbidden (403), not_found (404), invalid (400, fields: newPriceIqd price_step|no_change|too_small|
 * too_big, newCompareAtIqd compare_at_not_higher, reason reason_short), compare_at_not_charged (409),
 * change_pending (409), price_changed (409), cost_changed (409), change_not_pending (409),
 * approver_is_requester (403), override_required (403), not_requester (403), note_required (400).
 */
import { and, asc, desc, eq, inArray, isNull, or, sql, type AnyColumn, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, sha256Hex } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, employees, platforms, priceChanges, products, variantCosts, variants, PRODUCT_KINDS, PRODUCT_STATUSES, type ProductKind, type ProductStatus } from "~/server/db/schema";
import { expectChanged, expectThat, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, toAppError } from "~/server/errors";
import { actorId, assertAny, fieldAccess, type FieldAccess } from "./access";
import { bundleComponentsFor, chunks, costBasisFor, onHandFor } from "./facts.server";
import {
  CHANGE_MODES,
  COMPARE_AT_MIN_DAYS,
  compareAtCheck,
  dropReferencePrice,
  evaluatePriceChange,
  isOnStep,
  marginBps,
  MAX_PRICE_IQD,
  OVERRIDE_REASONS,
  parseDecimal,
  priceForMargin,
  priceSegments,
  PRICE_STEP_IQD,
  type AppliedChange,
  type ChangeEvaluation,
  type ChangeMode,
  type ChangeReason,
  type CostBasis,
} from "./rules";

// ───────────────────────────────────────────────────────────────── shared

/** Margin of a SKU against its rules. */
export type MarginState = "ok" | "below_target" | "below_min" | "below_cost" | "no_cost";

export function marginStateOf(priceIqd: number, cost: CostBasis | null): MarginState {
  if (!cost) return "no_cost";
  if (priceIqd < cost.landedIqd) return "below_cost";
  const margin = marginBps(priceIqd, cost.landedIqd) ?? -Infinity;
  if (cost.minMarginBps !== null && margin < cost.minMarginBps) return "below_min";
  if (cost.targetMarginBps !== null && margin < cost.targetMarginBps) return "below_target";
  return "ok";
}

/** Reasons a person may see: margin-based ones reveal cost information and need profit.read. */
export function visibleReasons(reasons: readonly ChangeReason[], access: FieldAccess): ChangeReason[] {
  return reasons.filter((reason) => access.profit || !(OVERRIDE_REASONS.has(reason) || reason === "cost_unknown"));
}

const escapeLike = (text: string) => text.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/** The SQL that says "this SKU has a request nobody has decided yet". */
const pendingExists = (variantIdSql: SQL | string) =>
  sql`exists (select 1 from price_changes p where p.variant_id = ${variantIdSql} and p.status = 'pending' and not exists (select 1 from price_changes d where d.request_id = p.id))`;

/** Typed IQD from a form ("749,000", "٧٤٩٠٠٠") or a number; empty → undefined (required), unreadable → NaN (invalid). */
export function formIqd(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    if (value.trim() === "") return undefined;
    return parseDecimal(value, 0) ?? Number.NaN;
  }
  return value;
}

const priceField = z.preprocess(
  formIqd,
  z
    .number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") })
    .int("invalid")
    .min(PRICE_STEP_IQD, "too_small")
    .max(MAX_PRICE_IQD, "too_big")
    .refine((value) => isOnStep(value), "price_step"),
);
const optionalPriceField = z.preprocess((value) => (value === "" || value === undefined ? null : formIqd(value)), priceField.nullable());

// ───────────────────────────────────────────────────────────────── the SKU price list

export const PRICE_VIEWS = ["all", "pending", "on_sale", "bundles", "below_min", "below_target", "no_cost"] as const;
export type PriceView = (typeof PRICE_VIEWS)[number];
export const PRICE_SORTS = ["sku", "name", "price", "stock", "margin"] as const;
export type PriceSort = (typeof PRICE_SORTS)[number];

export type PriceFilters = {
  q: string;
  kind: ProductKind | null;
  platform: string | null;
  status: ProductStatus | null;
  view: PriceView;
  sort: PriceSort;
  dir: "asc" | "desc";
  page: number;
};

export const PAGE_SIZE = 50;

/** Filters from the URL. Views and sorts that need cost.read / profit.read fall back for actors without them. */
export function parsePriceFilters(params: URLSearchParams, access: FieldAccess): PriceFilters {
  const q = (params.get("q") ?? "").trim().slice(0, 100);
  const kind = params.get("kind");
  const status = params.get("status");
  const view = params.get("view");
  const sort = params.get("sort");
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  const allowedView = (value: string | null): PriceView => {
    if (!value || !(PRICE_VIEWS as readonly string[]).includes(value)) return "all";
    if ((value === "below_min" || value === "below_target") && !access.profit) return "all";
    if (value === "no_cost" && !access.cost) return "all";
    return value as PriceView;
  };
  const allowedSort = (value: string | null): PriceSort => {
    if (!value || !(PRICE_SORTS as readonly string[]).includes(value)) return "sku";
    if (value === "margin" && !access.profit) return "sku";
    return value as PriceSort;
  };
  return {
    q,
    kind: kind && (PRODUCT_KINDS as readonly string[]).includes(kind) ? (kind as ProductKind) : null,
    platform: params.get("platform")?.trim().slice(0, 60) || null,
    status: status && (PRODUCT_STATUSES as readonly string[]).includes(status) ? (status as ProductStatus) : null,
    view: allowedView(view),
    sort: allowedSort(sort),
    dir: params.get("dir") === "desc" ? "desc" : "asc",
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
  };
}

export type SkuRow = {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  variantTitle: string | null;
  kind: ProductKind;
  productStatus: ProductStatus;
  isActive: boolean;
  isBundle: boolean;
  priceIqd: number;
  compareAtIqd: number | null;
  onHand: number;
  /** Id of the request waiting for a decision, if any. */
  pendingId: string | null;
  /** cost.read only: the landed cost priced against (null = no cost known). */
  cost?: { landedIqd: number | null; source: "own" | "bundle" | null };
  /** profit.read only. */
  margin?: { bps: number | null; minBps: number | null; targetBps: number | null; state: MarginState };
};

export type SkuPage = { rows: SkuRow[]; total: number; page: number; pageCount: number; access: FieldAccess; platforms: { id: string; slug: string; name: string }[] };

/** Landed cost the SKU is priced against, in SQL: its own row, else the full sum of its bundle components. */
const effectiveLandedSql = sql<number | null>`coalesce(${variantCosts.landedCostIqd}, (select case when count(*) > 0 and count(*) = count(c.variant_id) then sum(c.landed_cost_iqd * bi.qty) end from bundle_items bi left join variant_costs c on c.variant_id = bi.component_variant_id where bi.bundle_variant_id = ${variants.id}))`;
const isBundleSql = sql<number>`exists (select 1 from bundle_items bi2 where bi2.bundle_variant_id = ${variants.id})`;
const onHandSql = sql<number>`coalesce((select sum(sl.on_hand) from stock_levels sl where sl.variant_id = ${variants.id}), 0)`;
const marginSql = sql<number | null>`case when ${variants.priceIqd} > 0 and ${effectiveLandedSql} is not null then ((${variants.priceIqd} - ${effectiveLandedSql}) * 10000.0) / ${variants.priceIqd} end`;

function nameSql(locale: Locale): SQL {
  return locale === "ar" ? sql`json_extract(${products.name}, '$.ar')` : sql`coalesce(json_extract(${products.name}, '$.${sql.raw(locale)}'), json_extract(${products.name}, '$.ar'))`;
}

function filterSql(filters: PriceFilters): SQL | undefined {
  const parts: SQL[] = [];
  if (filters.q) {
    const term = `%${escapeLike(filters.q)}%`;
    parts.push(or(sql`${variants.sku} like ${term} escape '\\'`, sql`${variants.barcode} like ${term} escape '\\'`, sql`${products.name} like ${term} escape '\\'`, sql`${products.slug} like ${term} escape '\\'`)!);
  }
  if (filters.kind) parts.push(eq(products.kind, filters.kind));
  if (filters.status) parts.push(eq(products.status, filters.status));
  if (filters.platform) parts.push(eq(platforms.slug, filters.platform));
  switch (filters.view) {
    case "pending":
      parts.push(pendingExists(sql`${variants.id}`));
      break;
    case "on_sale":
      parts.push(sql`${variants.compareAtIqd} is not null`);
      break;
    case "bundles":
      parts.push(isBundleSql);
      break;
    case "no_cost":
      parts.push(sql`${effectiveLandedSql} is null`);
      break;
    case "below_min":
      parts.push(sql`(${effectiveLandedSql} is not null and (${variants.priceIqd} < ${effectiveLandedSql} or (${variantCosts.minMarginBps} is not null and ${marginSql} < ${variantCosts.minMarginBps})))`);
      break;
    case "below_target":
      parts.push(sql`(${effectiveLandedSql} is not null and ${variantCosts.targetMarginBps} is not null and ${marginSql} < ${variantCosts.targetMarginBps})`);
      break;
    default:
      break;
  }
  return parts.length ? and(...parts) : undefined;
}

function orderSql(filters: PriceFilters, locale: Locale): SQL[] {
  const dir = (expr: SQL | AnyColumn) => (filters.dir === "desc" ? desc(expr) : asc(expr));
  switch (filters.sort) {
    case "name":
      return [dir(nameSql(locale)), asc(variants.sku)];
    case "price":
      return [dir(variants.priceIqd), asc(variants.sku)];
    case "stock":
      return [dir(onHandSql), asc(variants.sku)];
    case "margin":
      return [sql`(${marginSql}) is null`, dir(marginSql), asc(variants.sku)];
    default:
      return [dir(variants.sku)];
  }
}

const SKU_READERS = ["pricing.price.update", "pricing.price.approve", "pricing.cost.update", "pricing.margin.manage", "pricing.simulation.run", "pricing.suggestion.read", "pricing.price_list.manage", "pricing.discount.override", "pricing.used.update", "pricing.fx_rate.manage"] as const;

/** A SKU row as the database gives it — [P] fields included. Internal: services gate it with toSkuRow / their own rules. */
export type RawSkuRow = {
  variantId: string;
  productId: string;
  categoryId: string | null;
  sku: string;
  name: SkuNameL10n;
  title: SkuNameL10n | null;
  kind: ProductKind;
  productStatus: ProductStatus;
  isActive: boolean;
  priceIqd: number;
  compareAtIqd: number | null;
  onHand: number;
  isBundle: boolean;
  pendingId: string | null;
  basis: CostBasis | null;
};
type SkuNameL10n = { ar: string; en?: string; ckb?: string };

const skuSelect = {
  variantId: variants.id,
  productId: products.id,
  categoryId: products.categoryId,
  sku: variants.sku,
  name: products.name,
  title: variants.title,
  kind: products.kind,
  productStatus: products.status,
  isActive: variants.isActive,
  priceIqd: variants.priceIqd,
  compareAtIqd: variants.compareAtIqd,
  onHand: onHandSql,
  isBundle: isBundleSql,
  pendingId: sql<string | null>`(select p.id from price_changes p where p.variant_id = ${variants.id} and p.status = 'pending' and not exists (select 1 from price_changes d where d.request_id = p.id) limit 1)`,
  landed: effectiveLandedSql,
  ownCost: sql<number>`${variantCosts.variantId} is not null`,
  minMarginBps: variantCosts.minMarginBps,
  targetMarginBps: variantCosts.targetMarginBps,
};

/** Rows of the filters, in their order (one query). */
export async function querySkuRows(db: Db, filters: PriceFilters, locale: Locale, limit: number, offset = 0): Promise<RawSkuRow[]> {
  const rows = await db
    .select(skuSelect)
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(platforms, eq(platforms.id, products.platformId))
    .leftJoin(variantCosts, eq(variantCosts.variantId, variants.id))
    .where(filterSql(filters))
    .orderBy(...orderSql(filters, locale))
    .limit(limit)
    .offset(offset);
  return rows.map((row) => {
    const landed = row.landed === null ? null : Number(row.landed);
    return {
      variantId: row.variantId,
      productId: row.productId,
      categoryId: row.categoryId,
      sku: row.sku,
      name: row.name,
      title: row.title ?? null,
      kind: row.kind,
      productStatus: row.productStatus,
      isActive: row.isActive,
      priceIqd: row.priceIqd,
      compareAtIqd: row.compareAtIqd,
      onHand: Number(row.onHand),
      isBundle: Boolean(row.isBundle),
      pendingId: row.pendingId,
      basis: landed === null ? null : { landedIqd: landed, minMarginBps: row.minMarginBps, targetMarginBps: row.targetMarginBps, source: row.ownCost ? "own" : "bundle" },
    };
  });
}

export async function countSkuRows(db: Db, filters: PriceFilters): Promise<number> {
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .leftJoin(platforms, eq(platforms.id, products.platformId))
    .leftJoin(variantCosts, eq(variantCosts.variantId, variants.id))
    .where(filterSql(filters));
  return Number(total);
}

/** A raw row as this actor may see it: landed cost only with cost.read, margins only with profit.read. */
export function toSkuRow(row: RawSkuRow, access: FieldAccess, locale: Locale): SkuRow {
  const out: SkuRow = {
    variantId: row.variantId,
    productId: row.productId,
    sku: row.sku,
    name: pick(row.name, locale),
    variantTitle: row.title ? pick(row.title, locale) || null : null,
    kind: row.kind,
    productStatus: row.productStatus,
    isActive: row.isActive,
    isBundle: row.isBundle,
    priceIqd: row.priceIqd,
    compareAtIqd: row.compareAtIqd,
    onHand: row.onHand,
    pendingId: row.pendingId,
  };
  const basis = row.basis;
  if (access.cost) out.cost = { landedIqd: basis ? basis.landedIqd : null, source: basis ? basis.source : null };
  if (access.profit) out.margin = { bps: basis ? marginBps(row.priceIqd, basis.landedIqd) : null, minBps: basis?.minMarginBps ?? null, targetBps: basis?.targetMarginBps ?? null, state: marginStateOf(row.priceIqd, basis) };
  return out;
}

export async function platformOptions(db: Db, locale: Locale): Promise<{ id: string; slug: string; name: string }[]> {
  const rows = await db.select({ id: platforms.id, slug: platforms.slug, name: platforms.name }).from(platforms).orderBy(asc(platforms.sort));
  return rows.map((row) => ({ id: row.id, slug: row.slug, name: pick(row.name, locale) }));
}

/** One page of SKUs with prices — and landed cost / margins for actors allowed to see them. */
export async function listSkuPrices(db: Db, actor: Actor, filters: PriceFilters, locale: Locale): Promise<SkuPage> {
  assertAny(actor, SKU_READERS);
  const access = fieldAccess(actor);
  const total = await countSkuRows(db, filters);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const [rows, platformList] = await Promise.all([querySkuRows(db, filters, locale, PAGE_SIZE, (page - 1) * PAGE_SIZE), platformOptions(db, locale)]);
  return { rows: rows.map((row) => toSkuRow(row, access, locale)), total, page, pageCount, access, platforms: platformList };
}

/** Every row of the current filters (no paging), for the CSV export. Capped at 5,000 rows. */
export async function allSkuPrices(db: Db, actor: Actor, filters: PriceFilters, locale: Locale): Promise<{ rows: SkuRow[]; access: FieldAccess; truncated: boolean }> {
  assertAny(actor, SKU_READERS);
  const access = fieldAccess(actor);
  const rows = await querySkuRows(db, filters, locale, 5_001);
  return { rows: rows.slice(0, 5_000).map((row) => toSkuRow(row, access, locale)), access, truncated: rows.length > 5_000 };
}

// ───────────────────────────────────────────────────────────────── one SKU

type VariantFacts = {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  title: string | null;
  kind: ProductKind;
  productStatus: ProductStatus;
  isActive: boolean;
  priceIqd: number;
  compareAtIqd: number | null;
  createdAt: number;
  /** When the product went on sale (published); null while it never was. */
  onSaleFrom: number | null;
  pendingId: string | null;
  cost: CostBasis | null;
  history: AppliedChange[];
};

async function loadVariantFacts(db: Db, variantId: string, locale: Locale): Promise<VariantFacts | null> {
  const row = await db
    .select({
      variantId: variants.id,
      productId: products.id,
      sku: variants.sku,
      name: products.name,
      title: variants.title,
      kind: products.kind,
      productStatus: products.status,
      publishedAt: products.publishedAt,
      productCreatedAt: products.createdAt,
      isActive: variants.isActive,
      priceIqd: variants.priceIqd,
      compareAtIqd: variants.compareAtIqd,
      createdAt: variants.createdAt,
    })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(variants.id, variantId))
    .get();
  if (!row) return null;
  const [pending, applied, costs] = await Promise.all([
    db
      .select({ id: priceChanges.id })
      .from(priceChanges)
      .where(and(eq(priceChanges.variantId, variantId), eq(priceChanges.status, "pending"), sql`not exists (select 1 from price_changes d where d.request_id = ${priceChanges.id})`))
      .get(),
    db
      .select({ at: priceChanges.createdAt, oldPriceIqd: priceChanges.oldPriceIqd, newPriceIqd: priceChanges.newPriceIqd, approvedBy: priceChanges.approvedBy })
      .from(priceChanges)
      .where(and(eq(priceChanges.variantId, variantId), eq(priceChanges.status, "applied")))
      .orderBy(asc(priceChanges.createdAt)),
    costBasisFor(db, [variantId]),
  ]);
  const onSaleFrom = row.productStatus === "published" || row.publishedAt !== null ? (row.publishedAt ?? row.productCreatedAt) : null;
  return {
    variantId: row.variantId,
    productId: row.productId,
    sku: row.sku,
    name: pick(row.name, locale),
    title: row.title ? pick(row.title, locale) || null : null,
    kind: row.kind,
    productStatus: row.productStatus,
    isActive: row.isActive,
    priceIqd: row.priceIqd,
    compareAtIqd: row.compareAtIqd,
    // A variant cannot have been sold before it existed, even when its product is older.
    createdAt: row.createdAt,
    onSaleFrom,
    pendingId: pending?.id ?? null,
    cost: costs.get(variantId) ?? null,
    // A decision row carries its decider: an approved change starts a new drop window.
    history: applied.map((change) => ({ at: change.at, oldPriceIqd: change.oldPriceIqd, newPriceIqd: change.newPriceIqd, approved: change.approvedBy !== null })),
  };
}

/** The price a cut of this SKU is measured from today (rules.ts → dropReferencePrice). */
const referenceOf = (facts: VariantFacts, now: number) => dropReferencePrice(facts.priceIqd, facts.createdAt, facts.history, now);

/** May today's price serve as a "was" price, and since when has it been charged? (Public facts — no cost.) */
export type CompareAtFacts = { currentSince: number; currentDays: number; eligibleNow: boolean; eligibleFrom: number };

function compareAtFacts(facts: VariantFacts, now: number): CompareAtFacts {
  const segments = priceSegments(facts.priceIqd, facts.createdAt, facts.history, now);
  const current = segments[segments.length - 1];
  const since = current ? Math.max(current.from, facts.onSaleFrom ?? current.from) : now;
  const check = compareAtCheck(facts.priceIqd, segments, facts.onSaleFrom, now);
  return { currentSince: since, currentDays: check.days, eligibleNow: check.ok, eligibleFrom: since + COMPARE_AT_MIN_DAYS * 86_400_000 };
}

export type SkuPricing = {
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  variantTitle: string | null;
  kind: ProductKind;
  productStatus: ProductStatus;
  isActive: boolean;
  priceIqd: number;
  compareAtIqd: number | null;
  onHand: number;
  pending: ChangeView | null;
  compareAt: CompareAtFacts;
  components: { variantId: string; sku: string; name: string; qty: number; priceIqd: number; landedIqd?: number | null }[];
  /** cost.read only. */
  cost?: { basis: CostBasis | null };
  /** profit.read only. */
  margin?: { bps: number | null; state: MarginState; floorIqd: number | null; targetIqd: number | null };
  access: FieldAccess;
  can: { request: boolean; approve: boolean; override: boolean; editCost: boolean; editMargins: boolean; suggest: boolean; simulate: boolean };
};

export async function getSkuPricing(db: Db, actor: Actor, variantId: string, locale: Locale, now: number): Promise<SkuPricing> {
  assertAny(actor, SKU_READERS);
  const facts = await loadVariantFacts(db, variantId, locale);
  if (!facts) throw notFound("variant");
  const access = fieldAccess(actor);
  const [stock, components, pendingViews] = await Promise.all([
    onHandFor(db, [variantId]),
    bundleComponentsFor(db, [variantId]),
    facts.pendingId ? listChangeViews(db, actor, { requestIds: [facts.pendingId] }, locale) : Promise.resolve([]),
  ]);
  const parts = components.get(variantId) ?? [];
  const partRows = parts.length
    ? await db
        .select({ variantId: variants.id, sku: variants.sku, name: products.name, priceIqd: variants.priceIqd })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .where(inArray(variants.id, parts.map((part) => part.componentVariantId)))
    : [];
  const partCosts = access.cost && parts.length ? await costBasisFor(db, parts.map((part) => part.componentVariantId)) : null;
  const result: SkuPricing = {
    variantId: facts.variantId,
    productId: facts.productId,
    sku: facts.sku,
    name: facts.name,
    variantTitle: facts.title,
    kind: facts.kind,
    productStatus: facts.productStatus,
    isActive: facts.isActive,
    priceIqd: facts.priceIqd,
    compareAtIqd: facts.compareAtIqd,
    onHand: stock.get(variantId) ?? 0,
    pending: pendingViews[0] ?? null,
    compareAt: compareAtFacts(facts, now),
    components: parts.map((part) => {
      const row = partRows.find((candidate) => candidate.variantId === part.componentVariantId);
      const entry: SkuPricing["components"][number] = { variantId: part.componentVariantId, sku: row?.sku ?? part.componentVariantId, name: row ? pick(row.name, locale) : "", qty: part.qty, priceIqd: row?.priceIqd ?? 0 };
      if (partCosts) entry.landedIqd = partCosts.get(part.componentVariantId)?.landedIqd ?? null;
      return entry;
    }),
    access,
    can: {
      request: can(actor, "pricing.price.update"),
      approve: can(actor, "pricing.price.approve"),
      override: can(actor, "pricing.discount.override"),
      editCost: can(actor, "pricing.cost.update") && access.cost,
      editMargins: can(actor, "pricing.margin.manage") && access.profit,
      suggest: can(actor, "pricing.suggestion.read") && access.cost,
      simulate: can(actor, "pricing.simulation.run"),
    },
  };
  if (access.cost) result.cost = { basis: facts.cost };
  if (access.profit) {
    const basis = facts.cost;
    result.margin = {
      bps: basis ? marginBps(facts.priceIqd, basis.landedIqd) : null,
      state: marginStateOf(facts.priceIqd, basis),
      floorIqd: basis ? (basis.minMarginBps !== null ? priceForMargin(basis.landedIqd, basis.minMarginBps) : basis.landedIqd) : null,
      targetIqd: basis && basis.targetMarginBps !== null ? priceForMargin(basis.landedIqd, basis.targetMarginBps) : null,
    };
  }
  return result;
}

// ───────────────────────────────────────────────────────────────── price changes

export const PriceChangeInput = z.object({
  variantId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  newPriceIqd: priceField,
  newCompareAtIqd: optionalPriceField.default(null),
  reason: z.string({ error: "required" }).trim().min(3, "reason_short").max(500, "too_long"),
  mode: z.enum(CHANGE_MODES, { error: "invalid" }).default("standard"),
  source: z.enum(["manual", "suggestion", "bulk"], { error: "invalid" }).default("manual"),
  idempotencyKey: z.string({ error: "required" }).trim().min(8, "invalid").max(120, "invalid"),
});
export type PriceChangeInput = z.input<typeof PriceChangeInput>;

export type ChangePreview = {
  oldPriceIqd: number;
  newPriceIqd: number;
  oldCompareAtIqd: number | null;
  newCompareAtIqd: number | null;
  /** Reasons the person may see (margin-based ones only with profit.read). */
  reasons: ChangeReason[];
  /** "decided_on_submit": rules this person may not see might apply; the server decides when the change is sent. */
  approval: "required" | "not_required" | "decided_on_submit";
  needsOverride?: boolean;
  dropBps: number | null;
  /** The highest price of the last 30 days (since the last approved change) — what the 10 % limit counts from. Public. */
  referencePriceIqd: number;
  referenceDropBps: number | null;
  /** profit.read only. */
  marginBeforeBps?: number | null;
  marginAfterBps?: number | null;
  floorIqd?: number | null;
  /** On-hand units × price difference: what today's stock is worth at the new price (retail, not cost). */
  stockValueDeltaIqd: number;
  onHand: number;
};

type Evaluated = { facts: VariantFacts; input: z.output<typeof PriceChangeInput>; evaluation: ChangeEvaluation };

async function evaluate(db: Db, raw: unknown, locale: Locale, now: number): Promise<Evaluated> {
  const input = PriceChangeInput.parse(raw);
  const facts = await loadVariantFacts(db, input.variantId, locale);
  if (!facts) throw notFound("variant");
  if (input.newPriceIqd === facts.priceIqd && input.newCompareAtIqd === facts.compareAtIqd) throw invalid({ newPriceIqd: "no_change" });
  if (input.newCompareAtIqd !== null && input.newCompareAtIqd <= input.newPriceIqd) throw invalid({ newCompareAtIqd: "compare_at_not_higher" });
  if (input.newCompareAtIqd !== null && input.newCompareAtIqd !== facts.compareAtIqd) {
    const segments = priceSegments(facts.priceIqd, facts.createdAt, facts.history, now);
    const check = compareAtCheck(input.newCompareAtIqd, segments, facts.onSaleFrom, now);
    if (!check.ok) throw new AppError("compare_at_not_charged", 409, { fields: { newCompareAtIqd: "compare_at_not_charged" }, detail: String(check.days) });
  }
  const evaluation = evaluatePriceChange({
    oldPriceIqd: facts.priceIqd,
    newPriceIqd: input.newPriceIqd,
    oldCompareAtIqd: facts.compareAtIqd,
    newCompareAtIqd: input.newCompareAtIqd,
    cost: facts.cost,
    mode: input.mode,
    referencePriceIqd: referenceOf(facts, now),
  });
  return { facts, input, evaluation };
}

/** What a change would do, without doing it — for the confirmation dialog. */
export async function previewPriceChange(db: Db, actor: Actor, raw: unknown, locale: Locale, now: number): Promise<ChangePreview> {
  assertCan(actor, "pricing.price.update");
  const { facts, input, evaluation } = await evaluate(db, raw, locale, now);
  const access = fieldAccess(actor);
  const reasons = visibleReasons(evaluation.reasons, access);
  const hidden = reasons.length < evaluation.reasons.length;
  const onHand = (await onHandFor(db, [facts.variantId])).get(facts.variantId) ?? 0;
  const preview: ChangePreview = {
    oldPriceIqd: facts.priceIqd,
    newPriceIqd: input.newPriceIqd,
    oldCompareAtIqd: facts.compareAtIqd,
    newCompareAtIqd: input.newCompareAtIqd,
    reasons,
    approval: reasons.length > 0 ? "required" : hidden || !access.profit ? (evaluation.needsApproval ? (access.profit ? "required" : "decided_on_submit") : access.profit ? "not_required" : "decided_on_submit") : "not_required",
    dropBps: evaluation.dropBps,
    referencePriceIqd: evaluation.referencePriceIqd,
    referenceDropBps: evaluation.referenceDropBps,
    stockValueDeltaIqd: (input.newPriceIqd - facts.priceIqd) * onHand,
    onHand,
  };
  if (access.profit) {
    preview.needsOverride = evaluation.needsOverride;
    preview.marginBeforeBps = evaluation.marginBeforeBps;
    preview.marginAfterBps = evaluation.marginAfterBps;
    preview.floorIqd = evaluation.floorIqd;
  }
  return preview;
}

export type PriceChangeResult = { status: "applied" | "pending"; changeId: string; replayed: boolean; reasons: ChangeReason[] };

async function derivedId(prefix: string, actor: Actor, key: string): Promise<string> {
  const who = actor.kind === "system" ? `system:${actor.job}` : actor.kind === "guest" ? "guest" : actor.id;
  return `${prefix}_${(await sha256Hex(`${who}:${key}`)).slice(0, 26)}`;
}

async function replayOf(db: Db, changeId: string, access: FieldAccess): Promise<PriceChangeResult | null> {
  const row = await db.select({ id: priceChanges.id, status: priceChanges.status, approvalId: priceChanges.approvalId }).from(priceChanges).where(eq(priceChanges.id, changeId)).get();
  if (!row) return null;
  let reasons: ChangeReason[] = [];
  if (row.approvalId) {
    const approval = await db.select({ payload: approvals.payload }).from(approvals).where(eq(approvals.id, row.approvalId)).get();
    reasons = visibleReasons(((approval?.payload as { reasons?: ChangeReason[] } | null)?.reasons ?? []) as ChangeReason[], access);
  }
  return { status: row.status === "pending" ? "pending" : "applied", changeId: row.id, replayed: true, reasons };
}

/** "Nobody else has an undecided request for this SKU" — a batch guard. */
const noPendingGuard = (db: Db, variantId: string) => expectThat(db, sql`not ${pendingExists(variantId)}`, { code: "CHANGE_PENDING", detail: variantId });

/** "The cost this decision was made on is still the cost" — a batch guard (own cost rows only). */
function costGuard(db: Db, variantId: string, cost: CostBasis | null): BatchStatement | null {
  if (cost && cost.source === "bundle") return null;
  const landed = cost ? cost.landedIqd : null;
  const min = cost ? cost.minMarginBps : null;
  return expectThat(
    db,
    sql`(select landed_cost_iqd from variant_costs where variant_id = ${variantId}) is ${landed} and (select min_margin_bps from variant_costs where variant_id = ${variantId}) is ${min}`,
    { code: "COST_CHANGED", detail: variantId },
  );
}

function priceUpdate(db: Db, facts: VariantFacts, newPriceIqd: number, newCompareAtIqd: number | null, now: number): BatchStatement[] {
  return [
    db
      .update(variants)
      .set({ priceIqd: newPriceIqd, compareAtIqd: newCompareAtIqd, updatedAt: now })
      .where(and(eq(variants.id, facts.variantId), eq(variants.priceIqd, facts.priceIqd), facts.compareAtIqd === null ? isNull(variants.compareAtIqd) : eq(variants.compareAtIqd, facts.compareAtIqd))),
    expectChanged(db, 1, { code: "PRICE_CHANGED", detail: facts.variantId }),
  ];
}

/**
 * Requests a selling-price change (pricing.price.update). Applied at once when it trips no rule; otherwise stored as a
 * pending request that a second person decides (decidePriceChange). Safe to repeat with the same idempotency key.
 */
export async function requestPriceChange(db: Db, actor: Actor, raw: unknown, locale: Locale, now: number): Promise<PriceChangeResult> {
  assertCan(actor, "pricing.price.update");
  const access = fieldAccess(actor);
  const keyed = PriceChangeInput.pick({ idempotencyKey: true }).safeParse(raw);
  if (keyed.success) {
    const replay = await replayOf(db, await derivedId("pch", actor, keyed.data.idempotencyKey), access);
    if (replay) return replay;
  }
  const { facts, input, evaluation } = await evaluate(db, raw, locale, now);
  if (facts.pendingId) throw new AppError("change_pending", 409, { detail: facts.pendingId });
  const changeId = await derivedId("pch", actor, input.idempotencyKey);
  const requester = actorId(actor);
  const before = { priceIqd: facts.priceIqd, compareAtIqd: facts.compareAtIqd };
  const after = { priceIqd: input.newPriceIqd, compareAtIqd: input.newCompareAtIqd };
  const guards = [noPendingGuard(db, facts.variantId), costGuard(db, facts.variantId, facts.cost)].filter((statement): statement is BatchStatement => statement !== null);

  let statements: BatchStatement[];
  if (!evaluation.needsApproval) {
    statements = [
      ...guards,
      ...priceUpdate(db, facts, input.newPriceIqd, input.newCompareAtIqd, now),
      db.insert(priceChanges).values({
        id: changeId,
        variantId: facts.variantId,
        oldPriceIqd: facts.priceIqd,
        newPriceIqd: input.newPriceIqd,
        oldCompareAtIqd: facts.compareAtIqd,
        newCompareAtIqd: input.newCompareAtIqd,
        reason: input.reason,
        requestedBy: requester,
        approvedBy: null,
        status: "applied",
        source: input.source,
        createdAt: now,
      }),
      auditStatement(db, { actor, action: "pricing.price.change", entityType: "variant", entityId: facts.variantId, summary: facts.sku, before, after: { ...after, changeId, source: input.source }, reason: input.reason, at: now }),
    ];
  } else {
    const approvalId = newId("apr");
    statements = [
      ...guards,
      db.insert(approvals).values({
        id: approvalId,
        kind: "price_change",
        entityType: "price_change",
        entityId: changeId,
        requestedBy: requester ?? "system",
        payload: { variantId: facts.variantId, sku: facts.sku, ...before, newPriceIqd: input.newPriceIqd, newCompareAtIqd: input.newCompareAtIqd, mode: input.mode, source: input.source, reasons: evaluation.reasons },
        status: "pending",
        reason: input.reason,
        createdAt: now,
        requiredPermission: evaluation.needsOverride ? "pricing.discount.override" : "pricing.price.approve",
      }),
      db.insert(priceChanges).values({
        id: changeId,
        variantId: facts.variantId,
        oldPriceIqd: facts.priceIqd,
        newPriceIqd: input.newPriceIqd,
        oldCompareAtIqd: facts.compareAtIqd,
        newCompareAtIqd: input.newCompareAtIqd,
        reason: input.reason,
        requestedBy: requester,
        approvedBy: null,
        status: "pending",
        source: input.source,
        approvalId,
        createdAt: now,
      }),
      auditStatement(db, { actor, action: "pricing.price.request", entityType: "variant", entityId: facts.variantId, summary: facts.sku, before, after: { ...after, changeId, mode: input.mode, reasons: evaluation.reasons }, reason: input.reason, at: now }),
    ];
  }

  try {
    await runBatch(db, statements);
  } catch (error) {
    // A double submit: the first one won; answer with its result.
    if (isUniqueViolation(error, "price_changes.id") || toAppError(error)?.code === "price_changed" || toAppError(error)?.code === "change_pending") {
      const replay = await replayOf(db, changeId, access);
      if (replay) return replay;
    }
    throw error;
  }
  return { status: evaluation.needsApproval ? "pending" : "applied", changeId, replayed: false, reasons: visibleReasons(evaluation.reasons, access) };
}

type RequestRow = typeof priceChanges.$inferSelect;
type Decision = { status: "applied" | "rejected" | "cancelled"; row: RequestRow };

async function loadRequest(db: Db, requestId: string): Promise<{ request: RequestRow; decision: Decision | null; payload: Record<string, unknown> | null }> {
  const request = await db.select().from(priceChanges).where(and(eq(priceChanges.id, requestId), eq(priceChanges.status, "pending"))).get();
  if (!request) throw notFound("price_change");
  const decisionRow = await db.select().from(priceChanges).where(eq(priceChanges.requestId, requestId)).orderBy(desc(priceChanges.createdAt)).get();
  const approval = request.approvalId ? await db.select({ payload: approvals.payload }).from(approvals).where(eq(approvals.id, request.approvalId)).get() : null;
  return {
    request,
    decision: decisionRow && (decisionRow.status === "applied" || decisionRow.status === "rejected" || decisionRow.status === "cancelled") ? { status: decisionRow.status, row: decisionRow } : null,
    payload: (approval?.payload as Record<string, unknown> | null) ?? null,
  };
}

export const DecideInput = z.object({
  requestId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  decision: z.enum(["approve", "reject"], { error: "invalid" }),
  note: z.string().trim().max(500, "too_long").optional().default(""),
});

/**
 * Approves (applies) or rejects a pending request. Needs pricing.price.approve, plus pricing.discount.override when
 * the price is under the minimum margin or the landed cost (re-checked now, against today's cost). The decider is
 * never the requester. Repeating the same decision returns it again (`replayed`).
 */
export async function decidePriceChange(db: Db, actor: Actor, raw: unknown, locale: Locale, now: number): Promise<{ status: "applied" | "rejected"; replayed: boolean }> {
  assertCan(actor, "pricing.price.approve");
  const input = DecideInput.parse(raw);
  const { request, decision, payload } = await loadRequest(db, input.requestId);
  if (decision) {
    if (input.decision === "approve" && decision.status === "applied") return { status: "applied", replayed: true };
    if (input.decision === "reject" && decision.status === "rejected") return { status: "rejected", replayed: true };
    throw new AppError("change_not_pending", 409, { detail: decision.status });
  }
  if (actor.kind === "employee" && request.requestedBy === actor.id) throw new AppError("approver_is_requester", 403, { detail: request.id });
  const decider = actorId(actor);
  const mode: ChangeMode = payload?.mode === "clearance" ? "clearance" : "standard";
  const closeApproval = (status: "approved" | "rejected", note: string | null): BatchStatement[] =>
    request.approvalId
      ? [
          db
            .update(approvals)
            .set({ status, decidedBy: decider, decidedAt: now, decisionNote: note })
            .where(and(eq(approvals.id, request.approvalId), eq(approvals.status, "pending"))),
          expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: request.id }),
        ]
      : [];
  const notDecided = expectThat(db, sql`not exists (select 1 from price_changes d where d.request_id = ${request.id})`, { code: "CHANGE_NOT_PENDING", detail: request.id });

  if (input.decision === "reject") {
    if (input.note.length < 3) throw invalid({ note: "note_required" });
    await runBatch(db, [
      ...closeApproval("rejected", input.note),
      notDecided,
      db.insert(priceChanges).values({
        id: newId("pch"),
        variantId: request.variantId,
        oldPriceIqd: request.oldPriceIqd,
        newPriceIqd: request.newPriceIqd,
        oldCompareAtIqd: request.oldCompareAtIqd,
        newCompareAtIqd: request.newCompareAtIqd,
        reason: input.note,
        requestedBy: request.requestedBy,
        approvedBy: decider,
        status: "rejected",
        source: request.source,
        requestId: request.id,
        approvalId: request.approvalId,
        createdAt: now,
      }),
      auditStatement(db, { actor, action: "pricing.price.reject", entityType: "variant", entityId: request.variantId, summary: request.id, before: { status: "pending" }, after: { status: "rejected", requestId: request.id }, reason: input.note, at: now }),
    ]).catch((error) => {
      throw toAppError(error) ?? error;
    });
    return { status: "rejected", replayed: false };
  }

  // Approve: re-check the rules against today's facts.
  const facts = await loadVariantFacts(db, request.variantId, locale);
  if (!facts) throw notFound("variant");
  if (facts.priceIqd !== request.oldPriceIqd || facts.compareAtIqd !== request.oldCompareAtIqd) throw new AppError("price_changed", 409, { detail: request.variantId });
  if (request.newCompareAtIqd !== null && request.newCompareAtIqd !== request.oldCompareAtIqd) {
    const check = compareAtCheck(request.newCompareAtIqd, priceSegments(facts.priceIqd, facts.createdAt, facts.history, now), facts.onSaleFrom, now);
    if (!check.ok) throw new AppError("compare_at_not_charged", 409, { detail: String(check.days) });
  }
  const evaluation = evaluatePriceChange({ oldPriceIqd: facts.priceIqd, newPriceIqd: request.newPriceIqd, oldCompareAtIqd: facts.compareAtIqd, newCompareAtIqd: request.newCompareAtIqd, cost: facts.cost, mode, referencePriceIqd: referenceOf(facts, now) });
  if (evaluation.needsOverride && !can(actor, "pricing.discount.override")) throw new AppError("override_required", 403, { detail: "pricing.discount.override" });
  const note = input.note || null;
  const guard = costGuard(db, facts.variantId, facts.cost);
  await runBatch(db, [
    ...closeApproval("approved", note),
    notDecided,
    ...(guard ? [guard] : []),
    ...priceUpdate(db, facts, request.newPriceIqd, request.newCompareAtIqd, now),
    db.insert(priceChanges).values({
      id: newId("pch"),
      variantId: request.variantId,
      oldPriceIqd: request.oldPriceIqd,
      newPriceIqd: request.newPriceIqd,
      oldCompareAtIqd: request.oldCompareAtIqd,
      newCompareAtIqd: request.newCompareAtIqd,
      reason: note ?? request.reason,
      requestedBy: request.requestedBy,
      approvedBy: decider,
      status: "applied",
      source: request.source,
      requestId: request.id,
      approvalId: request.approvalId,
      createdAt: now,
    }),
    auditStatement(db, {
      actor,
      action: "pricing.price.approve",
      entityType: "variant",
      entityId: request.variantId,
      summary: facts.sku,
      before: { priceIqd: request.oldPriceIqd, compareAtIqd: request.oldCompareAtIqd },
      after: { priceIqd: request.newPriceIqd, compareAtIqd: request.newCompareAtIqd, requestId: request.id, reasons: evaluation.reasons, mode },
      reason: note ?? request.reason,
      at: now,
    }),
  ]).catch((error) => {
    throw toAppError(error) ?? error;
  });
  return { status: "applied", replayed: false };
}

export const CancelInput = z.object({
  requestId: z.string({ error: "required" }).trim().min(1, "required").max(120, "invalid"),
  note: z.string().trim().max(500, "too_long").optional().default(""),
});

/** The requester withdraws their own pending request (pricing.price.update). */
export async function cancelPriceChange(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "cancelled"; replayed: boolean }> {
  assertCan(actor, "pricing.price.update");
  const input = CancelInput.parse(raw);
  const { request, decision } = await loadRequest(db, input.requestId);
  if (decision) {
    if (decision.status === "cancelled") return { status: "cancelled", replayed: true };
    throw new AppError("change_not_pending", 409, { detail: decision.status });
  }
  const who = actorId(actor);
  if (actor.kind !== "system" && request.requestedBy !== who) throw new AppError("not_requester", 403, { detail: request.id });
  const note = input.note || null;
  await runBatch(db, [
    ...(request.approvalId
      ? [
          db
            .update(approvals)
            .set({ status: "rejected", decidedBy: who, decidedAt: now, decisionNote: note ? `cancelled: ${note}` : "cancelled" })
            .where(and(eq(approvals.id, request.approvalId), eq(approvals.status, "pending"))),
          expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: request.id }),
        ]
      : []),
    expectThat(db, sql`not exists (select 1 from price_changes d where d.request_id = ${request.id})`, { code: "CHANGE_NOT_PENDING", detail: request.id }),
    db.insert(priceChanges).values({
      id: newId("pch"),
      variantId: request.variantId,
      oldPriceIqd: request.oldPriceIqd,
      newPriceIqd: request.newPriceIqd,
      oldCompareAtIqd: request.oldCompareAtIqd,
      newCompareAtIqd: request.newCompareAtIqd,
      reason: note,
      requestedBy: request.requestedBy,
      approvedBy: who,
      status: "cancelled",
      source: request.source,
      requestId: request.id,
      approvalId: request.approvalId,
      createdAt: now,
    }),
    auditStatement(db, { actor, action: "pricing.price.cancel", entityType: "variant", entityId: request.variantId, summary: request.id, before: { status: "pending" }, after: { status: "cancelled", requestId: request.id }, reason: note, at: now }),
  ]).catch((error) => {
    throw toAppError(error) ?? error;
  });
  return { status: "cancelled", replayed: false };
}

// ───────────────────────────────────────────────────────────────── history and the approval queue

export type ChangeStatus = "applied" | "pending" | "rejected" | "cancelled";
export type ChangeView = {
  id: string;
  kind: "direct" | "request";
  variantId: string;
  productId: string;
  sku: string;
  name: string;
  oldPriceIqd: number | null;
  newPriceIqd: number;
  oldCompareAtIqd: number | null;
  newCompareAtIqd: number | null;
  status: ChangeStatus;
  source: string;
  mode: ChangeMode;
  reasons: ChangeReason[];
  /** Holders of pricing.price.approve may decide; this also needs pricing.discount.override (profit.read only). */
  needsOverride?: boolean;
  requestedBy: { id: string; name: string } | null;
  decidedBy: { id: string; name: string } | null;
  reason: string | null;
  decisionNote: string | null;
  createdAt: number;
  decidedAt: number | null;
  /** True when the viewer requested it (they may cancel it, never decide it). */
  mine: boolean;
};

export type ChangeQuery = {
  tab?: "pending" | "history";
  variantId?: string;
  requestIds?: string[];
  status?: ChangeStatus | null;
  q?: string;
  page?: number;
  limit?: number;
};

/**
 * Price changes as people read them: one entry per direct change and one per request (with its decision folded
 * in), newest first. `tab: "pending"` = requests nobody has decided yet.
 */
export async function listChangeViews(db: Db, actor: Actor, query: ChangeQuery, locale: Locale): Promise<ChangeView[]> {
  return (await listChanges(db, actor, query, locale)).items;
}

export async function listChanges(db: Db, actor: Actor, query: ChangeQuery, locale: Locale): Promise<{ items: ChangeView[]; total: number; page: number; pageCount: number }> {
  assertAny(actor, SKU_READERS);
  const access = fieldAccess(actor);
  const limit = Math.min(Math.max(query.limit ?? PAGE_SIZE, 1), 200);
  // Heads: direct changes (applied, no request) and requests (pending rows).
  const conditions: SQL[] = [sql`(${priceChanges.status} = 'pending' or (${priceChanges.status} = 'applied' and ${priceChanges.requestId} is null))`];
  if (query.variantId) conditions.push(eq(priceChanges.variantId, query.variantId));
  if (query.requestIds) conditions.push(inArray(priceChanges.id, query.requestIds.length ? query.requestIds : ["-"]));
  const decisionStatus = sql<string | null>`(select d.status from price_changes d where d.request_id = ${priceChanges.id} order by d.created_at desc limit 1)`;
  const effectiveStatus = sql<string>`case when ${priceChanges.status} = 'pending' then coalesce(${decisionStatus}, 'pending') else ${priceChanges.status} end`;
  if (query.tab === "pending") conditions.push(sql`${effectiveStatus} = 'pending'`);
  if (query.status) conditions.push(sql`${effectiveStatus} = ${query.status}`);
  if (query.q) {
    const term = `%${escapeLike(query.q.trim().slice(0, 100))}%`;
    conditions.push(or(sql`${variants.sku} like ${term} escape '\\'`, sql`${products.name} like ${term} escape '\\'`)!);
  }
  const where = and(...conditions);
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)` })
    .from(priceChanges)
    .innerJoin(variants, eq(variants.id, priceChanges.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(where);
  const pageCount = Math.max(1, Math.ceil(Number(total) / limit));
  const page = Math.min(Math.max(query.page ?? 1, 1), pageCount);
  const heads = await db
    .select({ change: priceChanges, sku: variants.sku, productId: products.id, name: products.name })
    .from(priceChanges)
    .innerJoin(variants, eq(variants.id, priceChanges.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(where)
    .orderBy(desc(priceChanges.createdAt), desc(priceChanges.id))
    .limit(limit)
    .offset((page - 1) * limit);
  if (heads.length === 0) return { items: [], total: Number(total), page, pageCount };

  const requestIds = heads.filter((head) => head.change.status === "pending").map((head) => head.change.id);
  const decisions = requestIds.length ? await db.select().from(priceChanges).where(inArray(priceChanges.requestId, requestIds)).orderBy(desc(priceChanges.createdAt)) : [];
  const approvalIds = heads.map((head) => head.change.approvalId).filter((id): id is string => Boolean(id));
  const approvalRows = approvalIds.length ? await db.select({ id: approvals.id, payload: approvals.payload, decisionNote: approvals.decisionNote, requiredPermission: approvals.requiredPermission }).from(approvals).where(inArray(approvals.id, approvalIds)) : [];
  const people = new Set<string>();
  for (const head of heads) {
    if (head.change.requestedBy) people.add(head.change.requestedBy);
    if (head.change.approvedBy) people.add(head.change.approvedBy);
  }
  for (const decision of decisions) if (decision.approvedBy) people.add(decision.approvedBy);
  const names = people.size ? await db.select({ id: employees.id, name: employees.name }).from(employees).where(inArray(employees.id, [...people])) : [];
  const nameOf = (id: string | null) => (id ? { id, name: names.find((row) => row.id === id)?.name ?? id } : null);
  const viewer = actorId(actor);

  const items = heads.map(({ change, sku, productId, name }): ChangeView => {
    const decision = decisions.find((row) => row.requestId === change.id) ?? null;
    const approval = approvalRows.find((row) => row.id === change.approvalId) ?? null;
    const payload = (approval?.payload ?? {}) as { mode?: string; reasons?: ChangeReason[] };
    const status: ChangeStatus = change.status === "pending" ? (decision ? (decision.status as ChangeStatus) : "pending") : (change.status as ChangeStatus);
    const view: ChangeView = {
      id: change.id,
      kind: change.status === "pending" ? "request" : "direct",
      variantId: change.variantId,
      productId,
      sku,
      name: pick(name, locale),
      oldPriceIqd: change.oldPriceIqd,
      newPriceIqd: change.newPriceIqd,
      oldCompareAtIqd: change.oldCompareAtIqd,
      newCompareAtIqd: change.newCompareAtIqd,
      status,
      source: change.source,
      mode: payload.mode === "clearance" ? "clearance" : "standard",
      reasons: visibleReasons(payload.reasons ?? [], access),
      requestedBy: nameOf(change.requestedBy),
      decidedBy: change.status === "pending" ? nameOf(decision?.approvedBy ?? null) : null,
      reason: change.reason,
      decisionNote: decision ? (decision.status === "applied" ? (decision.reason !== change.reason ? decision.reason : null) : decision.reason) : null,
      createdAt: change.createdAt,
      decidedAt: decision?.createdAt ?? null,
      mine: viewer !== null && change.requestedBy === viewer,
    };
    if (access.profit) view.needsOverride = approval?.requiredPermission === "pricing.discount.override";
    return view;
  });
  return { items, total: Number(total), page, pageCount };
}

/** How many requests wait for a decision this actor may make (not their own). */
export async function countDecidable(db: Db, actor: Actor): Promise<number> {
  if (!can(actor, "pricing.price.approve")) return 0;
  const viewer = actorId(actor);
  const overrides = can(actor, "pricing.discount.override");
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(priceChanges)
    .leftJoin(approvals, eq(approvals.id, priceChanges.approvalId))
    .where(
      and(
        eq(priceChanges.status, "pending"),
        sql`not exists (select 1 from price_changes d where d.request_id = ${priceChanges.id})`,
        viewer ? sql`coalesce(${priceChanges.requestedBy}, '') <> ${viewer}` : undefined,
        overrides ? undefined : sql`coalesce(${approvals.requiredPermission}, '') <> 'pricing.discount.override'`,
      ),
    );
  return Number(row?.count ?? 0);
}

export type RequestImpact = {
  onHand: number;
  /** Units on hand × (new − old price): today's stock at retail. */
  stockValueDeltaIqd: number;
  /** False when the SKU's price moved since the request (approving it would fail with price_changed). */
  current: boolean;
  /** The highest price of the last 30 days the 10 % limit counts from (public), and the cut measured from it. */
  referencePriceIqd: number;
  referenceDropBps: number | null;
  /** profit.read only — evaluated against today's cost. */
  marginBeforeBps?: number | null;
  marginAfterBps?: number | null;
  floorIqd?: number | null;
  needsOverride?: boolean;
};

/** What deciding each pending request would do today (for the approval dialog). */
export async function impactsFor(db: Db, actor: Actor, views: readonly ChangeView[], at: number = Date.now()): Promise<Record<string, RequestImpact>> {
  assertAny(actor, SKU_READERS);
  const pending = views.filter((view) => view.status === "pending");
  if (pending.length === 0) return {};
  const access = fieldAccess(actor);
  const ids = [...new Set(pending.map((view) => view.variantId))];
  const parts = chunks(ids);
  const [stock, costs, current, applied] = await Promise.all([
    onHandFor(db, ids),
    access.profit ? costBasisFor(db, ids) : Promise.resolve(new Map<string, CostBasis | null>()),
    Promise.all(parts.map((part) => db.select({ id: variants.id, priceIqd: variants.priceIqd, compareAtIqd: variants.compareAtIqd, createdAt: variants.createdAt }).from(variants).where(inArray(variants.id, part)))).then((rows) => rows.flat()),
    Promise.all(
      parts.map((part) =>
        db
          .select({ variantId: priceChanges.variantId, at: priceChanges.createdAt, oldPriceIqd: priceChanges.oldPriceIqd, newPriceIqd: priceChanges.newPriceIqd, approvedBy: priceChanges.approvedBy })
          .from(priceChanges)
          .where(and(inArray(priceChanges.variantId, part), eq(priceChanges.status, "applied"))),
      ),
    ).then((rows) => rows.flat()),
  ]);
  const out: Record<string, RequestImpact> = {};
  for (const view of pending) {
    const onHand = stock.get(view.variantId) ?? 0;
    const now = current.find((row) => row.id === view.variantId);
    const history = applied.filter((row) => row.variantId === view.variantId).map((row) => ({ at: row.at, oldPriceIqd: row.oldPriceIqd, newPriceIqd: row.newPriceIqd, approved: row.approvedBy !== null }));
    const old = view.oldPriceIqd ?? view.newPriceIqd;
    const reference = now ? Math.max(old, dropReferencePrice(now.priceIqd, now.createdAt, history, at)) : old;
    const impact: RequestImpact = {
      onHand,
      stockValueDeltaIqd: (view.newPriceIqd - old) * onHand,
      current: Boolean(now && now.priceIqd === view.oldPriceIqd && now.compareAtIqd === view.oldCompareAtIqd),
      referencePriceIqd: reference,
      referenceDropBps: reference > 0 ? Math.trunc(((reference - view.newPriceIqd) * 10_000) / reference) : null,
    };
    if (access.profit) {
      const evaluation = evaluatePriceChange({ oldPriceIqd: old, newPriceIqd: view.newPriceIqd, oldCompareAtIqd: view.oldCompareAtIqd, newCompareAtIqd: view.newCompareAtIqd, cost: costs.get(view.variantId) ?? null, mode: view.mode });
      impact.marginBeforeBps = evaluation.marginBeforeBps;
      impact.marginAfterBps = evaluation.marginAfterBps;
      impact.floorIqd = evaluation.floorIqd;
      impact.needsOverride = evaluation.needsOverride;
    }
    out[view.id] = impact;
  }
  return out;
}
