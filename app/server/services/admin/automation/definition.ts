/**
 * Admin module 19 — a rule's definition as a form sends it (validated with zod, digits in any of the three sets) and as
 * the `workflows` row stores it. No database here; the rules service and the tests use it.
 *
 *   const definition = parseDefinition(ruleRawFromForm(form));   // AppError("invalid", 400, { fields }) on a bad field
 *   const stored = readStored(row);                              // the row's JSON read defensively
 *
 * Storage (no migration: the schema's columns are used as they are):
 *   workflows.trigger_event  the event key
 *   workflows.actions        RuleAction[]
 *   workflows.conditions     { schema: 1, version, match, author: { id, at }, demo, dryRun, activation, pause }
 *     version     +1 on every saved change of the event, the conditions, the actions, the name or the description
 *     author      who saved the current version (that person never switches it on: four eyes)
 *     dryRun      the latest dry run's summary (its `version` says which version it simulated)
 *     activation  the version that was switched on, by whom and when (events before `at` are never run)
 *     pause       who paused it, when and why
 * The full text of every version is in the audit trail (`automation.rule.save`, before / after).
 */
import { z } from "zod";
import { AppError } from "~/server/errors";
import {
  EVENT_ACTIONS,
  EVENT_TYPES,
  LIMITS,
  NOTICE_AUDIENCES,
  ORDER_CHANNEL_CHOICES,
  PAYMENT_METHODS,
  PRICE_DIRECTIONS,
  PRODUCT_KINDS,
  STAFF_TASK_PRIORITIES,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  defaultMatch,
  isActionType,
  isEventType,
  parseWhole,
  type ActionType,
  type EventType,
  type RuleAction,
  type RuleDefinition,
  type RuleMatch,
} from "./catalog";
import type { DryRunSummary } from "./types";

const ID = /^[A-Za-z0-9_.:-]{1,64}$/;

/** One line of text: spaces collapsed, control characters removed. */
export function cleanLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
}

const text = (max: number) =>
  z
    .string()
    .optional()
    .default("")
    .transform((value) => cleanLine(value))
    .refine((value) => value.length <= max, "too_long");

const optionalId = z
  .string()
  .optional()
  .transform((value) => (value && value.trim() !== "" ? value.trim() : null))
  .refine((value) => value === null || ID.test(value), "invalid");

const list = <T extends string>(values: readonly T[]) =>
  z
    .array(z.string())
    .optional()
    .default([])
    .transform((items) => [...new Set(items.map((item) => item.trim()).filter(Boolean))])
    .refine((items) => items.every((item) => (values as readonly string[]).includes(item)), "invalid")
    .transform((items) => items as T[]);

/** A whole number field: blank → null, digits in any of the three sets, within bounds. */
const whole = (min: number, max: number, required = false) =>
  z
    .string()
    .optional()
    .transform((raw, ctx) => {
      const value = parseWhole(raw);
      if (value === undefined) {
        if (required) ctx.addIssue({ code: "custom", message: "required" });
        return null;
      }
      if (value === null) {
        ctx.addIssue({ code: "custom", message: "number_invalid" });
        return null;
      }
      if (value < min || value > max) ctx.addIssue({ code: "custom", message: "out_of_range" });
      return value;
    });

const flagField = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((value) => value === true || value === "on" || value === "1" || value === "true");

const OrderMatchInput = z.object({ channel: z.enum(ORDER_CHANNEL_CHOICES, { error: "invalid" }).default("any"), paymentMethods: list(PAYMENT_METHODS), minTotal: whole(1, LIMITS.maxTotalIqd), governorateId: optionalId, includeDemo: flagField });
const StockMatchInput = z.object({ locationId: optionalId, productKinds: list(PRODUCT_KINDS), onlyNothingIncoming: flagField, includeDemo: flagField });
const TicketMatchInput = z.object({ hours: whole(LIMITS.hoursMin, LIMITS.hoursMax, true), priorities: list(TICKET_PRIORITIES), categories: list(TICKET_CATEGORIES), unassignedOnly: flagField, includeDemo: flagField });
const PriceMatchInput = z.object({ direction: z.enum(PRICE_DIRECTIONS, { error: "invalid" }).default("any"), minChangePercent: whole(LIMITS.changePercentMin, LIMITS.changePercentMax), includeDemo: flagField });

const TaskInput = z.object({
  assigneeId: z
    .string()
    .optional()
    .transform((value) => (value ?? "").trim())
    .refine((value) => value !== "", "required")
    .refine((value) => value === "" || ID.test(value), "invalid"),
  priority: z.enum(STAFF_TASK_PRIORITIES, { error: "invalid" }).default("normal"),
  dueHours: whole(1, LIMITS.dueHoursMax),
  note: text(LIMITS.note).transform((value) => (value === "" ? null : value)),
});
const NotifyInput = z.object({ audience: z.enum(NOTICE_AUDIENCES, { error: "invalid" }) });

/** What a builder form sends, before validation (the route reads it from the form with `ruleRawFromForm`). */
export type RuleRaw = {
  name?: string;
  description?: string;
  event?: string;
  match?: Record<string, unknown>;
  actions?: Partial<Record<ActionType, Record<string, unknown> | boolean>>;
};

export type ParsedDefinition = RuleDefinition & { name: string; description: string | null };

/** zod's issues as the module's field errors: "match.minTotal" → "minTotal", "actions.staff_task.assigneeId" → "taskAssignee". */
const FIELD_NAMES: Record<string, string> = {
  "match.minTotal": "minTotal",
  "match.hours": "hours",
  "match.minChangePercent": "minChangePercent",
  "match.governorateId": "governorateId",
  "match.locationId": "locationId",
  "match.paymentMethods": "paymentMethods",
  "match.productKinds": "productKinds",
  "match.priorities": "priorities",
  "match.categories": "categories",
  "match.channel": "channel",
  "match.direction": "direction",
  "actions.staff_task.assigneeId": "taskAssignee",
  "actions.staff_task.priority": "taskPriority",
  "actions.staff_task.dueHours": "taskDueHours",
  "actions.staff_task.note": "taskNote",
  "actions.notify.audience": "notifyAudience",
};

function issuesToFields(prefix: string, error: z.ZodError, fields: Record<string, string>): void {
  for (const issue of error.issues) {
    const path = [prefix, ...issue.path.map(String)].join(".");
    const name = FIELD_NAMES[path] ?? path.split(".").pop() ?? "_";
    if (!fields[name]) fields[name] = issue.message && /^[a-z_]+$/.test(issue.message) ? issue.message : "invalid";
  }
}

/** Validates a rule as the builder sends it; every problem comes back at once as field errors. */
export function parseDefinition(raw: RuleRaw): ParsedDefinition {
  const fields: Record<string, string> = {};
  const name = cleanLine(String(raw.name ?? ""));
  if (name.length < 3) fields.name = name === "" ? "required" : "too_short";
  else if (name.length > LIMITS.name) fields.name = "too_long";
  const description = cleanLine(String(raw.description ?? ""));
  if (description.length > LIMITS.description) fields.description = "too_long";
  if (!isEventType(raw.event)) {
    fields.event = "required";
    throw new AppError("invalid", 400, { fields });
  }
  const event: EventType = raw.event;
  const matchRaw = raw.match ?? {};
  let match: RuleMatch = defaultMatch(event);
  const schema = event === "order.placed" ? OrderMatchInput : event === "stock.below_reorder" ? StockMatchInput : event === "ticket.waiting" ? TicketMatchInput : PriceMatchInput;
  const parsed = schema.safeParse(matchRaw);
  if (!parsed.success) issuesToFields("match", parsed.error, fields);
  else {
    const value = parsed.data as Record<string, unknown>;
    if (event === "order.placed") match = { channel: value.channel as never, paymentMethods: value.paymentMethods as never, minTotalIqd: (value.minTotal as number | null) ?? null, governorateId: value.governorateId as string | null, includeDemo: value.includeDemo as boolean };
    else if (event === "stock.below_reorder") match = { locationId: value.locationId as string | null, productKinds: value.productKinds as never, onlyNothingIncoming: value.onlyNothingIncoming as boolean, includeDemo: value.includeDemo as boolean };
    else if (event === "ticket.waiting") match = { hours: value.hours as number, priorities: value.priorities as never, categories: value.categories as never, unassignedOnly: value.unassignedOnly as boolean, includeDemo: value.includeDemo as boolean };
    else match = { direction: value.direction as never, minChangeBps: value.minChangePercent === null ? null : (value.minChangePercent as number) * 100, includeDemo: value.includeDemo as boolean };
  }

  const actions: RuleAction[] = [];
  const chosen = Object.entries(raw.actions ?? {}).filter(([type, value]) => isActionType(type) && value !== false && value !== undefined) as [ActionType, Record<string, unknown> | true][];
  for (const [type, value] of chosen) {
    if (!EVENT_ACTIONS[event].includes(type)) {
      fields.actions = "action_not_allowed";
      continue;
    }
    const params = value === true ? {} : value;
    if (type === "staff_task") {
      const task = TaskInput.safeParse(params);
      if (!task.success) issuesToFields("actions.staff_task", task.error, fields);
      else actions.push({ type, params: { assigneeId: task.data.assigneeId, priority: task.data.priority, dueHours: task.data.dueHours ?? null, note: task.data.note } });
    } else if (type === "notify") {
      const notice = NotifyInput.safeParse(params);
      if (!notice.success) issuesToFields("actions.notify", notice.error, fields);
      else actions.push({ type, params: { audience: notice.data.audience } });
    } else actions.push({ type, params: {} } as RuleAction);
  }
  if (chosen.length === 0) fields.actions = "action_required";
  if (Object.keys(fields).length) throw new AppError("invalid", 400, { fields });
  // the catalogue's order, so two forms with the same choices store the same definition
  actions.sort((a, b) => EVENT_ACTIONS[event].indexOf(a.type) - EVENT_ACTIONS[event].indexOf(b.type));
  return { name, description: description === "" ? null : description, event, match, actions };
}

/** The builder's form as `parseDefinition` reads it (field names: docs/areas/admin-automation.md). */
export function ruleRawFromForm(form: { get(name: string): FormDataEntryValue | null; getAll(name: string): FormDataEntryValue[] }): RuleRaw {
  const one = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : undefined;
  };
  const many = (name: string) => form.getAll(name).filter((value): value is string => typeof value === "string");
  const on = (name: string) => one(name) === "on" || one(name) === "1" || one(name) === "true";
  const actions: RuleRaw["actions"] = {};
  if (on("act_staff_task")) actions.staff_task = { assigneeId: one("taskAssignee"), priority: one("taskPriority") || undefined, dueHours: one("taskDueHours"), note: one("taskNote") };
  if (on("act_notify")) actions.notify = { audience: one("notifyAudience") };
  if (on("act_flag_order")) actions.flag_order = true;
  if (on("act_suggest_purchase")) actions.suggest_purchase = true;
  return {
    name: one("name"),
    description: one("description"),
    event: one("event"),
    match: {
      channel: one("channel") || undefined,
      paymentMethods: many("paymentMethods"),
      minTotal: one("minTotal"),
      governorateId: one("governorateId"),
      locationId: one("locationId"),
      productKinds: many("productKinds"),
      onlyNothingIncoming: one("onlyNothingIncoming"),
      hours: one("hours"),
      priorities: many("priorities"),
      categories: many("categories"),
      unassignedOnly: one("unassignedOnly"),
      direction: one("direction") || undefined,
      minChangePercent: one("minChangePercent"),
      includeDemo: one("includeDemo"),
    },
    actions,
  };
}

/**
 * What the form held, as far as it reads (for showing a refused form again without JavaScript): unreadable numbers
 * become empty, unknown choices are dropped. Never stored.
 */
export function looseValues(raw: RuleRaw): { name: string; description: string | null; event: EventType; match: RuleMatch; actions: RuleAction[] } | null {
  if (!isEventType(raw.event)) return null;
  const event = raw.event;
  const m = (raw.match ?? {}) as Record<string, unknown>;
  const str = (value: unknown) => (typeof value === "string" ? value : "");
  const arr = <T extends string>(value: unknown, allowed: readonly T[]) => (Array.isArray(value) ? (value.filter((item) => (allowed as readonly unknown[]).includes(item)) as T[]) : []);
  const whole = (value: unknown) => {
    const parsed = parseWhole(str(value));
    return typeof parsed === "number" ? parsed : null;
  };
  const on = (value: unknown) => value === "on" || value === "1" || value === "true" || value === true;
  const base = defaultMatch(event);
  let match: RuleMatch = base;
  if (event === "order.placed") match = { channel: (ORDER_CHANNEL_CHOICES as readonly string[]).includes(str(m.channel)) ? (str(m.channel) as never) : "any", paymentMethods: arr(m.paymentMethods, PAYMENT_METHODS), minTotalIqd: whole(m.minTotal), governorateId: str(m.governorateId) || null, includeDemo: on(m.includeDemo) };
  else if (event === "stock.below_reorder") match = { locationId: str(m.locationId) || null, productKinds: arr(m.productKinds, PRODUCT_KINDS), onlyNothingIncoming: on(m.onlyNothingIncoming), includeDemo: on(m.includeDemo) };
  else if (event === "ticket.waiting") match = { hours: whole(m.hours) ?? (base as { hours: number }).hours, priorities: arr(m.priorities, TICKET_PRIORITIES), categories: arr(m.categories, TICKET_CATEGORIES), unassignedOnly: on(m.unassignedOnly), includeDemo: on(m.includeDemo) };
  else {
    const percent = whole(m.minChangePercent);
    match = { direction: (PRICE_DIRECTIONS as readonly string[]).includes(str(m.direction)) ? (str(m.direction) as never) : "any", minChangeBps: percent === null ? null : percent * 100, includeDemo: on(m.includeDemo) };
  }
  const actions: RuleAction[] = [];
  const chosen = raw.actions ?? {};
  const task = chosen.staff_task;
  if (task) {
    const params = task === true ? {} : task;
    const priority = str(params.priority);
    actions.push({ type: "staff_task", params: { assigneeId: str(params.assigneeId), priority: (STAFF_TASK_PRIORITIES as readonly string[]).includes(priority) ? (priority as never) : "normal", dueHours: whole(params.dueHours), note: str(params.note) || null } });
  }
  const notice = chosen.notify;
  if (notice) {
    const audience = str(notice === true ? "" : notice.audience);
    actions.push({ type: "notify", params: { audience: (NOTICE_AUDIENCES as readonly string[]).includes(audience) ? (audience as never) : NOTICE_AUDIENCES[0] } });
  }
  if (chosen.flag_order) actions.push({ type: "flag_order", params: {} });
  if (chosen.suggest_purchase) actions.push({ type: "suggest_purchase", params: {} });
  return { name: str(raw.name), description: str(raw.description) || null, event, match, actions };
}

// ───────────────────────────────────────────────────────────────── the stored row

export type StoredConditions = {
  schema: 1;
  version: number;
  match: RuleMatch;
  author: { id: string | null; at: number };
  demo: boolean;
  dryRun: DryRunSummary | null;
  activation: { version: number; at: number; by: string } | null;
  pause: { at: number; by: string; reason: string | null } | null;
  /** Orders and price changes: the last event the scheduled run has read (it continues after it). */
  cursor?: { at: number; id: string } | null;
};

export type StoredRule = {
  event: EventType;
  match: RuleMatch;
  actions: RuleAction[];
  meta: StoredConditions;
  /** The row's JSON did not read as a rule (edited by hand, or written by an older version): it never runs. */
  broken: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A `workflows` row's JSON read defensively: anything that does not fit gives `broken: true`, never a throw. */
export function readStored(row: { triggerEvent: string; conditions: unknown; actions: unknown; createdBy?: string | null; createdAt?: number }): StoredRule {
  const event: EventType = isEventType(row.triggerEvent) ? row.triggerEvent : EVENT_TYPES[0];
  const raw = isRecord(row.conditions) ? row.conditions : {};
  const meta: StoredConditions = {
    schema: 1,
    version: Number.isInteger(raw.version) && (raw.version as number) > 0 ? (raw.version as number) : 1,
    match: isRecord(raw.match) ? ({ ...defaultMatch(event), ...(raw.match as object) } as RuleMatch) : defaultMatch(event),
    author: isRecord(raw.author) ? { id: typeof raw.author.id === "string" ? raw.author.id : null, at: Number(raw.author.at ?? row.createdAt ?? 0) } : { id: row.createdBy ?? null, at: row.createdAt ?? 0 },
    demo: raw.demo === true,
    dryRun: isRecord(raw.dryRun) ? (raw.dryRun as unknown as DryRunSummary) : null,
    activation: isRecord(raw.activation) && typeof raw.activation.at === "number" ? (raw.activation as StoredConditions["activation"]) : null,
    pause: isRecord(raw.pause) && typeof raw.pause.at === "number" ? (raw.pause as StoredConditions["pause"]) : null,
    cursor: isRecord(raw.cursor) && typeof raw.cursor.at === "number" && typeof raw.cursor.id === "string" ? { at: raw.cursor.at, id: raw.cursor.id } : null,
  };
  const actions = Array.isArray(row.actions) ? (row.actions.filter((action) => isRecord(action) && isActionType(action.type) && EVENT_ACTIONS[event].includes(action.type as ActionType)) as RuleAction[]) : [];
  const broken = !isEventType(row.triggerEvent) || !isRecord(raw.match) || actions.length === 0 || (Array.isArray(row.actions) && actions.length !== row.actions.length);
  return { event, match: meta.match, actions, meta, broken };
}

/** The definition as the audit trail keeps each version (no ids of other records beyond the assignee). */
export function definitionSnapshot(definition: ParsedDefinition, version: number) {
  return { version, name: definition.name, description: definition.description, event: definition.event, match: definition.match, actions: definition.actions };
}
