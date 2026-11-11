/**
 * Admin 06 point of sale — CLIENT-SAFE constants, pure rules and view-model types (no server imports at runtime).
 * The till (routes/admin/pos/sell.tsx) uses the same rules offline that the services apply on the server, so a sale
 * rung up without a connection is priced and limited exactly like one rung up online — and the server checks again.
 */

/** Iraqi dinar notes counted at the till (largest first). Coins are not in circulation. */
export const IQD_DENOMINATIONS = [50_000, 25_000, 10_000, 5_000, 1_000, 500, 250] as const;
export type Denomination = (typeof IQD_DENOMINATIONS)[number];

/** Cash moved in or out of a drawer by hand (sales and refunds move it by themselves). */
export const CASH_MOVE_KINDS = ["pay_in", "pay_out", "drop"] as const;
export type CashMoveKind = (typeof CASH_MOVE_KINDS)[number];

export const TILL_METHODS = ["pos_cash", "pos_card", "wallet"] as const;
export type TillMethod = (typeof TILL_METHODS)[number];

/**
 * A cashier's own discount limit (pos.discount.apply): at most this share of a line's price, and of the whole sale.
 * Beyond it — or under a SKU's margin floor — only pricing.discount.override. A module constant until settings (22)
 * has a key for it (requested).
 */
export const CASHIER_DISCOUNT_LIMIT_BPS = 1_000;
/** A catalogue snapshot on a device is used for offline sales for at most this long. */
export const CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Largest opening float / cash move / count accepted (a field error above it). */
export const MAX_DRAWER_IQD = 1_000_000_000;

export const SHIFT_STATES = ["open", "review", "closed"] as const;
export type ShiftState = (typeof SHIFT_STATES)[number];

/** open · review (counted with a difference nobody approved yet) · closed (final). */
export function shiftStateOf(shift: { status: string; varianceIqd: number | null; approvedBy: string | null }): ShiftState {
  if (shift.status === "open") return "open";
  if ((shift.varianceIqd ?? 0) !== 0 && !shift.approvedBy) return "review";
  return "closed";
}

export const SHIFT_TONE: Record<ShiftState, "ok" | "warn" | "neutral"> = { open: "ok", review: "warn", closed: "neutral" };

// ───────────────────────────────────────────────────────────────── numbers typed by a person

const DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4", "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

/** Arabic-Indic and Persian (Kurdish keyboard) digits to Latin ones. */
export function latinDigits(text: string): string {
  return text.replace(/[٠-٩۰-۹]/g, (digit) => DIGITS[digit] ?? digit);
}

/**
 * A whole amount typed by a person: Latin, Arabic-Indic or Persian digits, thousands separators (",", "٬", "،", ".",
 * spaces) allowed only in groups of three; a decimal fraction is refused (money is whole dinars). "" → null;
 * anything else that is not a whole number → NaN.
 */
export function parseWhole(raw: string | null | undefined): number | null {
  const text = latinDigits(String(raw ?? "")).trim().replace(/[\s  ]/g, "");
  if (text === "") return null;
  const unsigned = text.replace(/^[-−]/, "");
  if (!/^\d{1,3}([,٬،.]\d{3})*$|^\d+$/.test(unsigned)) return Number.NaN;
  const value = Number(unsigned.replace(/[,٬،.]/g, ""));
  if (!Number.isSafeInteger(value)) return Number.NaN;
  return text.startsWith("-") || text.startsWith("−") ? -value : value;
}

/** A percentage typed by a person ("10", "٧٫٥", "12.5%") → basis points; null when empty, NaN when not a number 0–100. */
export function parsePercentBps(raw: string | null | undefined): number | null {
  const text = latinDigits(String(raw ?? "")).trim().replace(/[%٪\s]/g, "").replace(/[٫,]/g, ".");
  if (text === "") return null;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return Number.NaN;
  const bps = Math.round(Number(text) * 100);
  return bps >= 0 && bps <= 10_000 ? bps : Number.NaN;
}

/** floor(amount × bps / 10,000), exact for any amount a sale can carry. */
export function bpsShare(amountIqd: number, bps: number): number {
  return Number((BigInt(Math.max(0, Math.floor(amountIqd))) * BigInt(Math.max(0, Math.floor(bps)))) / 10_000n);
}

// ───────────────────────────────────────────────────────────────── a sale's sums (the till and the server agree)

export type CartLineLike = { unitPriceIqd: number; qty: number; discountIqd: number };

/** Gross, discounts and total of a cart (integer IQD). */
export function cartTotals(lines: readonly CartLineLike[], orderDiscountIqd: number) {
  let gross = 0;
  let lineDiscount = 0;
  for (const line of lines) {
    gross += line.unitPriceIqd * line.qty;
    lineDiscount += Math.min(line.discountIqd, line.unitPriceIqd * line.qty);
  }
  const subtotal = gross - lineDiscount;
  const orderDiscount = Math.min(Math.max(0, orderDiscountIqd), subtotal);
  return { grossIqd: gross, lineDiscountIqd: lineDiscount, subtotalIqd: subtotal, orderDiscountIqd: orderDiscount, discountIqd: lineDiscount + orderDiscount, totalIqd: subtotal - orderDiscount };
}

/**
 * Which discounts the cashier may give alone: every line's discount and the sale's total discount at most
 * `limitBps` of the price. Returns the first line index (or "order") that goes beyond it, or null.
 */
export function discountBeyondLimit(lines: readonly CartLineLike[], orderDiscountIqd: number, limitBps: number = CASHIER_DISCOUNT_LIMIT_BPS): number | "order" | null {
  for (const [index, line] of lines.entries()) {
    if (line.discountIqd > bpsShare(line.unitPriceIqd * line.qty, limitBps)) return index;
  }
  const totals = cartTotals(lines, orderDiscountIqd);
  if (totals.discountIqd > bpsShare(totals.grossIqd, limitBps)) return "order";
  return null;
}

// ───────────────────────────────────────────────────────────────── view models

/** What the till knows about an item (a lookup, a search hit, the offline catalogue). Never cost data. */
export type TillItem = {
  kind: "variant" | "used";
  variantId: string;
  usedUnitId: string | null;
  sku: string;
  name: string;
  barcodes: string[];
  /** What one unit is charged (the price list's price when one applies). */
  unitPriceIqd: number;
  /** The SKU's own price (shown struck when a list price applies). */
  basePriceIqd: number;
  listCode: string | null;
  trackSerials: boolean;
  bundle: boolean;
  /** Free units at this store (its shelves included). */
  stockHere: number;
  /** Free units the online store can sell (all sellable locations). */
  stockAll: number;
  warrantyMonths: number | null;
  warrantyDays: number | null;
  /** The serial scanned to find it (serial-tracked items, used devices). */
  serial: { id: string; serial: string } | null;
  grade: string | null;
};

export type LookupResult =
  | { kind: "item"; item: TillItem }
  | { kind: "serial_unavailable"; serial: string; status: string; here: boolean }
  | { kind: "serial_hidden" }
  | { kind: "not_sellable"; sku: string; reason: "inactive" | "archived" | "no_price" }
  | { kind: "none"; code: string };

export type CatalogSnapshot = {
  /** When the server built it (prices and stock as of then). */
  at: number;
  registerId: string;
  locationId: string;
  items: TillItem[];
};

export type CustomerHit = {
  id: string;
  name: string | null;
  phoneMasked: string;
  /** The wallet's balance — only for roles with customers.wallet.read (null otherwise: ask the customer). */
  walletIqd: number | null;
  status: "active" | "blocked" | string;
  segmentIds: string[];
};

export type SaleLineInput = {
  variantId?: string;
  usedUnitId?: string;
  qty: number;
  /** The unit price the till showed (the server prices again and compares). */
  unitPriceIqd: number;
  discountIqd: number;
  /** Serial NUMBERS scanned for the line (resolved on the server; offline-safe). */
  serials: string[];
};

export type SalePaymentInput = { method: TillMethod; amountIqd: number; tenderedIqd?: number; reference?: string | null };

export type SaleRequest = {
  idempotencyKey: string;
  shiftId: string;
  customer: { id?: string | null; phone?: string | null; name?: string | null } | null;
  lines: SaleLineInput[];
  orderDiscountIqd: number;
  payments: SalePaymentInput[];
  discountReason?: string | null;
  notes?: string | null;
  /** Rung up without a connection: the device's time (epoch ms). */
  offlineCreatedAt?: number | null;
  /** A queued sale whose prices changed since: record it at the prices the customer paid (pricing.discount.override). */
  acceptChargedPrices?: boolean;
  /** The goods left although the system had them promised elsewhere (inventory.oversell.authorize). */
  allowOversell?: boolean;
  /** Why (an accepted price, an oversell). */
  overrideReason?: string | null;
};

export type SaleOutcome =
  | { ok: true; ref: string; receiptNumber: string | null; totalIqd: number; changeIqd: number; replayed: boolean; lateForClosedShift: boolean }
  | {
      ok: false;
      code: string;
      message?: string;
      fields?: Record<string, string>;
      /** price_changed: the lines whose price moved (index → the price now). */
      prices?: { index: number; unitPriceIqd: number }[];
      /** Who may resolve it: the override a person needs. */
      resolvable?: "accept_prices" | "oversell" | null;
    };

export type ShiftCash = {
  /** Opening float + every cash movement (reviewers only — the drawer's owner counts blind). */
  expectedIqd: number | null;
  salesIqd: number | null;
  refundsIqd: number | null;
  payInIqd: number | null;
  payOutIqd: number | null;
  dropIqd: number | null;
};

export type ShiftView = {
  id: string;
  state: ShiftState;
  register: { id: string; code: string; name: string };
  location: { id: string; code: string; name: string } | null;
  openedBy: { id: string; name: string };
  openedAt: number;
  closedBy: { id: string; name: string } | null;
  closedAt: number | null;
  approvedBy: { id: string; name: string } | null;
  openingFloatIqd: number;
  countedCashIqd: number | null;
  /** Reviewers only (null for the drawer's owner — blind count). */
  expectedCashIqd: number | null;
  varianceIqd: number | null;
  varianceNote: string | null;
  denominations: Record<string, number> | null;
  notes: string | null;
  sales: { count: number; totalIqd: number | null };
  mine: boolean;
};

export type ShiftReport = ShiftView & {
  cash: ShiftCash;
  byMethod: { method: TillMethod; count: number; totalIqd: number }[] | null;
  discounts: { lines: number; lineIqd: number; orderIqd: number; sales: number } | null;
  moves: { id: string; kind: string; amountIqd: number; reason: string | null; at: number; by: string; orderRef: string | null }[];
  canReview: boolean;
  reviewBlocked: "own_shift" | null;
};

export type ShiftListRow = Pick<ShiftView, "id" | "state" | "register" | "openedBy" | "openedAt" | "closedAt" | "openingFloatIqd" | "countedCashIqd" | "expectedCashIqd" | "varianceIqd" | "sales" | "mine">;

export type RegisterRow = {
  id: string;
  code: string;
  name: string;
  isActive: boolean;
  branch: { id: string; code: string; name: string } | null;
  location: { id: string; code: string; name: string; kind: string; isActive: boolean } | null;
  openShift: { id: string; openedBy: string; openedAt: number } | null;
};

export type SaleRow = {
  orderId: string;
  ref: string;
  receiptNumber: string | null;
  at: number;
  offlineAt: number | null;
  register: { code: string; name: string } | null;
  shiftId: string | null;
  cashier: string | null;
  customer: string | null;
  totalIqd: number;
  discountIqd: number;
  methods: TillMethod[];
  status: string;
  paymentStatus: string;
  refundedIqd: number;
  isDemo: boolean;
};

/** A receipt as the print view shows it (frozen at the sale; serial numbers only for inventory.serial.read). */
export type ReceiptView = {
  ref: string;
  number: string | null;
  at: number;
  offlineAt: number | null;
  register: { code: string; name: string };
  cashier: string | null;
  customer: { name: string | null; phoneMasked: string | null; account: boolean } | null;
  lines: { sku: string; name: string; qty: number; unitPriceIqd: number; discountIqd: number; totalIqd: number; serials: string[] | null; warrantyMonths: number | null; warrantyDays: number | null; used: boolean }[];
  subtotalIqd: number;
  orderDiscountIqd: number;
  discountIqd: number;
  totalIqd: number;
  payments: { method: TillMethod; amountIqd: number; reference: string | null }[];
  tenderedIqd: number | null;
  changeIqd: number;
  /** Money given back since (a refund) — the receipt says so. */
  refundedIqd: number;
  status: string;
  isDemo: boolean;
  /** The original was printed (recorded once, `pos.receipt.print`): every later print is a copy. */
  printed: boolean;
  /** Copies printed after the original (pos.receipt.reprint, audited). */
  copies: number;
  /** The store's own contact details from settings (empty until the owner fills them in). */
  store: { name: string | null; phone: string | null; address: string | null };
};

// ───────────────────────────────────────────────────────────────── URL state

export type ShiftFilters = { state: ShiftState | null; register: string | null; day: string | null; mine: boolean; page: number };
export type SaleFilters = { register: string | null; shift: string | null; day: string | null; method: TillMethod | null; q: string; page: number };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const pageOf = (value: string | null) => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 1 && n <= 10_000 ? n : 1;
};
const idOf = (value: string | null) => (value && ID.test(value) ? value : null);
const dayOf = (value: string | null) => {
  if (!value || !DAY.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value ? null : value;
};

export function parseShiftFilters(params: URLSearchParams): ShiftFilters {
  const state = params.get("state");
  return {
    state: (SHIFT_STATES as readonly string[]).includes(state ?? "") ? (state as ShiftState) : null,
    register: idOf(params.get("register")),
    day: dayOf(params.get("day")),
    mine: params.get("mine") === "1",
    page: pageOf(params.get("page")),
  };
}

export function shiftSearch(filters: Partial<ShiftFilters>): string {
  const params = new URLSearchParams();
  if (filters.state) params.set("state", filters.state);
  if (filters.register) params.set("register", filters.register);
  if (filters.day) params.set("day", filters.day);
  if (filters.mine) params.set("mine", "1");
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function parseSaleFilters(params: URLSearchParams): SaleFilters {
  const method = params.get("method");
  return {
    register: idOf(params.get("register")),
    shift: idOf(params.get("shift")),
    day: dayOf(params.get("day")),
    method: (TILL_METHODS as readonly string[]).includes(method ?? "") ? (method as TillMethod) : null,
    q: (params.get("q") ?? "").trim().slice(0, 40),
    page: pageOf(params.get("page")),
  };
}

export function saleSearch(filters: Partial<SaleFilters>): string {
  const params = new URLSearchParams();
  if (filters.register) params.set("register", filters.register);
  if (filters.shift) params.set("shift", filters.shift);
  if (filters.day) params.set("day", filters.day);
  if (filters.method) params.set("method", filters.method);
  if (filters.q) params.set("q", filters.q);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** "YYYY-MM-DD" of an instant in Baghdad (UTC+3, no daylight saving). */
export function baghdadDay(at: number): string {
  return new Date(at + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/** [start, end) of a Baghdad day in epoch ms. */
export function baghdadDayRange(day: string): { from: number; to: number } {
  const from = Date.parse(`${day}T00:00:00Z`) - 3 * 60 * 60 * 1000;
  return { from, to: from + 24 * 60 * 60 * 1000 };
}
