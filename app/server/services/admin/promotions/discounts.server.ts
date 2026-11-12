/**
 * Admin 08.02 — conditional discount rules (`promotions` rows: automatic discounts, no code needed): category,
 * customer segment, cart value, quantity, platform and channel conditions; percent, fixed, tiered by quantity,
 * "buy X get Y" and free shipping; priority and stacking with coupons; a time window.
 *
 *   listRules(db, actor, filters, now) · getRule(db, actor, ruleId, now)
 *   saveRule(db, actor, raw, now)                    create (idempotencyKey) / edit (expectedUpdatedAt)
 *   setRuleActive(db, actor, { ruleId, active, reason, expectedUpdatedAt }, now)
 *   decideRule(db, actor, { approvalId, decision, note }, now) · withdrawRuleRequest(db, actor, { approvalId }, now)
 *   dryRun(db, actor, ruleId, { days, includeDemo }, now)   the recent orders the rule would have changed, and by how much
 *
 * HONEST BOUNDARY: the commerce core's cart totals do not read `promotions` yet — a rule switched on here changes no
 * checkout until `priceCart` (cart.server.ts, after the subtotal) and `placeOrder` apply it (requested; the pure
 * evaluator is `evaluateRule` in ./rules.ts). The dry run is how staff see a rule's effect today.
 *
 * Switching a rule on when its terms go beyond DISCOUNT_LIMITS needs a second person (approvals kind
 * "promotion_rule", promotions.rule.manage + pricing.discount.override, never the requester); an edit of a live rule
 * whose new terms need one waits while the rule keeps its terms. Every write is guarded on `updated_at`.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import type { L10n } from "~/lib/locales";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { approvals, categories, customerSegmentMembers, customerSegments, platforms, promotions, type Promotion, type PromotionScope } from "~/server/db/schema";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { discountApprovalReasons, evaluateRule, ruleStateOf, stackedChange, termsFingerprint, type CartFacts, type CartLineFacts } from "./rules";
import { ID, KEY, SECTION_READ, approvedFingerprint, assertAny, assertMayDecide, canDecideApproval, historyOf, idFromKey, noPendingRequest, num, pendingApprovalOf, pendingChangeView } from "./shared.server";
import {
  CHANNELS,
  DAY_MS,
  DRY_RUN_MAX_ORDERS,
  PAGE_SIZE,
  PRODUCT_KIND_OPTIONS,
  RULE_KINDS,
  fromBaghdadInput,
  parsePercentBps,
  parseWhole,
  type ApprovalReason,
  type DryRun,
  type DryRunOrder,
  type DryRunSkip,
  type RuleDetail,
  type RuleFilters,
  type RulePage,
  type RuleRow,
  type RuleState,
  type RuleTerms,
  type RuleView,
  type DiscountLimits,
} from "./types";
import { programRules } from "./program.server";

const KIND = "promotion_rule" as const;

// ───────────────────────────────────────────────────────────────── terms

const strings = (value: unknown) => (Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string"))].sort() : []);

export function ruleTerms(row: Pick<Promotion, "kind" | "value" | "config" | "scope" | "maxDiscountIqd" | "stackable" | "priority" | "startsAt" | "endsAt">): RuleTerms {
  const config = (row.config ?? {}) as { tiers?: unknown; buy?: unknown; get?: unknown };
  const scope: PromotionScope = row.scope ?? {};
  const tiers = Array.isArray(config.tiers)
    ? config.tiers
        .filter((tier): tier is { minQty: number; bps: number } => typeof tier === "object" && tier !== null && typeof (tier as { minQty?: unknown }).minQty === "number" && typeof (tier as { bps?: unknown }).bps === "number")
        .map((tier) => ({ minQty: tier.minQty, bps: tier.bps }))
        .sort((a, b) => a.minQty - b.minQty)
    : [];
  return {
    kind: (RULE_KINDS as readonly string[]).includes(row.kind) ? (row.kind as RuleTerms["kind"]) : "percent",
    value: row.kind === "percent" || row.kind === "fixed" ? row.value : null,
    tiers: row.kind === "tiered" ? tiers : [],
    bogo: row.kind === "bogo" && typeof config.buy === "number" && typeof config.get === "number" ? { buy: config.buy, get: config.get } : null,
    maxDiscountIqd: row.maxDiscountIqd,
    stackable: row.stackable,
    priority: row.priority,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    scope: {
      platformIds: strings(scope.platformIds),
      categoryIds: strings(scope.categoryIds),
      productKinds: strings(scope.productKinds),
      segmentIds: strings(scope.segmentIds),
      channels: strings(scope.channels),
      minSubtotalIqd: typeof scope.minSubtotalIqd === "number" ? scope.minSubtotalIqd : null,
      minQty: typeof scope.minQty === "number" ? scope.minQty : null,
    },
  };
}

/** Why these terms need a second person, against the limits in force (`limits`: programRules; DISCOUNT_LIMITS when left out). */
export const ruleReasons = (terms: RuleTerms, limits?: DiscountLimits): ApprovalReason[] => discountApprovalReasons({ kind: terms.kind, value: terms.value, maxDiscountIqd: terms.maxDiscountIqd, tiers: terms.tiers }, { limits });
/** The discount limits in force (the setting promotions.discount_limits — follow-up 2026-11-12). */
const limitsInForce = async (db: Db) => (await programRules(db)).limits;

function columnsOf(terms: RuleTerms, keepScope: PromotionScope | null) {
  const scope: PromotionScope = {};
  if (keepScope?.productIds?.length) scope.productIds = keepScope.productIds;
  if (keepScope?.variantIds?.length) scope.variantIds = keepScope.variantIds;
  if (terms.scope.platformIds.length) scope.platformIds = terms.scope.platformIds;
  if (terms.scope.categoryIds.length) scope.categoryIds = terms.scope.categoryIds;
  if (terms.scope.productKinds.length) scope.productKinds = terms.scope.productKinds;
  if (terms.scope.segmentIds.length) scope.segmentIds = terms.scope.segmentIds;
  if (terms.scope.channels.length) scope.channels = terms.scope.channels;
  if (terms.scope.minSubtotalIqd !== null) scope.minSubtotalIqd = terms.scope.minSubtotalIqd;
  if (terms.scope.minQty !== null) scope.minQty = terms.scope.minQty;
  const config: Record<string, unknown> | null = terms.kind === "tiered" ? { tiers: terms.tiers } : terms.kind === "bogo" && terms.bogo ? { buy: terms.bogo.buy, get: terms.bogo.get } : null;
  return { kind: terms.kind, value: terms.value, config, scope: Object.keys(scope).length ? scope : null, maxDiscountIqd: terms.maxDiscountIqd, priority: terms.priority, stackable: terms.stackable, startsAt: terms.startsAt, endsAt: terms.endsAt };
}

async function loadRule(db: Db, ruleId: string): Promise<Promotion> {
  if (!ID.test(ruleId)) throw notFound("promotion");
  const row = await db.select().from(promotions).where(eq(promotions.id, ruleId)).get();
  if (!row) throw notFound("promotion");
  return row;
}

function changedGuard(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "CHANGE_PENDING") throw new AppError("change_pending", 409);
  if (info?.code === "RULE_CHANGED") throw new AppError("rule_changed", 409);
  if (info?.code === "CHANGE_NOT_PENDING") throw new AppError("change_not_pending", 409);
  throw error;
}

// ───────────────────────────────────────────────────────────────── lists

const VIEW_STATES: Record<RuleView, RuleState[] | null> = { all: null, live: ["live"], scheduled: ["scheduled"], pending: null, off: ["off"], ended: ["expired"] };

export async function listRules(db: Db, actor: Actor, filters: RuleFilters, now: number, locale: Locale): Promise<RulePage> {
  assertAny(actor, SECTION_READ.rules);
  const rows = await db.select().from(promotions).orderBy(desc(promotions.priority), desc(promotions.createdAt)).limit(500);
  const pendingIds = new Set(
    (await db.select({ entityId: approvals.entityId }).from(approvals).where(and(eq(approvals.kind, KIND), eq(approvals.status, "pending")))).map((row) => row.entityId).filter((id): id is string => Boolean(id)),
  );
  const q = filters.q.toLowerCase();
  const all = rows.map((row) => {
    const pending = pendingIds.has(row.id);
    return { row, pending, state: ruleStateOf(row, pending, now) };
  });
  const counts: Partial<Record<RuleView, number>> = { all: all.length, live: 0, scheduled: 0, pending: 0, off: 0, ended: 0 };
  for (const entry of all) {
    if (entry.pending) counts.pending = (counts.pending ?? 0) + 1;
    for (const view of ["live", "scheduled", "off", "ended"] as const) if (VIEW_STATES[view]?.includes(entry.state)) counts[view] = (counts[view] ?? 0) + 1;
  }
  const states = VIEW_STATES[filters.view];
  const visible = all.filter((entry) => {
    if (filters.view === "pending" ? !entry.pending : states && !states.includes(entry.state)) return false;
    if (q && !`${entry.row.name.ar} ${entry.row.name.en ?? ""}`.toLowerCase().includes(q)) return false;
    return true;
  });
  const page = visible.slice((filters.page - 1) * PAGE_SIZE, filters.page * PAGE_SIZE);
  return {
    rows: page.map(
      ({ row, pending, state }): RuleRow => ({ id: row.id, name: pick(row.name, locale), kind: ruleTerms(row).kind, value: row.value, state, isActive: row.isActive, startsAt: row.startsAt, endsAt: row.endsAt, stackable: row.stackable, priority: row.priority, isDemo: row.isDemo, pending }),
    ),
    total: visible.length,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(visible.length / PAGE_SIZE)),
    counts,
  };
}

export async function getRule(db: Db, actor: Actor, ruleId: string, now: number): Promise<RuleDetail> {
  assertAny(actor, SECTION_READ.rules);
  const row = await loadRule(db, ruleId);
  const terms = ruleTerms(row);
  const fingerprint = termsFingerprint(terms);
  const [pending, approved, history] = await Promise.all([pendingApprovalOf(db, KIND, row.id), approvedFingerprint(db, KIND, row.id, fingerprint), historyOf(db, "promotion", row.id)]);
  const view = await pendingChangeView(db, actor, pending);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    isActive: row.isActive,
    isDemo: row.isDemo,
    state: ruleStateOf(row, Boolean(pending), now),
    terms,
    fingerprint,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    approvalReasons: ruleReasons(terms, await limitsInForce(db)),
    approvedTerms: approved,
    pending: view ? { ...view, terms: null } : null,
    history,
    can: { manage: can(actor, "promotions.rule.manage"), decide: pending ? canDecideApproval(actor, pending) : false },
  };
}

// ───────────────────────────────────────────────────────────────── input

const reasonText = z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long");
const many = (value: unknown) => (value === undefined || value === null || value === "" ? [] : Array.isArray(value) ? value : [value]);
const idList = z.preprocess(many, z.array(z.string().regex(ID, "invalid")).max(40, "too_many"));
const whole = (max: number) => z.preprocess((value) => (value === "" || value === null || value === undefined ? null : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(1, "too_small").max(max, "too_big").nullable());
const optionalText = (max: number) => z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanLine).trim().max(max, "too_long"));

export const RuleInput = z
  .object({
    ruleId: z.string().regex(ID, "invalid").optional(),
    idempotencyKey: z.string().regex(KEY, "invalid").optional(),
    expectedUpdatedAt: z.preprocess((value) => (value === "" || value === undefined ? undefined : Number(value)), z.number().int().optional()),
    nameAr: z.string({ error: "required" }).overwrite(cleanLine).trim().min(2, "required").max(120, "too_long"),
    nameEn: optionalText(120),
    descriptionAr: optionalText(300),
    descriptionEn: optionalText(300),
    kind: z.enum(RULE_KINDS, { error: "required" }),
    value: z.preprocess((value) => (typeof value === "string" || typeof value === "number" ? value : ""), z.union([z.string(), z.number()])),
    tierMinQty: z.preprocess(many, z.array(z.string()).max(6)),
    tierPercent: z.preprocess(many, z.array(z.string()).max(6)),
    buy: whole(20),
    get: whole(20),
    maxDiscountIqd: whole(100_000_000),
    stackable: z.preprocess((value) => value === true || value === "on" || value === "1" || value === "true", z.boolean()),
    priority: z.preprocess((value) => (value === "" || value === undefined || value === null ? 0 : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(0, "too_small").max(100, "too_big")),
    startsAt: z.preprocess((value) => fromBaghdadInput(value ?? ""), z.number({ error: "date_invalid" }).int().nullable()),
    endsAt: z.preprocess((value) => fromBaghdadInput(value ?? ""), z.number({ error: "date_invalid" }).int().nullable()),
    platformIds: idList,
    categoryIds: idList,
    productKinds: z.preprocess(many, z.array(z.enum(PRODUCT_KIND_OPTIONS, { error: "invalid" })).max(9)),
    segmentIds: idList,
    channels: z.preprocess(many, z.array(z.enum(CHANNELS, { error: "invalid" })).max(2)),
    minSubtotalIqd: whole(100_000_000),
    minQty: whole(1_000),
    activate: z.preprocess((value) => value === true || value === "on" || value === "1" || value === "true", z.boolean()).optional(),
    reason: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(500, "too_long")),
  })
  .superRefine((input, ctx) => {
    if (input.kind === "percent") {
      const bps = parsePercentBps(input.value);
      if (bps === null || bps < 1) ctx.addIssue({ code: "custom", path: ["value"], message: String(input.value ?? "").trim() === "" ? "required" : "percent_invalid" });
      else if (bps > 10_000) ctx.addIssue({ code: "custom", path: ["value"], message: "percent_too_big" });
    }
    if (input.kind === "fixed") {
      const iqd = parseWhole(input.value);
      if (iqd === null || iqd < 1) ctx.addIssue({ code: "custom", path: ["value"], message: String(input.value ?? "").trim() === "" ? "required" : "number_invalid" });
      else if (iqd > 100_000_000) ctx.addIssue({ code: "custom", path: ["value"], message: "too_big" });
    }
    if (input.kind === "tiered") {
      const pairs = input.tierMinQty.map((qty, index) => [qty, input.tierPercent[index] ?? ""] as const).filter(([qty, percent]) => qty.trim() !== "" || percent.trim() !== "");
      if (pairs.length === 0) ctx.addIssue({ code: "custom", path: ["tiers"], message: "required" });
      for (const [qty, percent] of pairs) {
        const q = parseWhole(qty);
        const bps = parsePercentBps(percent);
        if (q === null || q < 1 || q > 1_000 || bps === null || bps < 1 || bps > 10_000) ctx.addIssue({ code: "custom", path: ["tiers"], message: "tier_invalid" });
      }
      if (new Set(pairs.map(([qty]) => parseWhole(qty))).size !== pairs.length) ctx.addIssue({ code: "custom", path: ["tiers"], message: "tier_duplicate" });
    }
    if (input.kind === "bogo" && (input.buy === null || input.get === null)) ctx.addIssue({ code: "custom", path: [input.buy === null ? "buy" : "get"], message: "required" });
    if (input.startsAt !== null && input.endsAt !== null && Number.isFinite(input.startsAt) && Number.isFinite(input.endsAt) && input.endsAt <= input.startsAt) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "ends_before_start" });
    if (input.ruleId && input.reason.length < 3) ctx.addIssue({ code: "custom", path: ["reason"], message: "reason_short" });
    if (!input.ruleId && !input.idempotencyKey) ctx.addIssue({ code: "custom", path: ["idempotencyKey"], message: "required" });
  });
export type RuleInput = z.input<typeof RuleInput>;

function termsFromInput(input: z.output<typeof RuleInput>): RuleTerms {
  const tiers =
    input.kind === "tiered"
      ? input.tierMinQty
          .map((qty, index) => ({ minQty: parseWhole(qty), bps: parsePercentBps(input.tierPercent[index] ?? "") }))
          .filter((tier): tier is { minQty: number; bps: number } => tier.minQty !== null && tier.bps !== null)
          .sort((a, b) => a.minQty - b.minQty)
      : [];
  return {
    kind: input.kind,
    value: input.kind === "percent" ? parsePercentBps(input.value) : input.kind === "fixed" ? parseWhole(input.value) : null,
    tiers,
    bogo: input.kind === "bogo" && input.buy !== null && input.get !== null ? { buy: input.buy, get: input.get } : null,
    maxDiscountIqd: input.kind === "fixed" ? null : input.maxDiscountIqd,
    stackable: input.stackable,
    priority: input.priority,
    startsAt: input.startsAt,
    endsAt: input.endsAt,
    scope: {
      platformIds: [...new Set(input.platformIds)].sort(),
      categoryIds: [...new Set(input.categoryIds)].sort(),
      productKinds: [...new Set(input.productKinds)].sort(),
      segmentIds: [...new Set(input.segmentIds)].sort(),
      channels: [...new Set(input.channels)].sort(),
      minSubtotalIqd: input.minSubtotalIqd,
      minQty: input.minQty,
    },
  };
}

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

const l10n = (ar: string, en: string): L10n => (en ? { ar, en } : { ar });
const l10nOrNull = (ar: string, en: string): L10n | null => (ar ? l10n(ar, en) : en ? { ar: en, en } : null);

// ───────────────────────────────────────────────────────────────── writes

/** Creates or edits a rule (see the file header for when a second person decides). */
export async function saveRule(db: Db, actor: Actor, raw: unknown, now: number, options: { demo?: boolean } = {}): Promise<{ ruleId: string; status: "applied" | "requested" | "unchanged"; replayed?: boolean; reasons: ApprovalReason[] }> {
  assertCan(actor, "promotions.rule.manage");
  const parsed = RuleInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "rule.save");
  const input = parsed.data;
  await assertKnownIds(db, input);
  const terms = termsFromInput(input);
  const reasons = ruleReasons(terms, await limitsInForce(db));
  const fingerprint = termsFingerprint(terms);
  const actorId = actor.kind === "employee" ? actor.id : "system";
  const name = l10n(input.nameAr, input.nameEn);
  const description = l10nOrNull(input.descriptionAr, input.descriptionEn);

  if (!input.ruleId) {
    if (input.endsAt !== null && input.endsAt <= now) throw invalid({ endsAt: "ends_past" });
    const ruleId = await idFromKey("prm", actor, input.idempotencyKey as string);
    const existing = await db.select().from(promotions).where(eq(promotions.id, ruleId)).get();
    if (existing) {
      if (termsFingerprint(ruleTerms(existing)) !== fingerprint) throw new AppError("idempotency_mismatch", 409);
      return { ruleId, status: existing.isActive || !(await pendingApprovalOf(db, KIND, ruleId)) ? "applied" : "requested", replayed: true, reasons };
    }
    const activate = input.activate === true;
    const needsSecond = activate && reasons.length > 0;
    const statements: BatchStatement[] = [
      db.insert(promotions).values({ id: ruleId, name, description, ...columnsOf(terms, null), isActive: activate && !needsSecond, isDemo: options.demo ?? false, createdBy: actorId, createdAt: now, updatedAt: now }),
      auditStatement(db, { actor, action: "promotions.rule.create", entityType: "promotion", entityId: ruleId, summary: name.ar, after: { ...terms, active: activate && !needsSecond }, reason: input.reason || null, at: now }),
    ];
    if (needsSecond) {
      statements.push(
        db.insert(approvals).values({ id: await idFromKey("apr", actor, `${input.idempotencyKey}:rule`), kind: KIND, entityType: "promotion", entityId: ruleId, requestedBy: actorId, payload: { action: "create", fingerprint, reasons, baseUpdatedAt: now }, status: "pending", reason: input.reason || null, requiredPermission: "pricing.discount.override", createdAt: now }),
        auditStatement(db, { actor, action: "promotions.rule.request", entityType: "promotion", entityId: ruleId, summary: name.ar, after: { action: "create", reasons }, reason: input.reason || null, at: now }),
      );
    }
    await runBatch(db, statements).catch(changedGuard);
    return { ruleId, status: needsSecond ? "requested" : "applied", reasons };
  }

  const row = await loadRule(db, input.ruleId);
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== row.updatedAt) throw new AppError("rule_changed", 409);
  const current = ruleTerms(row);
  const currentFingerprint = termsFingerprint(current);
  const sameText = JSON.stringify(name) === JSON.stringify(row.name) && JSON.stringify(description) === JSON.stringify(row.description ?? null);
  if (fingerprint === currentFingerprint && sameText) return { ruleId: row.id, status: "unchanged", reasons };
  if (await pendingApprovalOf(db, KIND, row.id)) throw new AppError("change_pending", 409);
  const needsSecond = row.isActive && fingerprint !== currentFingerprint && reasons.length > 0 && !(await approvedFingerprint(db, KIND, row.id, fingerprint));
  if (needsSecond) {
    await runBatch(db, [
      noPendingRequest(db, KIND, row.id),
      db.insert(approvals).values({
        id: newId("apr"),
        kind: KIND,
        entityType: "promotion",
        entityId: row.id,
        requestedBy: actorId,
        payload: { action: "update", fingerprint, reasons, terms, name, description, baseUpdatedAt: row.updatedAt, base: currentFingerprint },
        status: "pending",
        reason: input.reason,
        requiredPermission: "pricing.discount.override",
        createdAt: now,
      }),
      auditStatement(db, { actor, action: "promotions.rule.request", entityType: "promotion", entityId: row.id, summary: row.name.ar, before: current, after: { action: "update", terms, reasons }, reason: input.reason, at: now }),
    ]).catch(changedGuard);
    return { ruleId: row.id, status: "requested", reasons };
  }
  await runBatch(db, [
    db
      .update(promotions)
      .set({ name, description, ...columnsOf(terms, row.scope), updatedAt: Math.max(now, row.updatedAt + 1) })
      .where(and(eq(promotions.id, row.id), eq(promotions.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "RULE_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "promotions.rule.update", entityType: "promotion", entityId: row.id, summary: name.ar, before: current, after: terms, reason: input.reason, at: now }),
  ]).catch(changedGuard);
  return { ruleId: row.id, status: "applied", reasons };
}

export const RuleActiveInput = z.object({ ruleId: z.string().regex(ID, "invalid"), active: z.boolean(), reason: reasonText, expectedUpdatedAt: z.number().int().optional() });

export async function setRuleActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "applied" | "requested" | "unchanged" }> {
  assertCan(actor, "promotions.rule.manage");
  const parsed = RuleActiveInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "rule.active");
  const input = parsed.data;
  const row = await loadRule(db, input.ruleId);
  if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== row.updatedAt) throw new AppError("rule_changed", 409);
  if (row.isActive === input.active) return { status: "unchanged" };
  const terms = ruleTerms(row);
  const actorId = actor.kind === "employee" ? actor.id : "system";
  if (input.active) {
    if (terms.endsAt !== null && terms.endsAt <= now) throw invalid({ endsAt: "ends_past" });
    const reasons = ruleReasons(terms, await limitsInForce(db));
    const fingerprint = termsFingerprint(terms);
    if (reasons.length > 0 && !(await approvedFingerprint(db, KIND, row.id, fingerprint))) {
      if (await pendingApprovalOf(db, KIND, row.id)) throw new AppError("change_pending", 409);
      await runBatch(db, [
        noPendingRequest(db, KIND, row.id),
        db.insert(approvals).values({ id: newId("apr"), kind: KIND, entityType: "promotion", entityId: row.id, requestedBy: actorId, payload: { action: "activate", fingerprint, reasons, baseUpdatedAt: row.updatedAt }, status: "pending", reason: input.reason, requiredPermission: "pricing.discount.override", createdAt: now }),
        auditStatement(db, { actor, action: "promotions.rule.request", entityType: "promotion", entityId: row.id, summary: row.name.ar, after: { action: "activate", reasons }, reason: input.reason, at: now }),
      ]).catch(changedGuard);
      return { status: "requested" };
    }
  }
  await runBatch(db, [
    db
      .update(promotions)
      .set({ isActive: input.active, updatedAt: Math.max(now, row.updatedAt + 1) })
      .where(and(eq(promotions.id, row.id), eq(promotions.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "RULE_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: input.active ? "promotions.rule.activate" : "promotions.rule.deactivate", entityType: "promotion", entityId: row.id, summary: row.name.ar, before: { active: row.isActive }, after: { active: input.active }, reason: input.reason, at: now }),
  ]).catch(changedGuard);
  return { status: "applied" };
}

/** `ruleId`: the rule whose page sent the decision — another rule's request is not found there (no IDOR). */
export const RuleDecideInput = z.object({ approvalId: z.string().regex(ID, "invalid"), ruleId: z.string().regex(ID, "invalid").optional(), decision: z.enum(["approve", "reject"], { error: "required" }), note: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(500, "too_long")) });

export async function decideRule(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "approved" | "rejected"; ruleId: string }> {
  assertCan(actor, "promotions.rule.manage");
  const parsed = RuleDecideInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "rule.decide");
  const input = parsed.data;
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, input.approvalId), eq(approvals.kind, KIND))).get();
  if (!approval || !approval.entityId || (input.ruleId !== undefined && approval.entityId !== input.ruleId)) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  assertMayDecide(actor, approval);
  if (input.decision === "reject" && input.note.length < 3) throw invalid({ note: "reason_short" });
  const row = await loadRule(db, approval.entityId);
  const payload = (approval.payload ?? {}) as { action?: string; fingerprint?: string; terms?: RuleTerms; name?: L10n; description?: L10n | null; baseUpdatedAt?: number };
  const actorId = actor.kind === "employee" ? actor.id : "system";
  const statements: BatchStatement[] = [
    db
      .update(approvals)
      .set({ status: input.decision === "approve" ? "approved" : "rejected", decidedBy: actorId, decidedAt: now, decisionNote: input.note || null })
      .where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
  ];
  if (input.decision === "approve") {
    if (payload.baseUpdatedAt !== row.updatedAt) throw new AppError("rule_changed", 409);
    if (payload.action === "update" && payload.terms) {
      statements.push(
        db
          .update(promotions)
          .set({ ...(payload.name ? { name: payload.name } : {}), description: payload.description ?? null, ...columnsOf(payload.terms, row.scope), updatedAt: Math.max(now, row.updatedAt + 1) })
          .where(and(eq(promotions.id, row.id), eq(promotions.updatedAt, row.updatedAt))),
        expectChanged(db, 1, { code: "RULE_CHANGED", detail: row.id }),
      );
    } else {
      if (termsFingerprint(ruleTerms(row)) !== payload.fingerprint) throw new AppError("rule_changed", 409);
      if (row.endsAt !== null && row.endsAt <= now) throw invalid({ endsAt: "ends_past" });
      statements.push(
        db
          .update(promotions)
          .set({ isActive: true, updatedAt: Math.max(now, row.updatedAt + 1) })
          .where(and(eq(promotions.id, row.id), eq(promotions.updatedAt, row.updatedAt))),
        expectChanged(db, 1, { code: "RULE_CHANGED", detail: row.id }),
      );
    }
  }
  statements.push(
    auditStatement(db, { actor, action: input.decision === "approve" ? "promotions.rule.approve" : "promotions.rule.reject", entityType: "promotion", entityId: row.id, summary: row.name.ar, after: { action: payload.action, approvalId: approval.id }, reason: input.note || approval.reason, at: now }),
  );
  await runBatch(db, statements).catch(changedGuard);
  return { status: input.decision === "approve" ? "approved" : "rejected", ruleId: row.id };
}

export async function withdrawRuleRequest(db: Db, actor: Actor, raw: { approvalId: string; ruleId?: string }, now: number): Promise<{ ruleId: string }> {
  assertCan(actor, "promotions.rule.manage");
  const approvalId = z.string().regex(ID, "invalid").parse(raw.approvalId);
  const approval = await db.select().from(approvals).where(and(eq(approvals.id, approvalId), eq(approvals.kind, KIND))).get();
  if (!approval || !approval.entityId || (raw.ruleId !== undefined && approval.entityId !== raw.ruleId)) throw notFound("approval");
  if (approval.status !== "pending") throw new AppError("change_not_pending", 409);
  if (actor.kind !== "employee" || approval.requestedBy !== actor.id) throw new AppError("forbidden", 403, { detail: "not_requester" });
  await runBatch(db, [
    db.update(approvals).set({ status: "rejected", decidedBy: actor.id, decidedAt: now, decisionNote: "withdrawn" }).where(and(eq(approvals.id, approval.id), eq(approvals.status, "pending"))),
    expectChanged(db, 1, { code: "CHANGE_NOT_PENDING", detail: approval.id }),
    auditStatement(db, { actor, action: "promotions.rule.withdraw", entityType: "promotion", entityId: approval.entityId, after: { approvalId: approval.id }, at: now }),
  ]).catch(changedGuard);
  return { ruleId: approval.entityId };
}

// ───────────────────────────────────────────────────────────────── the dry run

type OrderFact = { id: string; ref: string; channel: string; customer_id: string | null; subtotal_iqd: number; discount_iqd: number; shipping_iqd: number; placed_at: number; is_demo: number };
type LineFact = { order_id: string; variant_id: string; product_id: string; platform_id: string | null; category_id: string | null; kind: string; qty: number; unit_price_iqd: number; cost: number | null };

/**
 * The orders placed in the last `days` days (not cancelled, the newest DRY_RUN_MAX_ORDERS), priced again with this
 * rule as if it had existed: which would have changed, by how much, and why the others would not. Segment
 * membership is today's. Demo orders are left out unless asked for (and counted). [P] With cost.read + profit.read
 * the margin of the changed orders before and after (cost snapshots of their lines; a line without a cost makes the
 * margin unknown, never 0).
 */
export async function dryRun(db: Db, actor: Actor, ruleId: string, options: { days: number; includeDemo: boolean }, now: number): Promise<DryRun> {
  assertAny(actor, SECTION_READ.rules);
  const row = await loadRule(db, ruleId);
  const terms = ruleTerms(row);
  const since = now - options.days * DAY_MS;
  const demoWhere = options.includeDemo ? sql`` : sql` AND o.is_demo = 0`;
  const [orderRows, demoCount] = await Promise.all([
    db.all<OrderFact>(sql`SELECT o.id, o.ref, o.channel, o.customer_id, o.subtotal_iqd, o.discount_iqd, o.shipping_iqd, o.placed_at, o.is_demo FROM orders AS o
      WHERE o.placed_at >= ${since} AND o.placed_at < ${now} AND o.status <> 'cancelled'${demoWhere}
      ORDER BY o.placed_at DESC LIMIT ${DRY_RUN_MAX_ORDERS + 1}`),
    options.includeDemo ? Promise.resolve([{ n: 0 }]) : db.all<{ n: number }>(sql`SELECT count(*) AS n FROM orders AS o WHERE o.placed_at >= ${since} AND o.placed_at < ${now} AND o.status <> 'cancelled' AND o.is_demo = 1`),
  ]);
  const truncated = orderRows.length > DRY_RUN_MAX_ORDERS;
  const scanned = orderRows.slice(0, DRY_RUN_MAX_ORDERS);
  const withCost = can(actor, "cost.read") && can(actor, "profit.read");

  const lines = new Map<string, LineFact[]>();
  const ids = scanned.map((order) => order.id);
  for (let i = 0; i < ids.length; i += 80) {
    const part = ids.slice(i, i + 80);
    const rows = await db.all<LineFact>(sql`SELECT oi.order_id, oi.variant_id, p.id AS product_id, p.platform_id, p.category_id, p.kind, oi.qty, oi.unit_price_iqd, ${withCost ? sql`oi.cost_snapshot_iqd` : sql`NULL`} AS cost
      FROM order_items AS oi JOIN variants AS v ON v.id = oi.variant_id JOIN products AS p ON p.id = v.product_id
      WHERE oi.order_id IN (${sql.join(part.map((id) => sql`${id}`), sql`, `)})`);
    for (const line of rows) lines.set(line.order_id, [...(lines.get(line.order_id) ?? []), line]);
  }
  const tree = await db.select({ id: categories.id, parentId: categories.parentId }).from(categories);
  const parent = new Map(tree.map((entry) => [entry.id, entry.parentId]));
  const chains = new Map<string, string[]>();
  const chainOf = (categoryId: string | null): string[] => {
    if (!categoryId) return [];
    const cached = chains.get(categoryId);
    if (cached) return cached;
    const seen: string[] = [];
    for (let current: string | null = categoryId; current && !seen.includes(current); current = parent.get(current) ?? null) seen.push(current);
    chains.set(categoryId, seen);
    return seen;
  };
  const segments = new Map<string, Set<string>>();
  if (terms.scope.segmentIds.length) {
    const customerIds = [...new Set(scanned.map((order) => order.customer_id).filter((id): id is string => Boolean(id)))];
    for (let i = 0; i < customerIds.length; i += 80) {
      const rows = await db.select({ customerId: customerSegmentMembers.customerId, segmentId: customerSegmentMembers.segmentId }).from(customerSegmentMembers).where(inArray(customerSegmentMembers.customerId, customerIds.slice(i, i + 80)));
      for (const entry of rows) segments.set(entry.customerId, new Set([...(segments.get(entry.customerId) ?? []), entry.segmentId]));
    }
  }

  const skips: Partial<Record<DryRunSkip, number>> = {};
  const changedOrders: (DryRunOrder & { cost: number | null; uncosted: number })[] = [];
  for (const order of scanned) {
    const facts: CartFacts = {
      channel: order.channel,
      segmentIds: (order.customer_id && segments.get(order.customer_id)) || new Set<string>(),
      subtotalIqd: num(order.subtotal_iqd),
      shippingIqd: num(order.shipping_iqd),
      placedAt: num(order.placed_at),
      lines: (lines.get(order.id) ?? []).map((line): CartLineFacts => ({ variantId: line.variant_id, productId: line.product_id, platformId: line.platform_id, categoryChain: chainOf(line.category_id), kind: line.kind, qty: num(line.qty), unitPriceIqd: num(line.unit_price_iqd) })),
    };
    // the dry run asks "what if this rule had been there": its own window is not applied to the past
    const outcome = evaluateRule({ ...terms, startsAt: null, endsAt: null }, facts);
    if (!outcome.applies) {
      skips[outcome.skip] = (skips[outcome.skip] ?? 0) + 1;
      continue;
    }
    const change = stackedChange(outcome, terms.stackable, num(order.discount_iqd), num(order.subtotal_iqd));
    if (change.goodsIqd <= 0 && change.shippingIqd <= 0) {
      skips.coupon_better = (skips.coupon_better ?? 0) + 1;
      continue;
    }
    const orderLines = lines.get(order.id) ?? [];
    const uncosted = orderLines.filter((line) => line.cost === null).length;
    const cost = uncosted > 0 ? null : orderLines.reduce((sum, line) => sum + num(line.cost) * num(line.qty), 0);
    changedOrders.push({
      ref: order.ref,
      placedAt: num(order.placed_at),
      channel: order.channel,
      subtotalIqd: num(order.subtotal_iqd),
      existingDiscountIqd: num(order.discount_iqd),
      ruleDiscountIqd: outcome.discountIqd,
      changeIqd: change.goodsIqd,
      shippingIqd: change.shippingIqd,
      isDemo: num(order.is_demo) === 1,
      cost,
      uncosted,
    });
  }
  const result: DryRun = {
    days: options.days,
    includeDemo: options.includeDemo,
    scanned: scanned.length,
    truncated,
    demoLeftOut: num(demoCount[0]?.n),
    changed: changedOrders.length,
    discountIqd: changedOrders.reduce((sum, order) => sum + order.changeIqd, 0),
    shippingDiscountIqd: changedOrders.reduce((sum, order) => sum + order.shippingIqd, 0),
    subtotalOfChangedIqd: changedOrders.reduce((sum, order) => sum + order.subtotalIqd, 0),
    skips,
    orders: [...changedOrders]
      .sort((a, b) => b.changeIqd + b.shippingIqd - (a.changeIqd + a.shippingIqd) || b.placedAt - a.placedAt)
      .slice(0, 50)
      .map(({ cost: _cost, uncosted: _uncosted, ...order }) => order),
  };
  if (withCost) {
    const revenueBefore = changedOrders.reduce((sum, order) => sum + order.subtotalIqd - order.existingDiscountIqd, 0);
    const revenueAfter = revenueBefore - result.discountIqd;
    const uncostedLines = changedOrders.reduce((sum, order) => sum + order.uncosted, 0);
    const costIqd = uncostedLines > 0 ? null : changedOrders.reduce((sum, order) => sum + (order.cost ?? 0), 0);
    const margin = (revenue: number) => (costIqd === null || revenue <= 0 ? null : Math.trunc(((revenue - costIqd) * 10_000) / revenue));
    result.margin = { revenueBeforeIqd: revenueBefore, revenueAfterIqd: revenueAfter, costIqd, marginBeforeBps: margin(revenueBefore), marginAfterBps: margin(revenueAfter), uncostedLines };
  }
  return result;
}

/** Rules for pickers elsewhere (A/B tests). */
export async function ruleChoices(db: Db, actor: Actor, locale: Locale): Promise<{ id: string; name: string }[]> {
  assertAny(actor, SECTION_READ.rules);
  const rows = await db.select({ id: promotions.id, name: promotions.name }).from(promotions).orderBy(desc(promotions.createdAt)).limit(200);
  return rows.map((row) => ({ id: row.id, name: pick(row.name, locale) }));
}
