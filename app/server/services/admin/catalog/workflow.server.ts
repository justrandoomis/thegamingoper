/**
 * Admin catalogue — publishing workflow (02.05): draft → review → scheduled → published, hidden, archived.
 *
 *   await changeProductStatus(db, actor, { productId, version, action: "publish" }, now);
 *   await changeProductStatus(db, actor, { productId, version, action: "schedule", publishAt }, now);
 *   await changeProductStatus(db, actor, { productId, version, action: "hide", reason }, now);
 *   const outcome = await bulkChangeStatus(db, actor, { ids, action, reason, publishAt? }, now);
 *   const run = await publishDueProducts(db, now);           // the scheduled job (system actor)
 *
 * Transitions, permissions and which ones need a reason or a complete product: rules.ts `WORKFLOW`. An incomplete
 * product (02.03) can be neither published nor scheduled. "Hide" takes a published product off the storefront
 * (status draft, `published_at` kept, so the admin shows it as hidden and showing it again does not make it new).
 *
 * Scheduled publishing works at read time: the product page and the cart treat a `scheduled` product whose
 * `publish_at` has passed as live. Category lists, search and the menus read `status = 'published'` only, so
 * `publishDueProducts` moves due products to `published` (and puts them in the search index); it must run from the
 * Worker's 5-minute cron (requested from the lead: job "catalog.publish_due"). A product that became incomplete before
 * its time goes back to draft instead of going live.
 *
 * Every transition is one batch: the product row guarded by its version, a version row, an audit event with the
 * reason, and the search rows (added when the product becomes findable, removed when it stops being).
 */
import { and, asc, eq, lte } from "drizzle-orm";
import { z } from "zod";
import { assertCan, systemActor, type Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { products, type Product } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { invalid, isAppError } from "~/server/errors";
import { invalidateNavTaxonomy } from "~/server/services/catalog/taxonomy.server";
import { baselines, catalogError, commitStatements, parseInput, productCompleteness, requireProductState, rethrowCatalog, zId, zReason, zVersion, type ProductState } from "./common.server";
import { MAX_SCHEDULE_AHEAD_MS, WORKFLOW, WORKFLOW_ACTIONS, isWorkflowAction, type WorkflowAction } from "./rules";

/** A schedule must be at least this far ahead (anything sooner is "publish now"). */
export const MIN_SCHEDULE_AHEAD_MS = 60 * 1000;

const zPublishAt = z.preprocess((value) => (value === "" || value === null ? undefined : value), z.coerce.number({ error: "invalid" }).int("invalid").min(0, "invalid").optional());

export const StatusChangeInput = z.object({
  productId: zId,
  version: zVersion,
  action: z.enum(WORKFLOW_ACTIONS, { error: "invalid" }),
  /** Epoch ms (the screen turns the Baghdad wall-clock time into it). Only for "schedule". */
  publishAt: zPublishAt,
  reason: zReason(false),
});

type Decided = { next: Product; reason: string | null };

/** What a transition makes of the product, after checking it is allowed (permission, from-status, inputs). */
async function decide(db: Db, actor: Actor, state: ProductState, action: WorkflowAction, input: { publishAt?: number; reason?: string }, now: number): Promise<Decided> {
  const rule = WORKFLOW[action];
  assertCan(actor, rule.permission);
  const { product } = state;
  if (!(rule.from as readonly string[]).includes(product.status)) throw catalogError("status_not_allowed", 409, { detail: `${product.status}→${action}` });
  const reason = input.reason?.trim() || null;
  if (rule.needsReason && (!reason || reason.length < 3)) throw invalid({ reason: "reason_required" });

  if (rule.needsComplete) {
    const result = await productCompleteness(db, product.id);
    if (!result || !result.completeness.complete) {
      throw catalogError("incomplete", 409, { detail: result ? [...result.completeness.missing, ...result.completeness.missingCustom.map((key) => `custom:${key}`)].join(",") : "" });
    }
  }

  switch (action) {
    case "schedule": {
      const at = input.publishAt;
      if (at === undefined) throw catalogError("schedule_past", 400, { fields: { publishAt: "required" } });
      if (at < now + MIN_SCHEDULE_AHEAD_MS) throw catalogError("schedule_past", 400, { fields: { publishAt: "schedule_past" } });
      if (at > now + MAX_SCHEDULE_AHEAD_MS) throw catalogError("schedule_far", 400, { fields: { publishAt: "schedule_far" } });
      return { next: { ...product, status: "scheduled", publishAt: at }, reason };
    }
    case "publish":
      // Keeps the first publication date (a product shown again is not a new arrival).
      return { next: { ...product, status: "published", publishAt: null, publishedAt: product.publishedAt ?? now }, reason };
    case "submit_review":
      return { next: { ...product, status: "review" }, reason };
    case "return_draft":
    case "unschedule":
    case "hide":
    case "unarchive":
      return { next: { ...product, status: "draft", publishAt: null }, reason };
    case "archive":
      return { next: { ...product, status: "archived", publishAt: null }, reason };
  }
}

export async function changeProductStatus(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ version: number; status: Product["status"] }> {
  // The move's permission first — before the fields are validated or the product read: a role without it gets
  // "forbidden", never field errors or "product_changed". (An unknown move has no permission to check: invalid.)
  const wanted = typeof raw === "object" && raw !== null ? (raw as { action?: unknown }).action : undefined;
  if (isWorkflowAction(wanted)) assertCan(actor, WORKFLOW[wanted].permission);
  const input = parseInput(StatusChangeInput, raw);
  assertCan(actor, WORKFLOW[input.action].permission);
  const state = await requireProductState(db, input.productId);
  if (state.product.version !== input.version) throw catalogError("product_changed");
  const decided = await decide(db, actor, state, input.action, { publishAt: input.publishAt, reason: input.reason }, now);
  const hasBaseline = (await baselines(db, [state.product])).has(state.product.id);
  const plan = commitStatements(db, {
    actor,
    now,
    before: state,
    after: { product: decided.next, variants: state.variants },
    action: `catalog.product.${input.action}`,
    reason: decided.reason,
    summary: `${state.product.slug}: ${state.product.status} → ${decided.next.status}`,
    hasBaseline,
  });
  await runBatch(db, [...plan.statements, ...plan.search]).catch(rethrowCatalog);
  invalidateNavTaxonomy(db);
  return { version: plan.version, status: decided.next.status };
}

// ───────────────────────────────────────────────────────────────── bulk

export const BulkStatusInput = z.object({
  ids: z.array(zId).min(1, "required").max(100, "too_big"),
  action: z.enum(WORKFLOW_ACTIONS, { error: "invalid" }),
  publishAt: zPublishAt,
  reason: zReason(false),
});

export type BulkStatusOutcome = { changed: string[]; skipped: { id: string; reason: string }[] };

/** The same transition on many products; each one is checked on its own and skipped with its reason when refused. */
export async function bulkChangeStatus(db: Db, actor: Actor, raw: unknown, now: number): Promise<BulkStatusOutcome> {
  const wanted = typeof raw === "object" && raw !== null ? (raw as { action?: unknown }).action : undefined;
  if (isWorkflowAction(wanted)) assertCan(actor, WORKFLOW[wanted].permission);
  const input = parseInput(BulkStatusInput, raw);
  assertCan(actor, WORKFLOW[input.action].permission);
  if (WORKFLOW[input.action].needsReason && (!input.reason || input.reason.length < 3)) throw invalid({ reason: "reason_required" });
  const outcome: BulkStatusOutcome = { changed: [], skipped: [] };
  for (const id of [...new Set(input.ids)]) {
    const state = await requireProductState(db, id).catch(() => null);
    if (!state) {
      outcome.skipped.push({ id, reason: "not_found" });
      continue;
    }
    try {
      const decided = await decide(db, actor, state, input.action, { publishAt: input.publishAt, reason: input.reason }, now);
      const hasBaseline = (await baselines(db, [state.product])).has(id);
      const plan = commitStatements(db, {
        actor,
        now,
        before: state,
        after: { product: decided.next, variants: state.variants },
        action: `catalog.product.${input.action}`,
        reason: decided.reason,
        summary: `${state.product.slug}: ${state.product.status} → ${decided.next.status} (bulk)`,
        hasBaseline,
      });
      await runBatch(db, [...plan.statements, ...plan.search]).catch(rethrowCatalog);
      outcome.changed.push(id);
    } catch (error) {
      if (!isAppError(error)) throw error;
      outcome.skipped.push({ id, reason: error.code });
    }
  }
  if (outcome.changed.length > 0) invalidateNavTaxonomy(db);
  return outcome;
}

// ───────────────────────────────────────────────────────────────── the scheduled job

export const PUBLISH_DUE_JOB = "catalog.publish_due";
/** Products handled per run (the next run takes the rest). */
const DUE_PER_RUN = 50;

export type PublishDueRun = { published: string[]; returnedToDraft: string[]; conflicts: string[] };

/**
 * Moves scheduled products whose time has come to `published` (status, search index, version row, audit by the
 * system actor). Safe to run twice at once: each product is guarded by its version, the loser counts a conflict.
 */
export async function publishDueProducts(db: Db, now: number): Promise<PublishDueRun> {
  const actor = systemActor(PUBLISH_DUE_JOB);
  const due = await db
    .select({ id: products.id })
    .from(products)
    .where(and(eq(products.status, "scheduled"), lte(products.publishAt, now)))
    .orderBy(asc(products.publishAt), asc(products.id))
    .limit(DUE_PER_RUN);
  const run: PublishDueRun = { published: [], returnedToDraft: [], conflicts: [] };
  for (const { id } of due) {
    const state = await requireProductState(db, id).catch(() => null);
    if (!state || state.product.status !== "scheduled" || state.product.publishAt === null || state.product.publishAt > now) continue;
    const result = await productCompleteness(db, id);
    const complete = result?.completeness.complete ?? false;
    const publishAt = state.product.publishAt;
    const next: Product = complete
      ? { ...state.product, status: "published", publishAt: null, publishedAt: state.product.publishedAt ?? publishAt }
      : { ...state.product, status: "draft", publishAt: null };
    const hasBaseline = (await baselines(db, [state.product])).has(id);
    const plan = commitStatements(db, {
      actor,
      now,
      before: state,
      after: { product: next, variants: state.variants },
      action: complete ? "catalog.product.publish_due" : "catalog.product.publish_blocked",
      reason: complete ? null : `incomplete: ${result ? [...result.completeness.missing, ...result.completeness.missingCustom].join(",") : "unknown"}`,
      summary: `${state.product.slug}: scheduled → ${next.status}`,
      hasBaseline,
    });
    try {
      await runBatch(db, [...plan.statements, ...plan.search]).catch(rethrowCatalog);
      (complete ? run.published : run.returnedToDraft).push(id);
    } catch (error) {
      if (isAppError(error, "product_changed")) run.conflicts.push(id);
      else throw error;
    }
  }
  if (run.published.length > 0 || run.returnedToDraft.length > 0) invalidateNavTaxonomy(db);
  return run;
}
