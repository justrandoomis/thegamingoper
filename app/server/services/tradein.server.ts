/**
 * Trade-in — the shopper's side of selling a device to the store (brief §5, DESIGN.md §9.21, CONTRACTS.md §3 "used").
 *
 *   const devices = await listTradeInDevices(db, ctx.locale);                          // models with an active price guide
 *   const result = await estimateTradeIn(db, ctx.locale, "ps5-slim", answers, ctx.now); // { device, estimate } | null
 *   const made = await createTradeIn(db, who, raw, ctx.now);                            // → /trade-in/<ref>?t=<accessToken>
 *   const view = await getTradeInByRef(db, ref, { accessToken, customerId }, ctx.locale, ctx.now);
 *   const view = await lookupTradeIn(db, { ref, phone }, { ip }, ctx.locale, ctx.now); // reference AND phone, rate-limited
 *   await respondToOffer(db, { ref, accessToken }, { decision: "accept", payout: "cash" }, ctx.now);
 *
 * THE JOURNEY — what is built here, and what is staff work (admin module 13, not built yet)
 *   shopper  device → condition questionnaire → photos (private) → indicative estimate RANGE → contact and a preferred
 *            inspection time → a reference and a tracking page with the history.
 *   staff    confirm the inspection time → inspect (checklist, grade, ownership and account-lock checks) → final offer
 *            (only an employee: the database refuses an offer without offered_by, offered_at and a recorded inspection —
 *            drizzle/0001_invariants.sql §7) → payout (store credit or cash) → data wipe → used listing.
 *   shopper  accepts or declines a final offer while it is open (respondToOffer) — the one decision after submitting.
 *
 * THE ESTIMATE IS NOT AN OFFER. It is a range from the model's price guide (trade_in_price_guides: `base_iqd` prices a
 * grade-A+ unit, `grade_multipliers` are basis points per grade, `deductions` IQD per missing item). The shopper's
 * description maps to a span of two grades (a self-assessment is uncertain by about one grade: "light marks" → B…A),
 * the guide prices both ends, missing items are deducted, and both ends are rounded DOWN to 5,000 IQD. It is valid for
 * settings "tradein.estimate_valid_days". A device that does not work fully, or whose body or screen is broken, gets no
 * online figure ("inspection": priced after the inspection); a device locked to an account the shopper cannot remove
 * is refused (the store cannot buy it). Integer IQD throughout. Nothing from the client is trusted: the estimate is
 * computed again when the request is created.
 *
 * IDEMPOTENCY (trade_ins has no idempotency column): the request id is derived from the client's key (`tin_` + 26
 * base32 characters of sha256), so a retry or a double submission with the same key meets the primary key and gets the
 * first request back (`replayed: true`) — only with the same phone number, otherwise `idempotency_conflict`. The guest
 * tracking token is base64url(sha256("tamtam.tradein.access.v1|" + id + "|" + key)); only its sha256 is stored (as for
 * orders), so a database reader cannot rebuild the link.
 *
 * PHOTOS are private files (kind "trade_in_photo") uploaded before the request exists, tied to a draft token in the
 * httpOnly cookie `tt_tradein` (files.owner_type "trade_in_draft", owner_id = sha256 of the token). Creating the request
 * moves them to owner_type "trade_in" in the same batch. At most TRADE_IN_PHOTO_LIMIT per draft. They are never public:
 * the draft's owner sees thumbnails while drafting; after submission only staff (admin) can.
 *
 * PRIVACY: the phone number is shown masked only; serial numbers, the guide's base price and inspection notes are never
 * returned; a reference alone opens nothing (it needs the token, the owner's session, or the phone number).
 *
 * Errors (AppError; texts in the "used" namespace under errors.<code>, the generic ones in "errors"):
 *   invalid (400; fields: required, too_long, invalid, phone_invalid, inspection_day_invalid, ownership_required,
 *   payout_required) · not_found (404) · rate_limited (429) · trade_in_device_unavailable, trade_in_refused,
 *   trade_in_answers_incomplete, idempotency_conflict, trade_in_photo_limit, trade_in_offer_closed (409) ·
 *   payout_requires_account (403) · the upload codes of ~/server/uploads.server.
 * Must not import "cloudflare:workers".
 */
import { and, asc, count, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { z } from "zod";
import type { ImageRef, UsedGrade } from "~/lib/dto";
import { newId, publicRef, randomToken, sha256Hex, timingSafeEqual } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { maskPhone, normalizeIraqPhone } from "~/lib/phone";
import type { Actor } from "~/server/actor";
import type { Db } from "~/server/db/drizzle.server";
import { files, tradeInEvents, tradeIns, type DeviceKind, type TradeInStatus } from "~/server/db/schema";
import { expectChanged, runBatch, type BatchStatement } from "~/server/db/tx.server";
import { AppError, invalid, notFound, rateLimited, zodFieldErrors } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { limitKey, rateLimit, type RateLimitRule } from "~/server/ratelimit.server";
import { getSetting } from "~/server/settings.server";
import { deleteFile, getFile, type BlobStore, type StoredFile } from "~/server/storage.server";
import { saveImageUpload, type UploadSource } from "~/server/uploads.server";

export { TRADE_IN_STATUSES, type TradeInStatus } from "~/server/db/schema";

/** Error codes this module throws besides the generic ones (invalid, not_found, rate_limited, upload_*). */
export const TRADE_IN_ERROR_KEYS = [
  "trade_in_device_unavailable",
  "trade_in_refused",
  "trade_in_answers_incomplete",
  "idempotency_conflict",
  "trade_in_photo_limit",
  "trade_in_offer_closed",
  "payout_requires_account",
  // field keys
  "inspection_day_invalid",
  "ownership_required",
  "payout_required",
] as const;

const DAY_MS = 86_400_000;
const BAGHDAD_OFFSET_MS = 3 * 3_600_000;
/** The estimate's ends are rounded down to this step (IQD). */
export const ESTIMATE_STEP_IQD = 5_000;
/** How far ahead a preferred inspection day may be (Baghdad days after today). */
export const INSPECTION_DAYS_AHEAD = 13;

// ───────────────────────────────────────────────────────────────── the questionnaire

export const POWER_ANSWERS = ["works", "faulty", "dead"] as const;
export const BODY_ANSWERS = ["like_new", "light", "visible", "damaged"] as const;
export const SCREEN_ANSWERS = ["perfect", "scratched", "damaged"] as const;
export const ACCOUNT_ANSWERS = ["yes", "no"] as const;
export type PowerAnswer = (typeof POWER_ANSWERS)[number];
export type BodyAnswer = (typeof BODY_ANSWERS)[number];
export type ScreenAnswer = (typeof SCREEN_ANSWERS)[number];
export type AccountAnswer = (typeof ACCOUNT_ANSWERS)[number];

/** Every question, in the order they are asked. `screen` and `included` are asked only when they apply to the device. */
export const TRADE_IN_QUESTIONS = ["power", "body", "screen", "included", "account"] as const;
export type TradeInQuestion = (typeof TRADE_IN_QUESTIONS)[number];
/** The options of the single-choice questions (option rows); `included` is a set of check boxes. */
export const SINGLE_CHOICE: Record<Exclude<TradeInQuestion, "included">, readonly string[]> = {
  power: POWER_ANSWERS,
  body: BODY_ANSWERS,
  screen: SCREEN_ANSWERS,
  account: ACCOUNT_ANSWERS,
};

export type TradeInAnswers = {
  power?: PowerAnswer;
  body?: BodyAnswer;
  screen?: ScreenAnswer;
  /** Accessory keys the shopper sends with the device. `undefined` = not answered yet; [] = the device alone. */
  included?: string[];
  account?: AccountAnswer;
};

export type PreferredWindow = "morning" | "afternoon" | "evening" | "any";
export const PREFERRED_WINDOWS: readonly PreferredWindow[] = ["any", "morning", "afternoon", "evening"];

// ───────────────────────────────────────────────────────────────── devices

/**
 * A device model the store buys (it has an active, model-wide price guide). The guide itself (base price, grade
 * multipliers, deductions) stays on the server; the one figure that leaves is `upToIqd`.
 */
export type TradeInDevice = {
  id: string;
  slug: string;
  name: string;
  platformSlug: string;
  platformName: string;
  kind: DeviceKind;
  image: ImageRef | null;
  /** A built-in screen (handheld PCs, the Switch family, PlayStation Portal): the questionnaire asks about it. */
  hasScreen: boolean;
  /** What a complete unit comes with — the questionnaire asks which of these the shopper sends ("controller", "dock"…). */
  accessories: string[];
  /**
   * The most the estimate can reach for this model — the top of the range for a unit like new, working, with
   * everything it came with (the same figure the wizard shows for those answers), rounded down to 5,000 IQD — or null
   * when the guide cannot price that case. The device tiles say «حتى 350,000 د.ع · تقديري» (v2 §6.14): an estimate,
   * never an offer.
   */
  upToIqd: number | null;
};

type Guide = { id: string; baseIqd: number; multipliers: Partial<Record<UsedGrade, number>>; deductions: Record<string, number>; updatedAt: number };
type DeviceRow = TradeInDevice & { guide: Guide };

type DeviceSqlRow = {
  id: string;
  slug: string;
  name: string | null;
  device_kind: DeviceKind;
  display: string | null;
  platform_slug: string;
  platform_name: string | null;
  guide_id: string;
  base_iqd: number;
  grade_multipliers: string | null;
  deductions: string | null;
  updated_at: number;
  image: string | null;
};

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return value as T;
  if (value === "") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

const MISSING = "missing_";

/** The questionnaire's accessory keys from a guide's deduction keys ("missing_controller" → "controller"). */
function accessoriesOf(deductions: Record<string, number>): string[] {
  return Object.keys(deductions)
    .filter((key) => key.startsWith(MISSING) && key.length > MISSING.length && Number.isSafeInteger(deductions[key]) && deductions[key] >= 0)
    .map((key) => key.slice(MISSING.length));
}

const hasScreenOf = (kind: DeviceKind | null, display: string | null) => kind === "handheld_pc" || display === "object" || display === "text";

function imageOf(raw: unknown, fallbackAlt: string, locale: Locale): ImageRef | null {
  const image = parseJson<{ a: string | null; alt: L10n | null }>(raw);
  return image?.a ? { artKey: image.a, mediaKey: null, alt: pick(image.alt, locale) || fallbackAlt, isIllustration: true } : null;
}

function toDevice(row: DeviceSqlRow, locale: Locale): DeviceRow {
  const name = pick(parseJson<L10n>(row.name), locale) || row.slug;
  const deductions = parseJson<Record<string, number>>(row.deductions) ?? {};
  const guide: Guide = {
    id: row.guide_id,
    baseIqd: row.base_iqd,
    multipliers: parseJson<Partial<Record<UsedGrade, number>>>(row.grade_multipliers) ?? {},
    deductions,
    updatedAt: row.updated_at,
  };
  const hasScreen = hasScreenOf(row.device_kind, row.display);
  const accessories = accessoriesOf(deductions);
  return {
    id: row.id,
    slug: row.slug,
    name,
    platformSlug: row.platform_slug,
    platformName: pick(parseJson<L10n>(row.platform_name), locale) || row.platform_slug,
    kind: row.device_kind,
    image: imageOf(row.image, name, locale),
    hasScreen,
    accessories,
    upToIqd: bestCaseIqd(guide, { hasScreen, accessories }),
    guide,
  };
}

/** The top of the estimate for the best description of a device (see TradeInDevice.upToIqd). Pure. */
export function bestCaseIqd(guide: Guide, device: Pick<TradeInDevice, "hasScreen" | "accessories">): number | null {
  const best: TradeInAnswers = { power: "works", body: "like_new", account: "yes" };
  if (device.hasScreen) best.screen = "perfect";
  if (device.accessories.length > 0) best.included = [...device.accessories];
  // The validity and the time do not change the figure.
  const estimate = computeEstimate(guide, device, best, 1, 0);
  return estimate.kind === "range" ? estimate.maxIqd : null;
}

/** The first picture of a device model (its catalogue photo), as json_object('a', art key, 'alt', L10n). */
const MODEL_IMAGE = sql`(
    SELECT json_object('a', m.art_key, 'alt', json(m.alt))
    FROM media AS m
    WHERE m.owner_type = 'device_model' AND m.owner_id = dm.id AND m.kind IN ('image', 'render') AND m.art_key IS NOT NULL
    ORDER BY m.sort, m.id
    LIMIT 1
  )`;

/** Published device models with an active model-wide guide (variant-specific guides are not used by the questionnaire). */
async function loadDevices(db: Db, locale: Locale, slug?: string): Promise<DeviceRow[]> {
  const rows = await db.all<DeviceSqlRow>(sql`
SELECT dm.id, dm.slug, dm.name, dm.device_kind, json_type(dm.specs, '$.display') AS display,
  pl.slug AS platform_slug, pl.name AS platform_name,
  g.id AS guide_id, g.base_iqd, g.grade_multipliers, g.deductions, g.updated_at,
  ${MODEL_IMAGE} AS image
FROM trade_in_price_guides AS g
JOIN device_models AS dm ON dm.id = g.device_model_id
JOIN platforms AS pl ON pl.id = dm.platform_id
WHERE g.is_active = 1 AND g.variant_id IS NULL AND dm.status = 'published' AND pl.is_active = 1
  ${slug === undefined ? sql`` : sql`AND dm.slug = ${slug}`}
ORDER BY pl.sort ASC, dm.sort ASC, dm.id ASC, g.updated_at DESC, g.id DESC`);
  // One guide per model: the most recently updated active one.
  const seen = new Set<string>();
  const out: DeviceRow[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(toDevice(row, locale));
  }
  return out;
}

function publicDevice(row: DeviceRow): TradeInDevice {
  const { guide, ...device } = row;
  void guide;
  return device;
}

/** Every device model the store buys, in platform order then model order. */
export async function listTradeInDevices(db: Db, locale: Locale): Promise<TradeInDevice[]> {
  return (await loadDevices(db, locale)).map(publicDevice);
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

async function findDevice(db: Db, locale: Locale, slug: unknown): Promise<DeviceRow | null> {
  if (typeof slug !== "string" || slug.length > 80 || !SLUG.test(slug)) return null;
  const [row] = await loadDevices(db, locale, slug);
  return row ?? null;
}

/** One device the store buys, or null (unknown model, no active guide, unpublished). */
export async function getTradeInDevice(db: Db, locale: Locale, slug: unknown): Promise<TradeInDevice | null> {
  const row = await findDevice(db, locale, slug);
  return row ? publicDevice(row) : null;
}

// ───────────────────────────────────────────────────────────────── answers

/** The questions this device gets, in order. */
export function questionsFor(device: Pick<TradeInDevice, "hasScreen" | "accessories">): TradeInQuestion[] {
  return TRADE_IN_QUESTIONS.filter((question) => (question === "screen" ? device.hasScreen : question === "included" ? device.accessories.length > 0 : true));
}

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);

/**
 * Answers read from a query string or a form (tolerant: anything unknown is dropped). The `included` question counts as
 * answered when the form says so with `inc=1` (an empty set of check boxes sends nothing).
 */
export function readTradeInAnswers(params: URLSearchParams | FormData, device: Pick<TradeInDevice, "hasScreen" | "accessories">): TradeInAnswers {
  const get = (name: string) => {
    const value = params.get(name);
    return typeof value === "string" ? value : null;
  };
  const answers: TradeInAnswers = {};
  const power = get("power");
  if (isOneOf(POWER_ANSWERS, power)) answers.power = power;
  const body = get("body");
  if (isOneOf(BODY_ANSWERS, body)) answers.body = body;
  const screen = get("screen");
  if (device.hasScreen && isOneOf(SCREEN_ANSWERS, screen)) answers.screen = screen;
  if (device.accessories.length > 0 && get("inc") === "1") {
    const chosen = params.getAll("included").filter((value): value is string => typeof value === "string");
    answers.included = device.accessories.filter((key) => chosen.includes(key));
  }
  const account = get("account");
  if (isOneOf(ACCOUNT_ANSWERS, account)) answers.account = account;
  return answers;
}

/** The query-string pairs that carry `answers` from step to step (the inverse of readTradeInAnswers). */
export function answerPairs(answers: TradeInAnswers): [string, string][] {
  const pairs: [string, string][] = [];
  if (answers.power) pairs.push(["power", answers.power]);
  if (answers.body) pairs.push(["body", answers.body]);
  if (answers.screen) pairs.push(["screen", answers.screen]);
  if (answers.included) {
    pairs.push(["inc", "1"]);
    for (const key of answers.included) pairs.push(["included", key]);
  }
  if (answers.account) pairs.push(["account", answers.account]);
  return pairs;
}

export function isAnswered(answers: TradeInAnswers, question: TradeInQuestion): boolean {
  return question === "included" ? Array.isArray(answers.included) : answers[question] !== undefined;
}

/** The first question this device still needs, or null when the questionnaire is complete. */
export function firstUnanswered(device: Pick<TradeInDevice, "hasScreen" | "accessories">, answers: TradeInAnswers): TradeInQuestion | null {
  return questionsFor(device).find((question) => !isAnswered(answers, question)) ?? null;
}

// ───────────────────────────────────────────────────────────────── the estimate

export type TradeInRange = { kind: "range"; minIqd: number; maxIqd: number; expiresAt: number; validDays: number; low: UsedGrade; high: UsedGrade; missing: string[]; deductionsIqd: number };

export type TradeInEstimate =
  /** An indicative range — never an offer. `low`…`high` is the grade span it was priced at. */
  | TradeInRange
  /** No online figure: the device is priced after the inspection. */
  | { kind: "inspection"; reason: "not_working" | "damaged" | "unpriced" }
  /** The store cannot buy this device. */
  | { kind: "refused"; reason: "account_locked" };

/** Grades from worst to best. */
const GRADE_RANK: readonly UsedGrade[] = ["C", "B", "A", "A+"];
const worse = (a: UsedGrade, b: UsedGrade): UsedGrade => (GRADE_RANK.indexOf(a) <= GRADE_RANK.indexOf(b) ? a : b);
const BODY_SPAN: Record<Exclude<BodyAnswer, "damaged">, [UsedGrade, UsedGrade]> = { like_new: ["A", "A+"], light: ["B", "A"], visible: ["C", "B"] };

/** The grade span a description supports, or null when it needs an inspection first. Pure. */
export function gradeSpan(answers: TradeInAnswers): { low: UsedGrade; high: UsedGrade } | null {
  if (!answers.body || answers.body === "damaged" || answers.screen === "damaged") return null;
  let [low, high] = BODY_SPAN[answers.body];
  if (answers.screen === "scratched") {
    high = worse(high, "A");
    low = worse(low, "B");
  }
  return { low, high };
}

const floorStep = (amount: number) => Math.max(0, Math.floor(amount / ESTIMATE_STEP_IQD) * ESTIMATE_STEP_IQD);
const isBps = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 20_000;

/**
 * The estimate for complete answers (pure: the guide, the answers, the validity and the time are all given). Callers
 * pass complete answers (see firstUnanswered).
 */
export function computeEstimate(guide: Guide, device: Pick<TradeInDevice, "accessories">, answers: TradeInAnswers, validDays: number, now: number): TradeInEstimate {
  if (answers.account === "no") return { kind: "refused", reason: "account_locked" };
  if (answers.power !== "works") return { kind: "inspection", reason: "not_working" };
  const span = gradeSpan(answers);
  if (!span) return { kind: "inspection", reason: "damaged" };
  const lowBps = guide.multipliers[span.low];
  const highBps = guide.multipliers[span.high];
  if (!Number.isSafeInteger(guide.baseIqd) || guide.baseIqd <= 0 || !isBps(lowBps) || !isBps(highBps)) return { kind: "inspection", reason: "unpriced" };
  const included = answers.included ?? [];
  const missing = device.accessories.filter((key) => !included.includes(key));
  let deductionsIqd = 0;
  for (const key of missing) {
    const amount = guide.deductions[`${MISSING}${key}`];
    if (Number.isSafeInteger(amount) && amount > 0) deductionsIqd += amount;
  }
  const at = (bps: number) => floorStep(Math.floor((guide.baseIqd * bps) / 10_000) - deductionsIqd);
  const a = at(lowBps);
  const b = at(highBps);
  const minIqd = Math.min(a, b);
  const maxIqd = Math.max(a, b);
  if (maxIqd <= 0) return { kind: "inspection", reason: "unpriced" };
  const days = Number.isSafeInteger(validDays) && validDays > 0 ? validDays : 7;
  return { kind: "range", minIqd, maxIqd, expiresAt: now + days * DAY_MS, validDays: days, low: span.low, high: span.high, missing, deductionsIqd };
}

/**
 * The estimate for a device and complete answers, or null for a device the store does not buy. Incomplete answers →
 * AppError("trade_in_answers_incomplete", 409).
 */
export async function estimateTradeIn(db: Db, locale: Locale, slug: unknown, answers: TradeInAnswers, now: number): Promise<{ device: TradeInDevice; estimate: TradeInEstimate } | null> {
  const device = await findDevice(db, locale, slug);
  if (!device) return null;
  if (firstUnanswered(device, answers) !== null) throw new AppError("trade_in_answers_incomplete", 409);
  const estimate = computeEstimate(device.guide, device, answers, await getSetting(db, "tradein.estimate_valid_days"), now);
  return { device: publicDevice(device), estimate };
}

// ───────────────────────────────────────────────────────────────── creating a request

const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{22,128}$/;
const blank = (value: unknown) => (value === "" || value === null ? undefined : value);
/** Free text: control, bidi-override and invisible characters are removed first (~/server/text.server). */
const optionalText = (max: number, multiline = false) =>
  z.preprocess(
    blank,
    z
      .string()
      .overwrite(multiline ? cleanBlock : cleanLine)
      .trim()
      .max(max, "too_long")
      .optional()
      .transform((value) => (value ? value : null)),
  );

export const CreateTradeInInput = z.object({
  /** randomToken() rendered into the contact step's form, one per attempt. */
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY, "invalid"),
  /** Device model slug. */
  device: z.string().trim().min(1, "required").max(80, "invalid"),
  answers: z.object({
    power: z.enum(POWER_ANSWERS).optional(),
    body: z.enum(BODY_ANSWERS).optional(),
    screen: z.enum(SCREEN_ANSWERS).optional(),
    included: z.array(z.string().max(40)).max(12).optional(),
    account: z.enum(ACCOUNT_ANSWERS).optional(),
  }),
  contactName: optionalText(100),
  phone: z.preprocess((value) => (value === undefined || value === null ? "" : value), z.string().trim().min(1, "required").max(40, "too_long")),
  /** YYYY-MM-DD (Baghdad), today … +INSPECTION_DAYS_AHEAD. Empty = no preference. */
  preferredDay: z.preprocess(blank, z.string().max(10, "inspection_day_invalid").optional()),
  preferredWindow: z.preprocess(blank, z.enum(["morning", "afternoon", "evening", "any"]).optional()),
  notes: optionalText(500, true),
  /** "This device is mine and I may sell it" — a declaration; the inspection checks it. */
  ownershipConfirmed: z.literal(true, { error: "ownership_required" }),
});
export type CreateTradeInInput = z.input<typeof CreateTradeInInput>;

export type TradeInWho = {
  customerId: string | null;
  ip: string | null;
  locale: Locale;
  storeMode: "demo" | "live";
  /** The `tt_tradein` cookie: the photos uploaded for this request. */
  draftToken?: string | null;
};

export type CreateTradeInResult = {
  ref: string;
  tradeInId: string;
  /** The tracking token: the confirmation link is /trade-in/<ref>?t=<accessToken>. */
  accessToken: string;
  status: TradeInStatus;
  /** The range stored with the request; null when it is priced after the inspection (and on a replay). */
  estimate: TradeInRange | null;
  photos: number;
  replayed: boolean;
};

/** Requests and lookups per IP, phone and reference. Generous for people, tight for scripts. */
export const TRADE_IN_LIMITS = {
  perIp: { limit: 10, windowSec: 60 * 60 },
  perPhone: { limit: 5, windowSec: 24 * 60 * 60 },
  lookupIp: { limit: 10, windowSec: 15 * 60 },
  lookupRef: { limit: 10, windowSec: 60 * 60 },
} as const satisfies Record<string, RateLimitRule>;

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/** The id of the request made with this key: `tin_` + 26 Crockford base32 characters (the shape of newId). */
export async function tradeInIdFor(idempotencyKey: string): Promise<string> {
  const bytes = await digest(`tamtam.tradein.id.v1|${idempotencyKey}`);
  let out = "";
  for (let i = 0; i < 26; i++) out += BASE32[bytes[i] % 32];
  return `tin_${out}`;
}

/** The guest tracking token of a request (only its sha256 is stored). */
export async function tradeInAccessToken(tradeInId: string, idempotencyKey: string): Promise<string> {
  return base64Url(await digest(`tamtam.tradein.access.v1|${tradeInId}|${idempotencyKey}`));
}

/** The Baghdad calendar day of an instant: "2026-11-11". */
export const baghdadDay = (at: number): string => new Date(at + BAGHDAD_OFFSET_MS).toISOString().slice(0, 10);

/** The days a shopper may prefer for the inspection, today first (Baghdad). */
export function inspectionDays(now: number, ahead = INSPECTION_DAYS_AHEAD): string[] {
  return Array.from({ length: ahead + 1 }, (_, index) => baghdadDay(now + index * DAY_MS));
}

function validInspectionDay(day: string, now: number): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const parsed = Date.parse(`${day}T00:00:00Z`);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString().slice(0, 10) !== day) return false;
  return day >= baghdadDay(now) && day <= baghdadDay(now + INSPECTION_DAYS_AHEAD * DAY_MS);
}

/** The actor for a shopper's own trade-in actions (uploads, answers). */
export function tradeInActor(who: { customerId?: string | null; ip?: string | null }): Actor {
  return who.customerId ? { kind: "customer", id: who.customerId, ip: who.ip ?? null } : { kind: "guest", ip: who.ip ?? null };
}

const eventActor = (who: { customerId?: string | null }) => (who.customerId ? { actorKind: "customer" as const, actorId: who.customerId } : { actorKind: "guest" as const, actorId: null });

async function checkLimit(db: Db, key: string | null, rule: RateLimitRule, now: number): Promise<void> {
  const verdict = await rateLimit(db, key, rule, now);
  if (!verdict.ok) throw rateLimited(verdict.retryAfterSec);
}

type ExistingRequest = { id: string; ref: string; phoneE164: string; status: TradeInStatus };

async function findRequest(db: Db, id: string): Promise<ExistingRequest | null> {
  const row = await db.select({ id: tradeIns.id, ref: tradeIns.ref, phoneE164: tradeIns.phoneE164, status: tradeIns.status }).from(tradeIns).where(eq(tradeIns.id, id)).get();
  return row ?? null;
}

async function replay(db: Db, existing: ExistingRequest, phone: string, idempotencyKey: string): Promise<CreateTradeInResult> {
  if (existing.phoneE164 !== phone) throw new AppError("idempotency_conflict", 409);
  return {
    ref: existing.ref,
    tradeInId: existing.id,
    accessToken: await tradeInAccessToken(existing.id, idempotencyKey),
    status: existing.status,
    estimate: null,
    photos: await countPhotos(db, "trade_in", existing.id),
    replayed: true,
  };
}

/**
 * Creates a trade-in request (see the file header). Throws AppError — 400 invalid with field keys, 409 for a device the
 * store does not buy, a locked device, incomplete answers or a key reused with another phone, 429 rate_limited — and
 * writes nothing when it throws.
 */
export async function createTradeIn(db: Db, who: TradeInWho, raw: unknown, now: number): Promise<CreateTradeInResult> {
  const parsed = CreateTradeInInput.safeParse(raw);
  if (!parsed.success) {
    // Every field at once (the form's error summary lists them all): a phone that is there but unreadable is said
    // together with the rest, not one round trip later.
    const fields = zodFieldErrors(parsed.error);
    const typed = (raw as { phone?: unknown } | null)?.phone;
    if (!fields.phone && typeof typed === "string" && typed.trim() !== "" && !normalizeIraqPhone(typed)) fields.phone = "phone_invalid";
    throw invalid(fields, "tradein.create");
  }
  const input = parsed.data;
  const phone = normalizeIraqPhone(input.phone);
  const fields: Record<string, string> = {};
  if (!phone) fields.phone = "phone_invalid";
  if (input.preferredDay && !validInspectionDay(input.preferredDay, now)) fields.preferredDay = "inspection_day_invalid";
  if (!phone || Object.keys(fields).length > 0) throw invalid(fields, "tradein.create");

  const id = await tradeInIdFor(input.idempotencyKey);
  const earlier = await findRequest(db, id);
  if (earlier) return replay(db, earlier, phone, input.idempotencyKey);

  const device = await findDevice(db, who.locale, input.device);
  if (!device) throw new AppError("trade_in_device_unavailable", 409, { fields: { device: "trade_in_device_unavailable" } });
  const answers: TradeInAnswers = { ...input.answers };
  if (!device.hasScreen) delete answers.screen;
  if (device.accessories.length === 0) delete answers.included;
  else if (answers.included) answers.included = device.accessories.filter((key) => answers.included?.includes(key));
  if (firstUnanswered(device, answers) !== null) throw new AppError("trade_in_answers_incomplete", 409);

  const estimate = computeEstimate(device.guide, device, answers, await getSetting(db, "tradein.estimate_valid_days"), now);
  if (estimate.kind === "refused") throw new AppError("trade_in_refused", 409);

  await checkLimit(db, await limitKey("tradein", "ip", who.ip), TRADE_IN_LIMITS.perIp, now);
  await checkLimit(db, await limitKey("tradein", "phone", phone), TRADE_IN_LIMITS.perPhone, now);

  const draft = isDraftToken(who.draftToken) ? await draftOwnerId(who.draftToken) : null;
  const photos = draft ? await countPhotos(db, DRAFT_OWNER, draft) : 0;

  const accessToken = await tradeInAccessToken(id, input.idempotencyKey);
  const accessTokenHash = await sha256Hex(accessToken);
  const range = estimate.kind === "range" ? estimate : null;
  const status: TradeInStatus = range ? "estimated" : "submitted";
  const included = answers.included ?? [];
  const stored: Record<string, string> = { power: answers.power ?? "", body: answers.body ?? "", account: answers.account ?? "" };
  if (answers.screen) stored.screen = answers.screen;
  if (device.accessories.length > 0) {
    stored.included = included.join(",");
    stored.missing = device.accessories.filter((key) => !included.includes(key)).join(",");
  }

  const attempt = async (ref: string): Promise<CreateTradeInResult> => {
    const statements: BatchStatement[] = [
      db
        .insert(tradeIns)
        .values({
          id,
          ref,
          customerId: who.customerId,
          phoneE164: phone,
          deviceModelId: device.id,
          variantId: null,
          answers: stored,
          estimateMinIqd: range?.minIqd ?? null,
          estimateMaxIqd: range?.maxIqd ?? null,
          estimateExpiresAt: range?.expiresAt ?? null,
          status,
          accessTokenHash,
          createdAt: now,
          contactName: input.contactName,
          locale: who.locale,
          isDemo: who.storeMode === "demo",
          updatedAt: now,
        })
        .onConflictDoNothing({ target: tradeIns.id }),
      // A second request with the same key inserts nothing: the batch stops here and the first request is the answer.
      expectChanged(db, 1, { code: "NO_ROWS_CHANGED", detail: "trade_ins.id" }),
      db.insert(tradeInEvents).values({
        id: newId("tie"),
        tradeInId: id,
        kind: "submitted",
        data: {
          photos,
          preferredDay: input.preferredDay ?? null,
          preferredWindow: input.preferredWindow ?? null,
          notes: input.notes,
          ownershipDeclared: true,
          estimate: estimate.kind === "range" ? "range" : estimate.reason,
        },
        ...eventActor(who),
        at: now,
      }),
    ];
    if (range) {
      statements.push(
        db.insert(tradeInEvents).values({
          id: newId("tie"),
          tradeInId: id,
          kind: "estimated",
          // What the figure was based on, so a later change of the guide can be traced (brief §5 "track valuation changes").
          data: {
            minIqd: range.minIqd,
            maxIqd: range.maxIqd,
            expiresAt: range.expiresAt,
            low: range.low,
            high: range.high,
            missing: range.missing,
            deductionsIqd: range.deductionsIqd,
            guideId: device.guide.id,
            guideBaseIqd: device.guide.baseIqd,
            guideUpdatedAt: device.guide.updatedAt,
            multipliers: { low: device.guide.multipliers[range.low] ?? null, high: device.guide.multipliers[range.high] ?? null },
          },
          actorKind: "system",
          actorId: "tradein.estimate",
          at: now,
        }),
      );
    }
    if (draft) {
      statements.push(
        db
          .update(files)
          .set({ ownerType: "trade_in", ownerId: id })
          .where(and(eq(files.ownerType, DRAFT_OWNER), eq(files.ownerId, draft), eq(files.kind, PHOTO_KIND), isNull(files.deletedAt))),
      );
    }
    await runBatch(db, statements);
    return { ref, tradeInId: id, accessToken, status, estimate: range, photos, replayed: false };
  };

  try {
    return await attempt(publicRef("TI"));
  } catch (error) {
    // The same key won a race (or committed meanwhile): the first request is the answer.
    const winner = await findRequest(db, id);
    if (winner) return replay(db, winner, phone, input.idempotencyKey);
    // A reference collision (30^8 references) gets one more try with a new reference; anything else bubbles.
    if (/trade_ins\.ref|trade_ins_ref_uq/.test(String((error as { message?: unknown })?.message ?? ""))) return attempt(publicRef("TI"));
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────── reading a request

export type TradeInHistoryEntry = {
  kind: string;
  at: number;
  /** "estimated": the range. */
  minIqd?: number;
  maxIqd?: number;
  /** "offered": the amount. */
  amountIqd?: number;
  /** "inspection_scheduled": the confirmed time. */
  scheduledAt?: number;
  /** "accepted": how the shopper will be paid. */
  payout?: "store_credit" | "cash";
};

export type TradeInView = {
  ref: string;
  /** The request's status as the shopper sees it: an "offered" request whose offer is past its date reads "expired". */
  status: TradeInStatus;
  createdAt: number;
  isDemo: boolean;
  device: { slug: string | null; name: string; platformSlug: string | null; image: ImageRef | null; hasScreen: boolean; accessories: string[] };
  answers: TradeInAnswers;
  /** The stored range (`expired` once its validity has passed). */
  estimate: { minIqd: number; maxIqd: number; expiresAt: number | null; expired: boolean } | null;
  /** Why there is no online figure, when there is none (the device is priced after the inspection). */
  inspectionReason: "not_working" | "damaged" | "unpriced" | null;
  /** The final, human-approved offer when there is one. */
  offer: { amountIqd: number; expiresAt: number | null; expired: boolean } | null;
  /**
   * What the inspection found, as the offer was made on it (the latest `offered` history event, written by the staff
   * side): the grade, how many checks passed and failed, and the accessories handed over — plus the checklist lines in
   * the template's words when they are the ones that snapshot counted. Null without an offer. Never the inspector's
   * notes, the serial or who inspected.
   */
  inspection: TradeInInspectionView | null;
  payoutMethod: "store_credit" | "cash" | null;
  /** The inspection time staff confirmed. */
  inspectionAt: number | null;
  /** What the shopper asked for. */
  preferred: { day: string | null; window: PreferredWindow | null } | null;
  contactName: string | null;
  phoneMasked: string;
  photoCount: number;
  history: TradeInHistoryEntry[];
  /** A final offer is open and the shopper may answer it. */
  canRespond: boolean;
  /** Store credit needs an account (a wallet): only requests made while signed in can choose it. */
  canChooseCredit: boolean;
};

/** The inspection result a shopper sees beside the final offer (TradeInView.inspection). */
export type TradeInInspectionView = {
  grade: UsedGrade | null;
  /** Checks that passed / found a problem, as counted when the offer was made (null when not recorded). */
  passed: number | null;
  failed: number | null;
  /** Accessory keys handed over with the device ("controller", "dock"…). */
  included: string[];
  /** The checklist lines (pass / fail only), in the shopper's language; empty when they no longer match the snapshot. */
  checks: { key: string; label: string; ok: boolean }[];
};

const REF = /^TI-[2-9A-HJ-NP-Z]{8}$/;

/** "ti-7k4m2q9x " → "TI-7K4M2Q9X", or null when it cannot be a trade-in reference. */
export function normalizeTradeInRef(ref: unknown): string | null {
  if (typeof ref !== "string") return null;
  const value = ref.trim().toUpperCase();
  return REF.test(value) ? value : null;
}

/** What the shopper side reads of a request (no serial, no inspection notes, no offer author). */
type RequestRow = {
  id: string;
  ref: string;
  customerId: string | null;
  phoneE164: string;
  answers: Record<string, unknown> | null;
  estimateMinIqd: number | null;
  estimateMaxIqd: number | null;
  estimateExpiresAt: number | null;
  status: TradeInStatus;
  finalOfferIqd: number | null;
  offerExpiresAt: number | null;
  payoutMethod: "store_credit" | "cash" | null;
  accessTokenHash: string | null;
  createdAt: number;
  contactName: string | null;
  deviceText: string | null;
  inspectionScheduledAt: number | null;
  isDemo: boolean;
  modelSlug: string | null;
  modelName: unknown;
  modelKind: DeviceKind | null;
  display: string | null;
  platformSlug: string | null;
  image: unknown;
  guideDeductions: unknown;
  /** trade_ins.inspection (staff): read only for the checklist lines of the offer — never sent as it is. */
  inspection: unknown;
};

type RequestSqlRow = {
  id: string;
  ref: string;
  customer_id: string | null;
  phone_e164: string;
  answers: string | null;
  estimate_min_iqd: number | null;
  estimate_max_iqd: number | null;
  estimate_expires_at: number | null;
  status: TradeInStatus;
  final_offer_iqd: number | null;
  offer_expires_at: number | null;
  payout_method: "store_credit" | "cash" | null;
  access_token_hash: string | null;
  created_at: number;
  contact_name: string | null;
  device_text: string | null;
  inspection_scheduled_at: number | null;
  is_demo: number;
  model_slug: string | null;
  model_name: string | null;
  model_kind: DeviceKind | null;
  display: string | null;
  platform_slug: string | null;
  image: string | null;
  guide_deductions: string | null;
  inspection: string | null;
};

async function loadRequest(db: Db, ref: string): Promise<RequestRow | null> {
  const [row] = await db.all<RequestSqlRow>(sql`
SELECT t.id, t.ref, t.customer_id, t.phone_e164, t.answers, t.estimate_min_iqd, t.estimate_max_iqd, t.estimate_expires_at,
  t.status, t.final_offer_iqd, t.offer_expires_at, t.payout_method, t.access_token_hash, t.created_at, t.contact_name,
  t.device_text, t.inspection_scheduled_at, t.is_demo, t.inspection,
  dm.slug AS model_slug, dm.name AS model_name, dm.device_kind AS model_kind, json_type(dm.specs, '$.display') AS display,
  pl.slug AS platform_slug,
  ${MODEL_IMAGE} AS image,
  (
    SELECT g.deductions FROM trade_in_price_guides AS g
    WHERE g.device_model_id = dm.id AND g.variant_id IS NULL
    ORDER BY g.is_active DESC, g.updated_at DESC, g.id DESC
    LIMIT 1
  ) AS guide_deductions
FROM trade_ins AS t
LEFT JOIN device_models AS dm ON dm.id = t.device_model_id
LEFT JOIN platforms AS pl ON pl.id = dm.platform_id
WHERE t.ref = ${ref}
LIMIT 1`);
  if (!row) return null;
  return {
    id: row.id,
    ref: row.ref,
    customerId: row.customer_id,
    phoneE164: row.phone_e164,
    answers: parseJson<Record<string, unknown>>(row.answers),
    estimateMinIqd: row.estimate_min_iqd,
    estimateMaxIqd: row.estimate_max_iqd,
    estimateExpiresAt: row.estimate_expires_at,
    status: row.status,
    finalOfferIqd: row.final_offer_iqd,
    offerExpiresAt: row.offer_expires_at,
    payoutMethod: row.payout_method,
    accessTokenHash: row.access_token_hash,
    createdAt: row.created_at,
    contactName: row.contact_name,
    deviceText: row.device_text,
    inspectionScheduledAt: row.inspection_scheduled_at,
    isDemo: row.is_demo === 1,
    modelSlug: row.model_slug,
    modelName: row.model_name,
    modelKind: row.model_kind,
    display: row.display,
    platformSlug: row.platform_slug,
    image: row.image,
    guideDeductions: row.guide_deductions,
    inspection: row.inspection,
  };
}

const GRADE_VALUES: readonly UsedGrade[] = ["A+", "A", "B", "C"];
const ACCESSORY_KEY = /^[a-z0-9_]{1,40}$/;
const countOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

type StoredInspection = { checklist?: { templateId?: unknown; items?: { key?: unknown; result?: unknown }[] } | null };

/**
 * The inspection result beside a final offer: the latest `offered` event's snapshot (grade, passed, failed, included —
 * admin module 13 writes it), and the checklist lines of the recorded inspection in the template's words, kept only
 * when their pass / fail counts are the snapshot's (an offer is never made on another inspection than the one shown).
 */
async function inspectionView(db: Db, row: RequestRow, offered: Record<string, unknown> | null, locale: Locale): Promise<TradeInInspectionView | null> {
  if (!offered) return null;
  const grade = GRADE_VALUES.find((value) => value === offered.grade) ?? null;
  const passed = countOf(offered.passed);
  const failed = countOf(offered.failed);
  const included = Array.isArray(offered.included) ? [...new Set(offered.included.filter((key): key is string => typeof key === "string" && ACCESSORY_KEY.test(key)))] : [];

  const stored = parseJson<StoredInspection>(row.inspection);
  const items = Array.isArray(stored?.checklist?.items) ? stored.checklist.items : [];
  const templateId = typeof stored?.checklist?.templateId === "string" ? stored.checklist.templateId : null;
  let checks: TradeInInspectionView["checks"] = [];
  if (templateId && items.length > 0) {
    const [template] = await db.all<{ items: string | null }>(sql`SELECT items FROM inspection_templates WHERE id = ${templateId} LIMIT 1`);
    const labels = new Map<string, L10n>();
    for (const item of parseJson<{ key?: unknown; label?: L10n }[]>(template?.items) ?? []) if (item && typeof item.key === "string" && item.label) labels.set(item.key, item.label);
    for (const item of items) {
      if (!item || typeof item.key !== "string" || (item.result !== "pass" && item.result !== "fail")) continue;
      const label = pick(labels.get(item.key) ?? null, locale);
      if (label) checks.push({ key: item.key, label, ok: item.result === "pass" });
    }
    const agree = passed === checks.filter((check) => check.ok).length && failed === checks.filter((check) => !check.ok).length;
    if (!agree) checks = [];
  }
  return { grade, passed, failed, included, checks };
}

async function authorized(row: RequestRow, access: { accessToken?: string | null; customerId?: string | null }): Promise<boolean> {
  if (access.customerId && row.customerId && access.customerId === row.customerId) return true;
  if (typeof access.accessToken === "string" && /^[A-Za-z0-9_-]{20,128}$/.test(access.accessToken) && row.accessTokenHash) {
    return timingSafeEqual(await sha256Hex(access.accessToken), row.accessTokenHash);
  }
  return false;
}

/** History kinds the shopper sees, in lifecycle order (staff-internal kinds, such as notes, are left out). */
const LIFECYCLE = ["submitted", "estimated", "inspection_scheduled", "inspected", "offered", "accepted", "declined", "paid", "cancelled", "expired"];
const PUBLIC_EVENTS = new Set(LIFECYCLE);

async function buildView(db: Db, row: RequestRow, locale: Locale, now: number): Promise<TradeInView> {
  const [events, photoCount] = await Promise.all([
    db
      .select({ kind: tradeInEvents.kind, data: tradeInEvents.data, at: tradeInEvents.at })
      .from(tradeInEvents)
      .where(eq(tradeInEvents.tradeInId, row.id))
      .orderBy(asc(tradeInEvents.at), asc(tradeInEvents.id)),
    countPhotos(db, "trade_in", row.id),
  ]);
  const stored = row.answers ?? {};
  const deductions = parseJson<Record<string, number>>(row.guideDeductions) ?? {};
  const answers: TradeInAnswers = {};
  if (isOneOf(POWER_ANSWERS, stored.power)) answers.power = stored.power;
  if (isOneOf(BODY_ANSWERS, stored.body)) answers.body = stored.body;
  if (isOneOf(SCREEN_ANSWERS, stored.screen)) answers.screen = stored.screen;
  if (typeof stored.included === "string") answers.included = stored.included.split(",").filter(Boolean);
  if (isOneOf(ACCOUNT_ANSWERS, stored.account)) answers.account = stored.account;

  const submitted = events.find((event) => event.kind === "submitted")?.data ?? null;
  const day = typeof submitted?.preferredDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(submitted.preferredDay) ? submitted.preferredDay : null;
  const window = isOneOf(PREFERRED_WINDOWS, submitted?.preferredWindow) ? submitted.preferredWindow : null;

  const history: TradeInHistoryEntry[] = events
    .filter((event) => PUBLIC_EVENTS.has(event.kind))
    // Events written in one batch share a timestamp: the lifecycle decides their order (submitted before estimated).
    .sort((a, b) => a.at - b.at || LIFECYCLE.indexOf(a.kind) - LIFECYCLE.indexOf(b.kind))
    .map((event) => {
      const data = event.data ?? {};
      const entry: TradeInHistoryEntry = { kind: event.kind, at: event.at };
      if (event.kind === "estimated" && Number.isSafeInteger(data.minIqd) && Number.isSafeInteger(data.maxIqd)) {
        entry.minIqd = data.minIqd as number;
        entry.maxIqd = data.maxIqd as number;
      }
      if (event.kind === "offered" && Number.isSafeInteger(data.amountIqd)) entry.amountIqd = data.amountIqd as number;
      if (event.kind === "inspection_scheduled" && Number.isSafeInteger(data.at)) entry.scheduledAt = data.at as number;
      if (event.kind === "accepted" && (data.payout === "store_credit" || data.payout === "cash")) entry.payout = data.payout;
      return entry;
    });

  const estimate =
    row.estimateMinIqd !== null && row.estimateMaxIqd !== null
      ? { minIqd: row.estimateMinIqd, maxIqd: row.estimateMaxIqd, expiresAt: row.estimateExpiresAt, expired: row.estimateExpiresAt !== null && row.estimateExpiresAt <= now }
      : null;
  const offer =
    row.finalOfferIqd !== null && ["offered", "accepted", "declined", "paid", "expired"].includes(row.status)
      ? { amountIqd: row.finalOfferIqd, expiresAt: row.offerExpiresAt, expired: row.offerExpiresAt !== null && row.offerExpiresAt <= now }
      : null;
  // The newest offer's snapshot (events are in time order; a replaced offer leaves an older "offered" behind).
  const offeredEvent = offer ? ([...events].reverse().find((event) => event.kind === "offered")?.data ?? null) : null;
  const inspection = await inspectionView(db, row, offeredEvent, locale);
  const name = pick(parseJson<L10n>(row.modelName), locale) || row.deviceText || "";

  // An open offer past its date is over for the shopper even before the daily job closes the row (as the admin shows
  // it): the page never says "awaiting your answer" about an offer that can no longer be answered.
  const status: TradeInStatus = row.status === "offered" && offer?.expired ? "expired" : row.status;

  return {
    ref: row.ref,
    status,
    createdAt: row.createdAt,
    isDemo: row.isDemo,
    device: {
      slug: row.modelSlug,
      name,
      platformSlug: row.platformSlug,
      image: imageOf(row.image, name, locale),
      hasScreen: hasScreenOf(row.modelKind, row.display),
      accessories: accessoriesOf(deductions),
    },
    answers,
    estimate,
    inspectionReason: estimate === null && isOneOf(["not_working", "damaged", "unpriced"] as const, submitted?.estimate) ? submitted.estimate : null,
    offer,
    inspection,
    payoutMethod: row.payoutMethod,
    inspectionAt: row.inspectionScheduledAt,
    preferred: day || window ? { day, window } : null,
    contactName: row.contactName,
    phoneMasked: maskPhone(row.phoneE164),
    photoCount,
    history,
    canRespond: row.status === "offered" && offer !== null && !offer.expired,
    canChooseCredit: row.customerId !== null,
  };
}

/**
 * A request, for whoever may see it: the holder of the tracking token from the confirmation link, or the signed-in
 * customer who made it. Anyone else — and an unknown reference — gets null (the same answer, so references cannot be
 * probed).
 */
export async function getTradeInByRef(db: Db, ref: unknown, access: { accessToken?: string | null; customerId?: string | null }, locale: Locale, now: number): Promise<TradeInView | null> {
  const normalized = normalizeTradeInRef(ref);
  if (!normalized) return null;
  const row = await loadRequest(db, normalized);
  if (!row || !(await authorized(row, access))) return null;
  return buildView(db, row, locale, now);
}

/**
 * The tracking page without the link: the reference AND the phone number it was made with. Rate-limited per IP and
 * per reference; a wrong reference and a wrong phone give the same null. A missing or unreadable phone is a field
 * error (that reveals nothing about the request).
 */
export async function lookupTradeIn(db: Db, raw: { ref: unknown; phone: unknown }, origin: { ip: string | null }, locale: Locale, now: number): Promise<TradeInView | null> {
  const typed = typeof raw.phone === "string" ? raw.phone.trim() : "";
  const phone = normalizeIraqPhone(typed);
  if (!phone) throw invalid({ phone: typed === "" ? "required" : "phone_invalid" }, "tradein.lookup");
  await checkLimit(db, await limitKey("tradein-lookup", "ip", origin.ip), TRADE_IN_LIMITS.lookupIp, now);
  const ref = normalizeTradeInRef(raw.ref);
  if (!ref) return null;
  await checkLimit(db, await limitKey("tradein-lookup", "ref", ref), TRADE_IN_LIMITS.lookupRef, now);
  const row = await loadRequest(db, ref);
  if (!row || !timingSafeEqual(row.phoneE164, phone)) return null;
  return buildView(db, row, locale, now);
}

// ───────────────────────────────────────────────────────────────── the shopper's answer to a final offer

export const RespondToOfferInput = z.discriminatedUnion("decision", [
  z.object({ decision: z.literal("accept"), payout: z.preprocess(blank, z.enum(["store_credit", "cash"], { error: "payout_required" })) }),
  z.object({ decision: z.literal("decline"), reason: optionalText(300, true) }),
]);

/**
 * Accepts or declines the final offer — only while it is open (status "offered", before offer_expires_at), only for the
 * token holder or the signed-in owner, in one guarded update with its history event (a second answer, or one after the
 * offer closed, gets "trade_in_offer_closed"). Store credit goes to the customer's wallet, so it needs the request to
 * belong to an account (`payout_requires_account`). Paying out is staff work (admin), at the hand-over.
 */
export async function respondToOffer(
  db: Db,
  who: { ref: unknown; accessToken?: string | null; customerId?: string | null },
  raw: unknown,
  now: number,
): Promise<{ status: "accepted" | "declined" }> {
  const parsed = RespondToOfferInput.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "tradein.respond");
  const input = parsed.data;
  const ref = normalizeTradeInRef(who.ref);
  const row = ref ? await loadRequest(db, ref) : null;
  if (!row || !(await authorized(row, who))) throw notFound("trade_in");
  if (row.status !== "offered" || row.finalOfferIqd === null || (row.offerExpiresAt !== null && row.offerExpiresAt <= now)) throw new AppError("trade_in_offer_closed", 409);
  if (input.decision === "accept" && input.payout === "store_credit" && !row.customerId) {
    throw new AppError("payout_requires_account", 403, { fields: { payout: "payout_requires_account" } });
  }
  const open = and(eq(tradeIns.id, row.id), eq(tradeIns.status, "offered"), sql`(${tradeIns.offerExpiresAt} IS NULL OR ${tradeIns.offerExpiresAt} > ${now})`);
  const status = input.decision === "accept" ? ("accepted" as const) : ("declined" as const);
  try {
    await runBatch(db, [
      input.decision === "accept"
        ? db.update(tradeIns).set({ status, payoutMethod: input.payout, acceptedAt: now, updatedAt: now }).where(open)
        : db.update(tradeIns).set({ status, declinedAt: now, declineReason: input.reason, updatedAt: now }).where(open),
      expectChanged(db, 1, { code: "NO_ROWS_CHANGED", detail: "trade_ins.offer" }),
      db.insert(tradeInEvents).values({
        id: newId("tie"),
        tradeInId: row.id,
        kind: status,
        data: input.decision === "accept" ? { payout: input.payout, amountIqd: row.finalOfferIqd } : { reason: input.reason, amountIqd: row.finalOfferIqd },
        ...eventActor(who),
        at: now,
      }),
    ]);
  } catch (error) {
    // Someone (or the expiry job) moved the request on between the read and the write.
    const current = await loadRequest(db, row.ref);
    if (current && (current.status !== "offered" || (current.offerExpiresAt !== null && current.offerExpiresAt <= now))) throw new AppError("trade_in_offer_closed", 409, { cause: error });
    throw error;
  }
  return { status };
}

// ───────────────────────────────────────────────────────────────── photos (private, drafted before the request exists)

export const TRADE_IN_PHOTO_LIMIT = 6;
export const TRADE_IN_DRAFT_COOKIE = "tt_tradein";
/** How long the draft cookie (and its photos) last. */
export const TRADE_IN_DRAFT_MAX_AGE_SEC = 2 * 24 * 60 * 60;
const DRAFT_OWNER = "trade_in_draft";
const PHOTO_KIND = "trade_in_photo";

export const newDraftToken = (): string => randomToken(24);
export const isDraftToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(value);
const draftOwnerId = (token: string) => sha256Hex(`tamtam.tradein.draft.v1|${token}`);

export type TradeInDraftPhoto = { id: string; name: string | null; width: number | null; height: number | null; createdAt: number };

async function countPhotos(db: Db, ownerType: string, ownerId: string): Promise<number> {
  const row = await db
    .select({ n: count() })
    .from(files)
    .where(and(eq(files.ownerType, ownerType), eq(files.ownerId, ownerId), eq(files.kind, PHOTO_KIND), isNull(files.deletedAt)))
    .get();
  return Number(row?.n ?? 0);
}

/** The photos of a draft, oldest first. */
export async function listTradeInDraftPhotos(db: Db, token: string | null | undefined): Promise<TradeInDraftPhoto[]> {
  if (!isDraftToken(token)) return [];
  const owner = await draftOwnerId(token);
  const rows = await db
    .select({ id: files.id, name: files.originalName, width: files.width, height: files.height, createdAt: files.createdAt })
    .from(files)
    .where(and(eq(files.ownerType, DRAFT_OWNER), eq(files.ownerId, owner), eq(files.kind, PHOTO_KIND), isNull(files.deletedAt)))
    .orderBy(asc(files.createdAt), asc(files.id));
  return rows.map((row) => ({ id: row.id, name: row.name ?? null, width: row.width ?? null, height: row.height ?? null, createdAt: row.createdAt }));
}

/**
 * Stores one photo for a draft (type, size and metadata handled by ~/server/uploads.server; private, kind
 * "trade_in_photo"). AppError: the upload codes (upload_missing, upload_too_large, upload_type, upload_corrupt,
 * upload_dimensions) and "trade_in_photo_limit" once the draft holds TRADE_IN_PHOTO_LIMIT photos.
 */
export async function addTradeInDraftPhoto(db: Db, store: BlobStore, token: string, source: UploadSource, createdBy: Actor, now: number): Promise<TradeInDraftPhoto & { count: number }> {
  if (!isDraftToken(token)) throw invalid({ draft: "invalid" }, "tradein.photo");
  const owner = await draftOwnerId(token);
  if ((await countPhotos(db, DRAFT_OWNER, owner)) >= TRADE_IN_PHOTO_LIMIT) throw new AppError("trade_in_photo_limit", 409);
  const { file } = await saveImageUpload(db, store, source, { visibility: "private", kind: PHOTO_KIND, ownerType: DRAFT_OWNER, ownerId: owner, createdBy, now });
  // Two uploads at the same moment can both pass the count: the later one gives way.
  const total = await countPhotos(db, DRAFT_OWNER, owner);
  if (total > TRADE_IN_PHOTO_LIMIT) {
    await deleteFile(db, store, file.id, now);
    throw new AppError("trade_in_photo_limit", 409);
  }
  return { id: file.id, name: file.originalName ?? null, width: file.width ?? null, height: file.height ?? null, createdAt: file.createdAt, count: total };
}

async function draftFile(db: Db, token: string | null | undefined, fileId: unknown): Promise<{ id: string } | null> {
  if (!isDraftToken(token) || typeof fileId !== "string" || !/^fil_[0-9A-Z]{26}$/.test(fileId)) return null;
  const owner = await draftOwnerId(token);
  const row = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.id, fileId), eq(files.ownerType, DRAFT_OWNER), eq(files.ownerId, owner), eq(files.kind, PHOTO_KIND), isNull(files.deletedAt)))
    .get();
  return row ?? null;
}

/** Removes one photo of the draft (bytes deleted, row marked). False when it is not this draft's photo. */
export async function removeTradeInDraftPhoto(db: Db, store: BlobStore, token: string | null | undefined, fileId: unknown, now: number): Promise<boolean> {
  const row = await draftFile(db, token, fileId);
  if (!row) return false;
  return deleteFile(db, store, row.id, now);
}

/** The bytes of one photo of the draft, for its own thumbnail — null for anyone else's file. */
export async function readTradeInDraftPhoto(db: Db, store: BlobStore, token: string | null | undefined, fileId: unknown): Promise<StoredFile | null> {
  const row = await draftFile(db, token, fileId);
  if (!row) return null;
  return getFile(db, store, row.id);
}

/**
 * Deletes draft photos older than `maxAgeSec` that never became part of a request (abandoned wizards), up to 200 per
 * call. Meant for the daily retention job (owner of app/server/jobs.server.ts). Returns how many were removed.
 */
export async function purgeStaleTradeInDrafts(db: Db, store: BlobStore, now: number, maxAgeSec = TRADE_IN_DRAFT_MAX_AGE_SEC): Promise<number> {
  const stale = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.ownerType, DRAFT_OWNER), eq(files.kind, PHOTO_KIND), isNull(files.deletedAt), lt(files.createdAt, now - maxAgeSec * 1000)))
    .orderBy(desc(files.createdAt))
    .limit(200);
  let removed = 0;
  for (const row of stale) if (await deleteFile(db, store, row.id, now)) removed++;
  return removed;
}
