/**
 * Admin 19.01 / 19.07 — automation rules: list, builder, versions, dry run, switching on and off.
 *
 *   await saveRule(db, actor, { definition: ruleRawFromForm(form), idempotencyKey }, now);        // a new draft (v1)
 *   await saveRule(db, actor, { ruleId, expectedUpdatedAt, definition, reason }, now);           // a new version → draft
 *   await dryRunRule(db, actor, { ruleId, days: 30, expectedUpdatedAt }, now);                   // what it would have done
 *   await activateRule(db, actor, { ruleId, expectedUpdatedAt, reason }, now);                   // another person, ≤ 7 days
 *   await pauseRule(db, actor, { ruleId, expectedUpdatedAt, reason }, now);
 *
 * RULES
 *   · Permissions: read automation.workflow.read; write automation.workflow.manage; dry run manage or activate; switch
 *     on (and resume) automation.workflow.activate; pause manage or activate. Rules act on the whole store, so a
 *     branch-limited employee reads them but changes nothing (branch_limited, 403). Checked before the input is read.
 *   · Every saved change is a NEW VERSION (+1) of the same rule, stored with who saved it, and goes back to "draft": an
 *     active rule that is edited stops until its new version passes a dry run and is switched on again. Each version's
 *     full definition is the `after` of its audit event (`automation.rule.create` / `.save`), with the reason.
 *   · 19.07: a rule is switched on only after a dry run of its CURRENT version that is at most DRY_RUN_FRESH_MS old,
 *     and never by the person who saved that version (author_cannot_activate, 403) — four eyes on what automation
 *     will do. The dry run reads the last 7 / 30 / 90 days (stock: as it is now), runs the same planner as a real run
 *     without writing anything but its own summary and up to DRY_RUN_SAMPLES sample rows (`is_dry_run`), replacing the
 *     rule's previous samples.
 *   · Every change is one batch guarded on the row's `updated_at` (rule_changed, 409) with its audit event; creating
 *     is idempotent on the form's key.
 * Errors: forbidden (403), branch_limited (403), author_cannot_activate (403), invalid (400), not_found (404),
 * rule_changed, dry_run_required, dry_run_stale, rule_not_activatable, rule_not_active, rule_not_paused (409).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { employees, governorates, workflowRuns, workflows, type Workflow } from "~/server/db/schema";
import { chunkRows, expectChanged, isDbError, isUniqueViolation, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound } from "~/server/errors";
import { locationOptions, locationTree } from "../inventory/shared.server";
import {
  DAY_MS,
  DRY_RUN_FRESH_MS,
  DRY_RUN_MAX_EVENTS,
  DRY_RUN_SAMPLES,
  DRY_RUN_WINDOWS,
  LIMITS,
  RULE_STATUSES,
  evaluate,
  parseWhole,
  type ActionType,
  type OrderMatch,
  type RuleStatus,
  type StockMatch,
} from "./catalog";
import { cleanLine, definitionSnapshot, parseDefinition, readStored, type RuleRaw, type StoredConditions } from "./definition";
import { collectEvents } from "./events.server";
import { runsOfRule } from "./log.server";
import { eventSnapshot, newPlanCache, planEvent, ruleContext, statusOf } from "./runner.server";
import { assertWholeStore, branchLimited, dryRunIdFor, employeeNames, idFromKey, personOf, stampOf } from "./shared.server";
import { PAGE_SIZE, type DryRunSummary, type RuleDetail, type RuleFilters, type RuleFormOptions, type RulePage, type RuleRow, type RuleVersion } from "./types";

const num = (value: unknown) => Number(value ?? 0);
const RULE_ID = /^wfl_[a-z0-9]{10,40}$/;

const parseL10n = (value: unknown): L10n => {
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as L10n;
    } catch {
      return { ar: value };
    }
  }
  return (value ?? { ar: "" }) as L10n;
};

function reasonOf(raw: unknown, required: boolean): string | null {
  const value = cleanLine(typeof raw === "string" ? raw : "");
  if (value.length > LIMITS.reason) throw invalid({ reason: "too_long" });
  if (required && value.length < 3) throw invalid({ reason: value === "" ? "reason_required" : "too_short" });
  return value === "" ? null : value;
}

async function ruleRow(db: Db, ruleId: unknown): Promise<Workflow> {
  if (typeof ruleId !== "string" || !RULE_ID.test(ruleId)) throw notFound("workflow");
  const row = await db.select().from(workflows).where(eq(workflows.id, ruleId)).get();
  if (!row) throw notFound("workflow");
  return row;
}

function expectedOf(raw: unknown): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw invalid({ expectedUpdatedAt: "required" });
  return value;
}

const dryRunFresh = (meta: StoredConditions, now: number) => meta.dryRun !== null && meta.dryRun.version === meta.version && now - meta.dryRun.at <= DRY_RUN_FRESH_MS;

/** Why this actor cannot switch the rule on now (null: they can). */
export function activationBlock(actor: Actor, meta: StoredConditions, now: number): RuleDetail["can"]["activateBlocked"] {
  if (branchLimited(actor)) return "branch_limited";
  if (!meta.dryRun || meta.dryRun.version !== meta.version) return "dry_run_required";
  if (now - meta.dryRun.at > DRY_RUN_FRESH_MS) return "dry_run_stale";
  if (meta.author.id !== null && meta.author.id === stampOf(actor)) return "author_cannot_activate";
  return null;
}

const mayActivate = (actor: Actor) => can(actor, "automation.workflow.activate") && !branchLimited(actor);

/**
 * The rules this actor may switch on right now — a fresh dry run of the current version that they did not write, the
 * definition readable — out of `rows` (rules waiting with a dry run). The ONE answer behind the bell's and the front
 * page's count and the list they open (`?ready=1`).
 */
function activatableBy(actor: Actor, rows: readonly Workflow[], now: number): Workflow[] {
  if (!mayActivate(actor)) return [];
  return rows.filter((row) => {
    if (row.status !== "dry_run") return false;
    const stored = readStored(row);
    return !stored.broken && activationBlock(actor, stored.meta, now) === null;
  });
}

// ───────────────────────────────────────────────────────────────── the list

export async function listRules(db: Db, actor: Actor, filters: RuleFilters, now: number): Promise<RulePage> {
  assertCan(actor, "automation.workflow.read");
  const like = filters.q ? `%${filters.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const base = sql.join(
    [sql`1 = 1`, filters.event ? sql`trigger_event = ${filters.event}` : null, like ? sql`name LIKE ${like} ESCAPE '\\'` : null].filter((part): part is ReturnType<typeof sql> => part !== null),
    sql` AND `,
  );
  const where = filters.status ? sql`${base} AND status = ${filters.status}` : base;
  const offset = (filters.page - 1) * PAGE_SIZE;
  const [listed, counts, waiting] = await Promise.all([
    filters.ready
      ? Promise.resolve([] as Workflow[])
      : db
          .select()
          .from(workflows)
          .where(where)
          .orderBy(sql`CASE ${workflows.status} WHEN 'active' THEN 0 WHEN 'dry_run' THEN 1 WHEN 'paused' THEN 2 ELSE 3 END`, sql`${workflows.updatedAt} DESC`, workflows.id)
          .limit(PAGE_SIZE)
          .offset(offset),
    db.all<{ status: string; n: number }>(sql`SELECT status, count(*) AS n FROM workflows WHERE ${base} GROUP BY status`),
    mayActivate(actor) ? db.select().from(workflows).where(sql`${base} AND status = 'dry_run'`).orderBy(sql`${workflows.updatedAt} DESC`, workflows.id) : Promise.resolve([] as Workflow[]),
  ]);
  const ready = activatableBy(actor, waiting, now);
  const rows = filters.ready ? ready.slice(offset, offset + PAGE_SIZE) : listed;
  const parsed = rows.map((row) => ({ row, stored: readStored(row) }));
  const names = await employeeNames(db, parsed.map(({ stored }) => stored.meta.author.id));
  const byStatus = new Map(counts.map((row) => [row.status, num(row.n)]));
  const all = [...byStatus.values()].reduce((sum, n) => sum + n, 0);
  const countsOut = Object.fromEntries([...RULE_STATUSES.map((status) => [status, byStatus.get(status) ?? 0]), ["all", all]]) as RulePage["counts"];
  const total = filters.ready ? ready.length : filters.status ? (byStatus.get(filters.status) ?? 0) : all;
  return {
    readyCount: mayActivate(actor) ? ready.length : null,
    rows: parsed.map(({ row, stored }): RuleRow => ({
      id: row.id,
      name: row.name,
      event: stored.event,
      status: row.status as RuleStatus,
      version: stored.meta.version,
      demo: stored.meta.demo,
      actions: stored.actions.map((action) => action.type),
      runCount: num(row.runCount),
      lastRunAt: row.lastRunAt === null ? null : num(row.lastRunAt),
      updatedAt: num(row.updatedAt),
      author: personOf(names, stored.meta.author.id),
      dryRunReady: dryRunFresh(stored.meta, now),
    })),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
    counts: countsOut,
  };
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────── the builder's choices

/** Who a task may go to, which governorate or location a condition may name (automation.workflow.manage). */
export async function ruleFormOptions(db: Db, actor: Actor, locale: Locale): Promise<RuleFormOptions> {
  assertCan(actor, "automation.workflow.manage");
  const [people, places, tree] = await Promise.all([
    db.select({ id: employees.id, name: employees.name, isDemo: employees.isDemo }).from(employees).where(eq(employees.status, "active")).orderBy(employees.name),
    db.select({ id: governorates.id, name: governorates.name, sort: governorates.sort }).from(governorates).orderBy(governorates.sort),
    locationTree(db),
  ]);
  return {
    employees: people.map((person) => ({ value: person.id, label: person.name })),
    governorates: places.map((place) => ({ value: place.id, label: pick(parseL10n(place.name), locale) })),
    locations: locationOptions(tree)
      .filter((option) => option.isSellable)
      .map((option) => ({ value: option.value, label: option.label })),
  };
}

// ───────────────────────────────────────────────────────────────── one rule

async function versionsOf(db: Db, ruleId: string): Promise<RuleVersion[]> {
  const rows = await db.all<{ at: number; actorKind: string; actorId: string | null; reason: string | null; after: string | null }>(sql`
    SELECT at, actor_kind AS actorKind, actor_id AS actorId, reason, after FROM audit_events
    WHERE entity_type = 'workflow' AND entity_id = ${ruleId} AND action IN ('automation.rule.create', 'automation.rule.save') ORDER BY seq DESC LIMIT 50`);
  const names = await employeeNames(db, rows.map((row) => row.actorId));
  return rows.map((row) => {
    const after = parseJson(row.after) as RuleVersion["definition"] & { version?: number } | null;
    return { version: Number(after?.version ?? 0), at: num(row.at), by: row.actorKind === "employee" ? personOf(names, row.actorId) : row.actorKind === "system" ? { system: row.actorId ?? "system" } : null, reason: row.reason, definition: after ?? null };
  });
}

export async function getRule(db: Db, actor: Actor, ruleId: string, locale: Locale, now: number): Promise<RuleDetail> {
  assertCan(actor, "automation.workflow.read");
  const row = await ruleRow(db, ruleId);
  const stored = readStored(row);
  const meta = stored.meta;
  const taskAction = stored.actions.find((action) => action.type === "staff_task");
  const assigneeId = taskAction?.type === "staff_task" ? taskAction.params.assigneeId : null;
  const ids = [meta.author.id, meta.activation?.by, meta.pause?.by, meta.dryRun?.by, assigneeId];
  const [names, versions, samples, recent, governorate, tree] = await Promise.all([
    employeeNames(db, ids),
    versionsOf(db, row.id),
    meta.dryRun ? runsOfRule(db, actor, row.id, "dry", DRY_RUN_SAMPLES) : Promise.resolve([]),
    runsOfRule(db, actor, row.id, "real", 10),
    stored.event === "order.placed" && (stored.match as OrderMatch).governorateId ? db.select({ name: governorates.name }).from(governorates).where(eq(governorates.id, (stored.match as OrderMatch).governorateId as string)).get() : Promise.resolve(undefined),
    stored.event === "stock.below_reorder" && (stored.match as StockMatch).locationId ? locationTree(db) : Promise.resolve([]),
  ]);
  const location = stored.event === "stock.below_reorder" ? tree.find((node) => node.id === (stored.match as StockMatch).locationId) : undefined;
  const manage = can(actor, "automation.workflow.manage") && !branchLimited(actor);
  const activate = can(actor, "automation.workflow.activate");
  const block = activationBlock(actor, meta, now);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    event: stored.event,
    match: stored.match,
    actions: stored.actions,
    status: row.status as RuleStatus,
    version: meta.version,
    demo: meta.demo,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
    author: personOf(names, meta.author.id),
    activation: meta.activation ? { version: meta.activation.version, at: meta.activation.at, by: personOf(names, meta.activation.by) } : null,
    pause: meta.pause ? { at: meta.pause.at, by: personOf(names, meta.pause.by), reason: meta.pause.reason } : null,
    dryRun: meta.dryRun ? { ...meta.dryRun, byName: personOf(names, meta.dryRun.by), fresh: now - meta.dryRun.at <= DRY_RUN_FRESH_MS, current: meta.dryRun.version === meta.version } : null,
    samples,
    recent,
    runCount: row.runCount,
    lastRunAt: row.lastRunAt,
    versions,
    names: {
      assignee: assigneeId ? (names.get(assigneeId)?.name ?? null) : null,
      assigneeActive: assigneeId ? (names.get(assigneeId)?.active ?? false) : true,
      governorate: governorate ? pick(parseL10n(governorate.name), locale) : null,
      location: location ? `${location.path} · ${location.name}` : null,
    },
    can: {
      manage,
      dryRun: canAny(actor, ["automation.workflow.manage", "automation.workflow.activate"]) && !branchLimited(actor) && !stored.broken,
      activate: activate && !stored.broken && (row.status === "dry_run" || row.status === "paused") && block === null,
      pause: canAny(actor, ["automation.workflow.manage", "automation.workflow.activate"]) && !branchLimited(actor) && row.status === "active",
      activateBlocked: activate && (row.status === "dry_run" || row.status === "paused" || row.status === "draft") ? (row.status === "draft" ? "dry_run_required" : block) : null,
    },
  };
}

// ───────────────────────────────────────────────────────────────── saving a version

export type SaveRuleInput = { ruleId?: string; expectedUpdatedAt?: unknown; definition: RuleRaw; reason?: unknown; idempotencyKey?: unknown };

/** Creates a draft rule (v1) or saves a new version of one (back to draft). Field errors come back all at once. */
export async function saveRule(db: Db, actor: Actor, raw: SaveRuleInput, now: number, options: { demo?: boolean } = {}): Promise<{ ruleId: string; version: number; replayed: boolean; stopped: boolean }> {
  assertCan(actor, "automation.workflow.manage");
  assertWholeStore(actor);
  const definition = parseDefinition(raw.definition);
  await assertReferences(db, definition);
  const by = stampOf(actor);
  if (!raw.ruleId) {
    const key = typeof raw.idempotencyKey === "string" ? raw.idempotencyKey : "";
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw invalid({ idempotencyKey: "required" });
    const ruleId = await idFromKey("wfl", actor, key);
    const existing = await db.select({ id: workflows.id, name: workflows.name, triggerEvent: workflows.triggerEvent }).from(workflows).where(eq(workflows.id, ruleId)).get();
    if (existing) {
      if (existing.name !== definition.name || existing.triggerEvent !== definition.event) throw new AppError("idempotency_mismatch", 409);
      return { ruleId, version: 1, replayed: true, stopped: false };
    }
    const conditions: StoredConditions = { schema: 1, version: 1, match: definition.match, author: { id: by, at: now }, demo: options.demo === true, dryRun: null, activation: null, pause: null, cursor: null };
    try {
      await runBatch(db, [
        db.insert(workflows).values({ id: ruleId, name: definition.name, description: definition.description, triggerEvent: definition.event, conditions, actions: definition.actions, status: "draft", requiresApproval: false, runCount: 0, createdBy: by, createdAt: now, updatedAt: now }),
        auditStatement(db, { actor, action: "automation.rule.create", entityType: "workflow", entityId: ruleId, summary: definition.name, after: definitionSnapshot(definition, 1), reason: reasonOf(raw.reason, false), at: now }),
      ]);
    } catch (error) {
      if (isUniqueViolation(error, "workflows.id")) return { ruleId, version: 1, replayed: true, stopped: false };
      throw error;
    }
    return { ruleId, version: 1, replayed: false, stopped: false };
  }
  const row = await ruleRow(db, raw.ruleId);
  const expected = expectedOf(raw.expectedUpdatedAt);
  const reason = reasonOf(raw.reason, true);
  if (row.updatedAt !== expected) throw new AppError("rule_changed", 409);
  const stored = readStored(row);
  const before = { version: stored.meta.version, name: row.name, description: row.description, event: stored.event, match: stored.match, actions: stored.actions };
  const version = stored.meta.version + 1;
  const after = definitionSnapshot(definition, version);
  if (JSON.stringify({ ...before, version: 0 }) === JSON.stringify({ ...after, version: 0 })) throw invalid({ _: "no_change" });
  const conditions: StoredConditions = { ...stored.meta, version, match: definition.match, author: { id: by, at: now }, cursor: null };
  try {
    await runBatch(db, [
      db
        .update(workflows)
        .set({ name: definition.name, description: definition.description, triggerEvent: definition.event, conditions, actions: definition.actions, status: "draft", updatedAt: now })
        .where(and(eq(workflows.id, row.id), eq(workflows.updatedAt, expected))),
      expectChanged(db, 1, { code: "RULE_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "automation.rule.save", entityType: "workflow", entityId: row.id, summary: `${definition.name} v${version}`, before, after, reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "RULE_CHANGED")) throw new AppError("rule_changed", 409, { cause: error });
    throw error;
  }
  return { ruleId: row.id, version, replayed: false, stopped: row.status === "active" };
}

/** The people and places a definition names must exist (an inactive assignee is refused here, not at run time). */
async function assertReferences(db: Db, definition: ReturnType<typeof parseDefinition>): Promise<void> {
  const fields: Record<string, string> = {};
  for (const action of definition.actions) {
    if (action.type !== "staff_task") continue;
    const person = await db.select({ status: employees.status }).from(employees).where(eq(employees.id, action.params.assigneeId)).get();
    if (!person) fields.taskAssignee = "not_found";
    else if (person.status !== "active") fields.taskAssignee = "employee_inactive";
  }
  if (definition.event === "order.placed" && (definition.match as OrderMatch).governorateId) {
    const place = await db.select({ id: governorates.id }).from(governorates).where(eq(governorates.id, (definition.match as OrderMatch).governorateId as string)).get();
    if (!place) fields.governorateId = "not_found";
  }
  if (definition.event === "stock.below_reorder" && (definition.match as StockMatch).locationId) {
    const tree = await locationTree(db);
    if (!tree.some((node) => node.id === (definition.match as StockMatch).locationId && node.isSellable)) fields.locationId = "location_invalid";
  }
  if (Object.keys(fields).length) throw invalid(fields);
}

// ───────────────────────────────────────────────────────────────── 19.07 dry run

export type DryRunResult = DryRunSummary & { samples: number };

export async function dryRunRule(db: Db, actor: Actor, raw: { ruleId?: unknown; days?: unknown; expectedUpdatedAt?: unknown }, now: number): Promise<DryRunResult> {
  if (!canAny(actor, ["automation.workflow.manage", "automation.workflow.activate"])) throw forbidden("automation.workflow.manage");
  assertWholeStore(actor);
  // the window in any of the three digit sets ("٣٠", "۳۰", "30")
  const days = typeof raw.days === "number" ? raw.days : parseWhole(typeof raw.days === "string" ? raw.days : "");
  if (typeof days !== "number" || !(DRY_RUN_WINDOWS as readonly number[]).includes(days)) throw invalid({ days: "invalid" });
  const row = await ruleRow(db, raw.ruleId);
  const expected = expectedOf(raw.expectedUpdatedAt);
  if (row.updatedAt !== expected) throw new AppError("rule_changed", 409);
  const stored = readStored(row);
  if (stored.broken) throw new AppError("rule_not_activatable", 409);
  const rule = ruleContext(row, stored);
  const from = now - days * DAY_MS;
  const events = await collectEvents(db, rule.event, rule.match, { from, to: now, limit: DRY_RUN_MAX_EVENTS + 1, current: false }, now);
  const truncated = events.length > DRY_RUN_MAX_EVENTS;
  const considered = events.slice(0, DRY_RUN_MAX_EVENTS);
  const cache = newPlanCache();
  const actions: DryRunSummary["actions"] = {};
  const failed: DryRunSummary["failed"] = {};
  const samples: (typeof workflowRuns.$inferInsert)[] = [];
  let matched = 0;
  for (const event of considered) {
    const verdict = evaluate(rule.event, event.facts, rule.match, event.at);
    if (!verdict.matched) {
      failed[verdict.failed] = (failed[verdict.failed] ?? 0) + 1;
      continue;
    }
    matched++;
    const sampleId = await dryRunIdFor(row.id, rule.version, now, event.key);
    const planned = await planEvent(db, rule, event, cache, now, { dry: true, runId: sampleId });
    for (const entry of planned.entries) {
      const bucket = (actions[entry.type as ActionType] ??= { would: 0, skip: 0 });
      if (entry.outcome === "would") bucket.would++;
      else bucket.skip++;
    }
    if (samples.length < DRY_RUN_SAMPLES) {
      const status = statusOf(planned.entries);
      samples.push({ id: sampleId, workflowId: row.id, refType: event.refType, refId: event.refId, event: eventSnapshot(rule, event), isDryRun: true, status, actionsLog: planned.entries, error: null, startedAt: now, finishedAt: now });
    }
  }
  const summary: DryRunSummary = { version: rule.version, at: now, by: stampOf(actor), days, considered: considered.length, matched, truncated, actions, failed, stockNow: rule.event === "stock.below_reorder" };
  const nextStatus: RuleStatus = row.status === "draft" ? "dry_run" : (row.status as RuleStatus);
  const statements: BatchStatement[] = [
    db
      .update(workflows)
      .set({ conditions: sql`json_set(${workflows.conditions}, '$.dryRun', json(${JSON.stringify(summary)}))`, status: nextStatus, updatedAt: now })
      .where(and(eq(workflows.id, row.id), eq(workflows.updatedAt, expected))),
    expectChanged(db, 1, { code: "RULE_CHANGED", detail: row.id }),
    db.delete(workflowRuns).where(and(eq(workflowRuns.workflowId, row.id), eq(workflowRuns.isDryRun, true))),
    ...chunkRows(workflowRuns, samples).map((chunk) => db.insert(workflowRuns).values(chunk)),
    auditStatement(db, { actor, action: "automation.rule.dry_run", entityType: "workflow", entityId: row.id, summary: `${row.name} v${rule.version}: ${matched}/${considered.length}`, after: summary, at: now }),
  ];
  try {
    await runBatch(db, statements);
  } catch (error) {
    if (isDbError(error, "RULE_CHANGED")) throw new AppError("rule_changed", 409, { cause: error });
    throw error;
  }
  return { ...summary, samples: samples.length };
}

// ───────────────────────────────────────────────────────────────── switching on and off

export async function activateRule(db: Db, actor: Actor, raw: { ruleId?: unknown; expectedUpdatedAt?: unknown; reason?: unknown }, now: number): Promise<{ status: "active"; replayed: boolean }> {
  assertCan(actor, "automation.workflow.activate");
  assertWholeStore(actor);
  const row = await ruleRow(db, raw.ruleId);
  const expected = expectedOf(raw.expectedUpdatedAt);
  const reason = reasonOf(raw.reason, true);
  const stored = readStored(row);
  if (row.status === "active" && stored.meta.activation?.by === stampOf(actor) && stored.meta.activation.version === stored.meta.version) return { status: "active", replayed: true };
  if (row.updatedAt !== expected) throw new AppError("rule_changed", 409);
  if (stored.broken) throw new AppError("rule_not_activatable", 409);
  if (row.status === "draft") throw new AppError("dry_run_required", 409);
  if (row.status !== "dry_run" && row.status !== "paused") throw new AppError("rule_not_activatable", 409);
  const block = activationBlock(actor, stored.meta, now);
  if (block === "author_cannot_activate") throw new AppError("author_cannot_activate", 403);
  if (block) throw new AppError(block, block === "branch_limited" ? 403 : 409);
  const activation = { version: stored.meta.version, at: now, by: stampOf(actor) as string };
  try {
    await runBatch(db, [
      db
        .update(workflows)
        .set({
          status: "active",
          conditions: sql`json_set(json_set(json_set(${workflows.conditions}, '$.activation', json(${JSON.stringify(activation)})), '$.pause', json('null')), '$.cursor', json('null'))`,
          updatedAt: now,
        })
        .where(and(eq(workflows.id, row.id), eq(workflows.updatedAt, expected), inArray(workflows.status, ["dry_run", "paused"]))),
      expectChanged(db, 1, { code: "RULE_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: row.status === "paused" ? "automation.rule.resume" : "automation.rule.activate", entityType: "workflow", entityId: row.id, summary: `${row.name} v${stored.meta.version}`, before: { status: row.status }, after: { status: "active", version: stored.meta.version, dryRun: stored.meta.dryRun }, reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "RULE_CHANGED")) throw new AppError("rule_changed", 409, { cause: error });
    throw error;
  }
  return { status: "active", replayed: false };
}

export async function pauseRule(db: Db, actor: Actor, raw: { ruleId?: unknown; expectedUpdatedAt?: unknown; reason?: unknown }, now: number): Promise<{ status: "paused"; replayed: boolean }> {
  if (!canAny(actor, ["automation.workflow.manage", "automation.workflow.activate"])) throw forbidden("automation.workflow.manage");
  assertWholeStore(actor);
  const row = await ruleRow(db, raw.ruleId);
  const expected = expectedOf(raw.expectedUpdatedAt);
  const reason = reasonOf(raw.reason, true) as string;
  const stored = readStored(row);
  if (row.status === "paused" && stored.meta.pause?.by === stampOf(actor)) return { status: "paused", replayed: true };
  if (row.updatedAt !== expected) throw new AppError("rule_changed", 409);
  if (row.status !== "active") throw new AppError("rule_not_active", 409);
  const pause = { at: now, by: stampOf(actor) as string, reason };
  try {
    await runBatch(db, [
      db
        .update(workflows)
        .set({ status: "paused", conditions: sql`json_set(${workflows.conditions}, '$.pause', json(${JSON.stringify(pause)}))`, updatedAt: now })
        .where(and(eq(workflows.id, row.id), eq(workflows.updatedAt, expected), eq(workflows.status, "active"))),
      expectChanged(db, 1, { code: "RULE_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: "automation.rule.pause", entityType: "workflow", entityId: row.id, summary: `${row.name} v${stored.meta.version}`, before: { status: "active" }, after: { status: "paused" }, reason, at: now }),
    ]);
  } catch (error) {
    if (isDbError(error, "RULE_CHANGED")) throw new AppError("rule_changed", 409, { cause: error });
    throw error;
  }
  return { status: "paused", replayed: false };
}

/** The builder's starting values for an existing rule (automation.workflow.manage). */
export async function ruleForEdit(db: Db, actor: Actor, ruleId: string) {
  assertCan(actor, "automation.workflow.manage");
  const row = await ruleRow(db, ruleId);
  const stored = readStored(row);
  return { id: row.id, name: row.name, description: row.description, event: stored.event, match: stored.match, actions: stored.actions, status: row.status as RuleStatus, version: stored.meta.version, updatedAt: row.updatedAt, demo: stored.meta.demo };
}

/**
 * Rules waiting for someone to switch them on that this employee may switch on (the admin bell, the module's home) —
 * exactly the rules `listRules` lists with `ready` (AUTOMATION_LINKS.rulesToActivate).
 */
export async function countActivatable(db: Db, actor: Actor, now: number): Promise<number | null> {
  if (!mayActivate(actor)) return null;
  const rows = await db.select().from(workflows).where(eq(workflows.status, "dry_run"));
  return activatableBy(actor, rows, now).length;
}
