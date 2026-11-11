/**
 * shipping — governorates and districts of Iraq, delivery fees, carriers, shipments, delivery
 * attempts and cash-on-delivery settlements (admin module 11).
 *
 * Delivery is a flat fee to every governorate (`settings["shipping.flat_fee_iqd"]`, 5,000 IQD).
 * Rows in `shipping_rates` with `is_override = 1` only apply when an admin has switched on
 * `settings["shipping.overrides_enabled"]` (ARCHITECTURE §7.7).
 *
 * Estimated delivery days are optional and admin-entered: the store never invents a delivery promise.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ACTOR_KINDS, NOW_MS, at, flag, id, iqd, json, l10n, type Ref } from "../columns";
import { orderItems, orders } from "./commerce";
import { files } from "./core";
import { inventoryLocations } from "./inventory";

// ───────────────────────────────────────────────────────────────── geography

/** The 19 governorates of Iraq (seeded by seedReference; editable, never deleted — deactivate instead). */
export const governorates = sqliteTable(
  "governorates",
  {
    id: id(),
    slug: text("slug").notNull(),
    name: l10n("name").notNull(),
    sort: integer("sort").notNull().default(0),
    /** Inactive = not offered at checkout (delivery paused). */
    isActive: flag("is_active").notNull().default(true),
    /** Optional estimate shown as "usually N–M days"; null = say nothing. */
    etaDaysMin: integer("eta_days_min"),
    etaDaysMax: integer("eta_days_max"),
  },
  (t) => [uniqueIndex("governorates_slug_uq").on(t.slug), index("governorates_sort_idx").on(t.sort)],
);
export type Governorate = typeof governorates.$inferSelect;
export type NewGovernorate = typeof governorates.$inferInsert;

/** Districts (qadhas) per governorate. The neighbourhood itself is free text on the address. */
export const districts = sqliteTable(
  "districts",
  {
    id: id(),
    governorateId: text("governorate_id")
      .notNull()
      .references((): Ref => governorates.id),
    name: l10n("name").notNull(),
    sort: integer("sort").notNull().default(0),
    isActive: flag("is_active").notNull().default(true),
    /** Stable key within the governorate (seeded rows); null for districts added by hand. */
    slug: text("slug"),
  },
  (t) => [index("districts_governorate_idx").on(t.governorateId, t.sort), uniqueIndex("districts_governorate_slug_uq").on(t.governorateId, t.slug)],
);
export type District = typeof districts.$inferSelect;
export type NewDistrict = typeof districts.$inferInsert;

/**
 * Delivery fee rules. `governorate_id IS NULL` = all governorates. A non-override row can mirror the
 * flat fee; override rows are ignored unless overrides are enabled in settings.
 */
export const shippingRates = sqliteTable(
  "shipping_rates",
  {
    id: id(),
    governorateId: text("governorate_id").references((): Ref => governorates.id),
    feeIqd: iqd("fee_iqd").notNull(),
    isOverride: flag("is_override").notNull().default(false),
    isActive: flag("is_active").notNull().default(true),
    districtId: text("district_id").references((): Ref => districts.id),
    note: text("note"),
    updatedBy: text("updated_by"),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    index("shipping_rates_governorate_idx").on(t.governorateId, t.isActive),
    index("shipping_rates_district_idx").on(t.districtId),
    check("shipping_rates_fee_check", sql`${t.feeIqd} >= 0`),
  ],
);
export type ShippingRate = typeof shippingRates.$inferSelect;
export type NewShippingRate = typeof shippingRates.$inferInsert;

// ───────────────────────────────────────────────────────────────── carriers

export const CARRIER_KINDS = ["in_house", "third_party"] as const;
export type CarrierKind = (typeof CARRIER_KINDS)[number];

/** Delivery companies and the store's own drivers. No integration is implied by a row here. */
export const carriers = sqliteTable(
  "carriers",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: CARRIER_KINDS }).notNull().default("third_party"),
    contactName: text("contact_name"),
    phone: text("phone"),
    /** e.g. "https://carrier.example/track/{tracking_no}"; null = no public tracking page. */
    trackingUrlTemplate: text("tracking_url_template"),
    codSupported: flag("cod_supported").notNull().default(true),
    /** What the carrier keeps from collected cash: a flat amount and/or basis points. */
    codFeeIqd: iqd("cod_fee_iqd"),
    codFeeBps: integer("cod_fee_bps"),
    notes: text("notes"),
    isActive: flag("is_active").notNull().default(true),
    isDemo: flag("is_demo").notNull().default(false),
    createdAt: at("created_at").notNull(),
  },
  (t) => [uniqueIndex("carriers_code_uq").on(t.code)],
);
export type Carrier = typeof carriers.$inferSelect;
export type NewCarrier = typeof carriers.$inferInsert;

/** What a carrier charges the store per governorate and service level (11.02) — a cost, not the shopper's fee. */
export const carrierZones = sqliteTable(
  "carrier_zones",
  {
    id: id(),
    carrierId: text("carrier_id")
      .notNull()
      .references((): Ref => carriers.id, { onDelete: "cascade" }),
    governorateId: text("governorate_id")
      .notNull()
      .references((): Ref => governorates.id),
    serviceLevel: text("service_level").notNull().default("standard"),
    costIqd: iqd("cost_iqd").notNull(),
    etaDaysMin: integer("eta_days_min"),
    etaDaysMax: integer("eta_days_max"),
    isActive: flag("is_active").notNull().default(true),
  },
  (t) => [
    uniqueIndex("carrier_zones_zone_uq").on(t.carrierId, t.governorateId, t.serviceLevel),
    index("carrier_zones_governorate_idx").on(t.governorateId),
    check("carrier_zones_cost_check", sql`${t.costIqd} >= 0`),
  ],
);
export type CarrierZone = typeof carrierZones.$inferSelect;
export type NewCarrierZone = typeof carrierZones.$inferInsert;

// ───────────────────────────────────────────────────────────────── shipments

export const SHIPMENT_STATUSES = ["pending", "packed", "handed_over", "in_transit", "out_for_delivery", "delivered", "failed", "returning", "returned", "cancelled"] as const;
export type ShipmentStatus = (typeof SHIPMENT_STATUSES)[number];

/** A parcel. An order can be split into several shipments (05.04). */
export const shipments = sqliteTable(
  "shipments",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    carrierId: text("carrier_id").references((): Ref => carriers.id),
    trackingNo: text("tracking_no"),
    status: text("status", { enum: SHIPMENT_STATUSES }).notNull().default("pending"),
    /** Cash the courier must collect; 0 for prepaid orders. */
    codAmountIqd: iqd("cod_amount_iqd").notNull().default(0),
    codSettledAt: at("cod_settled_at"),
    packedBy: text("packed_by"),
    /** Proof of delivery (photo / signed slip) — private file. */
    proofFileId: text("proof_file_id").references((): Ref => files.id),
    shippedAt: at("shipped_at"),
    deliveredAt: at("delivered_at"),
    /** Photo of the packed parcel for sensitive devices (11.06) — private file. */
    packingFileId: text("packing_file_id").references((): Ref => files.id),
    /** Name of the person who received the parcel. */
    receivedByName: text("received_by_name"),
    /** What the carrier charged the store for this parcel. */
    costIqd: iqd("cost_iqd"),
    /** Location the parcel ships from. */
    locationId: text("location_id").references((): Ref => inventoryLocations.id),
    failureReason: text("failure_reason"),
    returnedAt: at("returned_at"),
    labelPrintedAt: at("label_printed_at"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull().default(NOW_MS),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    index("shipments_order_idx").on(t.orderId),
    index("shipments_carrier_idx").on(t.carrierId, t.status),
    index("shipments_tracking_idx").on(t.trackingNo),
    index("shipments_status_idx").on(t.status, t.createdAt),
    index("shipments_cod_idx").on(t.codSettledAt, t.status),
    index("shipments_proof_file_idx").on(t.proofFileId),
    index("shipments_packing_file_idx").on(t.packingFileId),
    index("shipments_location_idx").on(t.locationId),
    check("shipments_cod_check", sql`${t.codAmountIqd} >= 0`),
  ],
);
export type Shipment = typeof shipments.$inferSelect;
export type NewShipment = typeof shipments.$inferInsert;

/** What is inside a shipment, with the pick/scan verification trail (04.11). */
export const shipmentItems = sqliteTable(
  "shipment_items",
  {
    shipmentId: text("shipment_id")
      .notNull()
      .references((): Ref => shipments.id, { onDelete: "cascade" }),
    orderItemId: text("order_item_id")
      .notNull()
      .references((): Ref => orderItems.id),
    qty: integer("qty").notNull(),
    pickedBy: text("picked_by"),
    pickedAt: at("picked_at"),
    /** Barcode / serial scan confirmed the right item was packed. */
    verifiedAt: at("verified_at"),
  },
  (t) => [
    primaryKey({ columns: [t.shipmentId, t.orderItemId] }),
    index("shipment_items_order_item_idx").on(t.orderItemId),
    check("shipment_items_qty_check", sql`${t.qty} > 0`),
  ],
);
export type ShipmentItem = typeof shipmentItems.$inferSelect;
export type NewShipmentItem = typeof shipmentItems.$inferInsert;

/** [A] Tracking history of a shipment. */
export const shipmentEvents = sqliteTable(
  "shipment_events",
  {
    id: id(),
    shipmentId: text("shipment_id")
      .notNull()
      .references((): Ref => shipments.id),
    /** A shipment status, or "note" / "label_printed" / "cod_collected" … */
    kind: text("kind").notNull(),
    note: text("note"),
    data: json<Record<string, unknown>>("data"),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorId: text("actor_id"),
    at: at("at").notNull(),
  },
  (t) => [index("shipment_events_shipment_idx").on(t.shipmentId, t.at)],
);
export type ShipmentEvent = typeof shipmentEvents.$inferSelect;
export type NewShipmentEvent = typeof shipmentEvents.$inferInsert;

export const DELIVERY_OUTCOMES = ["delivered", "no_answer", "refused", "wrong_address", "rescheduled", "damaged", "other"] as const;
export type DeliveryOutcome = (typeof DELIVERY_OUTCOMES)[number];

/** Each try at the door (11.05): what happened and when the next try is planned. */
export const deliveryAttempts = sqliteTable(
  "delivery_attempts",
  {
    id: id(),
    shipmentId: text("shipment_id")
      .notNull()
      .references((): Ref => shipments.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    outcome: text("outcome", { enum: DELIVERY_OUTCOMES }).notNull(),
    reason: text("reason"),
    notes: text("notes"),
    nextAttemptAt: at("next_attempt_at"),
    proofFileId: text("proof_file_id").references((): Ref => files.id),
    attemptedAt: at("attempted_at").notNull(),
    recordedBy: text("recorded_by"),
  },
  (t) => [uniqueIndex("delivery_attempts_shipment_no_uq").on(t.shipmentId, t.attemptNo), index("delivery_attempts_proof_file_idx").on(t.proofFileId)],
);
export type DeliveryAttempt = typeof deliveryAttempts.$inferSelect;
export type NewDeliveryAttempt = typeof deliveryAttempts.$inferInsert;

// ───────────────────────────────────────────────────────────────── COD settlements

export const COD_SETTLEMENT_STATUSES = ["draft", "submitted", "reconciled", "disputed"] as const;
export type CodSettlementStatus = (typeof COD_SETTLEMENT_STATUSES)[number];

/**
 * Cash handed over by a carrier for delivered COD parcels (11.04, 10.02).
 * variance_iqd = received_iqd − (expected_iqd − fees_iqd); a non-zero variance needs a note.
 */
export const codSettlements = sqliteTable(
  "cod_settlements",
  {
    id: id(),
    ref: text("ref").notNull(),
    carrierId: text("carrier_id")
      .notNull()
      .references((): Ref => carriers.id),
    periodFrom: at("period_from"),
    periodTo: at("period_to"),
    expectedIqd: iqd("expected_iqd").notNull().default(0),
    feesIqd: iqd("fees_iqd").notNull().default(0),
    receivedIqd: iqd("received_iqd").notNull().default(0),
    varianceIqd: iqd("variance_iqd").notNull().default(0),
    status: text("status", { enum: COD_SETTLEMENT_STATUSES }).notNull().default("draft"),
    /** The carrier's statement — private file. */
    statementFileId: text("statement_file_id").references((): Ref => files.id),
    notes: text("notes"),
    reconciledBy: text("reconciled_by"),
    reconciledAt: at("reconciled_at"),
    /** Journal entry that booked the cash. */
    journalEntryId: text("journal_entry_id"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("cod_settlements_ref_uq").on(t.ref),
    index("cod_settlements_carrier_idx").on(t.carrierId, t.createdAt),
    index("cod_settlements_status_idx").on(t.status, t.createdAt),
    index("cod_settlements_statement_file_idx").on(t.statementFileId),
  ],
);
export type CodSettlement = typeof codSettlements.$inferSelect;
export type NewCodSettlement = typeof codSettlements.$inferInsert;

/** Shipments covered by a settlement. A shipment settles once (UNIQUE shipment_id). */
export const codSettlementItems = sqliteTable(
  "cod_settlement_items",
  {
    settlementId: text("settlement_id")
      .notNull()
      .references((): Ref => codSettlements.id, { onDelete: "cascade" }),
    shipmentId: text("shipment_id")
      .notNull()
      .references((): Ref => shipments.id),
    amountIqd: iqd("amount_iqd").notNull(),
    feeIqd: iqd("fee_iqd").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.settlementId, t.shipmentId] }), uniqueIndex("cod_settlement_items_shipment_uq").on(t.shipmentId)],
);
export type CodSettlementItem = typeof codSettlementItems.$inferSelect;
export type NewCodSettlementItem = typeof codSettlementItems.$inferInsert;
