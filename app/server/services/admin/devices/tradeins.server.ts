/**
 * Admin module 13 — the staff side of trade-in (13.03 valuation, 13.04 offer / price difference / validity, 13.08
 * ownership and data wipe, 13.09 customer approval), following the blueprint's workflow "used-device trade-in":
 *
 *   valuation → inspection & ownership → price offer → approval → receipt & data wipe → cost entry → relisting
 *
 *   const page = await listTradeIns(db, actor, parseTradeInFilters(url.searchParams), locale, now);
 *   const ti = await getTradeInDetail(db, actor, "TI-7K4M2Q9X", locale, now, { file, target });
 *   await openCounterTradeIn(db, actor, { phone, deviceModelId | variantId, …, idempotencyKey }, now, storeMode);
 *   await scheduleInspection(db, actor, { tradeInId, day, time }, now);
 *   await recordInspection(db, actor, { tradeInId, templateId, variantId, serial, grade, answers, included, ownershipOk, accountLockOk }, now);
 *   await makeOffer(db, actor, { tradeInId, amountIqd, validDays }, now);                 // the final, human-made quote
 *   await recordAnswer(db, actor, { tradeInId, decision: "accept", payout: "cash" }, now); // the customer, in person
 *   await confirmWipe(db, actor, { tradeInId }, now);                                       // accounts unlinked, data wiped
 *   await payOut(db, actor, { tradeInId, method, locationId }, now);                        // money + the used unit
 *
 * The shopper's side is the storefront's (services/tradein.server.ts: createTradeIn, getTradeInByRef, respondToOffer).
 * This file WRITES the history events the tracking page /trade-in/:ref reads: `inspection_scheduled` (data.at),
 * `inspected`, `offered` (data.amountIqd), `accepted` / `declined` (in person), `paid`, `cancelled`, `expired` — plus
 * staff-internal kinds the shopper never sees (`data_wiped`, `photo`).
 *
 * RULES
 *   · An estimate is never an offer. Only an employee makes the final offer (devices.tradein.offer), after an
 *     inspection with a complete checklist, a grade, the catalogue variant, the serial (serial-tracked devices), and
 *     the ownership and account-lock checks passed (13.08). The database refuses an offer without offered_by,
 *     offered_at and an inspection (TT:TRADE_IN_OFFER_NOT_ALLOWED). An offer is open for 1–30 days; a declined or
 *     expired one can be replaced by a new offer (the history keeps both).
 *   · The customer approves (13.09): online through respondToOffer, or in person — recorded by staff with
 *     `inPerson: true` in the event. The `offered` event snapshots the grade, the checklist result and the guide's
 *     suggestion the offer was made on.
 *   · Payout (devices.tradein.payout) only after the customer accepted AND the data wipe was confirmed
 *     (devices.ownership.verify): store credit for account holders (the wallet core's walletCreditStatement, kind
 *     trade_in_credit, key "tradein:<id>:payout", with postWalletCredit: Dr inventory / Cr wallet liability), or cash
 *     (one journal entry Dr inventory / Cr cash through the core's journalStatements, key "trade_in:<id>:payout") —
 *     the money in ONE batch with the trade-in → paid (guarded on accepted, the amount and the wipe), the registry
 *     serial (new, or a unit the store sold before: its old order link is released and its running warranty ends
 *     "traded_in:<ref>"), the used unit (acquisition cost [P] = the offer, grade, checklist, ownership and wipe facts
 *     copied, price 0 until pricing sets it; "ready" only by the units' own rule) and its inspection photos as
 *     unconfirmed media. A payout that loses a race (another payout, a cancel, the serial entering stock) moves no
 *     money. One payout per trade-in, ever (deterministic keys; a repeat answers `replayed` with the method paid).
 *   · Four eyes on exceptions: an offer above the guide's suggestion, without a guide, or on a guide last changed by
 *     the employee who makes the offer is paid out by an employee other than the one who made it
 *     (`payout_second_person`, 403). The `offered` event keeps the suggestion and the guide's author it was made on.
 *   · 13.08: confirming ownership and the account lock is devices.ownership.verify's; the inspector records the
 *     checklist (a confirmation on file carries over to a re-inspection of the same serial, never to another one).
 *   · A new checklist is filled on the current version of its template (`template_changed` otherwise).
 *   · Cancelling is refused once money went out for the trade-in (`payout_started`).
 *   · Phones masked without customer.phone.read_full; nothing here selects a [P] column for a view.
 *
 * Errors (AppError; texts in admin-devices → errors.*): forbidden, not_found, invalid (fields), trade_in_changed,
 * trade_in_not_open, inspection_required, offer_ownership, offer_account_lock, offer_checklist_incomplete,
 * offer_grade_required, offer_variant_required, offer_serial_required, offer_open, offer_closed, payout_not_accepted,
 * payout_method_required, payout_requires_account, payout_wipe_required, payout_second_person, payout_started,
 * serial_in_stock, serial_in_trade_in, serial_variant_mismatch, variant_not_model, photo_limit, period_closed,
 * plus the wallet's (wallet_requires_account, customer_unavailable, idempotency_mismatch).
 */
import { and, asc, count, desc, eq, inArray, isNull, notInArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId, publicRef } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { normalizeIraqPhone } from "~/lib/phone";
import { actorRef, assertCan, can, canAny, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import {
  cashMovements,
  customers,
  deviceModels,
  files,
  inspectionTemplates,
  journalEntries,
  media,
  orderItemSerials,
  orderItems,
  orders,
  products,
  serials,
  tradeInEvents,
  tradeInPriceGuides,
  tradeIns,
  usedUnits,
  variants,
  walletLedger,
  warranties,
  type IncludedItem,
  type TradeIn,
  type TradeInInspection,
  type UsedChecklist,
  type UsedGrade,
  type UsedUnitStatus,
} from "~/server/db/schema";
import { expectChanged, expectThat, isUniqueViolation, mapDbError, runBatch } from "~/server/db/tx.server";
import { AppError, forbidden, invalid, notFound, toAppError, zodFieldErrors } from "~/server/errors";
import { cleanBlock, cleanLine } from "~/server/text.server";
import { getSetting } from "~/server/settings.server";
import { journalStatements, mapPostingError, postedBy, postWalletCredit } from "~/server/services/accounting/post.server";
import { releaseSoldSerialStatements } from "~/server/services/inventory/stock.server";
import { normalizeTradeInRef } from "~/server/services/tradein.server";
import { walletCreditStatement } from "~/server/services/wallet.server";
import {
  DAY_MS,
  ID,
  PAGE_SIZE,
  accessoriesOf,
  activeTemplates,
  assertUnitLocation,
  baghdadInstant,
  buildChecklist,
  checklistView,
  employeeNames,
  inspectionKindFor,
  l10nOf,
  likePattern,
  parseJson,
  phoneView,
  templateById,
  unitBranchWhere,
  unitLocations,
  variantLabel,
  type ChecklistAnswers,
} from "./shared.server";
import { settledStatus } from "./used.server";
import {
  CANCELLABLE,
  GRADE_LIST,
  INSPECTABLE,
  MAX_OFFER_IQD,
  MAX_TRADE_IN_PHOTOS,
  OFFERABLE,
  OFFER_STEP_IQD,
  OFFER_VALID_DAYS,
  PAYOUT_LIST,
  SCHEDULE_DAYS_AHEAD,
  TRADE_IN_OPEN,
  TRADE_IN_VIEW_STATUSES,
  latinDigits,
  type HistoryEntry,
  type Payout,
  type PriceDifference,
  type QueueCounts,
  type ReferencePrice,
  type TradeInDetail,
  type TradeInFilters,
  type TradeInListRow,
  type TradeInPage,
  type TradeInPhoto,
  type TradeInStatusKey,
  type Valuation,
  type VariantChoice,
} from "./types";

export const TRADE_IN_ADMIN_ERROR_KEYS = [
  "trade_in_changed",
  "trade_in_not_open",
  "inspection_required",
  "offer_ownership",
  "offer_account_lock",
  "offer_checklist_incomplete",
  "offer_grade_required",
  "offer_variant_required",
  "offer_serial_required",
  "offer_open",
  "offer_closed",
  "payout_not_accepted",
  "payout_method_required",
  "payout_requires_account",
  "payout_wipe_required",
  "payout_second_person",
  "payout_started",
  "serial_in_stock",
  "serial_in_trade_in",
  "serial_variant_mismatch",
  "variant_not_model",
  "photo_limit",
] as const;

/** Kinds of private files of a trade-in: the shopper's photos (storefront) and the inspector's. */
export const CUSTOMER_PHOTO_KIND = "trade_in_photo";
export const INSPECTION_PHOTO_KIND = "trade_in_inspection";

const READERS = ["devices.tradein.read", "devices.tradein.inspect", "devices.tradein.offer", "devices.tradein.payout"] as const;

function assertReader(actor: Actor): void {
  if (!canAny(actor, READERS)) throw forbidden("devices.tradein.read");
}

const blank = (value: unknown) => (value === "" || value === null ? undefined : value);
const text = (max: number, multiline = false) =>
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
const reasonText = z.string({ error: "required" }).overwrite(cleanBlock).trim().min(3, "reason_short").max(500, "too_long");
const idField = z.string({ error: "required" }).trim().regex(ID, "invalid");
const formInt = (value: unknown) => {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return value;
  const digits = latinDigits(value).replace(/[,\s٬،]/g, "");
  if (digits === "") return undefined;
  return /^\d{1,13}$/.test(digits) ? Number(digits) : Number.NaN;
};
const parse = <T extends z.ZodType>(schema: T, raw: unknown, detail: string): z.output<T> => {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), detail);
  return parsed.data;
};

/** "s01f 4k2 " → "S01F4K2"; null when it cannot be a serial number. */
export function normalizeSerial(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = latinDigits(raw).toUpperCase().replace(/\s+/g, "");
  return /^[A-Z0-9][A-Z0-9\-_/.]{2,63}$/.test(value) ? value : null;
}

type Inspection = TradeInInspection & { serial?: string | null; included?: string[]; batteryPct?: number | null; ownershipAt?: number | null; ownershipBy?: string | null };

async function tradeInById(db: Db, id: string): Promise<TradeIn> {
  const row = ID.test(id) ? await db.select().from(tradeIns).where(eq(tradeIns.id, id)).get() : undefined;
  if (!row) throw notFound("trade_in");
  return row;
}

export async function tradeInByRef(db: Db, ref: string): Promise<TradeIn> {
  const normalized = normalizeTradeInRef(ref);
  const row = normalized ? await db.select().from(tradeIns).where(eq(tradeIns.ref, normalized)).get() : undefined;
  if (!row) throw notFound("trade_in");
  return row;
}

const offerExpired = (row: Pick<TradeIn, "status" | "offerExpiresAt">, now: number) => row.status === "offered" && row.offerExpiresAt !== null && row.offerExpiresAt <= now;

function eventRow(tradeInId: string, kind: string, data: Record<string, unknown>, actor: Actor, at: number) {
  const { actorKind, actorId } = actorRef(actor);
  return { id: newId("tie"), tradeInId, kind, data, actorKind, actorId, at };
}

/** A failure from a batch as the AppError it means (guards → trade_in_changed, a closed month → period_closed). */
function settle(error: unknown, fallback = "trade_in_changed"): never {
  const posting = mapPostingError(error);
  if (posting) throw posting;
  const app = toAppError(error);
  if (app && (app.code === "no_rows_changed" || app.code === "guard_failed" || app.code.endsWith("_changed"))) throw new AppError(fallback, 409, { cause: error });
  throw app ?? error;
}

// ───────────────────────────────────────────────────────────────── list and queues

function baghdadDayStart(day: string): number {
  return Date.parse(`${day}T00:00:00Z`) - 3 * 3_600_000;
}

const pastValidity = (now: number) => and(eq(tradeIns.status, "offered"), sql`${tradeIns.offerExpiresAt} <= ${now}`);

/**
 * The rows of a saved view at `now` — for the list AND its queue count (one definition, so they always agree): an offer
 * past its date belongs to "inspected" (waiting for a new offer) even before the expiry job records it, and "offered"
 * holds only offers still open.
 */
export function viewWhere(view: Exclude<TradeInFilters["view"], "all">, now: number): SQL {
  const statuses = inArray(tradeIns.status, [...TRADE_IN_VIEW_STATUSES[view]]);
  if (view === "inspected") return or(statuses, pastValidity(now)) as SQL;
  if (view === "offered") return and(statuses, sql`(${tradeIns.offerExpiresAt} IS NULL OR ${tradeIns.offerExpiresAt} > ${now})`) as SQL;
  return statuses;
}

export async function listTradeIns(db: Db, actor: Actor, filters: TradeInFilters, locale: Locale, now: number): Promise<TradeInPage> {
  assertReader(actor);
  const where: SQL[] = [];
  // "to_pay": what THIS employee can move on (payoutsWhere — the "to pay" card's own count); nothing without the
  // payout or the verify permission
  if (filters.view === "to_pay") where.push(payoutsWhere(actor, now) ?? sql`0 = 1`);
  else if (filters.view !== "all") where.push(viewWhere(filters.view, now));
  if (filters.status) where.push(eq(tradeIns.status, filters.status));
  if (filters.from) where.push(sql`${tradeIns.createdAt} >= ${baghdadDayStart(filters.from)}`);
  if (filters.to) where.push(sql`${tradeIns.createdAt} < ${baghdadDayStart(filters.to) + DAY_MS}`);
  if (filters.q) {
    const ref = normalizeTradeInRef(filters.q);
    const phone = normalizeIraqPhone(filters.q);
    const digits = latinDigits(filters.q).replace(/\D/g, "");
    const parts: SQL[] = [];
    if (ref) parts.push(eq(tradeIns.ref, ref));
    else parts.push(sql`${tradeIns.ref} LIKE ${likePattern(filters.q.toUpperCase())} ESCAPE '\\'`);
    if (phone) parts.push(eq(tradeIns.phoneE164, phone));
    else if (digits.length >= 4 && can(actor, "customer.phone.read_full")) parts.push(sql`${tradeIns.phoneE164} LIKE ${likePattern(digits.replace(/^0/, ""))} ESCAPE '\\'`);
    parts.push(sql`${tradeIns.contactName} LIKE ${likePattern(filters.q)} ESCAPE '\\'`);
    where.push(or(...parts) as SQL);
  }
  const condition = where.length ? and(...where) : undefined;
  const [rows, totals] = await Promise.all([
    db
      .select({
        id: tradeIns.id,
        ref: tradeIns.ref,
        status: tradeIns.status,
        createdAt: tradeIns.createdAt,
        contactName: tradeIns.contactName,
        phone: tradeIns.phoneE164,
        estimateMin: tradeIns.estimateMinIqd,
        estimateMax: tradeIns.estimateMaxIqd,
        offer: tradeIns.finalOfferIqd,
        offerExpiresAt: tradeIns.offerExpiresAt,
        inspectionAt: tradeIns.inspectionScheduledAt,
        isDemo: tradeIns.isDemo,
        deviceText: tradeIns.deviceText,
        modelName: deviceModels.name,
        productName: products.name,
        variantTitle: variants.title,
        counter: sql<number>`EXISTS (SELECT 1 FROM trade_in_events AS e WHERE e.trade_in_id = ${tradeIns.id} AND e.kind = 'submitted' AND e.actor_kind = 'employee')`,
      })
      .from(tradeIns)
      .leftJoin(deviceModels, eq(deviceModels.id, tradeIns.deviceModelId))
      .leftJoin(variants, eq(variants.id, tradeIns.variantId))
      .leftJoin(products, eq(products.id, variants.productId))
      .where(condition)
      .orderBy(desc(tradeIns.createdAt), desc(tradeIns.id))
      .limit(PAGE_SIZE)
      .offset((filters.page - 1) * PAGE_SIZE),
    db.select({ n: count() }).from(tradeIns).where(condition),
  ]);
  const total = Number(totals[0]?.n ?? 0);
  const money = seesTradeInMoney(actor);
  return {
    rows: rows.map(
      (row): TradeInListRow => ({
        id: row.id,
        ref: row.ref,
        status: row.status,
        offerExpired: offerExpired({ status: row.status, offerExpiresAt: row.offerExpiresAt }, now),
        createdAt: row.createdAt,
        device: row.productName ? variantLabel(row.productName, row.variantTitle, locale) : pick(row.modelName, locale) || row.deviceText || "—",
        contactName: row.contactName,
        phone: phoneView(actor, row.phone),
        estimate: row.estimateMin !== null && row.estimateMax !== null ? { minIqd: row.estimateMin, maxIqd: row.estimateMax } : null,
        offerIqd: money ? row.offer : null,
        offerExpiresAt: row.offerExpiresAt,
        inspectionAt: row.inspectionAt,
        counter: Number(row.counter) === 1,
        isDemo: row.isDemo,
      }),
    ),
    total,
    page: filters.page,
    pageCount: Math.max(1, Math.ceil(total / PAGE_SIZE)),
  };
}

/**
 * The accepted trade-ins (the list's "to_pay" view; "accepted" holds them all) THIS employee can move on, by the trade-in page's own rules: the
 * data wipe with devices.ownership.verify while it is not confirmed; the payout with devices.tradein.payout once it is
 * — never their own offer that only a second person may pay (payoutNeedsSecond: above the guide's suggestion, no
 * suggestion, or a guide they set themselves; payOut refuses it, payout_second_person). Null when the employee holds
 * neither permission. Follow-up 2026-11-12: `toPay` counted every accepted trade-in for anyone with either permission —
 * a wipe they cannot confirm, a payout before the wipe, their own offer. The shell's bell had its own copy of this
 * rule (shell/queues.server.ts payoutsWhere); this is the module's, for both to share.
 */
export function payoutsWhere(actor: Actor, now: number): SQL | null {
  const wipes = can(actor, "devices.ownership.verify");
  const pays = can(actor, "devices.tradein.payout");
  if (!wipes && !pays) return null;
  const me = actor.kind === "employee" ? actor.id : "";
  const ownOfferForASecondPayer = sql`(${tradeIns.offeredBy} = ${me} AND ${tradeIns.finalOfferIqd} IS NOT NULL AND coalesce((
      SELECT CASE
        WHEN json_extract(e.data, '$.guideBy') = ${tradeIns.offeredBy} THEN 1
        WHEN json_type(e.data, '$.suggestedIqd') IS NOT 'integer' THEN 1
        WHEN ${tradeIns.finalOfferIqd} > json_extract(e.data, '$.suggestedIqd') THEN 1
        ELSE 0
      END
      FROM trade_in_events AS e WHERE e.trade_in_id = ${tradeIns.id} AND e.kind = 'offered' ORDER BY e.at DESC, e.id DESC LIMIT 1), 1) = 1)`;
  const steps: SQL[] = [];
  if (wipes) steps.push(sql`coalesce(${tradeIns.dataWiped}, 0) = 0`);
  if (pays) steps.push(sql`(${tradeIns.dataWiped} = 1 AND NOT ${ownOfferForASecondPayer})`);
  return and(viewWhere("accepted", now), or(...steps)) as SQL;
}

/** What waits in the module for this employee (each null when they may not act on it). */
export async function deviceQueueCounts(db: Db, actor: Actor, now: number): Promise<QueueCounts> {
  const one = async (where: SQL | undefined) => Number((await db.select({ n: count() }).from(tradeIns).where(where).get())?.n ?? 0);
  // Units: what the employee's own list shows (an employee limited to a branch: that branch's units).
  const units = async (statuses: UsedUnitStatus[]) => Number((await db.select({ n: count() }).from(usedUnits).where(and(inArray(usedUnits.status, statuses), unitBranchWhere(actor))).get())?.n ?? 0);
  // Each count is its card's list (index.tsx links: ?view=new, inspected, offered, to_pay) — the same viewWhere;
  // `toPay` only what this employee can move on (payoutsWhere, which the list's "to_pay" view applies too).
  const payouts = payoutsWhere(actor, now);
  const [toInspect, toOffer, awaitingAnswer, toPay, unitsToInspect, toList] = await Promise.all([
    can(actor, "devices.tradein.inspect") ? one(viewWhere("new", now)) : null,
    can(actor, "devices.tradein.offer") ? one(viewWhere("inspected", now)) : null,
    canAny(actor, READERS) ? one(viewWhere("offered", now)) : null,
    payouts ? one(payouts) : null,
    can(actor, "devices.used.inspect") ? units(["intake", "testing", "returned"]) : null,
    can(actor, "devices.used.list") ? units(["ready"]) : null,
  ]);
  return { toInspect, toOffer, awaitingAnswer, toPay, unitsToInspect, toList };
}

// ───────────────────────────────────────────────────────────────── valuation (13.03)

type GuideRow = { id: string; baseIqd: number; multipliers: Partial<Record<UsedGrade, number>>; deductions: Record<string, number>; updatedAt: number; updatedBy?: string | null };

/** The guide that prices a device: an active guide for the exact variant first, else the model's active model-wide guide. */
export async function guideFor(db: Db, modelId: string | null, variantId: string | null): Promise<GuideRow | null> {
  if (!modelId) return null;
  const rows = await db
    .select({ id: tradeInPriceGuides.id, variantId: tradeInPriceGuides.variantId, baseIqd: tradeInPriceGuides.baseIqd, multipliers: tradeInPriceGuides.gradeMultipliers, deductions: tradeInPriceGuides.deductions, updatedAt: tradeInPriceGuides.updatedAt, updatedBy: tradeInPriceGuides.updatedBy })
    .from(tradeInPriceGuides)
    .where(and(eq(tradeInPriceGuides.deviceModelId, modelId), eq(tradeInPriceGuides.isActive, true)))
    .orderBy(desc(tradeInPriceGuides.updatedAt), desc(tradeInPriceGuides.id));
  const exact = variantId ? rows.find((row) => row.variantId === variantId) : undefined;
  const wide = rows.find((row) => row.variantId === null);
  const row = exact ?? wide;
  return row ? { id: row.id, baseIqd: row.baseIqd, multipliers: row.multipliers ?? {}, deductions: row.deductions ?? {}, updatedAt: row.updatedAt, updatedBy: row.updatedBy ?? null } : null;
}

const isBps = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 20_000;

/**
 * What the guide says a unit is worth (pure): the grade's share of the base price, less a deduction for each accessory
 * that did not come with it, rounded DOWN to whole thousands. Null suggestion when the guide has no multiplier for the
 * grade. Never an offer: a person decides the offer.
 */
export function valuationOf(guide: GuideRow, grade: UsedGrade, included: readonly string[]): Valuation {
  const bps = guide.multipliers[grade];
  const gradeValueIqd = isBps(bps) ? Math.floor((guide.baseIqd * bps) / 10_000) : null;
  const deductions = accessoriesOf(guide.deductions)
    .filter((key) => !included.includes(key))
    .map((key) => ({ key, amountIqd: Number.isSafeInteger(guide.deductions[`missing_${key}`]) ? Math.max(0, guide.deductions[`missing_${key}`]) : 0 }))
    .filter((line) => line.amountIqd > 0);
  const suggestedIqd = gradeValueIqd === null ? null : Math.max(0, Math.floor((gradeValueIqd - deductions.reduce((sum, line) => sum + line.amountIqd, 0)) / OFFER_STEP_IQD) * OFFER_STEP_IQD);
  return { guideId: guide.id, guideUpdatedAt: guide.updatedAt, baseIqd: guide.baseIqd, grade, multiplierBps: isBps(bps) ? bps : null, gradeValueIqd, deductions, suggestedIqd };
}

/** Reference market prices from the store's own catalogue: the variant(s) new, and used units of the model sold or on sale. */
async function referencePrices(db: Db, modelId: string | null, variantId: string | null, locale: Locale): Promise<ReferencePrice[]> {
  const out: ReferencePrice[] = [];
  const newRows = variantId
    ? await db.select({ sku: variants.sku, price: variants.priceIqd, title: variants.title, name: products.name, slug: products.slug, status: products.status }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.id, variantId)).limit(1)
    : modelId
      ? await db
          .select({ sku: variants.sku, price: variants.priceIqd, title: variants.title, name: products.name, slug: products.slug, status: products.status })
          .from(variants)
          .innerJoin(products, eq(products.id, variants.productId))
          .where(and(eq(products.deviceModelId, modelId), eq(variants.isActive, true), inArray(products.kind, ["console"])))
          .orderBy(asc(variants.sort))
          .limit(4)
      : [];
  for (const row of newRows) if (row.price > 0) out.push({ kind: "new", label: variantLabel(row.name, row.title, locale), sku: row.sku, priceIqd: row.price, href: null });
  const usedWhere = variantId ? eq(usedUnits.variantId, variantId) : modelId ? eq(products.deviceModelId, modelId) : undefined;
  if (usedWhere) {
    const used = await db
      .select({ id: usedUnits.id, grade: usedUnits.grade, price: usedUnits.priceIqd, sku: variants.sku, title: variants.title, name: products.name })
      .from(usedUnits)
      .innerJoin(variants, eq(variants.id, usedUnits.variantId))
      .innerJoin(products, eq(products.id, variants.productId))
      .where(and(usedWhere, inArray(usedUnits.status, ["listed", "reserved", "sold"]), sql`${usedUnits.priceIqd} > 0`))
      .orderBy(desc(usedUnits.updatedAt))
      .limit(5);
    for (const row of used) out.push({ kind: "used", label: `${variantLabel(row.name, row.title, locale)} · ${row.grade}`, sku: row.sku, priceIqd: row.price, href: `/admin/devices/used/${row.id}` });
  }
  return out;
}

/** The variants a trade-in's device can be (the model's catalogue variants, or the product of the variant it names). */
async function variantChoices(db: Db, modelId: string | null, variantId: string | null, locale: Locale): Promise<VariantChoice[]> {
  let where: SQL | undefined;
  if (variantId) {
    const product = await db.select({ productId: variants.productId }).from(variants).where(eq(variants.id, variantId)).get();
    where = product ? eq(variants.productId, product.productId) : eq(variants.id, variantId);
  } else if (modelId) where = eq(products.deviceModelId, modelId);
  if (!where) return [];
  const rows = await db
    .select({ id: variants.id, sku: variants.sku, title: variants.title, name: products.name, trackSerials: variants.trackSerials, price: variants.priceIqd, kind: products.kind })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(where, notInArray(products.kind, ["bundle", "digital"])))
    .orderBy(asc(products.slug), asc(variants.sort), asc(variants.sku))
    .limit(60);
  return rows.map((row) => ({ id: row.id, sku: row.sku, label: variantLabel(row.name, row.title, locale), trackSerials: row.trackSerials, priceIqd: row.price }));
}

// ───────────────────────────────────────────────────────────────── the detail page

export type DetailUrls = { file: (fileId: string) => string; target?: string | null };

/** The device's kind for the checklist: the variant's product, else the model. */
async function deviceKindOf(db: Db, row: Pick<TradeIn, "deviceModelId" | "variantId">) {
  const variant = row.variantId
    ? await db.select({ kind: products.kind, modelId: products.deviceModelId, trackSerials: variants.trackSerials }).from(variants).innerJoin(products, eq(products.id, variants.productId)).where(eq(variants.id, row.variantId)).get()
    : undefined;
  const modelId = row.deviceModelId ?? variant?.modelId ?? null;
  const model = modelId ? await db.select({ id: deviceModels.id, name: deviceModels.name, kind: deviceModels.deviceKind }).from(deviceModels).where(eq(deviceModels.id, modelId)).get() : undefined;
  return { kind: inspectionKindFor({ productKind: variant?.kind, deviceKind: model?.kind }), model: model ?? null, trackSerials: variant?.trackSerials ?? null };
}

async function photosOf(db: Db, tradeInId: string, url: (fileId: string) => string): Promise<TradeInPhoto[]> {
  const rows = await db
    .select({ id: files.id, kind: files.kind, width: files.width, height: files.height, createdAt: files.createdAt, visibility: files.visibility, storageKey: files.storageKey })
    .from(files)
    .where(and(eq(files.ownerType, "trade_in"), eq(files.ownerId, tradeInId), inArray(files.kind, [CUSTOMER_PHOTO_KIND, INSPECTION_PHOTO_KIND]), isNull(files.deletedAt)))
    .orderBy(asc(files.createdAt), asc(files.id));
  // An inspection photo published with the used unit it shows is served by /media like every public file (the
  // module's private-file route answers 404 for public files).
  return rows.map((row) => ({
    id: row.id,
    url: row.visibility === "public" && row.storageKey ? `/media/${encodeURIComponent(row.storageKey)}` : url(row.id),
    kind: row.kind === INSPECTION_PHOTO_KIND ? "inspection" : "customer",
    width: row.width,
    height: row.height,
    createdAt: row.createdAt,
  }));
}

/**
 * Whether this employee sees a trade-in's money: the offer, the guide's valuation and reference prices, the price
 * difference, the amounts in its history. A paid offer IS the used unit's purchase cost (payOut: costIqd = the offer),
 * so — like every cost figure — it is for cost.read, and for the people who work the money (devices.tradein.offer,
 * devices.tradein.payout). Follow-up 2026-11-12: support staff (devices.tradein.read) saw every offer. The customer's
 * own estimate (what the storefront told them) stays visible.
 */
export function seesTradeInMoney(actor: Actor): boolean {
  return can(actor, "cost.read") || canAny(actor, ["devices.tradein.offer", "devices.tradein.payout"]);
}

/** Money keys of the trade-in events (makeOffer, recordAnswer, payOut, expiry) — dropped for those who do not see money. */
const HISTORY_MONEY_KEYS = ["amountIqd", "suggestedIqd", "guideBaseIqd"] as const;

/** A detail without its money (seesTradeInMoney false): amounts null or empty, history amounts marked hidden. */
function withoutMoney(detail: TradeInDetail): TradeInDetail {
  return {
    ...detail,
    money: false,
    offer: detail.offer ? { ...detail.offer, amountIqd: null } : null,
    valuation: null,
    references: [],
    difference: null,
    history: detail.history.map((entry) => {
      if (!HISTORY_MONEY_KEYS.some((key) => key in entry.data)) return entry;
      const data: Record<string, unknown> = { ...entry.data, amountHidden: true };
      for (const key of HISTORY_MONEY_KEYS) delete data[key];
      return { ...entry, data };
    }),
  };
}

async function historyOf(db: Db, tradeInId: string): Promise<HistoryEntry[]> {
  const events = await db.select().from(tradeInEvents).where(eq(tradeInEvents.tradeInId, tradeInId)).orderBy(asc(tradeInEvents.at), asc(tradeInEvents.id));
  const names = await employeeNames(db, events.filter((event) => event.actorKind === "employee").map((event) => event.actorId));
  return events.map((event) => ({ id: event.id, kind: event.kind, at: event.at, actorKind: event.actorKind, actor: event.actorKind === "employee" && event.actorId ? (names.get(event.actorId) ?? null) : null, data: event.data ?? {} }));
}

/** The latest `offered` event: what the offer was made on (grade, the guide's suggestion and who last set that guide). */
async function lastOfferEvent(db: Db, tradeInId: string): Promise<{ suggestedIqd: number | null; amountIqd: number | null; actorId: string | null; guideBy: string | null } | null> {
  const row = await db
    .select({ data: tradeInEvents.data, actorId: tradeInEvents.actorId })
    .from(tradeInEvents)
    .where(and(eq(tradeInEvents.tradeInId, tradeInId), eq(tradeInEvents.kind, "offered")))
    .orderBy(desc(tradeInEvents.at), desc(tradeInEvents.id))
    .get();
  if (!row) return null;
  const data = row.data ?? {};
  return {
    suggestedIqd: Number.isSafeInteger(data.suggestedIqd) ? (data.suggestedIqd as number) : null,
    amountIqd: Number.isSafeInteger(data.amountIqd) ? (data.amountIqd as number) : null,
    actorId: row.actorId,
    guideBy: typeof data.guideBy === "string" && data.guideBy ? data.guideBy : null,
  };
}

/**
 * The payout is another employee's (four eyes on exceptions) when the offer is above the guide's suggestion, when
 * there is no guide at all — or when the guide was last set by the employee who made the offer: a suggestion the
 * offerer wrote themselves is no independent check.
 */
export const payoutNeedsSecond = (offerIqd: number | null, suggestedIqd: number | null, guideSetByOfferer = false) => offerIqd !== null && (guideSetByOfferer || suggestedIqd === null || offerIqd > suggestedIqd);

/** Did the employee who made the offer also last set the guide it was valued on? */
const guideSetByOfferer = (lastOffer: { guideBy: string | null } | null, offeredBy: string | null) => Boolean(lastOffer?.guideBy && offeredBy && lastOffer.guideBy === offeredBy);

async function serialOrigin(db: Db, serial: string | null) {
  if (!serial) return null;
  const row = await db
    .select({ id: serials.id, status: serials.status, variantId: serials.variantId })
    .from(serials)
    .where(sql`upper(replace(${serials.serial}, ' ', '')) = ${serial}`)
    .get();
  if (!row) return null;
  const [order, warranty] = await Promise.all([
    db
      .select({ ref: orders.ref })
      .from(orderItemSerials)
      .innerJoin(orderItems, eq(orderItems.id, orderItemSerials.orderItemId))
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orderItemSerials.serialId, row.id), isNull(orderItemSerials.releasedAt)))
      .get(),
    db.select({ endsAt: warranties.endsAt }).from(warranties).where(and(eq(warranties.serialId, row.id), eq(warranties.status, "active"))).orderBy(desc(warranties.endsAt)).get(),
  ]);
  return { id: row.id, status: row.status, variantId: row.variantId, orderRef: order?.ref ?? null, warrantyEndsAt: warranty?.endsAt ?? null };
}

/** The target of a price-difference estimate: a SKU or barcode of a new product, or a used unit's slug. */
async function differenceTarget(db: Db, target: string, locale: Locale): Promise<PriceDifference["target"] | null> {
  const code = latinDigits(target).trim();
  if (!code || code.length > 80) return null;
  const variant = await db
    .select({ sku: variants.sku, price: variants.priceIqd, title: variants.title, name: products.name })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(or(sql`upper(${variants.sku}) = ${code.toUpperCase()}`, eq(variants.barcode, code)))
    .get();
  if (variant && variant.price > 0) return { kind: "new", label: variantLabel(variant.name, variant.title, locale), sku: variant.sku, priceIqd: variant.price };
  const unit = await db
    .select({ slug: usedUnits.slug, price: usedUnits.priceIqd, grade: usedUnits.grade, sku: variants.sku, title: variants.title, name: products.name })
    .from(usedUnits)
    .innerJoin(variants, eq(variants.id, usedUnits.variantId))
    .innerJoin(products, eq(products.id, variants.productId))
    .where(and(eq(usedUnits.slug, code.toLowerCase()), inArray(usedUnits.status, ["ready", "listed"])))
    .get();
  if (unit && unit.price > 0) return { kind: "used", label: `${variantLabel(unit.name, unit.title, locale)} · ${unit.grade}`, sku: unit.sku, priceIqd: unit.price };
  return null;
}

/** The price difference (13.04): what the customer would still pay for `target` after the trade-in value (negative = credit left). */
export function priceDifference(target: PriceDifference["target"], offerIqd: number): PriceDifference {
  const differenceIqd = target.priceIqd - offerIqd;
  return { target, offerIqd, differenceIqd, covered: differenceIqd <= 0 };
}

export async function getTradeInDetail(db: Db, actor: Actor, ref: string, locale: Locale, now: number, urls: DetailUrls): Promise<TradeInDetail> {
  assertReader(actor);
  const row = await tradeInByRef(db, ref);
  const inspection = (row.inspection ?? null) as Inspection | null;
  const device = await deviceKindOf(db, row);
  const variant = row.variantId
    ? await db
        .select({ id: variants.id, sku: variants.sku, title: variants.title, name: products.name, trackSerials: variants.trackSerials, price: variants.priceIqd })
        .from(variants)
        .innerJoin(products, eq(products.id, variants.productId))
        .where(eq(variants.id, row.variantId))
        .get()
    : undefined;
  const [customer, unit, photos, history, templates, locations, guide, choices, origin, lastOffer] = await Promise.all([
    row.customerId ? db.select({ id: customers.id, name: customers.name, status: customers.status }).from(customers).where(eq(customers.id, row.customerId)).get() : Promise.resolve(undefined),
    db.select({ id: usedUnits.id, slug: usedUnits.slug, status: usedUnits.status }).from(usedUnits).where(eq(usedUnits.tradeInId, row.id)).get(),
    photosOf(db, row.id, urls.file),
    historyOf(db, row.id),
    activeTemplates(db, locale),
    unitLocations(db, actor),
    guideFor(db, device.model?.id ?? null, row.variantId),
    variantChoices(db, device.model?.id ?? null, row.variantId, locale),
    serialOrigin(db, inspection?.serial ?? null),
    lastOfferEvent(db, row.id),
  ]);
  // the payer's till drawer, offered for a cash payout (only while one is to be made)
  const drawer = row.status === "accepted" && can(actor, "devices.tradein.payout") ? await drawerOf(db, actor) : null;
  const template = inspection?.checklist?.templateId ? await templateById(db, inspection.checklist.templateId) : null;
  const fallbackTemplate = templates.find((entry) => entry.kind === device.kind) ?? null;
  const checklist = checklistView(template ?? fallbackTemplate, inspection?.checklist ?? null, locale, device.kind);
  const submitted = history.find((entry) => entry.kind === "submitted")?.data ?? {};
  const counter = history.some((entry) => entry.kind === "submitted" && entry.actorKind === "employee");
  const answers: Record<string, string> = {};
  for (const [key, value] of Object.entries((row.answers ?? {}) as Record<string, unknown>)) if (typeof value === "string" && value) answers[key] = value;
  const included = inspection?.included ?? [];
  const valuation = guide && inspection?.grade ? valuationOf(guide, inspection.grade, included) : null;
  const target = urls.target ? await differenceTarget(db, urls.target, locale) : null;
  const value = row.finalOfferIqd ?? valuation?.suggestedIqd ?? null;
  const expired = offerExpired(row, now);
  const status = row.status;
  const open = (TRADE_IN_OPEN as readonly string[]).includes(status);
  const hasAccount = Boolean(customer && customer.status !== "merged" && customer.status !== "deleted");

  const offerBlockers: string[] = [];
  if (!inspection) offerBlockers.push("inspection_required");
  else {
    if (!inspection.grade) offerBlockers.push("offer_grade_required");
    if (!row.variantId) offerBlockers.push("offer_variant_required");
    if (device.trackSerials && !inspection.serial) offerBlockers.push("offer_serial_required");
    if (checklist.missing.length > 0 || !inspection.checklist?.completedAt) offerBlockers.push("offer_checklist_incomplete");
    if (row.ownershipOk !== true) offerBlockers.push("offer_ownership");
    if (row.accountLockOk !== true) offerBlockers.push("offer_account_lock");
  }
  const needsSecond = payoutNeedsSecond(row.finalOfferIqd, lastOffer?.suggestedIqd ?? null, guideSetByOfferer(lastOffer, row.offeredBy));
  const ownOffer = actor.kind === "employee" && row.offeredBy === actor.id;
  /** The guide that values this device was last set by this employee: an offer they make on it needs a second payer. */
  const ownGuide = Boolean(guide?.updatedBy && actor.kind === "employee" && guide.updatedBy === actor.id);
  const payoutBlockers: string[] = [];
  if (status === "accepted") {
    if (!row.payoutMethod) payoutBlockers.push("payout_method_required");
    if (!row.dataWiped) payoutBlockers.push("payout_wipe_required");
    if (needsSecond && ownOffer) payoutBlockers.push("payout_second_person");
    if (locations.length === 0) payoutBlockers.push("location_invalid");
  }

  const detail: TradeInDetail = {
    id: row.id,
    ref: row.ref,
    status,
    money: true,
    drawer,
    offerExpired: expired,
    isDemo: row.isDemo,
    counter,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    locale: row.locale ?? null,
    customer: { id: row.customerId, name: row.contactName ?? customer?.name ?? null, phone: phoneView(actor, row.phoneE164), hasAccount },
    device: {
      modelId: device.model?.id ?? null,
      modelName: device.model ? pick(device.model.name, locale) : null,
      kind: device.kind,
      text: row.deviceText,
      variant: variant ? { id: variant.id, sku: variant.sku, label: variantLabel(variant.name, variant.title, locale), trackSerials: variant.trackSerials, priceIqd: variant.price } : null,
    },
    answers,
    preferred:
      typeof submitted.preferredDay === "string" || typeof submitted.preferredWindow === "string" || typeof submitted.notes === "string"
        ? { day: typeof submitted.preferredDay === "string" ? submitted.preferredDay : null, window: typeof submitted.preferredWindow === "string" ? submitted.preferredWindow : null, notes: typeof submitted.notes === "string" ? submitted.notes : null }
        : null,
    estimate: row.estimateMinIqd !== null && row.estimateMaxIqd !== null ? { minIqd: row.estimateMinIqd, maxIqd: row.estimateMaxIqd, expiresAt: row.estimateExpiresAt } : null,
    inspectionAt: row.inspectionScheduledAt,
    inspection: inspection
      ? {
          serial: inspection.serial ?? null,
          grade: inspection.grade ?? null,
          notes: inspection.notes ?? null,
          included,
          batteryPct: inspection.batteryPct ?? null,
          inspectedAt: inspection.inspectedAt ?? null,
          inspectedBy: inspection.inspectedBy ? ((await employeeNames(db, [inspection.inspectedBy])).get(inspection.inspectedBy) ?? null) : null,
          checklist,
        }
      : null,
    ownershipOk: row.ownershipOk,
    accountLockOk: row.accountLockOk,
    dataWiped: row.dataWiped === true,
    offer: row.finalOfferIqd !== null ? { amountIqd: row.finalOfferIqd, expiresAt: row.offerExpiresAt, offeredAt: row.offeredAt, offeredBy: row.offeredBy ? ((await employeeNames(db, [row.offeredBy])).get(row.offeredBy) ?? null) : null } : null,
    payout: { method: row.payoutMethod, paidAt: row.paidAt, ref: row.payoutRef },
    acceptedAt: row.acceptedAt,
    declinedAt: row.declinedAt,
    declineReason: row.declineReason,
    usedUnit: unit ?? null,
    serialOrigin: origin ? { status: origin.status, orderRef: origin.orderRef, warrantyEndsAt: origin.warrantyEndsAt } : null,
    accessories: guide ? accessoriesOf(guide.deductions) : [],
    valuation,
    references: await referencePrices(db, device.model?.id ?? null, row.variantId, locale),
    variants: choices,
    templates,
    checklistForm: checklistView(fallbackTemplate, inspection?.checklist ?? null, locale, device.kind),
    photos,
    history,
    locations,
    difference: target && value !== null ? priceDifference(target, value) : null,
    can: {
      schedule: can(actor, "devices.tradein.inspect") && ["submitted", "estimated", "inspection_scheduled"].includes(status),
      inspect: can(actor, "devices.tradein.inspect") && (INSPECTABLE as readonly string[]).includes(status),
      offer: can(actor, "devices.tradein.offer") && ((OFFERABLE as readonly string[]).includes(status) || expired),
      answer: can(actor, "devices.tradein.offer") && status === "offered" && !expired,
      wipe: can(actor, "devices.ownership.verify") && status === "accepted" && !row.dataWiped,
      payout: can(actor, "devices.tradein.payout") && status === "accepted",
      cancel: open && (CANCELLABLE as readonly string[]).includes(status) && (can(actor, "devices.tradein.offer") || (can(actor, "devices.tradein.inspect") && ["submitted", "estimated", "inspection_scheduled", "inspected"].includes(status))),
      photo: can(actor, "devices.tradein.inspect") && open,
      verify: can(actor, "devices.ownership.verify"),
      payoutNeedsSecond: needsSecond,
      ownOffer,
      ownGuide,
    },
    offerBlockers,
    payoutBlockers,
  };
  return seesTradeInMoney(actor) ? detail : withoutMoney(detail);
}

// ───────────────────────────────────────────────────────────────── a trade-in at the counter

const BASE32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** The id of a counter trade-in made with this form key (a double submit finds the first one). */
export async function counterTradeInId(idempotencyKey: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`tamtam.tradein.counter.v1|${idempotencyKey}`)));
  let out = "";
  for (let i = 0; i < 26; i++) out += BASE32[bytes[i] % 32];
  return `tin_${out}`;
}

export const CounterTradeInInput = z
  .object({
    idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, "invalid"),
    phone: z.string({ error: "required" }).trim().min(1, "required").max(40, "too_long"),
    contactName: text(100),
    deviceModelId: z.preprocess(blank, idField.optional()),
    /** A catalogue SKU or barcode (games, controllers and accessories; also an exact console variant). */
    code: z.preprocess(blank, z.string().trim().max(80, "too_long").optional()),
    notes: text(500, true),
    ownershipDeclared: z.literal(true, { error: "ownership_required" }),
    /**
     * The employee saw that the store account with this number is the customer's own (signed in on their phone). Only
     * then is the trade-in linked to it — a typed number is no proof (follow-up 2026-11-12: any account with the number
     * was linked, so its owner could be paid store credit for someone else's device, and see it in their account).
     */
    accountConfirmed: z.boolean().default(false),
  })
  .refine((input) => Boolean(input.deviceModelId) !== Boolean(input.code), {
    message: "device_required",
    path: ["device"],
    // Checked even when other fields fail, so the form marks every missing field at once.
    when: (payload) => typeof payload.value === "object" && payload.value !== null,
  });

/**
 * A trade-in for a customer who brings a device to the shop (devices.tradein.inspect): the customer's phone (the store
 * account with that number is linked — so store credit is possible — only when the employee confirms the customer
 * showed it is theirs, `accountConfirmed`; otherwise the number stays a contact and the payout is cash), the device as a device model or a catalogue
 * SKU / barcode (games and accessories have no device model), and notes. No estimate: the inspection prices it.
 * Idempotent on the form's key.
 */
export async function openCounterTradeIn(db: Db, actor: Actor, raw: unknown, now: number, storeMode: "demo" | "live"): Promise<{ tradeInId: string; ref: string; replayed: boolean }> {
  assertCan(actor, "devices.tradein.inspect");
  const input = parse(CounterTradeInInput, raw, "tradein.counter");
  const phone = normalizeIraqPhone(input.phone);
  if (!phone) throw invalid({ phone: "phone_invalid" });
  const id = await counterTradeInId(input.idempotencyKey);
  const earlier = await db.select({ ref: tradeIns.ref, phone: tradeIns.phoneE164 }).from(tradeIns).where(eq(tradeIns.id, id)).get();
  if (earlier) {
    if (earlier.phone !== phone) throw new AppError("idempotency_conflict", 409);
    return { tradeInId: id, ref: earlier.ref, replayed: true };
  }
  let deviceModelId: string | null = null;
  let variantId: string | null = null;
  if (input.deviceModelId) {
    const model = await db.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.id, input.deviceModelId)).get();
    if (!model) throw invalid({ deviceModelId: "invalid" });
    deviceModelId = model.id;
  } else if (input.code) {
    const code = latinDigits(input.code).trim();
    const found = await db
      .select({ id: variants.id, modelId: products.deviceModelId, kind: products.kind })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(or(sql`upper(${variants.sku}) = ${code.toUpperCase()}`, eq(variants.barcode, code)))
      .get();
    if (!found || found.kind === "digital" || found.kind === "bundle") throw invalid({ code: "unknown_code" });
    variantId = found.id;
    deviceModelId = found.modelId;
  }
  const customer = input.accountConfirmed ? await db.select({ id: customers.id }).from(customers).where(and(eq(customers.phoneE164, phone), notInArray(customers.status, ["merged", "deleted"]))).get() : undefined;
  if (input.accountConfirmed && !customer) throw invalid({ accountConfirmed: "no_account_for_phone" });
  const attempt = async (ref: string) => {
    await runBatch(db, [
      db
        .insert(tradeIns)
        .values({
          id,
          ref,
          customerId: customer?.id ?? null,
          phoneE164: phone,
          deviceModelId,
          variantId,
          answers: {},
          status: "submitted",
          createdAt: now,
          contactName: input.contactName,
          locale: null,
          isDemo: storeMode === "demo",
          updatedAt: now,
        })
        .onConflictDoNothing({ target: tradeIns.id }),
      expectChanged(db, 1, { code: "NO_ROWS_CHANGED", detail: "trade_ins.id" }),
      db.insert(tradeInEvents).values(eventRow(id, "submitted", { counter: true, notes: input.notes, ownershipDeclared: true, estimate: "inspection" }, actor, now)),
      auditStatement(db, { actor, action: "devices.tradein.open", entityType: "trade_in", entityId: id, summary: ref, after: { deviceModelId, variantId, counter: true, accountLinked: Boolean(customer) }, at: now }),
    ]);
    return { tradeInId: id, ref, replayed: false };
  };
  try {
    return await attempt(publicRef("TI"));
  } catch (error) {
    const winner = await db.select({ ref: tradeIns.ref }).from(tradeIns).where(eq(tradeIns.id, id)).get();
    if (winner) return { tradeInId: id, ref: winner.ref, replayed: true };
    if (isUniqueViolation(error, "trade_ins.ref")) return attempt(publicRef("TI"));
    throw error;
  }
}

// ───────────────────────────────────────────────────────────────── the inspection appointment

export const ScheduleInput = z.object({
  tradeInId: idField,
  day: z.string({ error: "required" }).trim().regex(/^\d{4}-\d{2}-\d{2}$/, "day_invalid"),
  time: z.string({ error: "required" }).trim().regex(/^\d{2}:\d{2}$/, "time_invalid"),
  note: text(300, true),
});

/** Confirms (or moves) the inspection appointment — the tracking page shows it (`inspection_scheduled`, data.at). */
export async function scheduleInspection(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ at: number; replayed: boolean }> {
  assertCan(actor, "devices.tradein.inspect");
  const input = parse(ScheduleInput, { ...(raw as object), day: latinDigits(String((raw as { day?: unknown })?.day ?? "")), time: latinDigits(String((raw as { time?: unknown })?.time ?? "")) }, "tradein.schedule");
  const at = baghdadInstant(input.day, input.time);
  if (at === null) throw invalid({ day: "day_invalid" });
  if (at < now - 30 * 60_000 || at > now + SCHEDULE_DAYS_AHEAD * DAY_MS) throw invalid({ day: "schedule_out_of_range" });
  const row = await tradeInById(db, input.tradeInId);
  if (!["submitted", "estimated", "inspection_scheduled"].includes(row.status)) throw new AppError("trade_in_not_open", 409);
  if (row.status === "inspection_scheduled" && row.inspectionScheduledAt === at) return { at, replayed: true };
  try {
    await runBatch(db, [
      db
        .update(tradeIns)
        .set({ status: "inspection_scheduled", inspectionScheduledAt: at, updatedAt: now })
        .where(and(eq(tradeIns.id, row.id), inArray(tradeIns.status, ["submitted", "estimated", "inspection_scheduled"]), eq(tradeIns.updatedAt, row.updatedAt))),
      expectChanged(db, 1, { code: "TRADE_IN_CHANGED", detail: row.id }),
      db.insert(tradeInEvents).values(eventRow(row.id, "inspection_scheduled", { at, note: input.note, moved: row.inspectionScheduledAt !== null }, actor, now)),
      auditStatement(db, { actor, action: "devices.tradein.schedule", entityType: "trade_in", entityId: row.id, summary: row.ref, before: { at: row.inspectionScheduledAt }, after: { at }, reason: input.note, at: now }),
    ]);
  } catch (error) {
    settle(error);
  }
  return { at, replayed: false };
}

// ───────────────────────────────────────────────────────────────── the inspection (13.02, 13.08, 13.09)

export const InspectionInput = z.object({
  tradeInId: idField,
  templateId: idField,
  variantId: z.preprocess(blank, idField.optional()),
  serial: z.preprocess(blank, z.string().max(80, "too_long").optional()),
  grade: z.preprocess(blank, z.enum(GRADE_LIST, { error: "invalid" }).optional()),
  answers: z.record(z.string(), z.object({ result: z.string().max(10).nullish(), value: z.string().max(400).nullish(), note: z.string().max(400).nullish() })),
  included: z.array(z.string().regex(/^[a-z0-9_]{1,40}$/, "invalid")).max(12, "too_long").default([]),
  /** Ownership proven / the account lock is off. Left out: what is on file stays (for the same serial). */
  ownershipOk: z.boolean().optional(),
  accountLockOk: z.boolean().optional(),
  notes: text(1000, true),
});
export type InspectionInputType = z.input<typeof InspectionInput>;

/**
 * Records what the inspector found with the device in hand (devices.tradein.inspect): the checklist of the device's
 * template (its current version), the grade, the exact catalogue variant, the serial number (scanned; required for
 * serial-tracked variants, refused when the store holds that unit or another open trade-in has it), the accessories
 * that came with it, and the ownership (proof the customer may sell it) and account-lock checks (13.08) — CONFIRMING
 * those is devices.ownership.verify's; a confirmation on file carries over to a re-inspection of the same serial. May
 * be repeated until an offer is out; the latest inspection counts. Writes `inspected` to the history.
 */
export async function recordInspection(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ complete: boolean; status: TradeInStatusKey }> {
  assertCan(actor, "devices.tradein.inspect");
  const input = parse(InspectionInput, raw, "tradein.inspect");
  const row = await tradeInById(db, input.tradeInId);
  if (!(INSPECTABLE as readonly string[]).includes(row.status)) throw new AppError("trade_in_not_open", 409);
  const device = await deviceKindOf(db, row);
  const template = await templateById(db, input.templateId);
  if (!template || template.kind !== device.kind) throw invalid({ templateId: "template_invalid" });
  // A new checklist is filled on the CURRENT version: a switched-off one (fewer or older checks) is a stale page.
  if (!template.isActive) throw invalid({ templateId: "template_changed" });

  // The variant: one of the model's catalogue variants (or of the product a counter trade-in named).
  const variantId = input.variantId ?? row.variantId ?? null;
  let trackSerials = false;
  if (variantId) {
    const variant = await db
      .select({ id: variants.id, productId: variants.productId, modelId: products.deviceModelId, kind: products.kind, trackSerials: variants.trackSerials })
      .from(variants)
      .innerJoin(products, eq(products.id, variants.productId))
      .where(eq(variants.id, variantId))
      .get();
    if (!variant || variant.kind === "digital" || variant.kind === "bundle") throw invalid({ variantId: "invalid" });
    if (row.deviceModelId && variant.modelId !== row.deviceModelId) throw invalid({ variantId: "variant_not_model" });
    if (!row.deviceModelId && row.variantId && row.variantId !== variant.id) {
      const named = await db.select({ productId: variants.productId }).from(variants).where(eq(variants.id, row.variantId)).get();
      if (named?.productId !== variant.productId) throw invalid({ variantId: "variant_not_model" });
    }
    trackSerials = variant.trackSerials;
  }

  // The serial: normalized, and free (not a unit the store holds, not in another open trade-in).
  let serial: string | null = null;
  if (input.serial !== undefined) {
    serial = normalizeSerial(input.serial);
    if (!serial) throw invalid({ serial: "serial_invalid" });
  }
  if (serial) {
    const origin = await serialOrigin(db, serial);
    if (origin && origin.status !== "sold") throw invalid({ serial: "serial_in_stock" });
    if (origin && variantId && origin.variantId !== variantId) throw invalid({ serial: "serial_variant_mismatch" });
    const other = await db
      .select({ id: tradeIns.id })
      .from(tradeIns)
      .where(and(sql`${tradeIns.id} <> ${row.id}`, notInArray(tradeIns.status, ["paid", "cancelled"]), sql`json_extract(${tradeIns.inspection}, '$.serial') = ${serial}`))
      .get();
    if (other) throw invalid({ serial: "serial_in_trade_in" });
  }

  const actorId = actor.kind === "employee" ? actor.id : null;
  const previous = (row.inspection ?? null) as Inspection | null;
  // 13.08: a confirmation on file holds for the device it was made for — the same serial — and nothing else.
  const sameDevice = previous !== null && (previous.serial ?? null) === serial;
  const onFile = (stored: boolean | null): boolean | null => (stored === true ? (sameDevice ? true : null) : stored);
  const ownershipOk = input.ownershipOk ?? onFile(row.ownershipOk);
  const accountLockOk = input.accountLockOk ?? onFile(row.accountLockOk);
  const keptOwnership = sameDevice && row.ownershipOk === true;
  const keptLock = sameDevice && row.accountLockOk === true;
  // Confirming ownership or a free account lock is devices.ownership.verify's (the inspector's "no" never needs it).
  if (((ownershipOk === true && !keptOwnership) || (accountLockOk === true && !keptLock)) && !can(actor, "devices.ownership.verify")) throw forbidden("devices.ownership.verify");
  const built = buildChecklist(template, input.answers as ChecklistAnswers, actorId, now, cleanLine);
  const guide = await guideFor(db, device.model?.id ?? null, variantId);
  const allowed = new Set([...(guide ? accessoriesOf(guide.deductions) : []), "original_box", "extra"]);
  const included = [...new Set(input.included)].filter((key) => allowed.has(key));
  const confirmed = ownershipOk === true && accountLockOk === true;
  const kept = confirmed && keptOwnership && keptLock && Boolean(previous?.ownershipAt);
  const inspection: Inspection = {
    checklist: built.checklist,
    ...(input.grade ? { grade: input.grade } : {}),
    ...(input.notes ? { notes: input.notes } : {}),
    inspectedBy: actorId ?? undefined,
    inspectedAt: now,
    serial,
    included,
    batteryPct: built.batteryPct,
    // Who confirmed ownership and the lock, and when: kept from the confirmation on file, never the later inspector's.
    ownershipAt: confirmed ? (kept ? (previous?.ownershipAt ?? now) : now) : null,
    ownershipBy: confirmed ? (kept ? (previous?.ownershipBy ?? actorId) : actorId) : null,
  };
  const statuses = [...INSPECTABLE];
  try {
    await runBatch(db, [
      db
        .update(tradeIns)
        .set({ inspection, variantId, ownershipOk, accountLockOk, status: "inspected", updatedAt: now })
        .where(and(eq(tradeIns.id, row.id), inArray(tradeIns.status, statuses), eq(tradeIns.updatedAt, row.updatedAt))),
      expectChanged(db, 1, { code: "TRADE_IN_CHANGED", detail: row.id }),
      db.insert(tradeInEvents).values(
        eventRow(row.id, "inspected", { grade: input.grade ?? null, complete: built.complete, passed: built.checklist.items.filter((item) => item.result === "pass").length, failed: built.checklist.items.filter((item) => item.result === "fail").length, ownershipOk, accountLockOk, templateId: template.id }, actor, now),
      ),
      auditStatement(db, {
        actor,
        action: "devices.tradein.inspect",
        entityType: "trade_in",
        entityId: row.id,
        summary: row.ref,
        before: previous ? { grade: previous.grade ?? null, serial: previous.serial ?? null, ownershipOk: row.ownershipOk, accountLockOk: row.accountLockOk } : null,
        after: { grade: input.grade ?? null, serial, variantId, ownershipOk, accountLockOk, complete: built.complete },
        at: now,
      }),
    ]);
  } catch (error) {
    settle(error);
  }
  return { complete: built.complete, status: "inspected" };
}

// ───────────────────────────────────────────────────────────────── the final offer (13.04)

export const OfferInput = z.object({
  tradeInId: idField,
  amountIqd: z.preprocess(formInt, z.number({ error: (issue) => (issue.input === undefined ? "required" : "invalid") }).int("invalid").min(OFFER_STEP_IQD, "too_small").max(MAX_OFFER_IQD, "too_big").refine((value) => value % OFFER_STEP_IQD === 0, "offer_step")),
  validDays: z.preprocess(formInt, z.number({ error: "invalid" }).int("invalid").min(OFFER_VALID_DAYS.min, "too_small").max(OFFER_VALID_DAYS.max, "too_big")).optional(),
  note: text(300, true),
});

/**
 * The final, binding offer — made by a person (devices.tradein.offer) on a recorded inspection: complete checklist,
 * grade, variant, serial (serial-tracked devices) and the ownership and account-lock checks passed. Open for
 * `validDays` (default: the setting tradein.estimate_valid_days). Replaces a declined or expired offer; an open offer
 * is never changed under the customer (`offer_open`). The `offered` event keeps what it was made on.
 */
export async function makeOffer(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ expiresAt: number; replayed: boolean }> {
  assertCan(actor, "devices.tradein.offer");
  const input = parse(OfferInput, raw, "tradein.offer");
  const row = await tradeInById(db, input.tradeInId);
  const expired = offerExpired(row, now);
  if (row.status === "offered" && !expired) {
    if (row.finalOfferIqd === input.amountIqd && row.offeredBy === (actor.kind === "employee" ? actor.id : null)) return { expiresAt: row.offerExpiresAt ?? now, replayed: true };
    throw new AppError("offer_open", 409);
  }
  if (!(OFFERABLE as readonly string[]).includes(row.status) && !expired) throw new AppError("trade_in_not_open", 409);
  const inspection = (row.inspection ?? null) as Inspection | null;
  if (!inspection) throw new AppError("inspection_required", 409);
  if (!inspection.grade) throw new AppError("offer_grade_required", 409);
  if (!row.variantId) throw new AppError("offer_variant_required", 409);
  if (row.ownershipOk !== true) throw new AppError("offer_ownership", 409);
  if (row.accountLockOk !== true) throw new AppError("offer_account_lock", 409);
  const device = await deviceKindOf(db, row);
  if (device.trackSerials && !inspection.serial) throw new AppError("offer_serial_required", 409);
  const template = inspection.checklist?.templateId ? await templateById(db, inspection.checklist.templateId) : null;
  const checklist = checklistView(template, inspection.checklist ?? null, "ar", device.kind);
  if (!inspection.checklist?.completedAt || checklist.missing.length > 0) throw new AppError("offer_checklist_incomplete", 409);
  const days = input.validDays ?? Math.min(OFFER_VALID_DAYS.max, Math.max(OFFER_VALID_DAYS.min, await getSetting(db, "tradein.estimate_valid_days")));
  const expiresAt = now + days * DAY_MS;
  const guide = await guideFor(db, device.model?.id ?? null, row.variantId);
  const valuation = guide ? valuationOf(guide, inspection.grade, inspection.included ?? []) : null;
  const statuses = expired ? [...OFFERABLE, "offered" as const] : [...OFFERABLE];
  const offeredBy = actor.kind === "employee" ? actor.id : postedBy(actor);
  const statements: BatchStatement[] = [
    db
      .update(tradeIns)
      .set({ finalOfferIqd: input.amountIqd, offeredBy, offeredAt: now, offerExpiresAt: expiresAt, status: "offered", acceptedAt: null, declinedAt: null, declineReason: null, payoutMethod: null, dataWiped: false, updatedAt: now })
      .where(and(eq(tradeIns.id, row.id), inArray(tradeIns.status, statuses), eq(tradeIns.updatedAt, row.updatedAt))),
    expectChanged(db, 1, { code: "TRADE_IN_CHANGED", detail: row.id }),
  ];
  if (expired) statements.push(db.insert(tradeInEvents).values(eventRow(row.id, "expired", { amountIqd: row.finalOfferIqd }, actor, now - 1)));
  statements.push(
    db.insert(tradeInEvents).values(
      eventRow(
        row.id,
        "offered",
        // guideBy: who last set the guide the suggestion came from (four eyes when it is the offerer — payoutNeedsSecond).
        { amountIqd: input.amountIqd, expiresAt, validDays: days, grade: inspection.grade, passed: checklist.passed, failed: checklist.failed, included: inspection.included ?? [], suggestedIqd: valuation?.suggestedIqd ?? null, guideId: guide?.id ?? null, guideBaseIqd: guide?.baseIqd ?? null, guideBy: guide?.updatedBy ?? null, note: input.note },
        actor,
        now,
      ),
    ),
    auditStatement(db, {
      actor,
      action: "devices.tradein.offer",
      entityType: "trade_in",
      entityId: row.id,
      summary: row.ref,
      before: { status: row.status, offerIqd: row.finalOfferIqd },
      after: { status: "offered", offerIqd: input.amountIqd, expiresAt, suggestedIqd: valuation?.suggestedIqd ?? null },
      reason: input.note,
      at: now,
    }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    settle(error);
  }
  return { expiresAt, replayed: false };
}

// ───────────────────────────────────────────────────────────────── the customer's answer, in person (13.09)

export const AnswerInput = z.discriminatedUnion("decision", [
  z.object({ tradeInId: idField, decision: z.literal("accept"), payout: z.preprocess(blank, z.enum(PAYOUT_LIST, { error: "payout_required" })) }),
  z.object({ tradeInId: idField, decision: z.literal("decline"), reason: text(300, true) }),
]);

/**
 * The customer's answer given at the counter (devices.tradein.offer) — the same rules as the shopper's own answer
 * (respondToOffer): only while the offer is open, store credit only for a customer with an account. The event says
 * `inPerson: true`; the printed offer the customer signs names the grade and the checklist result.
 */
export async function recordAnswer(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ status: "accepted" | "declined"; replayed: boolean }> {
  assertCan(actor, "devices.tradein.offer");
  const input = parse(AnswerInput, raw, "tradein.answer");
  const row = await tradeInById(db, input.tradeInId);
  // The same answer sent twice (a double tap, a retry) is that answer — not an error; a different one stays refused.
  if (input.decision === "accept" && row.status === "accepted" && row.payoutMethod === input.payout) return { status: "accepted", replayed: true };
  if (input.decision === "decline" && row.status === "declined") return { status: "declined", replayed: true };
  if (row.status !== "offered" || row.finalOfferIqd === null || offerExpired(row, now)) throw new AppError("offer_closed", 409);
  if (input.decision === "accept" && input.payout === "store_credit" && !row.customerId) throw new AppError("payout_requires_account", 409, { fields: { payout: "payout_requires_account" } });
  const open = and(eq(tradeIns.id, row.id), eq(tradeIns.status, "offered"), sql`(${tradeIns.offerExpiresAt} IS NULL OR ${tradeIns.offerExpiresAt} > ${now})`);
  const status = input.decision === "accept" ? ("accepted" as const) : ("declined" as const);
  const grade = ((row.inspection ?? null) as Inspection | null)?.grade ?? null;
  try {
    await runBatch(db, [
      input.decision === "accept"
        ? db.update(tradeIns).set({ status, payoutMethod: input.payout, acceptedAt: now, updatedAt: now }).where(open)
        : db.update(tradeIns).set({ status, declinedAt: now, declineReason: input.reason, updatedAt: now }).where(open),
      expectChanged(db, 1, { code: "TRADE_IN_CHANGED", detail: row.id }),
      db.insert(tradeInEvents).values(eventRow(row.id, status, input.decision === "accept" ? { payout: input.payout, amountIqd: row.finalOfferIqd, grade, inPerson: true } : { reason: input.reason, amountIqd: row.finalOfferIqd, inPerson: true }, actor, now)),
      auditStatement(db, { actor, action: `devices.tradein.${status === "accepted" ? "accept" : "decline"}`, entityType: "trade_in", entityId: row.id, summary: row.ref, after: { status, payout: input.decision === "accept" ? input.payout : null, amountIqd: row.finalOfferIqd, inPerson: true }, reason: input.decision === "decline" ? input.reason : null, at: now }),
    ]);
  } catch (error) {
    settle(error, "offer_closed");
  }
  return { status, replayed: false };
}

// ───────────────────────────────────────────────────────────────── data wipe (13.08)

export const WipeInput = z.object({ tradeInId: idField, note: text(300, true) });

/**
 * Confirms that the customer's accounts are unlinked and the device is factory-reset (devices.ownership.verify) —
 * after the customer accepted and before the payout (the blueprint's "receipt and data wipe" step). For a game or an
 * accessory with nothing to wipe, the same confirmation says so in the note.
 */
export async function confirmWipe(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  assertCan(actor, "devices.ownership.verify");
  const input = parse(WipeInput, raw, "tradein.wipe");
  const row = await tradeInById(db, input.tradeInId);
  if (row.status !== "accepted") throw new AppError("payout_not_accepted", 409);
  if (row.dataWiped) return { replayed: true };
  if (row.ownershipOk !== true || row.accountLockOk !== true) throw new AppError("offer_ownership", 409);
  try {
    await runBatch(db, [
      db.update(tradeIns).set({ dataWiped: true, updatedAt: now }).where(and(eq(tradeIns.id, row.id), eq(tradeIns.status, "accepted"), eq(tradeIns.dataWiped, false))),
      expectChanged(db, 1, { code: "TRADE_IN_CHANGED", detail: row.id }),
      db.insert(tradeInEvents).values(eventRow(row.id, "data_wiped", { note: input.note }, actor, now)),
      auditStatement(db, { actor, action: "devices.tradein.wipe", entityType: "trade_in", entityId: row.id, summary: row.ref, after: { dataWiped: true }, reason: input.note, at: now }),
    ]);
  } catch (error) {
    settle(error);
  }
  return { replayed: false };
}

// ───────────────────────────────────────────────────────────────── payout and the used unit (cost entry, relisting)

export const PayoutInput = z.object({
  tradeInId: idField,
  method: z.preprocess(blank, z.enum(PAYOUT_LIST, { error: "payout_required" }).optional()),
  locationId: idField,
  /** Required when the method differs from the one the customer chose. */
  reason: text(300, true),
  /**
   * Cash paid from the payer's own till drawer: this open POS shift of theirs (follow-up 2026-11-12). The payout is then
   * a drawer pay-out on that shift in the same batch, so the drawer's expected cash — and its blind count — stay right.
   * Left out: the cash came from elsewhere (the safe).
   */
  shiftId: z.preprocess(blank, idField.optional()),
});

export const payoutDrawerKey = (tradeInId: string) => `tradein:${tradeInId}:drawer`;

/** The employee's open POS shift (their till drawer) a cash payout can be paid from; null without one. */
export async function drawerOf(db: Db, actor: Actor): Promise<{ shiftId: string; register: string } | null> {
  if (actor.kind !== "employee" || !can(actor, "pos.cash.move")) return null;
  const rows = await db.all<{ id: string; code: string }>(sql`SELECT s.id, r.code FROM pos_shifts AS s JOIN pos_registers AS r ON r.id = s.register_id WHERE s.opened_by = ${actor.id} AND s.status = 'open' ORDER BY s.opened_at DESC LIMIT 1`);
  return rows[0] ? { shiftId: rows[0].id, register: rows[0].code } : null;
}

export const payoutWalletKey = (tradeInId: string) => `tradein:${tradeInId}:payout`;
export const payoutJournalKey = (tradeInId: string) => `trade_in:${tradeInId}:payout`;

const SLUG_TAIL = "0123456789abcdefghjkmnpqrstvwxyz";

/** A used unit's public slug: "used-<product slug>-<6 random characters>". */
function usedSlug(productSlug: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let tail = "";
  for (const byte of bytes) tail += SLUG_TAIL[byte % 32];
  const base = productSlug.replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "device";
  return `used-${base}-${tail}`;
}

/** Was a payout started for this trade-in (a wallet credit or a cash posting under its key)? */
async function payoutStarted(db: Db, tradeInId: string): Promise<{ walletEntryId: string | null; journalId: string | null }> {
  const [wallet, journal] = await Promise.all([
    db.select({ id: walletLedger.id }).from(walletLedger).where(eq(walletLedger.idempotencyKey, payoutWalletKey(tradeInId))).get(),
    db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.idempotencyKey, payoutJournalKey(tradeInId))).get(),
  ]);
  return { walletEntryId: wallet?.id ?? null, journalId: journal?.id ?? null };
}

/**
 * Pays the customer and takes the device into stock as a used unit (devices.tradein.payout) — only when the customer
 * accepted and the data wipe was confirmed. See the file header for the money, the registry and the four-eyes rule.
 * Returns the used unit to continue with (photos, price, listing). A repeat returns the same unit (`replayed`).
 */
export async function payOut(db: Db, actor: Actor, raw: unknown, now: number, options: { labels?: (key: string) => L10n | undefined } = {}): Promise<{ usedUnitId: string; replayed: boolean; method: Payout }> {
  assertCan(actor, "devices.tradein.payout");
  const input = parse(PayoutInput, raw, "tradein.payout");
  const row = await tradeInById(db, input.tradeInId);
  if (row.status === "paid") {
    const unit = await db.select({ id: usedUnits.id }).from(usedUnits).where(eq(usedUnits.tradeInId, row.id)).get();
    if (unit) return { usedUnitId: unit.id, replayed: true, method: (row.payoutMethod ?? "cash") as Payout };
  }
  if (row.status !== "accepted" || row.finalOfferIqd === null) throw new AppError("payout_not_accepted", 409);
  const method: Payout | null = input.method ?? row.payoutMethod;
  if (!method) throw new AppError("payout_method_required", 409, { fields: { method: "payout_required" } });
  if (row.payoutMethod && method !== row.payoutMethod && !input.reason) throw invalid({ reason: "reason_required" });
  if (method === "store_credit" && !row.customerId) throw new AppError("payout_requires_account", 409, { fields: { method: "payout_requires_account" } });
  if (!row.dataWiped) throw new AppError("payout_wipe_required", 409);
  if (row.ownershipOk !== true || row.accountLockOk !== true) throw new AppError("offer_ownership", 409);
  const inspection = (row.inspection ?? null) as Inspection | null;
  if (!inspection?.grade || !row.variantId) throw new AppError("inspection_required", 409);
  const lastOffer = await lastOfferEvent(db, row.id);
  if (payoutNeedsSecond(row.finalOfferIqd, lastOffer?.suggestedIqd ?? null, guideSetByOfferer(lastOffer, row.offeredBy)) && actor.kind === "employee" && row.offeredBy === actor.id) throw new AppError("payout_second_person", 403);
  const location = await assertUnitLocation(db, actor, input.locationId);
  const variant = await db
    .select({ id: variants.id, trackSerials: variants.trackSerials, productSlug: products.slug })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(eq(variants.id, row.variantId))
    .get();
  if (!variant) throw new AppError("inspection_required", 409);
  if (variant.trackSerials && !inspection.serial) throw new AppError("offer_serial_required", 409);
  const origin = await serialOrigin(db, inspection.serial ?? null);
  if (origin && origin.status !== "sold") throw invalid({ serial: "serial_in_stock" });
  if (origin && origin.variantId !== variant.id) throw invalid({ serial: "serial_variant_mismatch" });

  const amount = row.finalOfferIqd;
  const actorId = actor.kind === "employee" ? actor.id : null;

  // The money goes in the SAME batch as the trade-in → paid, the serial and the unit: a payout that loses a race (a
  // second payout, a cancel, the serial entering stock meanwhile) moves no money. Built with the wallet and accounting
  // cores' statement builders (walletCreditStatement + postWalletCredit, journalStatements).
  let payoutRef: string;
  const money: BatchStatement[] = [];
  const started = await payoutStarted(db, row.id);
  if (method === "store_credit") {
    const customerId = row.customerId as string;
    if (started.journalId) throw new AppError("payout_started", 409);
    if (started.walletEntryId) {
      // A credit written by an earlier payout that stopped half way: this payout completes it, never pays it twice.
      const earlier = await db.select({ id: walletLedger.id, customerId: walletLedger.customerId, amountIqd: walletLedger.amountIqd, kind: walletLedger.kind }).from(walletLedger).where(eq(walletLedger.id, started.walletEntryId)).get();
      if (!earlier || earlier.customerId !== customerId || earlier.amountIqd !== amount || earlier.kind !== "trade_in_credit") throw new AppError("idempotency_mismatch", 409, { detail: payoutWalletKey(row.id) });
      payoutRef = earlier.id;
    } else {
      const customer = await db.select({ status: customers.status, isDemo: customers.isDemo }).from(customers).where(eq(customers.id, customerId)).get();
      if (!customer) throw notFound("customer");
      if (customer.status === "merged" || customer.status === "deleted") throw new AppError("customer_unavailable", 409, { detail: customer.status });
      payoutRef = newId("wal");
      const reason = `Trade-in ${row.ref}`;
      money.push(
        walletCreditStatement(db, { id: payoutRef, customerId, amountIqd: amount, kind: "trade_in_credit", refType: "trade_in", refId: row.id, reason, idempotencyKey: payoutWalletKey(row.id), actor, now }),
        // Dr inventory (the device bought) / Cr wallet liability, exactly as the wallet core posts a trade-in credit.
        // A demo trade-in (or a demo customer) never posts to the real books.
        ...postWalletCredit(db, { ledgerEntryId: payoutRef, customerId, amountIqd: amount, debitAccount: "inventory", memo: "Wallet trade_in_credit", at: now, createdBy: postedBy(actor), isDemo: customer.isDemo || row.isDemo }),
        auditStatement(db, { actor, action: "customers.wallet.credit", entityType: "customer", entityId: customerId, after: { entryId: payoutRef, kind: "trade_in_credit", amountIqd: amount, refType: "trade_in", refId: row.id }, reason, at: now }),
      );
    }
  } else {
    // Cash is never paid for a trade-in that already has its store credit (the credit completes instead).
    if (started.walletEntryId) throw new AppError("payout_started", 409);
    if (input.shiftId) {
      // from the payer's own open till drawer: a drawer pay-out in this batch, guarded on the shift still being open
      const drawer = await drawerOf(db, actor);
      if (!drawer || drawer.shiftId !== input.shiftId) throw new AppError("payout_drawer_invalid", 409, { fields: { shiftId: "payout_drawer_invalid" } });
      const { actorKind, actorId: mover } = actorRef(actor);
      money.push(
        expectThat(db, sql`EXISTS (SELECT 1 FROM pos_shifts WHERE id = ${input.shiftId} AND status = 'open')`, { code: "PAYOUT_DRAWER_CLOSED", detail: input.shiftId }),
        db.insert(cashMovements).values({ id: newId("cmv"), shiftId: input.shiftId, kind: "pay_out", amountIqd: -amount, reason: `trade_in ${row.ref}`, actorKind, actorId: mover, idempotencyKey: payoutDrawerKey(row.id), at: now }),
      );
    }
    payoutRef = newId("je");
    money.push(
      ...journalStatements(db, {
        id: payoutRef,
        at: now,
        memo: `Trade-in ${row.ref} paid in cash`,
        refType: "trade_in",
        refId: row.id,
        createdBy: postedBy(actor),
        idempotencyKey: payoutJournalKey(row.id),
        isDemo: row.isDemo,
        lines: [
          { accountCode: "inventory", debitIqd: amount, memo: row.ref },
          { accountCode: "cash", creditIqd: amount, memo: row.ref },
        ],
      }),
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM wallet_ledger WHERE idempotency_key = ${payoutWalletKey(row.id)})`, { code: "PAYOUT_STARTED", detail: row.id }),
    );
  }

  const unitId = newId("usd");
  const serialId = inspection.serial ? (origin?.id ?? newId("ser")) : null;
  const wipeEvent = await db
    .select({ at: tradeInEvents.at, actorId: tradeInEvents.actorId })
    .from(tradeInEvents)
    .where(and(eq(tradeInEvents.tradeInId, row.id), eq(tradeInEvents.kind, "data_wiped")))
    .orderBy(desc(tradeInEvents.at))
    .get();
  const inspectionPhotos = await db
    .select({ id: files.id })
    .from(files)
    .where(and(eq(files.ownerType, "trade_in"), eq(files.ownerId, row.id), eq(files.kind, INSPECTION_PHOTO_KIND), isNull(files.deletedAt)))
    .orderBy(asc(files.createdAt));
  const included: IncludedItem[] = (inspection.included ?? []).map((key) => {
    const label = options.labels?.(key);
    return label ? { key, label } : { key };
  });
  const checklist: UsedChecklist = inspection.checklist ?? { templateId: null, completedAt: null, completedBy: null, items: [] };
  const ownershipAt = inspection.ownershipAt ?? inspection.inspectedAt ?? now;
  const dataWipedAt = wipeEvent?.at ?? now;
  // The units' own rule: "ready" only with the checklist complete and no critical item failed (a broken screen bought
  // for parts is "testing", out of the listing queue, until it is repaired and inspected again).
  const unitStatus = await settledStatus(db, { status: "intake", checklist, grade: inspection.grade, ownershipCheckedAt: ownershipAt, dataWipedAt }, (await deviceKindOf(db, row)).kind);

  // Parents first (the serial), then the rows that point at it (the trade-in, the used unit).
  const statements: BatchStatement[] = [];
  if (serialId && inspection.serial) {
    if (origin) {
      // A unit the store sold before comes back: it is ours again, its old order line lets it go, its warranty ends
      // (the commerce core's buy-back of a sold serial, CONTRACTS §1 inventory/stock.server).
      statements.push(...releaseSoldSerialStatements(db, { serialId, variantId: variant.id, locationId: location.id, source: "trade_in", sourceRef: row.id, costIqd: amount, notes: row.ref, voidReason: `traded_in:${row.ref}`, now }));
    } else {
      statements.push(
        db.insert(serials).values({ id: serialId, serial: inspection.serial, variantId: variant.id, status: "in_stock", locationId: location.id, costIqd: amount, source: "trade_in", sourceRef: row.id, notes: row.ref, createdAt: now, updatedAt: now }),
      );
    }
  }
  statements.push(
    db
      .update(tradeIns)
      .set({ status: "paid", paidAt: now, payoutRef, payoutMethod: method, serialId, updatedAt: now })
      .where(and(eq(tradeIns.id, row.id), eq(tradeIns.status, "accepted"), eq(tradeIns.finalOfferIqd, amount), eq(tradeIns.dataWiped, true))),
    expectChanged(db, 1, { code: "TRADE_IN_CHANGED", detail: row.id }),
    db.insert(usedUnits).values({
      id: unitId,
      slug: usedSlug(variant.productSlug),
      variantId: variant.id,
      serialId,
      grade: inspection.grade,
      batteryHealthPct: inspection.batteryPct ?? null,
      cosmeticNotes: null,
      defects: [],
      included,
      checklist,
      priceIqd: 0,
      acquisitionCostIqd: amount,
      warrantyDays: 0,
      locationId: location.id,
      status: unitStatus,
      ownershipCheckedAt: ownershipAt,
      ownershipCheckedBy: inspection.ownershipBy ?? inspection.inspectedBy ?? null,
      dataWipedAt,
      dataWipedBy: wipeEvent?.actorId ?? actorId,
      isDemo: row.isDemo,
      source: "trade_in",
      tradeInId: row.id,
      createdAt: now,
      updatedAt: now,
    }),
  );
  inspectionPhotos.forEach((photo, index) => {
    // The inspector's photos become the unit's photos — still unconfirmed (is_illustration = 1) until staff say they show this unit.
    statements.push(db.insert(media).values({ id: newId("med"), ownerType: "used_unit", ownerId: unitId, fileId: photo.id, kind: "image", isIllustration: true, sort: index, createdAt: now }));
  });
  // The money, after the guarded trade-in → paid (one transaction: all of it or none).
  statements.push(...money);
  statements.push(
    db.insert(tradeInEvents).values(eventRow(row.id, "paid", { payout: method, amountIqd: amount, usedUnitId: unitId, changedFrom: row.payoutMethod && row.payoutMethod !== method ? row.payoutMethod : null }, actor, now)),
    auditStatement(db, {
      actor,
      action: "devices.tradein.payout",
      entityType: "trade_in",
      entityId: row.id,
      summary: row.ref,
      before: { status: "accepted", payout: row.payoutMethod },
      after: { status: "paid", payout: method, amountIqd: amount, payoutRef, usedUnitId: unitId, serialId, reacquired: Boolean(origin), locationId: location.id, drawerShiftId: method === "cash" ? (input.shiftId ?? null) : null },
      reason: input.reason,
      at: now,
    }),
    auditStatement(db, { actor, action: "devices.used.intake", entityType: "used_unit", entityId: unitId, after: { source: "trade_in", tradeInId: row.id, grade: inspection.grade, serialId, locationId: location.id, status: unitStatus }, at: now }),
  );
  try {
    await runBatch(db, statements);
  } catch (error) {
    // A repeat that lost the race: the first payout's unit is the answer — with the method that was really paid.
    const current = await db.select({ status: tradeIns.status, payoutMethod: tradeIns.payoutMethod }).from(tradeIns).where(eq(tradeIns.id, row.id)).get();
    if (current?.status === "paid") {
      const unit = await db.select({ id: usedUnits.id }).from(usedUnits).where(eq(usedUnits.tradeInId, row.id)).get();
      if (unit) return { usedUnitId: unit.id, replayed: true, method: (current.payoutMethod ?? method) as Payout };
    }
    if (isUniqueViolation(error, "serials.serial")) throw invalid({ serial: "serial_in_stock" });
    if (toAppError(error)?.code === "payout_started") throw new AppError("payout_started", 409, { cause: error });
    // the till shift was closed between the check and the batch: nothing was paid
    if (mapDbError(error)?.code === "PAYOUT_DRAWER_CLOSED") throw new AppError("payout_drawer_invalid", 409, { fields: { shiftId: "payout_drawer_invalid" }, cause: error });
    settle(error);
  }
  return { usedUnitId: unitId, replayed: false, method };
}

// ───────────────────────────────────────────────────────────────── cancel, expire

export const CancelInput = z.object({ tradeInId: idField, reason: reasonText });

/**
 * Cancels a trade-in that is still open (no-show, the customer changed their mind, a device the store will not buy).
 * Before an offer the inspector may (devices.tradein.inspect); after it, devices.tradein.offer. Refused once a payout
 * was started for it (`payout_started`) — also inside the batch.
 */
export async function cancelTradeIn(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ replayed: boolean }> {
  if (!canAny(actor, ["devices.tradein.offer", "devices.tradein.inspect"])) throw forbidden("devices.tradein.offer");
  const input = parse(CancelInput, raw, "tradein.cancel");
  const row = await tradeInById(db, input.tradeInId);
  if (row.status === "cancelled") return { replayed: true };
  if (!(CANCELLABLE as readonly string[]).includes(row.status)) throw new AppError("trade_in_not_open", 409);
  const beforeOffer = ["submitted", "estimated", "inspection_scheduled", "inspected"].includes(row.status);
  if (!can(actor, "devices.tradein.offer") && !beforeOffer) throw forbidden("devices.tradein.offer");
  const started = await payoutStarted(db, row.id);
  if (started.walletEntryId || started.journalId) throw new AppError("payout_started", 409);
  try {
    await runBatch(db, [
      db.update(tradeIns).set({ status: "cancelled", updatedAt: now }).where(and(eq(tradeIns.id, row.id), eq(tradeIns.status, row.status), eq(tradeIns.updatedAt, row.updatedAt))),
      expectChanged(db, 1, { code: "TRADE_IN_CHANGED", detail: row.id }),
      expectThat(db, sql`NOT EXISTS (SELECT 1 FROM wallet_ledger WHERE idempotency_key = ${payoutWalletKey(row.id)}) AND NOT EXISTS (SELECT 1 FROM journal_entries WHERE idempotency_key = ${payoutJournalKey(row.id)})`, { code: "PAYOUT_STARTED", detail: row.id }),
      db.insert(tradeInEvents).values(eventRow(row.id, "cancelled", { reason: input.reason, from: row.status }, actor, now)),
      auditStatement(db, { actor, action: "devices.tradein.cancel", entityType: "trade_in", entityId: row.id, summary: row.ref, before: { status: row.status }, after: { status: "cancelled" }, reason: input.reason, at: now }),
    ]);
  } catch (error) {
    const app = toAppError(error);
    if (app?.code === "payout_started") throw new AppError("payout_started", 409, { cause: error });
    settle(error);
  }
  return { replayed: false };
}

/**
 * Closes offers whose validity passed (offered → expired, an `expired` event). For the daily job (owner of
 * app/server/jobs.server.ts); the admin also shows an open offer past its date as expired before this runs, and the
 * shopper's answer is refused after the date either way.
 */
export async function expireTradeInOffers(db: Db, now: number, limit = 200): Promise<{ expired: number }> {
  const due = await db
    .select({ id: tradeIns.id, offer: tradeIns.finalOfferIqd, updatedAt: tradeIns.updatedAt })
    .from(tradeIns)
    .where(and(eq(tradeIns.status, "offered"), sql`${tradeIns.offerExpiresAt} <= ${now}`))
    .limit(limit);
  let expired = 0;
  const job: Actor = { kind: "system", job: "tradein.expire_offers" };
  for (const row of due) {
    try {
      await runBatch(db, [
        db.update(tradeIns).set({ status: "expired", updatedAt: now }).where(and(eq(tradeIns.id, row.id), eq(tradeIns.status, "offered"), sql`${tradeIns.offerExpiresAt} <= ${now}`)),
        expectChanged(db, 1, { code: "TRADE_IN_CHANGED", detail: row.id }),
        db.insert(tradeInEvents).values(eventRow(row.id, "expired", { amountIqd: row.offer }, job, now)),
      ]);
      expired++;
    } catch (error) {
      if (toAppError(error)?.code !== "trade_in_changed") throw error;
    }
  }
  return { expired };
}

// ───────────────────────────────────────────────────────────────── photos

/** Authorizes an inspection photo BEFORE it is stored: the inspector, an open trade-in, room left. */
export async function assertTradeInPhotoSlot(db: Db, actor: Actor, tradeInId: string): Promise<TradeIn> {
  assertCan(actor, "devices.tradein.inspect");
  const row = await tradeInById(db, tradeInId);
  if (!(TRADE_IN_OPEN as readonly string[]).includes(row.status)) throw new AppError("trade_in_not_open", 409);
  const total = await db
    .select({ n: count() })
    .from(files)
    .where(and(eq(files.ownerType, "trade_in"), eq(files.ownerId, row.id), eq(files.kind, INSPECTION_PHOTO_KIND), isNull(files.deletedAt)))
    .get();
  if (Number(total?.n ?? 0) >= MAX_TRADE_IN_PHOTOS) throw new AppError("photo_limit", 409);
  return row;
}

/** The history line of a stored inspection photo (staff-internal; the shopper's photo count is unaffected). */
export async function recordTradeInPhoto(db: Db, actor: Actor, row: TradeIn, fileId: string, now: number): Promise<void> {
  await runBatch(db, [
    db.insert(tradeInEvents).values(eventRow(row.id, "photo", { fileId }, actor, now)),
    auditStatement(db, { actor, action: "devices.tradein.photo", entityType: "trade_in", entityId: row.id, summary: row.ref, after: { fileId }, at: now }),
  ]);
}

// ───────────────────────────────────────────────────────────────── the printed offer / receipt

export type TradeInDocument = TradeInDetail & { printedAt: number; storeName: string | null };

/** What the printed offer and receipt show (tradein.read) — the customer signs it when they accept in person. */
export async function tradeInDocument(db: Db, actor: Actor, ref: string, locale: Locale, now: number, urls: DetailUrls): Promise<TradeInDocument> {
  const detail = await getTradeInDetail(db, actor, ref, locale, now, urls);
  return { ...detail, printedAt: now, storeName: null };
}

/** Template ids → names, for the history of inspections. */
export async function templateNames(db: Db, ids: readonly string[], locale: Locale): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(ids.filter((id) => ID.test(id)))];
  if (wanted.length === 0) return out;
  const rows = await db.select({ id: inspectionTemplates.id, name: inspectionTemplates.name }).from(inspectionTemplates).where(inArray(inspectionTemplates.id, wanted));
  for (const row of rows) out.set(row.id, pick(row.name, locale) || row.id);
  return out;
}

/** Device models a counter trade-in can name (published or not; the inspection decides). */
export async function counterModelOptions(db: Db, locale: Locale): Promise<{ id: string; name: string; platform: string }[]> {
  const rows = await db.all<{ id: string; name: string | null; platform: string | null }>(sql`
    SELECT dm.id, dm.name, pl.name AS platform FROM device_models AS dm JOIN platforms AS pl ON pl.id = dm.platform_id
    WHERE dm.status <> 'archived' ORDER BY pl.sort, dm.sort, dm.id LIMIT 200`);
  return rows.map((row) => ({ id: row.id, name: l10nOf(row.name, locale) || row.id, platform: l10nOf(row.platform, locale) }));
}

void parseJson;
