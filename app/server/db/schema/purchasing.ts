/**
 * purchasing — suppliers, RFQs, purchase orders, goods receipts, supplier invoices, landed cost and
 * supplier claims (admin module 09).
 *
 * EVERYTHING in this file is [P] protected: supplier prices and costs are only selected by services
 * after can(actor, "cost.read"), and must be absent (not masked) from every response, export and API
 * for other actors.
 *
 * Supplier-currency amounts are integers in the currency's minor units (`*_minor`, e.g. cents);
 * `fx_rate_micros` is IQD per one unit of the currency × 1,000,000. IQD amounts are `*_iqd`.
 */
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { at, flag, id, iqd, json, type Ref } from "../columns";
import { variants } from "./catalog";
import { files } from "./core";
import { inventoryLocations } from "./inventory";

// ───────────────────────────────────────────────────────────────── suppliers

export const SUPPLIER_STATUSES = ["active", "inactive", "blocked"] as const;
export type SupplierStatus = (typeof SUPPLIER_STATUSES)[number];

export const suppliers = sqliteTable(
  "suppliers",
  {
    id: id(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    legalName: text("legal_name"),
    country: text("country"),
    /** ISO 4217 code the supplier quotes in. */
    currency: text("currency").notNull().default("USD"),
    /** e.g. "advance", "net 30", "50% deposit". */
    paymentTerms: text("payment_terms"),
    leadTimeDays: integer("lead_time_days"),
    phone: text("phone"),
    email: text("email"),
    address: text("address"),
    notes: text("notes"),
    status: text("status", { enum: SUPPLIER_STATUSES }).notNull().default("active"),
    isDemo: flag("is_demo").notNull().default(false),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [uniqueIndex("suppliers_code_uq").on(t.code), index("suppliers_status_idx").on(t.status)],
);
export type Supplier = typeof suppliers.$inferSelect;
export type NewSupplier = typeof suppliers.$inferInsert;

export const supplierContacts = sqliteTable(
  "supplier_contacts",
  {
    id: id(),
    supplierId: text("supplier_id")
      .notNull()
      .references((): Ref => suppliers.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    role: text("role"),
    phone: text("phone"),
    email: text("email"),
    isPrimary: flag("is_primary").notNull().default(false),
    notes: text("notes"),
  },
  (t) => [index("supplier_contacts_supplier_idx").on(t.supplierId)],
);
export type SupplierContact = typeof supplierContacts.$inferSelect;
export type NewSupplierContact = typeof supplierContacts.$inferInsert;

// ───────────────────────────────────────────────────────────────── RFQs (09.02)

export const RFQ_STATUSES = ["draft", "sent", "quoted", "awarded", "cancelled"] as const;
export type RfqStatus = (typeof RFQ_STATUSES)[number];

/** Request for quotations: compare price, lead time and warranty across suppliers. */
export const rfqs = sqliteTable(
  "rfqs",
  {
    id: id(),
    ref: text("ref").notNull(),
    title: text("title").notNull(),
    status: text("status", { enum: RFQ_STATUSES }).notNull().default("draft"),
    neededBy: at("needed_by"),
    notes: text("notes"),
    /** The winning quote. */
    awardedQuoteId: text("awarded_quote_id").references((): Ref => rfqQuotes.id),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    closedAt: at("closed_at"),
  },
  (t) => [
    uniqueIndex("rfqs_ref_uq").on(t.ref),
    index("rfqs_status_idx").on(t.status, t.createdAt),
    index("rfqs_awarded_quote_idx").on(t.awardedQuoteId),
  ],
);
export type Rfq = typeof rfqs.$inferSelect;
export type NewRfq = typeof rfqs.$inferInsert;

export const rfqItems = sqliteTable(
  "rfq_items",
  {
    id: id(),
    rfqId: text("rfq_id")
      .notNull()
      .references((): Ref => rfqs.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    qty: integer("qty").notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("rfq_items_rfq_variant_uq").on(t.rfqId, t.variantId),
    index("rfq_items_variant_idx").on(t.variantId),
    check("rfq_items_qty_check", sql`${t.qty} > 0`),
  ],
);
export type RfqItem = typeof rfqItems.$inferSelect;
export type NewRfqItem = typeof rfqItems.$inferInsert;

export const RFQ_QUOTE_STATUSES = ["received", "accepted", "rejected", "expired"] as const;
export type RfqQuoteStatus = (typeof RFQ_QUOTE_STATUSES)[number];

export const rfqQuotes = sqliteTable(
  "rfq_quotes",
  {
    id: id(),
    rfqId: text("rfq_id")
      .notNull()
      .references((): Ref => rfqs.id, { onDelete: "cascade" }),
    supplierId: text("supplier_id")
      .notNull()
      .references((): Ref => suppliers.id),
    currency: text("currency").notNull().default("USD"),
    totalMinor: integer("total_minor"),
    leadTimeDays: integer("lead_time_days"),
    warrantyMonths: integer("warranty_months"),
    validUntil: at("valid_until"),
    notes: text("notes"),
    /** The supplier's quotation document — private file. */
    fileId: text("file_id").references((): Ref => files.id),
    status: text("status", { enum: RFQ_QUOTE_STATUSES }).notNull().default("received"),
    receivedAt: at("received_at").notNull(),
    createdBy: text("created_by"),
  },
  (t) => [
    uniqueIndex("rfq_quotes_rfq_supplier_uq").on(t.rfqId, t.supplierId),
    index("rfq_quotes_supplier_idx").on(t.supplierId),
    index("rfq_quotes_file_idx").on(t.fileId),
  ],
);
export type RfqQuote = typeof rfqQuotes.$inferSelect;
export type NewRfqQuote = typeof rfqQuotes.$inferInsert;

export const rfqQuoteItems = sqliteTable(
  "rfq_quote_items",
  {
    id: id(),
    quoteId: text("quote_id")
      .notNull()
      .references((): Ref => rfqQuotes.id, { onDelete: "cascade" }),
    rfqItemId: text("rfq_item_id")
      .notNull()
      .references((): Ref => rfqItems.id, { onDelete: "cascade" }),
    unitCostMinor: integer("unit_cost_minor").notNull(),
    qtyAvailable: integer("qty_available"),
    leadTimeDays: integer("lead_time_days"),
    warrantyMonths: integer("warranty_months"),
  },
  (t) => [
    uniqueIndex("rfq_quote_items_quote_item_uq").on(t.quoteId, t.rfqItemId),
    index("rfq_quote_items_rfq_item_idx").on(t.rfqItemId),
    check("rfq_quote_items_cost_check", sql`${t.unitCostMinor} >= 0`),
  ],
);
export type RfqQuoteItem = typeof rfqQuoteItems.$inferSelect;
export type NewRfqQuoteItem = typeof rfqQuoteItems.$inferInsert;

// ───────────────────────────────────────────────────────────────── purchase orders (09.03)

export const PURCHASE_ORDER_STATUSES = ["draft", "pending_approval", "approved", "sent", "partially_received", "received", "closed", "cancelled"] as const;
export type PurchaseOrderStatus = (typeof PURCHASE_ORDER_STATUSES)[number];

/** A purchase order. Orders above the creator's spending limit wait in `pending_approval` (row in `approvals`). */
export const purchaseOrders = sqliteTable(
  "purchase_orders",
  {
    id: id(),
    ref: text("ref").notNull(),
    supplierId: text("supplier_id")
      .notNull()
      .references((): Ref => suppliers.id),
    rfqQuoteId: text("rfq_quote_id").references((): Ref => rfqQuotes.id),
    status: text("status", { enum: PURCHASE_ORDER_STATUSES }).notNull().default("draft"),
    currency: text("currency").notNull().default("USD"),
    fxRateMicros: integer("fx_rate_micros"),
    /** "YYYY-MM-DD" the rate was taken. */
    fxDate: text("fx_date"),
    subtotalMinor: integer("subtotal_minor").notNull().default(0),
    shippingMinor: integer("shipping_minor").notNull().default(0),
    otherMinor: integer("other_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull().default(0),
    /** total_minor converted at fx_rate_micros. */
    totalIqd: iqd("total_iqd"),
    /** Where the goods will be received. */
    locationId: text("location_id").references((): Ref => inventoryLocations.id),
    expectedAt: at("expected_at"),
    paymentTerms: text("payment_terms"),
    notes: text("notes"),
    approvalId: text("approval_id"),
    approvedBy: text("approved_by"),
    approvedAt: at("approved_at"),
    sentAt: at("sent_at"),
    cancelledAt: at("cancelled_at"),
    cancelReason: text("cancel_reason"),
    isDemo: flag("is_demo").notNull().default(false),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("purchase_orders_ref_uq").on(t.ref),
    index("purchase_orders_supplier_idx").on(t.supplierId, t.createdAt),
    index("purchase_orders_status_idx").on(t.status, t.createdAt),
    index("purchase_orders_rfq_quote_idx").on(t.rfqQuoteId),
    index("purchase_orders_location_idx").on(t.locationId),
    check("purchase_orders_total_check", sql`${t.totalMinor} = ${t.subtotalMinor} + ${t.shippingMinor} + ${t.otherMinor}`),
  ],
);
export type PurchaseOrder = typeof purchaseOrders.$inferSelect;
export type NewPurchaseOrder = typeof purchaseOrders.$inferInsert;

export const poItems = sqliteTable(
  "po_items",
  {
    id: id(),
    poId: text("po_id")
      .notNull()
      .references((): Ref => purchaseOrders.id, { onDelete: "cascade" }),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    qtyOrdered: integer("qty_ordered").notNull(),
    qtyReceived: integer("qty_received").notNull().default(0),
    unitCostMinor: integer("unit_cost_minor").notNull(),
    notes: text("notes"),
  },
  (t) => [
    uniqueIndex("po_items_po_variant_uq").on(t.poId, t.variantId),
    index("po_items_variant_idx").on(t.variantId),
    check("po_items_qty_check", sql`${t.qtyOrdered} > 0 AND ${t.qtyReceived} >= 0 AND ${t.unitCostMinor} >= 0`),
  ],
);
export type PoItem = typeof poItems.$inferSelect;
export type NewPoItem = typeof poItems.$inferInsert;

// ───────────────────────────────────────────────────────────────── receipts (09.04)

export const RECEIPT_STATUSES = ["draft", "posted", "cancelled"] as const;
export type ReceiptStatus = (typeof RECEIPT_STATUSES)[number];

/** Goods received (full or partial). Posting a receipt writes stock movements, serials and cost layers in one batch. */
export const receipts = sqliteTable(
  "receipts",
  {
    id: id(),
    ref: text("ref").notNull(),
    poId: text("po_id").references((): Ref => purchaseOrders.id),
    supplierId: text("supplier_id").references((): Ref => suppliers.id),
    locationId: text("location_id")
      .notNull()
      .references((): Ref => inventoryLocations.id),
    status: text("status", { enum: RECEIPT_STATUSES }).notNull().default("draft"),
    /** The supplier's delivery note number. */
    supplierDocNo: text("supplier_doc_no"),
    notes: text("notes"),
    receivedBy: text("received_by"),
    receivedAt: at("received_at"),
    postedAt: at("posted_at"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("receipts_ref_uq").on(t.ref),
    index("receipts_po_idx").on(t.poId),
    index("receipts_supplier_idx").on(t.supplierId),
    index("receipts_location_idx").on(t.locationId),
    index("receipts_status_idx").on(t.status, t.createdAt),
  ],
);
export type Receipt = typeof receipts.$inferSelect;
export type NewReceipt = typeof receipts.$inferInsert;

export const receiptItems = sqliteTable(
  "receipt_items",
  {
    id: id(),
    receiptId: text("receipt_id")
      .notNull()
      .references((): Ref => receipts.id, { onDelete: "cascade" }),
    poItemId: text("po_item_id").references((): Ref => poItems.id),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    qtyReceived: integer("qty_received").notNull(),
    /** Passed inspection and went into stock. */
    qtyAccepted: integer("qty_accepted").notNull().default(0),
    qtyRejected: integer("qty_rejected").notNull().default(0),
    rejectReason: text("reject_reason"),
    unitCostMinor: integer("unit_cost_minor"),
    /** Purchase cost per unit in IQD at the PO's rate. */
    unitCostIqd: iqd("unit_cost_iqd"),
    /** unit_cost_iqd + this line's share of landed costs. */
    landedUnitCostIqd: iqd("landed_unit_cost_iqd"),
    /** Serial numbers scanned at receiving, for serial-tracked variants. */
    serialsScanned: json<string[]>("serials_scanned"),
  },
  (t) => [
    index("receipt_items_receipt_idx").on(t.receiptId),
    index("receipt_items_po_item_idx").on(t.poItemId),
    index("receipt_items_variant_idx").on(t.variantId),
    check("receipt_items_qty_check", sql`${t.qtyReceived} >= 0 AND ${t.qtyAccepted} >= 0 AND ${t.qtyRejected} >= 0 AND ${t.qtyAccepted} + ${t.qtyRejected} <= ${t.qtyReceived}`),
  ],
);
export type ReceiptItem = typeof receiptItems.$inferSelect;
export type NewReceiptItem = typeof receiptItems.$inferInsert;

// ───────────────────────────────────────────────────────────────── supplier invoices (09.04, 09.07)

export const SUPPLIER_INVOICE_STATUSES = ["draft", "matched", "mismatch", "approved", "paid", "void"] as const;
export type SupplierInvoiceStatus = (typeof SUPPLIER_INVOICE_STATUSES)[number];

/** A difference found by the three-way match between PO, receipt and invoice. */
export type InvoiceDiscrepancy = { variantId: string; field: "qty" | "unit_cost"; po: number | null; received: number | null; invoiced: number | null };

export const supplierInvoices = sqliteTable(
  "supplier_invoices",
  {
    id: id(),
    supplierId: text("supplier_id")
      .notNull()
      .references((): Ref => suppliers.id),
    poId: text("po_id").references((): Ref => purchaseOrders.id),
    invoiceNo: text("invoice_no").notNull(),
    currency: text("currency").notNull().default("USD"),
    subtotalMinor: integer("subtotal_minor").notNull().default(0),
    shippingMinor: integer("shipping_minor").notNull().default(0),
    otherMinor: integer("other_minor").notNull().default(0),
    totalMinor: integer("total_minor").notNull(),
    fxRateMicros: integer("fx_rate_micros"),
    totalIqd: iqd("total_iqd"),
    /** "YYYY-MM-DD". */
    issuedOn: text("issued_on"),
    dueOn: text("due_on"),
    status: text("status", { enum: SUPPLIER_INVOICE_STATUSES }).notNull().default("draft"),
    discrepancies: json<InvoiceDiscrepancy[]>("discrepancies"),
    paidAt: at("paid_at"),
    paymentRef: text("payment_ref"),
    /** The invoice document — private file. */
    fileId: text("file_id").references((): Ref => files.id),
    journalEntryId: text("journal_entry_id"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("supplier_invoices_supplier_no_uq").on(t.supplierId, t.invoiceNo),
    index("supplier_invoices_po_idx").on(t.poId),
    index("supplier_invoices_status_idx").on(t.status, t.createdAt),
    index("supplier_invoices_file_idx").on(t.fileId),
  ],
);
export type SupplierInvoice = typeof supplierInvoices.$inferSelect;
export type NewSupplierInvoice = typeof supplierInvoices.$inferInsert;

export const supplierInvoiceItems = sqliteTable(
  "supplier_invoice_items",
  {
    id: id(),
    invoiceId: text("invoice_id")
      .notNull()
      .references((): Ref => supplierInvoices.id, { onDelete: "cascade" }),
    poItemId: text("po_item_id").references((): Ref => poItems.id),
    receiptItemId: text("receipt_item_id").references((): Ref => receiptItems.id),
    variantId: text("variant_id")
      .notNull()
      .references((): Ref => variants.id),
    qty: integer("qty").notNull(),
    unitCostMinor: integer("unit_cost_minor").notNull(),
  },
  (t) => [
    index("supplier_invoice_items_invoice_idx").on(t.invoiceId),
    index("supplier_invoice_items_po_item_idx").on(t.poItemId),
    index("supplier_invoice_items_receipt_item_idx").on(t.receiptItemId),
    index("supplier_invoice_items_variant_idx").on(t.variantId),
    check("supplier_invoice_items_qty_check", sql`${t.qty} > 0 AND ${t.unitCostMinor} >= 0`),
  ],
);
export type SupplierInvoiceItem = typeof supplierInvoiceItems.$inferSelect;
export type NewSupplierInvoiceItem = typeof supplierInvoiceItems.$inferInsert;

// ───────────────────────────────────────────────────────────────── landed cost (09.05, 03.02)

export const LANDED_COST_KINDS = ["freight", "customs", "insurance", "fees", "commission", "other"] as const;
export type LandedCostKind = (typeof LANDED_COST_KINDS)[number];
export const LANDED_COST_METHODS = ["by_value", "by_qty", "by_weight", "manual"] as const;
export type LandedCostMethod = (typeof LANDED_COST_METHODS)[number];
export const LANDED_COST_STATUSES = ["draft", "allocated"] as const;
export type LandedCostStatus = (typeof LANDED_COST_STATUSES)[number];

/** A freight / customs / fee bill to spread over the units of a receipt. */
export const landedCosts = sqliteTable(
  "landed_costs",
  {
    id: id(),
    receiptId: text("receipt_id")
      .notNull()
      .references((): Ref => receipts.id),
    kind: text("kind", { enum: LANDED_COST_KINDS }).notNull(),
    description: text("description"),
    currency: text("currency").notNull().default("IQD"),
    amountMinor: integer("amount_minor").notNull(),
    fxRateMicros: integer("fx_rate_micros"),
    amountIqd: iqd("amount_iqd").notNull(),
    method: text("method", { enum: LANDED_COST_METHODS }).notNull().default("by_value"),
    status: text("status", { enum: LANDED_COST_STATUSES }).notNull().default("draft"),
    supplierInvoiceId: text("supplier_invoice_id").references((): Ref => supplierInvoices.id),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
  },
  (t) => [
    index("landed_costs_receipt_idx").on(t.receiptId),
    index("landed_costs_invoice_idx").on(t.supplierInvoiceId),
    check("landed_costs_amount_check", sql`${t.amountIqd} >= 0`),
  ],
);
export type LandedCost = typeof landedCosts.$inferSelect;
export type NewLandedCost = typeof landedCosts.$inferInsert;

/** Share of a landed cost carried by one receipt line. The shares of a landed cost add up to its amount_iqd exactly. */
export const landedCostAllocations = sqliteTable(
  "landed_cost_allocations",
  {
    id: id(),
    landedCostId: text("landed_cost_id")
      .notNull()
      .references((): Ref => landedCosts.id, { onDelete: "cascade" }),
    receiptItemId: text("receipt_item_id")
      .notNull()
      .references((): Ref => receiptItems.id),
    amountIqd: iqd("amount_iqd").notNull(),
    perUnitIqd: iqd("per_unit_iqd").notNull(),
  },
  (t) => [
    uniqueIndex("landed_cost_allocations_cost_item_uq").on(t.landedCostId, t.receiptItemId),
    index("landed_cost_allocations_receipt_item_idx").on(t.receiptItemId),
    check("landed_cost_allocations_amount_check", sql`${t.amountIqd} >= 0 AND ${t.perUnitIqd} >= 0`),
  ],
);
export type LandedCostAllocation = typeof landedCostAllocations.$inferSelect;
export type NewLandedCostAllocation = typeof landedCostAllocations.$inferInsert;

// ───────────────────────────────────────────────────────────────── supplier claims (09.06)

export const SUPPLIER_CLAIM_KINDS = ["shortage", "damage", "defect", "wrong_item", "price", "return"] as const;
export type SupplierClaimKind = (typeof SUPPLIER_CLAIM_KINDS)[number];
export const SUPPLIER_CLAIM_STATUSES = ["open", "submitted", "accepted", "rejected", "credited", "closed"] as const;
export type SupplierClaimStatus = (typeof SUPPLIER_CLAIM_STATUSES)[number];

/** Shortage, damage and return-to-supplier claims; also feeds the supplier defect rate (09.08). */
export const supplierClaims = sqliteTable(
  "supplier_claims",
  {
    id: id(),
    ref: text("ref").notNull(),
    supplierId: text("supplier_id")
      .notNull()
      .references((): Ref => suppliers.id),
    poId: text("po_id").references((): Ref => purchaseOrders.id),
    receiptId: text("receipt_id").references((): Ref => receipts.id),
    kind: text("kind", { enum: SUPPLIER_CLAIM_KINDS }).notNull(),
    status: text("status", { enum: SUPPLIER_CLAIM_STATUSES }).notNull().default("open"),
    description: text("description"),
    /** Units claimed: `[{ variantId, qty, serialId? }]`. */
    items: json<Array<{ variantId: string; qty: number; serialId?: string }>>("items"),
    currency: text("currency").notNull().default("USD"),
    amountMinor: integer("amount_minor"),
    amountIqd: iqd("amount_iqd"),
    resolution: text("resolution"),
    createdBy: text("created_by"),
    createdAt: at("created_at").notNull(),
    resolvedAt: at("resolved_at"),
  },
  (t) => [
    uniqueIndex("supplier_claims_ref_uq").on(t.ref),
    index("supplier_claims_supplier_idx").on(t.supplierId, t.createdAt),
    index("supplier_claims_po_idx").on(t.poId),
    index("supplier_claims_receipt_idx").on(t.receiptId),
    index("supplier_claims_status_idx").on(t.status),
  ],
);
export type SupplierClaim = typeof supplierClaims.$inferSelect;
export type NewSupplierClaim = typeof supplierClaims.$inferInsert;
