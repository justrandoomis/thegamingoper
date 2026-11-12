/**
 * Admin module 16 "marketing" — client-safe vocabulary: channels, the sending limits, the campaign states and views,
 * what an audience is and why a person is left out of one, the safe variables of a message, URL state of every list,
 * Baghdad days and months, typed numbers (Arabic-Indic and Persian digits accepted) and the view models the pages
 * receive. No database, no server import: pages and services share this file.
 *
 * HONEST BOUNDARIES that shape these types (docs/areas/admin-marketing.md):
 *   · no SMS / WhatsApp / e-mail provider is configured — a released campaign and a cart reminder are messages HELD in
 *     the outbox (`outbox.status = 'held'`), never "sent";
 *   · the storefront records no campaign source — an order is attributed only when it really carries one
 *     (`orders.utm_link_id` / `orders.attribution`), which today none does;
 *   · ad spend is measured nowhere — staff enter it per campaign and month, and every figure says where it comes from.
 */

export const MARKETING_NS = "admin-marketing";

// ───────────────────────────────────────────────────────────────── channels and templates

/** Channels a campaign can message people on (push has no device tokens: not offered). */
export const MESSAGE_CHANNELS = ["sms", "whatsapp", "email"] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];
/** Campaigns that message nobody: they carry a link, a budget and their spend (16.04, 16.07). */
export const TRACKING_CHANNELS = ["social", "ads", "offline"] as const;
export type TrackingChannel = (typeof TRACKING_CHANNELS)[number];
export const CAMPAIGN_CHANNEL_LIST = [...MESSAGE_CHANNELS, ...TRACKING_CHANNELS] as const;
export type CampaignChannelKey = (typeof CAMPAIGN_CHANNEL_LIST)[number];
export const isMessageChannel = (channel: string): channel is MessageChannel => (MESSAGE_CHANNELS as readonly string[]).includes(channel);

/** `outbox.template` of the messages this module holds (their texts belong to the settings module, 22.04 — requested). */
export const CAMPAIGN_TEMPLATE = "marketing_campaign";
export const CART_REMINDER_TEMPLATE = "cart_reminder";
export const MARKETING_TEMPLATES = [CAMPAIGN_TEMPLATE, CART_REMINDER_TEMPLATE] as const;

/** The variables a campaign text may use — anything else is refused when the campaign is saved. */
export const CAMPAIGN_VARIABLES = ["name", "link", "store"] as const;
export type CampaignVariable = (typeof CAMPAIGN_VARIABLES)[number];
/** Longest text per channel (sms: one long SMS, the settings module's TEMPLATE_MAX_LENGTH). */
export const BODY_MAX: Record<MessageChannel, number> = { sms: 640, whatsapp: 1000, email: 4000 };
export const SUBJECT_MAX = 120;
export const MESSAGE_LOCALES = ["ar", "en", "ckb"] as const;
export type MessageLocale = (typeof MESSAGE_LOCALES)[number];

// ───────────────────────────────────────────────────────────────── sending limits (16.01, 16.02)

/**
 * Marketing messages (campaigns and cart reminders together) one person may be held at most, per rolling window.
 * Checked when the audience is counted AND inside the write (a message that would pass the limit is not written).
 */
export const SEND_LIMITS = { windowDays: 7, maxPerWindow: 2 } as const;
/** The most people one campaign reaches; a larger audience is refused (narrow it). */
export const MAX_AUDIENCE = 5_000;
/** Recipients written per batch while a campaign is released. */
export const RELEASE_CHUNK = 250;
/** Abandoned-cart reminders (16.02): which carts, how often, when. */
export const CART_RECOVERY = {
  /** A cart untouched for at least this long counts as left. */
  idleHours: 2,
  /** Older carts are not reminded any more. */
  maxAgeDays: 7,
  /** One reminder per person in this many days, whatever the cart. */
  perPersonDays: 7,
  /** One reminder per cart, ever (`cart_reminders.step` 1). */
  stepsPerCart: 1,
  /** Quiet hours (Baghdad): a reminder prepared between these hours is scheduled for the morning. */
  quietFrom: 21,
  quietTo: 9,
  /** Carts one run prepares at most. */
  maxPerRun: 100,
} as const;

// ───────────────────────────────────────────────────────────────── audiences (16.01, 16.03)

/** Who a campaign is for: module 07's segment and/or what they bought (platform and purchase dates). */
export type AudienceSpec = {
  /** `customer_segments.id` (module 07's stored segments) or null. */
  segmentId: string | null;
  /** `platforms.id` of what they bought; empty = any platform. */
  platformIds: string[];
  /** Bought between these Baghdad days (inclusive); null = no bound. */
  boughtFrom: string | null;
  boughtTo: string | null;
  /** Include people who bought as guests (their number's checkout answers count). */
  guests: boolean;
};
export const EMPTY_AUDIENCE: AudienceSpec = { segmentId: null, platformIds: [], boughtFrom: null, boughtTo: null, guests: true };

/**
 * Why a person is left out of an audience — the first reason that applies, in this order. "changed" is counted only
 * by a release: the person passed when the audience was counted, but the check INSIDE the write refused them (a "no",
 * a closed account or the limit landed in between) — so held + every reason always equals the people considered.
 */
export const EXCLUSION_REASONS = ["account_closed", "blocked", "demo_mismatch", "no_consent", "consent_withdrawn", "channel_off", "no_address", "frequency_cap", "duplicate", "changed"] as const;
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number];
export const emptyExclusions = (): Record<ExclusionReason, number> => Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])) as Record<ExclusionReason, number>;

/** Where a consent answer was given (`consents.source`), as the pages name it; anything else is "other". */
export const CONSENT_SOURCES = ["checkout", "account", "banner", "assistant", "admin", "merge", "onboarding"] as const;
export const consentSourceKey = (source: string | null | undefined): string => (source && (CONSENT_SOURCES as readonly string[]).includes(source) ? source : "other");

/** Order states that count as "bought" for an audience (placed and accepted; not cancelled or sent back). */
export const BOUGHT_STATUSES = ["confirmed", "preparing", "shipped", "delivered"] as const;

// ───────────────────────────────────────────────────────────────── campaigns

/** A campaign as staff see it, derived from the stored status, the waiting request and the schedule. */
export const CAMPAIGN_STATES = ["draft", "pending", "scheduled", "due", "released", "tracking", "completed", "cancelled"] as const;
export type CampaignState = (typeof CAMPAIGN_STATES)[number];
export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";
export const CAMPAIGN_STATE_TONE: Record<CampaignState, Tone> = {
  draft: "neutral",
  pending: "warn",
  scheduled: "info",
  due: "warn",
  released: "info",
  tracking: "info",
  completed: "ok",
  cancelled: "neutral",
};

/**
 * "decide" = the requests this employee may decide (the bell's link); "pending" = every waiting request; "due" =
 * approved message campaigns whose time has come (the front page's "due" figure opens exactly this list).
 */
export const CAMPAIGN_VIEWS = ["all", "decide", "draft", "pending", "scheduled", "due", "released", "closed"] as const;
export type CampaignView = (typeof CAMPAIGN_VIEWS)[number];
export type CampaignFilters = { view: CampaignView; q: string; channel: CampaignChannelKey | null; demo: boolean; page: number };

/** The approvals kind of a campaign request (approvals.kind). */
export const CAMPAIGN_APPROVAL_KIND = "marketing_campaign";

export type SpendEntry = { id: string; period: string; amountIqd: number; reference: string | null; note: string; by: string | null; at: number };
export type ReleaseStats = { at: number; by: string | null; held: number; skipped: number; excluded: Record<ExclusionReason, number>; candidates: number; complete: boolean };

/** What campaigns.content holds. */
export type CampaignContent = {
  audience?: AudienceSpec;
  body?: Partial<Record<MessageLocale, string>>;
  subject?: Partial<Record<MessageLocale, string>>;
  linkId?: string | null;
  notes?: string | null;
  startsOn?: string | null;
  endsOn?: string | null;
  spend?: SpendEntry[];
  release?: ReleaseStats | null;
  closedAt?: number | null;
};

export type CampaignRow = {
  id: string;
  name: string;
  channel: CampaignChannelKey;
  state: CampaignState;
  isDemo: boolean;
  scheduledAt: number | null;
  budgetIqd: number | null;
  spendIqd: number;
  utmCampaign: string | null;
  createdAt: number;
  updatedAt: number;
  createdBy: string | null;
  held: number | null;
};

export type ApprovalView = {
  id: string;
  requestedBy: string | null;
  requestedByName: string | null;
  reason: string | null;
  createdAt: number;
  fingerprint: string;
  mine: boolean;
  /** This employee may decide it (marketing.campaign.send, not the requester, never edited the campaign). */
  canDecide: boolean;
  /** Why not, when they hold the permission. */
  blockedBy: "requester" | "editor" | null;
};

export type RecipientSample = { key: string; name: string | null; phone: { display: string; full: boolean } | null; email: string | null; profileId: string | null; guest: boolean; consentAt: number | null; consentSource: string | null };

export type AudiencePreview = {
  candidates: number;
  eligible: number;
  excluded: Record<ExclusionReason, number>;
  sample: RecipientSample[];
  truncated: boolean;
  /** Module 07's segment, when one is chosen: its name, members and when it was last computed. */
  segment: { id: string; name: string; members: number; computedAt: number | null } | null;
};

export type HistoryRow = { id: string; action: string; actor: string | null; at: number; reason: string | null };

export type LinkOption = { id: string; code: string; url: string; targetPath: string; source: string; medium: string };

export type CampaignDetail = CampaignRow & {
  content: CampaignContent;
  segmentId: string | null;
  fingerprint: string;
  approval: ApprovalView | null;
  lastDecision: { status: "approved" | "rejected"; by: string | null; note: string | null; at: number | null } | null;
  recipients: { held: number; pending: number; sent: number; failed: number; skipped: number };
  links: LinkOption[];
  history: HistoryRow[];
  can: { edit: boolean; submit: boolean; withdraw: boolean; release: boolean; cancel: boolean; close: boolean; spend: boolean };
};

export type RecipientRow = { id: string; name: string | null; phone: { display: string; full: boolean } | null; email: string | null; status: string; profileId: string | null };

// ───────────────────────────────────────────────────────────────── carts (16.02)

export const CART_VERDICTS = ["eligible", "reminded", "guest_cart", "account_closed", "blocked", "no_consent", "consent_withdrawn", "channel_off", "no_address", "recent_order", "nothing_available", "person_limit", "frequency_cap"] as const;
export type CartVerdict = (typeof CART_VERDICTS)[number];
export const CART_VIEWS = ["eligible", "all", "reminded"] as const;
export type CartView = (typeof CART_VIEWS)[number];
export type CartFilters = { view: CartView; demo: boolean; page: number };
export type CartRow = {
  id: string;
  customer: { name: string | null; phone: { display: string; full: boolean } | null; profileId: string | null; isDemo: boolean } | null;
  lines: number;
  units: number;
  valueIqd: number | null;
  updatedAt: number;
  verdict: CartVerdict;
  reminder: { status: string; scheduledAt: number; createdAt: number; converted: boolean } | null;
};

// ───────────────────────────────────────────────────────────────── cross-sell (16.05)

/** Shelves a cross-sell rule can target ("" = every shelf with the device: setup shelves and related products). */
export const CROSS_SELL_PLACEMENTS = ["", "device_hub:setup", "product:setup", "cart:setup", "post_purchase:setup", "product:related"] as const;
export type CrossSellPlacement = (typeof CROSS_SELL_PLACEMENTS)[number];
export const RULE_KINDS = ["pin", "boost", "exclude"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
/** Products that may be suggested with a device (the recommendation engine's add-on kinds). */
export const ADDON_KINDS = ["controller", "headset", "storage", "accessory", "digital", "part", "bundle"] as const;
export const RULE_WEIGHT_MAX = 100;
export type RuleEffect = "shows" | "not_verified" | "partial" | "incompatible" | "unverified" | "not_published" | "out_of_stock" | "inactive" | "ended" | "not_started" | "removes";

// ───────────────────────────────────────────────────────────────── reviews (16.06)

export const REVIEW_VIEWS = ["pending", "approved", "rejected", "all"] as const;
export type ReviewView = (typeof REVIEW_VIEWS)[number];
export const REJECT_CODES = ["abusive", "personal_data", "off_topic", "spam", "not_about_product", "other"] as const;
export type RejectCode = (typeof REJECT_CODES)[number];

// ───────────────────────────────────────────────────────────────── error keys

export const MARKETING_ERROR_KEYS = [
  "campaign_changed",
  "campaign_not_draft",
  "campaign_not_due",
  "campaign_not_message",
  "campaign_closed",
  "change_pending",
  "change_not_pending",
  "approver_is_requester",
  "approver_edited",
  "audience_empty",
  "audience_too_large",
  "link_required",
  "link_not_campaign",
  "utm_taken",
  "spend_below_zero",
  "idempotency_mismatch",
  "review_changed",
  "review_not_verified",
  "purchase_not_verified",
  "rule_not_verified",
  "rule_changed",
  "product_not_addon",
  "device_required",
  "nothing_to_prepare",
  "segment_unknown",
] as const;
export type MarketingErrorKey = (typeof MARKETING_ERROR_KEYS)[number];

// ───────────────────────────────────────────────────────────────── numbers and digits

/** Arabic-Indic and Persian digits as 0–9 (what a phone keyboard types in Arabic). */
export function latinDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/**
 * A typed whole number ("25,000", "٢٥٬٠٠٠", "25 000", "-5000") → the number; NaN for anything else (a fraction, a
 * stray mark — never silently a different number); undefined when empty.
 */
export function parseWhole(value: unknown, options: { negative?: boolean } = {}): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : Number.NaN;
  if (typeof value !== "string") return undefined;
  const text = latinDigits(value).replace(/[\s,٬،']/g, "").replace(/^[−–]/, "-");
  if (text === "") return undefined;
  const pattern = options.negative ? /^-?\d{1,12}$/ : /^\d{1,12}$/;
  return pattern.test(text) ? Number(text) : Number.NaN;
}

// ───────────────────────────────────────────────────────────────── Baghdad days and months (UTC+3, no DST)

const BAGHDAD_MS = 3 * 3_600_000;
export const DAY_MS = 86_400_000;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;
const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** "YYYY-MM-DD" of an instant, in Baghdad. */
export function baghdadDay(ms: number): string {
  return new Date(ms + BAGHDAD_MS).toISOString().slice(0, 10);
}
/** "YYYY-MM" of an instant, in Baghdad. */
export function baghdadMonth(ms: number): string {
  return baghdadDay(ms).slice(0, 7);
}
/** Midnight (Baghdad) that starts a day, as epoch ms; null for anything that is not a real day. */
export function dayStart(day: string | null | undefined): number | null {
  const match = typeof day === "string" ? DAY_RE.exec(latinDigits(day.trim())) : null;
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(y, m - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return ms - BAGHDAD_MS;
}
/** A day as typed ("2026-11-12", Arabic-Indic digits too) → "YYYY-MM-DD", or null. */
export function normalizeDay(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const day = latinDigits(value.trim());
  return dayStart(day) === null ? null : day;
}
/** A month "YYYY-MM" (Arabic-Indic digits too) → itself, or null. */
export function normalizeMonth(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = MONTH_RE.exec(latinDigits(value.trim()));
  if (!match) return null;
  const month = Number(match[2]);
  return month >= 1 && month <= 12 && Number(match[1]) >= 2000 && Number(match[1]) <= 2100 ? `${match[1]}-${match[2]}` : null;
}
/** Midnight (Baghdad) that starts a month. */
export function monthStart(period: string): number {
  const [y, m] = period.split("-").map(Number);
  return Date.UTC(y, m - 1, 1) - BAGHDAD_MS;
}
/** The month `n` months after `period` (n may be negative). */
export function addMonths(period: string, n: number): string {
  const [y, m] = period.split("-").map(Number);
  const index = y * 12 + (m - 1) + n;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}
/** Every month from `from` to `to`, inclusive (at most 24). */
export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let period = from; period <= to && out.length < 24; period = addMonths(period, 1)) out.push(period);
  return out;
}
/** An instant as the value of a datetime-local input in Baghdad ("2026-11-12T09:30"). */
export function toLocalInput(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  return new Date(ms + BAGHDAD_MS).toISOString().slice(0, 16);
}
/** A datetime-local value read as Baghdad time → epoch ms; null when it is not one. */
export function fromLocalInput(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = LOCAL_RE.exec(latinDigits(value.trim()));
  if (!match) return null;
  const [y, mo, d, h, mi] = match.slice(1).map(Number);
  if (h > 23 || mi > 59) return null;
  const ms = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(ms);
  if (back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return ms - BAGHDAD_MS;
}
/** The Baghdad hour of an instant (0–23). */
export function baghdadHour(ms: number): number {
  return new Date(ms + BAGHDAD_MS).getUTCHours();
}

// ───────────────────────────────────────────────────────────────── URL state

const one = <T extends string>(list: readonly T[], value: string | null | undefined, fallback: T): T => (value && (list as readonly string[]).includes(value) ? (value as T) : fallback);
const pageOf = (value: string | null): number => {
  const n = Number(latinDigits(value ?? "1"));
  return Number.isSafeInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
};
const flagOf = (value: string | null): boolean => value === "1" || value === "true" || value === "on";
const queryOf = (entries: Record<string, string | number | boolean | null | undefined | readonly string[]>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(entries)) {
    if (Array.isArray(value)) for (const entry of value) params.append(name, String(entry));
    else if (value === true) params.set(name, "1");
    else if (value !== null && value !== undefined && value !== false && value !== "") params.set(name, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
};

export function parseCampaignFilters(params: URLSearchParams): CampaignFilters {
  const channel = params.get("channel");
  return {
    view: one(CAMPAIGN_VIEWS, params.get("view"), "all"),
    q: (params.get("q") ?? "").trim().slice(0, 80),
    channel: channel && (CAMPAIGN_CHANNEL_LIST as readonly string[]).includes(channel) ? (channel as CampaignChannelKey) : null,
    demo: flagOf(params.get("demo")),
    page: pageOf(params.get("page")),
  };
}
export function campaignSearch(filters: CampaignFilters): string {
  return queryOf({ view: filters.view === "all" ? null : filters.view, q: filters.q, channel: filters.channel, demo: filters.demo, page: filters.page > 1 ? filters.page : null });
}

export function parseCartFilters(params: URLSearchParams): CartFilters {
  return { view: one(CART_VIEWS, params.get("view"), "eligible"), demo: flagOf(params.get("demo")), page: pageOf(params.get("page")) };
}
export function cartSearch(filters: CartFilters): string {
  return queryOf({ view: filters.view === "eligible" ? null : filters.view, demo: filters.demo, page: filters.page > 1 ? filters.page : null });
}

export type AudienceQuery = AudienceSpec & { demo: boolean };
/** The segmentation explorer's URL (16.03) — also what "start a campaign with this audience" carries. */
export function parseAudienceQuery(params: URLSearchParams): AudienceQuery {
  const platformIds = [...new Set(params.getAll("platform").map((value) => value.trim()).filter((value) => /^[A-Za-z0-9_.:-]{1,64}$/.test(value)))].slice(0, 10);
  const segment = (params.get("segment") ?? "").trim();
  // a submitted form ("f=1") without the box ticked means "no guests"; a bare link means the default (guests in)
  const submitted = params.get("f") === "1";
  return {
    segmentId: /^[A-Za-z0-9_.:-]{1,64}$/.test(segment) ? segment : null,
    platformIds,
    boughtFrom: normalizeDay(params.get("from")),
    boughtTo: normalizeDay(params.get("to")),
    guests: params.has("guests") ? flagOf(params.get("guests")) : !submitted,
    demo: flagOf(params.get("demo")),
  };
}
export function audienceSearch(query: AudienceQuery): string {
  return queryOf({ platform: query.platformIds, from: query.boughtFrom, to: query.boughtTo, segment: query.segmentId, guests: query.guests ? null : "0", demo: query.demo });
}

export type LinkFilters = { q: string; campaign: string | null; page: number };
export function parseLinkFilters(params: URLSearchParams): LinkFilters {
  const campaign = (params.get("campaign") ?? "").trim();
  return { q: (params.get("q") ?? "").trim().slice(0, 60), campaign: /^[A-Za-z0-9_.:-]{1,64}$/.test(campaign) ? campaign : null, page: pageOf(params.get("page")) };
}

/** A range of Baghdad days ("from", "to" inclusive) with a default of the last 30 days; at most 400 days. */
export type DayRange = { from: string; to: string; demo: boolean };
export function parseDayRange(params: URLSearchParams, now: number, defaultDays = 30): DayRange {
  const today = baghdadDay(now);
  let to = normalizeDay(params.get("to")) ?? today;
  if (to > today) to = today;
  const fallbackFrom = baghdadDay((dayStart(to) ?? now) - (defaultDays - 1) * DAY_MS);
  let from = normalizeDay(params.get("from")) ?? fallbackFrom;
  if (from > to) from = to;
  const span = ((dayStart(to) ?? 0) - (dayStart(from) ?? 0)) / DAY_MS;
  if (span > 399) from = baghdadDay((dayStart(to) ?? now) - 399 * DAY_MS);
  return { from, to, demo: flagOf(params.get("demo")) };
}

/** A range of months for the performance report (16.07): default the last three months, at most 24. */
export type MonthRange = { from: string; to: string; demo: boolean };
export function parseMonthRange(params: URLSearchParams, now: number): MonthRange {
  const current = baghdadMonth(now);
  let to = normalizeMonth(params.get("to")) ?? current;
  if (to > current) to = current;
  let from = normalizeMonth(params.get("from")) ?? addMonths(to, -2);
  if (from > to) from = to;
  if (monthsBetween(from, to).length >= 24 && addMonths(from, 23) < to) from = addMonths(to, -23);
  return { from, to, demo: flagOf(params.get("demo")) };
}
export function monthRangeSearch(range: MonthRange): string {
  return queryOf({ from: range.from, to: range.to, demo: range.demo });
}

export type RuleFilters = { device: string | null; kind: RuleKind | null; active: "active" | "inactive" | "all"; page: number };
export function parseRuleFilters(params: URLSearchParams): RuleFilters {
  const device = (params.get("device") ?? "").trim();
  const kind = params.get("kind");
  return {
    device: /^[A-Za-z0-9_.:-]{1,64}$/.test(device) ? device : null,
    kind: kind && (RULE_KINDS as readonly string[]).includes(kind) ? (kind as RuleKind) : null,
    active: one(["active", "inactive", "all"] as const, params.get("active"), "active"),
    page: pageOf(params.get("page")),
  };
}
export function ruleSearch(filters: RuleFilters): string {
  return queryOf({ device: filters.device, kind: filters.kind, active: filters.active === "active" ? null : filters.active, page: filters.page > 1 ? filters.page : null });
}

export type ReviewFilters = { view: ReviewView; rating: number | null; verified: "all" | "yes" | "no"; q: string; page: number };
export function parseReviewFilters(params: URLSearchParams): ReviewFilters {
  const rating = Number(latinDigits(params.get("rating") ?? ""));
  return {
    view: one(REVIEW_VIEWS, params.get("view"), "pending"),
    rating: Number.isInteger(rating) && rating >= 1 && rating <= 5 ? rating : null,
    verified: one(["all", "yes", "no"] as const, params.get("verified"), "all"),
    q: (params.get("q") ?? "").trim().slice(0, 80),
    page: pageOf(params.get("page")),
  };
}
export function reviewSearch(filters: ReviewFilters): string {
  return queryOf({ view: filters.view === "pending" ? null : filters.view, rating: filters.rating, verified: filters.verified === "all" ? null : filters.verified, q: filters.q, page: filters.page > 1 ? filters.page : null });
}

// ───────────────────────────────────────────────────────────────── small pure helpers

/** A first name: letters and their marks (any script), with an inner apostrophe, hyphen or zero-width non-joiner. */
const NAME_WORD = /^[\p{L}\p{M}](?:[\p{L}\p{M}'’‌-]*[\p{L}\p{M}])?$/u;

/**
 * The first word of a name ("سارة الربيعي" → "سارة"), for a greeting; null without one. {name} is filled from what a
 * shopper typed (a guest checkout's name is anyone's to type), so only a word made of letters counts: a web address,
 * a number, a code or a mark ("tamtam-gift.com", "0770…") is never put into the store's text — the neutral word is.
 */
export function firstName(name: string | null | undefined): string | null {
  const word = (name ?? "").trim().split(/\s+/)[0] ?? "";
  return word.length > 0 && word.length <= 40 && NAME_WORD.test(word) ? word : null;
}

/** A slug for UTM values: lower-case Latin letters, digits, "-", "_" and ".", 1–60 characters. */
export const UTM_VALUE = /^[a-z0-9][a-z0-9_.-]{0,59}$/;
export function utmValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = latinDigits(value.trim()).toLowerCase().replace(/\s+/g, "-");
  return text === "" ? null : text;
}

/** ROAS, CAC and LTV as ratios: null (never 0, NaN or Infinity) when the denominator is missing. */
export function ratio(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || !Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return null;
  return numerator / denominator;
}
