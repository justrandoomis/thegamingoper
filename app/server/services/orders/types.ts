/**
 * Order view models — CLIENT-SAFE (types and constants only; no server imports at runtime).
 *
 * What a shopper sees about their own order: statuses, lines, totals, payment state and transfer
 * instructions, proof status, shipment tracking, refunds and a timeline. Never cost data, internal
 * notes, risk flags, staff identities, serial numbers or anything about other customers. Phone
 * numbers are masked. Services in this folder build these; components only render them.
 */
import type { ImageRef, OrderStatus, PaymentMethod, PaymentStatus, UsedGrade } from "~/lib/dto";

export type { OrderStatus, PaymentMethod, PaymentStatus };

/** Requested delivery time of day — a preference, never a promise. */
export const PREFERRED_WINDOWS = ["morning", "afternoon", "evening", "any"] as const;
export type PreferredWindow = (typeof PREFERRED_WINDOWS)[number];

/** State of the latest transfer proof of an order. */
export type ProofStatus = "none" | "submitted" | "approved" | "rejected";

export type ShipmentStatusView = "pending" | "packed" | "handed_over" | "in_transit" | "out_for_delivery" | "delivered" | "failed" | "returning" | "returned" | "cancelled";

export type OrderLineView = {
  id: string;
  kind: "variant" | "used_unit";
  /** Name as sold (snapshot), in the request's language. */
  name: string;
  /** Used units: their grade. */
  grade: UsedGrade | null;
  /** Locale-less path to the item's page today, when it still has one. */
  href: string | null;
  image: ImageRef;
  qty: number;
  unitPriceIqd: number;
  lineTotalIqd: number;
  /** Units of this line refunded so far. */
  refundedQty: number;
  /** Warranty as sold: new items in months, used units in days; null = none. */
  warranty: { months: number } | { days: number } | null;
};

/** Where to send a manual transfer — read from settings at the time of the request. */
export type TransferInstructions = { method: "bank_transfer"; accountNumber: string; recipientName: string } | { method: "zaincash"; number: string };

export type OrderPaymentView = {
  method: PaymentMethod | null;
  status: PaymentStatus;
  /** What is still owed (0 once paid). */
  amountDueIqd: number;
  paidIqd: number;
  refundedIqd: number;
  /** Deadline for uploading a transfer proof; null when none applies. */
  dueAt: number | null;
  /** Shown while a transfer is awaited (status awaiting_payment). */
  instructions: TransferInstructions | null;
  proof: {
    status: ProofStatus;
    submittedAt: number | null;
    declaredAmountIqd: number | null;
    /** Why the last proof was rejected, as written by the reviewer. */
    rejectReason: string | null;
  };
  /** True while the shopper may upload a (new) proof. */
  canUploadProof: boolean;
};

export type ShipmentView = {
  status: ShipmentStatusView;
  carrierName: string | null;
  trackingNo: string | null;
  /** Public tracking page of the carrier, when it has one. */
  trackingUrl: string | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  events: { kind: string; at: number }[];
};

export const ORDER_TIMELINE_KINDS = [
  "placed",
  "proof_submitted",
  "payment_rejected",
  "payment_verified",
  "cod_collected",
  "confirmed",
  "preparing",
  "shipped",
  "delivered",
  "cancelled",
  "returned",
  "refunded",
] as const;
export type OrderTimelineKind = (typeof ORDER_TIMELINE_KINDS)[number];

export type OrderRefundView = { amountIqd: number; method: "original" | "wallet" | "cash"; status: "pending" | "paid"; at: number };

export type OrderView = {
  ref: string;
  status: OrderStatus;
  placedAt: number;
  confirmedAt: number | null;
  shippedAt: number | null;
  deliveredAt: number | null;
  cancelledAt: number | null;
  /** Placed while the store ran in demo mode: nothing will be shipped or charged. */
  isDemo: boolean;
  contact: { name: string | null; phoneMasked: string };
  delivery: {
    governorate: string;
    district: string | null;
    area: string | null;
    address: string | null;
    notes: string | null;
    /** "YYYY-MM-DD" — requested, subject to confirmation. */
    preferredDay: string | null;
    preferredWindow: PreferredWindow | null;
  };
  lines: OrderLineView[];
  /** Sum of quantities. */
  itemCount: number;
  totals: { subtotalIqd: number; discountIqd: number; shippingIqd: number; totalIqd: number };
  coupon: { code: string } | null;
  payment: OrderPaymentView;
  shipments: ShipmentView[];
  refunds: OrderRefundView[];
  timeline: { kind: OrderTimelineKind; at: number }[];
};

/** One row of "my orders". */
export type OrderSummary = {
  ref: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  paymentMethod: PaymentMethod | null;
  placedAt: number;
  totalIqd: number;
  itemCount: number;
  /** Name of the first line, for the row title. */
  firstItemName: string;
  image: ImageRef | null;
  isDemo: boolean;
};

/** What placeOrder returns (and returns again, unchanged, for a retry with the same idempotency key). */
export type PlaceOrderResult = {
  ref: string;
  orderId: string;
  /** Secret for the guest confirmation link (/order/<ref>?t=<token>). Only its hash is stored. */
  accessToken: string;
  paymentStatus: PaymentStatus;
  totalIqd: number;
  /** True when this call returned an order placed by an earlier call with the same key. */
  replayed: boolean;
};
