/**
 * inventory — locations, stock levels, the immutable movement ledger, serial numbers,
 * reservations, transfers, cycle counts, FIFO cost layers, digital codes and replenishment
 * (admin module 04, parts of 13 and 19).
 *
 * Invariants enforced by triggers (drizzle/0001_invariants.sql):
 *   stock_levels     available (on_hand − reserved) never drops below 0 unless allow_oversell = 1
 *                    → TT:INSUFFICIENT_STOCK:<variant_id>
 *   serials          status moves to 'sold' only from 'in_stock' | 'reserved', and to 'reserved'
 *                    only from 'in_stock' → TT:SERIAL_NOT_AVAILABLE:<serial_id>
 *   stock_movements  [A] append-only → TT:IMMUTABLE:stock_movements
 *
 * Every change to `stock_levels` is written together with its `stock_movements` row in ONE batch.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ACTOR_KINDS, NOW_MS, at, flag, id, iqd, json, type Ref } from "../columns";
import { variants } from "./catalog";
import { orderItems, orders } from "./commerce";
import { branches } from "./ops";
import { receiptItems, suppliers } from "./purchasing";

// ───────────────────────────────────────────────────────────────── locations

export const LOCATION_KINDS = ["warehouse", "store", "bin"] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/** Warehouses, shop floors and the shelves/bins inside them (04.02). */
export const inventoryLocations = sqliteTable(
  "inventory_locations",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    kind: text("kind", { enum: LOCATION_KINDS }).notNull().default("warehouse"),
    parentId: text("parent_id").references((): Ref => inventoryLocations.id),
    /** Printed on the shelf label and scanned during put-away and picking. */
    barcode: text("barcode"),
    /** Stock here counts towards what the storefront can sell. */
    isSellable: flag("is_sellable").notNull().default(true),
    branchId: text("branch_id").references((): Ref => branches.id),
    isActive: flag("is_active").notNull().default(true),
    sort: integer("sort").notNull().default(0),
  },
  (t) => [
    uniqueIndex("inventory_locations_code_uq").on(t.code),
    uniqueIndex("inventory_locations_barcode_uq").on(t.barcode),
    index("inventory_locations_parent_idx").on(t.parentId),
    index("inventory_locations_branch_idx").on(t.branchId),
  ],
);
export type InventoryLocation = typeof inventoryLocations.$inferSelect;
export type NewInventoryLocation = typeof inventoryLocations.$inferInsert;

// ───────────────────────────────────────────────────────────────── levels and movements

/**
 * Current quantities per variant and location. available = on_hand − reserved.
 * `allow_oversell` needs the `inventory.oversell.authorize` permission and an audit reason.
 */
export const stockLevels = sqliteTable(
  "stock_levels",
  {
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id, { onDelete: "cascade" }),
    locationId: text("location_id")
      .notNull()
      .references((): Ref => inventoryLocations.id),
    onHand: integer("on_hand").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    /** On approved purchase orders and inbound transfers, not yet received. */
    incoming: integer("incoming").notNull().default(0),
    reorderPoint: integer("reorder_point"),
    allowOversell: flag("allow_oversell").notNull().default(false),
    /** Suggested order quantity when the reorder point is reached. */
    reorderQty: integer("reorder_qty"),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    primaryKey({ columns: [t.variantId, t.locationId] }),
    index("stock_levels_location_idx").on(t.locationId),
    check("stock_levels_counts_check", sql`${t.reserved} >= 0 AND ${t.incoming} >= 0`),
  ],
);
export type StockLevel = typeof stockLevels.$inferSelect;
export type NewStockLevel = typeof stockLevels.$inferInsert;

export const STOCK_MOVEMENT_KINDS = ["receive", "reserve", "release", "sale", "transfer_out", "transfer_in", "damage", "adjust", "return", "count"] as const;
export type StockMovementKind = (typeof STOCK_MOVEMENT_KINDS)[number];

/**
 * [A] Every change to stock, with reason, reference, actor and time (04.04).
 * `unit_cost_iqd` is [P]: select it only for actors with cost.read.
 */
export const stockMovements = sqliteTable(
  "stock_movements",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    locationId: text("location_id")
      .notNull()
      .references((): Ref => inventoryLocations.id),
    serialId: text("serial_id").references((): Ref => serials.id),
    kind: text("kind", { enum: STOCK_MOVEMENT_KINDS }).notNull(),
    /** Change to on_hand (signed). */
    qtyDelta: integer("qty_delta").notNull().default(0),
    /** Change to reserved (signed). */
    reservedDelta: integer("reserved_delta").notNull().default(0),
    /** [P] */
    unitCostIqd: iqd("unit_cost_iqd"),
    /** What caused it: "order", "receipt", "transfer", "cycle_count", "return", "trade_in", … */
    refType: text("ref_type"),
    refId: text("ref_id"),
    reason: text("reason"),
    actorKind: text("actor_kind", { enum: ACTOR_KINDS }).notNull(),
    actorId: text("actor_id"),
    at: at("at").notNull(),
  },
  (t) => [
    index("stock_movements_variant_idx").on(t.variantId, t.at),
    index("stock_movements_location_idx").on(t.locationId, t.at),
    index("stock_movements_serial_idx").on(t.serialId),
    index("stock_movements_ref_idx").on(t.refType, t.refId),
    index("stock_movements_kind_idx").on(t.kind, t.at),
  ],
);
export type StockMovement = typeof stockMovements.$inferSelect;
export type NewStockMovement = typeof stockMovements.$inferInsert;

// ───────────────────────────────────────────────────────────────── serials

export const SERIAL_STATUSES = ["in_stock", "reserved", "sold", "returned", "in_repair", "scrapped", "intake"] as const;
export type SerialStatus = (typeof SERIAL_STATUSES)[number];
export const SERIAL_SOURCES = ["purchase", "trade_in"] as const;
export type SerialSource = (typeof SERIAL_SOURCES)[number];

/**
 * One row per physical device (13.01). Serial numbers are private: never render them on public pages.
 * `cost_iqd` is [P].
 */
export const serials = sqliteTable(
  "serials",
  {
    id: id(),
    serial: text("serial").notNull(),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    status: text("status", { enum: SERIAL_STATUSES }).notNull().default("in_stock"),
    locationId: text("location_id").references((): Ref => inventoryLocations.id),
    /** [P] */
    costIqd: iqd("cost_iqd"),
    source: text("source", { enum: SERIAL_SOURCES }).notNull().default("purchase"),
    /** Receipt item id or trade-in id the unit came from. */
    sourceRef: text("source_ref"),
    notes: text("notes"),
    createdAt: at("created_at").notNull().default(NOW_MS),
    updatedAt: at("updated_at").notNull().default(NOW_MS),
  },
  (t) => [
    uniqueIndex("serials_serial_uq").on(t.serial),
    index("serials_variant_idx").on(t.variantId, t.status),
    index("serials_location_idx").on(t.locationId),
    index("serials_status_idx").on(t.status),
  ],
);
export type Serial = typeof serials.$inferSelect;
export type NewSerial = typeof serials.$inferInsert;

// ───────────────────────────────────────────────────────────────── reservations

export const RESERVATION_STATUSES = ["active", "committed", "released", "expired"] as const;
export type ReservationStatus = (typeof RESERVATION_STATUSES)[number];

/**
 * Stock held for an order (04.08). Created in the order batch together with
 * `stock_levels.reserved += qty`; a job releases `active` rows past `expires_at`.
 */
export const stockReservations = sqliteTable(
  "stock_reservations",
  {
    id: id(),
    orderId: text("order_id")
      .notNull()
      .references((): Ref => orders.id),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    locationId: text("location_id")
      .notNull()
      .references((): Ref => inventoryLocations.id),
    qty: integer("qty").notNull(),
    status: text("status", { enum: RESERVATION_STATUSES }).notNull().default("active"),
    /** Null = held until the order is fulfilled or cancelled (paid / COD-confirmed orders). */
    expiresAt: at("expires_at"),
    createdAt: at("created_at").notNull(),
    orderItemId: text("order_item_id").references((): Ref => orderItems.id),
    releasedAt: at("released_at"),
  },
  (t) => [
    index("stock_reservations_order_idx").on(t.orderId),
    index("stock_reservations_variant_idx").on(t.variantId, t.locationId, t.status),
    index("stock_reservations_location_idx").on(t.locationId),
    index("stock_reservations_order_item_idx").on(t.orderItemId),
    index("stock_reservations_expiry_idx").on(t.status, t.expiresAt),
    check("stock_reservations_qty_check", sql`${t.qty} > 0`),
  ],
);
export type StockReservation = typeof stockReservations.$inferSelect;
export type NewStockReservation = typeof stockReservations.$inferInsert;

// ───────────────────────────────────────────────────────────────── transfers

export const TRANSFER_STATUSES = ["draft", "in_transit", "received", "cancelled"] as const;
export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

/** Moves between locations and branches, including the in-transit state (04.07). */
export const stockTransfers = sqliteTable(
  "stock_transfers",
  {
    id: id(),
    ref: text("ref").notNull(),
    fromLocationId: text("from_location_id")
      .notNull()
      .references((): Ref => inventoryLocations.id),
    toLocationId: text("to_location_id")
      .notNull()
      .references((): Ref => inventoryLocations.id),
    status: text("status", { enum: TRANSFER_STATUSES }).notNull().default("draft"),
    notes: text("notes"),
    requestedBy: text("requested_by"),
    shippedBy: text("shipped_by"),
    receivedBy: text("received_by"),
    createdAt: at("created_at").notNull(),
    shippedAt: at("shipped_at"),
    receivedAt: at("received_at"),
    cancelledAt: at("cancelled_at"),
  },
  (t) => [
    uniqueIndex("stock_transfers_ref_uq").on(t.ref),
    index("stock_transfers_from_idx").on(t.fromLocationId),
    index("stock_transfers_to_idx").on(t.toLocationId),
    index("stock_transfers_status_idx").on(t.status, t.createdAt),
    check("stock_transfers_locations_check", sql`${t.fromLocationId} <> ${t.toLocationId}`),
  ],
);
export type StockTransfer = typeof stockTransfers.$inferSelect;
export type NewStockTransfer = typeof stockTransfers.$inferInsert;

/** Serialized units get one line each (`serial_id`, qty 1). */
export const stockTransferItems = sqliteTable(
  "stock_transfer_items",
  {
    id: id(),
    transferId: text("transfer_id")
      .notNull()
      .references((): Ref => stockTransfers.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    serialId: text("serial_id").references((): Ref => serials.id),
    qty: integer("qty").notNull(),
    qtyReceived: integer("qty_received").notNull().default(0),
    notes: text("notes"),
  },
  (t) => [
    index("stock_transfer_items_transfer_idx").on(t.transferId),
    index("stock_transfer_items_variant_idx").on(t.variantId),
    index("stock_transfer_items_serial_idx").on(t.serialId),
    check("stock_transfer_items_qty_check", sql`${t.qty} > 0 AND ${t.qtyReceived} >= 0 AND ${t.qtyReceived} <= ${t.qty}`),
  ],
);
export type StockTransferItem = typeof stockTransferItems.$inferSelect;
export type NewStockTransferItem = typeof stockTransferItems.$inferInsert;

// ───────────────────────────────────────────────────────────────── cycle counts

export const CYCLE_COUNT_STATUSES = ["draft", "counting", "review", "approved", "cancelled"] as const;
export type CycleCountStatus = (typeof CYCLE_COUNT_STATUSES)[number];
export const CYCLE_COUNT_SCOPES = ["full", "partial"] as const;
export type CycleCountScope = (typeof CYCLE_COUNT_SCOPES)[number];

/** Periodic and selective stock counts; variances are posted only after a supervisor approves (04.05). */
export const cycleCounts = sqliteTable(
  "cycle_counts",
  {
    id: id(),
    ref: text("ref").notNull(),
    locationId: text("location_id")
      .notNull()
      .references((): Ref => inventoryLocations.id),
    scope: text("scope", { enum: CYCLE_COUNT_SCOPES }).notNull().default("partial"),
    status: text("status", { enum: CYCLE_COUNT_STATUSES }).notNull().default("draft"),
    notes: text("notes"),
    startedBy: text("started_by"),
    approvedBy: text("approved_by"),
    createdAt: at("created_at").notNull(),
    startedAt: at("started_at"),
    submittedAt: at("submitted_at"),
    approvedAt: at("approved_at"),
  },
  (t) => [
    uniqueIndex("cycle_counts_ref_uq").on(t.ref),
    index("cycle_counts_location_idx").on(t.locationId),
    index("cycle_counts_status_idx").on(t.status, t.createdAt),
  ],
);
export type CycleCount = typeof cycleCounts.$inferSelect;
export type NewCycleCount = typeof cycleCounts.$inferInsert;

export const cycleCountLines = sqliteTable(
  "cycle_count_lines",
  {
    id: id(),
    countId: text("count_id")
      .notNull()
      .references((): Ref => cycleCounts.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    /** on_hand captured when the count started. */
    expectedQty: integer("expected_qty").notNull(),
    /** Null until counted. */
    countedQty: integer("counted_qty"),
    /** Why the count differs (required to approve a variance). */
    reason: text("reason"),
    /** Serials seen during the count, for serial-tracked variants. */
    serialsSeen: json<string[]>("serials_seen"),
    countedBy: text("counted_by"),
    countedAt: at("counted_at"),
  },
  (t) => [uniqueIndex("cycle_count_lines_count_variant_uq").on(t.countId, t.variantId), index("cycle_count_lines_variant_idx").on(t.variantId)],
);
export type CycleCountLine = typeof cycleCountLines.$inferSelect;
export type NewCycleCountLine = typeof cycleCountLines.$inferInsert;

// ───────────────────────────────────────────────────────────────── costing [P]

export const COST_LAYER_SOURCES = ["purchase", "trade_in", "return", "adjustment", "opening"] as const;
export type CostLayerSource = (typeof COST_LAYER_SOURCES)[number];

/**
 * [P] FIFO cost layers (04.10): one row per received batch; sales consume the oldest layer with
 * `qty_remaining > 0` first. Never exposed without cost.read.
 */
export const costLayers = sqliteTable(
  "cost_layers",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    locationId: text("location_id")
      .notNull()
      .references((): Ref => inventoryLocations.id),
    qtyRemaining: integer("qty_remaining").notNull(),
    /** Landed cost per unit. */
    unitCostIqd: iqd("unit_cost_iqd").notNull(),
    receivedAt: at("received_at").notNull(),
    receiptItemId: text("receipt_item_id").references((): Ref => receiptItems.id),
    qtyReceived: integer("qty_received").notNull(),
    source: text("source", { enum: COST_LAYER_SOURCES }).notNull().default("purchase"),
  },
  (t) => [
    index("cost_layers_fifo_idx").on(t.variantId, t.locationId, t.receivedAt),
    index("cost_layers_location_idx").on(t.locationId),
    index("cost_layers_receipt_item_idx").on(t.receiptItemId),
    check("cost_layers_qty_check", sql`${t.qtyRemaining} >= 0 AND ${t.qtyRemaining} <= ${t.qtyReceived} AND ${t.unitCostIqd} >= 0`),
  ],
);
export type CostLayer = typeof costLayers.$inferSelect;
export type NewCostLayer = typeof costLayers.$inferInsert;

// ───────────────────────────────────────────────────────────────── digital codes

export const DIGITAL_CODE_STATUSES = ["available", "reserved", "delivered", "revoked", "expired"] as const;
export type DigitalCodeStatus = (typeof DIGITAL_CODE_STATUSES)[number];

/**
 * Redeemable codes for digital products (13.07). The code itself is stored encrypted
 * (`code_enc`, AES-256-GCM with DATA_KEY); `code_hash` (sha256 of the normalized code) only
 * detects duplicates. A code is shown to the buyer after the order is paid, and to staff only
 * with the `digital_code.reveal` permission (each reveal is audited). `cost_iqd` is [P].
 */
export const digitalCodes = sqliteTable(
  "digital_codes",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    codeEnc: text("code_enc").notNull(),
    codeHash: text("code_hash").notNull(),
    status: text("status", { enum: DIGITAL_CODE_STATUSES }).notNull().default("available"),
    orderItemId: text("order_item_id").references((): Ref => orderItems.id),
    receiptItemId: text("receipt_item_id").references((): Ref => receiptItems.id),
    /** [P] */
    costIqd: iqd("cost_iqd"),
    expiresAt: at("expires_at"),
    reservedAt: at("reserved_at"),
    deliveredAt: at("delivered_at"),
    /** First time the buyer opened the code. */
    revealedAt: at("revealed_at"),
    revealCount: integer("reveal_count").notNull().default(0),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("digital_codes_code_hash_uq").on(t.codeHash),
    index("digital_codes_variant_idx").on(t.variantId, t.status),
    index("digital_codes_order_item_idx").on(t.orderItemId),
    index("digital_codes_receipt_item_idx").on(t.receiptItemId),
  ],
);
export type DigitalCode = typeof digitalCodes.$inferSelect;
export type NewDigitalCode = typeof digitalCodes.$inferInsert;

// ───────────────────────────────────────────────────────────────── replenishment (04.06, 19.02, 19.05)

export const REORDER_SUGGESTION_STATUSES = ["open", "approved", "dismissed", "ordered"] as const;
export type ReorderSuggestionStatus = (typeof REORDER_SUGGESTION_STATUSES)[number];

/** "This will run out" alerts with a purchase quantity a person can approve into a purchase order. */
export const reorderSuggestions = sqliteTable(
  "reorder_suggestions",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    locationId: text("location_id").references((): Ref => inventoryLocations.id),
    supplierId: text("supplier_id").references((): Ref => suppliers.id),
    suggestedQty: integer("suggested_qty").notNull(),
    /** Days of cover left at the measured sales rate; null when there is not enough history. */
    daysOfCover: integer("days_of_cover"),
    /** The numbers behind the suggestion (on hand, reserved, incoming, sales rate, lead time). */
    basis: json<Record<string, unknown>>("basis"),
    status: text("status", { enum: REORDER_SUGGESTION_STATUSES }).notNull().default("open"),
    /** Purchase order created from it. */
    purchaseOrderId: text("purchase_order_id"),
    decidedBy: text("decided_by"),
    decidedAt: at("decided_at"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("reorder_suggestions_status_idx").on(t.status, t.createdAt),
    index("reorder_suggestions_variant_idx").on(t.variantId),
    index("reorder_suggestions_location_idx").on(t.locationId),
    index("reorder_suggestions_supplier_idx").on(t.supplierId),
    check("reorder_suggestions_qty_check", sql`${t.suggestedQty} > 0`),
  ],
);
export type ReorderSuggestion = typeof reorderSuggestions.$inferSelect;
export type NewReorderSuggestion = typeof reorderSuggestions.$inferInsert;

/** Demand forecast per variant and month. Always shown with its method and inputs — a forecast is not a fact. */
export const demandForecasts = sqliteTable(
  "demand_forecasts",
  {
    id: id(),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id, { onDelete: "cascade" }),
    /** "YYYY-MM". */
    period: text("period").notNull(),
    qtyForecast: integer("qty_forecast").notNull(),
    /** e.g. "moving_average_3m", "seasonal_naive". */
    method: text("method").notNull(),
    inputs: json<Record<string, unknown>>("inputs"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [uniqueIndex("demand_forecasts_variant_period_uq").on(t.variantId, t.period, t.method)],
);
export type DemandForecast = typeof demandForecasts.$inferSelect;
export type NewDemandForecast = typeof demandForecasts.$inferInsert;
