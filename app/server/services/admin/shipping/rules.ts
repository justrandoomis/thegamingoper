/**
 * Admin module 11 "shipping" — the pure, client-safe part: parcel statuses and their tones, the moves a person makes
 * on a parcel from this module, service levels, failed-delivery outcomes, list filters in the URL, the arithmetic of
 * carrier fees and cash-on-delivery settlements, and the view models the screens render. No database, no server code.
 *
 *   SHIPMENT_STATUS_LIST, SHIPMENT_TONE, PARCEL_MOVES[status] → the actions a parcel page offers
 *   parcelCode("TT-7K4M2Q9X", 1) → "TT-7K4M2Q9X-1"   (the waybill number printed as Code 128)
 *   codFeeFor(754_000, { codFeeIqd: 1_000, codFeeBps: 100 }) → 8_540
 *   settlementTotals(items, receivedIqd) → { expectedIqd, feesIqd, netDueIqd, varianceIqd }
 *   parseShipmentFilters(params) / shipmentSearch(filters)
 */
import type { CarrierKind, CodSettlementStatus, DeliveryOutcome, ShipmentStatus } from "~/server/db/schema/shipping";
import { parseIqd } from "~/server/services/admin/orders/types";

export { parseIqd };
export type { CarrierKind, CodSettlementStatus, DeliveryOutcome, ShipmentStatus };

export type Tone = "ok" | "warn" | "info" | "bad" | "neutral";

// ───────────────────────────────────────────────────────────────── parcels

export const SHIPMENT_STATUS_LIST = ["pending", "packed", "handed_over", "in_transit", "out_for_delivery", "delivered", "failed", "returning", "returned", "cancelled"] as const satisfies readonly ShipmentStatus[];

export const SHIPMENT_TONE: Record<ShipmentStatus, Tone> = {
  pending: "neutral",
  packed: "info",
  handed_over: "info",
  in_transit: "info",
  out_for_delivery: "info",
  delivered: "ok",
  failed: "warn",
  returning: "warn",
  returned: "neutral",
  cancelled: "neutral",
};

/** On the road with a courier: the parcel has left the store and is not back or delivered. */
export const ON_ROAD = ["handed_over", "in_transit", "out_for_delivery"] as const satisfies readonly ShipmentStatus[];
/** Left the store, not delivered and not back yet. */
export const IN_FLIGHT = ["handed_over", "in_transit", "out_for_delivery", "failed", "returning"] as const satisfies readonly ShipmentStatus[];
/** A delivery can be recorded from these (a courier's later try can succeed after a failed one). */
export const DELIVERABLE = ["handed_over", "in_transit", "out_for_delivery", "failed"] as const satisfies readonly ShipmentStatus[];
/** Still in the store. */
export const AT_STORE = ["pending", "packed"] as const satisfies readonly ShipmentStatus[];
/** Nothing more happens to these. */
export const FINAL = ["delivered", "returned", "cancelled"] as const satisfies readonly ShipmentStatus[];

export const isStatus = (value: unknown): value is ShipmentStatus => typeof value === "string" && (SHIPMENT_STATUS_LIST as readonly string[]).includes(value);
export const inList = (status: string, list: readonly string[]) => list.includes(status);

/** Plain status moves a person makes from this module (no order state behind them). */
export const SIMPLE_MOVES = {
  in_transit: ["handed_over"],
  out_for_delivery: ["handed_over", "in_transit", "failed"],
  returning: ["handed_over", "in_transit", "out_for_delivery", "failed"],
} as const satisfies Record<string, readonly ShipmentStatus[]>;
export type SimpleMove = keyof typeof SIMPLE_MOVES;
export const SIMPLE_MOVE_LIST = Object.keys(SIMPLE_MOVES) as SimpleMove[];

export const canMove = (from: ShipmentStatus, to: SimpleMove) => (SIMPLE_MOVES[to] as readonly string[]).includes(from);

/** What a parcel page may offer from each status (the permissions decide the rest). */
export const PARCEL_ACTIONS = ["waybill", "pickup", "in_transit", "out_for_delivery", "attempt", "deliver", "returning", "receive_return", "packing_photo", "proof"] as const;
export type ParcelAction = (typeof PARCEL_ACTIONS)[number];

export const PARCEL_MOVES: Record<ShipmentStatus, readonly ParcelAction[]> = {
  pending: ["waybill", "packing_photo"],
  packed: ["waybill", "pickup", "packing_photo"],
  handed_over: ["in_transit", "out_for_delivery", "attempt", "deliver", "returning", "receive_return", "waybill"],
  in_transit: ["out_for_delivery", "attempt", "deliver", "returning", "receive_return", "waybill"],
  out_for_delivery: ["attempt", "deliver", "returning", "receive_return", "waybill"],
  failed: ["out_for_delivery", "deliver", "returning", "receive_return"],
  returning: ["receive_return"],
  delivered: ["proof"],
  returned: [],
  cancelled: [],
};

/** After this many failed tries the queue suggests sending the parcel back (the store's rule, not a carrier's). */
export const MAX_ATTEMPTS = 3;

/** Why a delivery try failed (the delivery_attempts outcomes without "delivered"). */
export const FAILURE_OUTCOMES = ["no_answer", "refused", "wrong_address", "rescheduled", "damaged", "other"] as const satisfies readonly DeliveryOutcome[];
export type FailureOutcome = (typeof FAILURE_OUTCOMES)[number];

/** Service levels a carrier's rates are given for. */
export const SERVICE_LEVELS = ["standard", "express", "same_day"] as const;
export type ServiceLevel = (typeof SERVICE_LEVELS)[number];
export const isServiceLevel = (value: unknown): value is ServiceLevel => typeof value === "string" && (SERVICE_LEVELS as readonly string[]).includes(value);

export const CARRIER_KIND_LIST = ["in_house", "third_party"] as const satisfies readonly CarrierKind[];

/** The waybill number of a parcel: the order reference and the parcel's number ("TT-7K4M2Q9X-1"). */
export function parcelCode(ref: string, number: number): string {
  return `${ref}-${number}`;
}

/** "TT-7K4M2Q9X-1" → { ref, number }; null for anything else. */
export function parseParcelCode(code: string): { ref: string; number: number } | null {
  const match = /^([A-Z]{2,4}-[A-Z0-9]{4,16})-(\d{1,3})$/.exec(code.trim().toUpperCase());
  return match ? { ref: match[1], number: Number(match[2]) } : null;
}

/** The number in a parcel id `shp_<orderId>_<n>` (the orders module's ids); 0 when the id has another shape. */
export function parcelNumberOf(orderId: string, shipmentId: string): number {
  const prefix = `shp_${orderId}_`;
  if (!shipmentId.startsWith(prefix)) return 0;
  const tail = shipmentId.slice(prefix.length);
  return /^\d{1,4}$/.test(tail) ? Number(tail) : 0;
}

// ───────────────────────────────────────────────────────────────── money

/** What a carrier keeps from cash it collects: a flat amount plus basis points of the amount, rounded to the dinar. */
export function codFeeFor(collectedIqd: number, carrier: { codFeeIqd: number | null; codFeeBps: number | null }): number {
  if (!Number.isSafeInteger(collectedIqd) || collectedIqd <= 0) return 0;
  const flat = carrier.codFeeIqd ?? 0;
  const share = carrier.codFeeBps ? Math.round((collectedIqd * carrier.codFeeBps) / 10_000) : 0;
  return flat + share;
}

export type SettlementTotals = {
  /** Cash the couriers collected on the parcels of the settlement. */
  expectedIqd: number;
  /** What the carrier charges for those parcels (delivery, returns, its cash fee). */
  feesIqd: number;
  /** What the carrier owes the store: expected − fees (negative: the store owes the carrier). */
  netDueIqd: number;
  /** received − net due; null until the amount received is known. Negative = short, positive = over. */
  varianceIqd: number | null;
};

/** The totals of a settlement from its parcels and the amount received (negative: the store paid the carrier). */
export function settlementTotals(items: readonly { amountIqd: number; feeIqd: number }[], receivedIqd: number | null): SettlementTotals {
  const expectedIqd = items.reduce((sum, item) => sum + item.amountIqd, 0);
  const feesIqd = items.reduce((sum, item) => sum + item.feeIqd, 0);
  const netDueIqd = expectedIqd - feesIqd;
  return { expectedIqd, feesIqd, netDueIqd, varianceIqd: receivedIqd === null ? null : receivedIqd - netDueIqd };
}

// ───────────────────────────────────────────────────────────────── delivery fees (the rule of shipping/fees.server.ts)

export type FeePolicy = { flatFeeIqd: number; overridesEnabled: boolean; allOverrideIqd: number | null };

/**
 * The fee checkout charges to a governorate — the same rule as getShippingFee (shipping/fees.server.ts): the flat fee,
 * unless overrides are switched on and a governorate override, else an all-governorates override, exists.
 */
export function effectiveFee(policy: FeePolicy, governorateOverrideIqd: number | null): number {
  if (!policy.overridesEnabled) return policy.flatFeeIqd;
  return governorateOverrideIqd ?? policy.allOverrideIqd ?? policy.flatFeeIqd;
}

export type ZoneFeeRow = { id: string; name: string; isActive: boolean; overrideIqd: number | null };
export type FeeChange = { id: string; name: string; beforeIqd: number; afterIqd: number };

/** Active governorates whose fee changes between two policies (and per-governorate overrides): the impact of a fee edit. */
export function feeChanges(zones: readonly ZoneFeeRow[], before: FeePolicy, after: FeePolicy, overrideAfter?: { id: string; overrideIqd: number | null }): FeeChange[] {
  const out: FeeChange[] = [];
  for (const zone of zones) {
    if (!zone.isActive) continue;
    const beforeIqd = effectiveFee(before, zone.overrideIqd);
    const afterIqd = effectiveFee(after, overrideAfter && overrideAfter.id === zone.id ? overrideAfter.overrideIqd : zone.overrideIqd);
    if (beforeIqd !== afterIqd) out.push({ id: zone.id, name: zone.name, beforeIqd, afterIqd });
  }
  return out;
}

/** Highest delivery estimate a person may enter, in days. */
export const ETA_MAX_DAYS = 30;

export const SETTLEMENT_STATUS_LIST = ["draft", "submitted", "reconciled", "disputed"] as const satisfies readonly CodSettlementStatus[];
export const SETTLEMENT_TONE: Record<CodSettlementStatus, Tone> = { draft: "neutral", submitted: "warn", reconciled: "ok", disputed: "bad" };

/** Where the money of a settlement arrived (journal account by system key). */
export const RECEIVED_INTO = ["cash", "bank_clearing"] as const;
export type ReceivedInto = (typeof RECEIVED_INTO)[number];

// ───────────────────────────────────────────────────────────────── list filters (URL state)

export const STATUS_GROUPS = ["open", "on_road", "all"] as const;
export type StatusGroup = (typeof STATUS_GROUPS)[number];
export type StatusFilter = ShipmentStatus | StatusGroup;

export const SHIPMENT_FLAGS = ["no_waybill", "undocumented", "cod_unsettled", "attempts"] as const;
export type ShipmentFlag = (typeof SHIPMENT_FLAGS)[number];

export const SHIPMENT_SORTS = ["created_desc", "created_asc", "updated_desc"] as const;
export type ShipmentSort = (typeof SHIPMENT_SORTS)[number];

export const SHIPMENT_PAGE_SIZE = 25;

export type ShipmentFilters = {
  q: string;
  status: StatusFilter;
  carrier: string | null;
  governorate: string | null;
  flag: ShipmentFlag | null;
  sort: ShipmentSort;
  page: number;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

export function parseShipmentFilters(params: URLSearchParams): ShipmentFilters {
  const status = params.get("status") ?? "open";
  const flag = params.get("flag");
  const sort = params.get("sort");
  const page = Number(params.get("page") ?? "1");
  const carrier = params.get("carrier");
  const governorate = params.get("governorate");
  return {
    q: (params.get("q") ?? "").trim().slice(0, 60),
    status: isStatus(status) || (STATUS_GROUPS as readonly string[]).includes(status) ? (status as StatusFilter) : "open",
    carrier: carrier && (carrier === "none" || ID.test(carrier)) ? carrier : null,
    governorate: governorate && ID.test(governorate) ? governorate : null,
    flag: flag && (SHIPMENT_FLAGS as readonly string[]).includes(flag) ? (flag as ShipmentFlag) : null,
    sort: sort && (SHIPMENT_SORTS as readonly string[]).includes(sort) ? (sort as ShipmentSort) : "created_desc",
    page: Number.isSafeInteger(page) && page >= 1 && page <= 10_000 ? page : 1,
  };
}

/** "?status=failed&carrier=…" for these filters (defaults left out). */
export function shipmentSearch(filters: Partial<ShipmentFilters>): string {
  const params = new URLSearchParams();
  if (filters.q) params.set("q", filters.q);
  if (filters.status && filters.status !== "open") params.set("status", filters.status);
  if (filters.carrier) params.set("carrier", filters.carrier);
  if (filters.governorate) params.set("governorate", filters.governorate);
  if (filters.flag) params.set("flag", filters.flag);
  if (filters.sort && filters.sort !== "created_desc") params.set("sort", filters.sort);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const out = params.toString();
  return out ? `?${out}` : "";
}

/** Saved views as chips above the list. */
export const SHIPMENT_VIEWS: readonly { id: string; filters: Partial<ShipmentFilters> }[] = [
  { id: "open", filters: { status: "open" } },
  { id: "to_prepare", filters: { status: "packed", flag: "no_waybill" } },
  { id: "ready", filters: { status: "packed" } },
  { id: "on_road", filters: { status: "on_road" } },
  { id: "failed", filters: { status: "failed" } },
  { id: "returning", filters: { status: "returning" } },
  { id: "cod_unsettled", filters: { status: "all", flag: "cod_unsettled" } },
  { id: "all", filters: { status: "all" } },
];

// ───────────────────────────────────────────────────────────────── view models

/** A phone as the employee may see it: full with customer.phone.read_full, otherwise masked. */
export type PhoneView = { display: string; full: boolean; e164?: string };

/** How the courier handles money for a parcel. */
export type CodView =
  /** Cash to collect (the order's pending cash-on-delivery payment, carried by its first parcel). */
  | { kind: "collect"; amountIqd: number }
  /** Collected and recorded (the cash-on-delivery payment is paid). */
  | { kind: "collected"; amountIqd: number }
  /** A later parcel of a cash order: the first parcel carries the cash. */
  | { kind: "with_first" }
  /** Paid before delivery: collect nothing. */
  | { kind: "prepaid" }
  /** Not paid and nothing to collect (a transfer still awaited, a cancelled cash payment): do not hand over. */
  | { kind: "unpaid" };

export type ShipmentListRow = {
  id: string;
  code: string;
  number: number;
  orderId: string;
  ref: string;
  orderStatus: string;
  status: ShipmentStatus;
  carrier: { id: string; name: string } | null;
  trackingNo: string | null;
  governorate: string | null;
  cod: CodView;
  sensitive: boolean;
  documented: boolean;
  attempts: number;
  nextAttemptAt: number | null;
  settled: boolean;
  createdAt: number;
  shippedAt: number | null;
  deliveredAt: number | null;
  isDemo: boolean;
};

export type ShipmentListPage = {
  rows: ShipmentListRow[];
  total: number;
  page: number;
  pageCount: number;
  filters: ShipmentFilters;
  counts: Record<"open" | "on_road" | "packed" | "failed" | "returning", number>;
};

export type CarrierOption = {
  carrierId: string;
  name: string;
  kind: CarrierKind;
  serviceLevel: ServiceLevel;
  costIqd: number;
  codFeeIqd: number;
  totalIqd: number;
  etaDaysMin: number | null;
  etaDaysMax: number | null;
  codSupported: boolean;
  /** False when the parcel collects cash and the carrier does not collect. */
  eligible: boolean;
};

export type ParcelEvent = { id: string; kind: string; note: string | null; at: number; actor: string | null; data: Record<string, string | number | boolean | null> };
export type AttemptView = { attemptNo: number; outcome: DeliveryOutcome; reason: string | null; notes: string | null; nextAttemptAt: number | null; attemptedAt: number; recordedBy: string | null; proofUrl: string | null };

export type ShipmentDetail = {
  id: string;
  code: string;
  number: number;
  parcels: { id: string; number: number; status: ShipmentStatus }[];
  status: ShipmentStatus;
  updatedAt: number;
  carrier: { id: string; name: string; kind: CarrierKind; phone: string | null; trackingUrl: string | null } | null;
  serviceLevel: ServiceLevel | null;
  trackingNo: string | null;
  /** What the carrier charges for this parcel — only for who may see carrier cost (canSeeCarrierCost): absent otherwise. */
  costIqd?: number | null;
  /** Fee charged to the shopper minus the carrier's cost — profit.read only. */
  deliveryMarginIqd?: number | null;
  cod: CodView;
  settlement: { id: string; ref: string; status: CodSettlementStatus } | null;
  codSettledAt: number | null;
  order: {
    id: string;
    ref: string;
    status: string;
    paymentMethod: string | null;
    paymentStatus: string;
    totalIqd: number;
    shippingIqd: number;
    onHold: boolean;
    isDemo: boolean;
    preferredDay: string | null;
    preferredWindow: string | null;
  };
  recipient: { name: string | null; phone: PhoneView | null; governorateId: string | null; governorate: string | null; district: string | null; area: string | null; address: string | null; notes: string | null };
  items: { orderItemId: string; name: string; sku: string; qty: number; serials?: string[] }[];
  sensitive: boolean;
  packingPhotos: { fileId: string; url: string; note: string | null; at: number }[];
  proof: { url: string; receivedByName: string | null } | null;
  receivedByName: string | null;
  failureReason: string | null;
  events: ParcelEvent[];
  attempts: AttemptView[];
  createdAt: number;
  shippedAt: number | null;
  deliveredAt: number | null;
  returnedAt: number | null;
  /** True when the order moved on without its parcels (a follow-up that did not run): offer to bring them in line. */
  outOfStep: boolean;
  /** The order's lines that a return can restock or scrap (shipped → returned). */
  returnLines: { orderItemId: string; name: string; sku: string; qty: number }[];
  /** Why the courier cannot take the parcel yet (a parcel of the order without a waybill, this device without its packing photo). */
  pickupBlock: "no_waybill" | "undocumented" | null;
  can: {
    waybill: boolean;
    pickup: boolean;
    move: boolean;
    attempt: boolean;
    deliver: boolean;
    deliverOrder: boolean;
    proof: boolean;
    receiveReturn: boolean;
    print: boolean;
    sync: boolean;
  };
};

export type SettlementItemView = {
  shipmentId: string;
  code: string;
  orderId: string;
  ref: string;
  status: ShipmentStatus;
  governorate: string | null;
  completedAt: number | null;
  /** The cash-on-delivery payment's amount (what the courier had to collect), null when the parcel carries none. */
  dueIqd: number | null;
  paymentStatus: string | null;
  amountIqd: number;
  feeIqd: number;
  /** The carrier's rate on the waybill (the charge suggested with its cash fee); null when no rate was recorded. */
  rateIqd: number | null;
  isDemo: boolean;
};

export type SettlementView = {
  id: string;
  ref: string;
  status: CodSettlementStatus;
  carrier: { id: string; name: string; codFeeIqd: number | null; codFeeBps: number | null };
  periodFrom: number | null;
  periodTo: number | null;
  totals: SettlementTotals;
  receivedIqd: number | null;
  notes: string | null;
  statementUrl: string | null;
  createdBy: string | null;
  createdAt: number;
  submittedBy: string | null;
  reconciledBy: string | null;
  reconciledAt: number | null;
  journalEntryId: string | null;
  items: SettlementItemView[];
  /** A parcel's cash or charge was corrected by hand: with a variance, this makes the reconciliation a second person's. */
  corrected: boolean;
  /** The books take a difference (variance or correction): nobody who created, corrected or submitted it reconciles it. */
  secondPerson: boolean;
  history: { id: string; action: string; actor: string | null; reason: string | null; at: number }[];
  can: { edit: boolean; submit: boolean; reconcile: boolean; reconcileReason: "self" | "permission" | null; dispute: boolean; reopen: boolean; discard: boolean; recordCod: boolean };
};
