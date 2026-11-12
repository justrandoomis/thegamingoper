/**
 * Admin module 19 — the rule runner: what the scheduled job does (`runAutomation`), and the planner a dry run shares
 * with it (`planEvent`), so a dry run says exactly what a run would do.
 *
 *   const result = await runAutomation(db, now);   // { status, stats, error } — the shape app/server/jobs.server.ts records
 *
 * One run: the 19.02 stock-out scan (scanStockOuts, as the system), then every ACTIVE rule:
 *   · its events since it was switched on (orders and price changes after the rule's cursor, oldest first; stock and
 *     tickets as they are now), at most RUN_EVENTS_PER_RULE a rule a run — the next run continues;
 *   · an event that meets the conditions runs the rule ONCE: the run's id is derived from the rule and the event's key,
 *     so a second run, two runs at once or a retry never act twice (the insert of the run row meets its primary key);
 *   · the actions, all in the run row's batch with their audit events: a staff task (15.02's table, an active
 *     assignee), a notice (the run row itself, for holders of a permission), a reorder suggestion (19.02, one per SKU
 *     and stock episode), or a review flag on the order through 05.09's `decideReview` — the one action another
 *     module writes: the run row is claimed first ("interrupted" until it is finished), then the flag, then the row.
 *     Never on a held, closed, already flagged or already CLEARED order (a reviewer's decision is not reopened);
 *   · every event's batch (the claim, for a flag) is guarded on the rule being exactly as the run read it — still
 *     active, same version, not paused (`updated_at`): a pause or a new version saved while a run is under way stops
 *     that run at its next event, and the next run continues from there.
 * Nothing here moves stock or money, changes a price or approves anything (19.08). A rule whose stored definition
 * does not read (`broken`) is skipped and counted.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { formatMoney } from "~/lib/money";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { employees, orders, reorderSuggestions, staffTasks, workflowRuns, workflows, type Workflow } from "~/server/db/schema";
import { expectChanged, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { toAppError } from "~/server/errors";
import type { ReorderRow } from "../inventory/analytics.server";
import { decideReview } from "../orders/risk.server";
import { OPEN_STATUSES } from "../orders/types";
import {
  HOUR_MS,
  RUN_EVENTS_PER_RULE,
  changeBpsOf,
  evaluate,
  type ActionLogEntry,
  type AutomationEvent,
  type EventType,
  type OrderFacts,
  type RuleAction,
  type RuleMatch,
  type RunStatus,
  type StockFacts,
  type TicketFacts,
  type PriceFacts,
} from "./catalog";
import { readStored, type StoredRule } from "./definition";
import { collectEvents, usesCursor, type Cursor } from "./events.server";
import { assertWholeStore, runIdFor, runnerActor, stampOf } from "./shared.server";
import { isSuggestionExists, planSuggestion, reorderIndex, scanStockOuts, suggestionStatements, type SuggestionPlan } from "./suggestions.server";

/** A rule as one run (or one dry run) read it; `updatedAt` is what its writes are guarded on. */
export type RuleContext = { id: string; name: string; version: number; updatedAt: number; event: EventType; match: RuleMatch; actions: RuleAction[] };

export function ruleContext(row: Pick<Workflow, "id" | "name" | "updatedAt">, stored: StoredRule): RuleContext {
  return { id: row.id, name: row.name, version: stored.meta.version, updatedAt: row.updatedAt, event: stored.event, match: stored.match, actions: stored.actions };
}

/**
 * The first statements of every write a run makes for one event: the rule must still be active exactly as the run read
 * it (a pause, a new version or a dry run changes `updated_at`), or the batch fails with RULE_CHANGED and nothing of it
 * is written. Setting `last_run_at` is the touch the guard counts.
 */
function ruleUnchanged(db: Db, rule: RuleContext, now: number): BatchStatement[] {
  return [
    db
      .update(workflows)
      .set({ lastRunAt: now })
      .where(and(eq(workflows.id, rule.id), eq(workflows.status, "active"), eq(workflows.updatedAt, rule.updatedAt))),
    expectChanged(db, 1, { code: "RULE_CHANGED", detail: rule.id }),
  ];
}

/** Lookups shared by the events of one run (or one dry run). */
export type PlanCache = { assignees: Map<string, { active: boolean; name: string }>; reorder: Map<string, ReorderRow> | null; suggestionIds: Set<string>; flaggedOrders: Set<string> };
export const newPlanCache = (): PlanCache => ({ assignees: new Map(), reorder: null, suggestionIds: new Set(), flaggedOrders: new Set() });

const OPEN = new Set<string>(OPEN_STATUSES);
const TITLE_MAX = 120;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const iqd = (amount: number) => formatMoney(amount, "IQD", "ar");

/** The event in one Arabic sentence (task titles are stored text, in the store's source language, like 05's packing tasks). */
export function eventSentence(event: AutomationEvent): string {
  switch (event.type) {
    case "order.placed": {
      const f = event.facts as OrderFacts;
      return `طلب جديد ${f.ref} بقيمة ${iqd(f.totalIqd)}`;
    }
    case "stock.below_reorder": {
      const f = event.facts as StockFacts;
      return `مخزون ${f.sku} في ${f.locationCode}: ${f.available} قطعة، وحد إعادة الطلب ${f.reorderPoint}`;
    }
    case "ticket.waiting": {
      const f = event.facts as TicketFacts;
      const hours = Math.max(1, Math.floor((event.at - f.waitingSince) / HOUR_MS));
      return `التذكرة ${f.ref} تنتظر رد الفريق منذ ${hours} ساعة`;
    }
    case "price.changed": {
      const f = event.facts as PriceFacts;
      const bps = changeBpsOf(f.oldPriceIqd, f.newPriceIqd);
      return `تغيّر سعر ${f.sku} من ${f.oldPriceIqd === null ? "—" : iqd(f.oldPriceIqd)} إلى ${iqd(f.newPriceIqd)}${bps === null ? "" : ` (${bps > 0 ? "+" : ""}${(bps / 100).toFixed(1)}٪)`}`;
    }
  }
}

const isDemoEvent = (event: AutomationEvent) => (event.facts as { isDemo: boolean }).isDemo;

/** What the run row keeps about the event (no phone numbers, no cost). */
export function eventSnapshot(rule: RuleContext, event: AutomationEvent) {
  return { key: event.key, type: event.type, at: event.at, label: event.label, version: rule.version, isDemo: isDemoEvent(event), facts: event.facts };
}

/** A run's status from what its actions did. */
export function statusOf(entries: readonly ActionLogEntry[]): RunStatus {
  if (entries.some((entry) => entry.outcome === "failed")) return "failed";
  if (entries.some((entry) => (entry.outcome === "done" || entry.outcome === "would") && (entry.type === "flag_order" || entry.type === "suggest_purchase"))) return "awaiting_approval";
  if (entries.some((entry) => entry.outcome === "done" || entry.outcome === "would")) return "succeeded";
  return "skipped";
}

export type PlannedEvent = {
  entries: ActionLogEntry[];
  statements: BatchStatement[];
  /** 05.09's review flag, asked for after the run row is claimed. */
  flag: { orderId: string; reason: string } | null;
  suggestion: SuggestionPlan | null;
};

async function assigneeOf(db: Db, cache: PlanCache, id: string) {
  if (!cache.assignees.has(id)) {
    const row = await db.select({ status: employees.status, name: employees.name }).from(employees).where(eq(employees.id, id)).get();
    cache.assignees.set(id, { active: row?.status === "active", name: row?.name ?? "" });
  }
  return cache.assignees.get(id)!;
}

/**
 * What each action does for one event that met the conditions: log entries, the statements of the run's batch, and
 * the review flag to ask for. `dry` plans without writing anything (outcomes "would" / "would_skip").
 */
export async function planEvent(db: Db, rule: RuleContext, event: AutomationEvent, cache: PlanCache, now: number, options: { dry: boolean; runId: string }): Promise<PlannedEvent> {
  const actor = runnerActor();
  const entries: ActionLogEntry[] = [];
  const statements: BatchStatement[] = [];
  let flag: PlannedEvent["flag"] = null;
  let suggestion: SuggestionPlan | null = null;
  const done = options.dry ? "would" : "done";
  const skipped = options.dry ? "would_skip" : "skipped";
  const sentence = eventSentence(event);
  const demo = isDemoEvent(event);
  for (const action of rule.actions) {
    switch (action.type) {
      case "staff_task": {
        const assignee = await assigneeOf(db, cache, action.params.assigneeId);
        if (!assignee.active) {
          entries.push({ type: "staff_task", outcome: options.dry ? "would_skip" : "failed", reason: "assignee_inactive", detail: { assigneeId: action.params.assigneeId } });
          break;
        }
        const taskId = `tsk_${options.runId.slice(4)}`;
        const dueAt = action.params.dueHours ? now + action.params.dueHours * HOUR_MS : null;
        entries.push({ type: "staff_task", outcome: done, detail: { taskId: options.dry ? null : taskId, assigneeId: action.params.assigneeId, priority: action.params.priority, dueAt } });
        if (!options.dry) {
          const title = clip(`${demo ? "[تجريبي] " : ""}${sentence}`, TITLE_MAX);
          const description = clip(`أنشأتها قاعدة الأتمتة «${rule.name}» (النسخة ${rule.version}): ${sentence}.${action.params.note ? ` ملاحظة القاعدة: ${action.params.note}` : ""}`, 1000);
          statements.push(
            db.insert(staffTasks).values({ id: taskId, title, description, assignedTo: action.params.assigneeId, priority: action.params.priority, status: "open", dueAt, refType: null, refId: null, createdBy: stampOf(actor), createdAt: now }),
            auditStatement(db, { actor, action: "automation.task.create", entityType: "staff_task", entityId: taskId, summary: `${title} → ${assignee.name}`, after: { ruleId: rule.id, version: rule.version, runId: options.runId, assignedTo: action.params.assigneeId, priority: action.params.priority, dueAt }, at: now }),
          );
        }
        break;
      }
      case "notify":
        entries.push({ type: "notify", outcome: done, detail: { audience: action.params.audience } });
        break;
      case "flag_order": {
        const facts = event.facts as OrderFacts;
        // a dry run reads the order as the event query found it (now); a run reads it again just before flagging
        const current = event.type !== "order.placed" ? undefined : options.dry ? { status: facts.status, reviewStatus: facts.reviewStatus } : await db.select({ status: orders.status, reviewStatus: orders.reviewStatus }).from(orders).where(eq(orders.id, event.refId)).get();
        const status = current?.status ?? facts.status;
        const review = current?.reviewStatus ?? facts.reviewStatus;
        if (event.type !== "order.placed" || !current) entries.push({ type: "flag_order", outcome: skipped, reason: "order_unknown" });
        else if (!OPEN.has(status)) entries.push({ type: "flag_order", outcome: skipped, reason: "order_closed", detail: { orderId: event.refId } });
        else if (review === "blocked") entries.push({ type: "flag_order", outcome: skipped, reason: "order_on_hold", detail: { orderId: event.refId } });
        else if (review === "needs_review" || cache.flaggedOrders.has(event.refId)) entries.push({ type: "flag_order", outcome: skipped, reason: "already_flagged", detail: { orderId: event.refId } });
        // a reviewer already looked at it and cleared it: a rule never reopens that decision (05.09's "flag" would)
        else if (review === "cleared") entries.push({ type: "flag_order", outcome: skipped, reason: "order_reviewed", detail: { orderId: event.refId } });
        else {
          cache.flaggedOrders.add(event.refId);
          entries.push({ type: "flag_order", outcome: done, detail: { orderId: event.refId } });
          flag = { orderId: event.refId, reason: clip(`قاعدة أتمتة «${rule.name}» (النسخة ${rule.version}): ${sentence}`, 500) };
        }
        break;
      }
      case "suggest_purchase": {
        if (event.type !== "stock.below_reorder") {
          entries.push({ type: "suggest_purchase", outcome: skipped, reason: "not_stock" });
          break;
        }
        const facts = event.facts as StockFacts;
        cache.reorder ??= await reorderIndex(db, now);
        const plan = await planSuggestion(db, cache.reorder.get(facts.variantId), rule.id);
        if ("skip" in plan) {
          entries.push({ type: "suggest_purchase", outcome: skipped, reason: plan.skip, detail: { variantId: facts.variantId } });
          break;
        }
        const exists = cache.suggestionIds.has(plan.id) || Boolean(await db.select({ id: reorderSuggestions.id }).from(reorderSuggestions).where(eq(reorderSuggestions.id, plan.id)).get());
        if (exists) {
          entries.push({ type: "suggest_purchase", outcome: skipped, reason: "already_suggested", detail: { suggestionId: plan.id, variantId: facts.variantId } });
          break;
        }
        cache.suggestionIds.add(plan.id);
        entries.push({ type: "suggest_purchase", outcome: done, detail: { suggestionId: plan.id, variantId: facts.variantId, qty: plan.qty } });
        if (!options.dry) {
          suggestion = plan;
          statements.push(...suggestionStatements(db, actor, plan, now, true));
        }
        break;
      }
    }
  }
  return { entries, statements, flag, suggestion };
}

/** "stopped": the rule was paused, saved as a new version or dry-run since the run read it — nothing was written. */
type EventOutcome = "ran" | "exists" | "error" | "stopped";

/** Runs one rule for one event that met its conditions. */
async function runEvent(db: Db, rule: RuleContext, event: AutomationEvent, cache: PlanCache, now: number): Promise<{ outcome: EventOutcome; status?: RunStatus; error?: string }> {
  const actor = runnerActor();
  const runId = await runIdFor(rule.id, event.key);
  for (let attempt = 0; attempt < 2; attempt++) {
    const planned = await planEvent(db, rule, event, cache, now, { dry: false, runId });
    const snapshot = eventSnapshot(rule, event);
    try {
      if (planned.flag) {
        // claim the run first (while the rule is still as read): a second runner meets the primary key and leaves the order alone
        await runBatch(db, [...ruleUnchanged(db, rule, now), db.insert(workflowRuns).values({ id: runId, workflowId: rule.id, refType: event.refType, refId: event.refId, event: snapshot, isDryRun: false, status: "failed", actionsLog: planned.entries, error: "interrupted", startedAt: now })]);
        try {
          await decideReview(db, actor, planned.flag.orderId, { decision: "flag", reason: planned.flag.reason }, now);
        } catch (error) {
          const code = toAppError(error)?.code ?? "unexpected";
          for (const entry of planned.entries) if (entry.type === "flag_order" && entry.outcome === "done") Object.assign(entry, code === "order_on_hold" || code === "review_not_open" ? { outcome: "skipped", reason: code } : { outcome: "failed", reason: code });
        }
        const status = statusOf(planned.entries);
        const error = status === "failed" ? (planned.entries.find((entry) => entry.outcome === "failed")?.reason ?? "failed") : null;
        await runBatch(db, [
          db.update(workflowRuns).set({ status, actionsLog: planned.entries, error, finishedAt: now }).where(eq(workflowRuns.id, runId)),
          ...planned.statements,
          auditStatement(db, { actor, action: "automation.rule.run", entityType: "workflow", entityId: rule.id, summary: `${event.label}: ${status}`, after: { runId, version: rule.version, event: event.key, actions: planned.entries }, at: now }),
        ]);
        return { outcome: "ran", status, error: error ?? undefined };
      }
      const status = statusOf(planned.entries);
      const error = status === "failed" ? (planned.entries.find((entry) => entry.outcome === "failed")?.reason ?? "failed") : null;
      await runBatch(db, [
        ...ruleUnchanged(db, rule, now),
        db.insert(workflowRuns).values({ id: runId, workflowId: rule.id, refType: event.refType, refId: event.refId, event: snapshot, isDryRun: false, status, actionsLog: planned.entries, error, startedAt: now, finishedAt: now }),
        ...planned.statements,
        auditStatement(db, { actor, action: "automation.rule.run", entityType: "workflow", entityId: rule.id, summary: `${event.label}: ${status}`, after: { runId, version: rule.version, event: event.key, actions: planned.entries }, at: now }),
      ]);
      return { outcome: "ran", status, error: error ?? undefined };
    } catch (error) {
      if (isDbError(error, "RULE_CHANGED")) return { outcome: "stopped" };
      if (isUniqueViolation(error, "workflow_runs.id")) return { outcome: "exists" };
      if (isSuggestionExists(error) && attempt === 0) {
        if (planned.suggestion) cache.suggestionIds.add(planned.suggestion.id);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: "error", error: message.slice(0, 300) };
    }
  }
  return { outcome: "error", error: "replan_failed" };
}

/** `stopped`: the rule changed while this run was under way (paused, a new version): the rest waits for the next run. */
export type RuleRunStats = { events: number; matched: number; runs: number; failed: number; skipped: number; errors: string[]; stopped: boolean };

/** One active rule: its new events, the runs, the rule's counters and cursor. */
export async function runRule(db: Db, row: Workflow, now: number, cache: PlanCache = newPlanCache(), limit = RUN_EVENTS_PER_RULE): Promise<RuleRunStats> {
  const stored = readStored(row);
  const stats: RuleRunStats = { events: 0, matched: 0, runs: 0, failed: 0, skipped: 0, errors: [], stopped: false };
  if (stored.broken || row.status !== "active" || !stored.meta.activation) return stats;
  const rule = ruleContext(row, stored);
  const since = stored.meta.activation.at;
  let cursor: Cursor | null = null;
  let events: AutomationEvent[];
  if (usesCursor(rule.event)) {
    const stale = stored.meta.cursor;
    const after = stale && stale.at >= since ? stale : { at: since, id: "" };
    events = await collectEvents(db, rule.event, rule.match, { from: since, to: now, limit, after }, now);
    const last = events[events.length - 1];
    if (last) cursor = { at: last.at, id: last.refId };
  } else {
    events = await collectEvents(db, rule.event, rule.match, { from: since, to: now, limit: 1000, current: true }, now);
  }
  stats.events = events.length;
  const matched = events.filter((event) => evaluate(rule.event, event.facts, rule.match, event.type === "ticket.waiting" ? now : event.at).matched);
  stats.matched = matched.length;
  // state-based events: leave out the ones this rule already ran for
  let todo = matched;
  if (!usesCursor(rule.event) && matched.length) {
    const ids = await Promise.all(matched.map((event) => runIdFor(rule.id, event.key)));
    const seen = new Set<string>();
    for (let at = 0; at < ids.length; at += 90) {
      const found = await db.select({ id: workflowRuns.id }).from(workflowRuns).where(inArray(workflowRuns.id, ids.slice(at, at + 90)));
      for (const item of found) seen.add(item.id);
    }
    todo = matched.filter((_, index) => !seen.has(ids[index])).slice(0, limit);
  }
  for (const event of todo) {
    const result = await runEvent(db, rule, event, cache, now);
    if (result.outcome === "stopped") {
      // paused or saved anew under this run: nothing more for it, and the cursor stays where the rule's state put it
      stats.stopped = true;
      cursor = null;
      break;
    }
    if (result.outcome === "ran") {
      stats.runs++;
      if (result.status === "failed") stats.failed++;
      if (result.status === "skipped") stats.skipped++;
    } else if (result.outcome === "error") {
      stats.errors.push(`${rule.id} ${event.key}: ${result.error}`);
      // a time-based event that could not be written is read again next time: the cursor stops before it
      if (cursor && usesCursor(rule.event)) {
        const index = events.indexOf(event);
        const previous = events[index - 1];
        cursor = previous ? { at: previous.at, id: previous.refId } : stored.meta.cursor && stored.meta.cursor.at >= since ? stored.meta.cursor : { at: since, id: "" };
        break;
      }
    }
  }
  const statements: BatchStatement[] = [];
  if (stats.runs > 0) statements.push(db.update(workflows).set({ runCount: sql`${workflows.runCount} + ${stats.runs}`, lastRunAt: now }).where(eq(workflows.id, row.id)));
  if (cursor) statements.push(db.update(workflows).set({ conditions: sql`json_set(${workflows.conditions}, '$.cursor', json(${JSON.stringify(cursor)}))` }).where(and(eq(workflows.id, row.id), eq(workflows.status, "active"))));
  if (statements.length) await runBatch(db, statements);
  return stats;
}

/** The shape app/server/jobs.server.ts records: "failed" when any rule or the scan failed (the others still ran). */
export type AutomationRunResult = { status: "succeeded" | "skipped" | "failed"; stats: Record<string, number>; error: string | null };

/**
 * The scheduled job (and "run now"): the stock-out scan, then every active rule. Never throws for one rule's failure:
 * the failures are counted and named in `error` (the job's run is then "failed", as jobs.server.ts records it).
 * `triggeredBy` (a person's "run now"): automation.workflow.activate, the whole store, audited.
 */
export async function runAutomation(db: Db, now: number, options: { ruleId?: string; triggeredBy?: Actor; reason?: string | null; scan?: boolean } = {}): Promise<AutomationRunResult> {
  if (options.triggeredBy) {
    assertCan(options.triggeredBy, "automation.workflow.activate");
    assertWholeStore(options.triggeredBy);
  }
  const errors: string[] = [];
  // scanned: the stock-out scan ran to its end (a person's "run now" is the suggestions page's "last checked" then)
  const stats = { rules: 0, events: 0, matched: 0, runs: 0, failedRuns: 0, skippedRuns: 0, stoppedRules: 0, suggestionsCreated: 0, suggestionsReopened: 0, brokenRules: 0, scanned: 0 };
  if (options.scan !== false && !options.ruleId) {
    try {
      const scan = await scanStockOuts(db, runnerActor(), now);
      stats.suggestionsCreated += scan.created;
      stats.suggestionsReopened += scan.reopened;
      stats.scanned = 1;
    } catch (error) {
      errors.push(`scan: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
  }
  const rules = await db
    .select()
    .from(workflows)
    .where(options.ruleId ? and(eq(workflows.id, options.ruleId), eq(workflows.status, "active")) : eq(workflows.status, "active"))
    .orderBy(workflows.createdAt, workflows.id);
  const cache = newPlanCache();
  for (const row of rules) {
    if (readStored(row).broken) {
      stats.brokenRules++;
      continue;
    }
    stats.rules++;
    try {
      const result = await runRule(db, row, now, cache);
      stats.events += result.events;
      stats.matched += result.matched;
      stats.runs += result.runs;
      stats.failedRuns += result.failed;
      stats.skippedRuns += result.skipped;
      if (result.stopped) stats.stoppedRules++;
      errors.push(...result.errors);
    } catch (error) {
      errors.push(`${row.id}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 300));
    }
  }
  if (options.triggeredBy && options.triggeredBy.kind === "employee") {
    await runBatch(db, [auditStatement(db, { actor: options.triggeredBy, action: "automation.rule.run_now", entityType: "workflow", entityId: options.ruleId ?? null, summary: `runs ${stats.runs}`, after: stats, reason: options.reason ?? null, at: now })]);
  }
  const nothing = stats.rules === 0 && stats.suggestionsCreated === 0 && stats.suggestionsReopened === 0 && errors.length === 0;
  return { status: errors.length ? "failed" : nothing ? "skipped" : "succeeded", stats, error: errors.length ? errors.join("; ").slice(0, 2000) : null };
}

