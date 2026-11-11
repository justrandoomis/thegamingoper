/**
 * Admin module 10 "finance" — what the screens and the services share, client-safe (no database, no server imports):
 * Baghdad days and fiscal months, amounts typed by people (Arabic-Indic and Persian digits), the URL state of the
 * lists, and the statuses' tones.
 *
 *   const range = parseRange(url.searchParams, now);           // ?period=2026-11 | ?from=2026-11-01&to=2026-11-11, demo=1
 *   const search = rangeSearch(range, { account: "acc_cash" });  // "?period=2026-11&account=acc_cash"
 *   parseAmount("١٥٠٬٠٠٠") === 150000; parseAmount("-25,000", { signed: true }) === -25000
 *
 * Time: every day and month is Asia/Baghdad (UTC+3, no daylight saving) — docs/metrics.md §1.
 */

export const FINANCE_NS = "admin-finance";
/** Rows per page of the module's lists. */
export const PAGE_SIZE = 25;
/** Lines of one manual journal entry. */
export const MAX_MANUAL_LINES = 20;

// ───────────────────────────────────────────────────────────────── Baghdad days and fiscal months

export const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
export const DAY_MS = 24 * 60 * 60 * 1000;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const PERIOD = /^(\d{4})-(\d{2})$/;

/** "YYYY-MM-DD" of an instant in Baghdad. */
export function baghdadDay(at: number): string {
  return new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);
}

/** "YYYY-MM" (the fiscal period) of an instant in Baghdad — the same rule as the journal's `period`. */
export function periodOf(at: number): string {
  return new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 7);
}

/** True for a real calendar day "YYYY-MM-DD" between 2000 and 2100 ("2026-02-30" is not one). */
export function isDay(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DAY.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return false;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}

/** True for "YYYY-MM" between 2000 and 2100. */
export function isPeriod(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = PERIOD.exec(value);
  if (!match) return false;
  const [y, m] = [Number(match[1]), Number(match[2])];
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12;
}

/** Baghdad midnight at the start of a day, in epoch ms. */
export function dayStart(day: string): number {
  const match = DAY.exec(day);
  if (!match) throw new Error(`dayStart: not a day: ${day}`);
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) - BAGHDAD_OFFSET_MS;
}

/** Noon in Baghdad of a day — the moment a dated entry (an expense, a manual entry) is booked at. */
export function dayNoon(day: string): number {
  return dayStart(day) + 12 * 60 * 60 * 1000;
}

/** [from, to) of a fiscal month, in epoch ms. */
export function periodRange(period: string): { from: number; to: number } {
  const match = PERIOD.exec(period);
  if (!match) throw new Error(`periodRange: not a period: ${period}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  return { from: Date.UTC(y, m - 1, 1) - BAGHDAD_OFFSET_MS, to: Date.UTC(y, m, 1) - BAGHDAD_OFFSET_MS };
}

export function shiftPeriod(period: string, months: number): string {
  const match = PERIOD.exec(period);
  if (!match) throw new Error(`shiftPeriod: not a period: ${period}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

/** The first and last day of a month ("2026-11" → "2026-11-01", "2026-11-30"). */
export function periodDays(period: string): { first: string; last: string } {
  const { to } = periodRange(period);
  return { first: `${period}-01`, last: baghdadDay(to - 1) };
}

// ───────────────────────────────────────────────────────────────── amounts typed by people

const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Latin digits for Arabic-Indic (an Arabic keyboard) and Persian (a Kurdish keyboard) ones. */
export function latinDigits(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const a = ARABIC_INDIC.indexOf(ch);
    const p = PERSIAN.indexOf(ch);
    out += a >= 0 ? String(a) : p >= 0 ? String(p) : ch;
  }
  return out;
}

/**
 * A whole number of dinars typed by a person: "754,000", "754 000", "٧٥٤٬٠٠٠", "۷۵۴۰۰۰" → 754000. Undefined when
 * empty, NaN when it is not a whole number (decimals included: IQD has no fractions here). With `signed`, a leading
 * minus (- − or the Arabic ‎"-") is kept; parentheses "(25,000)" read as negative too (bank statements write them so).
 */
export function parseAmount(raw: unknown, options: { signed?: boolean } = {}): number | undefined {
  if (typeof raw === "number") return Number.isSafeInteger(raw) && (options.signed || raw >= 0) ? raw : Number.NaN;
  if (typeof raw !== "string") return undefined;
  let text = latinDigits(raw)
    .replace(/[\s,٬،'’_]/g, "")
    .replace(/[‎‏؜]/g, "")
    .replace(/٫/g, ".");
  if (text === "") return undefined;
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (/^[-−]/.test(text)) {
    negative = !negative;
    text = text.slice(1);
  } else if (/[-−]$/.test(text)) {
    negative = !negative;
    text = text.slice(0, -1);
  }
  if (text.startsWith("+")) text = text.slice(1);
  if (/^\d+\.0+$/.test(text)) text = text.slice(0, text.indexOf("."));
  if (!/^\d{1,13}$/.test(text)) return Number.NaN;
  const value = Number(text);
  if (negative && !options.signed) return Number.NaN;
  return negative ? -value : value;
}

/** A percentage typed by a person ("15", "2.5", "٢٫٥") → basis points (1500, 250); NaN when it is not one. */
export function parsePercentBps(raw: unknown): number | undefined {
  if (typeof raw !== "string") return undefined;
  const text = latinDigits(raw).replace(/[\s%٪]/g, "").replace(/[٫،,]/g, ".");
  if (text === "") return undefined;
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(text)) return Number.NaN;
  const [whole, fraction = ""] = text.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
}

// ───────────────────────────────────────────────────────────────── URL state

/** A date range of a report or a list: a fiscal month or two Baghdad days (inclusive), plus the demo switch. */
export type RangeFilter = {
  /** "YYYY-MM" when the range is one whole month. */
  period: string | null;
  /** First and last day, inclusive ("YYYY-MM-DD"). */
  from: string;
  to: string;
  /** Epoch ms: [fromMs, toMs). */
  fromMs: number;
  toMs: number;
  /** Include rows marked is_demo (excluded from real figures by default — docs/metrics.md §1). */
  demo: boolean;
};

/** The longest range a list or report covers (keeps every query bounded). */
export const MAX_RANGE_DAYS = 400;

function rangeOfPeriod(period: string, demo: boolean): RangeFilter {
  const { from, to } = periodRange(period);
  const days = periodDays(period);
  return { period, from: days.first, to: days.last, fromMs: from, toMs: to, demo };
}

/**
 * ?period=YYYY-MM, or ?from=YYYY-MM-DD&to=YYYY-MM-DD (swapped when reversed, capped at MAX_RANGE_DAYS), else the
 * current month. `demo=1` includes demo rows.
 */
export function parseRange(params: URLSearchParams, now: number): RangeFilter {
  const demo = params.get("demo") === "1";
  const period = params.get("period");
  if (isPeriod(period)) return rangeOfPeriod(period, demo);
  let from = params.get("from");
  let to = params.get("to");
  if (isDay(from) || isDay(to)) {
    if (!isDay(from)) from = to as string;
    if (!isDay(to)) to = from as string;
    if ((from as string) > (to as string)) [from, to] = [to, from];
    let fromMs = dayStart(from as string);
    const toMs = dayStart(to as string) + DAY_MS;
    if (toMs - fromMs > MAX_RANGE_DAYS * DAY_MS) {
      fromMs = toMs - MAX_RANGE_DAYS * DAY_MS;
      from = baghdadDay(fromMs);
    }
    return { period: null, from: from as string, to: to as string, fromMs, toMs, demo };
  }
  return rangeOfPeriod(periodOf(now), demo);
}

/** The query string of a range (+ extra parameters; null / "" / undefined are left out). */
export function rangeSearch(range: Pick<RangeFilter, "period" | "from" | "to" | "demo">, extra: Record<string, string | number | null | undefined> = {}): string {
  const params = new URLSearchParams();
  if (range.period) params.set("period", range.period);
  else {
    params.set("from", range.from);
    params.set("to", range.to);
  }
  if (range.demo) params.set("demo", "1");
  for (const [key, value] of Object.entries(extra)) if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
  const out = params.toString();
  return out ? `?${out}` : "";
}

export function pageOf(params: URLSearchParams): number {
  const raw = Number(params.get("page") ?? "1");
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 10_000 ? raw : 1;
}

/** Free text from the URL, trimmed and bounded (D1 refuses long LIKE patterns). */
export function queryText(params: URLSearchParams, name = "q", max = 40): string {
  return (params.get(name) ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max);
}

/** An id-like value from the URL, or null. */
export function idParam(params: URLSearchParams, name: string): string | null {
  const value = params.get(name);
  return value && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value) ? value : null;
}

// ───────────────────────────────────────────────────────────────── shared vocabularies

export const ACCOUNT_TYPE_LIST = ["asset", "liability", "equity", "revenue", "expense"] as const;
export type AccountTypeKey = (typeof ACCOUNT_TYPE_LIST)[number];

/** Journal reference types this module names (anything else shows as "other"). */
export const REF_TYPES = ["order", "payment", "refund", "wallet_ledger", "expense", "manual", "receipt", "return", "cod_settlement", "pos_shift"] as const;

export const STATEMENT_SOURCES = ["bank_card", "zaincash", "carrier"] as const;
export type StatementSource = (typeof STATEMENT_SOURCES)[number];
export const STATEMENT_STATUSES = ["unmatched", "matched", "ignored"] as const;

export const EXPENSE_STATUS_LIST = ["draft", "posted", "void"] as const;

export const TOPUP_STATUS_LIST = ["pending_verification", "approved", "rejected", "cancelled"] as const;

/** Copies of schema enums for client code (the schema module is server-side); tests/admin-finance.test.ts compares them. */
export const PRODUCT_KIND_LIST = ["console", "game", "controller", "headset", "storage", "accessory", "digital", "part", "bundle"] as const;
export const CHANNEL_LIST = ["web", "pos"] as const;
export const WALLET_KIND_LIST = ["topup", "purchase", "refund", "trade_in_credit", "gift_card", "adjustment"] as const;

export type StatusTone = "ok" | "warn" | "info" | "bad" | "neutral";

export const TONES = {
  statement: { unmatched: "warn", matched: "ok", ignored: "neutral" },
  expense: { draft: "warn", approved: "info", posted: "ok", void: "neutral" },
  topup: { pending_verification: "warn", approved: "ok", rejected: "bad", cancelled: "neutral" },
  approval: { pending: "warn", approved: "ok", rejected: "neutral" },
  period: { open: "info", closed: "ok" },
  severity: { critical: "bad", warning: "warn", info: "info" },
  finding: { open: "warn", acknowledged: "info", resolved: "ok", false_positive: "neutral" },
} as const satisfies Record<string, Record<string, StatusTone>>;
