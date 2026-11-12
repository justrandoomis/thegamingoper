/**
 * Admin module 07 "Customers & CRM" — client-safe constants, URL state, the explained rules (RFM, VIP, fraud risk,
 * complaints) and the view models shared by the services in this folder and the route modules in
 * app/routes/admin/customers. No database, no server-only imports.
 *
 * Every rule here is a fixed, written threshold so a person can read why a customer carries a label: the screens show
 * the rule and the customer's own numbers next to it (never a score without its reason). They are module constants
 * until settings (22) owns them.
 */
import { toLatinDigits } from "~/lib/phone";

export const CUSTOMERS_NS = "admin-customers";
export const PAGE_SIZE = 25;
/** D1 refuses LIKE patterns much longer than this (the orders module found ~50 bytes). */
export const MAX_SEARCH_CHARS = 40;

export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";

// ───────────────────────────────────────────────────────────────── statuses

export const CUSTOMER_STATUS_LIST = ["active", "blocked", "merged", "deleted"] as const;
export type CustomerStatusKey = (typeof CUSTOMER_STATUS_LIST)[number];
export const CUSTOMER_STATUS_TONE: Record<CustomerStatusKey, Tone> = { active: "ok", blocked: "bad", merged: "neutral", deleted: "neutral" };

export const ORDER_STATUS_TONE: Record<string, Tone> = {
  new: "warn",
  awaiting_payment: "warn",
  payment_review: "warn",
  confirmed: "info",
  preparing: "info",
  shipped: "info",
  delivered: "ok",
  cancelled: "neutral",
  returned: "neutral",
};
/** Orders still moving (the customer is waiting for something). */
export const OPEN_ORDER_STATUSES = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing", "shipped"] as const;

// ───────────────────────────────────────────────────────────────── RFM (07.02)

/**
 * A purchase is an order the store was paid for and did not pay back in full: `paid_iqd − refunded_iqd > 0` (a
 * cancelled order never counts). Recency = days since the last purchase, frequency = purchases, monetary = Σ of what
 * was kept (paid − refunded), in IQD. Each axis scores 1–5 by these bounds; 0 = no purchase.
 */
export const RFM_RULES = {
  /** R: last purchase within … days → 5, 4, 3, 2; older → 1. */
  recencyDays: [30, 90, 180, 365],
  /** F: at least … purchases → 2, 3, 4, 5 (one purchase → 1). */
  frequency: [2, 3, 5, 10],
  /** M: at least … IQD kept → 2, 3, 4, 5 (less → 1). */
  monetaryIqd: [100_000, 300_000, 750_000, 2_000_000],
} as const;

/** Four ascending bounds (an axis's scores 5…2 or 2…5). */
export type Bounds4 = readonly [number, number, number, number];
/**
 * The RFM bounds in force: the setting `customers.rfm_rules` (module follow-up 2026-11-12; rules.server.ts reads it),
 * RFM_RULES its default. The pure functions below take them as an optional last argument (RFM_RULES when left out).
 */
export type RfmRules = { readonly recencyDays: Bounds4; readonly frequency: Bounds4; readonly monetaryIqd: Bounds4 };

export type RfmScore = 0 | 1 | 2 | 3 | 4 | 5;
export type RfmFacts = { purchases: number; monetaryIqd: number; lastPurchaseAt: number | null };
export type Rfm = { r: RfmScore; f: RfmScore; m: RfmScore; recencyDays: number | null; frequency: number; monetaryIqd: number; segment: RfmSegment };

const DAY_MS = 24 * 60 * 60 * 1000;

export function scoreRecency(days: number | null, bounds: Bounds4 = RFM_RULES.recencyDays): RfmScore {
  if (days === null || !Number.isFinite(days)) return 0;
  const [a, b, c, d] = bounds;
  return days <= a ? 5 : days <= b ? 4 : days <= c ? 3 : days <= d ? 2 : 1;
}

export function scoreFrequency(purchases: number, bounds: Bounds4 = RFM_RULES.frequency): RfmScore {
  if (!(purchases > 0)) return 0;
  const [a, b, c, d] = bounds;
  return purchases >= d ? 5 : purchases >= c ? 4 : purchases >= b ? 3 : purchases >= a ? 2 : 1;
}

export function scoreMonetary(iqd: number, purchases: number, bounds: Bounds4 = RFM_RULES.monetaryIqd): RfmScore {
  if (!(purchases > 0)) return 0;
  const [a, b, c, d] = bounds;
  return iqd >= d ? 5 : iqd >= c ? 4 : iqd >= b ? 3 : iqd >= a ? 2 : 1;
}

export const RFM_SEGMENTS = ["champions", "loyal", "new", "promising", "need_attention", "cant_lose", "at_risk", "hibernating", "lost", "none"] as const;
export type RfmSegment = (typeof RFM_SEGMENTS)[number];
export const RFM_SEGMENT_TONE: Record<RfmSegment, Tone> = {
  champions: "ok",
  loyal: "ok",
  new: "info",
  promising: "info",
  need_attention: "warn",
  cant_lose: "bad",
  at_risk: "warn",
  hibernating: "neutral",
  lost: "neutral",
  none: "neutral",
};

/**
 * The segment map (recency × frequency; monetary is shown beside it). Written as rules, in this order — the first
 * that matches wins:
 *   none            no purchase yet
 *   champions       R ≥ 4 and F ≥ 4          bought recently and often
 *   loyal           R ≥ 3 and F ≥ 3          buys regularly
 *   new             R = 5 and F = 1          first purchase in the last 30 days
 *   promising       R ≥ 4 and F ≤ 2          recent, few purchases
 *   need_attention  R = 3 and F ≤ 2          a while ago, few purchases
 *   cant_lose       R ≤ 2 and F ≥ 4          bought often, not for a long time
 *   at_risk         R = 2 and F = 2–3        used to buy, not for six months
 *   hibernating     R = 2 and F = 1          one purchase, six months to a year ago
 *   lost            R = 1                     nothing for more than a year
 */
export function segmentOf(r: RfmScore, f: RfmScore): RfmSegment {
  if (r === 0 || f === 0) return "none";
  if (r >= 4 && f >= 4) return "champions";
  if (r >= 3 && f >= 3) return "loyal";
  if (r === 5 && f === 1) return "new";
  if (r >= 4) return "promising";
  if (r === 3) return "need_attention";
  if (f >= 4) return "cant_lose";
  if (r === 2) return f === 1 ? "hibernating" : "at_risk";
  return "lost";
}

export function rfmOf(facts: RfmFacts, now: number, rules: RfmRules = RFM_RULES): Rfm {
  const recencyDays = facts.lastPurchaseAt === null ? null : Math.max(0, Math.floor((now - facts.lastPurchaseAt) / DAY_MS));
  const r = facts.purchases > 0 ? scoreRecency(recencyDays, rules.recencyDays) : 0;
  const f = scoreFrequency(facts.purchases, rules.frequency);
  const m = scoreMonetary(facts.monetaryIqd, facts.purchases, rules.monetaryIqd);
  return { r, f, m, recencyDays: facts.purchases > 0 ? recencyDays : null, frequency: facts.purchases, monetaryIqd: facts.monetaryIqd, segment: segmentOf(r, f) };
}

/** The segments table's key for an RFM segment (`customer_segments.key`). */
export const rfmSegmentKey = (segment: RfmSegment) => `rfm.${segment}`;

// ───────────────────────────────────────────────────────────────── VIP, fraud risk, complaints (07.06)

export const FLAG_RULES = {
  /** VIP: kept at least this much over the window… */
  vipSpendIqd: 2_000_000,
  /** …or at least this many purchases over the window. */
  vipPurchases: 5,
  vipWindowDays: 365,
  /** Risk: this many cancelled orders (not paid, or paid back) over the window — the orders module's phone rule. */
  riskCancelled: 2,
  riskCancelledDays: 90,
  /** Risk: this many rejected transfer proofs over the window. */
  riskRejectedProofs: 2,
  riskRejectedDays: 90,
  /** Risk: this many orders sent back (status "returned") over the window. */
  riskReturned: 2,
  riskReturnedDays: 180,
} as const;

/** The VIP and fraud-risk thresholds in force: the setting `customers.flag_rules` (rules.server.ts), FLAG_RULES its default. */
export type FlagRules = { readonly [K in keyof typeof FLAG_RULES]: number };

export const FLAG_IDS = [
  "vip_manual",
  "vip_spend",
  "vip_purchases",
  "risk_manual",
  "risk_cancelled",
  "risk_rejected_proofs",
  "risk_returned",
  "risk_duplicate_proof",
  "complaint_open",
] as const;
export type FlagId = (typeof FLAG_IDS)[number];
export type FlagKind = "vip" | "risk" | "complaint";
export const flagKind = (id: FlagId): FlagKind => (id.startsWith("vip_") ? "vip" : id.startsWith("risk_") ? "risk" : "complaint");
/** A label on a customer with the numbers that explain it (`vars` fill the sentence). */
export type CustomerFlag = { id: FlagId; vars: Record<string, string | number> };

// ───────────────────────────────────────────────────────────────── list (URL state)

export const CUSTOMER_VIEWS = ["all", "vip", "risk", "complaints", "blocked", "new", "no_purchase"] as const;
export type CustomerView = (typeof CUSTOMER_VIEWS)[number];
/** "new": accounts opened in the last … days. */
export const NEW_ACCOUNT_DAYS = 30;
export const CUSTOMER_SORTS = ["joined", "last_order", "spent", "purchases", "name"] as const;
export type CustomerSort = (typeof CUSTOMER_SORTS)[number];

export type CustomerFilters = {
  q: string;
  view: CustomerView;
  status: CustomerStatusKey | null;
  segment: RfmSegment | null;
  sort: CustomerSort;
  page: number;
};

const pick = <T extends string>(list: readonly T[], value: string | null | undefined): T | null => (value && (list as readonly string[]).includes(value) ? (value as T) : null);

/** The search text as typed (trimmed, Latin digits, at most MAX_SEARCH_CHARS). */
export function searchText(raw: string | null | undefined): string {
  return toLatinDigits(String(raw ?? ""))
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, MAX_SEARCH_CHARS);
}

export function pageNumber(raw: string | null | undefined): number {
  const n = Number(toLatinDigits(String(raw ?? "")));
  return Number.isSafeInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
}

export function parseCustomerFilters(params: URLSearchParams): CustomerFilters {
  return {
    q: searchText(params.get("q")),
    view: pick(CUSTOMER_VIEWS, params.get("view")) ?? "all",
    status: pick(CUSTOMER_STATUS_LIST, params.get("status")),
    segment: pick(RFM_SEGMENTS, params.get("segment")),
    sort: pick(CUSTOMER_SORTS, params.get("sort")) ?? "joined",
    page: pageNumber(params.get("page")),
  };
}

/** "?view=vip&q=…" — only what differs from the defaults (shareable, works without JavaScript). */
export function customerSearch(filters: Partial<CustomerFilters>): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.view && filters.view !== "all") params.set("view", filters.view);
  if (filters.status) params.set("status", filters.status);
  if (filters.segment) params.set("segment", filters.segment);
  if (filters.sort && filters.sort !== "joined") params.set("sort", filters.sort);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

// ───────────────────────────────────────────────────────────────── consents and privacy (07.04)

export const CONSENT_KIND_LIST = ["marketing", "personalization", "analytics", "support_log"] as const;
export type ConsentKindKey = (typeof CONSENT_KIND_LIST)[number];

export const PRIVACY_KIND_LIST = ["export", "delete", "rectify", "unsubscribe"] as const;
export type PrivacyKind = (typeof PRIVACY_KIND_LIST)[number];
export const PRIVACY_STATUS_LIST = ["open", "verifying", "in_progress", "completed", "rejected"] as const;
export type PrivacyStatus = (typeof PRIVACY_STATUS_LIST)[number];
export const PRIVACY_OPEN_STATUSES = ["open", "verifying", "in_progress"] as const satisfies readonly PrivacyStatus[];
export const PRIVACY_STATUS_TONE: Record<PrivacyStatus, Tone> = { open: "warn", verifying: "warn", in_progress: "info", completed: "ok", rejected: "neutral" };
/** The store's own target for answering a privacy request (not a legal deadline — none is configured). */
export const PRIVACY_DUE_DAYS = 30;
/** How the person asking was confirmed to be the account holder. */
export const VERIFY_METHODS = ["call_back", "in_store_id", "signed_in", "written_request"] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

export const CONSENT_FILTERS = ["all", "granted", "withdrawn"] as const;
export type ConsentFilter = (typeof CONSENT_FILTERS)[number];

export type ConsentLogFilters = { q: string; kind: ConsentKindKey | null; answer: ConsentFilter; source: string | null; page: number };

export function parseConsentFilters(params: URLSearchParams): ConsentLogFilters {
  const source = searchText(params.get("source")).replace(/[^A-Za-z0-9_:.-]/g, "").slice(0, 40);
  return { q: searchText(params.get("q")), kind: pick(CONSENT_KIND_LIST, params.get("kind")), answer: pick(CONSENT_FILTERS, params.get("answer")) ?? "all", source: source || null, page: pageNumber(params.get("page")) };
}

export function consentSearch(filters: Partial<ConsentLogFilters>): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.answer && filters.answer !== "all") params.set("answer", filters.answer);
  if (filters.source) params.set("source", filters.source);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const PRIVACY_VIEWS = ["open", "overdue", "done", "all"] as const;
export type PrivacyView = (typeof PRIVACY_VIEWS)[number];
export type PrivacyFilters = { view: PrivacyView; kind: PrivacyKind | null; page: number };

export function parsePrivacyFilters(params: URLSearchParams): PrivacyFilters {
  return { view: pick(PRIVACY_VIEWS, params.get("view")) ?? "open", kind: pick(PRIVACY_KIND_LIST, params.get("kind")), page: pageNumber(params.get("page")) };
}

export function privacySearch(filters: Partial<PrivacyFilters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "open") params.set("view", filters.view);
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** What an erasure removes, and what it keeps (and why) — shown in the plan before anyone confirms (privacy.server.ts). */
export const RETENTION = {
  // follow-up 2026-11-12: + the stored maintenance-assistant conversations and the sign-in log, which used to wait for
  // their own retention (30 / 90 days) after an erasure
  erased: ["profile", "mergedAccounts", "addresses", "savedDevices", "wishlist", "recentlyViewed", "browsing", "notifications", "sessions", "segments", "carts", "guestContacts", "assistant", "signIns"] as const,
  kept: ["orders", "payments", "wallet", "consents", "audit", "returns", "warranties", "tickets", "tradeIns", "messages", "request"] as const,
};
export type ErasedPart = (typeof RETENTION.erased)[number];
export type KeptPart = (typeof RETENTION.kept)[number];

/** The most addresses one customer keeps (the account area's limit). */
export const MAX_CUSTOMER_ADDRESSES = 10;

// ───────────────────────────────────────────────────────────────── merge (07.05)

/** How staff confirmed that both accounts belong to the same person. */
export const MERGE_VERIFY_METHODS = ["call_both_numbers", "in_store_id", "same_order_history", "written_request"] as const;
export type MergeVerifyMethod = (typeof MERGE_VERIFY_METHODS)[number];
export const DUPLICATE_REASONS = ["same_email", "phone_on_orders", "phone_on_addresses", "same_name_area"] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

// ───────────────────────────────────────────────────────────────── communication log (07.07)

export const CONTACT_CHANNELS = ["phone", "whatsapp", "in_store", "email", "other"] as const;
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export const CONTACT_DIRECTIONS = ["outbound", "inbound"] as const;
export type ContactDirection = (typeof CONTACT_DIRECTIONS)[number];
/**
 * The only payload fields the log shows: facts of the event, never money. Amounts, payment ids, references, reasons a
 * transfer was refused, balances and account numbers are left out (counted as "hidden").
 */
export const MESSAGE_SAFE_FIELDS = ["status", "trackingNo", "expectedDay", "delayed", "purpose"] as const;
export type SafeField = (typeof MESSAGE_SAFE_FIELDS)[number];
/** Message templates the log knows by name (others show their key). */
export const MESSAGE_TEMPLATES = [
  "order_confirmed",
  "order_shipped",
  "order_delivered",
  "order_cancelled",
  "order_returned",
  "payment_verified",
  "payment_rejected",
  "preorder_date_changed",
  "order_edited",
  "otp",
] as const;

// ───────────────────────────────────────────────────────────────── view models

export type PhoneView = { display: string; full: boolean };

export type CustomerListRow = {
  id: string;
  name: string | null;
  phone: PhoneView | null;
  email: string | null;
  status: CustomerStatusKey;
  createdAt: number;
  purchases: number;
  orders: number;
  spentIqd: number;
  lastOrderAt: number | null;
  segment: RfmSegment | null;
  flags: CustomerFlag[];
  isDemo: boolean;
};

export type CustomerListPage = { rows: CustomerListRow[]; total: number; page: number; pageCount: number; segmentsComputedAt: number | null };

export type CustomerAccess = {
  read: boolean;
  update: boolean;
  note: boolean;
  merge: boolean;
  block: boolean;
  export: boolean;
  segments: boolean;
  consents: boolean;
  privacy: boolean;
  wallet: boolean;
  communication: boolean;
  fullPhone: boolean;
  orders: boolean;
  returns: boolean;
  warranties: boolean;
  repairs: boolean;
  tickets: boolean;
  financeWallet: boolean;
  walletAdjust: boolean;
};

export type CustomerHeader = {
  id: string;
  name: string | null;
  phone: PhoneView | null;
  email: string | null;
  status: CustomerStatusKey;
  locale: string;
  createdAt: number;
  lastLoginAt: number | null;
  phoneVerifiedAt: number | null;
  vipTier: string | null;
  fraudFlag: boolean;
  fraudReason: string | null;
  mergedInto: { id: string; name: string | null } | null;
  anonymizedAt: number | null;
  isDemo: boolean;
  flags: CustomerFlag[];
  segment: { key: RfmSegment; computedAt: number | null } | null;
};

export type MoneyFact = number | null;

export type ProfileOrder = { id: string; ref: string; status: string; paymentStatus: string; totalIqd: number; paidIqd: number; refundedIqd: number; placedAt: number; items: number; isDemo: boolean };
export type ProfileTicket = { id: string; ref: string; subject: string; category: string; status: string; priority: string; createdAt: number; escalated: boolean; open: boolean; complaint: boolean; /** /admin/support/tickets/<ref> (follow-up 2026-11-12). */ href: string };
export type ProfileReturn = { id: string; rma: string; status: string; orderRef: string | null; reasonCode: string | null; createdAt: number };
export type ProfileWarranty = { id: string; itemName: string; sku: string | null; serial: string | null; startsAt: number; endsAt: number; status: string; state: "active" | "ending" | "expired" | "void" };
export type ProfileRepair = { id: string; ref: string; status: string; createdAt: number; issue: string };
export type ProfileNote = { id: string; text: string; by: string | null; at: number; fromAccount: string | null };
export type ConsentState = { kind: ConsentKindKey; granted: boolean | null; at: number | null; source: string | null };
export type WalletSummary = { balanceIqd: number; entries: { id: string; kind: string; amountIqd: number; at: number; orderRef: string | null }[]; pendingTopups: number; financeHref: string | null };
export type ActivityRow = { id: string; action: string; by: string | null; actorKind: string; at: number; reason: string | null };

export type CustomerProfile = {
  header: CustomerHeader;
  stats: { orders: number; purchases: number; openOrders: number; spentIqd: number; refundedIqd: number; aovIqd: number | null; firstOrderAt: number | null; lastOrderAt: number | null };
  rfm: Rfm;
  /** The rules in force (rules.server customerRules): the bounds and windows the page explains. */
  rules: { rfm: RfmRules; flags: FlagRules; privacyDueDays: number };
  orders: ProfileOrder[] | null;
  returns: ProfileReturn[] | null;
  warranties: ProfileWarranty[] | null;
  repairs: ProfileRepair[] | null;
  tickets: ProfileTicket[] | null;
  wallet: WalletSummary | null;
  notes: ProfileNote[];
  legacyNote: string | null;
  consents: ConsentState[] | null;
  privacy: { ref: string; kind: PrivacyKind; status: PrivacyStatus; dueAt: number | null }[] | null;
  mergedFrom: { id: string; name: string | null; phone: PhoneView | null; at: number | null }[];
  addresses: number;
  activity: ActivityRow[];
};
