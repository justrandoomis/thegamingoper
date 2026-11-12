/**
 * Admin 08.01 — coupons: the staff screens over the commerce core's `coupons` / `coupon_redemptions` (the core
 * validates and redeems a coupon at checkout — coupons.server.ts evaluateCoupon + placeOrder; nothing here is a
 * second validation path: "try a coupon" calls evaluateCoupon itself).
 *
 *   listCoupons(db, actor, filters, now)                       states, uses, discount given, saved views (URL)
 *   getCoupon(db, actor, couponId, now)                        terms, why they need a second person, the request, uses
 *   saveCoupon(db, actor, raw, now)                            create / edit: "applied" | "requested" | "unchanged"
 *   setCouponActive(db, actor, { couponId, active, reason, expected }, now)
 *   deactivateCoupons(db, actor, { couponIds, reason }, now)   bulk switch-off (the safe direction, no second person)
 *   decideCoupon(db, actor, { approvalId, decision, note }, now) · withdrawCouponRequest(db, actor, { approvalId }, now)
 *   tryCoupon(db, actor, { code, lines, phone?, channel }, now)  the core's evaluateCoupon on a sample cart
 *   conditionOptions(db, locale)                               platforms, categories, segments for the pickers
 *
 * Who may create and who approves: promotions.coupon.manage writes coupons. Terms beyond DISCOUNT_LIMITS (above 20 %,
 * more than 50,000 IQD off one order or no ceiling, no usage limit at all) are not switched on by the person who wrote
 * them: an `approvals` row (kind "coupon") waits for someone else holding promotions.coupon.manage +
 * pricing.discount.override. While an edit waits, the coupon keeps the terms in force. Every change is one batch,
 * guarded on the terms the screen showed (`coupon_changed`), with its audit event (before / after / reason).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, categories, couponRedemptions, coupons, customerSegments, customers, orders, platforms, variants, type Approval, type Coupon, type CouponConditions } from "~/server/db/schema";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { evaluateCoupon, normalizeCouponCode, type CouponEvaluation } from "~/server/services/coupons.server";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { couponStateOf, discountApprovalReasons, termsFingerprint } from "./rules";
import { ID, PROMOTIONS_PERMISSIONS, SECTION_READ, approvedFingerprint, assertAny, assertMayDecide, canDecideApproval, customerLabels, employeeNames, historyOf, noPendingRequest, num, pendingApprovalOf, pendingChangeView, phoneOf } from "./shared.server";
import {
  CHANNELS,
  PAGE_SIZE,
  PRODUCT_KIND_OPTIONS,
  fromBaghdadInput,
  parsePercentBps,
  parseWhole,
  type ApprovalReason,
  type ConditionOptions,
  type CouponConditionsView,
  type CouponDetail,
  type CouponFilters,
  type CouponPage,
  type CouponRow,
  type CouponState,
  type CouponTerms,
  type CouponView,
  type PendingChange,
  type DiscountLimits,
} from "./types";
import { programRules } from "./program.server";

const KIND = "coupon" as const;

// ───────────────────────────────────────────────────────────────── terms

function conditionsView(raw: CouponConditions | null | undefined): CouponConditionsView {
  const c = raw ?? {};
  const list = (value: unknown) => (Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))].sort() : []);
  return {
    platformIds: list(c.platformIds),
    categoryIds: list(c.categoryIds),
    productIds: list(c.productIds),
    productKinds: list(c.productKinds),
    segmentIds: list(c.segmentIds),
    channels: list(c.channels),
    firstOrderOnly: c.firstOrderOnly === true,
    minQty: typeof c.minQty === "number" ? c.minQty : null,
  };
}

/** The conditions as the core reads them (empty lists left out). */
function storedConditions(view: CouponConditionsView): CouponConditions | null {
  const out: CouponConditions = {};
  if (view.platformIds.length) out.platformIds = view.platformIds;
  if (view.categoryIds.length) out.categoryIds = view.categoryIds;
  if (view.productIds.length) out.productIds = view.productIds;
  if (view.productKinds.length) out.productKinds = view.productKinds;
  if (view.segmentIds.length) out.segmentIds = view.segmentIds;
  if (view.channels.length) out.channels = view.channels;
  if (view.firstOrderOnly) out.firstOrderOnly = true;
  if (view.minQty !== null) out.minQty = view.minQty;
  return Object.keys(out).length ? out : null;
}

export function couponTerms(row: Pick<Coupon, "kind" | "value" | "minSubtotalIqd" | "maxDiscountIqd" | "usageLimit" | "perCustomerLimit" | "startsAt" | "endsAt" | "conditions">): CouponTerms {
  return {
    kind: row.kind,
    value: row.value,
    minSubtotalIqd: row.minSubtotalIqd,
    maxDiscountIqd: row.maxDiscountIqd,
    usageLimit: row.usageLimit,
    perCustomerLimit: row.perCustomerLimit,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    conditions: conditionsView(row.conditions),
  };
}

/** Why these terms need a second person, against the limits in force (`limits`: programRules; DISCOUNT_LIMITS when left out). */
export const couponReasons = (terms: CouponTerms, limits?: DiscountLimits): ApprovalReason[] => discountApprovalReasons({ ...terms, value: terms.value }, { coupon: true, limits });
/** The discount limits in force (the setting promotions.discount_limits — follow-up 2026-11-12). */
const limitsInForce = async (db: Db) => (await programRules(db)).limits;

/** SQL: the coupon row still has exactly these terms, this switch state and this description. */
function sameRow(row: { id: string; isActive: boolean; description: string | null; conditionsText: string | null }, terms: CouponTerms) {
  return and(
    eq(coupons.id, row.id),
    sql`${coupons.kind} = ${terms.kind} AND ${coupons.value} = ${terms.value}
      AND ${coupons.minSubtotalIqd} IS ${terms.minSubtotalIqd} AND ${coupons.maxDiscountIqd} IS ${terms.maxDiscountIqd}
      AND ${coupons.usageLimit} IS ${terms.usageLimit} AND ${coupons.perCustomerLimit} IS ${terms.perCustomerLimit}
      AND ${coupons.startsAt} IS ${terms.startsAt} AND ${coupons.endsAt} IS ${terms.endsAt}
      AND coalesce(CAST(${coupons.conditions} AS TEXT), '') = ${row.conditionsText ?? ""}
      AND ${coupons.isActive} = ${row.isActive ? 1 : 0}
      AND coalesce(${coupons.description}, '') = ${row.description ?? ""}`,
  );
}

type LoadedCoupon = Coupon & { conditionsText: string | null };

async function loadCoupon(db: Db, couponId: string): Promise<LoadedCoupon> {
  if (!ID.test(couponId)) throw notFound("coupon");
  const row = await db
    .select({ coupon: coupons, conditionsText: sql<string | null>`CAST(${coupons.conditions} AS TEXT)` })
    .from(coupons)
    .where(eq(coupons.id, couponId))
    .get();
  if (!row) throw notFound("coupon");
  return { ...row.coupon, conditionsText: row.conditionsText };
}

function changedGuard(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "CHANGE_PENDING") throw new AppError("change_pending", 409);
  if (info?.code === "COUPON_CHANGED") throw new AppError("coupon_changed", 409);
  if (info?.code === "CHANGE_NOT_PENDING") throw new AppError("change_not_pending", 409);
  if (info?.kind === "unique" && (info.table === "coupons" || /coupons_code/.test(info.detail))) throw invalid({ code: "code_taken" });
  throw error;
}

// ───────────────────────────────────────────────────────────────── lists

const stateSql = (now: number) => sql`CASE
  WHEN c.is_active = 0 THEN CASE WHEN p.pending = 1 THEN 'pending' ELSE 'off' END
  WHEN c.ends_at IS NOT NULL AND c.ends_at <= ${now} THEN 'expired'
  WHEN c.usage_limit IS NOT NULL AND u.used >= c.usage_limit THEN 'exhausted'
  WHEN c.starts_at IS NOT NULL AND c.starts_at > ${now} THEN 'scheduled'
  ELSE 'live' END`;

const VIEW_STATES: Record<CouponView, CouponState[] | null> = { all: null, live: ["live"], scheduled: ["scheduled"], pending: null, off: ["off"], ended: ["expired", "exhausted"] };

type ListRow = { id: string; code: string; kind: "fixed" | "percent"; value: number; is_active: number; description: string | null; used: number; disc: number; usage_limit: number | null; starts_at: number | null; ends_at: number | null; created_at: number; is_demo: number; pending: number; state: CouponState };

export async function listCoupons(db: Db, actor: Actor, filters: CouponFilters, now: number): Promise<CouponPage> {
  assertAny(actor, SECTION_READ.coupons);
  const base = sql`
    WITH u AS (SELECT coupon_id, count(*) AS used, coalesce(sum(amount_iqd), 0) AS disc FROM coupon_redemptions WHERE voided_at IS NULL GROUP BY coupon_id),
    p AS (SELECT entity_id, 1 AS pending FROM approvals WHERE kind = 'coupon' AND status = 'pending' GROUP BY entity_id),
    x AS (SELECT c.id, c.code, c.kind, c.value, c.is_active, c.description, coalesce(u.used, 0) AS used, coalesce(u.disc, 0) AS disc, c.usage_limit, c.starts_at, c.ends_at, c.created_at, c.is_demo, coalesce(p.pending, 0) AS pending, ${stateSql(now)} AS state
      FROM coupons AS c LEFT JOIN u ON u.coupon_id = c.id LEFT JOIN p ON p.entity_id = c.id)`;
  const q = filters.q.toUpperCase().slice(0, 40);
  const like = `%${q.replace(/[%_\\]/g, "")}%`;
  const search = q ? sql` AND (upper(x.code) LIKE ${like} OR coalesce(x.description, '') LIKE ${`%${filters.q.slice(0, 40).replace(/[%_\\]/g, "")}%`})` : sql``;
  const states = VIEW_STATES[filters.view];
  const view = filters.view === "pending" ? sql` AND x.pending = 1` : states ? sql` AND x.state IN (${sql.join(states.map((state) => sql`${state}`), sql`, `)})` : sql``;
  const order =
    filters.sort === "code" ? sql`x.code ASC` : filters.sort === "uses" ? sql`x.used DESC, x.created_at DESC` : filters.sort === "ends" ? sql`x.ends_at IS NULL, x.ends_at ASC, x.code ASC` : sql`x.created_at DESC, x.id DESC`;
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [rows, totals, counts] = await Promise.all([
    db.all<ListRow>(sql`${base} SELECT * FROM x WHERE 1 = 1${view}${search} ORDER BY ${order} LIMIT ${PAGE_SIZE} OFFSET ${offset}`),
    db.all<{ n: number }>(sql`${base} SELECT count(*) AS n FROM x WHERE 1 = 1${view}${search}`),
    db.all<{ state: CouponState; pending: number; n: number }>(sql`${base} SELECT state, pending, count(*) AS n FROM x GROUP BY state, pending`),
  ]);
  const byView: Partial<Record<CouponView, number>> = { all: 0, live: 0, scheduled: 0, pending: 0, off: 0, ended: 0 };
  for (const row of counts) {
    const n = num(row.n);
    byView.all = (byView.all ?? 0) + n;
    if (num(row.pending) === 1) byView.pending = (byView.pending ?? 0) + n;
    for (const view of ["live", "scheduled", "off", "ended"] as const) if (VIEW_STATES[view]?.includes(row.state)) byView[view] = (byView[view] ?? 0) + n;
  }
  const total = num(totals[0]?.n);
  return {
    rows: rows.map(
      (row): CouponRow => ({
        id: row.id,
        code: row.code,
        kind: row.kind,
        value: num(row.value),
        state: row.state,
        isActive: num(row.is_active) === 1,
        description: row.description,
        used: num(row.used),
        usageLimit: row.usage_limit === null ? null : num(row.usage_limit),
        discountGivenIqd: num(row.disc),
        startsAt: row.starts_at === null ? null : num(row.starts_at),
        endsAt: row.ends_at === null ? null : num(row.ends_at),
        createdAt: num(row.created_at),
        isDemo: num(row.is_demo) === 1,
        pending: num(row.pending) === 1,
      }),
    ),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: byView,
  };
}

async function usage(db: Db, couponId: string): Promise<{ used: number; voided: number; discountIqd: number }> {
  const row = await db
    .select({
      used: sql<number>`coalesce(sum(CASE WHEN ${couponRedemptions.voidedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
      voided: sql<number>`coalesce(sum(CASE WHEN ${couponRedemptions.voidedAt} IS NULL THEN 0 ELSE 1 END), 0)`,
      discountIqd: sql<number>`coalesce(sum(CASE WHEN ${couponRedemptions.voidedAt} IS NULL THEN ${couponRedemptions.amountIqd} ELSE 0 END), 0)`,
    })
    .from(couponRedemptions)
    .where(eq(couponRedemptions.couponId, couponId))
    .get();
  return { used: num(row?.used), voided: num(row?.voided), discountIqd: num(row?.discountIqd) };
}

export async function getCoupon(db: Db, actor: Actor, couponId: string, now: number): Promise<CouponDetail> {
  assertAny(actor, SECTION_READ.coupons);
  const row = await loadCoupon(db, couponId);
  const terms = couponTerms(row);
  const fingerprint = termsFingerprint(terms);
  const [counts, pending, approved, redemptionRows, history, creator] = await Promise.all([
    usage(db, row.id),
    pendingApprovalOf(db, KIND, row.id),
    approvedFingerprint(db, KIND, row.id, fingerprint),
    db
      .select({ id: couponRedemptions.id, orderRef: orders.ref, orderStatus: orders.status, customerId: couponRedemptions.customerId, phone: couponRedemptions.phoneE164, amountIqd: couponRedemptions.amountIqd, at: couponRedemptions.at, voidedAt: couponRedemptions.voidedAt })
      .from(couponRedemptions)
      .leftJoin(orders, eq(orders.id, couponRedemptions.orderId))
      .where(eq(couponRedemptions.couponId, row.id))
      .orderBy(desc(couponRedemptions.at))
      .limit(50),
    historyOf(db, "coupon", row.id),
    employeeNames(db, [row.createdBy]),
  ]);
  const people = await customerLabels(db, actor, redemptionRows.map((entry) => entry.customerId));
  const full = can(actor, "customer.phone.read_full");
  return {
    id: row.id,
    code: row.code,
    description: row.description,
    isActive: row.isActive,
    isDemo: row.isDemo,
    state: couponStateOf(row, counts.used, Boolean(pending), now),
    terms,
    fingerprint,
    createdAt: row.createdAt,
    createdBy: row.createdBy ? (creator.get(row.createdBy) ?? null) : null,
    used: counts.used,
    voided: counts.voided,
    discountGivenIqd: counts.discountIqd,
    approvalReasons: couponReasons(terms, await limitsInForce(db)),
    approvedTerms: approved,
    pending: await pendingChangeView(db, actor, pending),
    redemptions: redemptionRows.map((entry) => ({
      id: entry.id,
      orderRef: entry.orderRef,
      orderStatus: entry.orderStatus,
      customer: entry.customerId ? (people.get(entry.customerId)?.name ?? null) : null,
      phone: phoneOf(entry.phone, full),
      amountIqd: entry.amountIqd,
      at: entry.at,
      voidedAt: entry.voidedAt,
    })),
    history,
    can: { manage: can(actor, "promotions.coupon.manage"), decide: pending ? canDecideApproval(actor, pending) : false },
  };
}

// ───────────────────────────────────────────────────────────────── input

const reasonText = z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long");
const idList = z.preprocess((value) => (value === undefined || value === null || value === "" ? [] : Array.isArray(value) ? value : [value]), z.array(z.string().regex(ID, "invalid")).max(40, "too_many"));
const amount = (max: number) =>
  z.preprocess((value) => (value === "" || value === null || value === undefined ? null : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(1, "too_small").max(max, "too_big").nullable());

export const CouponInput = z
  .object({
    couponId: z.string().regex(ID, "invalid").optional(),
    code: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()).optional(),
    kind: z.enum(["fixed", "percent"], { error: "required" }),
    value: z.union([z.string(), z.number()], { error: "required" }),
    minSubtotalIqd: amount(100_000_000),
    maxDiscountIqd: amount(100_000_000),
    usageLimit: amount(1_000_000),
    perCustomerLimit: amount(1_000),
    startsAt: z.preprocess((value) => fromBaghdadInput(value ?? ""), z.number({ error: "date_invalid" }).int().nullable()),
    endsAt: z.preprocess((value) => fromBaghdadInput(value ?? ""), z.number({ error: "date_invalid" }).int().nullable()),
    description: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanLine).trim().max(200, "too_long")),
    platformIds: idList,
    categoryIds: idList,
    productKinds: z.preprocess((value) => (value === undefined || value === null || value === "" ? [] : Array.isArray(value) ? value : [value]), z.array(z.enum(PRODUCT_KIND_OPTIONS, { error: "invalid" })).max(9)),
    segmentIds: idList,
    channels: z.preprocess((value) => (value === undefined || value === null || value === "" ? [] : Array.isArray(value) ? value : [value]), z.array(z.enum(CHANNELS, { error: "invalid" })).max(2)),
    firstOrderOnly: z.preprocess((value) => value === true || value === "on" || value === "1" || value === "true", z.boolean()),
    minQty: amount(1_000),
    /** Create: switch it on now (or as soon as a second person approves). */
    activate: z.preprocess((value) => value === true || value === "on" || value === "1" || value === "true", z.boolean()).optional(),
    /** Edit: the fingerprint of the terms the form showed. */
    expected: z.string().max(4_000).optional(),
    reason: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(500, "too_long")),
  })
  .superRefine((input, ctx) => {
    if (!input.couponId) {
      const code = normalizeCouponCode(input.code ?? "");
      if (!code) ctx.addIssue({ code: "custom", path: ["code"], message: "required" });
      else if (!COUPON_CODE.test(code)) ctx.addIssue({ code: "custom", path: ["code"], message: "code_invalid" });
    }
    const v = input.kind === "percent" ? parsePercentBps(input.value) : parseWhole(input.value);
    if (String(input.value).trim() === "") ctx.addIssue({ code: "custom", path: ["value"], message: "required" });
    else if (v === null || v < 1) ctx.addIssue({ code: "custom", path: ["value"], message: input.kind === "percent" ? "percent_invalid" : "number_invalid" });
    else if (input.kind === "percent" && v > 10_000) ctx.addIssue({ code: "custom", path: ["value"], message: "percent_too_big" });
    else if (input.kind === "fixed" && v > 100_000_000) ctx.addIssue({ code: "custom", path: ["value"], message: "too_big" });
    if (input.startsAt !== null && input.endsAt !== null && Number.isFinite(input.startsAt) && Number.isFinite(input.endsAt) && input.endsAt <= input.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "ends_before_start" });
    if (input.couponId && input.reason.length < 3) ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_short" });
  });
export type CouponInput = z.input<typeof CouponInput>;

async function assertKnownIds(db: Db, input: { platformIds: string[]; categoryIds: string[]; segmentIds: string[] }) {
  const fields: Record<string, string> = {};
  const check = async (ids: string[], table: typeof platforms | typeof categories | typeof customerSegments, field: string) => {
    if (ids.length === 0) return;
    const found = await db.select({ id: table.id }).from(table).where(inArray(table.id, ids));
    if (found.length !== new Set(ids).size) fields[field] = "unknown_option";
  };
  await Promise.all([check(input.platformIds, platforms, "platformIds"), check(input.categoryIds, categories, "categoryIds"), check(input.segmentIds, customerSegments, "segmentIds")]);
  if (Object.keys(fields).length) throw invalid(fields);
}

function termsFromInput(input: z.output<typeof CouponInput>, keep: CouponConditionsView | null): CouponTerms {
  const value = (input.kind === "percent" ? parsePercentBps(input.value) : parseWhole(input.value)) as number;
  return {
    kind: input.kind,
    value,
    minSubtotalIqd: input.minSubtotalIqd,
    // a ceiling only means something on a percentage
    maxDiscountIqd: input.kind === "percent" ? input.maxDiscountIqd : null,
    usageLimit: input.usageLimit,
    perCustomerLimit: input.perCustomerLimit,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    conditions: {
      platformIds: [...new Set(input.platformIds)].sort(),
      categoryIds: [...new Set(input.categoryIds)].sort(),
      // product lists are not edited here; an existing one is kept as it is
      productIds: keep?.productIds ?? [],
      productKinds: [...new Set(input.productKinds)].sort(),
      segmentIds: [...new Set(input.segmentIds)].sort(),
      channels: [...new Set(input.channels)].sort(),
      firstOrderOnly: input.firstOrderOnly,
      minQty: input.minQty,
    },
  };
}

const columnsOf = (terms: CouponTerms) => ({
  kind: terms.kind,
  value: terms.value,
  minSubtotalIqd: terms.minSubtotalIqd,
  maxDiscountIqd: terms.maxDiscountIqd,
  usageLimit: terms.usageLimit,
  perCustomerLimit: terms.perCustomerLimit,
  startsAt: terms.startsAt,
  endsAt: terms.endsAt,
  conditions: storedConditions(terms.conditions),
});

export const COUPON_CODE = /^[A-Z0-9][A-Z0-9_-]{2,31}$/;

// ───────────────────────────────────────────────────────────────── writes

/**
 * Creates or edits a coupon. A new coupon is stored at once; when it should be switched on and its terms need a second
 * person, it stays off with a request. An edit whose new terms need a second person (and were not approved before in
 * exactly this form) becomes a request; the coupon keeps its current terms meanwhile. A double submit of the same new
 * coupon (same code, same author, same terms) answers `replayed`.
 */
export async function saveCoupon(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ couponId: string; status: "applied" | "requested" | "unchanged"; replayed?: boolean; reasons: ApprovalReason[] }> {
  assertCan(actor, "promotions.coupon.manage");
  const parsed = CouponInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "coupon.save");
  const input = parsed.data;
  await assertKnownIds(db, input);
  const actorId = actor.kind === "employee" ? actor.id : null;

  if (!input.couponId) {
    const code = normalizeCouponCode(input.code ?? "");
    if (!code || !COUPON_CODE.test(code)) throw invalid({ code: code ? "code_invalid" : "required" });
    if (input.endsAt !== null && input.endsAt <= now) throw invalid({ endsAt: "ends_past" });
    const terms = termsFromInput(input, null);
    const reasons = couponReasons(terms, await limitsInForce(db));
    const fingerprint = termsFingerprint(terms);
    const existing = await db.select({ coupon: coupons, conditionsText: sql<string | null>`CAST(${coupons.conditions} AS TEXT)` }).from(coupons).where(sql`upper(${coupons.code}) = ${code}`).get();
    if (existing) {
      const same = existing.coupon.createdBy === actorId && termsFingerprint(couponTerms(existing.coupon)) === fingerprint;
      if (same) return { couponId: existing.coupon.id, status: existing.coupon.isActive ? "applied" : (await pendingApprovalOf(db, KIND, existing.coupon.id)) ? "requested" : "applied", replayed: true, reasons };
      throw invalid({ code: "code_taken" });
    }
    const couponId = newId("cpn");
    const activate = input.activate === true;
    const needsSecond = activate && reasons.length > 0;
    const statements: BatchStatement[] = [
      db.insert(coupons).values({ id: couponId, code, ...columnsOf(terms), isActive: activate && !needsSecond, description: input.description || null, isDemo: options.demo ?? false, createdBy: actorId, createdAt: now }),
      auditStatement(db, { actor, action: "promotions.coupon.create", entityType: "coupon", entityId: couponId, summary: code, after: { ...terms, active: activate && !needsSecond, description: input.description || null }, reason: input.reason || null, at: now }),
    ];
    if (needsSecond) {
      statements.push(
        db.insert(approvals).values({ id: newId("apr"), kind: KIND, entityType: "coupon", entityId: couponId, requestedBy: actorId ?? "system", payload: { action: "create", fingerprint, terms, reasons }, status: "pending", reason: input.reason || null, requiredPermission: "pricing.discount.override", createdAt: now }),
        auditStatement(db, { actor, action: "promotions.coupon.request", entityType: "coupon", entityId: couponId, summary: code, after: { action: "create", reasons }, reason: input.reason || null, at: now }),
      );
    }
    await runBatch(db, statements).catch(changedGuard);
    return { couponId, status: needsSecond ? "requested" : "applied", reasons };
  }

  const row = await loadCoupon(db, input.couponId);
  const current = couponTerms(row);
  const currentFingerprint = termsFingerprint(current);
  if (input.expected !== undefined && input.expected !== currentFingerprint) throw new AppError("coupon_changed", 409);
  const terms = termsFromInput(input, current.conditions);
  const fingerprint = termsFingerprint(terms);
  const description = input.description || null;
  if (fingerprint === currentFingerprint && description === (row.description ?? null)) return { couponId: row.id, status: "unchanged", reasons: couponReasons(terms, await limitsInForce(db)) };
  if (await pendingApprovalOf(db, KIND, row.id)) throw new AppError("change_pending", 409);
  const reasons = couponReasons(terms, await limitsInForce(db));
  const termsChanged = fingerprint !== currentFingerprint;
  const needsSecond = termsChanged && reasons.length > 0 && !(await approvedFingerprint(db, KIND, row.id, fingerprint));
  if (needsSecond) {
    await runBatch(db, [
      noPendingRequest(db, KIND, row.id),
      db.insert(approvals).values({
        id: newId("apr"),
        kind: KIND,
        entityType: "coupon",
        entityId: row.id,
        requestedBy: actorId ?? "system",
        payload: { action: "update", fingerprint, terms, reasons, base: currentFingerprint, baseTerms: current, description, baseDescription: row.description ?? null, baseActive: row.isActive, baseConditionsText: row.conditionsText },
        status: "pending",
        reason: input.reason,
        requiredPermission: "pricing.discount.override",
        createdAt: now,
      }),
      auditStatement(db, { actor, action: "promotions.coupon.request", entityType: "coupon", entityId: row.id, summary: row.code, before: current, after: { action: "update", terms, reasons }, reason: input.reason, at: now }),
    ]).catch(changedGuard);
    return { couponId: row.id, status: "requested", reasons };
  }
  await runBatch(db, [
    db
      .update(coupons)
      .set({ ...columnsOf(terms), description })
      .where(sameRow(row, current)),
    expectChanged(db, 1, { code: "COUPON_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "promotions.coupon.update", entityType: "coupon", entityId: row.id, summary: row.code, before: { ...current, description: row.description }, after: { ...terms, description }, reason: input.reason, at: now }),
  ]).catch(changedGuard);
  return { couponId: row.id, status: "applied", reasons };
}

export const SetActiveInput = z.object({ couponId: z.string().regex(ID, "invalid"), active: z.boolean(), reason: reasonText, expected: z.string().max(4_000).optional() });

/** Switches a coupon on or off. Off is immediate; on needs a second person when its terms do and were never approved. */
export async function setCouponActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "applied" | "requested" | "unchanged" }> {
  assertCan(actor, "promotions.coupon.manage");
  const parsed = SetActiveInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "coupon.active");
  const input = parsed.data;
  const row = await loadCoupon(db, input.couponId);
  const terms = couponTerms(row);
  const fingerprint = termsFingerprint(terms);
  if (input.expected !== undefined && input.expected !== fingerprint) throw new AppError("coupon_changed", 409);
  if (row.isActive === input.active) return { status: "unchanged" };
  const actorId = actor.kind === "employee" ? actor.id : "system";
  if (input.active) {
    if (input.active && terms.endsAt !== null && terms.endsAt <= now) throw invalid({ endsAt: "ends_past" });
    const reasons = couponReasons(terms, await limitsInForce(db));
    if (reasons.length > 0 && !(await approvedFingerprint(db, KIND, row.id, fingerprint))) {
      if (await pendingApprovalOf(db, KIND, row.id)) throw new AppError("change_pending", 409);
      await runBatch(db, [
        noPendingRequest(db, KIND, row.id),
        db.insert(approvals).values({ id: newId("apr"), kind: KIND, entityType: "coupon", entityId: row.id, requestedBy: actorId, payload: { action: "activate", fingerprint, terms, reasons, baseConditionsText: row.conditionsText, baseDescription: row.description ?? null }, status: "pending", reason: input.reason, requiredPermission: "pricing.discount.override", createdAt: now }),
        auditStatement(db, { actor, action: "promotions.coupon.request", entityType: "coupon", entityId: row.id, summary: row.code, after: { action: "activate", reasons }, reason: input.reason, at: now }),
      ]).catch(changedGuard);
      return { status: "requested" };
    }
  }
  await runBatch(db, [
    db.update(coupons).set({ isActive: input.active }).where(sameRow(row, terms)),
    expectChanged(db, 1, { code: "COUPON_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: input.active ? "promotions.coupon.activate" : "promotions.coupon.deactivate", entityType: "coupon", entityId: row.id, summary: row.code, before: { active: row.isActive }, after: { active: input.active }, reason: input.reason, at: now }),
  ]).catch(changedGuard);
  return { status: "applied" };
}

export const BulkOffInput = z.object({ couponIds: z.array(z.string().regex(ID, "invalid")).min(1, "required").max(100, "too_many"), reason: reasonText });

/** Switches several coupons off at once (the safe direction). Coupons already off are skipped and counted. */
export async function deactivateCoupons(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ changed: number; skipped: number }> {
  assertCan(actor, "promotions.coupon.manage");
  const parsed = BulkOffInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "coupon.bulk");
  const ids = [...new Set(parsed.data.couponIds)];
  // D1 binds at most 100 parameters per statement: read the selection in parts
  const live: { id: string; code: string }[] = [];
  for (let i = 0; i < ids.length; i += 90) live.push(...(await db.select({ id: coupons.id, code: coupons.code }).from(coupons).where(and(inArray(coupons.id, ids.slice(i, i + 90)), eq(coupons.isActive, true)))));
  if (live.length === 0) return { changed: 0, skipped: ids.length };
  const statements: BatchStatement[] = [];
  for (const row of live) {
    statements.push(
      db.update(coupons).set({ isActive: false }).where(and(eq(coupons.id, row.id), eq(coupons.isActive, true))),
      expectChanged(db, 1, { code: "COUPON_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "promotions.coupon.deactivate", entityType: "coupon", entityId: row.id, summary: row.code, before: { active: true }, after: { active: false, bulk: true }, reason: parsed.data.reason, at: now }),
    );
  }
  await runBatch(db, statements).catch(changedGuard);
  return { changed: live.length, skipped: ids.length - live.length };
}

/** `couponId`: the coupon whose page sent the decision — another coupon's request is not found there (no IDOR). */
export const DecideInput = z.object({ approvalId: z.string().regex(ID, "invalid"), couponId: z.string().regex(ID, "invalid").optional(), decision: z.enum(["approve", "reject"], { error: "required" }), note: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(500, "too_long")) });

/** A second person approves or rejects a coupon request (never the requester). */
export async function decideCoupon(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "approved" | "rejected"; couponId: string }> {
  assertAny(actor, ["promotions.coupon.manage"]);
  const parsed = DecideInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "coupon.decide");
  const input = parsed.data;
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, KIND))).get();
  if (!approval || !approval.entityId || (input.couponId !== undefined && approval.entityId !== input.couponId)) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  assertMayDecide(actor, approval);
  if (input.decision === "reject" && input.note.length < 3) throw invalid({ note: "reason_short" });
  const row = await loadCoupon(db, approval.entityId);
  const payload = (approval.payload ?? {}) as { action?: string; terms?: CouponTerms; fingerprint?: string; base?: string; baseTerms?: CouponTerms; description?: string | null; baseDescription?: string | null; baseActive?: boolean; baseConditionsText?: string | null };
  const actorId = actor.kind === "employee" ? actor.id : "system";
  const close = [
    db
      .update(approvals)
      .set({ status: input.decision === "approve" ? "approved" : "rejected", decidedBy: actorId, decidedAt: now, decisionNote: input.note || null })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
  ];
  const statements: BatchStatement[] = [...close];
  if (input.decision === "approve") {
    const current = couponTerms(row);
    if (payload.action === "update") {
      if (!payload.terms || !payload.baseTerms || termsFingerprint(current) !== payload.base) throw new AppError("coupon_changed", 409);
      statements.push(
        db
          .update(coupons)
          .set({ ...columnsOf(payload.terms), description: payload.description ?? null })
          .where(sameRow({ id: row.id, isActive: row.isActive, description: row.description, conditionsText: row.conditionsText }, payload.baseTerms)),
        expectChanged(db, 1, { code: "COUPON_CHANGED", detail: row.id }),
      );
    } else {
      // create / activate: switch on exactly the terms that were approved
      if (termsFingerprint(current) !== payload.fingerprint) throw new AppError("coupon_changed", 409);
      if (current.endsAt !== null && current.endsAt <= now) throw invalid({ endsAt: "ends_past" });
      statements.push(db.update(coupons).set({ isActive: true }).where(sameRow({ ...row, isActive: false }, current)), expectChanged(db, 1, { code: "COUPON_CHANGED", detail: row.id }));
    }
  }
  statements.push(
    auditStatement(db, {
      actor,
      action: input.decision === "approve" ? "promotions.coupon.approve" : "promotions.coupon.reject",
      entityType: "coupon",
      entityId: row.id,
      summary: row.code,
      before: payload.action === "update" ? payload.baseTerms : { active: row.isActive },
      after: { action: payload.action, approvalId: approval.id, ...(input.decision === "approve" && payload.action === "update" ? { terms: payload.terms } : {}), ...(input.decision === "approve" && payload.action !== "update" ? { active: true } : {}) },
      reason: input.note || approval.reason,
      at: now,
    }),
  );
  await runBatch(db, statements).catch(changedGuard);
  return { status: input.decision === "approve" ? "approved" : "rejected", couponId: row.id };
}

/** The requester takes their own request back (it is closed as rejected with the note "withdrawn"). */
export async function withdrawCouponRequest(db: Db, actor: Actor, raw: { approvalId: string; couponId?: string }, now: number): Promise<{ couponId: string }> {
  assertCan(actor, "promotions.coupon.manage");
  const approvalId = z.string().regex(ID, "invalid").parse(raw.approvalId);
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.kind, KIND))).get();
  if (!approval || !approval.entityId || (raw.couponId !== undefined && approval.entityId !== raw.couponId)) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  if (actor.kind !== "employee" || approval.requestedBy !== actor.id) throw new AppError("forbidden", 403, { detail: "not_requester" });
  await runBatch(db, [
    db.update(approvals).set({ status: "rejected", decidedBy: actor.id, decidedAt: now, decisionNote: "withdrawn" }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
    auditStatement(db, { actor, action: "promotions.coupon.withdraw", entityType: "coupon", entityId: approval.entityId, after: { approvalId: approval.id }, at: now }),
  ]).catch(changedGuard);
  return { couponId: approval.entityId };
}

// ───────────────────────────────────────────────────────────────── try a coupon (the core's own evaluation)

/** A quantity as staff type it (Arabic-Indic and Persian digits too); "" = 1. */
const tryQty = z.preprocess((value) => (value === "" || value === null || value === undefined ? 1 : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(1, "too_small").max(50, "too_big"));

export const TryInput = z.object({
  code: z.string({ error: "required" }).min(1, "required").max(64, "too_long"),
  lines: z
    .array(z.object({ code: z.string().trim().min(1, "required").max(64, "too_long"), qty: tryQty }))
    .min(1, "required")
    .max(10, "too_many"),
  phone: z.string().max(30).optional(),
  channel: z.enum(CHANNELS).default("web"),
});

/**
 * "Would this coupon apply to this cart?" — answered by the commerce core's evaluateCoupon (the one validation path),
 * with today's prices of the SKUs typed in. Reads only; reserves nothing.
 */
export async function tryCoupon(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ result: CouponEvaluation; subtotalIqd: number; unknown: string[] }> {
  assertAny(actor, SECTION_READ.coupons);
  const parsed = TryInput.safeParse(raw);
  if (!parsed.success) {
    // the form shows one message for the cart lines (lines.0.qty → lines)
    const fields: Record<string, string> = {};
    for (const [name, issue] of Object.entries(zodFieldErrors(parsed.error))) fields[name.startsWith("lines.") ? "lines" : name] ??= issue;
    throw invalid(fields, "coupon.try");
  }
  const input = parsed.data;
  const codes = input.lines.map((line) => line.code.toUpperCase());
  const found = await db.select({ id: variants.id, sku: variants.sku, barcode: variants.barcode, price: variants.priceIqd }).from(variants).where(sql`upper(${variants.sku}) IN (${sql.join(codes.map((code) => sql`${code}`), sql`, `)}) OR ${variants.barcode} IN (${sql.join(input.lines.map((line) => sql`${line.code}`), sql`, `)})`);
  const unknown: string[] = [];
  const lines = input.lines.flatMap((line) => {
    const hit = found.find((row) => row.sku.toUpperCase() === line.code.toUpperCase() || row.barcode === line.code);
    if (!hit) {
      unknown.push(line.code);
      return [];
    }
    return [{ variantId: hit.id, qty: line.qty, unitPriceIqd: hit.price }];
  });
  if (unknown.length) throw invalid({ lines: "unknown_code" });
  const subtotalIqd = lines.reduce((sum, line) => sum + line.unitPriceIqd * line.qty, 0);
  const phone = input.phone ? normalizeIraqPhone(input.phone) : null;
  if (input.phone && !phone) throw invalid({ phone: "phone_invalid" });
  let customerId: string | null = null;
  if (phone) customerId = (await db.select({ id: customers.id }).from(customers).where(eq(customers.phoneE164, phone)).get())?.id ?? null;
  const result = await evaluateCoupon(db, { code: input.code, subtotalIqd, lines, customerId, phoneE164: phone, channel: input.channel }, now);
  return { result, subtotalIqd, unknown };
}

// ───────────────────────────────────────────────────────────────── pickers

/** Platforms, categories (tree order, with depth) and customer segments for the condition pickers. */
export async function conditionOptions(db: Db, locale: Locale): Promise<ConditionOptions> {
  const [platformRows, categoryRows, segmentRows] = await Promise.all([
    db.select({ id: platforms.id, name: platforms.name, sort: platforms.sort }).from(platforms).orderBy(asc(platforms.sort)),
    db.select({ id: categories.id, parentId: categories.parentId, name: categories.name, sort: categories.sort }).from(categories).where(eq(categories.isActive, true)).orderBy(asc(categories.sort)),
    db.select({ id: customerSegments.id, name: customerSegments.name, members: customerSegments.memberCount }).from(customerSegments).orderBy(asc(customerSegments.key)),
  ]);
  const children = new Map<string | null, typeof categoryRows>();
  for (const row of categoryRows) children.set(row.parentId, [...(children.get(row.parentId) ?? []), row]);
  const ordered: { id: string; name: string; depth: number }[] = [];
  const known = new Set(categoryRows.map((row) => row.id));
  const walk = (parent: string | null, depth: number) => {
    for (const row of children.get(parent) ?? []) {
      ordered.push({ id: row.id, name: pick(row.name, locale), depth });
      if (depth < 4) walk(row.id, depth + 1);
    }
  };
  walk(null, 0);
  // categories whose parent is switched off still appear (at the top level)
  for (const row of categoryRows) if (row.parentId && !known.has(row.parentId) && !ordered.some((entry) => entry.id === row.id)) ordered.push({ id: row.id, name: pick(row.name, locale), depth: 0 });
  return {
    platforms: platformRows.map((row) => ({ id: row.id, name: pick(row.name, locale) })),
    categories: ordered,
    segments: segmentRows.map((row) => ({ id: row.id, name: pick(row.name, locale), members: row.members })),
  };
}

/** Coupons of module 08 for pickers elsewhere (A/B tests): id, code, state. */
export async function couponChoices(db: Db, actor: Actor, now: number): Promise<{ id: string; code: string; state: CouponState }[]> {
  assertAny(actor, PROMOTIONS_PERMISSIONS);
  const rows = await db.select({ id: coupons.id, code: coupons.code, isActive: coupons.isActive, startsAt: coupons.startsAt, endsAt: coupons.endsAt, usageLimit: coupons.usageLimit }).from(coupons).orderBy(asc(coupons.code)).limit(300);
  return rows.map((row) => ({ id: row.id, code: row.code, state: couponStateOf(row, 0, false, now) }));
}
