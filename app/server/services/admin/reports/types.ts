/**
 * Admin module 18 "reports" — what the screens and the services share, client-safe (no database, no server imports):
 * the reports and their permissions, the URL state of every report (date range + the report's own choices), the
 * parameters a saved report may keep, and the view models the pages render.
 *
 *   const params = parseSalesParams(url.searchParams, now);       // { range, by, page }
 *   const search = reportSearch("sales", params);                  // "?period=2026-11&by=platform"
 *   savedParamsOf("margin", url.searchParams)                      // only the keys a saved margin report keeps
 *
 * Days and months are Asia/Baghdad (the finance module's helpers, docs/metrics.md §1). A report's range is a fiscal
 * month or two Baghdad days (≤ 400 days, finance's parseRange); demo rows are left out unless `demo=1`.
 */
import type { Permission } from "~/server/permissions";
import { latinDigits, pageOf, parseRange, queryText, rangeSearch, type RangeFilter } from "../finance/types";

export { baghdadDay, BAGHDAD_OFFSET_MS, DAY_MS, dayStart, isPeriod, periodOf, periodRange, shiftPeriod, latinDigits, type RangeFilter } from "../finance/types";

/** The query parameters people type as numbers: a month, two days, a number of days, a page, the demo switch. */
const NUMERIC_PARAMS = ["period", "from", "to", "days", "page", "demo"] as const;

/**
 * The URL's parameters with those numbers in Latin digits. An Arabic or a Kurdish keyboard types "٢٠٢٦-٠٦" /
 * "۲۰۲۶-۰۶" (a month field the browser shows as plain text, a link typed or pasted by hand); finance's parseRange
 * reads Latin digits only, so without this the report silently showed the CURRENT month — and "save this view" saved
 * that month (review 2026-11-12). Every other parameter stays as it came.
 */
export function latinParams(params: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams(params);
  for (const name of NUMERIC_PARAMS) {
    const value = params.get(name);
    if (value !== null) out.set(name, latinDigits(value).trim());
  }
  return out;
}

export const REPORTS_NS = "admin-reports";
/** Rows per page of a report's table. */
export const PAGE_SIZE = 25;
/** Days per page of the daily sales table (a month on one page). */
export const DAY_PAGE_SIZE = 31;
/**
 * The most orders one line-level report reads (sales by platform, net margin per SKU, ABC): a range with more is
 * refused with a sentence that says so — never a partial total that looks complete.
 */
export const MAX_LINE_ORDERS = 5000;
/** Rows an export carries at most (the file says when there were more). */
export const MAX_EXPORT_ROWS = 10_000;

// ───────────────────────────────────────────────────────────────── the reports

export const REPORT_KEYS = ["sales", "margin", "inventory", "customers", "performance"] as const;
export type ReportKey = (typeof REPORT_KEYS)[number];

export const isReportKey = (value: unknown): value is ReportKey => typeof value === "string" && (REPORT_KEYS as readonly string[]).includes(value);

/** The permission that opens each report (its service checks it again). */
export const REPORT_PERMISSION = {
  sales: "reports.sales.read",
  margin: "reports.margin.read",
  inventory: "reports.inventory.read",
  customers: "reports.customer.read",
  performance: "reports.performance.read",
} as const satisfies Record<ReportKey, Permission>;

/** The blueprint function each report implements. */
export const REPORT_FUNCTION: Record<ReportKey, string> = { sales: "18.01", margin: "18.02", inventory: "18.03", customers: "18.04", performance: "18.05" };

export const REPORT_PATH = (key: ReportKey) => `/admin/reports/${key}`;

// ───────────────────────────────────────────────────────────────── URL state

export const SALES_DIMENSIONS = ["day", "platform", "branch", "channel"] as const;
export type SalesDimension = (typeof SALES_DIMENSIONS)[number];

export const MARGIN_SORTS = ["profit", "margin", "revenue", "units"] as const;
export type MarginSort = (typeof MARGIN_SORTS)[number];

export const INVENTORY_VIEWS = ["abc", "turnover", "dead"] as const;
export type InventoryView = (typeof INVENTORY_VIEWS)[number];
export const ABC_BASES = ["revenue", "units"] as const;
export type AbcBasis = (typeof ABC_BASES)[number];
export const ABC_CLASSES = ["A", "B", "C"] as const;
export type AbcClass = (typeof ABC_CLASSES)[number];
/**
 * ABC by cumulative share of the period's value, largest first: the SKUs that make up the first 80 % are A, the next
 * 15 % (to 95 %) B, the rest C. A SKU whose value is zero or below is C.
 */
export const ABC_BOUNDS = { a: 0.8, b: 0.95 } as const;
/** The periods module 04's turnover and dead-stock reports offer (inventory's REPORT_PERIODS). */
export const STOCK_DAYS = [30, 60, 90, 180, 365] as const;

export const CUSTOMER_VIEWS = ["cohorts", "value"] as const;
export type CustomerView = (typeof CUSTOMER_VIEWS)[number];
/** Months after the first purchase a cohort row follows (month 0 = the month of the first purchase). */
export const COHORT_MONTHS = 12;

export const PERFORMANCE_VIEWS = ["suppliers", "employees", "shipping", "support"] as const;
export type PerformanceView = (typeof PERFORMANCE_VIEWS)[number];
/** The windows module 14's service metrics offer (support METRIC_DAYS). */
export const SUPPORT_DAYS = [7, 30, 90] as const;

const oneOf = <T extends string>(list: readonly T[], value: string | null, fallback: T): T => (value !== null && (list as readonly string[]).includes(value) ? (value as T) : fallback);
const numberOf = <T extends number>(list: readonly T[], value: string | null, fallback: T): T => {
  const n = Number(value);
  return (list as readonly number[]).includes(n) ? (n as T) : fallback;
};

export type SalesParams = { range: RangeFilter; by: SalesDimension; page: number };
export type MarginParams = { range: RangeFilter; sort: MarginSort | null; dir: "asc" | "desc"; q: string; page: number };
export type InventoryParams = { range: RangeFilter; view: InventoryView; basis: AbcBasis; abcClass: AbcClass | null; days: (typeof STOCK_DAYS)[number]; page: number };
export type CustomerParams = { range: RangeFilter; view: CustomerView };
export type PerformanceParams = { range: RangeFilter; view: PerformanceView | null; days: (typeof SUPPORT_DAYS)[number] };

export function parseSalesParams(raw: URLSearchParams, now: number): SalesParams {
  const params = latinParams(raw);
  return { range: parseRange(params, now), by: oneOf(SALES_DIMENSIONS, params.get("by"), "day"), page: pageOf(params) };
}

export function parseMarginParams(raw: URLSearchParams, now: number): MarginParams {
  const params = latinParams(raw);
  const sort = params.get("sort");
  return {
    range: parseRange(params, now),
    sort: sort !== null && (MARGIN_SORTS as readonly string[]).includes(sort) ? (sort as MarginSort) : null,
    dir: params.get("dir") === "asc" ? "asc" : "desc",
    q: queryText(params),
    page: pageOf(params),
  };
}

export function parseInventoryParams(raw: URLSearchParams, now: number): InventoryParams {
  const params = latinParams(raw);
  const abcClass = params.get("class");
  return {
    range: parseRange(params, now),
    view: oneOf(INVENTORY_VIEWS, params.get("view"), "abc"),
    basis: oneOf(ABC_BASES, params.get("basis"), "revenue"),
    abcClass: abcClass !== null && (ABC_CLASSES as readonly string[]).includes(abcClass) ? (abcClass as AbcClass) : null,
    days: numberOf(STOCK_DAYS, params.get("days"), 90),
    page: pageOf(params),
  };
}

export function parseCustomerParams(raw: URLSearchParams, now: number): CustomerParams {
  const params = latinParams(raw);
  return { range: parseRange(params, now), view: oneOf(CUSTOMER_VIEWS, params.get("view"), "cohorts") };
}

export function parsePerformanceParams(raw: URLSearchParams, now: number): PerformanceParams {
  const params = latinParams(raw);
  const view = params.get("view");
  return {
    range: parseRange(params, now),
    view: view !== null && (PERFORMANCE_VIEWS as readonly string[]).includes(view) ? (view as PerformanceView) : null,
    days: numberOf(SUPPORT_DAYS, params.get("days"), 30),
  };
}

/** The query string of a report's state (defaults left out, so a saved or shared link stays short). */
export function reportSearch(key: ReportKey, state: SalesParams | MarginParams | InventoryParams | CustomerParams | PerformanceParams, patch: Record<string, string | number | null | undefined> = {}): string {
  const extra: Record<string, string | number | null | undefined> = {};
  if (key === "sales") {
    const s = state as SalesParams;
    extra.by = s.by === "day" ? null : s.by;
    extra.page = s.page > 1 ? s.page : null;
  } else if (key === "margin") {
    const s = state as MarginParams;
    extra.sort = s.sort;
    extra.dir = s.sort && s.dir === "asc" ? "asc" : null;
    extra.q = s.q || null;
    extra.page = s.page > 1 ? s.page : null;
  } else if (key === "inventory") {
    const s = state as InventoryParams;
    extra.view = s.view === "abc" ? null : s.view;
    extra.basis = s.view === "abc" && s.basis !== "revenue" ? s.basis : null;
    extra.class = s.view === "abc" ? s.abcClass : null;
    extra.days = s.view !== "abc" && s.days !== 90 ? s.days : null;
    extra.page = s.page > 1 ? s.page : null;
  } else if (key === "customers") {
    const s = state as CustomerParams;
    extra.view = s.view === "cohorts" ? null : s.view;
  } else {
    const s = state as PerformanceParams;
    extra.view = s.view;
    extra.days = s.view === "support" && s.days !== 30 ? s.days : null;
  }
  for (const [name, value] of Object.entries(patch)) extra[name] = value;
  if (!("page" in patch) && Object.keys(patch).length > 0) extra.page = null;
  return rangeSearch(state.range, extra);
}

/** What a saved report keeps of a URL: the range, the demo switch and the report's own choices — never a page. */
export const SAVED_PARAM_KEYS: Record<ReportKey, readonly string[]> = {
  sales: ["period", "from", "to", "demo", "by"],
  margin: ["period", "from", "to", "demo", "sort", "dir", "q"],
  inventory: ["period", "from", "to", "demo", "view", "basis", "class", "days"],
  customers: ["period", "from", "to", "demo", "view"],
  performance: ["period", "from", "to", "demo", "view", "days"],
};

/**
 * The saved parameters of a URL's query, normalised through the report's own parser (so a saved report never stores
 * a value its page would not accept), as a plain record of strings.
 */
export function savedParamsOf(key: ReportKey, params: URLSearchParams, now: number): Record<string, string> {
  const search = (() => {
    switch (key) {
      case "sales":
        return reportSearch(key, { ...parseSalesParams(params, now), page: 1 });
      case "margin":
        return reportSearch(key, { ...parseMarginParams(params, now), page: 1 });
      case "inventory":
        return reportSearch(key, { ...parseInventoryParams(params, now), page: 1 });
      case "customers":
        return reportSearch(key, parseCustomerParams(params, now));
      default:
        return reportSearch(key, parsePerformanceParams(params, now));
    }
  })();
  const parsed = new URLSearchParams(search);
  const out: Record<string, string> = {};
  for (const name of SAVED_PARAM_KEYS[key]) {
    const value = parsed.get(name);
    if (value !== null && value !== "") out[name] = value;
  }
  return out;
}

/** "/admin/reports/<key>?<saved params>" — where a saved report opens. */
export function savedReportHref(key: ReportKey, params: Record<string, unknown> | null | undefined): string {
  const query = new URLSearchParams();
  for (const name of SAVED_PARAM_KEYS[key]) {
    const value = params?.[name];
    if (typeof value === "string" && value !== "") query.set(name, value);
  }
  const text = query.toString();
  return `${REPORT_PATH(key)}${text ? `?${text}` : ""}`;
}

// ───────────────────────────────────────────────────────────────── figures

/** The journal's revenue figures (docs/metrics.md §3) of one row of a breakdown, integer IQD. */
export type RevenueFigures = {
  /** Revenue (gross): net credits to sales revenue [4000]. */
  grossIqd: number;
  /** Net debits to sales discounts [4800]. */
  discountsIqd: number;
  /** Net debits to sales refunds [4900]. */
  refundsIqd: number;
  /** Net credits to shipping income [4100]. */
  shippingIqd: number;
  /** Revenue − discounts − refunds. */
  netIqd: number;
};

export const NO_REVENUE: RevenueFigures = Object.freeze({ grossIqd: 0, discountsIqd: 0, refundsIqd: 0, shippingIqd: 0, netIqd: 0 });

export function addRevenue(a: RevenueFigures, b: RevenueFigures): RevenueFigures {
  return {
    grossIqd: a.grossIqd + b.grossIqd,
    discountsIqd: a.discountsIqd + b.discountsIqd,
    refundsIqd: a.refundsIqd + b.refundsIqd,
    shippingIqd: a.shippingIqd + b.shippingIqd,
    netIqd: a.netIqd + b.netIqd,
  };
}

export function sameRevenue(a: RevenueFigures, b: RevenueFigures): boolean {
  return a.grossIqd === b.grossIqd && a.discountsIqd === b.discountsIqd && a.refundsIqd === b.refundsIqd && a.shippingIqd === b.shippingIqd && a.netIqd === b.netIqd;
}

/** A share 0–1 shown as a percentage; null when there is nothing to divide (never a 0 that hides "no data"). */
export const ratio = (part: number, whole: number): number | null => (whole !== 0 && Number.isFinite(part) && Number.isFinite(whole) ? part / whole : null);

/** Basis points of part ÷ whole, rounded; null when the whole is 0 (docs/metrics.md: "not shown when … is 0"). */
export const bpsOfShare = (part: number, whole: number): number | null => (whole === 0 ? null : Math.round((part * 10_000) / whole));

// ───────────────────────────────────────────────────────────────── view models

export type SalesRowKey = { kind: "day"; day: string } | { kind: "platform"; id: string | null } | { kind: "branch"; id: string | null; channel: "web" | "pos" | null } | { kind: "channel"; channel: "web" | "pos" };

export type SalesRow = {
  key: string;
  /** What the row is: a Baghdad day, a platform, a branch (null id + channel = online store / counter without a branch), a channel. */
  label: SalesRowKey;
  /** Names for platforms and branches (L10n picked on the server). */
  name: string | null;
  revenue: RevenueFigures;
  /** Orders whose revenue was recognised (delivered) in the range ("order:<id>:sale" postings). */
  ordersRecognised: number;
  /** Units of those orders, less the units that came back (stock movements of kind "return"). */
  units: number;
  /** Orders placed in the range (any status) — operational, from the orders table. Null where not defined (platform). */
  placed: number | null;
  /** Σ total of the orders placed in the range, cancelled ones left out (docs/metrics.md GMV). Null for platforms. */
  gmvIqd: number | null;
  /** Orders placed in the range that are now cancelled. Null for platforms. */
  cancelled: number | null;
};

export type SalesReport = {
  by: SalesDimension;
  range: { from: string; to: string; period: string | null; demo: boolean };
  /** The journal's figures for the whole range — accounting/reports.server.ts revenueRecognised (the one implementation). */
  totals: RevenueFigures & { ordersRecognised: number };
  /** Operational figures for the whole range (docs/metrics.md §3). */
  operations: {
    placed: number;
    gmvIqd: number;
    cancelled: number;
    aovIqd: number | null;
    cancellationBps: number | null;
    paidSalesIqd: number;
    /** Σ refunds paid ÷ Σ payments paid in the range (money terms); null when nothing was paid. */
    refundRateBps: number | null;
    /** Units back (movements "return") ÷ units shipped (movements "sale") in the range; null when nothing shipped. */
    returnRateBps: number | null;
    unitsSold: number;
  };
  rows: SalesRow[];
  /** Revenue postings no row could be attributed to (a manual entry on a revenue account) — shown, never dropped. */
  unattributed: RevenueFigures;
  /** Σ rows + unattributed equals the journal's totals to the dinar. False is a defect, shown as an error. */
  consistent: boolean;
  /** The range has more orders than the line-level breakdown reads (platform only). */
  tooMany: { orders: number } | null;
  page: number;
  pageCount: number;
  total: number;
};
