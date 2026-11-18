/**
 * The owner's price sheet (catalog/owner-sheet-2026-11-18.json) applied to a database that may already hold the old
 * demo catalogue — production D1 was seeded with it ("insert if missing"), so inserting the new state is not enough:
 * the rows that are already there have to MOVE to it. These statements do that, and nothing else.
 *
 *   const statements = ownerTransitionStatements(db, data, now);   // data = buildDemoData(catalog, { ownerSheet: true })
 *
 * seedDemo({ ownerSheet: true }) puts them in its one batch after the categories and before the products, variants and
 * stock rows (which are "insert if missing"). On an empty database each of them changes nothing; on a database with the
 * demo rows they:
 *
 *   prices      set every variant of a product on the sheet to its sheet price (no "was" price), active when the sheet
 *               prices it, inactive with price 0 when it is not on the sheet (or has no price there) — but only while
 *               nobody has touched it: no price_changes row for the variant (every admin price change writes one) and
 *               the product never saved in the admin (products.updated_by IS NULL).
 *   stock       move the main location's level to what the sheet says (1 unit for a sheet row, 0 for a variant not on
 *               it) with ONE appended "adjust" movement (ref_type owner_sheet, id smv_sheet_<sku> / smv_sheet_out_<sku>)
 *               whose delta is the difference, and set on_hand to the sum of the variant's movements there — but only
 *               while the level is seed-made: every movement of the variant is a seed's (ref_type demo_seed or
 *               owner_sheet) and nothing is reserved. A sale, a receipt, a count or an adjustment by staff writes a
 *               movement of its own, and from then on the level is never touched again. The movement id is stable, so
 *               a second run finds it and adds nothing: the stock is never doubled.
 *   serials     the fake DEMO serials of such a level are set aside (status scrapped, with a note saying why).
 *   cost        the invented demo cost is removed: the variant_costs row the seed wrote (updated_by IS NULL) and the
 *               remaining units of the demo opening cost layer (qty_remaining 0). Nothing is put in its place — the
 *               sheet has no costs; the owner enters them (receiving or the pricing screen).
 *   products    a product on the sheet: is_demo = 0, status published (draft when the sheet prices none of its
 *               variants), its category; every other product: archived (hidden, not deleted) — again only while the
 *               admin never saved it.
 *   used units  the six demo used units are taken off the listing (status ready): they are not the owner's.
 *
 * Every statement is a plain single-table INSERT … SELECT / UPDATE / DELETE with scalar sub-queries (no compound
 * SELECT), so the --sql file runs on D1 as it is, and running it twice is harmless.
 */
import { sql, type SQL } from "drizzle-orm";
import type { Db, BatchStatement } from "../../drizzle.server";
import { batchSql } from "../../tx.server";
import { DEFAULT_LOCATION_ID } from "../reference";
import { OWNER_SHEET_DATE } from "./catalog/types";
import { DEMO_REF_TYPE, OWNER_SHEET_ACTOR_ID, OWNER_SHEET_REF_TYPE, demoId } from "./ids";
import type { DemoData, DemoVariant } from "./import";
import { DEMO_USED_UNITS } from "./used";

/** The stock movement texts of the owner's sheet (Arabic, as the other movement reasons). */
export const sheetOpeningReason = (row: number | null) => `رصيد افتتاحي من جرد المالك ${OWNER_SHEET_DATE}${row !== null ? ` (الصف ${row})` : ""}`;
export const SHEET_WITHDRAWAL_REASON = `سحب الرصيد التجريبي (DEMO): هذا الإصدار ليس في جرد المالك ${OWNER_SHEET_DATE}`;
export const sheetRefId = (row: number | null) => `owner-sheet-${OWNER_SHEET_DATE}${row !== null ? `:row-${row}` : ""}`;
const DEMO_SERIAL_WITHDRAWN_NOTE = `وحدة تجريبية (DEMO) — سُحبت: المخزون الحقيقي من جرد المالك ${OWNER_SHEET_DATE}`;

/** Units of a real product's variant on hand per the sheet: 1 for a sheet row, 0 otherwise. */
const targetOf = (variant: DemoVariant) => variant.ownerStock ?? 0;

export function ownerTransitionStatements(db: Db, data: DemoData, now: number): BatchStatement[] {
  const out: BatchStatement[] = [];
  const add = (query: SQL) => out.push(batchSql(db, query));
  const loc = DEFAULT_LOCATION_ID;

  for (const product of data.products) {
    const productId = demoId.product(product.slug);
    if (product.isDemo) {
      if (product.status === "archived") {
        add(sql`UPDATE products SET status = 'archived', updated_at = ${now} WHERE id = ${productId} AND updated_by IS NULL AND status <> 'archived'`);
      }
      continue;
    }
    const untouchedProduct = sql`(SELECT updated_by FROM products WHERE id = ${productId}) IS NULL`;
    for (const variant of product.variants) {
      const variantId = demoId.variant(variant.sku);
      const active = variant.isActive ? 1 : 0;
      const isDefault = variant.isDefault ? 1 : 0;
      // price, "was" price, on sale or not, default
      add(sql`UPDATE variants SET price_iqd = ${variant.priceIqd}, compare_at_iqd = NULL, is_active = ${active}, is_default = ${isDefault}, updated_at = ${now}
        WHERE id = ${variantId} AND NOT EXISTS (SELECT 1 FROM price_changes WHERE variant_id = ${variantId}) AND ${untouchedProduct}
          AND (price_iqd <> ${variant.priceIqd} OR compare_at_iqd IS NOT NULL OR is_active <> ${active} OR is_default <> ${isDefault})`);

      // stock: only while every movement of the variant is a seed's and nothing is reserved
      const target = targetOf(variant);
      const movementId = target > 0 ? demoId.sheetOpening(variant.sku) : demoId.sheetWithdrawal(variant.sku);
      const seedOnly = sql`NOT EXISTS (SELECT 1 FROM stock_movements WHERE variant_id = ${variantId} AND (ref_type IS NULL OR ref_type NOT IN (${DEMO_REF_TYPE}, ${OWNER_SHEET_REF_TYPE})))`;
      const movementSum = sql`(SELECT coalesce(sum(qty_delta), 0) FROM stock_movements WHERE variant_id = ${variantId} AND location_id = ${loc})`;
      const reason = target > 0 ? sheetOpeningReason(variant.sheetRow) : SHEET_WITHDRAWAL_REASON;
      // A withdrawal only when there is something to withdraw; the opening balance always says where the unit came from.
      const needed = target > 0 ? sql`1 = 1` : sql`${movementSum} <> 0`;
      add(sql`INSERT INTO stock_movements (id, variant_id, location_id, serial_id, kind, qty_delta, reserved_delta, unit_cost_iqd, ref_type, ref_id, reason, actor_kind, actor_id, at)
        SELECT ${movementId}, ${variantId}, ${loc}, NULL, 'adjust', ${target} - ${movementSum}, 0, NULL, ${OWNER_SHEET_REF_TYPE}, ${sheetRefId(variant.sheetRow)}, ${reason}, 'system', ${OWNER_SHEET_ACTOR_ID}, ${now}
        FROM stock_levels WHERE variant_id = ${variantId} AND location_id = ${loc} AND reserved = 0 AND ${seedOnly}
          AND NOT EXISTS (SELECT 1 FROM stock_movements WHERE id = ${movementId}) AND ${needed}`);
      add(sql`UPDATE stock_levels SET on_hand = ${movementSum}, reorder_point = NULL, updated_at = ${now}
        WHERE variant_id = ${variantId} AND location_id = ${loc} AND reserved = 0 AND ${seedOnly} AND on_hand <> ${movementSum}
          AND EXISTS (SELECT 1 FROM stock_movements WHERE variant_id = ${variantId} AND ref_type = ${OWNER_SHEET_REF_TYPE})`);
      if (variant.trackSerials) {
        add(sql`UPDATE serials SET status = 'scrapped', notes = ${DEMO_SERIAL_WITHDRAWN_NOTE}, updated_at = ${now}
          WHERE variant_id = ${variantId} AND status = 'in_stock' AND source = 'purchase' AND source_ref = ${DEMO_REF_TYPE} AND ${seedOnly}
            AND EXISTS (SELECT 1 FROM stock_movements WHERE variant_id = ${variantId} AND ref_type = ${OWNER_SHEET_REF_TYPE})`);
      }
      // the invented demo cost goes; nothing replaces it
      add(sql`DELETE FROM variant_costs WHERE variant_id = ${variantId} AND updated_by IS NULL AND ${untouchedProduct}
        AND NOT EXISTS (SELECT 1 FROM cost_layers WHERE variant_id = ${variantId} AND source <> 'opening')`);
      add(sql`UPDATE cost_layers SET qty_remaining = 0 WHERE id = ${demoId.openingCostLayer(variant.sku)} AND source = 'opening' AND qty_remaining > 0 AND qty_remaining = qty_received AND ${seedOnly}`);
    }
    // last: the variant statements above read the product's untouched state
    const categoryId = demoId.category(product.category);
    add(sql`UPDATE products SET is_demo = 0, status = ${product.status}, category_id = ${categoryId}, published_at = coalesce(published_at, ${now}), updated_at = ${now}
      WHERE id = ${productId} AND updated_by IS NULL AND (is_demo <> 0 OR status <> ${product.status} OR category_id IS NOT ${categoryId})`);
  }

  for (const unit of DEMO_USED_UNITS) {
    add(sql`UPDATE used_units SET status = 'ready', listed_at = NULL, updated_at = ${now} WHERE id = ${demoId.usedUnit(unit.slug)} AND is_demo = 1 AND status = 'listed'`);
  }
  return out;
}
