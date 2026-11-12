/**
 * Admin 08.08 — A/B tests of offers, only once a measurement rule is written down: the primary metric, the minimum
 * number of orders per variant and the planned end are fixed BEFORE the test starts (the decision rule), and the
 * results are read from real orders — no invented statistics.
 *
 *   listExperiments(db, actor) · getExperiment(db, actor, experimentId, now, { includeDemo })
 *   saveExperiment(db, actor, { experimentId?, key, name, description?, variants: [{ key, couponId }], metric?, minOrders?, plannedEnd?, idempotencyKey? }, now)
 *   startExperiment · pauseExperiment · resumeExperiment(db, actor, { experimentId, reason }, now)
 *   completeExperiment(db, actor, { experimentId, winner | null, reason }, now)   a winner only when the rule can be read
 *
 * What is measurable today: each variant is a coupon (08.01) handed to a different group (by a campaign, at the
 * counter…); its orders, net revenue (paid − refunded), average order, discount per order and refund rate come from
 * the orders that used that coupon while the test ran (cancelled orders and demo orders left out). Visitors are not
 * assigned or counted by the storefront (`experiment_assignments` / `experiment_events` have no writer), so
 * conversion rates are NOT measured and no significance is computed: the page says so. The leader is named only when
 * every variant reached its minimum, and labelled as a reading, not a proof (rules.ts experimentDecision).
 *
 * `experiments` has no column for the minimum sample: it is kept on each variant (`config.minOrders`, the same number
 * on all of them); the planned end is `ends_at` until the test completes (then the real end).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { coupons, experimentEvents, experiments, type Experiment, type ExperimentVariant } from "~/server/db/schema";
import { expectChanged, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, invalid, notFound, zodFieldErrors } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { couponStateOf, experimentDecision } from "./rules";
import { ID, KEY, SECTION_READ, assertAny, historyOf, idFromKey, num } from "./shared.server";
import { EXPERIMENT, EXPERIMENT_METRICS, endOfBaghdadDay, parseWhole, type ExperimentDetail, type ExperimentMetric, type ExperimentRow, type ExperimentStatus, type ExperimentVariantView, type VariantResult } from "./types";

const AREA = "promotion";

function guard(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "EXPERIMENT_CHANGED") throw new AppError("experiment_changed", 409);
  if (info?.kind === "unique" && info.table === "experiments") throw invalid({ key: "key_taken" });
  throw error;
}

const metricOf = (value: string): ExperimentMetric | null => ((EXPERIMENT_METRICS as readonly string[]).includes(value) ? (value as ExperimentMetric) : null);

function variantsView(row: Experiment): (ExperimentVariantView & { minOrders: number | null })[] {
  return (row.variants ?? []).map((variant) => {
    const config = (variant.config ?? {}) as { couponId?: unknown; minOrders?: unknown };
    return { key: variant.key, couponId: typeof config.couponId === "string" ? config.couponId : null, couponCode: null, weight: variant.weight, minOrders: typeof config.minOrders === "number" ? config.minOrders : null };
  });
}

/** What still stops a draft from starting (empty = it may start). */
export function measurementProblems(input: { metric: ExperimentMetric | null; minOrders: number | null; plannedEnd: number | null; variants: { key: string; couponId: string | null; couponState?: string | null }[] }, now: number): string[] {
  const problems: string[] = [];
  if (!input.metric) problems.push("metric_missing");
  if (input.minOrders === null || input.minOrders < EXPERIMENT.minSampleFloor) problems.push("sample_missing");
  if (input.plannedEnd === null) problems.push("end_missing");
  else if (input.plannedEnd <= now) problems.push("end_past");
  if (input.variants.length < 2) problems.push("variants_missing");
  if (input.variants.some((variant) => !variant.couponId)) problems.push("variant_without_offer");
  if (new Set(input.variants.map((variant) => variant.couponId)).size !== input.variants.length) problems.push("offers_repeat");
  if (input.variants.some((variant) => variant.couponState && variant.couponState !== "live" && variant.couponState !== "scheduled")) problems.push("offer_not_live");
  return problems;
}

async function couponFacts(db: Db, ids: readonly string[], now: number): Promise<Map<string, { code: string; state: string }>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db
    .select({ id: coupons.id, code: coupons.code, isActive: coupons.isActive, startsAt: coupons.startsAt, endsAt: coupons.endsAt, usageLimit: coupons.usageLimit, used: sql<number>`(SELECT count(*) FROM coupon_redemptions AS r WHERE r.coupon_id = ${coupons.id} AND r.voided_at IS NULL)` })
    .from(coupons)
    .where(inArray(coupons.id, unique));
  return new Map(rows.map((row) => [row.id, { code: row.code, state: couponStateOf(row, num(row.used), false, now) }]));
}

// ───────────────────────────────────────────────────────────────── reads

export async function listExperiments(db: Db, actor: Actor): Promise<ExperimentRow[]> {
  assertAny(actor, SECTION_READ.experiments);
  const rows = await db.select().from(experiments).where(eq(experiments.area, AREA)).orderBy(desc(experiments.createdAt)).limit(200);
  return rows.map((row) => ({ id: row.id, key: row.key, name: row.name, status: row.status, primaryMetric: row.primaryMetric, variants: (row.variants ?? []).length, startsAt: row.startsAt, endsAt: row.endsAt, winner: row.winnerVariant }));
}

async function results(db: Db, row: Experiment, variants: ExperimentVariantView[], now: number, includeDemo: boolean): Promise<VariantResult[]> {
  if (!row.startsAt) return variants.map((variant) => ({ key: variant.key, couponCode: variant.couponCode, orders: 0, netRevenueIqd: 0, avgOrderIqd: null, discountPerOrderIqd: null, refundRateBps: null, discountIqd: 0, refundedOrders: 0 }));
  const until = row.status === "completed" && row.endsAt ? row.endsAt : now;
  const out: VariantResult[] = [];
  for (const variant of variants) {
    if (!variant.couponId) {
      out.push({ key: variant.key, couponCode: null, orders: 0, netRevenueIqd: 0, avgOrderIqd: null, discountPerOrderIqd: null, refundRateBps: null, discountIqd: 0, refundedOrders: 0 });
      continue;
    }
    const facts = await db.all<{ n: number; net: number; total: number; discount: number; refunded: number }>(sql`SELECT count(*) AS n, coalesce(sum(o.paid_iqd - o.refunded_iqd), 0) AS net, coalesce(sum(o.total_iqd), 0) AS total,
        coalesce(sum(o.discount_iqd), 0) AS discount, coalesce(sum(CASE WHEN o.refunded_iqd > 0 THEN 1 ELSE 0 END), 0) AS refunded
      FROM orders AS o WHERE o.coupon_id = ${variant.couponId} AND o.status <> 'cancelled' AND o.placed_at >= ${row.startsAt} AND o.placed_at < ${until}${includeDemo ? sql`` : sql` AND o.is_demo = 0`}`);
    const n = num(facts[0]?.n);
    out.push({
      key: variant.key,
      couponCode: variant.couponCode,
      orders: n,
      netRevenueIqd: num(facts[0]?.net),
      avgOrderIqd: n > 0 ? Math.round(num(facts[0]?.total) / n) : null,
      discountPerOrderIqd: n > 0 ? Math.round(num(facts[0]?.discount) / n) : null,
      refundRateBps: n > 0 ? Math.round((num(facts[0]?.refunded) * 10_000) / n) : null,
      discountIqd: num(facts[0]?.discount),
      refundedOrders: num(facts[0]?.refunded),
    });
  }
  return out;
}

export async function getExperiment(db: Db, actor: Actor, experimentId: string, now: number, options: { includeDemo: boolean }): Promise<ExperimentDetail> {
  assertAny(actor, SECTION_READ.experiments);
  if (!ID.test(experimentId)) throw notFound("experiment");
  const row = await db.select().from(experiments).where(and(eq(experiments.id, experimentId), eq(experiments.area, AREA))).get();
  if (!row) throw notFound("experiment");
  const raw = variantsView(row);
  const facts = await couponFacts(db, raw.map((variant) => variant.couponId ?? ""), now);
  const variants = raw.map(({ minOrders: _min, ...variant }) => ({ ...variant, couponCode: variant.couponId ? (facts.get(variant.couponId)?.code ?? null) : null }));
  const metric = metricOf(row.primaryMetric);
  const minSample = raw[0]?.minOrders ?? null;
  const plannedEnd = row.status === "completed" ? null : row.endsAt;
  const [measured, events, history] = await Promise.all([results(db, row, variants, now, options.includeDemo), db.select({ n: sql<number>`count(*)` }).from(experimentEvents).where(eq(experimentEvents.experimentId, row.id)).get(), historyOf(db, "experiment", row.id)]);
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    status: row.status,
    variants,
    primaryMetric: metric,
    minSample,
    plannedEnd,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    winner: row.winnerVariant,
    results: measured,
    decision: experimentDecision(measured, metric, minSample),
    problems: row.status === "draft" ? measurementProblems({ metric, minOrders: minSample, plannedEnd, variants: raw.map((variant) => ({ key: variant.key, couponId: variant.couponId, couponState: variant.couponId ? (facts.get(variant.couponId)?.state ?? "off") : null })) }, now) : [],
    visitorEvents: num(events?.n),
    includeDemo: options.includeDemo,
    history,
    can: { manage: can(actor, "promotions.experiment.manage") },
  };
}

// ───────────────────────────────────────────────────────────────── writes

const many = (value: unknown) => (value === undefined || value === null || value === "" ? [] : Array.isArray(value) ? value : [value]);

export const ExperimentInput = z
  .object({
    experimentId: z.string().regex(ID, "invalid").optional(),
    idempotencyKey: z.string().regex(KEY, "invalid").optional(),
    key: z.preprocess((value) => (typeof value === "string" ? value.trim().toLowerCase() : value), z.string({ error: "required" }).regex(/^[a-z][a-z0-9_-]{2,39}$/, "key_invalid")),
    name: z.string({ error: "required" }).overwrite(cleanLine).trim().min(3, "required").max(120, "too_long"),
    description: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string().overwrite(cleanBlock).trim().max(600, "too_long")),
    couponIds: z.preprocess(many, z.array(z.string()).max(EXPERIMENT.maxVariants, "too_many")),
    metric: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
    minOrders: z.preprocess((value) => (value === "" || value === null || value === undefined ? null : parseWhole(value) ?? Number.NaN), z.number({ error: "number_invalid" }).int("number_invalid").min(EXPERIMENT.minSampleFloor, "too_small").max(EXPERIMENT.minSampleCap, "too_big").nullable()),
    plannedEnd: z.preprocess((value) => (typeof value === "string" ? value : ""), z.string()),
  })
  .superRefine((input, ctx) => {
    if (input.metric && !metricOf(input.metric)) ctx.addIssue({ code: "custom", path: ["metric"], message: "invalid" });
    if (input.plannedEnd && endOfBaghdadDay(input.plannedEnd) === null) ctx.addIssue({ code: "custom", path: ["plannedEnd"], message: "date_invalid" });
    if (!input.experimentId && !input.idempotencyKey) ctx.addIssue({ code: "custom", path: ["idempotencyKey"], message: "required" });
    const filled = input.couponIds.filter((id) => id !== "");
    if (filled.some((id) => !ID.test(id))) ctx.addIssue({ code: "custom", path: ["couponIds"], message: "invalid" });
    if (new Set(filled).size !== filled.length) ctx.addIssue({ code: "custom", path: ["couponIds"], message: "offers_repeat" });
  });

/** Creates or edits a draft (the measurement rule may be written now or later, but before it starts). */
export async function saveExperiment(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ experimentId: string; created: boolean; replayed?: boolean }> {
  assertCan(actor, "promotions.experiment.manage");
  const parsed = ExperimentInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "experiment.save");
  const input = parsed.data;
  const couponIds = input.couponIds.filter((id) => id !== "");
  if (couponIds.length) {
    const found = await db.select({ id: coupons.id }).from(coupons).where(inArray(coupons.id, couponIds));
    if (found.length !== couponIds.length) throw invalid({ couponIds: "unknown_option" });
  }
  const plannedEnd = input.plannedEnd ? endOfBaghdadDay(input.plannedEnd) : null;
  if (plannedEnd !== null && plannedEnd <= now) throw invalid({ plannedEnd: "end_past" });
  if (plannedEnd !== null && plannedEnd > now + EXPERIMENT.maxDays * 86_400_000) throw invalid({ plannedEnd: "too_far" });
  const variants: ExperimentVariant[] = couponIds.map((couponId, index) => ({ key: String.fromCharCode(65 + index), weight: 1, config: { couponId, ...(input.minOrders !== null ? { minOrders: input.minOrders } : {}) } }));
  const fields = { key: input.key, name: input.name, description: input.description || null, variants, primaryMetric: metricOf(input.metric) ?? "", endsAt: plannedEnd };
  if (!input.experimentId) {
    const experimentId = await idFromKey("exp", actor, input.idempotencyKey as string);
    if (await db.select({ id: experiments.id }).from(experiments).where(eq(experiments.id, experimentId)).get()) return { experimentId, created: false, replayed: true };
    await runBatch(db, [
      db.insert(experiments).values({ id: experimentId, ...fields, area: AREA, status: "draft", startsAt: null, createdBy: actor.kind === "employee" ? actor.id : null, createdAt: now }),
      auditStatement(db, { actor, action: "promotions.experiment.create", entityType: "experiment", entityId: experimentId, summary: input.key, after: fields, at: now }),
    ]).catch(guard);
    return { experimentId, created: true };
  }
  const row = await db.select().from(experiments).where(and(eq(experiments.id, input.experimentId), eq(experiments.area, AREA))).get();
  if (!row) throw notFound("experiment");
  if (row.status !== "draft") throw new AppError("experiment_not_draft", 409);
  await runBatch(db, [
    db
      .update(experiments)
      .set(fields)
      .where(and(eq(experiments.id, row.id), eq(experiments.status, "draft"))),
    expectChanged(db, 1, { code: "EXPERIMENT_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: "promotions.experiment.update", entityType: "experiment", entityId: row.id, summary: input.key, before: { variants: row.variants, primaryMetric: row.primaryMetric, endsAt: row.endsAt }, after: fields, at: now }),
  ]).catch(guard);
  return { experimentId: row.id, created: false };
}

const ReasonInput = z.object({ experimentId: z.string().regex(ID, "invalid"), reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long") });

async function move(db: Db, actor: Actor, raw: unknown, now: number, from: ExperimentStatus[], to: ExperimentStatus, extra: Partial<Experiment> = {}, check?: (row: Experiment) => Promise<void>) {
  assertCan(actor, "promotions.experiment.manage");
  const parsed = ReasonInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "experiment.move");
  const row = await db.select().from(experiments).where(and(eq(experiments.id, parsed.data.experimentId), eq(experiments.area, AREA))).get();
  if (!row) throw notFound("experiment");
  if (!from.includes(row.status)) throw new AppError(row.status === "draft" ? "experiment_not_running" : to === "running" && row.status !== "paused" ? "experiment_not_draft" : "experiment_not_running", 409);
  if (check) await check(row);
  await runBatch(db, [
    db
      .update(experiments)
      .set({ status: to, ...extra })
      .where(and(eq(experiments.id, row.id), eq(experiments.status, row.status))),
    expectChanged(db, 1, { code: "EXPERIMENT_CHANGED", detail: row.id }),
    auditStatement(db, { actor, action: `promotions.experiment.${to === "running" ? (row.status === "paused" ? "resume" : "start") : to === "paused" ? "pause" : "complete"}`, entityType: "experiment", entityId: row.id, summary: row.key, before: { status: row.status }, after: { status: to, ...extra }, reason: parsed.data.reason, at: now }),
  ]).catch(guard);
  return row;
}

/** Starts a draft — only with its measurement rule written down and its offers live. */
export async function startExperiment(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ started: boolean }> {
  await move(db, actor, raw, now, ["draft"], "running", { startsAt: now }, async (row) => {
    const variants = variantsView(row);
    const facts = await couponFacts(db, variants.map((variant) => variant.couponId ?? ""), now);
    const problems = measurementProblems({ metric: metricOf(row.primaryMetric), minOrders: variants[0]?.minOrders ?? null, plannedEnd: row.endsAt, variants: variants.map((variant) => ({ key: variant.key, couponId: variant.couponId, couponState: variant.couponId ? (facts.get(variant.couponId)?.state ?? "off") : null })) }, now);
    if (problems.length) throw new AppError("experiment_rule_missing", 409, { detail: problems.join(",") });
  });
  return { started: true };
}

export async function pauseExperiment(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ paused: boolean }> {
  await move(db, actor, raw, now, ["running"], "paused");
  return { paused: true };
}

export async function resumeExperiment(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ resumed: boolean }> {
  await move(db, actor, raw, now, ["paused"], "running");
  return { resumed: true };
}

export const CompleteInput = z.object({ experimentId: z.string().regex(ID, "invalid"), winner: z.preprocess((value) => (value === "" || value === undefined ? null : value), z.string().regex(/^[A-Z]$/, "invalid").nullable()), reason: z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long") });

/** Ends a test. A winner may be named only when the decision rule can be read and it is the leader. */
export async function completeExperiment(db: Db, actor: Actor, raw: unknown, now: number, options: { includeDemo?: boolean } = {}): Promise<{ winner: string | null }> {
  assertCan(actor, "promotions.experiment.manage");
  const parsed = CompleteInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "experiment.complete");
  const input = parsed.data;
  if (input.winner) {
    const detail = await getExperiment(db, actor, input.experimentId, now, { includeDemo: options.includeDemo ?? false });
    if (!detail.decision.ready || detail.decision.leader !== input.winner) throw new AppError("experiment_not_decidable", 409);
  }
  await move(db, actor, { experimentId: input.experimentId, reason: input.reason }, now, ["running", "paused"], "completed", { endsAt: now, winnerVariant: input.winner });
  return { winner: input.winner };
}
