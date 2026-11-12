/**
 * Admin module 12 "Returns & Warranty" — client-safe constants, URL state and view models shared by the services in
 * this folder and the route modules in app/routes/admin/returns. No database, no server-only imports.
 */
import type { ProductKindScope, RepairStatus, ReturnItemCondition, ReturnReason, ReturnResolution, ReturnStatus, RestockAction, WarrantyStatus } from "~/server/db/schema";

/** Product kinds a return rule can name ("*" = every kind) — a client-safe copy of the schema's list. */
export const PRODUCT_KIND_SCOPE_LIST = ["*", "console", "game", "controller", "headset", "storage", "accessory", "digital", "part", "bundle"] as const satisfies readonly ProductKindScope[];

// ───────────────────────────────────────────────────────────────── statuses and words

export const RMA_STATUS_LIST = ["requested", "approved", "rejected", "in_transit", "received", "inspected", "refunded", "exchanged", "repaired", "closed", "cancelled"] as const satisfies readonly ReturnStatus[];
export type RmaStatus = (typeof RMA_STATUS_LIST)[number];
export const RMA_OPEN_STATUSES = ["requested", "approved", "in_transit", "received", "inspected"] as const satisfies readonly RmaStatus[];
export const RMA_DONE_STATUSES = ["refunded", "exchanged", "repaired", "closed"] as const satisfies readonly RmaStatus[];

export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";
export const RMA_TONE: Record<RmaStatus, Tone> = {
  requested: "warn",
  approved: "info",
  rejected: "bad",
  in_transit: "info",
  received: "info",
  inspected: "warn",
  refunded: "ok",
  exchanged: "ok",
  repaired: "ok",
  closed: "neutral",
  cancelled: "neutral",
};

export const REASON_LIST = ["defective", "damaged_in_delivery", "wrong_item", "not_as_described", "changed_mind", "incompatible", "other"] as const satisfies readonly ReturnReason[];
export type ReasonCode = (typeof REASON_LIST)[number];
/** Reasons where the store is at fault: no seal requirement, no restocking fee. */
export const FAULT_REASONS: readonly ReasonCode[] = ["defective", "damaged_in_delivery", "wrong_item", "not_as_described"];
export const isFaultReason = (reason: ReasonCode | null | undefined) => reason != null && FAULT_REASONS.includes(reason);

export const RESOLUTION_LIST = ["refund", "store_credit", "exchange", "repair", "supplier_return", "none"] as const satisfies readonly ReturnResolution[];
export type Resolution = (typeof RESOLUTION_LIST)[number];
/** What a customer may ask for when the RMA is opened. */
export const REQUESTABLE_RESOLUTIONS = ["refund", "store_credit", "exchange", "repair"] as const satisfies readonly Resolution[];

export const CONDITION_LIST = ["sellable", "opened", "defective", "damaged"] as const satisfies readonly ReturnItemCondition[];
export type Condition = (typeof CONDITION_LIST)[number];
export const CONDITION_TONE: Record<Condition, Tone> = { sellable: "ok", opened: "info", defective: "warn", damaged: "bad" };

/**
 * What happens to an inspected unit: back on sale, into quarantine to be refurbished or to go back to its supplier,
 * written off — or nothing ("keep"): the unit stays the customer's (handed back, or repaired for them).
 */
export const DECISION_LIST = ["restock", "refurbish", "return_to_supplier", "scrap", "keep"] as const;
export type Decision = (typeof DECISION_LIST)[number];
export const decisionAction = (decision: Decision): RestockAction | null => (decision === "keep" ? null : decision);
export const QUARANTINE_DECISIONS: readonly Decision[] = ["refurbish", "return_to_supplier"];
/** The decision an inspector is offered first for a grade (they may choose another). */
export const DEFAULT_DECISION: Record<Condition, Decision> = { sellable: "restock", opened: "refurbish", defective: "return_to_supplier", damaged: "scrap" };

export const REFUND_METHOD_LIST = ["original", "wallet", "cash"] as const;
export type RefundMethodChoice = (typeof REFUND_METHOD_LIST)[number];

// ───────────────────────────────────────────────────────────────── timers (SLA) and fraud thresholds

/**
 * Service targets of the module. Constants until the settings module (22) owns them — docs/areas/admin-returns.md
 * "Requests". Every screen shows the due time and how late it is, never a colour alone.
 */
export const SLA = {
  /** A requested RMA gets a decision within … hours. */
  decisionHours: 48,
  /** A received parcel is inspected within … hours. */
  inspectionHours: 48,
  /** A repair is finished within … days of receiving the device (the ticket's sla_due_at, set at receipt). */
  repairDays: 7,
  /** A quarantined unit is decided (back on sale, to the supplier, written off) within … days. */
  quarantineDays: 14,
  /** Warranties that end within … days are listed as "ending soon". */
  warrantyEndingDays: 30,
} as const;

export const FRAUD_RULE_IDS = ["repeat_returner", "high_value", "quick_return", "customer_flagged", "earlier_refunds", "no_photos", "policy_override", "serial_mismatch", "refund_method_differs"] as const;
export type FraudRuleId = (typeof FRAUD_RULE_IDS)[number];
export const FRAUD_THRESHOLDS = {
  /** Returns by the same phone or customer within `repeatDays` (this one included). */
  repeatCount: 3,
  repeatDays: 90,
  /** Value of the returned units. */
  highValueIqd: 1_000_000,
  /** A change-of-mind return asked for within … hours of delivery. */
  quickHours: 24,
} as const;

// ───────────────────────────────────────────────────────────────── repairs

export const REPAIR_STATUS_LIST = ["submitted", "received", "diagnosing", "awaiting_approval", "awaiting_parts", "repairing", "ready", "delivered", "unrepairable", "cancelled"] as const satisfies readonly RepairStatus[];
export type RepairStatusKey = (typeof REPAIR_STATUS_LIST)[number];
export const REPAIR_OPEN: readonly RepairStatusKey[] = ["submitted", "received", "diagnosing", "awaiting_approval", "awaiting_parts", "repairing", "ready"];
export const REPAIR_TONE: Record<RepairStatusKey, Tone> = {
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
/** The repair workflow (12.07). A status not listed here cannot be reached from that status. */
export const REPAIR_TRANSITIONS: Record<RepairStatusKey, readonly RepairStatusKey[]> = {
  submitted: ["received", "cancelled"],
  received: ["diagnosing", "cancelled"],
  diagnosing: ["awaiting_approval", "awaiting_parts", "repairing", "unrepairable", "cancelled"],
  awaiting_approval: ["repairing", "awaiting_parts", "unrepairable", "cancelled"],
  awaiting_parts: ["repairing", "unrepairable", "cancelled"],
  repairing: ["ready", "awaiting_parts", "unrepairable"],
  ready: ["delivered"],
  unrepairable: ["delivered"],
  delivered: [],
  cancelled: [],
};
/** Transitions that need a typed reason. */
export const REPAIR_REASON_REQUIRED: readonly RepairStatusKey[] = ["cancelled", "unrepairable"];

// ───────────────────────────────────────────────────────────────── warranties

export const WARRANTY_STATE_LIST = ["active", "expired", "void"] as const satisfies readonly WarrantyStatus[];
export type WarrantyState = (typeof WARRANTY_STATE_LIST)[number];
export const WARRANTY_TONE: Record<WarrantyState, Tone> = { active: "ok", expired: "neutral", void: "bad" };

// ───────────────────────────────────────────────────────────────── numbers typed by people

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Latin digits for Arabic-Indic and Persian (Kurdish keyboard) ones. */
export function latinDigits(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const a = ARABIC_INDIC.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    out += a >= 0 ? String(a) : p >= 0 ? String(p) : ch;
  }
  return out;
}

/** A whole number typed by a person ("754,000", "٧٥٤٠٠٠", "۷۵۴۰۰۰"): the number, undefined when empty, NaN when not a whole number. */
export function parseWhole(raw: string | null | undefined): number | undefined {
  const text = latinDigits(String(raw ?? "")).replace(/[,\s٬،]/g, "");
  if (!text) return undefined;
  return /^\d{1,13}$/.test(text) ? Number(text) : Number.NaN;
}

// ───────────────────────────────────────────────────────────────── list filters (URL state)

export const RMA_VIEWS = ["all", "decide", "receive", "inspect", "refund", "done", "flagged"] as const;
export type RmaView = (typeof RMA_VIEWS)[number];
export const VIEW_STATUSES: Record<Exclude<RmaView, "all" | "flagged">, readonly RmaStatus[]> = {
  decide: ["requested"],
  receive: ["approved", "in_transit"],
  inspect: ["received"],
  refund: ["inspected"],
  done: ["refunded", "exchanged", "repaired", "closed", "rejected", "cancelled"],
};

export type RmaFilters = { view: RmaView; status: RmaStatus | null; reason: ReasonCode | null; q: string; from: string | null; to: string | null; page: number };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const validDay = (value: string | null): string | null => {
  if (!value || !DAY.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d ? value : null;
};

export function parseRmaFilters(params: URLSearchParams): RmaFilters {
  const view = params.get("view");
  const status = params.get("status");
  const reason = params.get("reason");
  const page = Number(latinDigits(params.get("page") ?? "1"));
  return {
    view: (RMA_VIEWS as readonly string[]).includes(view ?? "") ? (view as RmaView) : "all",
    status: (RMA_STATUS_LIST as readonly string[]).includes(status ?? "") ? (status as RmaStatus) : null,
    reason: (REASON_LIST as readonly string[]).includes(reason ?? "") ? (reason as ReasonCode) : null,
    q: (params.get("q") ?? "").trim().slice(0, 60),
    from: validDay(params.get("from")),
    to: validDay(params.get("to")),
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** "?view=…&q=…" for links (empty values left out; page 1 left out). */
export function rmaSearch(filters: Partial<RmaFilters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "all") params.set("view", filters.view);
  if (filters.status) params.set("status", filters.status);
  if (filters.reason) params.set("reason", filters.reason);
  if (filters.q) params.set("q", filters.q);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const REPAIR_VIEWS = ["open", "late", "mine", "warranty", "done", "all"] as const;
export type RepairView = (typeof REPAIR_VIEWS)[number];
export type RepairFilters = { view: RepairView; status: RepairStatusKey | null; q: string; page: number };

export function parseRepairFilters(params: URLSearchParams): RepairFilters {
  const view = params.get("view");
  const status = params.get("status");
  const page = Number(latinDigits(params.get("page") ?? "1"));
  return {
    view: (REPAIR_VIEWS as readonly string[]).includes(view ?? "") ? (view as RepairView) : "open",
    status: (REPAIR_STATUS_LIST as readonly string[]).includes(status ?? "") ? (status as RepairStatusKey) : null,
    q: (params.get("q") ?? "").trim().slice(0, 60),
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

export function repairSearch(filters: Partial<RepairFilters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "open") params.set("view", filters.view);
  if (filters.status) params.set("status", filters.status);
  if (filters.q) params.set("q", filters.q);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export const WARRANTY_VIEWS = ["active", "ending", "expired", "void", "all"] as const;
export type WarrantyView = (typeof WARRANTY_VIEWS)[number];
export type WarrantyFilters = { view: WarrantyView; q: string; page: number };

export function parseWarrantyFilters(params: URLSearchParams): WarrantyFilters {
  const view = params.get("view");
  const page = Number(latinDigits(params.get("page") ?? "1"));
  return {
    view: (WARRANTY_VIEWS as readonly string[]).includes(view ?? "") ? (view as WarrantyView) : "active",
    q: (params.get("q") ?? "").trim().slice(0, 60),
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

export function warrantySearch(filters: Partial<WarrantyFilters>): string {
  const params = new URLSearchParams();
  if (filters.view && filters.view !== "active") params.set("view", filters.view);
  if (filters.q) params.set("q", filters.q);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

// ───────────────────────────────────────────────────────────────── view models

/** A phone as this employee may see it: in full with customer.phone.read_full, masked otherwise (no e164 then). */
export type PhoneView = { display: string; full: boolean; e164?: string };
export type EmployeeRef = { id: string; name: string };

export type Eligibility = {
  eligible: boolean;
  /** Why not (or why it needs care), as message keys under `eligibility.*`. */
  problems: ("not_delivered" | "window_closed" | "not_returnable" | "seal_required" | "nothing_left")[];
  windowDays: number;
  /** End of the return window (null when the order has no delivery time). */
  windowEndsAt: number | null;
  daysSinceDelivery: number | null;
  requiresSealed: boolean;
  restockingFeeBps: number;
  /** The rule that decided: a return_policies row, or the store's general window. */
  rule: { id: string | null; source: "category" | "kind" | "catch_all" | "setting"; note: string | null };
};

export type EligibleLine = {
  orderItemId: string;
  name: string;
  sku: string;
  qty: number;
  /** Units still returnable: bought − refunded − in other open or finished returns. */
  returnableQty: number;
  unitValueIqd: number;
  isUsed: boolean;
  productKind: string | null;
  serials: { id: string; serial: string }[];
  eligibility: Eligibility;
};

export type OrderForReturn = {
  orderId: string;
  ref: string;
  status: string;
  deliveredAt: number | null;
  customer: { kind: "customer" | "guest"; name: string | null; phone: PhoneView | null };
  lines: EligibleLine[];
  /** Earlier returns of this order. */
  returns: { rma: string; status: RmaStatus; createdAt: number }[];
  isDemo: boolean;
};

export type RmaListRow = {
  id: string;
  rma: string;
  orderRef: string;
  status: RmaStatus;
  reasonCode: ReasonCode | null;
  requestedResolution: Resolution | null;
  resolution: Resolution | null;
  customerName: string | null;
  /** The customer's account, for a link to their profile — only for staff who may open it (customers.customer.read). */
  customerProfileId: string | null;
  phone: PhoneView | null;
  units: number;
  valueIqd: number;
  createdAt: number;
  /** When the current step is due (decision / inspection), null when nothing is timed. */
  dueAt: number | null;
  late: boolean;
  refund: "none" | "pending" | "paid";
  flags: FraudRuleId[];
  isDemo: boolean;
};

export type RmaListPage = { rows: RmaListRow[]; total: number; page: number; pageCount: number; filters: RmaFilters };

export type QueueCounts = {
  decide: number | null;
  receive: number | null;
  inspect: number | null;
  refund: number | null;
  refundApproval: number | null;
  quarantine: number | null;
  repairsLate: number | null;
  warrantiesEnding: number | null;
};

export type FraudSignal = { id: FraudRuleId; vars: Record<string, string | number> };

export type RmaItemView = {
  id: string;
  orderItemId: string;
  name: string;
  sku: string;
  qty: number;
  serial: { id: string; serial: string } | null;
  unitValueIqd: number;
  condition: Condition | null;
  decision: Decision | null;
  restockedAt: number | null;
  inspectedBy: string | null;
  notes: string | null;
  /** Units of this item held by a refund of this return (issued, or still waiting for its approval). */
  refundedQty: number;
  /** Of those, units whose refund was issued. */
  refundPaidQty: number;
  /** May its money go back through the RMA? The unit came back (inspected, not kept), or its repair under the RMA failed. */
  refundable: boolean;
  /** The policy's restocking fee on the units not refunded yet (0 when the store is at fault, or nothing is refundable). */
  feeIqd: number;
  /** A used device (module 13's unit): back to the devices team or written off, never into quarantine. */
  used: boolean;
  /** Quarantine follow-up: the unit left quarantine (back on sale, to its supplier, written off). */
  quarantineExit: "stock" | "scrap" | "supplier" | null;
  eligibility: Eligibility | null;
  warranty: { id: string; endsAt: number; state: WarrantyState } | null;
};

export type RmaRefundView = {
  id: string;
  amountIqd: number;
  method: RefundMethodChoice;
  status: "pending" | "approved" | "paid" | "rejected" | "cancelled";
  reason: string | null;
  reference: string | null;
  createdBy: string | null;
  createdAt: number;
  approvedBy: string | null;
  rejectReason: string | null;
  mine: boolean;
  needsReference: boolean;
};

export type PaymentOption = { id: string; method: string; amountIqd: number; refundableIqd: number };

export type TimelineEntry = {
  id: string;
  at: number;
  action: string;
  actor: { kind: string; name: string | null };
  reason: string | null;
  summary: string | null;
  /** An inspection: the grade and the decision it recorded. */
  inspection?: { condition: Condition; decision: Decision } | null;
};

export type RmaDetail = {
  id: string;
  rma: string;
  status: RmaStatus;
  order: { id: string; ref: string; status: string; deliveredAt: number | null; paymentMethod: string | null; totalIqd: number; paidIqd: number; refundedIqd: number };
  /** profileId: the account for a link to the customer's profile — only for staff who may open it (customers.customer.read). */
  customer: { kind: "customer" | "guest"; id: string | null; name: string | null; profileId: string | null; phone: PhoneView | null; hasWallet: boolean };
  reasonCode: ReasonCode | null;
  reason: string | null;
  requestedResolution: Resolution | null;
  resolution: Resolution | null;
  rejectReason: string | null;
  staffNote: string | null;
  createdAt: number;
  createdBy: string | null;
  approvedBy: string | null;
  approvedAt: number | null;
  receivedAt: number | null;
  inspectedAt: number | null;
  closedAt: number | null;
  dueAt: number | null;
  late: boolean;
  items: RmaItemView[];
  photos: { id: string; url: string; width: number | null; height: number | null }[];
  refunds: RmaRefundView[];
  payments: PaymentOption[];
  /** Suggested amount for the items not refunded yet: their value minus the restocking fee (store-fault reasons pay none). */
  refundSuggestion: { amountIqd: number; feeIqd: number; itemsValueIqd: number; capIqd: number } | null;
  repairs: { id: string; ref: string; status: RepairStatusKey }[];
  flags: FraudSignal[];
  timeline: TimelineEntry[];
  quarantineLocations: { id: string; code: string; name: string }[];
  sellableLocations: { id: string; code: string; name: string }[];
  can: {
    decide: boolean;
    /** The employee opened this RMA: a second person decides. */
    ownRequest: boolean;
    transit: boolean;
    inspect: boolean;
    refund: boolean;
    approveRefund: boolean;
    close: boolean;
    cancel: boolean;
    addPhoto: boolean;
    /** An internal note (returns.rma.create, inspect or approve). */
    note: boolean;
    repair: boolean;
    /** Restock may go "where the unit left from"; an employee limited to a branch names one of their branch's locations. */
    restockDefault: boolean;
    print: boolean;
  };
  isDemo: boolean;
};

export type QuarantineRow = {
  itemId: string;
  rma: string;
  returnId: string;
  name: string;
  sku: string;
  variantId: string;
  qty: number;
  serial: { id: string; serial: string } | null;
  condition: Condition | null;
  decision: Decision;
  location: { id: string; code: string; name: string } | null;
  since: number;
  dueAt: number;
  late: boolean;
  notes: string | null;
};

export type RepairListRow = {
  id: string;
  ref: string;
  status: RepairStatusKey;
  source: string;
  device: string | null;
  customerName: string | null;
  /** The customer's account, for a link to their profile — only for staff who may open it (customers.customer.read). */
  customerProfileId: string | null;
  phone: PhoneView | null;
  isWarranty: boolean;
  assignedTo: EmployeeRef | null;
  slaDueAt: number | null;
  late: boolean;
  createdAt: number;
  rma: string | null;
  isDemo: boolean;
};

export type RepairPartView = { variantId: string | null; name: string; qty: number; priceIqd: number; fromStock: boolean };

export type RepairDetail = {
  id: string;
  ref: string;
  status: RepairStatusKey;
  source: string;
  device: string | null;
  deviceText: string | null;
  serial: { id: string | null; text: string | null } | null;
  /** profileId: the account for a link to the customer's profile — only for staff who may open it. */
  customer: { name: string | null; profileId: string | null; phone: PhoneView | null };
  issue: string;
  diagnosis: string | null;
  resolution: string | null;
  isWarranty: boolean;
  warranty: { id: string; endsAt: number; state: WarrantyState } | null;
  rma: { id: string; rma: string } | null;
  quoteIqd: number | null;
  quoteApprovedAt: number | null;
  costIqd: number | null;
  parts: RepairPartView[];
  partsTotalIqd: number;
  slaDueAt: number | null;
  late: boolean;
  receivedAt: number | null;
  completedAt: number | null;
  deliveredAt: number | null;
  createdAt: number;
  assignedTo: EmployeeRef | null;
  technicians: EmployeeRef[];
  transitions: RepairStatusKey[];
  events: { id: string; kind: string; note: string | null; at: number; actor: { kind: string; name: string | null }; data: Record<string, string | number | boolean | null> }[];
  photos: { id: string; url: string }[];
  can: { manage: boolean; stock: boolean };
  isDemo: boolean;
};

export type WarrantyRow = {
  id: string;
  itemName: string;
  orderRef: string;
  serial: string | null;
  customerName: string | null;
  /** The customer's account, for a link to their profile — only for staff who may open it (customers.customer.read). */
  customerProfileId: string | null;
  phone: PhoneView | null;
  startsAt: number;
  endsAt: number;
  state: WarrantyState;
  repairs: number;
  isUsed: boolean;
};

export type WarrantyDetail = WarrantyRow & {
  terms: string | null;
  voidReason: string | null;
  makerWarranty: string | null;
  orderItemId: string;
  serialId: string | null;
  service: { id: string; ref: string; status: RepairStatusKey; createdAt: number; deliveredAt: number | null; issue: string; diagnosis: string | null; parts: RepairPartView[] }[];
  replacedParts: { ticketRef: string; name: string; qty: number; at: number }[];
  returns: { rma: string; status: RmaStatus; createdAt: number }[];
  history: TimelineEntry[];
  can: { manage: boolean };
};

export type PolicyView = {
  id: string;
  productKind: string;
  categoryId: string | null;
  categoryName: string | null;
  itemCondition: "*" | "new" | "used";
  isReturnable: boolean;
  windowDays: number | null;
  requiresSealed: boolean;
  restockingFeeBps: number;
  note: { ar: string; en: string | null; ckb: string | null } | null;
  sort: number;
  isActive: boolean;
};
