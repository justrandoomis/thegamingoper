/**
 * Admin module 05 "orders" — CLIENT-SAFE constants, filter parsing and view-model types (no server imports at runtime).
 * The services in this folder build these shapes; the screens in app/routes/admin/orders render them.
 *
 * Cost and profit fields are OPTIONAL properties that the services leave out entirely (never null-masked) for an
 * employee without `cost.read` / `profit.read` (CONTRACTS §4, blueprint acceptance #5).
 */
import type { OrderStatus } from "~/lib/dto";

export type { OrderStatus };

export const ORDER_STATUS_LIST = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing", "shipped", "delivered", "cancelled", "returned"] as const satisfies readonly OrderStatus[];
export const PAYMENT_STATUS_LIST = ["unpaid", "cod_due", "pending_verification", "paid", "rejected", "partially_refunded", "refunded"] as const;
export type OrderPaymentStatus = (typeof PAYMENT_STATUS_LIST)[number];
export const PAYMENT_METHOD_LIST = ["cod", "wallet", "bank_transfer", "zaincash", "pos_cash", "pos_card"] as const;
export type AnyPaymentMethod = (typeof PAYMENT_METHOD_LIST)[number];

/** Orders that still need work from the store (the review queue and the "late" rules only look at these). */
export const OPEN_STATUSES = ["new", "awaiting_payment", "payment_review", "confirmed", "preparing", "shipped"] as const satisfies readonly OrderStatus[];
/** Statuses an order can be packed in (pick-pack-ship, 04.11). */
export const PACKABLE_STATUSES = ["confirmed", "preparing"] as const satisfies readonly OrderStatus[];

export type StatusTone = "ok" | "warn" | "info" | "bad" | "neutral";

/** Words with a dot (DESIGN.md §10 "Status"): the tone never carries the meaning alone. */
export const STATUS_TONE: Record<OrderStatus, StatusTone> = {
  new: "info",
  awaiting_payment: "warn",
  payment_review: "warn",
  confirmed: "info",
  preparing: "info",
  shipped: "info",
  delivered: "ok",
  cancelled: "neutral",
  returned: "neutral",
};

export const PAYMENT_TONE: Record<OrderPaymentStatus, StatusTone> = {
  unpaid: "warn",
  cod_due: "neutral",
  pending_verification: "warn",
  paid: "ok",
  rejected: "bad",
  partially_refunded: "info",
  refunded: "neutral",
};

// ───────────────────────────────────────────────────────────────── risk rules (05.09)

/**
 * Deterministic review rules. Each one is a plain condition on the order (the SQL lives in risk.server.ts) with
 * a sentence that explains it to the reviewer ("risk.<id>.why" in admin-orders). Thresholds are constants so the
 * same order always gets the same flags at the same moment.
 */
export const RISK_THRESHOLDS = {
  /** proof_waiting: a submitted transfer proof nobody has decided for this many hours. */
  proofWaitingHours: 6,
  /** cod_unconfirmed: a cash-on-delivery order not confirmed by phone after this many hours. */
  codUnconfirmedHours: 24,
  /** not_shipped: confirmed (or being prepared) and not shipped after this many hours. */
  notShippedHours: 48,
  /** not_delivered: shipped and not delivered after this many days. */
  notDeliveredDays: 5,
  /** high_value_cod: cash on delivery at or above this total. */
  highValueCodIqd: 1_500_000,
  /** phone_cancellations: this many cancelled orders on the same phone… */
  phoneCancellations: 2,
  /** …in the days before this order was placed. */
  phoneCancellationDays: 90,
  /** phone_open_orders: this many open orders on the same phone (this one included). */
  phoneOpenOrders: 3,
  /** bulk_quantity: this many units of one item on one line. */
  bulkQuantity: 5,
} as const;

export const RISK_RULE_IDS = [
  "proof_waiting",
  "cod_unconfirmed",
  "not_shipped",
  "not_delivered",
  "preorder_overdue",
  "duplicate_proof",
  "amount_mismatch",
  "high_value_cod",
  "phone_cancellations",
  "phone_open_orders",
  "customer_flagged",
  "bulk_quantity",
] as const;
export type RiskRuleId = (typeof RISK_RULE_IDS)[number];
export const LATE_RULES: readonly RiskRuleId[] = ["proof_waiting", "cod_unconfirmed", "not_shipped", "not_delivered", "preorder_overdue"];
export const SUSPICIOUS_RULES: readonly RiskRuleId[] = ["duplicate_proof", "amount_mismatch", "high_value_cod", "phone_cancellations", "phone_open_orders", "customer_flagged", "bulk_quantity"];
export const riskKind = (id: RiskRuleId): "late" | "suspicious" => (LATE_RULES.includes(id) ? "late" : "suspicious");

export const REVIEW_STATUSES = ["none", "needs_review", "cleared", "blocked"] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

// ───────────────────────────────────────────────────────────────── list filters (URL state)

export const LIST_SORTS = ["placed_desc", "placed_asc", "total_desc", "total_asc"] as const;
export type ListSort = (typeof LIST_SORTS)[number];
export const LIST_FLAGS = ["late", "suspicious", "on_hold", "preorder"] as const;
export type ListFlag = (typeof LIST_FLAGS)[number];
export const LIST_ASSIGNED = ["me", "unassigned"] as const;
export type ListAssigned = (typeof LIST_ASSIGNED)[number];
export const LIST_PAGE_SIZE = 25;

export type OrderListFilters = {
  q: string;
  status: OrderStatus[];
  payment: OrderPaymentStatus[];
  method: AnyPaymentMethod[];
  governorate: string | null;
  /** Baghdad calendar days, "YYYY-MM-DD", inclusive. */
  from: string | null;
  to: string | null;
  flags: ListFlag[];
  assigned: ListAssigned | null;
  sort: ListSort;
  page: number;
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** A real calendar day "YYYY-MM-DD" or null ("2027-02-30" is null: Date.parse would quietly roll it to 2 March). */
export function validDay(value: string | null | undefined): string | null {
  if (!value || !DAY_PATTERN.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value ? null : value;
}

function pickAll<T extends string>(params: URLSearchParams, name: string, allowed: readonly T[]): T[] {
  const out: T[] = [];
  for (const raw of params.getAll(name)) {
    for (const value of raw.split(",")) {
      const v = value.trim() as T;
      if (allowed.includes(v) && !out.includes(v)) out.push(v);
    }
  }
  return out;
}

/** The list's filters from the URL. Unknown or malformed values are dropped, never guessed. */
export function parseListFilters(params: URLSearchParams): OrderListFilters {
  const sort = params.get("sort");
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  const assigned = params.get("assigned");
  const governorate = params.get("gov");
  const from = validDay(params.get("from"));
  const to = validDay(params.get("to"));
  return {
    q: (params.get("q") ?? "").trim().slice(0, 80),
    status: pickAll(params, "status", ORDER_STATUS_LIST),
    payment: pickAll(params, "payment", PAYMENT_STATUS_LIST),
    method: pickAll(params, "method", PAYMENT_METHOD_LIST),
    governorate: governorate && ID_PATTERN.test(governorate) ? governorate : null,
    from: from && to && from > to ? to : from,
    to: from && to && from > to ? from : to,
    flags: pickAll(params, "flag", LIST_FLAGS),
    assigned: (LIST_ASSIGNED as readonly string[]).includes(assigned ?? "") ? (assigned as ListAssigned) : null,
    sort: (LIST_SORTS as readonly string[]).includes(sort ?? "") ? (sort as ListSort) : "placed_desc",
    page: Number.isFinite(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** The URL query for filters (defaults left out), so links and the no-script form agree. */
export function listSearch(filters: Partial<OrderListFilters>): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  for (const value of filters.status ?? []) params.append("status", value);
  for (const value of filters.payment ?? []) params.append("payment", value);
  for (const value of filters.method ?? []) params.append("method", value);
  if (filters.governorate) params.set("gov", filters.governorate);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  for (const value of filters.flags ?? []) params.append("flag", value);
  if (filters.assigned) params.set("assigned", filters.assigned);
  if (filters.sort && filters.sort !== "placed_desc") params.set("sort", filters.sort);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const query = params.toString();
  return query ? `?${query}` : "";
}

/** Saved views of the list (uxRules: saved filters) — fixed, shareable URLs. */
export const SAVED_VIEWS = [
  { id: "all", filters: {} },
  { id: "to_verify", filters: { status: ["payment_review"] } },
  { id: "cod_to_confirm", filters: { status: ["new"] } },
  { id: "to_pack", filters: { status: ["confirmed", "preparing"] } },
  { id: "in_transit", filters: { status: ["shipped"] } },
  { id: "late", filters: { flags: ["late"] } },
  { id: "suspicious", filters: { flags: ["suspicious"] } },
] as const satisfies readonly { id: string; filters: Partial<OrderListFilters> }[];

// ───────────────────────────────────────────────────────────────── typed amounts

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/**
 * A whole number of dinars as a person types it — "754,000", "754000", "٧٥٤٬٠٠٠" (Arabic keyboard) or "۷۵۴٬۰۰۰"
 * (Persian / Kurdish keyboard), spaces allowed — or undefined when empty, NaN when it is not a whole amount (never 0).
 * The server (forms) and the dialogs (is it what is due? → reason needed) read it the same way.
 */
export function parseIqd(raw: string): number | undefined {
  let text = "";
  for (const ch of raw) {
    const a = ARABIC_INDIC.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    text += a >= 0 ? String(a) : p >= 0 ? String(p) : ch;
  }
  text = text.replace(/[,\s٬،]/g, "");
  if (!text) return undefined;
  return /^\d{1,13}$/.test(text) ? Number(text) : Number.NaN;
}

// ───────────────────────────────────────────────────────────────── printed documents (05.06)

export const PRINT_KINDS = ["invoice", "packing", "label"] as const;
export type PrintKind = (typeof PRINT_KINDS)[number];

// ───────────────────────────────────────────────────────────────── view models

/** A phone as the employee may see it: full with customer.phone.read_full, otherwise "0771 ••• ••52". */
export type PhoneView = { display: string; full: boolean; e164?: string };

export type OrderListRow = {
  id: string;
  ref: string;
  placedAt: number;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  paymentMethod: AnyPaymentMethod | null;
  totalIqd: number;
  paidIqd: number;
  units: number;
  contactName: string | null;
  phone: PhoneView | null;
  governorate: string | null;
  assignedTo: { id: string; name: string } | null;
  reviewStatus: ReviewStatus;
  isPreorder: boolean;
  isDemo: boolean;
  flags: RiskRuleId[];
};

export type OrderListPage = {
  rows: OrderListRow[];
  total: number;
  page: number;
  pageCount: number;
  filters: OrderListFilters;
  governorates: { id: string; name: string }[];
};

export type EmployeeRef = { id: string; name: string };

/** One thing the order's history says happened (order events, plus the audit trail for `audit.read`). */
export type HistoryEntry = {
  id: string;
  source: "order" | "audit";
  kind: string;
  at: number;
  actor: { kind: string; name: string | null };
  reason: string | null;
  /** Small, safe facts for the sentence (statuses, amounts, refs). Never cost data. */
  data: Record<string, string | number | boolean | null>;
};

export type TransitionImpact = {
  units: number;
  usedUnits: number;
  serialsReleased: number;
  pendingRefundIqd: number;
  couponFreed: boolean;
  unpaidCancelled: boolean;
};

export type TransitionOption = {
  to: OrderStatus;
  /** Cancelled and returned need a reason (the core refuses fewer than 3 characters). */
  reasonRequired: boolean;
  /** Why the core would refuse it right now (serials missing, order on hold…); null = it can go. */
  blocker: string | null;
  impact: TransitionImpact;
};

export type ProofView = {
  id: string;
  status: "submitted" | "approved" | "rejected";
  declaredAmountIqd: number;
  reference: string | null;
  note: string | null;
  createdAt: number;
  reviewedBy: string | null;
  reviewedAt: number | null;
  reviewNote: string | null;
  /** Staff only: an earlier proof with the same picture or reference (never shown to shoppers). */
  duplicateOf: { proofId: string; orderRef: string | null } | null;
  /** Present only with payment_proof.read. */
  imageUrl?: string;
};

export type PaymentView = {
  id: string;
  method: AnyPaymentMethod;
  status: "pending" | "pending_verification" | "paid" | "rejected" | "cancelled";
  amountIqd: number;
  declaredAmountIqd: number | null;
  reference: string | null;
  verifiedBy: string | null;
  verifiedAt: number | null;
  paidAt: number | null;
  rejectReason: string | null;
  createdAt: number;
  refundableIqd: number;
  proofs: ProofView[];
};

export type RefundView = {
  id: string;
  paymentId: string;
  amountIqd: number;
  method: "original" | "wallet" | "cash";
  status: "pending" | "approved" | "paid" | "rejected" | "cancelled";
  reason: string | null;
  createdBy: string | null;
  createdAt: number;
  approvedBy: string | null;
  approvedAt: number | null;
  reference: string | null;
  rejectReason: string | null;
  /** The signed-in employee asked for it: someone else must approve (two-person rule). */
  mine: boolean;
  /** Issuing it to the original bank / Zain Cash payment needs the outgoing transfer's reference. */
  needsReference: boolean;
  source: string | null;
};

export type OrderLineView = {
  id: string;
  variantId: string;
  usedUnitId: string | null;
  sku: string;
  barcode: string | null;
  name: string;
  options: string | null;
  unitPriceIqd: number;
  qty: number;
  totalIqd: number;
  refundedQty: number;
  trackSerials: boolean;
  serials: { id: string; serial: string; releasedAt: number | null }[];
  warranty: string | null;
  /** [P] cost.read only: landed cost per unit at the time of sale (null = unknown, shown as "—" with a reason). */
  unitCostIqd?: number | null;
  /** [P] profit.read (with cost.read) only: line total − cost; null when the cost is unknown. */
  marginIqd?: number | null;
};

export type ReservationView = { id: string; sku: string; location: string; qty: number; status: string; expiresAt: number | null };

export type ParcelView = {
  id: string;
  number: number;
  status: string;
  trackingNo: string | null;
  carrier: string | null;
  packedBy: string | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  receivedByName: string | null;
  proofUrl: string | null;
  items: { orderItemId: string; name: string; sku: string; qty: number; verifiedAt: number | null }[];
};

export type NotificationView = { id: string; channel: string; template: string; status: "held" | "queued" | "sent" | "failed"; createdAt: number; sentAt: number | null; lastError: string | null };

export type OrderDetail = {
  id: string;
  ref: string;
  status: OrderStatus;
  paymentStatus: OrderPaymentStatus;
  paymentMethod: AnyPaymentMethod | null;
  channel: "web" | "pos";
  isDemo: boolean;
  placedAt: number;
  confirmedAt: number | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  cancelledAt: number | null;
  cancelReason: string | null;
  paymentDueAt: number | null;
  totals: { subtotalIqd: number; discountIqd: number; shippingIqd: number; taxIqd: number; totalIqd: number; paidIqd: number; refundedIqd: number; dueIqd: number };
  coupon: string | null;
  customer: {
    kind: "customer" | "guest";
    name: string | null;
    phone: PhoneView | null;
    accountStatus: string | null;
    fraudFlag: boolean;
    vipTier: string | null;
    previousOrders: number;
  };
  address: {
    governorate: string | null;
    district: string | null;
    area: string | null;
    address: string | null;
    notes: string | null;
    preferredDay: string | null;
    preferredWindow: string | null;
  };
  lines: OrderLineView[];
  units: number;
  /** [P] cost.read only. Null = at least one unit has no known cost. */
  costIqd?: number | null;
  /** [P] profit.read + cost.read only. */
  marginIqd?: number | null;
  payments: PaymentView[];
  refunds: RefundView[];
  reservations: ReservationView[];
  usedUnits: { id: string; status: string; grade: string | null }[];
  parcels: ParcelView[];
  assignedTo: EmployeeRef | null;
  tasks: { id: string; title: string; status: string; assignedTo: string | null; createdAt: number; completedAt: number | null }[];
  review: { status: ReviewStatus; reviewedBy: string | null; reviewedAt: number | null; flags: RiskRuleId[]; clearedFlags: RiskRuleId[] };
  preorder: { isPreorder: boolean; expectedAt: number | null; releaseAt: number | null; depositIqd: number | null };
  invoice: { number: string; issuedAt: number } | null;
  history: HistoryEntry[];
  notifications: NotificationView[];
  transitions: TransitionOption[];
  can: {
    verify: boolean;
    override: boolean;
    seeProofs: boolean;
    recordCod: boolean;
    refund: boolean;
    approveRefund: boolean;
    assign: boolean;
    note: boolean;
    review: boolean;
    edit: boolean;
    pack: boolean;
    ship: boolean;
    deliver: boolean;
    deliveryProof: boolean;
    print: boolean;
    preorder: boolean;
    seeAudit: boolean;
  };
  /** Why the lines / the address cannot be edited right now (null = they can) — orders/edit.server.ts. */
  editBlockers: { lines: string | null; address: string | null };
  assignable: EmployeeRef[];
};
