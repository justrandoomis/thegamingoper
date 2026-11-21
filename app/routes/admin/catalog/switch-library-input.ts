/**
 * Switch game library (admin) — the rules for what staff type, pure and client-safe: the edit page previews with
 * them while staff type, and the service (app/server/services/admin/switch-library.server.ts) validates with the very
 * same functions. Contract: docs/switch-builder.md §3 (units) and §7 (admin).
 *
 *   parseSizeInput("16.5")      → 17,716,740,096 bytes   (GB as the console shows them: binary, 1 GB = 1024³ bytes)
 *   parseSizeInput("450 MB")    → 471,859,200 bytes      (small games: the console shows MB)
 *   formatSizeInput(bytes)      → "16.5" / "450 MB"      (what the form and the CSV show; parses back to the same)
 *   parseUsdInput("59.99")      → 5999 cents             (the Nintendo eShop US price staff checked)
 *   parseYouTubeId("https://youtu.be/dQw4w9WgXcQ?si=x") → "dQw4w9WgXcQ"
 *   parseAsOfDate("21/11/2026", today) → "2026-11-21"    (Excel rewrites dates; an ambiguous day/month is refused)
 *
 * Arabic-Indic digits and the Arabic decimal separator are read as typed on an Arabic keyboard («١٦٫٥»). Nothing here
 * reads or links to Nintendo's or Metacritic's sites: sizes are measured on TamTam's consoles, prices are checked by
 * staff, and a Metacritic score is entered only while TamTam holds the Metacritic licence (contract §1).
 */
import { GIB, bytesFromGiB, toGiB } from "~/lib/switch-builder/storage";

// ───────────────────────────────────────────────────────────────── ids

/** A library game id: the Nintendo US store slug of a Switch 1 game (Wikidata P8084), e.g. "hades-switch". */
export const LIBRARY_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-switch$/;
export const LIBRARY_ID_MAX = 160;

export function isLibraryGameId(value: unknown): value is string {
  return typeof value === "string" && value.length <= LIBRARY_ID_MAX && LIBRARY_ID_PATTERN.test(value);
}

/** A pasted id, made comparable: trimmed and lower-cased ("Hades-Switch " → "hades-switch"). */
export const normalizeGameId = (value: string): string => value.trim().toLowerCase();

// ───────────────────────────────────────────────────────────────── limits

/** No as-of date before the Switch went on sale. */
export const MIN_AS_OF = "2017-03-03";
/** Larger than any Switch 1 game: a typo such as "1650" for "16.50" is refused. */
export const MAX_SIZE_GIB = 200;
/** $1,000: eShop games cost far less; a typo is refused. */
export const MAX_PRICE_CENTS = 100_000;
export const MAX_DESCRIPTION = 1200;
/** Metacritic shows no Metascore for fewer than four critic reviews ("tbd"). */
export const MIN_METACRITIC_REVIEWS = 4;
export const MAX_METACRITIC_REVIEWS = 5000;

const MIB = 1024 ** 2;

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };
const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = <T>(error: string): Parsed<T> => ({ ok: false, error });

// ───────────────────────────────────────────────────────────────── numbers

const ARABIC_INDIC_ZERO = 0x0660;
const PERSIAN_ZERO = 0x06f0;
const ARABIC_DECIMAL_SEPARATOR = 0x066b;
const ARABIC_THOUSANDS_SEPARATOR = 0x066c;
/** No-break, thin and narrow no-break spaces (spreadsheets put them between thousands). */
const SPACES = new Set([0x00a0, 0x2009, 0x202f]);

/** Arabic-Indic (٠–٩) and Persian (۰–۹) digits as Latin digits; everything else as it is. */
export function mapDigits(raw: string): string {
  let text = "";
  for (const char of raw) {
    const code = char.charCodeAt(0);
    if (code >= ARABIC_INDIC_ZERO && code <= ARABIC_INDIC_ZERO + 9) text += String(code - ARABIC_INDIC_ZERO);
    else if (code >= PERSIAN_ZERO && code <= PERSIAN_ZERO + 9) text += String(code - PERSIAN_ZERO);
    else text += char;
  }
  return text;
}

/** Latin digits, «٫» as ".", no «٬», no spaces of any kind. */
function compactNumber(raw: string): string {
  let text = "";
  for (const char of mapDigits(raw.trim())) {
    const code = char.charCodeAt(0);
    if (code === ARABIC_DECIMAL_SEPARATOR) text += ".";
    else if (code === ARABIC_THOUSANDS_SEPARATOR || SPACES.has(code)) continue;
    else text += char;
  }
  return text.replace(/\s+/g, "");
}

/** A comma as the decimal point ("16,5", one comma, one or two digits after it, no point), else thousands ("1,299.99"). */
function decimalComma(text: string): string {
  if (!text.includes(",")) return text;
  const commas = text.split(",").length - 1;
  return !text.includes(".") && commas === 1 && /,\d{1,2}$/.test(text) ? text.replace(",", ".") : text.replaceAll(",", "");
}

/** What a number typed in any of the admin's languages reads as: "١٬٢٩٩٫٥" → "1299.5", "16,5" → "16.5". */
export function latinNumber(raw: string): string {
  return decimalComma(compactNumber(raw));
}

/** A plain decimal "16.52" → 16, 52 and its 2 digits; null when it is not one. */
function decimalParts(text: string, maxDecimals: number): { whole: number; fraction: number; digits: number } | null {
  const match = new RegExp(`^(\\d{1,6})(?:\\.(\\d{1,${maxDecimals}}))?$`).exec(text);
  if (!match) return null;
  return { whole: Number(match[1]), fraction: match[2] ? Number(match[2]) : 0, digits: match[2]?.length ?? 0 };
}

/** A whole number such as a Metacritic score or review count. */
export function parseWholeNumber(raw: string, min: number, max: number, errorKey: string): Parsed<number> {
  const text = latinNumber(raw);
  if (!/^\d{1,7}$/.test(text)) return fail(errorKey);
  const value = Number(text);
  return value < min || value > max ? fail(errorKey) : ok(value);
}

// ───────────────────────────────────────────────────────────────── sizes (bytes)

const GB_UNITS = new Set(["gb", "gib", "g", "جيجا", "جيجابايت", "غيغا", "غيغابايت", "گێگا", "گێگابایت", "گیگابایت"]);
const MB_UNITS = new Set(["mb", "mib", "m", "ميجا", "ميجابايت", "ميغا", "ميغابايت", "مێگا", "مێگابایت", "میگابایت"]);

/**
 * A size typed as the console shows it: GB with at most two decimals ("16.5", "16.52", "١٦٫٥ GB"), or MB for small
 * games ("450 MB"). `allowZero`: a cartridge whose copy needs no space on the console.
 */
export function parseSizeInput(raw: string, options: { allowZero?: boolean } = {}): Parsed<number> {
  const text = compactNumber(raw).toLowerCase();
  const match = /^([0-9.,]+)(.*)$/.exec(text);
  if (!match) return fail("size_format");
  const word = match[2];
  const unit = word === "" || GB_UNITS.has(word) ? "gb" : MB_UNITS.has(word) ? "mb" : null;
  if (!unit) return fail("size_format");
  const parts = decimalParts(decimalComma(match[1]), 2);
  if (!parts) return fail("size_format");
  const value = parts.whole + parts.fraction / 10 ** parts.digits;
  const bytes = unit === "gb" ? bytesFromGiB(value) : Math.round(value * MIB);
  if (bytes === 0) return options.allowZero ? ok(0) : fail("size_zero");
  if (bytes > MAX_SIZE_GIB * GIB) return fail("size_too_big");
  return ok(bytes);
}

/** The size as staff type it back: MB under 1 GB ("450 MB"), else GB with up to two decimals ("16.5"). */
export function formatSizeInput(bytes: number): string {
  if (bytes === 0) return "0";
  if (bytes < GIB) return `${Math.round((bytes / MIB) * 100) / 100} MB`;
  return String(toGiB(bytes, 2));
}

/** Two sizes that staff would type the same way are the same (an untouched value is never rewritten). */
export function sameSize(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b;
  return a === b || formatSizeInput(a) === formatSizeInput(b);
}

/** "16.5 GB" / "450 MB" for reading (lists, previews). */
export function sizeLabel(bytes: number): string {
  const text = formatSizeInput(bytes);
  return text.endsWith("MB") ? text : `${text} GB`;
}

// ───────────────────────────────────────────────────────────────── eShop price (US cents)

/** A price in US dollars with at most two decimals ("59.99", "$59.99", "0" for a free game) → cents. */
export function parseUsdInput(raw: string): Parsed<number> {
  const text = latinNumber(raw.toLowerCase().replace(/us\$|usd|\$|دولار|دۆلار/g, ""));
  const parts = decimalParts(text, 2);
  if (!parts) return fail("price_format");
  const cents = parts.whole * 100 + (parts.digits === 1 ? parts.fraction * 10 : parts.fraction);
  if (cents > MAX_PRICE_CENTS) return fail("price_too_big");
  return ok(cents);
}

/** Cents as staff type them: "59.99", "60", "0". */
export function formatUsdInput(cents: number): string {
  const whole = Math.floor(cents / 100);
  const rest = cents % 100;
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0")}`;
}

/** "$59.99" for reading. */
export const usdLabel = (cents: number): string => `$${formatUsdInput(cents)}`;

// ───────────────────────────────────────────────────────────────── trailer (YouTube id)

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set(["youtube.com", "youtube-nocookie.com", "youtu.be"]);

/**
 * The 11-character video id from what staff paste: the id itself, or a YouTube link (watch?v=, youtu.be/, /embed/,
 * /shorts/, /live/, youtube-nocookie.com). Any other site, or a link without a video id, is null.
 */
export function parseYouTubeId(raw: string): string | null {
  const text = raw.trim();
  if (YOUTUBE_ID.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, "");
  if (!YOUTUBE_HOSTS.has(host)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let candidate: string | null = null;
  if (host === "youtu.be") candidate = parts[0] ?? null;
  else if (parts.length === 0 || parts[0] === "watch") candidate = url.searchParams.get("v");
  else if (["embed", "shorts", "live", "v", "e"].includes(parts[0])) candidate = parts[1] ?? null;
  return candidate && YOUTUBE_ID.test(candidate) ? candidate : null;
}

/** The trailer's page on YouTube (a plain link for staff to check the video). */
export const youTubeWatchUrl = (id: string): string => `https://www.youtube.com/watch?v=${encodeURIComponent(id)}`;

// ───────────────────────────────────────────────────────────────── as-of dates (YYYY-MM-DD)

/** Today in Baghdad (UTC+3, no daylight saving) as YYYY-MM-DD. */
export function baghdadDay(now: number): string {
  return new Date(now + 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

const pad2 = (value: number) => String(value).padStart(2, "0");

function realDate(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * The day a figure was checked: 2026-11-21 (also 2026/11/21), or a spreadsheet's 21/11/2026 or 11/21/2026 when one
 * part is above 12 — 05/06/2026 could be either and is refused, unless one of its two readings is `known` (the day
 * already saved: Excel rewrites an exported 2026-11-05 as 05/11/2026 or 11/5/2026, and an untouched date must not
 * fail its row). A time after the date is ignored. Never before the Switch went on sale, never after today.
 */
export function parseAsOfDate(raw: string, today: string, known?: string | null): Parsed<string> {
  const text = mapDigits(raw.trim())
    .replace(/[ T]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s*(?:am|pm))?(?:Z|[+-]\d{2}:?\d{2})?$/i, "")
    .trim();
  let iso: string | null = null;
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(text);
  if (match) iso = realDate(Number(match[1]), Number(match[2]), Number(match[3]));
  else {
    match = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(text);
    if (!match) return fail("date_invalid");
    const [a, b, year] = [Number(match[1]), Number(match[2]), Number(match[3])];
    if (a > 12) iso = realDate(year, b, a);
    else if (b > 12) iso = realDate(year, a, b);
    else if (a === b) iso = realDate(year, a, a);
    else if (known && (known === realDate(year, b, a) || known === realDate(year, a, b))) iso = known;
    else return fail("date_ambiguous");
  }
  if (!iso) return fail("date_invalid");
  if (iso < MIN_AS_OF) return fail("date_too_early");
  if (iso > today) return fail("date_future");
  return ok(iso);
}

/** An ISO day as epoch ms (noon in Baghdad), for the date formatters. */
export const isoDayToEpoch = (iso: string): number => Date.parse(`${iso}T09:00:00Z`);

// ───────────────────────────────────────────────────────────────── yes / no

const YES = new Set(["yes", "y", "true", "1", "hidden", "نعم", "مخفي", "بەڵێ", "شاراوە"]);
const NO = new Set(["no", "n", "false", "0", "shown", "visible", "لا", "ظاهر", "نەخێر", "دیار"]);

/** A spreadsheet's yes / no (also TRUE / FALSE, 1 / 0, نعم / لا, بەڵێ / نەخێر); null when it is neither. */
export function parseYesNo(raw: string): boolean | null {
  const text = mapDigits(raw).trim().toLowerCase();
  if (YES.has(text)) return true;
  if (NO.has(text)) return false;
  return null;
}

// ───────────────────────────────────────────────────────────────── the CSV file

/**
 * The import's columns, in the export's order. One row per game, found by `game_id`. An empty cell leaves the
 * field as it is, "-" clears it; a column that is not in the file leaves its field alone. A value that changes
 * without its as-of date gets today's date.
 */
export const LIBRARY_CSV_COLUMNS = [
  "game_id",
  "size_gb",
  "cartridge_gb",
  "size_as_of",
  "price_usd",
  "price_as_of",
  "trailer",
  "description_ar",
  "description_en",
  "description_ckb",
  "metacritic_score",
  "metacritic_reviews",
  "metacritic_as_of",
  "hidden",
] as const;
export type LibraryCsvColumn = (typeof LIBRARY_CSV_COLUMNS)[number];

/** Columns an export or a sheet carries for reading only; an import ignores them. */
export const LIBRARY_CSV_READ_ONLY = ["title", "year", "picture", "updated_at"] as const;

export const LIBRARY_CSV_CLEAR = "-";
/** The whole open list (about 4,900 games) fits in one file… */
export const LIBRARY_CSV_MAX_ROWS = 5000;
export const LIBRARY_CSV_MAX_BYTES = 2 * 1024 * 1024;
/** …but one import writes at most this many games (D1: every written game is two statements in one request). */
export const LIBRARY_CSV_MAX_CHANGES = 400;

// ───────────────────────────────────────────────────────────────── the open list (client)

/**
 * The URL of the open list file named by app/routes/storefront/builder/library.manifest.ts (LIBRARY_LIST_FILE): a
 * file name under /library/switch/, or already a path. Null while the list has not been built.
 */
export function libraryListUrl(file: string | null | undefined): string | null {
  if (!file) return null;
  if (/^(?:https?:)?\//.test(file)) return file;
  return `/library/switch/${file.replace(/^\.?\/+/, "")}`;
}

/**
 * Search folding for the admin list: lower case, no Latin accents ("Pokémon" → "pokemon"), Arabic and Sorani
 * without diacritics or tatweel and with one form of alef, yeh, kaf and heh, punctuation as spaces.
 */
export function foldSearch(text: string): string {
  return mapDigits(text)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[ً-ٰٟـ]/g, "")
    .replace(/[أإآٱ]/g, "ا")
    .replace(/[ىی]/g, "ي")
    .replace(/ک/g, "ك")
    .replace(/[ةە]/g, "ه")
    .replace(/ؤ/g, "و")
    .replace(/ئ/g, "ي")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}
