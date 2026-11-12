/**
 * Purchasing rules (admin module 09) — pure functions and constants: no database, no server imports, no floats in
 * money. The services load the facts and call these; the pages and the tests call them directly (client-safe).
 *
 *   toIqd(minor, currency, rateMicros)        a supplier-currency amount in IQD at a dated rate, exactly (BigInt)
 *   poTotals(lines, shipping, other)           a purchase order's subtotal and total in the supplier's minor units
 *   poTotalsOrNull(…)                          the same, null when the total is too big to be exact (a field error)
 *   needsApproval(totalIqd, limit, windowIqd)  above the spending limit a second person decides (09.03) — counting
 *                                              what the same person approved for the same supplier in the last
 *                                              SPLIT_WINDOW_DAYS (an order split into pieces still meets four eyes)
 *   threeWayMatch(poLines, invoiceLines, …)    the order ↔ receipt ↔ invoice comparison of one invoice (09.04, 09.07),
 *                                              lines and the shipping / other charges
 *   rateSupplier(facts)                        the supplier rating from on-time deliveries and defects (09.08)
 *   CLAIM_TRANSITIONS                          how a supplier claim moves (09.06)
 *   receiptStateOf(receipt)                    draft · posting (stock moving or interrupted) · posted · cancelled
 */
import type { InvoiceDiscrepancy, PurchaseOrderStatus, RfqStatus, SupplierClaimKind, SupplierClaimStatus, SupplierInvoiceStatus, SupplierStatus } from "~/server/db/schema";
import { COST_CURRENCIES, isCostCurrency, parseDecimal, parseRateMicros, purchaseCostIqd, type CostCurrency } from "../pricing/rules";

export { COST_CURRENCIES, isCostCurrency, parseDecimal, parseRateMicros, type CostCurrency };

export const DAY_MS = 86_400_000;
/** Asia/Baghdad is UTC+3 all year (no daylight saving). */
export const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;

/**
 * The spending limit of 09.03: a purchase order whose total is above it (in IQD at the order's rate) waits for a
 * second person holding purchasing.po.approve — never its requester. At or below it the requester's own submission
 * approves it. One store-wide figure, a constant until settings (22) holds the key `purchasing.po_approval_limit_iqd`
 * (requested); per-role limits need approval chains (15.06).
 */
export const PO_SPENDING_LIMIT_IQD = 1_000_000;
/**
 * Orders one person approved within the limit for one supplier count together over this many days: the next order
 * that brings them above the limit waits for a second person (an order split into pieces still meets four eyes).
 */
export const SPLIT_WINDOW_DAYS = 7;
/** A posting that started this long ago and never finished may be resumed by someone else (crash recovery). */
export const POSTING_LEASE_MS = 5 * 60_000;
/** Marker kept in receipts.received_by while the receipt's stock is moving: "posting:<token>". */
export const POSTING_PREFIX = "posting:";
/** Lines of one document (order, quote, receipt, invoice, claim). */
export const MAX_LINES = 100;
export const MAX_QTY = 100_000;
/** Largest document total a form accepts (10 billion IQD): a typo guard that keeps every sum an exact integer. */
export const MAX_DOC_IQD = 10_000_000_000;

/** The supplier rating (09.08): what it looks at and how it weighs it. */
export const RATING = {
  windowDays: 365,
  /** Fewer posted receipts than this in the window → no rating ("not enough history"), never a guess. */
  minReceipts: 3,
  onTimeWeight: 60,
  qualityWeight: 40,
  grades: [
    { grade: "A", min: 90 },
    { grade: "B", min: 75 },
    { grade: "C", min: 60 },
    { grade: "D", min: 0 },
  ],
} as const;

export const SUPPLIER_STATUS_LIST: readonly SupplierStatus[] = ["active", "inactive", "blocked"];
export const PO_STATUS_LIST: readonly PurchaseOrderStatus[] = ["draft", "pending_approval", "approved", "sent", "partially_received", "received", "closed", "cancelled"];
/** Orders that still expect goods (what inventory's "incoming" column counts). */
export const OPEN_PO_STATUSES: readonly PurchaseOrderStatus[] = ["approved", "sent", "partially_received"];
/** Saved views of the order list (URL `view=`). */
export const PO_VIEWS = ["open", "pending_approval", "draft", "late", "received", "closed", "all"] as const;
export type PoView = (typeof PO_VIEWS)[number];
export const RFQ_STATUS_LIST: readonly RfqStatus[] = ["draft", "sent", "quoted", "awarded", "cancelled"];
export const INVOICE_STATUS_LIST: readonly SupplierInvoiceStatus[] = ["matched", "mismatch", "approved", "void"];
export const CLAIM_KIND_LIST: readonly SupplierClaimKind[] = ["shortage", "damage", "defect", "wrong_item", "price", "return"];
export const CLAIM_STATUS_LIST: readonly SupplierClaimStatus[] = ["open", "submitted", "accepted", "rejected", "credited", "closed"];

/** URL filters of the lists (client-safe, so the pages can render their chips). */
export const SUPPLIER_SORTS = ["name", "code", "rating", "lead"] as const;
export const PO_SORTS = ["created", "expected", "ref", "supplier"] as const;
export const RFQ_FILTERS = ["open", "draft", "sent", "quoted", "awarded", "cancelled", "all"] as const;
export const RECEIPT_FILTERS = ["open", "draft", "posting", "posted", "cancelled", "all"] as const;
/** "to_accept" = mismatches this employee may accept (not ones they recorded) — the bell's and the home's count. */
export const INVOICE_FILTERS = ["open", "mismatch", "to_accept", "matched", "approved", "void", "all"] as const;
/** "active" = not settled yet (open, submitted, accepted). */
export const CLAIM_FILTERS = ["active", "open", "submitted", "accepted", "rejected", "credited", "closed", "all"] as const;
export const ALERT_KINDS = ["invoice_qty", "invoice_price", "rejected", "over_received", "short_closed", "late"] as const;
export const LANDED_KIND_LIST = ["freight", "customs", "insurance", "fees", "commission", "other"] as const;
export const ALLOCATION_METHOD_LIST = ["by_value", "by_qty", "by_weight"] as const;

/** Where a claim may go next. "closed" is the end; a rejected claim can only be closed. */
export const CLAIM_TRANSITIONS: Readonly<Record<SupplierClaimStatus, readonly SupplierClaimStatus[]>> = {
  open: ["submitted", "closed"],
  submitted: ["accepted", "rejected", "closed"],
  accepted: ["credited", "closed"],
  rejected: ["closed"],
  credited: ["closed"],
  closed: [],
};
/** Kinds whose goods can physically go back to the supplier (stock leaves through the core). */
export const RETURNABLE_CLAIM_KINDS: readonly SupplierClaimKind[] = ["return", "defect", "damage", "wrong_item"];
/** Kinds that count as defects in the supplier rating. */
export const DEFECT_CLAIM_KINDS: readonly SupplierClaimKind[] = ["defect", "damage", "wrong_item"];

// ───────────────────────────────────────────────────────────────── numbers

/** Arabic-Indic (٠–٩) and Persian (۰–۹) digits become 0–9 (Arabic and Kurdish keyboards type those). */
export function normalizeDigits(value: string): string {
  return value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
}

/** A whole number typed in a field ("12", "١٢", "1,200"); undefined when empty, NaN when it is not one. */
export function parseCount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : Number.NaN;
  if (typeof value !== "string") return undefined;
  const raw = normalizeDigits(value).replace(/[,٬،\s]/g, "").trim();
  if (raw === "") return undefined;
  return /^\d+$/.test(raw) && raw.length <= 9 ? Number(raw) : Number.NaN;
}

export function decimalsOf(currency: string): number {
  return isCostCurrency(currency) ? COST_CURRENCIES[currency] : 0;
}

/** IQD of `minor` units of `currency` at `rateMicros` (IQD per unit × 10⁶), rounded half up. IQD itself is 1:1. */
export function toIqd(minor: number, currency: string, rateMicros: number | null): number | null {
  if (currency === "IQD") return minor;
  if (rateMicros === null || rateMicros <= 0) return null;
  return purchaseCostIqd(minor, decimalsOf(currency), rateMicros);
}

/** "1234.5" for a form value from minor units ("1234.50" with two decimals → "1234.5" is kept as "1234.50"). */
export function minorToText(minor: number | null | undefined, currency: string): string {
  if (minor === null || minor === undefined) return "";
  const decimals = decimalsOf(currency);
  if (decimals === 0) return String(minor);
  const negative = minor < 0;
  const digits = String(Math.abs(minor)).padStart(decimals + 1, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -decimals)}.${digits.slice(-decimals)}`;
}

/** The rate as typed ("1310", "1310.25") from IQD per unit × 10⁶. */
export function rateToText(rateMicros: number | null | undefined): string {
  if (rateMicros === null || rateMicros === undefined) return "";
  const whole = Math.floor(rateMicros / 1_000_000);
  const fraction = String(rateMicros % 1_000_000).padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export type PoLineAmount = { qty: number; unitCostMinor: number };

/** Subtotal and total of an order in the supplier's minor units (the CHECK total = subtotal + shipping + other). */
export function poTotals(lines: readonly PoLineAmount[], shippingMinor: number, otherMinor: number): { subtotalMinor: number; totalMinor: number } {
  const subtotal = lines.reduce((sum, line) => sum + BigInt(line.qty) * BigInt(line.unitCostMinor), 0n);
  const total = subtotal + BigInt(shippingMinor) + BigInt(otherMinor);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("poTotals: total out of range");
  return { subtotalMinor: Number(subtotal), totalMinor: Number(total) };
}

/** poTotals, or null when the total is too big to be an exact integer (answered as a field error, never a crash). */
export function poTotalsOrNull(lines: readonly PoLineAmount[], shippingMinor: number, otherMinor: number): { subtotalMinor: number; totalMinor: number } | null {
  try {
    return poTotals(lines, shippingMinor, otherMinor);
  } catch {
    return null;
  }
}

/**
 * True when an order of this total (IQD) needs a second person (09.03). `windowIqd`: what the same person approved
 * within the limit for the same supplier in the last SPLIT_WINDOW_DAYS — pieces of one purchase count together.
 */
export function needsApproval(totalIqd: number, limitIqd: number = PO_SPENDING_LIMIT_IQD, windowIqd = 0): boolean {
  return totalIqd + windowIqd > limitIqd;
}

// ───────────────────────────────────────────────────────────────── dates (Iraq time)

/** "YYYY-MM-DD" of the Baghdad day that contains `ms`. */
export function baghdadDate(ms: number): string {
  return new Date(ms + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

/** Epoch ms of 00:00 Baghdad of a "YYYY-MM-DD" date (Arabic digits accepted), or null when it is not a real date. */
export function parseBaghdadDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const text = normalizeDigits(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const ms = Date.parse(`${text}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== text) return null;
  return ms - BAGHDAD_OFFSET_MS;
}

/** The end of the Baghdad day that starts at (or contains) `ms`. */
export function endOfBaghdadDay(ms: number): number {
  return Math.floor((ms + BAGHDAD_OFFSET_MS) / DAY_MS) * DAY_MS - BAGHDAD_OFFSET_MS + DAY_MS;
}

/** An order is late when its expected day has ended and goods are still expected. */
export function isLate(order: { status: string; expectedAt: number | null }, now: number): boolean {
  return order.expectedAt !== null && (OPEN_PO_STATUSES as readonly string[]).includes(order.status) && now >= endOfBaghdadDay(order.expectedAt);
}

// ───────────────────────────────────────────────────────────────── receipts

export type ReceiptState = "draft" | "posting" | "posted" | "cancelled";

/** A posted receipt whose `received_by` still carries the posting marker is moving stock (or was interrupted). */
export function receiptStateOf(receipt: { status: string; receivedBy: string | null }): ReceiptState {
  if (receipt.status === "draft") return "draft";
  if (receipt.status === "cancelled") return "cancelled";
  return receipt.receivedBy?.startsWith(POSTING_PREFIX) ? "posting" : "posted";
}

// ───────────────────────────────────────────────────────────────── three-way match (09.04, 09.07)

export type MatchPoLine = { poItemId: string; variantId: string; qtyOrdered: number; qtyReceived: number; unitCostMinor: number };
export type MatchInvoiceLine = { poItemId: string | null; variantId: string; qty: number; unitCostMinor: number };
/** Shipping + other charges: what the order agreed, what the order's other live invoices billed, what this one bills. */
export type MatchCharges = { orderedMinor: number; billedElsewhereMinor: number; billedMinor: number };

/**
 * One difference the match found. The schema's InvoiceDiscrepancy knows "qty" and "unit_cost"; the match adds
 * "charges" (variantId "", po = the order's shipping + other, invoiced = what the order's live invoices bill) — stored
 * in the same JSON column (the schema owner is asked to add it to the type).
 */
export type MatchDiscrepancy = Omit<InvoiceDiscrepancy, "field"> & { field: InvoiceDiscrepancy["field"] | "charges" };

/**
 * The differences between one invoice and its order and receipts:
 *   · quantity — the units billed on this and the order's other live invoices are more than the units received
 *     (accepted into stock); a line the order does not have is billed for nothing that was ordered
 *   · unit cost — the invoice's unit cost differs from the order's (same currency; no tolerance)
 *   · charges — the shipping and other charges billed on this and the order's other live invoices are more than the
 *     order's shipping + other (billed in any split between the two; billing less is no variance)
 * `invoicedElsewhere`: units of each order line already billed on the order's other invoices that are not void.
 * An empty result is a match.
 */
export function threeWayMatch(poLines: readonly MatchPoLine[], invoiceLines: readonly MatchInvoiceLine[], invoicedElsewhere: ReadonlyMap<string, number> = new Map(), charges?: MatchCharges): MatchDiscrepancy[] {
  const out: MatchDiscrepancy[] = [];
  const byId = new Map(poLines.map((line) => [line.poItemId, line]));
  for (const line of invoiceLines) {
    const po = line.poItemId ? byId.get(line.poItemId) : undefined;
    if (!po) {
      out.push({ variantId: line.variantId, field: "qty", po: null, received: 0, invoiced: line.qty });
      continue;
    }
    const billed = (invoicedElsewhere.get(po.poItemId) ?? 0) + line.qty;
    if (billed > po.qtyReceived) out.push({ variantId: po.variantId, field: "qty", po: po.qtyOrdered, received: po.qtyReceived, invoiced: billed });
    if (line.unitCostMinor !== po.unitCostMinor) out.push({ variantId: po.variantId, field: "unit_cost", po: po.unitCostMinor, received: null, invoiced: line.unitCostMinor });
  }
  if (charges && charges.billedMinor > 0 && charges.billedElsewhereMinor + charges.billedMinor > charges.orderedMinor) {
    out.push({ variantId: "", field: "charges", po: charges.orderedMinor, received: null, invoiced: charges.billedElsewhereMinor + charges.billedMinor });
  }
  return out;
}

// ───────────────────────────────────────────────────────────────── supplier rating (09.08)

export type RatingFacts = {
  /** Posted receipts in the window. */
  receipts: number;
  /** Units delivered (received, accepted or not) in the window. */
  unitsReceived: number;
  /** …of which on or before the order's expected day (orders with an expected day only). */
  unitsOnTime: number;
  /** …after it. */
  unitsLate: number;
  /** Units of open orders whose expected day has passed and that have not arrived. */
  unitsOverdue: number;
  /** Units that never came: orders closed short after their expected day (they count as not on time). */
  unitsShortClosed?: number;
  /** Units refused at inspection + units of defect / damage / wrong-item claims beyond what inspection refused. */
  defectUnits: number;
  /** Days from ordering (sent, else approved) to each receipt. */
  leadDays: readonly number[];
  /** The lead time the supplier promised (profile). */
  promisedLeadDays: number | null;
};

export type SupplierRating = RatingFacts & {
  enough: boolean;
  onTimeRate: number | null;
  defectRate: number | null;
  /** 0–100, only with enough history and both rates known. */
  score: number | null;
  grade: "A" | "B" | "C" | "D" | null;
  avgLeadDays: number | null;
};

/**
 * score = 60 × on-time rate + 40 × (1 − defect rate), rounded; grade A ≥ 90, B ≥ 75, C ≥ 60, else D. With fewer than
 * RATING.minReceipts posted receipts in the window there is no score — the page says why instead of guessing.
 */
export function rateSupplier(facts: RatingFacts): SupplierRating {
  const due = facts.unitsOnTime + facts.unitsLate + facts.unitsOverdue + (facts.unitsShortClosed ?? 0);
  const onTimeRate = due > 0 ? facts.unitsOnTime / due : null;
  const defectRate = facts.unitsReceived > 0 ? Math.min(1, facts.defectUnits / facts.unitsReceived) : null;
  const enough = facts.receipts >= RATING.minReceipts;
  const score = enough && onTimeRate !== null && defectRate !== null ? Math.round(RATING.onTimeWeight * onTimeRate + RATING.qualityWeight * (1 - defectRate)) : null;
  const grade = score === null ? null : (RATING.grades.find((entry) => score >= entry.min)?.grade ?? "D");
  const avgLeadDays = facts.leadDays.length > 0 ? Math.round((facts.leadDays.reduce((sum, days) => sum + days, 0) / facts.leadDays.length) * 10) / 10 : null;
  return { ...facts, enough, onTimeRate, defectRate, score, grade, avgLeadDays };
}
