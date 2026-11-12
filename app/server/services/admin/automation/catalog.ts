/**
 * Admin module 19 "automation" — the FIXED catalogue a rule is built from, and the pure evaluator of its conditions.
 * Client-safe: no database, no "cloudflare:workers" (the rule builder renders from these lists).
 *
 *   const verdict = evaluate("order.placed", facts, rule.match);   // { matched: true } | { matched: false, failed: "minTotal" }
 *
 * A rule = ONE event of EVENT_TYPES + typed conditions for that event (no free expressions, no code) + actions from
 * EVENT_ACTIONS[event]. What the actions are allowed to do is the point of 19.08: every action only hands work to a
 * person — a staff task (15.02), a notice inside the admin, a review flag in the orders module's queue (05.09), a
 * reorder suggestion that a person turns into a DRAFT purchase order (19.02 → 09). No action refunds, changes a price,
 * moves stock or money, sends a message outside the admin or approves anything.
 */
import { PAYMENT_METHODS, PRODUCT_KINDS, STAFF_TASK_PRIORITIES, TICKET_CATEGORIES, TICKET_PRIORITIES, type PaymentMethod, type ProductKind, type StaffTaskPriority, type TicketCategory, type TicketPriority } from "~/server/db/schema";
import type { Permission } from "~/server/permissions";

export const AUTOMATION_NS = "admin-automation";

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

// ───────────────────────────────────────────────────────────────── events and actions

export const EVENT_TYPES = ["order.placed", "stock.below_reorder", "ticket.waiting", "price.changed"] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const ACTION_TYPES = ["staff_task", "notify", "flag_order", "suggest_purchase"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

/** The actions each event may use (a flag exists only where the record's own module has a review queue). */
export const EVENT_ACTIONS: Readonly<Record<EventType, readonly ActionType[]>> = {
  "order.placed": ["staff_task", "notify", "flag_order"],
  "stock.below_reorder": ["staff_task", "notify", "suggest_purchase"],
  "ticket.waiting": ["staff_task", "notify"],
  "price.changed": ["staff_task", "notify"],
};

/** The record an event is about (`workflow_runs.ref_type`). */
export const EVENT_RECORD: Readonly<Record<EventType, "order" | "stock_level" | "support_ticket" | "price_change">> = {
  "order.placed": "order",
  "stock.below_reorder": "stock_level",
  "ticket.waiting": "support_ticket",
  "price.changed": "price_change",
};

export const isEventType = (value: unknown): value is EventType => typeof value === "string" && (EVENT_TYPES as readonly string[]).includes(value);
export const isActionType = (value: unknown): value is ActionType => typeof value === "string" && (ACTION_TYPES as readonly string[]).includes(value);

/** Who a notice is for: holders of one of the module's own read permissions (they can open the module's pages). */
export const NOTICE_AUDIENCES = ["automation.workflow.read", "automation.suggestion.read", "automation.anomaly.read"] as const satisfies readonly Permission[];
export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];

export const ORDER_CHANNEL_CHOICES = ["any", "web", "pos"] as const;
export type OrderChannelChoice = (typeof ORDER_CHANNEL_CHOICES)[number];
export const PRICE_DIRECTIONS = ["any", "down", "up"] as const;
export type PriceDirection = (typeof PRICE_DIRECTIONS)[number];

export { PAYMENT_METHODS, PRODUCT_KINDS, STAFF_TASK_PRIORITIES, TICKET_CATEGORIES, TICKET_PRIORITIES };
export type { PaymentMethod, ProductKind, StaffTaskPriority, TicketCategory, TicketPriority };

// ───────────────────────────────────────────────────────────────── limits

export const LIMITS = {
  name: 80,
  description: 300,
  note: 200,
  reason: 500,
  /** Largest order total a condition may name (10 bn IQD — the services' document ceiling). */
  maxTotalIqd: 10_000_000_000,
  hoursMin: 1,
  hoursMax: 168,
  dueHoursMax: 168,
  /** A price change of at least 1 % … 90 %. */
  changePercentMin: 1,
  changePercentMax: 90,
} as const;

/** Days of history a dry run may look back over. */
export const DRY_RUN_WINDOWS = [7, 30, 90] as const;
export type DryRunWindow = (typeof DRY_RUN_WINDOWS)[number];
/** A rule is switched on only after a dry run of its CURRENT version that is at most this old. */
export const DRY_RUN_FRESH_MS = 7 * DAY_MS;
/** Rows of "what would have happened" kept from a dry run (the counts cover every event). */
export const DRY_RUN_SAMPLES = 50;
/** Events a dry run reads at most per run (the result says when it stopped there). */
export const DRY_RUN_MAX_EVENTS = 2000;
/** Events one scheduled run handles per rule; the next run continues with the rest. */
export const RUN_EVENTS_PER_RULE = 100;
/** Notices stay on the module's front page this long. */
export const NOTICE_DAYS = 14;

// ───────────────────────────────────────────────────────────────── conditions

export type OrderMatch = { channel: OrderChannelChoice; paymentMethods: PaymentMethod[]; minTotalIqd: number | null; governorateId: string | null; includeDemo: boolean };
export type StockMatch = { locationId: string | null; productKinds: ProductKind[]; onlyNothingIncoming: boolean; includeDemo: boolean };
export type TicketMatch = { hours: number; priorities: TicketPriority[]; categories: TicketCategory[]; unassignedOnly: boolean; includeDemo: boolean };
export type PriceMatch = { direction: PriceDirection; minChangeBps: number | null; includeDemo: boolean };

export type MatchOf<E extends EventType> = E extends "order.placed" ? OrderMatch : E extends "stock.below_reorder" ? StockMatch : E extends "ticket.waiting" ? TicketMatch : PriceMatch;
export type RuleMatch = OrderMatch | StockMatch | TicketMatch | PriceMatch;

/** The conditions a new rule of each event starts with. */
export function defaultMatch(event: EventType): RuleMatch {
  switch (event) {
    case "order.placed":
      return { channel: "any", paymentMethods: [], minTotalIqd: null, governorateId: null, includeDemo: false };
    case "stock.below_reorder":
      return { locationId: null, productKinds: [], onlyNothingIncoming: false, includeDemo: false };
    case "ticket.waiting":
      return { hours: 4, priorities: [], categories: [], unassignedOnly: false, includeDemo: false };
    case "price.changed":
      return { direction: "any", minChangeBps: null, includeDemo: false };
  }
}

// ───────────────────────────────────────────────────────────────── actions

export type TaskParams = { assigneeId: string; priority: StaffTaskPriority; dueHours: number | null; note: string | null };
export type NotifyParams = { audience: NoticeAudience };
export type EmptyParams = Record<string, never>;

export type RuleAction = { type: "staff_task"; params: TaskParams } | { type: "notify"; params: NotifyParams } | { type: "flag_order"; params: EmptyParams } | { type: "suggest_purchase"; params: EmptyParams };

export type RuleDefinition = { event: EventType; match: RuleMatch; actions: RuleAction[] };

// ───────────────────────────────────────────────────────────────── the facts an event carries

export type OrderFacts = { ref: string; channel: string; paymentMethod: string | null; totalIqd: number; governorateId: string | null; status: string; reviewStatus: string; isDemo: boolean };
export type StockFacts = { variantId: string; sku: string; locationId: string; locationCode: string; available: number; reorderPoint: number; incoming: number; productKind: string; isDemo: boolean };
export type TicketFacts = { ref: string; status: string; priority: string; category: string; assignedTo: string | null; waitingSince: number; isDemo: boolean };
export type PriceFacts = { variantId: string; sku: string; oldPriceIqd: number | null; newPriceIqd: number; source: string; isDemo: boolean };
export type FactsOf<E extends EventType> = E extends "order.placed" ? OrderFacts : E extends "stock.below_reorder" ? StockFacts : E extends "ticket.waiting" ? TicketFacts : PriceFacts;

/** One event as the runner and the dry run see it. `key` names it for good: a rule runs at most once per key. */
export type AutomationEvent<E extends EventType = EventType> = {
  type: E;
  key: string;
  /** When it happened (a waiting ticket: when it crossed the rule's hours; stock: when it was read). */
  at: number;
  refType: (typeof EVENT_RECORD)[E];
  refId: string;
  /** What staff read: an order or ticket reference, "SKU @ LOCATION", a SKU. */
  label: string;
  facts: FactsOf<E>;
};

// ───────────────────────────────────────────────────────────────── the evaluator

export type ConditionKey = "demo" | "channel" | "paymentMethods" | "minTotal" | "governorate" | "location" | "productKinds" | "incoming" | "hours" | "priorities" | "categories" | "unassigned" | "direction" | "minChange";

export type Verdict = { matched: true } | { matched: false; failed: ConditionKey };

const fail = (failed: ConditionKey): Verdict => ({ matched: false, failed });
const pass: Verdict = { matched: true };

/** A price change in basis points of the old price (signed; null without an old price). */
export function changeBpsOf(oldPriceIqd: number | null, newPriceIqd: number): number | null {
  if (oldPriceIqd === null || !Number.isFinite(oldPriceIqd) || oldPriceIqd <= 0 || !Number.isFinite(newPriceIqd)) return null;
  return Math.trunc(((newPriceIqd - oldPriceIqd) * 10_000) / oldPriceIqd);
}

/**
 * Whether one event meets a rule's conditions — the same answer in the scheduled run, the dry run and the tests. The
 * first condition that fails is named, so a dry run can say why an event did not count.
 */
export function evaluate(type: EventType, facts: OrderFacts | StockFacts | TicketFacts | PriceFacts, match: RuleMatch, at?: number): Verdict {
  if ((facts as { isDemo: boolean }).isDemo && !(match as { includeDemo?: boolean }).includeDemo) return fail("demo");
  switch (type) {
    case "order.placed": {
      const f = facts as OrderFacts;
      const m = match as OrderMatch;
      if (m.channel !== "any" && f.channel !== m.channel) return fail("channel");
      if (m.paymentMethods.length && !(f.paymentMethod && (m.paymentMethods as string[]).includes(f.paymentMethod))) return fail("paymentMethods");
      if (m.minTotalIqd !== null && !(f.totalIqd >= m.minTotalIqd)) return fail("minTotal");
      if (m.governorateId !== null && f.governorateId !== m.governorateId) return fail("governorate");
      return pass;
    }
    case "stock.below_reorder": {
      const f = facts as StockFacts;
      const m = match as StockMatch;
      if (m.locationId !== null && f.locationId !== m.locationId) return fail("location");
      if (m.productKinds.length && !(m.productKinds as string[]).includes(f.productKind)) return fail("productKinds");
      if (m.onlyNothingIncoming && f.incoming > 0) return fail("incoming");
      return pass;
    }
    case "ticket.waiting": {
      const f = facts as TicketFacts;
      const m = match as TicketMatch;
      // the event is "waited at least `hours`": the finder dates it at the crossing; a later reading still counts
      if (at !== undefined && at - f.waitingSince < m.hours * HOUR_MS) return fail("hours");
      if (m.priorities.length && !(m.priorities as string[]).includes(f.priority)) return fail("priorities");
      if (m.categories.length && !(m.categories as string[]).includes(f.category)) return fail("categories");
      if (m.unassignedOnly && f.assignedTo !== null) return fail("unassigned");
      return pass;
    }
    case "price.changed": {
      const f = facts as PriceFacts;
      const m = match as PriceMatch;
      const bps = changeBpsOf(f.oldPriceIqd, f.newPriceIqd);
      if (m.direction === "down" && !(bps !== null && bps < 0)) return fail("direction");
      if (m.direction === "up" && !(bps !== null && bps > 0)) return fail("direction");
      if (m.minChangeBps !== null && !(bps !== null && Math.abs(bps) >= m.minChangeBps)) return fail("minChange");
      return pass;
    }
  }
}

// ───────────────────────────────────────────────────────────────── statuses

export const RULE_STATUSES = ["draft", "dry_run", "active", "paused"] as const;
export type RuleStatus = (typeof RULE_STATUSES)[number];
export const RUN_STATUSES = ["succeeded", "awaiting_approval", "skipped", "failed"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const SUGGESTION_STATUSES = ["open", "approved", "dismissed"] as const;
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number];

export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";
export const RULE_STATUS_TONE: Readonly<Record<RuleStatus, Tone>> = { draft: "neutral", dry_run: "info", active: "ok", paused: "warn" };
export const RUN_STATUS_TONE: Readonly<Record<RunStatus, Tone>> = { succeeded: "ok", awaiting_approval: "info", skipped: "neutral", failed: "bad" };
export const SUGGESTION_STATUS_TONE: Readonly<Record<SuggestionStatus | "ordered", Tone>> = { open: "warn", approved: "info", ordered: "ok", dismissed: "neutral" };

/** What one action did in a run (or would have done in a dry run). */
export type ActionOutcome = "done" | "skipped" | "failed" | "would" | "would_skip";
export type ActionLogEntry = {
  type: ActionType;
  outcome: ActionOutcome;
  /** Why it was skipped or failed, as a key of `skip.*` in the module's strings. */
  reason?: string | null;
  /** Ids and numbers of what was created (never cost data). */
  detail?: Record<string, string | number | boolean | null>;
};

// ───────────────────────────────────────────────────────────────── 19.03: keyword rules (rules, never "AI")

/**
 * Words that point a ticket at a topic, checked in this order on the subject and the customer's first message
 * (normalised like the support module's routing rules: no case, diacritics or letter variants; digits Latin). The
 * first topic with a word in the text is the suggestion; the page shows the word that matched.
 */
export const KEYWORD_RULES: readonly { category: TicketCategory; words: readonly string[] }[] = [
  { category: "payment", words: ["حوالة", "تحويل", "زين كاش", "الدفع", "دفعت", "فلوسي", "ماستر", "كي كارد", "payment", "transfer", "zaincash", "paid"] },
  { category: "return", words: ["إرجاع", "استرجاع", "ترجيع", "استبدال", "refund", "return", "exchange"] },
  { category: "warranty", words: ["ضمان", "كفالة", "warranty", "guarantee"] },
  { category: "repair", words: ["تصليح", "صيانة", "عطل", "خربان", "ما يشتغل", "repair", "broken", "not working"] },
  { category: "shipping", words: ["توصيل", "الشحن", "المندوب", "ما وصل", "تأخر", "delivery", "courier", "shipping", "late"] },
  { category: "account", words: ["حسابي", "كلمة المرور", "كلمة السر", "تسجيل الدخول", "account", "password", "login", "sign in"] },
  { category: "complaint", words: ["شكوى", "سيء", "زعلان", "complaint", "terrible", "angry"] },
  { category: "order", words: ["طلبي", "الطلب", "طلبية", "إلغاء", "order", "cancel"] },
  { category: "product", words: ["متوفر", "سعر", "مواصفات", "يتوافق", "available", "price", "compatible", "specs"] },
];

// ───────────────────────────────────────────────────────────────── digits

/** Arabic-Indic and Persian digits as 0–9, the Arabic thousands separator and decimal comma removed / kept. */
export function latinDigits(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/[٬،,\s]/g, "");
}

/** A whole number typed in any of the three digit sets, or null when the text is not one (blank → undefined). */
export function parseWhole(raw: string | null | undefined): number | null | undefined {
  const text = latinDigits(String(raw ?? "")).trim();
  if (text === "") return undefined;
  if (!/^\d{1,13}$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}
