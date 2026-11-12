/**
 * Database invariants — proven at SQL level against a real local D1 (docs/ARCHITECTURE.md §7).
 *
 * Nothing here goes through a service: every assertion is about what the DATABASE accepts or
 * refuses, so the rules hold no matter which code path writes.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";
import { readFileSync } from "node:fs";
import path from "node:path";
import { newId } from "~/lib/ids";
import { fiscalPeriodOf, journalEntryStatements, JournalEntryError } from "~/server/db/journal.server";
import {
  accounts,
  auditEvents,
  auditSeals,
  cartItems,
  carts,
  cashMovements,
  consents,
  consistencyFindings,
  customers,
  employeePasswordLinks,
  employees,
  errorReports,
  incidentLinks,
  incidents,
  perfRollups,
  roles,
  districts,
  files,
  fiscalPeriods,
  governorates,
  inboundEvents,
  inspectionTemplates,
  inventoryLocations,
  journalEntries,
  journalLines,
  loyaltyLedger,
  media,
  orderEvents,
  orderItemSerials,
  orderItems,
  orders,
  payments,
  posRegisters,
  posShifts,
  priceChanges,
  productVersions,
  products,
  refundItems,
  refunds,
  repairEvents,
  repairTickets,
  rfqQuotes,
  rfqs,
  sequences,
  serials,
  settings,
  shipmentEvents,
  shipments,
  stockLevels,
  stockMovements,
  suppliers,
  tradeInEvents,
  tradeIns,
  usedUnits,
  variants,
  walletLedger,
  wishlistItems,
  type UsedChecklist,
} from "~/server/db/schema";
import { ftsMatchQuery, normalizeSearchText, searchIndexStatements, searchProductIds } from "~/server/db/search.server";
import { CHART_OF_ACCOUNTS, DEFAULT_LOCATION_ID, IRAQ_GOVERNORATES, SETTINGS_DEFAULTS, accountId, seedReference } from "~/server/db/seed/reference";
import { TRIGGER_ERROR_CODES, batchSql, chunkRows, clearGuards, expectChanged, expectThat, isDbError, isUniqueViolation, mapDbError, runBatch, type DbErrorInfo } from "~/server/db/tx.server";
import { TEST_NOW, createTestDb, type TestDb } from "./helpers/db";
import { fixtures, type Fixtures, type OrderLineInput } from "./helpers/factories";
import { MIGRATIONS_DIR, applyMigrations, dropEverything, listMigrations } from "./helpers/migrations";

const NOW = TEST_NOW;
let t: TestDb;
let make: Fixtures;

beforeAll(async () => {
  t = await createTestDb();
  make = fixtures(t.db, NOW);
});
afterAll(async () => {
  await t?.dispose();
});

// ───────────────────────────────────────────────────────────────── helpers

const next = (prefix: string) => make.next(prefix);
const phone = () => make.phone();

/** Runs a statement that must be refused by the database and returns the parsed reason. */
async function refused(run: () => PromiseLike<unknown>): Promise<DbErrorInfo> {
  try {
    await run();
  } catch (error) {
    const info = mapDbError(error);
    if (!info) throw error;
    return info;
  }
  throw new Error("Expected the database to refuse this statement, but it was accepted.");
}

const scalar = async <T = number>(query: string, ...binds: unknown[]): Promise<T> => {
  const row = await t.d1
    .prepare(query)
    .bind(...binds)
    .first<Record<string, T>>();
  return Object.values(row ?? {})[0] as T;
};

// Fixtures come from tests/helpers/factories.ts (shared with every other database test).
const makeVariant = (options: { trackSerials?: boolean; priceIqd?: number } = {}) => make.product(options);
const makeCustomer = () => make.customer();
const makeOrder = (lines: OrderLineInput[], options: { customerId?: string } = {}) => make.order(lines, { customerId: options.customerId ?? null });
const makePayment = (orderId: string, amountIqd: number, options: { method?: "cod" | "wallet" | "bank_transfer" | "zaincash"; status?: "pending" | "pending_verification" | "paid" } = {}) =>
  make.payment(orderId, amountIqd, options);

async function simpleOrder(options: { qty?: number; customerId?: string } = {}) {
  const variant = await makeVariant();
  const order = await makeOrder([{ variantId: variant.variantId, sku: variant.sku, qty: options.qty ?? 1, unitPriceIqd: 500_000 }], { customerId: options.customerId });
  return { ...variant, ...order, itemId: order.itemIds[0] };
}

// ───────────────────────────────────────────────────────────────── schema and migrations

/** Columns named by ARCHITECTURE §6 — the contract other code is written against. */
const CONTRACT_COLUMNS: Record<string, string> = {
  settings: "key value updated_at updated_by",
  audit_events: "seq id at actor_kind actor_id actor_label action entity_type entity_id summary before after reason ip request_id",
  audit_seals: "id from_seq to_seq hash prev_hash created_at",
  files: "id storage_key visibility kind mime bytes sha256 width height owner_type owner_id created_by created_at",
  outbox: "id channel recipient template payload status attempts last_error created_at sent_at",
  rate_limits: "key window_start count",
  _tx_guard: "ok",
  platforms: "id slug name accent sort",
  device_generations: "id platform_id slug name sort",
  device_models: "id platform_id generation_id slug name summary specs released_on status",
  categories: "id parent_id slug name kind sort is_active",
  products:
    "id slug kind name short description brand platform_id device_model_id category_id specs attributes warranty_months age_rating region license_type media_format status publish_at is_demo seo created_at updated_at",
  product_versions: "id product_id version snapshot changed_by reason created_at",
  variants: "id product_id sku barcode title options price_iqd compare_at_iqd is_default is_active track_serials sort",
  variant_costs: "variant_id currency unit_cost_minor fx_rate_micros fx_date landed_cost_iqd min_margin_bps target_margin_bps updated_by updated_at",
  price_changes: "id variant_id old_price_iqd new_price_iqd reason requested_by approved_by status created_at",
  media: "id owner_type owner_id file_id art_key kind alt is_illustration sort",
  bundle_items: "bundle_variant_id component_variant_id qty",
  product_relations: "product_id related_product_id kind pinned sort",
  compatibility_rules: "id subject_type subject_id target_type target_id status note source verified_by verified_at",
  reviews: "id product_id customer_id order_item_id rating title body status is_verified_purchase created_at",
  search_synonyms: "id locale term synonyms",
  inventory_locations: "id code name kind parent_id barcode is_sellable branch_id",
  stock_levels: "variant_id location_id on_hand reserved incoming reorder_point allow_oversell",
  stock_movements: "id variant_id location_id serial_id kind qty_delta reserved_delta unit_cost_iqd ref_type ref_id reason actor_kind actor_id at",
  serials: "id serial variant_id status location_id cost_iqd source source_ref notes",
  stock_reservations: "id order_id variant_id location_id qty status expires_at created_at",
  cost_layers: "id variant_id location_id qty_remaining unit_cost_iqd received_at receipt_item_id",
  customers: "id phone_e164 name email password_hash password_iters status locale vip_tier fraud_flag notes created_at",
  guest_contacts: "id phone_e164 name created_at",
  addresses: "id customer_id label recipient_name phone_e164 governorate_id district_id area_text address_text notes is_default",
  customer_sessions: "id_hash customer_id created_at last_seen_at expires_at ip user_agent revoked_at",
  otp_codes: "id phone_e164 purpose code_hash attempts expires_at consumed_at",
  consents: "id subject_type subject_id kind granted source at",
  saved_devices: "customer_id device_model_id",
  wishlist_items: "id customer_id cart_token_hash product_id created_at",
  notifications: "id customer_id kind title body link read_at created_at",
  carts: "id token_hash customer_id coupon_code created_at updated_at",
  cart_items: "id cart_id variant_id used_unit_id qty added_at",
  orders:
    "id ref idempotency_key channel customer_id guest_contact_id status payment_status payment_method subtotal_iqd discount_iqd shipping_iqd total_iqd paid_iqd refunded_iqd coupon_id contact_name contact_phone_e164 governorate_id district_id area_text address_text notes preferred_day preferred_window marketing_consent locale access_token_hash is_demo risk_flags placed_at confirmed_at cancelled_at cancel_reason",
  order_items: "id order_id variant_id used_unit_id sku name_snapshot options_snapshot unit_price_iqd qty discount_iqd total_iqd cost_snapshot_iqd refunded_qty warranty_months",
  order_item_serials: "order_item_id serial_id",
  order_events: "id order_id kind data actor_kind actor_id at",
  payments: "id order_id method status amount_iqd declared_amount_iqd reference idempotency_key verified_by verified_at reject_reason created_at",
  payment_proofs: "id payment_id file_id declared_amount_iqd note status duplicate_of sha256 reviewed_by reviewed_at review_note created_at",
  refunds: "id order_id payment_id amount_iqd method reason status approved_by created_by created_at",
  refund_items: "refund_id order_item_id qty",
  coupons: "id code kind value min_subtotal_iqd max_discount_iqd usage_limit per_customer_limit starts_at ends_at conditions is_active",
  coupon_redemptions: "id coupon_id order_id customer_id phone_e164 amount_iqd at",
  wallet_ledger: "id customer_id amount_iqd kind ref_type ref_id reason actor_kind actor_id idempotency_key at",
  governorates: "id slug name sort is_active",
  districts: "id governorate_id name sort is_active",
  shipping_rates: "id governorate_id fee_iqd is_override is_active",
  shipments: "id order_id carrier_id tracking_no status cod_amount_iqd cod_settled_at packed_by proof_file_id shipped_at delivered_at",
  returns: "id rma order_id customer_id status reason resolution created_at",
  return_items: "return_id order_item_id qty serial_id condition inspected_by notes",
  warranties: "id order_item_id serial_id customer_id phone_e164 starts_at ends_at terms status",
  repair_tickets: "id ref customer_id phone_e164 device_model_id serial_id warranty_id issue status sla_due_at assigned_to parts cost_iqd created_at",
  used_units:
    "id slug variant_id serial_id grade battery_health_pct cosmetic_notes defects included checklist price_iqd acquisition_cost_iqd warranty_days location_id status ownership_checked_at data_wiped_at listed_at is_demo",
  inspection_templates: "id device_kind items",
  trade_ins:
    "id ref customer_id phone_e164 device_model_id variant_id answers estimate_min_iqd estimate_max_iqd estimate_expires_at status final_offer_iqd offered_by offered_at offer_expires_at payout_method serial_id ownership_ok account_lock_ok data_wiped inspection access_token_hash created_at",
  trade_in_price_guides: "id device_model_id variant_id base_iqd grade_multipliers updated_by updated_at",
  knowledge_articles: "id slug kind title body device_model_id platform_id tags audience status approved_by approved_at updated_at",
  troubleshooting_trees: "id device_model_id symptom_key title tree status approved_by",
  accounts: "id code name type",
  journal_entries: "id at period memo ref_type ref_id created_by reverses_id",
  journal_lines: "id entry_id account_id debit_iqd credit_iqd cost_center",
  fiscal_periods: "period status closed_by closed_at",
  fx_rates: "id quote iqd_per_unit source is_demo effective_at created_by",
  employees: "id email name phone password_hash password_iters totp_secret_enc totp_enabled recovery_codes status branch_id locale created_at disabled_at",
  roles: "id key name is_system",
  role_permissions: "role_id permission",
  employee_roles: "employee_id role_id",
  employee_sessions: "id_hash employee_id mfa_ok created_at last_seen_at expires_at ip user_agent revoked_at",
  approvals: "id kind entity_type entity_id requested_by payload status decided_by decided_at reason",
  pos_shifts: "id register_id opened_by opened_at opening_float_iqd closed_by closed_at counted_cash_iqd expected_cash_iqd variance_iqd status",
  recommendation_rules: "id kind context product_id weight reason created_by",
  recommendation_events: "id session_hash customer_id kind product_id source at",
  redirects: "from_path to_path code",
  inbound_events: "id",
  // migration 0004 (ARCHITECTURE §6)
  incident_links: "incident_id kind target_id created_by created_at",
  employee_password_links: "id_hash employee_id purpose created_by created_at expires_at used_at revoked_at",
};

/** Columns migration 0004 adds to existing tables (each table's other columns are checked elsewhere). */
const COLUMNS_0004: Record<string, string> = {
  roles: "requires_mfa",
  consistency_findings: "assigned_to incident_id",
  error_reports: "is_demo",
  perf_rollups: "is_demo",
};

/** Tables that ARCHITECTURE §6 names without listing columns. */
const CONTRACT_TABLES_NAMED_ONLY =
  "job_runs error_reports incidents consistency_findings search_index stock_transfers stock_transfer_items cycle_counts cycle_count_lines recently_viewed privacy_requests gift_cards loyalty_ledger carriers shipment_items shipment_events delivery_attempts cod_settlements repair_events trade_in_events support_tickets ticket_messages canned_replies assistant_sessions assistant_messages suppliers rfqs rfq_quotes purchase_orders po_items receipts receipt_items supplier_invoices landed_cost_allocations supplier_claims expenses shifts attendance commissions payroll_runs pos_registers cash_movements promotions flash_sales referral_codes memberships campaigns utm_links cart_reminders experiments experiment_assignments banners home_sections pages nav_menus workflows workflow_runs api_keys webhooks webhook_deliveries branches channels".split(
    " ",
  );

/** [A] tables of ARCHITECTURE §6. */
const APPEND_ONLY_TABLES = [
  "audit_events",
  "audit_seals",
  "product_versions",
  "price_changes",
  "stock_movements",
  "consents",
  "order_events",
  "wallet_ledger",
  "loyalty_ledger",
  "shipment_events",
  "repair_events",
  "trade_in_events",
  "journal_entries",
  "journal_lines",
  "cash_movements",
] as const;

/** Every trigger the migrations must leave in place. A table rebuild that drops one fails this list. */
const EXPECTED_TRIGGERS = [
  "_tx_guard_check",
  "_replace_guard_check",
  ...APPEND_ONLY_TABLES.flatMap((table) => [`${table}_no_delete`, `${table}_no_update`, `${table}_no_replace`]),
  "stock_levels_available_insert",
  "stock_levels_available_update",
  "serials_status_guard",
  "used_units_status_guard",
  "used_units_listable_insert",
  "used_units_listable_update",
  "media_used_unit_evidence_delete",
  "media_used_unit_evidence_update",
  "wallet_ledger_no_overdraft",
  "loyalty_ledger_no_overdraft",
  "payments_transfer_verified_insert",
  "payments_transfer_verified_update",
  "payments_refund_floor",
  "refunds_bound_insert",
  "refunds_bound_update",
  "refund_items_bound_insert",
  "refund_items_bound_update",
  "order_items_refunded_qty_insert",
  "order_items_refunded_qty_update",
  "orders_refund_bound_insert",
  "orders_refund_bound_update",
  "trade_ins_offer_guard_insert",
  "trade_ins_offer_guard_update",
  "journal_lines_sealed",
  "journal_entries_post",
].sort();

describe("schema and migrations", () => {
  test("every table and column of ARCHITECTURE §6 exists", async () => {
    const existing = new Set((await t.d1.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()).results.map((row) => row.name));
    const missingTables = [...Object.keys(CONTRACT_COLUMNS), ...CONTRACT_TABLES_NAMED_ONLY].filter((name) => !existing.has(name));
    expect(missingTables).toEqual([]);

    const missingColumns: string[] = [];
    for (const [table, columns] of [...Object.entries(CONTRACT_COLUMNS), ...Object.entries(COLUMNS_0004)]) {
      const actual = new Set((await t.d1.prepare(`SELECT name FROM pragma_table_info('${table}')`).all<{ name: string }>()).results.map((row) => row.name));
      for (const column of columns.split(" ")) if (!actual.has(column)) missingColumns.push(`${table}.${column}`);
    }
    expect(missingColumns).toEqual([]);
  });

  test("all invariant triggers are installed (and no unknown ones)", async () => {
    const triggers = (await t.d1.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all<{ name: string }>()).results.map((row) => row.name);
    expect(triggers.sort()).toEqual(EXPECTED_TRIGGERS);
  });

  test("each migration splits into the same statements for wrangler and for the breakpoint marker", () => {
    const migrations = listMigrations();
    expect(migrations.map((migration) => migration.name)).toEqual(expect.arrayContaining(["0000_base.sql", "0001_invariants.sql", "0002_search.sql", "0003_append_only_no_replace.sql", "0004_accounts_access_ops.sql"]));
    for (const migration of migrations) {
      const wranglerStatements = unstable_splitSqlQuery(readFileSync(path.join(MIGRATIONS_DIR, migration.name), "utf8"));
      expect(wranglerStatements.length, migration.name).toBe(migration.statements.length);
    }
  });

  test("every foreign key column leads an index", async () => {
    const unindexed = (
      await t.d1
        .prepare(
          `SELECT m.name AS tbl, fk."from" AS col
           FROM sqlite_master m, pragma_foreign_key_list(m.name) fk
           WHERE m.type = 'table'
             AND NOT EXISTS (
               SELECT 1 FROM pragma_index_list(m.name) il, pragma_index_info(il.name) ii
               WHERE ii.seqno = 0 AND ii.name = fk."from"
             )
           ORDER BY 1, 2`,
        )
        .all<{ tbl: string; col: string }>()
    ).results.map((row) => `${row.tbl}.${row.col}`);
    expect(unindexed).toEqual([]);
  });

  test("foreign keys are enforced", async () => {
    const variant = await makeVariant();
    const error = await refused(() =>
      t.db.insert(orderItems).values({ id: newId("oit"), orderId: "ord_missing", variantId: variant.variantId, sku: variant.sku, nameSnapshot: { ar: "x" }, unitPriceIqd: 1000, qty: 1, totalIqd: 1000 }),
    );
    expect(error).toMatchObject({ code: "FOREIGN_KEY", kind: "foreign_key", status: 409 });
  });

  test("order totals must add up (CHECK constraints)", async () => {
    const error = await refused(() =>
      t.db.insert(orders).values({ id: newId("ord"), ref: next("TT"), idempotencyKey: next("idem"), contactPhoneE164: phone(), subtotalIqd: 100_000, shippingIqd: 5000, totalIqd: 100_000, placedAt: NOW }),
    );
    expect(error).toMatchObject({ code: "CHECK", constraint: "orders_total_check", status: 422 });

    const noPhone = await refused(() => t.db.insert(orders).values({ id: newId("ord"), ref: next("TT"), idempotencyKey: next("idem"), subtotalIqd: 1000, shippingIqd: 0, totalIqd: 1000, placedAt: NOW }));
    expect(noPhone).toMatchObject({ code: "CHECK", constraint: "orders_web_phone_check" });
  });

  test("every declared relation produces a valid relational query", async () => {
    const order = await simpleOrder({ qty: 2 });
    await makePayment(order.orderId, order.totalIqd);

    const tables = (t.db as unknown as { _: { schema: Record<string, { relations: Record<string, unknown> }> } })._.schema;
    const query = t.db.query as unknown as Record<string, { findFirst(config: unknown): Promise<unknown> }>;
    const checked: string[] = [];
    for (const [tableName, config] of Object.entries(tables)) {
      for (const relationName of Object.keys(config.relations)) {
        await query[tableName].findFirst({ with: { [relationName]: true } });
        checked.push(`${tableName}.${relationName}`);
      }
    }
    expect(checked.length).toBeGreaterThan(100);

    // And the canonical aggregate loads in one round trip.
    const loaded = await t.db.query.orders.findFirst({
      where: eq(orders.id, order.orderId),
      with: { items: { with: { variant: { with: { product: true } }, serials: true } }, payments: { with: { proofs: true, refunds: true } }, governorate: { with: { districts: true } } },
    });
    expect(loaded?.items).toHaveLength(1);
    expect(loaded?.items[0]).toMatchObject({ qty: 2, variant: { id: order.variantId, product: { id: order.productId, name: { ar: "جهاز للاختبار" } } } });
    expect(loaded?.payments[0]).toMatchObject({ status: "paid", proofs: [], refunds: [] });
    expect(loaded?.governorate?.districts.length).toBeGreaterThan(10);
  });

  test("raw SQL statements are batch-safe through batchSql and runBatch", async () => {
    const name = next("sequence");
    await t.db.insert(sequences).values({ name });
    const bump = sql`UPDATE sequences SET value = value + ${5} WHERE name = ${name}`;

    await t.db.batch([batchSql(t.db, bump), expectChanged(t.db)]);
    await runBatch(t.db, [t.db.run(bump), expectChanged(t.db)]);
    expect(await scalar("SELECT value FROM sequences WHERE name = ?", name)).toBe(10);
    await expect(runBatch(t.db, [batchSql(t.db, sql`UPDATE sequences SET value = 0 WHERE name = ${"missing"}`), expectChanged(t.db, 1, "NO_SUCH_SEQUENCE")])).rejects.toThrow(/TT:NO_SUCH_SEQUENCE/);
  });

  test("getDb() works against the test database through the cloudflare:workers stand-in", async () => {
    const { getDb } = await import("~/server/db.server");
    const rows = await getDb().select().from(settings).where(eq(settings.key, "shipping.flat_fee_iqd"));
    expect(rows[0]?.value).toBe(5000);
    expect(getDb()).toBe(getDb());
  });
});

describe("carts", () => {
  test("a cart holds a variant once (add-to-cart upsert) and a used unit once", async () => {
    const variant = await makeVariant();
    const cartId = newId("crt");
    await t.db.insert(carts).values({ id: cartId, tokenHash: next("token"), createdAt: NOW, updatedAt: NOW });
    const add = (qty: number) =>
      t.db
        .insert(cartItems)
        .values({ id: newId("cit"), cartId, variantId: variant.variantId, qty, addedAt: NOW })
        .onConflictDoUpdate({ target: [cartItems.cartId, cartItems.variantId], targetWhere: sql`${cartItems.usedUnitId} IS NULL`, set: { qty: sql`${cartItems.qty} + excluded.qty` } });
    await add(1);
    await add(2);
    expect(await t.db.select({ qty: cartItems.qty }).from(cartItems).where(eq(cartItems.cartId, cartId))).toEqual([{ qty: 3 }]);

    const usedId = newId("usd");
    await t.db.insert(usedUnits).values({ id: usedId, slug: next("used"), variantId: variant.variantId, grade: "A", priceIqd: 300_000, isDemo: true, status: "listed" });
    const addUsed = () => t.db.insert(cartItems).values({ id: newId("cit"), cartId, variantId: variant.variantId, usedUnitId: usedId, qty: 1, addedAt: NOW });
    await addUsed();
    let twice: unknown;
    try {
      await addUsed();
    } catch (caught) {
      twice = caught;
    }
    expect(isUniqueViolation(twice, "cart_items.used_unit_id")).toBe(true);
    // A used unit is one physical device: its line cannot have a quantity above 1.
    expect(await refused(() => t.db.update(cartItems).set({ qty: 2 }).where(eq(cartItems.usedUnitId, usedId)))).toMatchObject({ code: "CHECK", constraint: "cart_items_qty_check" });
    // Deleting the cart removes its lines.
    await t.db.delete(carts).where(eq(carts.id, cartId));
    expect(await scalar("SELECT count(*) FROM cart_items WHERE cart_id = ?", cartId)).toBe(0);
  });
});

describe("resetting a database (scripts/db-reset.ts)", () => {
  test("dropEverything empties a populated database and the migrations apply again", async () => {
    const fresh = await createTestDb();
    try {
      const { db, d1 } = fresh;
      const ids = { product: newId("prd"), variant: newId("var"), customer: newId("cus"), order: newId("ord"), item: newId("oit"), used: newId("usd"), rfq: newId("rfq"), quote: newId("rfqq"), supplier: newId("sup") };
      // Rows that reference each other in every awkward way: cascades (wishlist), cycles
      // (order_items ⇄ used_units, rfqs ⇄ rfq_quotes), append-only history and the FTS table.
      await runBatch(db, [
        db.insert(products).values({ id: ids.product, slug: "reset-product", kind: "console", name: { ar: "جهاز" }, createdAt: NOW, updatedAt: NOW }),
        db.insert(variants).values({ id: ids.variant, productId: ids.product, sku: "RESET-1", priceIqd: 1000 }),
        db.insert(customers).values({ id: ids.customer, phoneE164: "+9647700000001", createdAt: NOW }),
        db.insert(wishlistItems).values({ id: newId("wsh"), customerId: ids.customer, productId: ids.product, createdAt: NOW }),
        db.insert(walletLedger).values({ id: newId("wal"), customerId: ids.customer, amountIqd: 1000, kind: "topup", actorKind: "system", idempotencyKey: "reset-wallet", at: NOW }),
        db.insert(usedUnits).values({ id: ids.used, slug: "reset-used", variantId: ids.variant, grade: "A", priceIqd: 1000, isDemo: true, status: "listed" }),
        db.insert(orders).values({ id: ids.order, ref: "TT-RESET", idempotencyKey: "reset-order", customerId: ids.customer, contactPhoneE164: "+9647700000001", subtotalIqd: 1000, totalIqd: 1000, placedAt: NOW }),
        db.insert(orderItems).values({ id: ids.item, orderId: ids.order, variantId: ids.variant, usedUnitId: ids.used, sku: "RESET-1", nameSnapshot: { ar: "جهاز" }, unitPriceIqd: 1000, qty: 1, totalIqd: 1000 }),
        db.update(usedUnits).set({ soldOrderItemId: ids.item }).where(eq(usedUnits.id, ids.used)),
        db.insert(orderEvents).values({ id: newId("oev"), orderId: ids.order, kind: "placed", actorKind: "system", at: NOW }),
        db.insert(suppliers).values({ id: ids.supplier, code: "RESET", name: "مورد", createdAt: NOW, updatedAt: NOW }),
        db.insert(rfqs).values({ id: ids.rfq, ref: "RFQ-RESET", title: "طلب عروض", createdAt: NOW }),
        db.insert(rfqQuotes).values({ id: ids.quote, rfqId: ids.rfq, supplierId: ids.supplier, receivedAt: NOW }),
        db.update(rfqs).set({ awardedQuoteId: ids.quote }).where(eq(rfqs.id, ids.rfq)),
        ...searchIndexStatements(db, ids.product, [{ locale: "ar", name: "جهاز للتصفير" }]),
      ]);

      const dropped = await dropEverything(d1);
      expect(dropped.triggers).toBe(EXPECTED_TRIGGERS.length);
      const left = (await d1.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'").all<{ name: string }>()).results;
      expect(left).toEqual([]);

      expect(await applyMigrations(d1)).toEqual(["0000_base.sql", "0001_invariants.sql", "0002_search.sql", "0003_append_only_no_replace.sql", "0004_accounts_access_ops.sql"]);
      expect(await applyMigrations(d1)).toEqual([]);
      await seedReference(db, NOW);
      expect((await db.select().from(governorates)).length).toBe(19);
      expect((await db.select().from(orders)).length).toBe(0);
    } finally {
      await fresh.dispose();
    }
  });
});

// ───────────────────────────────────────────────────────────────── migration 0004

describe("migration 0004 (system accounts, staff access, operations links)", () => {
  /** The hand-written account statements of 0004, as wrangler would run them. */
  const accountInserts = () => listMigrations().find((migration) => migration.name === "0004_accounts_access_ops.sql")!.statements.filter((statement) => /INSERT INTO `accounts`/.test(statement));
  const NEW_KEYS = ["employee_advances", "gift_card_liability", "salaries_payable"] as const;
  const keyed = async (d1: D1Database) =>
    (await d1.prepare(`SELECT system_key AS key, code, type, is_system AS isSystem, name FROM accounts WHERE system_key IN ('employee_advances', 'gift_card_liability', 'salaries_payable') ORDER BY system_key`).all<{ key: string; code: string; type: string; isSystem: number; name: string }>()).results;

  test("seedReference installs the three new system accounts with the chart", async () => {
    expect(CHART_OF_ACCOUNTS.map((account) => account.key)).toEqual(expect.arrayContaining([...NEW_KEYS]));
    const rows = await keyed(t.d1);
    expect(rows.map((row) => [row.key, row.code, row.type, row.isSystem])).toEqual([
      ["employee_advances", "1300", "asset", 1],
      ["gift_card_liability", "2150", "liability", 1],
      ["salaries_payable", "2200", "liability", 1],
    ]);
  });

  test("its account statements add the accounts to a chart seeded before it, keep a renumbered code free, and add nothing to an empty database", async () => {
    expect(accountInserts()).toHaveLength(3);
    const fresh = await createTestDb({ seed: false });
    try {
      // An empty database (production before /admin/setup): nothing — seedReference will install the whole chart.
      for (const statement of accountInserts()) await fresh.d1.prepare(statement).run();
      expect(await fresh.d1.prepare("SELECT count(*) AS n FROM accounts").first<{ n: number }>()).toEqual({ n: 0 });

      // A chart seeded before 0004 (no new keys), where an accountant already gave 2200 to an account of their own.
      await seedReference(fresh.db, NOW);
      await fresh.d1.prepare(`DELETE FROM accounts WHERE system_key IN ('employee_advances', 'gift_card_liability', 'salaries_payable')`).run();
      await fresh.db.insert(accounts).values({ id: newId("acc"), code: "2200", name: { ar: "حساب المحاسب" }, type: "liability" });
      for (const statement of accountInserts()) await fresh.d1.prepare(statement).run();
      const rows = await keyed(fresh.d1);
      expect(rows.map((row) => [row.key, row.code, row.type, row.isSystem])).toEqual([
        ["employee_advances", "1300", "asset", 1],
        ["gift_card_liability", "2150", "liability", 1],
        ["salaries_payable", "SYS-salaries_payable", "liability", 1],
      ]);
      expect(JSON.parse(rows[2].name)).toEqual({ ar: "رواتب مستحقة الدفع", en: "Salaries payable", ckb: "مووچەی شایستەی پێدان" });
      // the same names as the chart the seed installs
      for (const row of rows) expect(JSON.parse(row.name)).toEqual(CHART_OF_ACCOUNTS.find((account) => account.key === row.key)?.name);

      // Applied again (a replayed migration, a second seed): nothing changes.
      for (const statement of accountInserts()) await fresh.d1.prepare(statement).run();
      await seedReference(fresh.db, NOW);
      expect((await keyed(fresh.d1)).map((row) => row.code)).toEqual(["1300", "2150", "SYS-salaries_payable"]);
    } finally {
      await fresh.dispose();
    }
  });

  test("new columns start empty or false: roles do not require two-step, findings have nobody and no incident, records are not demo", async () => {
    const roleRow = await t.d1.prepare("SELECT dflt_value AS value, \"notnull\" AS required FROM pragma_table_info('roles') WHERE name = 'requires_mfa'").first<{ value: string; required: number }>();
    expect(roleRow).toEqual({ value: "false", required: 1 });
    const roleId = newId("rol");
    await t.db.insert(roles).values({ id: roleId, key: next("role_0004"), name: { ar: "دور" }, createdAt: NOW });
    expect((await t.db.select({ requiresMfa: roles.requiresMfa }).from(roles).where(eq(roles.id, roleId)).get())?.requiresMfa).toBe(false);

    const errorId = newId("err");
    await t.db.insert(errorReports).values({ id: errorId, fingerprint: next("fp"), source: "server", message: "x", firstSeenAt: NOW, lastSeenAt: NOW });
    expect((await t.db.select({ isDemo: errorReports.isDemo }).from(errorReports).where(eq(errorReports.id, errorId)).get())?.isDemo).toBe(false);
    await t.db.insert(perfRollups).values({ day: "2026-11-10", area: "admin", route: `/admin/${next("route")}`, metric: "server_ms" });
    expect(await scalar("SELECT count(*) FROM perf_rollups WHERE is_demo = 0 AND metric = 'server_ms'")).toBeGreaterThan(0);
  });

  test("incident links: three kinds only, one row per link, gone with their incident; a finding's incident is cleared when the incident goes", async () => {
    const incidentId = newId("inc");
    await t.db.insert(incidents).values({ id: incidentId, ref: next("INC"), title: "تجربة", startedAt: NOW, createdAt: NOW, updatedAt: NOW });
    const findingId = newId("cfd");
    await t.db.insert(consistencyFindings).values({ id: findingId, fingerprint: next("cfp"), checkKey: "stock.levels_vs_movements", message: "x", detectedAt: NOW, lastSeenAt: NOW, assignedTo: "emp_someone", incidentId });
    await t.db.insert(incidentLinks).values([
      { incidentId, kind: "finding", targetId: findingId, createdAt: NOW },
      { incidentId, kind: "run", targetId: "job_x", createdAt: NOW },
      { incidentId, kind: "error", targetId: "err_x", createdAt: NOW },
    ]);
    expect(await refused(() => t.db.insert(incidentLinks).values({ incidentId, kind: "order" as never, targetId: "ord_x", createdAt: NOW }))).toMatchObject({ code: "CHECK", constraint: "incident_links_kind_check" });
    let twice: unknown;
    try {
      await t.db.insert(incidentLinks).values({ incidentId, kind: "run", targetId: "job_x", createdAt: NOW });
    } catch (caught) {
      twice = caught;
    }
    expect(isUniqueViolation(twice)).toBe(true);
    expect(await refused(() => t.db.insert(incidentLinks).values({ incidentId: "inc_missing", kind: "run", targetId: "job_y", createdAt: NOW }))).toMatchObject({ code: "FOREIGN_KEY" });

    await t.db.delete(incidents).where(eq(incidents.id, incidentId));
    expect(await scalar("SELECT count(*) FROM incident_links WHERE incident_id = ?", incidentId)).toBe(0);
    expect(await t.db.select({ incidentId: consistencyFindings.incidentId, assignedTo: consistencyFindings.assignedTo }).from(consistencyFindings).where(eq(consistencyFindings.id, findingId)).get()).toEqual({ incidentId: null, assignedTo: "emp_someone" });
  });

  test("password links belong to an employee and go with them; only the hash is a key", async () => {
    const employeeId = await make.employee();
    const idHash = next("hash");
    await t.db.insert(employeePasswordLinks).values({ idHash, employeeId, purpose: "welcome", createdAt: NOW, expiresAt: NOW + 3_600_000 });
    expect(await refused(() => t.db.insert(employeePasswordLinks).values({ idHash: next("hash"), employeeId: "emp_missing", purpose: "reset", createdAt: NOW, expiresAt: NOW }))).toMatchObject({ code: "FOREIGN_KEY" });
    await t.db.delete(employees).where(eq(employees.id, employeeId));
    expect(await scalar("SELECT count(*) FROM employee_password_links WHERE id_hash = ?", idHash)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── §7.1 stock

describe("stock never goes negative (§7.1)", () => {
  test("reserving or removing more than is available is refused", async () => {
    const { variantId } = await makeVariant();
    await t.db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: 2 });
    const level = and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID));

    await t.db.update(stockLevels).set({ reserved: 2 }).where(level);

    const overReserve = await refused(() => t.db.update(stockLevels).set({ reserved: sql`${stockLevels.reserved} + 1` }).where(level));
    expect(overReserve).toMatchObject({ code: "INSUFFICIENT_STOCK", detail: variantId, kind: "trigger", status: 409 });

    const overRemove = await refused(() => t.db.update(stockLevels).set({ onHand: sql`${stockLevels.onHand} - 1` }).where(level));
    expect(overRemove).toMatchObject({ code: "INSUFFICIENT_STOCK", detail: variantId });

    const [row] = await t.db.select().from(stockLevels).where(level);
    expect(row).toMatchObject({ onHand: 2, reserved: 2 });
  });

  test("a new level cannot start below zero", async () => {
    const { variantId } = await makeVariant();
    const error = await refused(() => t.db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: 0, reserved: 1 }));
    expect(error).toMatchObject({ code: "INSUFFICIENT_STOCK", detail: variantId });
    expect(await scalar("SELECT count(*) FROM stock_levels WHERE variant_id = ?", variantId)).toBe(0);
  });

  test("allow_oversell = 1 permits it, and cannot be switched off while stock is oversold", async () => {
    const { variantId } = await makeVariant();
    const level = and(eq(stockLevels.variantId, variantId), eq(stockLevels.locationId, DEFAULT_LOCATION_ID));
    await t.db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: 1, allowOversell: true });

    await t.db.update(stockLevels).set({ reserved: 3 }).where(level);
    await t.db.update(stockLevels).set({ onHand: -2, reserved: 0 }).where(level);
    expect((await t.db.select().from(stockLevels).where(level))[0]).toMatchObject({ onHand: -2, reserved: 0, allowOversell: true });

    const error = await refused(() => t.db.update(stockLevels).set({ allowOversell: false }).where(level));
    expect(error).toMatchObject({ code: "INSUFFICIENT_STOCK", detail: variantId });
  });

  test("the rule also holds for upserts and inside a batch (the whole batch rolls back)", async () => {
    const { variantId } = await makeVariant();
    const upsert = (delta: number) =>
      t.db
        .insert(stockLevels)
        .values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: delta })
        .onConflictDoUpdate({ target: [stockLevels.variantId, stockLevels.locationId], set: { onHand: sql`${stockLevels.onHand} + excluded.on_hand` } });

    await upsert(5);
    await upsert(-1); // attempted insert of -1 conflicts and becomes 5 - 1
    expect(await scalar("SELECT on_hand FROM stock_levels WHERE variant_id = ?", variantId)).toBe(4);

    const movementId = newId("mov");
    const error = await refused(() =>
      t.db.batch([
        t.db.insert(stockMovements).values({ id: movementId, variantId, locationId: DEFAULT_LOCATION_ID, kind: "sale", qtyDelta: -9, actorKind: "system", at: NOW }),
        upsert(-9),
      ]),
    );
    expect(error).toMatchObject({ code: "INSUFFICIENT_STOCK", detail: variantId });
    expect(await scalar("SELECT on_hand FROM stock_levels WHERE variant_id = ?", variantId)).toBe(4);
    expect(await scalar("SELECT count(*) FROM stock_movements WHERE id = ?", movementId)).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── §7.2 serials

describe("a serial is sold once (§7.2)", () => {
  async function makeSerial(variantId: string, status: "in_stock" | "reserved" | "intake" = "in_stock") {
    const id = newId("ser");
    await t.db.insert(serials).values({ id, serial: next("SN"), variantId, status, locationId: DEFAULT_LOCATION_ID });
    return id;
  }

  test("a serial cannot be attached to two order items", async () => {
    const variant = await makeVariant({ trackSerials: true });
    const serialId = await makeSerial(variant.variantId);
    const first = await makeOrder([{ variantId: variant.variantId, sku: variant.sku, qty: 1, unitPriceIqd: 500_000 }]);
    const second = await makeOrder([{ variantId: variant.variantId, sku: variant.sku, qty: 1, unitPriceIqd: 500_000 }]);

    await t.db.insert(orderItemSerials).values({ orderItemId: first.itemIds[0], serialId });
    let error: unknown;
    try {
      await t.db.insert(orderItemSerials).values({ orderItemId: second.itemIds[0], serialId });
    } catch (caught) {
      error = caught;
    }
    expect(mapDbError(error)).toMatchObject({ code: "UNIQUE", table: "order_item_serials", columns: ["serial_id"], status: 409 });
    expect(isUniqueViolation(error, "order_item_serials.serial_id")).toBe(true);
    expect(await scalar("SELECT count(*) FROM order_item_serials WHERE serial_id = ?", serialId)).toBe(1);
  });

  test("after the first sale is released (return), the unit can be sold again and history is kept", async () => {
    const variant = await makeVariant({ trackSerials: true });
    const serialId = await makeSerial(variant.variantId);
    const first = await makeOrder([{ variantId: variant.variantId, sku: variant.sku, qty: 1, unitPriceIqd: 500_000 }]);
    const second = await makeOrder([{ variantId: variant.variantId, sku: variant.sku, qty: 1, unitPriceIqd: 500_000 }]);

    await t.db.insert(orderItemSerials).values({ orderItemId: first.itemIds[0], serialId });
    await t.db.update(orderItemSerials).set({ releasedAt: NOW }).where(eq(orderItemSerials.serialId, serialId));
    await t.db.insert(orderItemSerials).values({ orderItemId: second.itemIds[0], serialId });

    expect(await scalar("SELECT count(*) FROM order_item_serials WHERE serial_id = ?", serialId)).toBe(2);
    expect(await scalar("SELECT count(*) FROM order_item_serials WHERE serial_id = ? AND released_at IS NULL", serialId)).toBe(1);
  });

  test("status only moves to sold from in_stock or reserved, and to reserved from in_stock", async () => {
    const { variantId } = await makeVariant({ trackSerials: true });
    const sellable = await makeSerial(variantId);
    await t.db.update(serials).set({ status: "reserved" }).where(eq(serials.id, sellable));
    await t.db.update(serials).set({ status: "sold" }).where(eq(serials.id, sellable));

    const soldTwice = await refused(() => t.db.update(serials).set({ status: "sold" }).where(eq(serials.id, sellable)));
    expect(soldTwice).toMatchObject({ code: "SERIAL_NOT_AVAILABLE", detail: sellable });
    const reserveSold = await refused(() => t.db.update(serials).set({ status: "reserved" }).where(eq(serials.id, sellable)));
    expect(reserveSold).toMatchObject({ code: "SERIAL_NOT_AVAILABLE", detail: sellable });

    const notReceived = await makeSerial(variantId, "intake");
    const sellIntake = await refused(() => t.db.update(serials).set({ status: "sold" }).where(eq(serials.id, notReceived)));
    expect(sellIntake).toMatchObject({ code: "SERIAL_NOT_AVAILABLE", detail: notReceived });

    // A returned unit goes back to stock and can then be sold again.
    await t.db.update(serials).set({ status: "returned" }).where(eq(serials.id, sellable));
    await t.db.update(serials).set({ status: "in_stock" }).where(eq(serials.id, sellable));
    await t.db.update(serials).set({ status: "sold" }).where(eq(serials.id, sellable));
    expect(await scalar<string>("SELECT status FROM serials WHERE id = ?", sellable)).toBe("sold");
  });
});

// ───────────────────────────────────────────────────────────────── §7.5 wallet

describe("the wallet is a ledger (§7.5)", () => {
  const entry = (customerId: string, amountIqd: number, kind: "topup" | "purchase" | "refund" = amountIqd > 0 ? "topup" : "purchase", key = next("wallet")) =>
    t.db.insert(walletLedger).values({ id: newId("wal"), customerId, amountIqd, kind, actorKind: "system", idempotencyKey: key, at: NOW });

  test("an overdraft is refused and SUM(amount_iqd) is the balance", async () => {
    const customerId = await makeCustomer();
    const balance = () => scalar("SELECT coalesce(sum(amount_iqd), 0) FROM wallet_ledger WHERE customer_id = ?", customerId);

    const emptyWallet = await refused(() => entry(customerId, -1));
    expect(emptyWallet).toMatchObject({ code: "WALLET_OVERDRAFT", detail: customerId, status: 409 });

    await entry(customerId, 10_000);
    await entry(customerId, -4_000);
    expect(await balance()).toBe(6_000);

    const tooMuch = await refused(() => entry(customerId, -6_001));
    expect(tooMuch).toMatchObject({ code: "WALLET_OVERDRAFT", detail: customerId });
    expect(await balance()).toBe(6_000);

    await entry(customerId, -6_000);
    expect(await balance()).toBe(0);
    expect(await scalar("SELECT count(*) FROM wallet_ledger WHERE customer_id = ?", customerId)).toBe(3);
  });

  test("one customer's balance never covers another's debit", async () => {
    const rich = await makeCustomer();
    const poor = await makeCustomer();
    await entry(rich, 500_000);
    expect(await refused(() => entry(poor, -1_000))).toMatchObject({ code: "WALLET_OVERDRAFT", detail: poor });
  });

  test("guests have no wallet: an entry needs an existing customer", async () => {
    const noCustomer = await refused(() =>
      t.d1.prepare("INSERT INTO wallet_ledger (id, amount_iqd, kind, actor_kind, idempotency_key, at) VALUES (?, 1000, 'topup', 'system', ?, ?)").bind(newId("wal"), next("wallet"), NOW).run(),
    );
    expect(noCustomer).toMatchObject({ code: "NOT_NULL", table: "wallet_ledger", columns: ["customer_id"] });
    expect(await refused(() => entry("cus_does_not_exist", 1_000))).toMatchObject({ code: "FOREIGN_KEY" });
  });

  test("a debit inside a batch that overdraws rolls the whole batch back", async () => {
    const customerId = await makeCustomer();
    await entry(customerId, 20_000);
    const { orderId } = await simpleOrder({ customerId });
    const eventId = newId("oev");
    const error = await refused(() =>
      t.db.batch([
        t.db.insert(orderEvents).values({ id: eventId, orderId, kind: "wallet_payment", actorKind: "customer", actorId: customerId, at: NOW }),
        entry(customerId, -20_001),
      ]),
    );
    expect(error.code).toBe("WALLET_OVERDRAFT");
    expect(await scalar("SELECT count(*) FROM order_events WHERE id = ?", eventId)).toBe(0);
    expect(await scalar("SELECT sum(amount_iqd) FROM wallet_ledger WHERE customer_id = ?", customerId)).toBe(20_000);
  });

  test("a retried debit with the same idempotency key cannot move money twice", async () => {
    const customerId = await makeCustomer();
    await entry(customerId, 50_000);
    await entry(customerId, -50_000, "purchase", "order:retry-test:wallet");

    let duplicate: unknown;
    try {
      await entry(customerId, -50_000, "purchase", "order:retry-test:wallet");
    } catch (caught) {
      duplicate = caught;
    }
    expect(isUniqueViolation(duplicate, "wallet_ledger.idempotency_key")).toBe(true);

    // The same retry written as "insert if new" is a silent no-op — not an overdraft error.
    await t.db
      .insert(walletLedger)
      .values({ id: newId("wal"), customerId, amountIqd: -50_000, kind: "purchase", actorKind: "system", idempotencyKey: "order:retry-test:wallet", at: NOW })
      .onConflictDoNothing({ target: walletLedger.idempotencyKey });
    expect(await scalar("SELECT sum(amount_iqd) FROM wallet_ledger WHERE customer_id = ?", customerId)).toBe(0);
  });

  test("loyalty points follow the same rule", async () => {
    const customerId = await makeCustomer();
    const points = (amount: number, kind: "earn" | "redeem") =>
      t.db.insert(loyaltyLedger).values({ id: newId("loy"), customerId, points: amount, kind, actorKind: "system", idempotencyKey: next("loyalty"), at: NOW });
    await points(120, "earn");
    await points(-100, "redeem");
    expect(await refused(() => points(-21, "redeem"))).toMatchObject({ code: "LOYALTY_OVERDRAFT", detail: customerId });
    expect(await scalar("SELECT sum(points) FROM loyalty_ledger WHERE customer_id = ?", customerId)).toBe(20);
  });
});

// ───────────────────────────────────────────────────────────────── §7.4 refunds

describe("refunds are bounded (§7.4)", () => {
  const refund = (orderId: string, paymentId: string, amountIqd: number, status: "pending" | "approved" | "paid" | "rejected" | "cancelled" = "pending", id = newId("ref")) =>
    t.db.insert(refunds).values({ id, orderId, paymentId, amountIqd, method: "original", status, createdAt: NOW });

  test("refunds of a payment never exceed what was paid", async () => {
    const { orderId } = await simpleOrder();
    const paymentId = await makePayment(orderId, 50_000);

    await refund(orderId, paymentId, 30_000);
    await refund(orderId, paymentId, 20_000, "approved");
    const over = await refused(() => refund(orderId, paymentId, 1));
    expect(over).toMatchObject({ code: "REFUND_EXCEEDS_PAYMENT", detail: paymentId, status: 409 });
    expect(await scalar("SELECT sum(amount_iqd) FROM refunds WHERE payment_id = ?", paymentId)).toBe(50_000);
  });

  test("rejected and cancelled refunds do not count, and cannot be revived past the limit", async () => {
    const { orderId } = await simpleOrder();
    const paymentId = await makePayment(orderId, 50_000);
    const rejectedId = newId("ref");

    await refund(orderId, paymentId, 50_000, "rejected", rejectedId);
    await refund(orderId, paymentId, 50_000, "cancelled");
    await refund(orderId, paymentId, 50_000, "paid");

    const revive = await refused(() => t.db.update(refunds).set({ status: "pending" }).where(eq(refunds.id, rejectedId)));
    expect(revive).toMatchObject({ code: "REFUND_EXCEEDS_PAYMENT", detail: paymentId });
    const raise = await refused(() => t.db.update(refunds).set({ amountIqd: 50_001 }).where(and(eq(refunds.paymentId, paymentId), eq(refunds.status, "paid"))));
    expect(raise).toMatchObject({ code: "REFUND_EXCEEDS_PAYMENT", detail: paymentId });
  });

  test("an unpaid payment has nothing to refund, and a refunded payment cannot be un-paid", async () => {
    const { orderId } = await simpleOrder();
    const pending = await makePayment(orderId, 50_000, { method: "bank_transfer", status: "pending_verification" });
    expect(await refused(() => refund(orderId, pending, 1_000))).toMatchObject({ code: "REFUND_EXCEEDS_PAYMENT", detail: pending });

    const paid = await makePayment(orderId, 50_000);
    await refund(orderId, paid, 40_000, "paid");
    expect(await refused(() => t.db.update(payments).set({ status: "cancelled" }).where(eq(payments.id, paid)))).toMatchObject({ code: "REFUND_EXCEEDS_PAYMENT", detail: paid });
    expect(await refused(() => t.db.update(payments).set({ amountIqd: 39_999 }).where(eq(payments.id, paid)))).toMatchObject({ code: "REFUND_EXCEEDS_PAYMENT", detail: paid });
    await t.db.update(payments).set({ amountIqd: 40_000 }).where(eq(payments.id, paid));
  });

  test("every refund references a payment of the same order", async () => {
    const first = await simpleOrder();
    const second = await simpleOrder();
    const paymentOfSecond = await makePayment(second.orderId, 50_000);
    const refundId = newId("ref");

    expect(await refused(() => refund(first.orderId, paymentOfSecond, 1_000, "pending", refundId))).toMatchObject({ code: "REFUND_PAYMENT_MISMATCH", detail: refundId });
    const withoutPayment = await refused(() =>
      t.d1.prepare("INSERT INTO refunds (id, order_id, amount_iqd, method, status, created_at) VALUES (?, ?, 1000, 'cash', 'pending', ?)").bind(newId("ref"), first.orderId, NOW).run(),
    );
    expect(withoutPayment).toMatchObject({ code: "NOT_NULL", table: "refunds", columns: ["payment_id"] });
  });

  test("refunded quantity never exceeds the quantity bought", async () => {
    const order = await simpleOrder({ qty: 2 });
    const paymentId = await makePayment(order.orderId, order.totalIqd);
    const refundIds = [newId("ref"), newId("ref"), newId("ref"), newId("ref")];
    for (const id of refundIds.slice(0, 3)) await refund(order.orderId, paymentId, 1_000, "pending", id);
    await refund(order.orderId, paymentId, 1_000, "rejected", refundIds[3]);

    await t.db.insert(refundItems).values({ refundId: refundIds[0], orderItemId: order.itemId, qty: 1 });
    await t.db.insert(refundItems).values({ refundId: refundIds[1], orderItemId: order.itemId, qty: 1 });
    // A rejected refund's lines are ignored…
    await t.db.insert(refundItems).values({ refundId: refundIds[3], orderItemId: order.itemId, qty: 2 });

    const third = await refused(() => t.db.insert(refundItems).values({ refundId: refundIds[2], orderItemId: order.itemId, qty: 1 }));
    expect(third).toMatchObject({ code: "REFUND_QTY_EXCEEDS", detail: order.itemId, status: 409 });
    const grow = await refused(() => t.db.update(refundItems).set({ qty: 2 }).where(eq(refundItems.refundId, refundIds[0])));
    expect(grow).toMatchObject({ code: "REFUND_QTY_EXCEEDS", detail: order.itemId });
    // …until someone tries to revive it.
    const revive = await refused(() => t.db.update(refunds).set({ status: "pending" }).where(eq(refunds.id, refundIds[3])));
    expect(revive).toMatchObject({ code: "REFUND_QTY_EXCEEDS", detail: order.itemId });

    expect(await scalar("SELECT sum(ri.qty) FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id WHERE ri.order_item_id = ? AND r.status NOT IN ('rejected','cancelled')", order.itemId)).toBe(2);
  });

  test("refund lines must belong to the refunded order; the order mirrors obey the same bounds", async () => {
    const order = await simpleOrder({ qty: 2 });
    const other = await simpleOrder();
    const paymentId = await makePayment(order.orderId, order.totalIqd);
    const refundId = newId("ref");
    await refund(order.orderId, paymentId, 1_000, "pending", refundId);

    expect(await refused(() => t.db.insert(refundItems).values({ refundId, orderItemId: other.itemId, qty: 1 }))).toMatchObject({ code: "REFUND_ITEM_MISMATCH", detail: other.itemId });

    await t.db.update(orderItems).set({ refundedQty: 2 }).where(eq(orderItems.id, order.itemId));
    expect(await refused(() => t.db.update(orderItems).set({ refundedQty: 3 }).where(eq(orderItems.id, order.itemId)))).toMatchObject({ code: "REFUND_QTY_EXCEEDS", detail: order.itemId });

    await t.db.update(orders).set({ paidIqd: order.totalIqd, refundedIqd: order.totalIqd }).where(eq(orders.id, order.orderId));
    expect(await refused(() => t.db.update(orders).set({ refundedIqd: order.totalIqd + 1 }).where(eq(orders.id, order.orderId)))).toMatchObject({
      code: "ORDER_REFUND_EXCEEDS_PAID",
      detail: order.orderId,
    });

    // Moving a refund onto another order's payment is caught as well.
    const paymentOfOther = await makePayment(other.orderId, other.totalIqd);
    expect(await refused(() => t.db.update(refunds).set({ paymentId: paymentOfOther }).where(eq(refunds.id, refundId)))).toMatchObject({ code: "REFUND_PAYMENT_MISMATCH", detail: refundId });

    // Rows cannot be created already out of bounds.
    const variant = await makeVariant();
    const bornRefunded = newId("ord");
    expect(
      await refused(() =>
        t.db.insert(orders).values({ id: bornRefunded, ref: next("TT"), idempotencyKey: next("idem"), contactPhoneE164: phone(), subtotalIqd: 1000, totalIqd: 1000, paidIqd: 500, refundedIqd: 501, placedAt: NOW }),
      ),
    ).toMatchObject({ code: "ORDER_REFUND_EXCEEDS_PAID", detail: bornRefunded });
    const bornOverRefunded = newId("oit");
    expect(
      await refused(() =>
        t.db.insert(orderItems).values({ id: bornOverRefunded, orderId: order.orderId, variantId: variant.variantId, sku: variant.sku, nameSnapshot: { ar: "x" }, unitPriceIqd: 1000, qty: 1, totalIqd: 1000, refundedQty: 2 }),
      ),
    ).toMatchObject({ code: "REFUND_QTY_EXCEEDS", detail: bornOverRefunded });
  });
});

// ───────────────────────────────────────────────────────────────── §7.6 manual transfers

describe("manual transfers are never auto-paid (§7.6)", () => {
  test("a bank or Zain Cash payment cannot be paid without a verifier", async () => {
    const { orderId } = await simpleOrder();

    for (const method of ["bank_transfer", "zaincash"] as const) {
      const direct = newId("pay");
      const inserted = await refused(() => t.db.insert(payments).values({ id: direct, orderId, method, status: "paid", amountIqd: 505_000, idempotencyKey: next("pay-idem"), createdAt: NOW }));
      expect(inserted).toMatchObject({ code: "PAYMENT_NOT_VERIFIED", detail: direct });

      const pending = await makePayment(orderId, 505_000, { method, status: "pending_verification" });
      const updated = await refused(() => t.db.update(payments).set({ status: "paid" }).where(eq(payments.id, pending)));
      expect(updated).toMatchObject({ code: "PAYMENT_NOT_VERIFIED", detail: pending });
      expect(await scalar<string>("SELECT status FROM payments WHERE id = ?", pending)).toBe("pending_verification");

      await t.db.update(payments).set({ status: "paid", verifiedBy: "emp_verifier", verifiedAt: NOW, paidAt: NOW }).where(eq(payments.id, pending));
      expect(await scalar<string>("SELECT status FROM payments WHERE id = ?", pending)).toBe("paid");
      expect(await refused(() => t.db.update(payments).set({ verifiedBy: null }).where(eq(payments.id, pending)))).toMatchObject({ code: "PAYMENT_NOT_VERIFIED" });
    }

    // Cash on delivery is collected, not verified from a proof.
    await makePayment(orderId, 505_000, { method: "cod", status: "paid" });
  });
});

// ───────────────────────────────────────────────────────────────── §7.8 append-only

describe("append-only history (§7.8)", () => {
  test("every [A] table refuses UPDATE and DELETE", async () => {
    // One row in each of the fifteen tables.
    const customerId = await makeCustomer();
    const order = await simpleOrder({ customerId });
    const shipmentId = newId("shp");
    const repairId = newId("rep");
    const tradeInId = newId("tin");
    const registerId = newId("reg");
    const shiftId = newId("psh");
    const entryId = newId("je");

    await runBatch(t.db, [
      t.db.insert(auditEvents).values({ id: newId("aud"), at: NOW, actorKind: "system", action: "test.audit.write", entityType: "test", entityId: "1" }),
      t.db.insert(auditSeals).values({ id: newId("seal"), fromSeq: 1, toSeq: 1, hash: "h1", createdAt: NOW }),
      t.db.insert(productVersions).values({ id: newId("pv"), productId: order.productId, version: 1, snapshot: { name: "x" }, createdAt: NOW }),
      t.db.insert(priceChanges).values({ id: newId("pc"), variantId: order.variantId, oldPriceIqd: 500_000, newPriceIqd: 480_000, status: "applied", createdAt: NOW }),
      t.db.insert(stockMovements).values({ id: newId("mov"), variantId: order.variantId, locationId: DEFAULT_LOCATION_ID, kind: "receive", qtyDelta: 1, actorKind: "system", at: NOW }),
      t.db.insert(consents).values({ id: newId("con"), subjectType: "customer", subjectId: customerId, kind: "marketing", granted: false, at: NOW }),
      t.db.insert(orderEvents).values({ id: newId("oev"), orderId: order.orderId, kind: "placed", actorKind: "customer", actorId: customerId, at: NOW }),
      t.db.insert(walletLedger).values({ id: newId("wal"), customerId, amountIqd: 1_000, kind: "topup", actorKind: "system", idempotencyKey: next("wallet"), at: NOW }),
      t.db.insert(loyaltyLedger).values({ id: newId("loy"), customerId, points: 10, kind: "earn", actorKind: "system", idempotencyKey: next("loyalty"), at: NOW }),
      t.db.insert(shipments).values({ id: shipmentId, orderId: order.orderId }),
      t.db.insert(shipmentEvents).values({ id: newId("sev"), shipmentId, kind: "packed", actorKind: "system", at: NOW }),
      t.db.insert(repairTickets).values({ id: repairId, ref: next("RP"), phoneE164: phone(), issue: "لا يعمل", createdAt: NOW }),
      t.db.insert(repairEvents).values({ id: newId("rev"), ticketId: repairId, kind: "created", actorKind: "system", at: NOW }),
      t.db.insert(tradeIns).values({ id: tradeInId, ref: next("TI"), phoneE164: phone(), createdAt: NOW }),
      t.db.insert(tradeInEvents).values({ id: newId("tev"), tradeInId, kind: "submitted", actorKind: "guest", at: NOW }),
      t.db.insert(posRegisters).values({ id: registerId, code: next("REG"), name: "الكاشير 1", createdAt: NOW }),
      t.db.insert(posShifts).values({ id: shiftId, registerId, openedBy: "emp_test", openedAt: NOW }),
      t.db.insert(cashMovements).values({ id: newId("cm"), shiftId, kind: "pay_in", amountIqd: 5_000, actorKind: "employee", actorId: "emp_test", at: NOW }),
      ...journalEntryStatements(t.db, {
        id: entryId,
        at: NOW,
        memo: "قيد للاختبار",
        lines: [
          { accountId: accountId("cash"), debitIqd: 5_000 },
          { accountId: accountId("sales_revenue"), creditIqd: 5_000 },
        ],
      }),
    ]);

    for (const table of APPEND_ONLY_TABLES) {
      const before = await scalar(`SELECT count(*) FROM ${table}`);
      expect(before, `${table} has a row to protect`).toBeGreaterThan(0);

      const firstColumn = await scalar<string>(`SELECT name FROM pragma_table_info('${table}') WHERE pk = 0 LIMIT 1`);
      const update = await refused(() => t.d1.prepare(`UPDATE ${table} SET ${firstColumn} = ${firstColumn}`).run());
      expect(update, `UPDATE ${table}`).toMatchObject({ code: "IMMUTABLE", detail: table, kind: "trigger", status: 409 });

      const remove = await refused(() => t.d1.prepare(`DELETE FROM ${table}`).run());
      expect(remove, `DELETE ${table}`).toMatchObject({ code: "IMMUTABLE", detail: table });

      expect(await scalar(`SELECT count(*) FROM ${table}`), `${table} row count`).toBe(before);
    }
  });

  test("an upsert cannot rewrite history either", async () => {
    const customerId = await makeCustomer();
    const key = next("wallet");
    await t.db.insert(walletLedger).values({ id: newId("wal"), customerId, amountIqd: 1_000, kind: "topup", actorKind: "system", idempotencyKey: key, at: NOW });
    const error = await refused(() =>
      t.db
        .insert(walletLedger)
        .values({ id: newId("wal"), customerId, amountIqd: 9_000_000, kind: "topup", actorKind: "system", idempotencyKey: key, at: NOW })
        .onConflictDoUpdate({ target: walletLedger.idempotencyKey, set: { amountIqd: 9_000_000 } }),
    );
    expect(error).toMatchObject({ code: "IMMUTABLE", detail: "wallet_ledger" });
    expect(await scalar("SELECT sum(amount_iqd) FROM wallet_ledger WHERE customer_id = ?", customerId)).toBe(1_000);
  });

  // ── INSERT OR REPLACE (drizzle/0003_append_only_no_replace.sql) ──────────────────────────────
  // SQLite settles a REPLACE conflict by deleting the old row without firing DELETE triggers, so the
  // UPDATE / DELETE triggers above cannot see it. Each [A] table has a <table>_no_replace guard: a
  // REPLACE that meets an existing primary key or other UNIQUE key is refused, and every other way of
  // inserting behaves exactly as it did without the guard.

  type ReplaceTarget = {
    table: (typeof APPEND_ONLY_TABLES)[number];
    /** The protected row, as stored. */
    row: Record<string, unknown>;
    /** The columns of each UNIQUE key of the table, primary key first. */
    keys: string[][];
    /** Per key column, a value no row has: lets a statement meet ONE key and miss the others. */
    fresh: Record<string, unknown>;
    /** What the rewrite would change. */
    change: [column: string, value: unknown];
  };

  /** One row in each of the fifteen tables, with every UNIQUE key filled in. */
  async function replaceTargets(): Promise<ReplaceTarget[]> {
    const customerId = await makeCustomer();
    const order = await simpleOrder({ customerId });
    const shipmentId = newId("shp");
    const repairId = newId("rep");
    const tradeInId = newId("tin");
    const registerId = newId("reg");
    const shiftId = newId("psh");
    const id = {
      audit: newId("aud"),
      seal: newId("seal"),
      version: newId("pv"),
      price: newId("pc"),
      movement: newId("mov"),
      consent: newId("con"),
      event: newId("oev"),
      wallet: newId("wal"),
      loyalty: newId("loy"),
      shipmentEvent: newId("sev"),
      repairEvent: newId("rev"),
      tradeInEvent: newId("tev"),
      entry: newId("je"),
      reversal: newId("je"),
      cash: newId("cm"),
    };
    // Seal ranges are UNIQUE across the log: stay clear of the ones other tests wrote.
    const sealFrom = (await scalar<number>("SELECT coalesce(max(to_seq), 0) FROM audit_seals")) + 1_000;
    const lines = (debit: string, credit: string) => [
      { accountId: debit, debitIqd: 7_000 },
      { accountId: credit, creditIqd: 7_000 },
    ];
    await runBatch(t.db, [
      t.db.insert(auditEvents).values({ id: id.audit, at: NOW, actorKind: "system", action: "test.replace.target" }),
      t.db.insert(auditSeals).values({ id: id.seal, fromSeq: sealFrom, toSeq: sealFrom + 1, hash: "a".repeat(64), createdAt: NOW }),
      t.db.insert(productVersions).values({ id: id.version, productId: order.productId, version: 1, snapshot: { name: "x" }, createdAt: NOW }),
      t.db.insert(priceChanges).values({ id: id.price, variantId: order.variantId, oldPriceIqd: 500_000, newPriceIqd: 490_000, status: "applied", createdAt: NOW }),
      t.db.insert(stockMovements).values({ id: id.movement, variantId: order.variantId, locationId: DEFAULT_LOCATION_ID, kind: "receive", qtyDelta: 1, actorKind: "system", at: NOW }),
      t.db.insert(consents).values({ id: id.consent, subjectType: "customer", subjectId: customerId, kind: "marketing", granted: true, at: NOW }),
      t.db.insert(orderEvents).values({ id: id.event, orderId: order.orderId, kind: "placed", actorKind: "system", at: NOW }),
      t.db.insert(walletLedger).values({ id: id.wallet, customerId, amountIqd: 25_000, kind: "topup", actorKind: "system", idempotencyKey: next("wallet"), at: NOW }),
      t.db.insert(loyaltyLedger).values({ id: id.loyalty, customerId, points: 40, kind: "earn", actorKind: "system", idempotencyKey: next("loyalty"), at: NOW }),
      t.db.insert(shipments).values({ id: shipmentId, orderId: order.orderId }),
      t.db.insert(shipmentEvents).values({ id: id.shipmentEvent, shipmentId, kind: "packed", actorKind: "system", at: NOW }),
      t.db.insert(repairTickets).values({ id: repairId, ref: next("RP"), phoneE164: phone(), issue: "لا يشحن", createdAt: NOW }),
      t.db.insert(repairEvents).values({ id: id.repairEvent, ticketId: repairId, kind: "created", actorKind: "system", at: NOW }),
      t.db.insert(tradeIns).values({ id: tradeInId, ref: next("TI"), phoneE164: phone(), createdAt: NOW }),
      t.db.insert(tradeInEvents).values({ id: id.tradeInEvent, tradeInId, kind: "submitted", actorKind: "guest", at: NOW }),
      t.db.insert(posRegisters).values({ id: registerId, code: next("REG"), name: "الكاشير 2", createdAt: NOW }),
      t.db.insert(posShifts).values({ id: shiftId, registerId, openedBy: "emp_test", openedAt: NOW }),
      t.db.insert(cashMovements).values({ id: id.cash, shiftId, kind: "pay_in", amountIqd: 5_000, actorKind: "employee", actorId: "emp_test", idempotencyKey: next("cash"), at: NOW }),
      ...journalEntryStatements(t.db, { id: id.entry, at: NOW, idempotencyKey: next("posting"), lines: lines(accountId("cash"), accountId("sales_revenue")) }),
      // The reversal carries all three UNIQUE keys of journal_entries.
      ...journalEntryStatements(t.db, { id: id.reversal, at: NOW, idempotencyKey: next("posting"), reversesId: id.entry, lines: lines(accountId("sales_revenue"), accountId("cash")) }),
    ]);

    const target = async (table: ReplaceTarget["table"], rowId: string, keys: string[][], change: ReplaceTarget["change"], fresh: Record<string, unknown> = {}): Promise<ReplaceTarget> => {
      const row = await t.d1.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(rowId).first<Record<string, unknown>>();
      if (!row) throw new Error(`no ${table} row ${rowId}`);
      return { table, row, keys, change, fresh: { id: `${rowId}.fresh`, ...fresh } };
    };
    return [
      await target("audit_events", id.audit, [["seq"], ["id"]], ["reason", "rewritten"], { seq: (await scalar<number>("SELECT max(seq) FROM audit_events")) + 1_000_000 }),
      await target("audit_seals", id.seal, [["id"], ["from_seq"], ["to_seq"]], ["hash", "f".repeat(64)], { from_seq: sealFrom + 500_000, to_seq: sealFrom + 500_001 }),
      await target("product_versions", id.version, [["id"], ["product_id", "version"]], ["reason", "rewritten"], { version: 1_000 }),
      await target("price_changes", id.price, [["id"]], ["new_price_iqd", 1]),
      await target("stock_movements", id.movement, [["id"]], ["qty_delta", 1_000]),
      await target("consents", id.consent, [["id"]], ["granted", 0]),
      await target("order_events", id.event, [["id"]], ["kind", "nothing_happened"]),
      await target("wallet_ledger", id.wallet, [["id"], ["idempotency_key"]], ["amount_iqd", 25_000_000], { idempotency_key: next("wallet") }),
      await target("loyalty_ledger", id.loyalty, [["id"], ["idempotency_key"]], ["points", 40_000], { idempotency_key: next("loyalty") }),
      await target("shipment_events", id.shipmentEvent, [["id"]], ["note", "rewritten"]),
      await target("repair_events", id.repairEvent, [["id"]], ["note", "rewritten"]),
      await target("trade_in_events", id.tradeInEvent, [["id"]], ["kind", "rewritten"]),
      await target("journal_entries", id.reversal, [["id"], ["idempotency_key"], ["reverses_id"]], ["memo", "rewritten"], { idempotency_key: next("posting"), reverses_id: null }),
      await target("journal_lines", `${id.reversal}.1`, [["id"]], ["memo", "rewritten"]),
      await target("cash_movements", id.cash, [["id"], ["idempotency_key"]], ["amount_iqd", 5_000_000], { idempotency_key: next("cash") }),
    ];
  }

  /** The row a statement sends to meet `target` on `key` only (every other UNIQUE key gets a fresh value), carrying the rewrite. */
  function collidingRow(target: ReplaceTarget, key: string[]): Record<string, unknown> {
    const row: Record<string, unknown> = { ...target.row, [target.change[0]]: target.change[1] };
    for (const other of target.keys) {
      if (other === key) continue;
      for (const column of other) if (!key.includes(column) && column in target.fresh) row[column] = target.fresh[column];
    }
    return row;
  }

  /** `<verb> INTO table (…) VALUES (…)<tail>` for a raw row, the way a careless script or an attacker would write it. */
  const insertRow = (table: string, row: Record<string, unknown>, verb: "INSERT" | "INSERT OR REPLACE" | "REPLACE" | "INSERT OR IGNORE" | "INSERT OR ABORT", tail = "") => {
    const columns = Object.keys(row);
    return t.d1
      .prepare(`${verb} INTO ${table} (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})${tail}`)
      .bind(...columns.map((column) => row[column] ?? null));
  };

  const stored = (target: ReplaceTarget) => t.d1.prepare(`SELECT * FROM ${target.table} WHERE id = ?`).bind(target.row.id).first();
  const changesOf = (result: unknown) => (result as { meta: { changes: number } }).meta.changes;

  test("INSERT OR REPLACE cannot rewrite a row of any [A] table, by its id or by any other UNIQUE key", async () => {
    const targets = await replaceTargets();
    expect(targets.map((target) => target.table).sort()).toEqual([...APPEND_ONLY_TABLES].sort());
    for (const target of targets) {
      const count = await scalar(`SELECT count(*) FROM ${target.table}`);
      for (const key of target.keys) {
        for (const verb of ["INSERT OR REPLACE", "REPLACE"] as const) {
          expect(await refused(() => insertRow(target.table, collidingRow(target, key), verb).run()), `${verb} ${target.table} (${key.join(", ")})`).toMatchObject({
            code: "IMMUTABLE",
            detail: target.table,
            kind: "trigger",
            status: 409,
          });
        }
      }
      expect(await stored(target), target.table).toEqual(target.row);
      expect(await scalar(`SELECT count(*) FROM ${target.table}`), `${target.table} row count`).toBe(count);
    }
    // The guard keeps no rows, and refuses one written to it directly.
    expect(await scalar("SELECT count(*) FROM _replace_guard")).toBe(0);
    expect(await refused(() => t.d1.prepare("INSERT INTO _replace_guard (tbl, probe) VALUES ('wallet_ledger', 1)").run())).toMatchObject({ code: "IMMUTABLE", detail: "wallet_ledger" });
    expect(await scalar("SELECT count(*) FROM _replace_guard")).toBe(0);
  });

  test("the guard changes nothing else: DO NOTHING and OR IGNORE skip the row, a plain duplicate fails with the same UNIQUE error, a new row goes in", async () => {
    const targets = await replaceTargets();
    for (const target of targets) {
      const count = await scalar(`SELECT count(*) FROM ${target.table}`);
      for (const key of target.keys) {
        const label = `${target.table} (${key.join(", ")})`;
        const row = collidingRow(target, key);
        // "Insert if missing" (how the demo seed and its --sql file write stock_movements): skipped, 0 rows changed.
        expect(changesOf(await insertRow(target.table, row, "INSERT", " ON CONFLICT DO NOTHING").run()), `DO NOTHING ${label}`).toBe(0);
        expect(changesOf(await insertRow(target.table, row, "INSERT", ` ON CONFLICT (${key.join(", ")}) DO NOTHING`).run()), `DO NOTHING on the key ${label}`).toBe(0);
        expect(changesOf(await insertRow(target.table, row, "INSERT OR IGNORE").run()), `OR IGNORE ${label}`).toBe(0);
        // A plain duplicate keeps SQLite's own error: the one creditWallet, sealAudit and mapPostingError read.
        expect(await refused(() => insertRow(target.table, row, "INSERT").run()), `INSERT ${label}`).toMatchObject({ code: "UNIQUE", kind: "unique", table: target.table, columns: key, status: 409 });
        // The documented side effect: an explicit OR ABORT is still refused, but names the guard's probe.
        expect(await refused(() => insertRow(target.table, row, "INSERT OR ABORT").run()), `OR ABORT ${label}`).toMatchObject({ code: "NOT_NULL", table: "_replace_guard", columns: ["probe"] });
      }
      expect(await stored(target), target.table).toEqual(target.row);
      expect(await scalar(`SELECT count(*) FROM ${target.table}`), `${target.table} row count`).toBe(count);
    }
    // A row that meets no existing key is no business of the guard, whatever the statement says.
    const wallet = targets.find((target) => target.table === "wallet_ledger")!;
    expect(changesOf(await insertRow("wallet_ledger", { ...wallet.row, id: newId("wal"), idempotency_key: next("wallet") }, "INSERT OR REPLACE").run())).toBe(1);
    const movement = targets.find((target) => target.table === "stock_movements")!;
    expect(changesOf(await insertRow("stock_movements", { ...movement.row, id: newId("mov") }, "REPLACE").run())).toBe(1);
    expect(changesOf(await insertRow("stock_movements", { ...movement.row, id: newId("mov") }, "INSERT", " ON CONFLICT DO NOTHING").run())).toBe(1);
  });

  test("in a batch, a refused REPLACE rolls back everything before it, and 'insert if missing' still counts 0 for expectChanged", async () => {
    const customerId = await makeCustomer();
    const { orderId, variantId } = await simpleOrder({ customerId });
    const key = next("wallet");
    await t.db.insert(walletLedger).values({ id: newId("wal"), customerId, amountIqd: 10_000, kind: "topup", actorKind: "system", idempotencyKey: key, at: NOW });

    const eventId = newId("oev");
    const error = await refused(() =>
      runBatch(t.db, [
        t.db.insert(orderEvents).values({ id: eventId, orderId, kind: "wallet_payment", actorKind: "system", at: NOW }),
        batchSql(t.db, sql`INSERT OR REPLACE INTO wallet_ledger (id, customer_id, amount_iqd, kind, actor_kind, idempotency_key, at) VALUES (${newId("wal")}, ${customerId}, ${10_000_000}, 'topup', 'system', ${key}, ${NOW})`),
      ]),
    );
    expect(error).toMatchObject({ code: "IMMUTABLE", detail: "wallet_ledger" });
    expect(await scalar("SELECT count(*) FROM order_events WHERE id = ?", eventId)).toBe(0);
    expect(await scalar("SELECT sum(amount_iqd) FROM wallet_ledger WHERE customer_id = ?", customerId)).toBe(10_000);

    // The demo seed's statement shape, guarded the way expectChanged() reads changes().
    const movement = { id: newId("mov"), variantId, locationId: DEFAULT_LOCATION_ID, kind: "adjust" as const, qtyDelta: 2, actorKind: "system" as const, at: NOW };
    const insertIfMissing = () => t.db.insert(stockMovements).values(movement).onConflictDoNothing({ target: stockMovements.id });
    const first = await runBatch(t.db, [insertIfMissing(), expectChanged(t.db, 1, "MOVEMENT_ADDED")]);
    expect(changesOf(first[0])).toBe(1);
    expect(await refused(() => runBatch(t.db, [insertIfMissing(), expectChanged(t.db, 1, `MOVEMENT_ADDED:${movement.id}`)]))).toMatchObject({ code: "MOVEMENT_ADDED", detail: movement.id });
    expect(changesOf((await runBatch(t.db, [insertIfMissing()]))[0])).toBe(0);
    expect(await scalar("SELECT count(*) FROM stock_movements WHERE id = ?", movement.id)).toBe(1);
  });

  test("each [A] table's guard names every UNIQUE key of the table", async () => {
    for (const table of APPEND_ONLY_TABLES) {
      const guard = await scalar<string | undefined>("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?", `${table}_no_replace`);
      expect(guard, table).toContain("BEFORE INSERT ON `" + table + "`");
      // UNIQUE indexes (a TEXT primary key is one of them) and an INTEGER PRIMARY KEY (the rowid itself, no index).
      const keys: string[][] = [];
      const indexes = (await t.d1.prepare(`SELECT name FROM pragma_index_list('${table}') WHERE "unique" = 1`).all<{ name: string }>()).results;
      for (const index of indexes) keys.push((await t.d1.prepare(`SELECT name FROM pragma_index_info('${index.name}') ORDER BY seqno`).all<{ name: string }>()).results.map((column) => column.name));
      const primary = (await t.d1.prepare(`SELECT name, type FROM pragma_table_info('${table}') WHERE pk > 0`).all<{ name: string; type: string }>()).results;
      if (primary.length === 1 && primary[0].type.toUpperCase() === "INTEGER") keys.push([primary[0].name]);
      expect(keys.length, table).toBeGreaterThan(0);
      for (const key of keys) expect(guard, `${table} (${key.join(", ")})`).toContain(`WHERE ${key.map((column) => `${column} = NEW.${column}`).join(" AND ")})`);
    }
  });
});

// ───────────────────────────────────────────────────────────────── §7.3 idempotency

describe("orders and payments are idempotent (§7.3)", () => {
  test("a duplicate idempotency key is refused and names the column", async () => {
    const variant = await makeVariant();
    const key = next("checkout");
    const order = (id: string, ref: string) =>
      t.db.insert(orders).values({ id, ref, idempotencyKey: key, contactPhoneE164: phone(), subtotalIqd: 500_000, shippingIqd: 5000, totalIqd: 505_000, placedAt: NOW });
    const orderId = newId("ord");
    await order(orderId, next("TT"));

    // A retry is a whole batch: the duplicate order aborts it, so nothing else the retry wrote survives.
    let retry: unknown;
    const retryId = newId("ord");
    const retryMovementId = newId("mov");
    try {
      await t.db.batch([
        t.db.insert(stockMovements).values({ id: retryMovementId, variantId: variant.variantId, locationId: DEFAULT_LOCATION_ID, kind: "reserve", reservedDelta: 1, refType: "order", refId: retryId, actorKind: "guest", at: NOW }),
        order(retryId, next("TT")),
        t.db.insert(orderItems).values({ id: newId("oit"), orderId: retryId, variantId: variant.variantId, sku: variant.sku, nameSnapshot: { ar: "x" }, unitPriceIqd: 500_000, qty: 1, totalIqd: 500_000 }),
      ]);
    } catch (caught) {
      retry = caught;
    }
    expect(mapDbError(retry)).toMatchObject({ code: "UNIQUE", table: "orders", columns: ["idempotency_key"], detail: "orders.idempotency_key", status: 409 });
    expect(isUniqueViolation(retry, "orders.idempotency_key")).toBe(true);
    expect(isUniqueViolation(retry, "orders.ref")).toBe(false);
    expect(await scalar("SELECT count(*) FROM orders WHERE idempotency_key = ?", key)).toBe(1);
    expect(await scalar("SELECT count(*) FROM stock_movements WHERE id = ?", retryMovementId)).toBe(0);
    expect(await scalar("SELECT count(*) FROM order_items WHERE order_id = ?", retryId)).toBe(0);

    const paymentKey = next("payment");
    const pay = () => t.db.insert(payments).values({ id: newId("pay"), orderId, method: "cod", status: "pending", amountIqd: 505_000, idempotencyKey: paymentKey, createdAt: NOW });
    await pay();
    let duplicatePayment: unknown;
    try {
      await pay();
    } catch (caught) {
      duplicatePayment = caught;
    }
    expect(isUniqueViolation(duplicatePayment, "payments.idempotency_key")).toBe(true);
    expect(await scalar("SELECT count(*) FROM payments WHERE order_id = ?", orderId)).toBe(1);
  });

  test("an inbound webhook event is processed once", async () => {
    const id = `zaincash:${next("evt")}`;
    const receive = () => t.db.insert(inboundEvents).values({ id, provider: "zaincash", receivedAt: NOW });
    await receive();
    let replay: unknown;
    try {
      await receive();
    } catch (caught) {
      replay = caught;
    }
    expect(isUniqueViolation(replay, "inbound_events.id")).toBe(true);
    expect(await scalar("SELECT count(*) FROM inbound_events WHERE id = ?", id)).toBe(1);
  });
});

// ───────────────────────────────────────────────────────────────── batch guards

describe("expectChanged / expectThat (atomic batches)", () => {
  test("expectChanged aborts and rolls back the whole batch when the previous statement changed nothing", async () => {
    const { variantId } = await makeVariant({ trackSerials: true });
    const serialId = newId("ser");
    await t.db.insert(serials).values({ id: serialId, serial: next("SN"), variantId, status: "sold" });
    const order = await simpleOrder();
    const eventId = newId("oev");

    const error = await refused(() =>
      t.db.batch([
        // 1. a write that succeeds — it must be rolled back too
        t.db.insert(orderEvents).values({ id: eventId, orderId: order.orderId, kind: "serial_assigned", actorKind: "system", at: NOW }),
        // 2. the conditional write: this serial is already sold, so no row matches
        t.db
          .update(serials)
          .set({ status: "sold" })
          .where(and(eq(serials.id, serialId), inArray(serials.status, ["in_stock", "reserved"]))),
        // 3. the guard
        expectChanged(t.db, 1, { code: "SERIAL_NOT_AVAILABLE", detail: serialId }),
        // 4. never reached
        t.db.insert(orderItemSerials).values({ orderItemId: order.itemId, serialId }),
      ]),
    );
    expect(error).toMatchObject({ code: "SERIAL_NOT_AVAILABLE", detail: serialId, kind: "trigger", status: 409 });
    expect(await scalar("SELECT count(*) FROM order_events WHERE id = ?", eventId)).toBe(0);
    expect(await scalar("SELECT count(*) FROM order_item_serials WHERE serial_id = ?", serialId)).toBe(0);
  });

  test("it lets the batch through when enough rows changed, and never stores guard rows", async () => {
    const { variantId } = await makeVariant({ trackSerials: true });
    const ids = [newId("ser"), newId("ser"), newId("ser")];
    await t.db.insert(serials).values(ids.map((id) => ({ id, serial: next("SN"), variantId })));

    const results = await t.db.batch([
      t.db
        .update(serials)
        .set({ status: "reserved" })
        .where(and(eq(serials.id, ids[0]), eq(serials.status, "in_stock"))),
      expectChanged(t.db),
      t.db.update(serials).set({ notes: "counted" }).where(inArray(serials.id, ids)),
      expectChanged(t.db, 3),
      t.db.select({ status: serials.status }).from(serials).where(eq(serials.id, ids[0])),
    ]);
    expect(results[4]).toEqual([{ status: "reserved" }]);
    expect(await scalar("SELECT count(*) FROM _tx_guard")).toBe(0);
  });

  test("the default failure is NO_ROWS_CHANGED; `min` is honoured; labels may be 'CODE:detail' strings", async () => {
    const { variantId } = await makeVariant({ trackSerials: true });
    const ids = [newId("ser"), newId("ser")];
    await t.db.insert(serials).values(ids.map((id) => ({ id, serial: next("SN"), variantId })));
    const touchAll = () => t.db.update(serials).set({ notes: "x" }).where(inArray(serials.id, ids));

    expect(await refused(() => t.db.batch([t.db.update(serials).set({ notes: "x" }).where(eq(serials.id, "ser_none")), expectChanged(t.db)]))).toMatchObject({ code: "NO_ROWS_CHANGED", detail: "" });
    expect(await refused(() => t.db.batch([touchAll(), expectChanged(t.db, 3, "NOT_ALL_UPDATED:batch-7")]))).toMatchObject({ code: "NOT_ALL_UPDATED", detail: "batch-7" });
    await t.db.batch([touchAll(), expectChanged(t.db, 2)]);
    // The detail is kept to one line so the message stays parseable.
    expect(await refused(() => t.db.batch([touchAll(), expectChanged(t.db, 9, { code: "MULTI_LINE", detail: "first\nsecond" })]))).toMatchObject({ code: "MULTI_LINE", detail: "first second" });
    expect(() => expectChanged(t.db, 1, "lower-case")).toThrow(/UPPER_SNAKE_CASE/);
    expect(() => expectChanged(t.db, 0)).toThrow(/positive integer/);
  });

  test("exact semantics: one guard per statement, SELECTs in between are fine, trigger writes do not count, conflicts count as zero", async () => {
    const customerId = await makeCustomer();
    const { variantId } = await makeVariant();
    const touch = () => t.db.update(customers).set({ notes: "seen" }).where(eq(customers.id, customerId));

    // A SELECT between the statement and its guard does not reset the count.
    await t.db.batch([touch(), t.db.select().from(customers).where(eq(customers.id, customerId)), expectChanged(t.db)]);

    // A second guard sees the first guard, not the UPDATE.
    expect(await refused(() => t.db.batch([touch(), expectChanged(t.db), expectChanged(t.db, 1, "SECOND_GUARD")]))).toMatchObject({ code: "SECOND_GUARD" });

    // INSERT … ON CONFLICT DO NOTHING that conflicts changed 0 rows.
    const first = t.db.insert(stockLevels).values({ variantId, locationId: DEFAULT_LOCATION_ID, onHand: 1 }).onConflictDoNothing();
    await t.db.batch([first, expectChanged(t.db, 1, "ALREADY_EXISTS")]);
    expect(await refused(() => t.db.batch([first, expectChanged(t.db, 1, `ALREADY_EXISTS:${variantId}`)]))).toMatchObject({ code: "ALREADY_EXISTS", detail: variantId });

    // Outside a batch the guard still reads the connection's last statement — which is why it is
    // only meaningful inside one.
    expect(await scalar("SELECT count(*) FROM _tx_guard")).toBe(0);
  });

  test("expectThat guards on a condition instead of the previous statement", async () => {
    const customerId = await makeCustomer();
    const balanceAtLeast = (amount: number) => sql`(SELECT coalesce(sum(amount_iqd), 0) FROM wallet_ledger WHERE customer_id = ${customerId}) >= ${amount}`;

    await t.db.batch([
      t.db.insert(walletLedger).values({ id: newId("wal"), customerId, amountIqd: 5_000, kind: "topup", actorKind: "system", idempotencyKey: next("wallet"), at: NOW }),
      expectThat(t.db, balanceAtLeast(5_000), "BALANCE_TOO_LOW"),
    ]);
    const error = await refused(() =>
      t.db.batch([
        t.db.insert(walletLedger).values({ id: newId("wal"), customerId, amountIqd: 1_000, kind: "topup", actorKind: "system", idempotencyKey: next("wallet"), at: NOW }),
        expectThat(t.db, balanceAtLeast(10_000), { code: "BALANCE_TOO_LOW", detail: customerId }),
      ]),
    );
    expect(error).toMatchObject({ code: "BALANCE_TOO_LOW", detail: customerId });
    expect(await refused(() => t.db.batch([expectThat(t.db, sql`1 = 0`)]))).toMatchObject({ code: "GUARD_FAILED" });
    expect(await scalar("SELECT sum(amount_iqd) FROM wallet_ledger WHERE customer_id = ?", customerId)).toBe(5_000);
  });

  test("runBatch accepts runtime lists (including an empty one); clearGuards is harmless", async () => {
    expect(await runBatch(t.db, [])).toEqual([]);
    const results = await runBatch(t.db, [t.db.select({ one: sql<number>`1` }).from(settings).limit(1), clearGuards(t.db)]);
    expect(results[0]).toEqual([{ one: 1 }]);
  });

  test("chunkRows keeps multi-row inserts under D1's 100-parameter limit", async () => {
    const rows = Array.from({ length: 45 }, (_, index) => ({ id: newId("aud"), at: NOW + index, actorKind: "system" as const, action: "test.chunk.insert" }));
    const chunks = chunkRows(auditEvents, rows);
    expect(chunks.every((chunk) => chunk.length * 15 <= 100)).toBe(true);
    expect(chunks.flat()).toHaveLength(45);
    await runBatch(t.db, chunks.map((chunk) => t.db.insert(auditEvents).values(chunk)));
    expect(await scalar("SELECT count(*) FROM audit_events WHERE action = 'test.chunk.insert'")).toBe(45);
    // The audit log keeps a strict order.
    expect(await scalar("SELECT count(*) FROM (SELECT seq, lag(seq) OVER (ORDER BY at) AS previous FROM audit_events WHERE action = 'test.chunk.insert') WHERE previous IS NOT NULL AND seq <= previous")).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────────── mapDbError

describe("mapDbError", () => {
  test("parses trigger messages with and without D1 / Drizzle wrappers", () => {
    const local = new Error("D1_ERROR: TT:INSUFFICIENT_STOCK:var_01ABC: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)");
    expect(mapDbError(local)).toMatchObject({ code: "INSUFFICIENT_STOCK", detail: "var_01ABC", kind: "trigger", status: 409 });
    expect(mapDbError(new Error("D1_ERROR: TT:PERIOD_CLOSED:2026-10: SQLITE_CONSTRAINT"))).toMatchObject({ code: "PERIOD_CLOSED", detail: "2026-10" });
    expect(mapDbError(new Error("TT:NO_ROWS_CHANGED:"))).toMatchObject({ code: "NO_ROWS_CHANGED", detail: "" });
    expect(mapDbError(new Error("TT:COUPON_LIMIT_REACHED:cpn_1:phone:+9647700000000: SQLITE_CONSTRAINT"))).toMatchObject({ code: "COUPON_LIMIT_REACHED", detail: "cpn_1:phone:+9647700000000" });
    expect(mapDbError("D1_ERROR: TT:IMMUTABLE:audit_events: SQLITE_CONSTRAINT")).toMatchObject({ code: "IMMUTABLE", detail: "audit_events" });

    // Drizzle wraps single statements; the SQL text in its message must never be mistaken for the cause.
    const wrapped = new Error("Failed query: update t set note = 'TT:FAKE:not-this' where id = ?\nparams: 1", { cause: local });
    expect(mapDbError(wrapped)).toMatchObject({ code: "INSUFFICIENT_STOCK", detail: "var_01ABC" });
  });

  test("parses built-in constraint failures", () => {
    expect(mapDbError(new Error("D1_ERROR: UNIQUE constraint failed: orders.idempotency_key: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)"))).toMatchObject({
      code: "UNIQUE",
      table: "orders",
      columns: ["idempotency_key"],
      status: 409,
    });
    expect(mapDbError(new Error("UNIQUE constraint failed: stock_levels.variant_id, stock_levels.location_id"))).toMatchObject({ table: "stock_levels", columns: ["variant_id", "location_id"] });
    expect(mapDbError(new Error("UNIQUE constraint failed: index 'custom_idx'"))).toMatchObject({ code: "UNIQUE", constraint: "custom_idx" });
    expect(mapDbError(new Error("D1_ERROR: NOT NULL constraint failed: payments.amount_iqd: SQLITE_CONSTRAINT"))).toMatchObject({ code: "NOT_NULL", table: "payments", columns: ["amount_iqd"], status: 422 });
    expect(mapDbError(new Error("D1_ERROR: CHECK constraint failed: orders_total_check: SQLITE_CONSTRAINT"))).toMatchObject({ code: "CHECK", constraint: "orders_total_check", status: 422 });
    expect(mapDbError(new Error("D1_ERROR: FOREIGN KEY constraint failed: SQLITE_CONSTRAINT"))).toMatchObject({ code: "FOREIGN_KEY", status: 409 });
  });

  test("every TT code the migrations can raise is listed in TRIGGER_ERROR_CODES", () => {
    const raised = new Set<string>();
    for (const migration of listMigrations()) {
      for (const statement of migration.statements) {
        // Only executable SQL counts — strip comment lines first.
        const code = statement.replace(/^\s*--.*$/gm, "");
        for (const match of code.matchAll(/'TT:([A-Z][A-Z0-9_]*):/g)) raised.add(match[1]);
        if (code.includes("coalesce(NEW.code, 'NO_ROWS_CHANGED')")) raised.add("NO_ROWS_CHANGED");
      }
    }
    // GUARD_FAILED is the default label of expectThat(); it is raised through _tx_guard.
    expect([...raised, "GUARD_FAILED"].sort()).toEqual(Object.keys(TRIGGER_ERROR_CODES).sort());
  });

  test("returns null for anything else, so unknown errors keep bubbling", () => {
    expect(mapDbError(new Error("D1_ERROR: no such table: nope: SQLITE_ERROR"))).toBeNull();
    expect(mapDbError(new TypeError("fetch failed"))).toBeNull();
    expect(mapDbError(undefined)).toBeNull();
    expect(isDbError(new Error("TT:WALLET_OVERDRAFT:cus_1"), "WALLET_OVERDRAFT", "cus_1")).toBe(true);
    expect(isDbError(new Error("TT:WALLET_OVERDRAFT:cus_1"), "WALLET_OVERDRAFT", "cus_2")).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────── full-text search

describe("product search (FTS5)", () => {
  const ps5 = "prd_search_ps5";
  const dualsense = "prd_search_dualsense";
  const pokemon = "prd_search_pokemon";
  const ally = "prd_search_ally";

  beforeAll(async () => {
    await runBatch(t.db, [
      ...searchIndexStatements(t.db, ps5, [
        { locale: "ar", name: "بلايستيشن 5 سليم", keywords: "سوني PS5 جهاز ألعاب", body: "جهاز ألعاب منزلي بسعة 1 تيرابايت" },
        { locale: "en", name: "PlayStation 5 Slim", keywords: "Sony PS5 console", body: "Home console with 1TB storage" },
        { locale: "ckb", name: "پلەیستەیشن 5 سلیم", keywords: "سۆنی PS5", body: "ئامێری یاریی ماڵەوە" },
      ]),
      ...searchIndexStatements(t.db, dualsense, [
        { locale: "ar", name: "يد تحكم دوال سنس لاسلكية", keywords: "ذراع كونترولر سوني PS5", body: "أبيض" },
        { locale: "en", name: "DualSense Wireless Controller", keywords: "Sony PS5 gamepad", body: "White" },
      ]),
      ...searchIndexStatements(t.db, pokemon, [
        { locale: "ar", name: "بوكيمون سكارلت", keywords: "نينتندو سويتش لعبة", body: "لعبة مغامرات" },
        { locale: "en", name: "Pokémon™ Scarlet", keywords: "Nintendo Switch game", body: "Adventure game" },
      ]),
      ...searchIndexStatements(t.db, ally, [{ locale: "en", name: "ROG Ally X", keywords: "ASUS handheld PC", body: "Windows handheld" }]),
    ]);
  });

  const ids = async (query: string, options?: { locale?: string }) => (await searchProductIds(t.db, query, options)).map((hit) => hit.productId);

  test("search_index is an FTS5 table with the trigram tokenizer (available in D1's SQLite)", async () => {
    const ddl = await scalar<string>("SELECT sql FROM sqlite_master WHERE name = 'search_index'");
    expect(ddl).toMatch(/CREATE VIRTUAL TABLE `search_index` USING fts5\(/);
    expect(ddl).toMatch(/tokenize = 'trigram'/);
    const columns = (await t.d1.prepare("SELECT name FROM pragma_table_info('search_index')").all<{ name: string }>()).results.map((row) => row.name);
    expect(columns).toEqual(["product_id", "locale", "name", "keywords", "body"]);
  });

  test("finds Arabic terms", async () => {
    expect(await ids("بلايستيشن")).toEqual([ps5]);
    expect(await ids("دوال سنس")).toEqual([dualsense]);
    expect(await ids("ألعاب")).toEqual(expect.arrayContaining([ps5]));
    // Tashkeel, hamza forms and teh marbuta / heh do not matter.
    expect(await ids("بلايستيشِن")).toEqual([ps5]);
    expect(await ids("العاب")).toEqual(expect.arrayContaining([ps5]));
    expect(await ids("لعبه مغامرات")).toEqual([pokemon]);
    // Substrings match too: "ستيشن" inside "بلايستيشن".
    expect(await ids("ستيشن")).toEqual([ps5]);
  });

  test("finds Latin terms, case- and accent-insensitively", async () => {
    expect(await ids("playstation")).toEqual([ps5]);
    expect(await ids("PLAYSTATION slim")).toEqual([ps5]);
    expect(await ids("pokemon")).toEqual([pokemon]);
    expect(await ids("Pokémon")).toEqual([pokemon]);
    expect(await ids("station")).toEqual([ps5]);
    expect((await ids("sony")).sort()).toEqual([dualsense, ps5].sort());
  });

  test("finds Kurdish terms across keyboard variants of the same letters", async () => {
    expect(await ids("پلەیستەیشن")).toEqual([ps5]);
    // Typed with Arabic yeh (ي) instead of Kurdish yeh (ی).
    expect(await ids("پلەيستەيشن")).toEqual([ps5]);
  });

  test("one hit per product, ranked with the name first, and optionally limited to a locale", async () => {
    const hits = await searchProductIds(t.db, "ps5");
    expect(hits.map((hit) => hit.productId).sort()).toEqual([dualsense, ps5].sort());
    expect(new Set(hits.map((hit) => hit.productId)).size).toBe(hits.length);

    const nameMatchFirst = await searchProductIds(t.db, "controller");
    expect(nameMatchFirst[0]?.productId).toBe(dualsense);
    expect(await ids("console", { locale: "ar" })).toEqual([]);
    expect(await ids("console", { locale: "en" })).toEqual([ps5]);
  });

  test("terms shorter than three characters fall back to LIKE", async () => {
    expect(ftsMatchQuery("يد")).toBeNull();
    expect(await ids("يد")).toEqual([dualsense]);
    expect(await ids("يد تحكم")).toEqual([dualsense]);
    expect(await ids("x")).toEqual([ally]);
    expect(await ids("rog x")).toEqual([ally]);
  });

  test("shopper input can never break the query", async () => {
    for (const hostile of ['"', 'ps5" OR name:*', "NEAR(a b)", "a AND b", "-ps5", "name: ps5", "%", "_", "'; DROP TABLE search_index; --", "   ", ""]) {
      await expect(searchProductIds(t.db, hostile)).resolves.toBeInstanceOf(Array);
    }
    expect(await ids('"ps5"')).toEqual(expect.arrayContaining([ps5]));
    expect(await scalar("SELECT count(*) FROM search_index")).toBeGreaterThan(0);
  });

  test("re-indexing replaces a product's rows; an empty list removes it", async () => {
    await runBatch(t.db, searchIndexStatements(t.db, ally, [{ locale: "en", name: "ROG Xbox Ally", keywords: "ASUS handheld PC" }]));
    expect(await scalar("SELECT count(*) FROM search_index WHERE product_id = ?", ally)).toBe(1);
    expect(await ids("xbox")).toEqual([ally]);
    await runBatch(t.db, searchIndexStatements(t.db, ally, []));
    expect(await ids("xbox")).toEqual([]);
  });

  test("normalizeSearchText is the shared canonical form", () => {
    expect(normalizeSearchText("  PlayStation®5 — Slim!  ")).toBe("playstation 5 slim");
    expect(normalizeSearchText("أَلْعَابٌ إلكترونيّة")).toBe("العاب الكترونيه");
    expect(normalizeSearchText("٥٠٠ جيجا ۱۲۸")).toBe("500 جيجا 128");
    expect(normalizeSearchText("کۆنترۆڵ")).toBe(normalizeSearchText("كۆنترۆڵ"));
    expect(normalizeSearchText(null)).toBe("");
  });
});

// ───────────────────────────────────────────────────────────────── §7.11 used units

describe("used units show real evidence (§7.11)", () => {
  const completeChecklist: UsedChecklist = { templateId: "itpl_console_v1", completedAt: NOW, completedBy: "emp_test", items: [{ key: "power", result: "pass" }] };

  async function makeUsedUnit(overrides: Partial<typeof usedUnits.$inferInsert> = {}) {
    const { variantId } = await makeVariant();
    const id = newId("usd");
    await t.db.insert(usedUnits).values({ id, slug: next("used"), variantId, grade: "A", priceIqd: 350_000, status: "ready", ...overrides });
    return id;
  }
  async function addPhoto(usedUnitId: string, options: { isIllustration?: boolean } = {}) {
    const fileId = newId("fil");
    const mediaId = newId("med");
    await t.db.batch([
      t.db.insert(files).values({ id: fileId, storageKey: next("used/photo"), kind: "used_photo", mime: "image/webp", bytes: 1024, sha256: next("sha"), createdAt: NOW }),
      t.db.insert(media).values({ id: mediaId, ownerType: "used_unit", ownerId: usedUnitId, fileId, kind: "image", isIllustration: options.isIllustration ?? false }),
    ]);
    return mediaId;
  }
  const list = (id: string) => t.db.update(usedUnits).set({ status: "listed", listedAt: NOW }).where(eq(usedUnits.id, id));

  test("a unit cannot be listed until every piece of evidence is there", async () => {
    const id = await makeUsedUnit();
    const notListable = { code: "USED_UNIT_NOT_LISTABLE", detail: id, kind: "trigger", status: 409 };

    expect(await refused(() => list(id))).toMatchObject(notListable);

    await t.db.update(usedUnits).set({ ownershipCheckedAt: NOW, dataWipedAt: NOW }).where(eq(usedUnits.id, id));
    expect(await refused(() => list(id))).toMatchObject(notListable);

    // A checklist that was started but not completed does not count.
    await t.db
      .update(usedUnits)
      .set({ checklist: { ...completeChecklist, completedAt: null } })
      .where(eq(usedUnits.id, id));
    expect(await refused(() => list(id))).toMatchObject(notListable);
    await t.db.update(usedUnits).set({ checklist: completeChecklist }).where(eq(usedUnits.id, id));
    expect(await refused(() => list(id))).toMatchObject(notListable);

    // An illustration (a stock photo, a render of the model) is not a photo of this unit. The art key
    // plays no part in the rule; this one names no real picture.
    await addPhoto(id, { isIllustration: true });
    await t.db.insert(media).values({ id: newId("med"), ownerType: "used_unit", ownerId: id, artKey: "test-illustration--1", kind: "render" });
    expect(await refused(() => list(id))).toMatchObject(notListable);

    await addPhoto(id);
    await list(id);
    expect(await scalar<string>("SELECT status FROM used_units WHERE id = ?", id)).toBe("listed");
  });

  test("a listed unit cannot lose its evidence", async () => {
    const id = await makeUsedUnit({ ownershipCheckedAt: NOW, dataWipedAt: NOW, checklist: completeChecklist });
    const first = await addPhoto(id);
    const second = await addPhoto(id);
    await list(id);

    await t.db.delete(media).where(eq(media.id, first));
    expect(await refused(() => t.db.delete(media).where(eq(media.id, second)))).toMatchObject({ code: "USED_UNIT_NOT_LISTABLE", detail: id });
    expect(await refused(() => t.db.update(media).set({ isIllustration: true }).where(eq(media.id, second)))).toMatchObject({ code: "USED_UNIT_NOT_LISTABLE", detail: id });
    expect(await refused(() => t.db.update(usedUnits).set({ dataWipedAt: null }).where(eq(usedUnits.id, id)))).toMatchObject({ code: "USED_UNIT_NOT_LISTABLE", detail: id });

    // Once it is no longer listed, the photo can go.
    await t.db.update(usedUnits).set({ status: "ready" }).where(eq(usedUnits.id, id));
    await t.db.delete(media).where(eq(media.id, second));
  });

  test("inserting a unit directly as listed is checked too; demo units are exempt", async () => {
    const { variantId } = await makeVariant();
    const realId = newId("usd");
    expect(await refused(() => t.db.insert(usedUnits).values({ id: realId, slug: next("used"), variantId, grade: "B", priceIqd: 1, status: "listed" }))).toMatchObject({
      code: "USED_UNIT_NOT_LISTABLE",
      detail: realId,
    });

    const demoId = await makeUsedUnit({ isDemo: true, status: "listed" });
    expect(await scalar<string>("SELECT status FROM used_units WHERE id = ?", demoId)).toBe("listed");
    // Turning a demo unit into a real one re-applies the rule.
    expect(await refused(() => t.db.update(usedUnits).set({ isDemo: false }).where(eq(usedUnits.id, demoId)))).toMatchObject({ code: "USED_UNIT_NOT_LISTABLE", detail: demoId });
  });

  test("a used unit is reserved and sold once", async () => {
    const id = await makeUsedUnit({ isDemo: true, status: "listed" });
    await t.db.update(usedUnits).set({ status: "reserved" }).where(eq(usedUnits.id, id));
    expect(await refused(() => t.db.update(usedUnits).set({ status: "reserved" }).where(eq(usedUnits.id, id)))).toMatchObject({ code: "USED_UNIT_NOT_AVAILABLE", detail: id });
    await t.db.update(usedUnits).set({ status: "sold" }).where(eq(usedUnits.id, id));
    expect(await refused(() => t.db.update(usedUnits).set({ status: "sold" }).where(eq(usedUnits.id, id)))).toMatchObject({ code: "USED_UNIT_NOT_AVAILABLE", detail: id });

    const untested = await makeUsedUnit({ status: "intake" });
    expect(await refused(() => t.db.update(usedUnits).set({ status: "sold" }).where(eq(usedUnits.id, untested)))).toMatchObject({ code: "USED_UNIT_NOT_AVAILABLE", detail: untested });
  });
});

// ───────────────────────────────────────────────────────────────── §7.12 trade-in

describe("trade-in estimates are not offers (§7.12)", () => {
  test("a final offer needs an inspection and the employee who made it", async () => {
    const id = newId("tin");
    await t.db.insert(tradeIns).values({ id, ref: next("TI"), phoneE164: phone(), estimateMinIqd: 150_000, estimateMaxIqd: 220_000, status: "estimated", createdAt: NOW });
    const row = eq(tradeIns.id, id);
    const refusedOffer = { code: "TRADE_IN_OFFER_NOT_ALLOWED", detail: id, status: 409 };

    // An estimate alone can never become an offer or an "offered" request.
    expect(await refused(() => t.db.update(tradeIns).set({ finalOfferIqd: 200_000 }).where(row))).toMatchObject(refusedOffer);
    expect(await refused(() => t.db.update(tradeIns).set({ status: "offered" }).where(row))).toMatchObject(refusedOffer);
    expect(await refused(() => t.db.update(tradeIns).set({ status: "accepted" }).where(row))).toMatchObject(refusedOffer);
    expect(await refused(() => t.db.update(tradeIns).set({ finalOfferIqd: 200_000, offeredBy: "emp_buyer", offeredAt: NOW }).where(row))).toMatchObject(refusedOffer);

    const inspection = { checklist: { templateId: "itpl_console_v1", completedAt: NOW, completedBy: "emp_tech", items: [{ key: "power", result: "pass" as const }] }, grade: "A" as const };
    expect(await refused(() => t.db.update(tradeIns).set({ finalOfferIqd: 200_000, inspection, status: "offered" }).where(row))).toMatchObject(refusedOffer);

    await t.db.update(tradeIns).set({ status: "inspected", inspection }).where(row);
    await t.db.update(tradeIns).set({ finalOfferIqd: 200_000, offeredBy: "emp_buyer", offeredAt: NOW, status: "offered" }).where(row);
    expect(await scalar("SELECT final_offer_iqd FROM trade_ins WHERE id = ?", id)).toBe(200_000);

    // The offer cannot be orphaned afterwards.
    expect(await refused(() => t.db.update(tradeIns).set({ offeredBy: null }).where(row))).toMatchObject(refusedOffer);

    const direct = newId("tin");
    expect(await refused(() => t.db.insert(tradeIns).values({ id: direct, ref: next("TI"), phoneE164: phone(), finalOfferIqd: 1, createdAt: NOW }))).toMatchObject({
      code: "TRADE_IN_OFFER_NOT_ALLOWED",
      detail: direct,
    });
  });
});

// ───────────────────────────────────────────────────────────────── journal

describe("double-entry journal", () => {
  const cash = accountId("cash");
  const revenue = accountId("sales_revenue");
  const shipping = accountId("shipping_income");

  test("a balanced entry posts; reports see lines only through their header", async () => {
    const id = newId("je");
    await runBatch(
      t.db,
      journalEntryStatements(t.db, {
        id,
        at: NOW,
        memo: "طلب للاختبار",
        refType: "order",
        refId: "ord_test",
        idempotencyKey: `order:${id}:delivered`,
        lines: [
          { accountId: cash, debitIqd: 754_000 },
          { accountId: revenue, creditIqd: 749_000 },
          { accountId: shipping, creditIqd: 5_000 },
        ],
      }),
    );
    const [entry] = await t.db.select().from(journalEntries).where(eq(journalEntries.id, id));
    expect(entry).toMatchObject({ period: "2026-11", refType: "order" });
    const totals = await t.d1.prepare("SELECT sum(debit_iqd) AS debit, sum(credit_iqd) AS credit, count(*) AS n FROM journal_lines WHERE entry_id = ?").bind(id).first();
    expect(totals).toEqual({ debit: 754_000, credit: 754_000, n: 3 });
  });

  test("the header is refused when its lines do not balance — or do not exist yet", async () => {
    const unbalanced = newId("je");
    const error = await refused(() =>
      t.db.batch([
        t.db.insert(journalLines).values({ id: `${unbalanced}.1`, entryId: unbalanced, accountId: cash, debitIqd: 10_000 }),
        t.db.insert(journalLines).values({ id: `${unbalanced}.2`, entryId: unbalanced, accountId: revenue, creditIqd: 9_999 }),
        t.db.insert(journalEntries).values({ id: unbalanced, at: NOW, period: fiscalPeriodOf(NOW) }),
      ]),
    );
    expect(error).toMatchObject({ code: "JOURNAL_UNBALANCED", detail: unbalanced, status: 409 });
    expect(await scalar("SELECT count(*) FROM journal_lines WHERE entry_id = ?", unbalanced)).toBe(0);

    const headerFirst = newId("je");
    expect(await refused(() => t.db.insert(journalEntries).values({ id: headerFirst, at: NOW, period: fiscalPeriodOf(NOW) }))).toMatchObject({ code: "JOURNAL_UNBALANCED", detail: headerFirst });

    const oneSided = newId("je");
    expect(
      await refused(() =>
        t.db.batch([t.db.insert(journalLines).values({ id: `${oneSided}.1`, entryId: oneSided, accountId: cash, debitIqd: 1 }), t.db.insert(journalEntries).values({ id: oneSided, at: NOW, period: fiscalPeriodOf(NOW) })]),
      ),
    ).toMatchObject({ code: "JOURNAL_UNBALANCED", detail: oneSided });

    // The helper catches the mistake before it reaches the database.
    expect(() => journalEntryStatements(t.db, { id: newId("je"), at: NOW, lines: [{ accountId: cash, debitIqd: 5 }, { accountId: revenue, creditIqd: 4 }] })).toThrow(JournalEntryError);
    expect(() => journalEntryStatements(t.db, { id: newId("je"), at: NOW, lines: [{ accountId: cash, debitIqd: 5, creditIqd: 5 }, { accountId: revenue, creditIqd: 5 }] })).toThrow(/exactly one/);
    // A line with both sides, or none, is refused by the table itself.
    expect(await refused(() => t.db.insert(journalLines).values({ id: newId("jl"), entryId: newId("je"), accountId: cash, debitIqd: 5, creditIqd: 5 }))).toMatchObject({ code: "CHECK", constraint: "journal_lines_side_check" });
  });

  test("a posted entry is sealed: no further lines, no edits, one reversal", async () => {
    const id = newId("je");
    const post = (entryId: string, debit: string, credit: string, extra: { reversesId?: string } = {}) =>
      runBatch(t.db, journalEntryStatements(t.db, { id: entryId, at: NOW, lines: [{ accountId: debit, debitIqd: 25_000 }, { accountId: credit, creditIqd: 25_000 }], ...extra }));
    await post(id, cash, revenue);

    expect(await refused(() => t.db.insert(journalLines).values({ id: `${id}.3`, entryId: id, accountId: cash, debitIqd: 1 }))).toMatchObject({ code: "JOURNAL_SEALED", detail: id });
    expect(await refused(() => t.db.update(journalEntries).set({ memo: "edited" }).where(eq(journalEntries.id, id)))).toMatchObject({ code: "IMMUTABLE", detail: "journal_entries" });
    expect(await refused(() => t.db.delete(journalLines).where(eq(journalLines.entryId, id)))).toMatchObject({ code: "IMMUTABLE", detail: "journal_lines" });

    // Corrections are reversal entries — and an entry is reversed at most once.
    await post(newId("je"), revenue, cash, { reversesId: id });
    let second: unknown;
    try {
      await post(newId("je"), revenue, cash, { reversesId: id });
    } catch (caught) {
      second = caught;
    }
    expect(isUniqueViolation(second, "journal_entries.reverses_id")).toBe(true);
    expect(await scalar("SELECT sum(debit_iqd) - sum(credit_iqd) FROM journal_lines")).toBe(0);
  });

  test("nothing can be posted into a closed period, and one business event posts once", async () => {
    const october = Date.UTC(2026, 9, 15, 9, 0, 0);
    const lines = [{ accountId: cash, debitIqd: 1_000 }, { accountId: revenue, creditIqd: 1_000 }];
    await runBatch(t.db, journalEntryStatements(t.db, { id: newId("je"), at: october, lines }));

    await t.db.insert(fiscalPeriods).values({ period: "2026-10", status: "closed", closedBy: "emp_finance", closedAt: NOW });
    const late = newId("je");
    const error = await refused(() => runBatch(t.db, journalEntryStatements(t.db, { id: late, at: october, lines })));
    expect(error).toMatchObject({ code: "PERIOD_CLOSED", detail: "2026-10", status: 409 });
    expect(await scalar("SELECT count(*) FROM journal_lines WHERE entry_id = ?", late)).toBe(0);

    // The current, open period still accepts entries; a replayed event does not post twice.
    const key = `payment:${next("pay")}:received`;
    await runBatch(t.db, journalEntryStatements(t.db, { id: newId("je"), at: NOW, idempotencyKey: key, lines }));
    let replay: unknown;
    try {
      await runBatch(t.db, journalEntryStatements(t.db, { id: newId("je"), at: NOW, idempotencyKey: key, lines }));
    } catch (caught) {
      replay = caught;
    }
    expect(isUniqueViolation(replay, "journal_entries.idempotency_key")).toBe(true);
    expect(await scalar("SELECT count(*) FROM journal_entries WHERE idempotency_key = ?", key)).toBe(1);
  });

  test("fiscalPeriodOf uses Asia/Baghdad time", () => {
    expect(fiscalPeriodOf(Date.UTC(2026, 9, 31, 20, 59, 59))).toBe("2026-10"); // 23:59:59 in Baghdad
    expect(fiscalPeriodOf(Date.UTC(2026, 9, 31, 21, 0, 0))).toBe("2026-11"); // midnight in Baghdad
  });
});

// ───────────────────────────────────────────────────────────────── reference data

describe("seedReference", () => {
  test("Iraq's 19 governorates and their districts, in three languages", async () => {
    const rows = await t.db.select().from(governorates);
    expect(rows).toHaveLength(19);
    expect(rows.map((row) => row.slug).sort()).toEqual(
      ["anbar", "babil", "baghdad", "basra", "dhi-qar", "diyala", "duhok", "erbil", "halabja", "karbala", "kirkuk", "maysan", "muthanna", "najaf", "nineveh", "qadisiyah", "salah-al-din", "sulaymaniyah", "wasit"].sort(),
    );
    for (const row of rows) {
      expect(row.isActive).toBe(true);
      expect(row.name.ar, row.slug).toMatch(/\p{Script=Arabic}/u);
      expect(row.name.en, row.slug).toMatch(/^[A-Za-z' -]+$/);
      expect(row.name.ckb, row.slug).toMatch(/\p{Script=Arabic}/u);
    }
    expect(rows.find((row) => row.slug === "halabja")?.name).toEqual({ ar: "حلبجة", en: "Halabja", ckb: "هەڵەبجە" });

    const all = await t.db.select().from(districts);
    expect(all).toHaveLength(IRAQ_GOVERNORATES.reduce((sum, governorate) => sum + governorate.districts.length, 0));
    expect(all.length).toBeGreaterThanOrEqual(120);
    for (const governorate of rows) {
      const own = all.filter((district) => district.governorateId === governorate.id);
      expect(own.length, governorate.slug).toBeGreaterThanOrEqual(3);
    }
    for (const district of all) {
      expect(district.name.ar, district.id).toMatch(/\p{Script=Arabic}/u);
      expect(district.name.en, district.id).toMatch(/^[A-Za-z' -]+$/);
      expect(district.name.ckb, district.id).toMatch(/\p{Script=Arabic}/u);
    }
    expect(new Set(all.map((district) => district.id)).size).toBe(all.length);
  });

  test("the settings defaults of ARCHITECTURE §10, exactly", async () => {
    const rows = await t.db.select().from(settings);
    expect(Object.fromEntries(rows.map((row) => [row.key, row.value]))).toEqual({
      "shipping.flat_fee_iqd": 5000,
      "shipping.overrides_enabled": false,
      "payments.cod": { enabled: true },
      "payments.wallet": { enabled: true },
      "payments.bank_transfer": { enabled: true, account_number: "9269317427", recipient_name: "علي خليفة" },
      "payments.zaincash": { enabled: true, number: "07719061852" },
      "checkout.reservation_minutes": 30,
      "checkout.transfer_proof_hours": 24,
      "returns.window_days": 7,
      "tradein.estimate_valid_days": 7,
      "store.contact": {},
      "locale.numbering": { ar: "latn", en: "latn", ckb: "latn" },
    });
    expect(Object.keys(SETTINGS_DEFAULTS)).toHaveLength(12);
  });

  test("a sellable default location, the chart of accounts and the inspection templates", async () => {
    const [location] = await t.db.select().from(inventoryLocations).where(eq(inventoryLocations.id, DEFAULT_LOCATION_ID));
    expect(location).toMatchObject({ code: "MAIN", kind: "warehouse", isSellable: true, isActive: true });

    const chart = await t.db.select().from(accounts);
    expect(chart).toHaveLength(CHART_OF_ACCOUNTS.length);
    const byKey = Object.fromEntries(chart.map((account) => [account.systemKey, account]));
    for (const key of ["cash", "bank_clearing", "cod_receivable", "wallet_liability", "inventory", "sales_revenue", "sales_discounts", "shipping_income", "cogs", "sales_refunds", "operating_expenses"]) {
      expect(byKey[key], key).toBeDefined();
      expect(byKey[key]?.isSystem).toBe(true);
    }
    expect(byKey.cash?.type).toBe("asset");
    expect(byKey.wallet_liability?.type).toBe("liability");
    expect(byKey.sales_discounts).toMatchObject({ type: "revenue", isContra: true });
    expect(byKey.shipping_costs?.parentId).toBe(accountId("operating_expenses"));

    const templates = await t.db.select().from(inspectionTemplates);
    expect(templates.map((template) => template.deviceKind).sort()).toEqual(["console", "controller", "game", "handheld_pc"]);
    const keys = (kind: string) => templates.find((template) => template.deviceKind === kind)?.items.map((entry) => entry.key) ?? [];
    expect(keys("console")).toEqual(expect.arrayContaining(["screen", "battery", "ports", "buttons", "sticks", "heat", "wifi", "storage", "account_lock", "accessories"]));
    expect(keys("handheld_pc")).toEqual(expect.arrayContaining(["screen", "battery", "ports", "buttons", "sticks", "heat", "wifi", "storage", "account_lock", "accessories"]));
    expect(keys("controller")).toEqual(expect.arrayContaining(["buttons", "sticks", "battery", "ports", "accessories"]));
    for (const template of templates) {
      for (const entry of template.items) {
        expect(entry.label.ar && entry.label.en && entry.label.ckb, `${template.deviceKind}.${entry.key}`).toBeTruthy();
      }
    }
  });

  test("is idempotent and never overwrites what an admin changed", async () => {
    const counts = async () => ({
      governorates: await scalar("SELECT count(*) FROM governorates"),
      districts: await scalar("SELECT count(*) FROM districts"),
      settings: await scalar("SELECT count(*) FROM settings"),
      accounts: await scalar("SELECT count(*) FROM accounts"),
      templates: await scalar("SELECT count(*) FROM inspection_templates"),
      locations: await scalar("SELECT count(*) FROM inventory_locations"),
      channels: await scalar("SELECT count(*) FROM channels"),
    });
    const before = await counts();

    await t.db.update(settings).set({ value: 7_500, updatedAt: NOW + 1, updatedBy: "emp_owner" }).where(eq(settings.key, "shipping.flat_fee_iqd"));
    await t.db.update(districts).set({ isActive: false, name: { ar: "الكرخ (معدّل)" } }).where(eq(districts.id, "dst_baghdad_karkh"));

    const result = await seedReference(t.db, NOW + 2);
    expect(result).toMatchObject({ governorates: 19, settings: 12 });
    expect(await counts()).toEqual(before);
    expect(await scalar("SELECT value FROM settings WHERE key = 'shipping.flat_fee_iqd'")).toBe("7500");
    const [karkh] = await t.db.select().from(districts).where(eq(districts.id, "dst_baghdad_karkh"));
    expect(karkh).toMatchObject({ isActive: false, name: { ar: "الكرخ (معدّل)" } });

    // `overwrite` restores names, but still leaves settings and on/off switches alone.
    await seedReference(t.db, NOW + 3, { overwrite: true });
    const [restored] = await t.db.select().from(districts).where(eq(districts.id, "dst_baghdad_karkh"));
    expect(restored).toMatchObject({ isActive: false, name: { ar: "الكرخ", en: "Karkh", ckb: "کەرخ" } });
    expect(await scalar("SELECT value FROM settings WHERE key = 'shipping.flat_fee_iqd'")).toBe("7500");
    expect(await counts()).toEqual(before);

    await t.db.update(settings).set({ value: 5000, updatedAt: NOW, updatedBy: null }).where(eq(settings.key, "shipping.flat_fee_iqd"));
    await t.db.update(districts).set({ isActive: true }).where(eq(districts.id, "dst_baghdad_karkh"));
  });
});
