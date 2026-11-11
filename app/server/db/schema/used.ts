/**
 * used — used / refurbished units, inspection checklists and the trade-in journey
 * (admin module 13).
 *
 * Invariants enforced by triggers (drizzle/0001_invariants.sql):
 *   used_units   a unit with is_demo = 0 can only be `listed` when it has
 *                  · at least one real photo: a `media` row with owner_type 'used_unit', kind 'image',
 *                    is_illustration = 0 and a file_id,
 *                  · a completed checklist (`checklist.completedAt` set and at least one item),
 *                  · ownership_checked_at and data_wiped_at
 *                → TT:USED_UNIT_NOT_LISTABLE:<used_unit_id>   (also raised when the last real photo of a
 *                  listed unit is removed)
 *   used_units   status moves to 'reserved' only from 'ready' | 'listed', and to 'sold' only from
 *                'ready' | 'listed' | 'reserved' → TT:USED_UNIT_NOT_AVAILABLE:<used_unit_id>
 *   trade_ins    final_offer_iqd needs offered_by, offered_at and a recorded inspection, and the
 *                statuses offered / accepted / paid need a final offer
 *                → TT:TRADE_IN_OFFER_NOT_ALLOWED:<trade_in_id>
 *   trade_in_events   [A]
 *
 * Privacy: serial numbers, sellers' details and acquisition cost never appear on public pages.
 * `acquisition_cost_iqd` is [P].
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { UsedGrade as UsedGradeDto } from "~/lib/dto";
import type { L10n, Locale } from "~/lib/locales";
import { ACTOR_KINDS, DEVICE_KINDS, NOW_MS, at, flag, id, iqd, json, l10n, type Ref, type Same } from "../columns";
import { deviceModels, variants } from "./catalog";
import { orderItems } from "./commerce";
import { customers } from "./customers";
import { inventoryLocations, serials } from "./inventory";

export const USED_GRADES = ["A+", "A", "B", "C"] as const;
export type UsedGrade = (typeof USED_GRADES)[number];
export const USED_UNIT_STATUSES = ["intake", "testing", "ready", "listed", "reserved", "sold", "returned"] as const;
export type UsedUnitStatus = (typeof USED_UNIT_STATUSES)[number];
export const USED_UNIT_SOURCES = ["trade_in", "purchase", "return"] as const;
export type UsedUnitSource = (typeof USED_UNIT_SOURCES)[number];

export type ChecklistResult = "pass" | "fail" | "na";
/**
 * A filled-in inspection. The listing trigger reads `completedAt` and `items`: set `completedAt`
 * only when every required item of the template has a result.
 */
export type UsedChecklist = {
  templateId: string | null;
  completedAt: number | null;
  completedBy: string | null;
  items: Array<{ key: string; result: ChecklistResult | null; value?: string | number; note?: string }>;
};
/** A disclosed fault, cosmetic or functional. Shown on the listing exactly as recorded. */
export type UsedDefect = { area: string; severity: "minor" | "moderate" | "major"; note: L10n };
/** What comes in the box (charger, dock, cable, original box, …). */
export type IncludedItem = { key: string; label?: L10n };

/**
 * One specific used device for sale. Photos are `media` rows with owner_type "used_unit".
 * The storefront shows the grade, defects, checklist results and battery health as recorded here.
 */
export const usedUnits = sqliteTable(
  "used_units",
  {
    id: id(),
    slug: text("slug").notNull(),
    /** The catalogue variant this unit is an instance of (model, storage, colour). */
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    serialId: text("serial_id").references((): Ref => serials.id),
    grade: text("grade", { enum: USED_GRADES }).notNull(),
    /** Null when it cannot be measured for this device. */
    batteryHealthPct: integer("battery_health_pct"),
    cosmeticNotes: l10n("cosmetic_notes"),
    defects: json<UsedDefect[]>("defects"),
    included: json<IncludedItem[]>("included"),
    checklist: json<UsedChecklist>("checklist"),
    priceIqd: iqd("price_iqd").notNull(),
    /** [P] What the store paid for the unit. */
    acquisitionCostIqd: iqd("acquisition_cost_iqd"),
    warrantyDays: integer("warranty_days").notNull().default(0),
    locationId: text("location_id").references((): Ref => inventoryLocations.id),
    status: text("status", { enum: USED_UNIT_STATUSES }).notNull().default("intake"),
    /** Proof of ownership and account-lock checks passed (13.08). */
    ownershipCheckedAt: at("ownership_checked_at"),
    /** Accounts removed and the device factory-reset (13.08). */
    dataWipedAt: at("data_wiped_at"),
    listedAt: at("listed_at"),
    isDemo: flag("is_demo").notNull().default(false),
    source: text("source", { enum: USED_UNIT_SOURCES }).notNull().default("trade_in"),
    tradeInId: text("trade_in_id").references((): Ref => tradeIns.id),
    ownershipCheckedBy: text("ownership_checked_by"),
    dataWipedBy: text("data_wiped_by"),
    /** Order line that sold the unit. */
    soldOrderItemId: text("sold_order_item_id").references((): Ref => orderItems.id),
    soldAt: at("sold_at"),
    createdAt: at("created_at").notNull().default(NOW_MS),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("used_units_slug_uq").on(t.slug),
    index("used_units_variant_idx").on(t.variantId, t.status),
    index("used_units_serial_idx").on(t.serialId),
    index("used_units_status_idx").on(t.status, t.listedAt),
    index("used_units_location_idx").on(t.locationId),
    index("used_units_trade_in_idx").on(t.tradeInId),
    index("used_units_sold_item_idx").on(t.soldOrderItemId),
    check("used_units_price_check", sql`${t.priceIqd} >= 0 AND ${t.warrantyDays} >= 0`),
    check("used_units_battery_check", sql`${t.batteryHealthPct} IS NULL OR ${t.batteryHealthPct} BETWEEN 0 AND 100`),
  ],
);
export type UsedUnit = typeof usedUnits.$inferSelect;
export type NewUsedUnit = typeof usedUnits.$inferInsert;

/** One line of an inspection template. `critical` items must pass before a unit may be listed (checked by the service). */
export type InspectionTemplateItem = {
  key: string;
  label: L10n;
  hint?: L10n;
  input: "pass_fail" | "percent" | "text";
  required: boolean;
  critical?: boolean;
};

/** What an inspection template is for: a device kind, or "game" for used physical games (disc, case, region — 13.05). */
export const INSPECTION_KINDS = [...DEVICE_KINDS, "game"] as const;
export type InspectionKind = (typeof INSPECTION_KINDS)[number];

/** Inspection checklists per device kind (13.02), editable in the admin. Seeded for consoles, handheld PCs, controllers and games. */
export const inspectionTemplates = sqliteTable(
  "inspection_templates",
  {
    id: id(),
    deviceKind: text("device_kind", { enum: INSPECTION_KINDS }).notNull(),
    items: json<InspectionTemplateItem[]>("items").notNull(),
    name: l10n("name"),
    version: integer("version").notNull().default(1),
    isActive: flag("is_active").notNull().default(true),
    updatedBy: text("updated_by"),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [uniqueIndex("inspection_templates_kind_version_uq").on(t.deviceKind, t.version)],
);
export type InspectionTemplate = typeof inspectionTemplates.$inferSelect;
export type NewInspectionTemplate = typeof inspectionTemplates.$inferInsert;

// ───────────────────────────────────────────────────────────────── trade-in

export const TRADE_IN_STATUSES = ["submitted", "estimated", "inspection_scheduled", "inspected", "offered", "accepted", "declined", "paid", "cancelled", "expired"] as const;
export type TradeInStatus = (typeof TRADE_IN_STATUSES)[number];
export const PAYOUT_METHODS = ["store_credit", "cash"] as const;
export type PayoutMethod = (typeof PAYOUT_METHODS)[number];

/** What the inspector recorded when the device was in hand. */
export type TradeInInspection = { checklist: UsedChecklist; grade?: UsedGrade; notes?: string; inspectedBy?: string; inspectedAt?: number };

/**
 * A trade-in request. `estimate_*` is an indicative range computed from the questionnaire — it is
 * never an offer. `final_offer_iqd` is entered by an employee after physical inspection and is the
 * only binding number; it expires at `offer_expires_at`. Photos are private files with owner_type "trade_in".
 */
export const tradeIns = sqliteTable(
  "trade_ins",
  {
    id: id(),
    ref: text("ref").notNull(),
    customerId: text("customer_id").references((): Ref => customers.id),
    phoneE164: text("phone_e164").notNull(),
    deviceModelId: text("device_model_id").references((): Ref => deviceModels.id),
    variantId: text("variant_id").references((): Ref => variants.id),
    /** Questionnaire answers keyed by question. */
    answers: json<Record<string, string | number | boolean>>("answers"),
    estimateMinIqd: iqd("estimate_min_iqd"),
    estimateMaxIqd: iqd("estimate_max_iqd"),
    estimateExpiresAt: at("estimate_expires_at"),
    status: text("status", { enum: TRADE_IN_STATUSES }).notNull().default("submitted"),
    finalOfferIqd: iqd("final_offer_iqd"),
    offeredBy: text("offered_by"),
    offeredAt: at("offered_at"),
    offerExpiresAt: at("offer_expires_at"),
    payoutMethod: text("payout_method", { enum: PAYOUT_METHODS }),
    /** Registry row created when the device is received. */
    serialId: text("serial_id").references((): Ref => serials.id),
    /** Null = not checked yet. */
    ownershipOk: flag("ownership_ok"),
    accountLockOk: flag("account_lock_ok"),
    dataWiped: flag("data_wiped"),
    inspection: json<TradeInInspection>("inspection"),
    /** sha256 of the guest tracking token. */
    accessTokenHash: text("access_token_hash"),
    createdAt: at("created_at").notNull(),
    contactName: text("contact_name"),
    /** Free-text device description when the model is not in the catalogue. */
    deviceText: text("device_text"),
    locale: text("locale").$type<Locale>(),
    inspectionScheduledAt: at("inspection_scheduled_at"),
    acceptedAt: at("accepted_at"),
    declinedAt: at("declined_at"),
    declineReason: text("decline_reason"),
    paidAt: at("paid_at"),
    /** Wallet ledger row or cash movement that paid the customer. */
    payoutRef: text("payout_ref"),
    isDemo: flag("is_demo").notNull().default(false),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("trade_ins_ref_uq").on(t.ref),
    index("trade_ins_customer_idx").on(t.customerId),
    index("trade_ins_phone_idx").on(t.phoneE164),
    index("trade_ins_device_model_idx").on(t.deviceModelId),
    index("trade_ins_variant_idx").on(t.variantId),
    index("trade_ins_serial_idx").on(t.serialId),
    index("trade_ins_status_idx").on(t.status, t.createdAt),
    check(
      "trade_ins_amounts_check",
      sql`(${t.estimateMinIqd} IS NULL OR ${t.estimateMinIqd} >= 0) AND (${t.estimateMaxIqd} IS NULL OR ${t.estimateMaxIqd} >= coalesce(${t.estimateMinIqd}, 0)) AND (${t.finalOfferIqd} IS NULL OR ${t.finalOfferIqd} >= 0)`,
    ),
  ],
);
export type TradeIn = typeof tradeIns.$inferSelect;
export type NewTradeIn = typeof tradeIns.$inferInsert;

/** [A] History of a trade-in: estimates, schedule changes, inspection evidence, offers, decisions (valuation changes are tracked here). */
export const tradeInEvents = sqliteTable(
  "trade_in_events",
  {
    id: id(),
    tradeInId: text("trade_in_id")
      .notNull()
      .references((): Ref => tradeIns.id),
    kind: text("kind").notNull(),
    data: json<Record<string, unknown>>("data"),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorId: text("actor_id"),
    at: at("at").notNull(),
  },
  (t) => [index("trade_in_events_trade_in_idx").on(t.tradeInId, t.at)],
);
export type TradeInEvent = typeof tradeInEvents.$inferSelect;
export type NewTradeInEvent = typeof tradeInEvents.$inferInsert;

/**
 * Reference prices for estimates (13.03): `base_iqd` is the value of a grade-A+ unit;
 * `grade_multipliers` are basis points per grade (e.g. `{ "A+": 10000, "A": 9000, "B": 7500, "C": 5500 }`).
 * `variant_id IS NULL` = applies to every variant of the model.
 */
export const tradeInPriceGuides = sqliteTable(
  "trade_in_price_guides",
  {
    id: id(),
    deviceModelId: text("device_model_id")
      .notNull()
      .references((): Ref => deviceModels.id),
    variantId: text("variant_id").references((): Ref => variants.id),
    baseIqd: iqd("base_iqd").notNull(),
    gradeMultipliers: json<Partial<Record<UsedGrade, number>>>("grade_multipliers"),
    updatedBy: text("updated_by"),
    updatedAt: at("updated_at").notNull(),
    /** IQD deducted per questionnaire answer, e.g. `{ "missing_charger": 15000 }`. */
    deductions: json<Record<string, number>>("deductions"),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [
    index("trade_in_price_guides_model_idx").on(t.deviceModelId, t.variantId),
    index("trade_in_price_guides_variant_idx").on(t.variantId),
    check("trade_in_price_guides_base_check", sql`${t.baseIqd} >= 0`),
  ],
);
export type TradeInPriceGuide = typeof tradeInPriceGuides.$inferSelect;
export type NewTradeInPriceGuide = typeof tradeInPriceGuides.$inferInsert;

const dtoGuards: [Same<UsedGrade, UsedGradeDto>] = [true];
void dtoGuards;
