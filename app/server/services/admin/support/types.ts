/**
 * Admin module 14 "support" — the client-safe half: statuses and their tones, the ticket workflow, the inbox's URL
 * state, the safe variables of canned replies (14.04), the routing rule matcher (14.03), the SLA clock (14.05), the
 * statistics the metrics use, escalation kinds (14.07) and the knowledge workflow (14.06). Pure: no database, no
 * "cloudflare:workers", safe in route components.
 *
 *   const filters = parseInboxFilters(new URL(request.url).searchParams);   // views, kind, status, priority, q, sort, page
 *   <Link to={`/admin/support${inboxSearch({ ...filters, page: 2 })}`}>
 *   const { text, missing } = fillTemplate("مرحباً {customer_name}", { customer_name: "سارة" });
 */
import {
  CONTENT_STATUSES,
  REPAIR_STATUSES,
  TICKET_CATEGORIES,
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type ArticleAudience,
  type ArticleKind,
  type ContentStatus,
  type RepairStatus,
  type TicketCategory,
  type TicketChannel,
  type TicketPriority,
  type TicketStatus,
} from "~/server/db/schema";
import type { Permission } from "~/server/permissions";

export { ARTICLE_AUDIENCES, ARTICLE_KINDS, CONTENT_STATUSES, REPAIR_STATUSES, TICKET_CATEGORIES, TICKET_CHANNELS, TICKET_PRIORITIES, TICKET_STATUSES } from "~/server/db/schema";
export type { ArticleAudience, ArticleKind, ContentStatus, RepairStatus, TicketCategory, TicketChannel, TicketPriority, TicketStatus };

export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";

/** Every code the module's services throw beyond the core's (texts: "admin-support" → errors.*). */
export const SUPPORT_ERROR_KEYS = [
  "ticket_changed",
  "transition_not_allowed",
  "ticket_closed",
  "reason_required",
  "unfilled_variable",
  "template_code",
  "unknown_variable",
  "no_phone",
  "no_email",
  "contact_required",
  "assignee_not_agent",
  "take_only_unassigned",
  "escalation_target",
  "escalation_self",
  "escalation_open",
  "not_escalated",
  "order_other_customer",
  "warranty_other_order",
  "link_not_found",
  "rule_changed",
  "pool_empty",
  "policy_duplicate",
  "article_changed",
  "approver_is_editor",
  "revision_pending",
  "no_revision",
  "slug_taken",
  "slug_locked",
  "article_not_editable",
  "reply_changed",
  "nothing_to_apply",
] as const;
export type SupportErrorKey = (typeof SUPPORT_ERROR_KEYS)[number];

// ───────────────────────────────────────────────────────────────── tickets

/** Statuses of a ticket that still needs somebody. */
export const OPEN_TICKET_STATUSES = ["open", "pending_customer", "pending_staff", "on_hold"] as const satisfies readonly TicketStatus[];
export const DONE_TICKET_STATUSES = ["resolved", "closed"] as const satisfies readonly TicketStatus[];
export const isOpenTicket = (status: string): boolean => (OPEN_TICKET_STATUSES as readonly string[]).includes(status);

export const TICKET_TONE: Record<TicketStatus, Tone> = {
  open: "warn",
  pending_staff: "warn",
  pending_customer: "info",
  on_hold: "neutral",
  resolved: "ok",
  closed: "neutral",
};

/** Which status may follow which (14.01). A status not listed cannot be reached from that status. */
export const TICKET_TRANSITIONS: Record<TicketStatus, readonly TicketStatus[]> = {
  open: ["pending_customer", "pending_staff", "on_hold", "resolved", "closed"],
  pending_customer: ["pending_staff", "on_hold", "resolved", "closed"],
  pending_staff: ["pending_customer", "on_hold", "resolved", "closed"],
  on_hold: ["pending_staff", "resolved", "closed"],
  resolved: ["open", "closed"],
  closed: ["open"],
};

/** A typed reason (or the resolution) is required to move a ticket into these, and to reopen one. */
export const STATUS_WITH_REASON: readonly TicketStatus[] = ["on_hold", "resolved", "closed", "open"];

export const PRIORITY_RANK: Record<TicketPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
export const PRIORITY_TONE: Record<TicketPriority, Tone> = { urgent: "bad", high: "warn", normal: "neutral", low: "neutral" };

/** Channels staff can open a ticket for (the storefront opens "web" and "assistant"). */
export const STAFF_CHANNELS = ["phone", "whatsapp", "email", "store", "social"] as const satisfies readonly TicketChannel[];
export type StaffChannel = (typeof STAFF_CHANNELS)[number];

/**
 * How a reply reached the customer. No SMS, WhatsApp or e-mail provider is connected: a written reply is HELD in the
 * outbox (never "sent"); a call or a conversation at the counter is recorded as such.
 */
export const REPLY_VIA = ["whatsapp", "sms", "email", "call", "in_person"] as const;
export type ReplyVia = (typeof REPLY_VIA)[number];
export const MESSAGE_VIA: readonly ReplyVia[] = ["whatsapp", "sms", "email"];

/** Where a customer message that staff record came from (read on a phone, heard at the counter…). */
export const INBOUND_VIA = ["whatsapp", "phone", "email", "in_person", "social"] as const;
export type InboundVia = (typeof INBOUND_VIA)[number];

/** What a reply does to the ticket. */
export const REPLY_THEN = ["pending_customer", "keep", "resolved"] as const;
export type ReplyThen = (typeof REPLY_THEN)[number];

// ───────────────────────────────────────────────────────────────── repairs (module 12's workflow, read here)

export const REPAIR_OPEN_STATUSES = ["submitted", "received", "diagnosing", "awaiting_approval", "awaiting_parts", "repairing", "ready"] as const satisfies readonly RepairStatus[];
export const REPAIR_DONE_STATUSES = ["delivered", "unrepairable", "cancelled"] as const satisfies readonly RepairStatus[];
export const REPAIR_TONE: Record<RepairStatus, Tone> = {
  submitted: "warn",
  received: "info",
  diagnosing: "info",
  awaiting_approval: "warn",
  awaiting_parts: "warn",
  repairing: "info",
  ready: "ok",
  delivered: "neutral",
  unrepairable: "bad",
  cancelled: "neutral",
};

// ───────────────────────────────────────────────────────────────── inbox (14.01) — URL state

export const INBOX_VIEWS = ["open", "needs_reply", "mine", "unassigned", "late", "escalated", "escalated_me", "handoffs", "repairs", "waiting", "done", "all"] as const;
export type InboxView = (typeof INBOX_VIEWS)[number];
/** The views shown as chips with their counts. */
export const INBOX_CHIP_VIEWS = ["needs_reply", "mine", "unassigned", "late", "escalated_me", "handoffs", "repairs"] as const satisfies readonly InboxView[];
export const INBOX_SORTS = ["activity", "due", "created", "priority"] as const;
export type InboxSort = (typeof INBOX_SORTS)[number];
export const INBOX_KINDS = ["ticket", "repair"] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

export type InboxFilters = {
  view: InboxView;
  kind: InboxKind | null;
  status: TicketStatus | null;
  priority: TicketPriority | null;
  category: TicketCategory | null;
  channel: TicketChannel | null;
  /** "me", "none" or an employee id. */
  assignee: string | null;
  team: string | null;
  q: string;
  sort: InboxSort;
  page: number;
};

export const INBOX_PAGE_SIZE = 25;
const ID_TEXT = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const TEAM = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u;

const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null => (value && (list as readonly string[]).includes(value) ? (value as T) : null);

export function normalizeTeam(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const team = value.trim().replace(/\s+/g, " ").toLowerCase();
  return TEAM.test(team) ? team : null;
}

export function parseInboxFilters(params: URLSearchParams): InboxFilters {
  const assignee = (params.get("assignee") ?? "").trim();
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    view: oneOf(INBOX_VIEWS, params.get("view")) ?? "open",
    kind: oneOf(INBOX_KINDS, params.get("kind")),
    status: oneOf(TICKET_STATUSES, params.get("status")),
    priority: oneOf(TICKET_PRIORITIES, params.get("priority")),
    category: oneOf(TICKET_CATEGORIES, params.get("category")),
    channel: oneOf(TICKET_CHANNELS, params.get("channel")),
    assignee: assignee === "me" || assignee === "none" || ID_TEXT.test(assignee) ? assignee : null,
    team: normalizeTeam(params.get("team")),
    q: (params.get("q") ?? "").replace(/[\u0000-\u001f‪-‮⁦-⁩]/g, "").trim().slice(0, 80),
    sort: oneOf(INBOX_SORTS, params.get("sort")) ?? "activity",
    page: Number.isFinite(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** "?view=…&…" with every default left out ("" for the defaults). */
export function inboxSearch(filters: Partial<InboxFilters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "open") params.set("view", filters.view);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.status) params.set("status", filters.status);
  if (filters.priority) params.set("priority", filters.priority);
  if (filters.category) params.set("category", filters.category);
  if (filters.channel) params.set("channel", filters.channel);
  if (filters.assignee) params.set("assignee", filters.assignee);
  if (filters.team) params.set("team", filters.team);
  if (filters.q) params.set("q", filters.q);
  if (filters.sort && filters.sort !== "activity") params.set("sort", filters.sort);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** True when anything beyond the view narrows the list. */
export const isFiltered = (filters: InboxFilters): boolean => Boolean(filters.kind || filters.status || filters.priority || filters.category || filters.channel || filters.assignee || filters.team || filters.q);

// ───────────────────────────────────────────────────────────────── canned replies (14.04) — safe variables

/**
 * The only placeholders a canned reply may use, written `{name}`. Their values come from the ticket and its linked
 * records on the server; nothing else in a body is interpreted — no conditions, loops, filters, markup or code.
 */
export const CANNED_VARIABLES = ["customer_name", "ticket_ref", "agent_name", "order_ref", "order_status", "repair_ref", "repair_status", "product_name", "warranty_end", "store_phone"] as const;
export type CannedVariable = (typeof CANNED_VARIABLES)[number];
export const isCannedVariable = (value: string): value is CannedVariable => (CANNED_VARIABLES as readonly string[]).includes(value);

const PLACEHOLDER = /\{([a-z_]{1,40})\}/g;

export type TemplateCheck = { variables: CannedVariable[]; unknown: string[]; code: boolean };

/**
 * What a body uses: its known variables (in order of first use), unknown `{names}`, and whether it holds anything
 * that is not a plain `{name}` placeholder — `{{x}}`, `{x.y}`, `{#if}`, `${x}`, `{% %}`, a lone brace (`code`).
 */
export function checkTemplate(body: string): TemplateCheck {
  const variables: CannedVariable[] = [];
  const unknown: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1];
    if (isCannedVariable(name)) {
      if (!variables.includes(name)) variables.push(name);
    } else if (!unknown.includes(name)) unknown.push(name);
  }
  const rest = body.replace(PLACEHOLDER, "");
  const code = /[{}]/.test(rest) || /\$\{|\{\{|\}\}|<%|%>/.test(body);
  return { variables, unknown, code };
}

/** The body with every known variable that has a value filled in; `missing` = variables used without a value. */
export function fillTemplate(body: string, values: Partial<Record<CannedVariable, string | null>>): { text: string; missing: CannedVariable[] } {
  const missing: CannedVariable[] = [];
  const text = body.replace(PLACEHOLDER, (whole, name: string) => {
    if (!isCannedVariable(name)) return whole;
    const value = values[name];
    if (typeof value === "string" && value.trim() !== "") return value;
    if (!missing.includes(name)) missing.push(name);
    return whole;
  });
  return { text, missing };
}

/** `{name}` placeholders still in a reply about to be recorded (the reviewer must fill or remove them). */
export function unfilledPlaceholders(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(PLACEHOLDER)) if (!out.includes(match[1])) out.push(match[1]);
  return out;
}

export const CANNED_KEY = /^[a-z0-9]+(?:[_-][a-z0-9]+)*$/;

// ───────────────────────────────────────────────────────────────── routing (14.03)

/**
 * A routing rule's `conditions` (ticket_routing_rules.conditions). Match: every list that is given must contain the
 * ticket's value (one keyword is enough); a rule with no conditions matches every ticket. Assignment: `agents` is the
 * pool (employee ids), `capacity` the most open tickets one agent of the pool may hold — the agent with the fewest open
 * tickets under that limit gets the ticket; with the pool full (or no pool) the ticket waits in the rule's team queue.
 * Rules are tried in `sort` order; the first that matches wins.
 */
export type RuleConditions = {
  categories?: TicketCategory[];
  channels?: TicketChannel[];
  priorities?: TicketPriority[];
  keywords?: string[];
  agents?: string[];
  capacity?: number;
};

export const RULE_LIMITS = { keywords: 20, keywordLength: 40, agents: 30, capacityMin: 1, capacityMax: 200, nameMax: 80 } as const;
export const DEFAULT_CAPACITY = 15;

export type TicketFacts = { category: TicketCategory; channel: TicketChannel; priority: TicketPriority; text: string };
export type RuleMatch = { category?: TicketCategory; channel?: TicketChannel; priority?: TicketPriority; keyword?: string };

/** Text compared without case, diacritics, tatweel or the letter variants people mix (أ إ آ ا · ة ه · ى ي), digits Latin. */
export function normalizeMatchText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[٠-٩]/g, (digit) => String("٠١٢٣٤٥٦٧٨٩".indexOf(digit)))
    .replace(/[۰-۹]/g, (digit) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(digit)))
    .replace(/\s+/g, " ")
    .trim();
}

/** Why the rule matches the ticket (an empty object for a catch-all), or null when it does not. */
export function ruleMatches(conditions: RuleConditions, facts: TicketFacts): RuleMatch | null {
  const match: RuleMatch = {};
  if (conditions.categories?.length) {
    if (!conditions.categories.includes(facts.category)) return null;
    match.category = facts.category;
  }
  if (conditions.channels?.length) {
    if (!conditions.channels.includes(facts.channel)) return null;
    match.channel = facts.channel;
  }
  if (conditions.priorities?.length) {
    if (!conditions.priorities.includes(facts.priority)) return null;
    match.priority = facts.priority;
  }
  if (conditions.keywords?.length) {
    const text = normalizeMatchText(facts.text);
    const keyword = conditions.keywords.find((word) => {
      const needle = normalizeMatchText(word);
      return needle !== "" && text.includes(needle);
    });
    if (!keyword) return null;
    match.keyword = keyword;
  }
  return match;
}

export type AgentLoad = { id: string; name: string; open: number };

/**
 * The agent of the pool with the fewest open tickets below the capacity (ties: by name, then id — stable), or null
 * with why: "pool_empty" (nobody in the pool may answer tickets) or "capacity_full".
 */
export function pickAgent(pool: readonly AgentLoad[], capacity: number): { agent: AgentLoad | null; why: "pool_empty" | "capacity_full" | null } {
  if (pool.length === 0) return { agent: null, why: "pool_empty" };
  const free = pool.filter((agent) => agent.open < capacity);
  if (free.length === 0) return { agent: null, why: "capacity_full" };
  const sorted = [...free].sort((a, b) => a.open - b.open || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return { agent: sorted[0], why: null };
}

/** The routing decision as it is written into the audit trail (the ticket page puts it into words). */
export type RouteDecision = {
  ruleId: string | null;
  ruleName: string | null;
  matched: RuleMatch | null;
  team: string | null;
  priority: TicketPriority | null;
  agent: { id: string; name: string; open: number; capacity: number } | null;
  fallback: "no_rule" | "pool_empty" | "capacity_full" | null;
};

// ───────────────────────────────────────────────────────────────── SLA (14.05)

export type SlaClock = "none" | "running" | "late" | "met" | "breached";

/** Where one target stands: no target, still running, late (not done, past due), met, or breached (done late). */
export function slaClock(dueAt: number | null | undefined, doneAt: number | null | undefined, now: number): SlaClock {
  if (!dueAt) return "none";
  if (doneAt) return doneAt <= dueAt ? "met" : "breached";
  return now > dueAt ? "late" : "running";
}

export const SLA_CLOCK_TONE: Record<SlaClock, Tone> = { none: "neutral", running: "info", late: "bad", met: "ok", breached: "bad" };

/** Suggested targets the owner may adopt in one step (minutes, calendar time; never applied without a click). */
export const SUGGESTED_SLA: readonly { priority: TicketPriority; firstResponseMinutes: number; resolutionMinutes: number }[] = [
  { priority: "urgent", firstResponseMinutes: 60, resolutionMinutes: 8 * 60 },
  { priority: "high", firstResponseMinutes: 4 * 60, resolutionMinutes: 24 * 60 },
  { priority: "normal", firstResponseMinutes: 8 * 60, resolutionMinutes: 72 * 60 },
  { priority: "low", firstResponseMinutes: 24 * 60, resolutionMinutes: 5 * 24 * 60 },
];
export const SLA_LIMITS = { minMinutes: 5, maxMinutes: 90 * 24 * 60, nameMax: 80 } as const;

// ───────────────────────────────────────────────────────────────── metrics (14.05)

export const METRIC_DAYS = [7, 30, 90] as const;
export type MetricDays = (typeof METRIC_DAYS)[number];

/** The middle value (the mean of the two middle ones for an even count), or null for no values. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** Nearest-rank percentile (p in 0–100), or null for no values. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

/** A share 0–1, or null when there is nothing to divide (never a 0 that hides "no data"). */
export const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

// ───────────────────────────────────────────────────────────────── escalation (14.07)

export const ESCALATION_KINDS = ["financial", "warranty"] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];
/**
 * Who may receive an escalation: holders of the permission that decides the matter — refunds (module 05) for a
 * financial complaint, warranties (module 12) for a warranty complaint — who can also open the ticket.
 */
export const ESCALATION_PERMISSION: Record<EscalationKind, Permission> = { financial: "orders.refund.approve", warranty: "returns.warranty.manage" };

// ───────────────────────────────────────────────────────────────── knowledge (14.06)

export const ARTICLE_TONE: Record<ContentStatus, Tone> = { draft: "neutral", review: "warn", approved: "ok", archived: "neutral" };
export const ARTICLE_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const ARTICLE_LIMITS = { slugMin: 3, slugMax: 80, titleMax: 140, summaryMax: 300, tags: 12, tagMax: 30 } as const;
export const KNOWLEDGE_VIEWS = ["all", "public", "internal", "review", "draft", "archived"] as const;
export type KnowledgeView = (typeof KNOWLEDGE_VIEWS)[number];

export type KnowledgeFilters = { view: KnowledgeView; q: string };
export function parseKnowledgeFilters(params: URLSearchParams): KnowledgeFilters {
  return { view: oneOf(KNOWLEDGE_VIEWS, params.get("view")) ?? "all", q: (params.get("q") ?? "").trim().slice(0, 60) };
}

export const isContentStatus = (value: string): value is ContentStatus => (CONTENT_STATUSES as readonly string[]).includes(value);
export const isRepairStatus = (value: string): value is RepairStatus => (REPAIR_STATUSES as readonly string[]).includes(value);

// ───────────────────────────────────────────────────────────────── view models

export type PhoneView = { display: string; full: boolean; e164?: string };
export type PersonRef = { id: string; name: string };

export type InboxRow = {
  kind: InboxKind;
  id: string;
  ref: string;
  title: string;
  channel: TicketChannel;
  category: TicketCategory;
  priority: TicketPriority;
  /** A ticket status or (kind "repair") a repair status. */
  status: string;
  handoff: boolean;
  contact: string | null;
  phone: PhoneView | null;
  assigned: PersonRef | null;
  team: string | null;
  createdAt: number;
  activityAt: number;
  due: { at: number; target: "first_response" | "resolution" | "repair"; late: boolean } | null;
  escalatedTo: PersonRef | null;
  escalated: boolean;
  isDemo: boolean;
};

export type InboxCounts = Record<(typeof INBOX_CHIP_VIEWS)[number], number>;

/** Where each of the module's queues opens: the inbox view that lists exactly the counted tickets (supportQueueCounts). */
export const QUEUE_LINKS = {
  escalatedToMe: "/admin/support?view=escalated_me",
  unassigned: "/admin/support?view=unassigned&kind=ticket",
  mineLate: "/admin/support?view=late&kind=ticket&assignee=me",
} as const;

export type InboxPage = {
  rows: InboxRow[];
  total: number;
  page: number;
  pageCount: number;
  filters: InboxFilters;
  counts: InboxCounts;
  teams: string[];
  agents: PersonRef[];
  can: { assign: boolean; reply: boolean; route: boolean };
};

export type SupportQueueCounts = {
  /** Open tickets escalated to this employee (support.ticket.read). */
  escalatedToMe: number | null;
  /** Open tickets nobody holds (support.ticket.assign). */
  unassigned: number | null;
  /** Open tickets of this employee past a due time (support.ticket.reply). */
  mineLate: number | null;
};
