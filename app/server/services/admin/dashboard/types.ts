/**
 * Admin module 01 "dashboard" — the command centre's client-safe vocabulary: the period and the span before it (Iraq
 * time), the URL state of the page, the comparison of two figures, the activity feed's kinds and the global search's
 * groups, and the view models the loaders stream to the page. Pure: no database, no server imports.
 *
 *   const filters = parseDashboardFilters(url.searchParams);       // ?period=week&view=finance&demo=1&branch=…
 *   const spans = periodSpans(filters.period, ctx.now);              // { current: [start, now], previous: same span before }
 *   compare(current, previous)                                       // { delta, ratioBps } | null (never a made-up 0)
 */
import { BAGHDAD_OFFSET_MS } from "~/lib/dates";

export const DAY_MS = 24 * 60 * 60 * 1000;

// ───────────────────────────────────────────────────────────────── periods (01.04)

/** Today, this week (Saturday first, as Iraq counts it) and this month — each up to now. */
export const DASHBOARD_PERIODS = ["today", "week", "month"] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];

/** [from, to) in epoch ms. */
export type Span = { from: number; to: number };

/**
 * The period so far and the same span of the period before it: today until now against yesterday until the same
 * time; this week from Saturday against last week until the same moment; this month against the same days of last
 * month (cut at last month's end — 31 March is compared with all of February).
 */
export type PeriodSpans = { period: DashboardPeriod; current: Span; previous: Span };

/** Start of the Baghdad day of an instant. */
export function dayStartOf(at: number): number {
  return Math.floor((at + BAGHDAD_OFFSET_MS) / DAY_MS) * DAY_MS - BAGHDAD_OFFSET_MS;
}

/** Start of the Baghdad week (Saturday 00:00) of an instant. */
export function weekStartOf(at: number): number {
  const day = dayStartOf(at);
  const weekday = new Date(day + BAGHDAD_OFFSET_MS).getUTCDay(); // 0 = Sunday … 6 = Saturday
  return day - ((weekday + 1) % 7) * DAY_MS;
}

/** Start of the Baghdad month of an instant. */
export function monthStartOf(at: number): number {
  const wall = new Date(at + BAGHDAD_OFFSET_MS);
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth(), 1) - BAGHDAD_OFFSET_MS;
}

function previousMonthStart(monthStart: number): number {
  const wall = new Date(monthStart + BAGHDAD_OFFSET_MS);
  return Date.UTC(wall.getUTCFullYear(), wall.getUTCMonth() - 1, 1) - BAGHDAD_OFFSET_MS;
}

/** The current span (up to and including `now`) and the equivalent span before it. */
export function periodSpans(period: DashboardPeriod, now: number): PeriodSpans {
  const to = now + 1;
  let from: number;
  let previousFrom: number;
  switch (period) {
    case "today":
      from = dayStartOf(now);
      previousFrom = from - DAY_MS;
      break;
    case "week":
      from = weekStartOf(now);
      previousFrom = from - 7 * DAY_MS;
      break;
    case "month":
      from = monthStartOf(now);
      previousFrom = previousMonthStart(from);
      break;
  }
  const elapsed = to - from;
  return { period, current: { from, to }, previous: { from: previousFrom, to: Math.min(previousFrom + elapsed, from) } };
}

// ───────────────────────────────────────────────────────────────── comparison

/** A figure now and in the span before; null where it cannot be computed (never a 0 in its place). */
export type Figure = { current: number | null; previous: number | null };

export type Comparison = { delta: number; ratioBps: number | null };

/** The change from `previous` to `current`: null when either is unknown; no ratio when the earlier figure is 0. */
export function compare(current: number | null, previous: number | null): Comparison | null {
  if (current === null || previous === null || !Number.isFinite(current) || !Number.isFinite(previous)) return null;
  const delta = current - previous;
  return { delta, ratioBps: previous === 0 ? null : Math.round((delta * 10_000) / Math.abs(previous)) };
}

// ───────────────────────────────────────────────────────────────── URL state of /admin

/** The role views of the command centre (01.05): everything the employee may see, or one role's cards. */
export const DASHBOARD_VIEWS = ["overview", "finance", "warehouse", "support"] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

export type DashboardFilters = {
  period: DashboardPeriod;
  view: DashboardView;
  /** Include demo rows (metrics §1 leaves them out of every real figure). */
  demo: boolean;
  /** A branch's figures only (POS sales of that branch); null = the whole store. */
  branch: string | null;
};

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const oneOf = <T extends string>(list: readonly T[], value: string | null): T | null => (value !== null && (list as readonly string[]).includes(value) ? (value as T) : null);

export function parseDashboardFilters(params: URLSearchParams): DashboardFilters {
  const branch = params.get("branch");
  return {
    period: oneOf(DASHBOARD_PERIODS, params.get("period")) ?? "today",
    view: oneOf(DASHBOARD_VIEWS, params.get("view")) ?? "overview",
    demo: params.get("demo") === "1",
    branch: branch && ID.test(branch) ? branch : null,
  };
}

/** "?period=week&…" with the defaults left out ("" when everything is a default) — links and the form agree. */
export function dashboardSearch(filters: Partial<DashboardFilters>): string {
  const params = new URLSearchParams();
  if (filters.period && filters.period !== "today") params.set("period", filters.period);
  if (filters.view && filters.view !== "overview") params.set("view", filters.view);
  if (filters.demo) params.set("demo", "1");
  if (filters.branch) params.set("branch", filters.branch);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** Which role views an employee has: a view appears only for holders of the permissions its cards need. */
export type ViewAccess = Record<DashboardView, boolean>;

// ───────────────────────────────────────────────────────────────── KPI cards (01.01)

export type SalesCard = {
  spans: PeriodSpans;
  /** Money that arrived for orders minus refunds paid (metrics §3 "Paid sales"), IQD. */
  paidSales: Figure;
  /** Orders placed in the span, any status (metrics §3). */
  ordersPlaced: Figure;
  /** Open orders now, and at the same moment of the span before (each order's own status history). */
  openOrders: Figure;
  /** (subtotal − discount) ÷ orders placed and not cancelled (metrics §3 "AOV"); null when there is none. */
  averageBasket: Figure;
  demo: boolean;
  branch: string | null;
};

/** One span of the finance module's profit and loss (accounting/reports.server.ts profitAndLoss). */
export type NetResult = { netIqd: number; netMarginBps: number | null; netRevenueIqd: number; uncostedUnits: number; ordersRecognised: number };

export type ResultCard = {
  spans: PeriodSpans;
  /** Null for a branch: the journal is kept for the whole store. */
  current: NetResult | null;
  previous: NetResult | null;
  perBranch: boolean;
  demo: boolean;
};

// ───────────────────────────────────────────────────────────────── urgent action centre (01.02)

export const ALERT_IDS = ["late_orders", "unmatched_payments", "low_stock", "critical_tickets"] as const;
export type AlertId = (typeof ALERT_IDS)[number];

/**
 * One row under a tile, as the module's own list shows it to this employee: `label` a reference or SKU, `text` a name
 * or subject (never translated), `code` a word the page translates (an order's late rule, a statement's source, a
 * ticket's priority), an amount or a quantity, a time, and the record's page.
 */
export type AlertRow = { key: string; label: string; text: string | null; code: string | null; amountIqd: number | null; qty: number | null; at: number | null; href: string | null; isDemo: boolean };

/** What one tile shows: the count of the list it opens (that module's own list, for this employee), its first rows. */
export type AlertTile = {
  id: AlertId;
  count: number;
  href: string;
  rows: AlertRow[];
  /** A second figure of the same module (tickets: past their due time), with its own list. */
  extra: { count: number; href: string } | null;
};

/** A streamed card: its data, or the honest failure (shown as "not available", never as 0). */
export type Streamed<T> = { ok: true; data: T } | { ok: false };

// ───────────────────────────────────────────────────────────────── conversion funnel (01.03)

export type FunnelCounts = { carts: number | null; orders: number; paid: number; delivered: number };

export type FunnelCard = {
  spans: PeriodSpans;
  /** Web: carts started in the span and what became of them (null for a branch — web orders belong to none). */
  web: { current: FunnelCounts; previous: FunnelCounts } | null;
  /** The counter (POS): sales rung up in the span — they have no cart. */
  counter: { current: FunnelCounts; previous: FunnelCounts };
  demo: boolean;
  branch: string | null;
};

// ───────────────────────────────────────────────────────────────── role cards (01.05)

export type MoneyCard = {
  /** Cash-on-delivery payments still pending on shipped or delivered orders (metrics §5). */
  codOutstanding: { count: number; iqd: number };
  /** Transfers waiting for a person to verify the proof (metrics §5): count and Σ declared. */
  transfersAwaiting: { count: number; iqd: number };
  /** Refunds asked for and not decided yet. */
  refundsPending: { count: number; iqd: number };
  /** finance.wallet.read: what the store owes in wallets (Σ wallet ledger). */
  walletLiability: number | null;
  /** Where each figure's list is — only the pages this employee may open (null otherwise). */
  links: { cod: string | null; transfers: string | null; refunds: string | null; wallet: string | null };
  demo: boolean;
};

/** The figures of the stock card, in the order it shows them. */
export const STOCK_FIGURES = ["skus", "available", "incoming", "low", "out", "oversold", "belowReorder", "counts", "transfers", "expiring", "toPack"] as const;
export type StockFigure = (typeof STOCK_FIGURES)[number];

export type StockCard = {
  skusInStock: number;
  available: number;
  incoming: number;
  low: number;
  out: number;
  oversold: number;
  belowReorder: number;
  countsToApprove: number | null;
  transfersInTransit: number | null;
  reservationsExpiring: number;
  /** orders.fulfillment.pack: orders confirmed or being prepared (the orders list's "to pack" view). */
  toPack: number | null;
  /**
   * The list each figure opens — only where that list counts exactly what the figure counts (the inventory overview
   * counts active SKUs of products that are not archived; the stock list counts every SKU, so its states are no
   * figure's list). null: shown without a link, like the inventory home shows it.
   */
  links: Record<StockFigure, string | null>;
};

export type InboxCard = {
  needsReply: number;
  unassigned: number | null;
  late: number;
  escalatedToMe: number;
  handoffs: number;
  repairs: number;
};

// ───────────────────────────────────────────────────────────────── activity feed (01.07)

export const FEED_KINDS = ["price", "return", "approval"] as const;
export type FeedKind = (typeof FEED_KINDS)[number];

export type FeedLine = {
  id: string;
  seq: number;
  at: number;
  kind: FeedKind;
  /** The audit action ("pricing.price.change") — its sentence is `feed.actions.<action>`. */
  action: string;
  actor: { label: string | null; system: boolean };
  /** The record it is about, as this employee may see it: its kind (feed.ts FeedEntity), a reference, a link only where they may open it. */
  record: { entity: string; label: string | null; href: string | null };
  reason: string | null;
  /** Price changes: the selling price before and after (never a cost). */
  price: { fromIqd: number | null; toIqd: number | null } | null;
};

export type FeedPage = { lines: FeedLine[]; next: number | null; kinds: FeedKind[]; kind: FeedKind | null };

export type FeedFilters = { kind: FeedKind | null; before: number | null };

export function parseFeedFilters(params: URLSearchParams): FeedFilters {
  const before = Number(params.get("before") ?? "");
  return { kind: oneOf(FEED_KINDS, params.get("kind")), before: Number.isSafeInteger(before) && before > 0 ? before : null };
}

export function feedSearch(filters: Partial<FeedFilters>): string {
  const params = new URLSearchParams();
  if (filters.kind) params.set("kind", filters.kind);
  if (filters.before) params.set("before", String(filters.before));
  const text = params.toString();
  return text ? `?${text}` : "";
}

// ───────────────────────────────────────────────────────────────── global search (01.06)

export const SEARCH_GROUPS = ["orders", "customers", "skus", "serials", "tickets"] as const;
export type SearchGroup = (typeof SEARCH_GROUPS)[number];

export const SEARCH_MIN_LENGTH = 2;
export const SEARCH_MAX_LENGTH = 60;
/** Rows per group: the page shows this many, the palette fewer. */
export const SEARCH_LIMIT = 6;

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/**
 * What was typed, as the search reads it: compatibility forms folded (NFKC: the Arabic presentation forms of text pasted
 * from a PDF — "ﺳﻤﺎﻋﺔ" — become the letters the catalogue is written in, "ﻻ" becomes "لا", full-width Latin becomes
 * Latin), Arabic-Indic and Persian digits as 0–9, controls and direction marks dropped, trimmed, bounded.
 */
export function cleanQuery(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let text = "";
  for (const ch of raw.normalize("NFKC")) {
    const a = ARABIC_INDIC.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    text += a >= 0 ? String(a) : p >= 0 ? String(p) : ch;
  }
  return text
    .replace(/[\u0000-\u001f\u007f‎‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, SEARCH_MAX_LENGTH);
}

export type QuickAction = { key: "open" | "pack" | "edit" | "customer" | "profile" | "wallet" | "product" | "stock" | "pricing" | "serial" | "registry" | "repair"; href: string };

export type PhoneText = { display: string; full: boolean };

export type OrderHit = { ref: string; status: string; paymentStatus: string; totalIqd: number; placedAt: number; contactName: string | null; phone: PhoneText | null; channel: string; isDemo: boolean; actions: QuickAction[] };
export type CustomerHit = { id: string; name: string | null; phone: PhoneText | null; status: string; isDemo: boolean; actions: QuickAction[] };
export type SkuHit = { variantId: string; sku: string; name: string; title: string | null; productStatus: string; isActive: boolean; priceIqd: number; available: number | null; actions: QuickAction[] };
export type SerialHit = { id: string; serial: string; status: string; sku: string; name: string; actions: QuickAction[] };
export type TicketHit = { kind: "ticket" | "repair"; ref: string; title: string; status: string; priority: string | null; isDemo: boolean; actions: QuickAction[] };

export type SearchResults = {
  q: string;
  /** Rows asked for per group: a group with this many may have more (its own list has them all). */
  limit: number;
  /** Something was typed but too little to search. */
  tooShort: boolean;
  /** null: the group is not for this employee (no permission); []: searched, nothing found. */
  groups: { orders: OrderHit[] | null; customers: CustomerHit[] | null; skus: SkuHit[] | null; serials: SerialHit[] | null; tickets: TicketHit[] | null };
  /** Each group's own list with the same text, where this employee may open it (null otherwise or with nothing typed). */
  links: Record<SearchGroup, string | null>;
  /** Groups whose module could not answer this time: shown as "could not be searched", never as "nothing found". */
  failed: SearchGroup[];
};
