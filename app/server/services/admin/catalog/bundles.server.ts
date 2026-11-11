/**
 * Admin catalogue — bundles (02.07, catalog.bundle.manage): a bundle variant is made of component variants
 * (console + game + case …), and it is available only as far as EVERY component is.
 *
 *   const bundle = await getBundle(db, actor, productId, locale);
 *   await setBundleComponent(db, actor, { productId, bundleVariantId, component, qty }, now);   // add or change qty
 *   await removeBundleComponent(db, actor, { productId, bundleVariantId, componentVariantId, reason }, now);
 *
 * Stock is the stock core's: getAvailability() counts complete sets (the scarcest component decides) and selling a
 * bundle reserves and moves its components — nothing here touches stock_levels. One level only: a component is a
 * stocked variant, never another bundle, and a bundle variant is never a component (stock.server.ts rule).
 * `component` may be typed or scanned: a SKU or a barcode.
 *
 * Components go only on the variants of a product of kind "bundle" (`bundle_kind`), and never on a variant that holds
 * units, reservations or serials of its own (`bundle_stocked`, checked inside the batch): the stock core treats ANY
 * variant with components as a bundle, so a console with consoles on the shelf would stop selling them and sell its
 * "components" instead.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { bundleItems, products, variants } from "~/server/db/schema";
import { expectThat, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { getAvailability } from "~/server/services/inventory/stock.server";
import { assertNoRegression, catalogError, completenessWith, parseInput, productCompleteness, requireProductState, rethrowCatalog, zId, zReason } from "./common.server";
import { adminStatusOf, MAX_COMPONENT_QTY, requirementsOf, type AdminStatus } from "./rules";
import { findVariantByCode } from "./variants.server";

export { MAX_COMPONENT_QTY };

export type BundleComponentView = {
  variantId: string;
  sku: string;
  productId: string;
  productName: string;
  title: string;
  qty: number;
  available: number;
  /** How many complete bundles this component alone allows (available ÷ qty, rounded down). */
  sets: number;
  /** This component decides the bundle's availability (the scarcest). */
  limiting: boolean;
  isActive: boolean;
  productStatus: AdminStatus;
};

export type BundleView = {
  productId: string;
  kind: string;
  live: boolean;
  variants: { id: string; sku: string; title: string; isActive: boolean; available: number; components: BundleComponentView[] }[];
};

export async function getBundle(db: Db, actor: Actor, productId: string, locale: Locale): Promise<BundleView> {
  assertCan(actor, "catalog.product.read");
  const state = await requireProductState(db, productId);
  const ids = state.variants.map((variant) => variant.id);
  const items =
    ids.length === 0
      ? []
      : await db
          .select({
            bundleId: bundleItems.bundleVariantId,
            componentId: bundleItems.componentVariantId,
            qty: bundleItems.qty,
            sku: variants.sku,
            title: variants.title,
            isActive: variants.isActive,
            productId: products.id,
            productName: products.name,
            productStatus: products.status,
            publishedAt: products.publishedAt,
          })
          .from(bundleItems)
          .innerJoin(variants, eq(variants.id, bundleItems.componentVariantId))
          .innerJoin(products, eq(products.id, variants.productId))
          .where(inArray(bundleItems.bundleVariantId, ids));
  const availability = await getAvailability(db, [...ids, ...items.map((item) => item.componentId)]);
  return {
    productId,
    kind: state.product.kind,
    live: state.product.status === "published" || state.product.status === "scheduled",
    variants: state.variants.map((variant) => {
      const parts = items.filter((item) => item.bundleId === variant.id);
      const sets = parts.map((part) => Math.floor((availability.get(part.componentId)?.available ?? 0) / Math.max(1, part.qty)));
      const scarcest = sets.length > 0 ? Math.min(...sets) : 0;
      return {
        id: variant.id,
        sku: variant.sku,
        title: pick(variant.title, locale),
        isActive: variant.isActive,
        // With components, the stock core's answer is the number of complete sets.
        available: availability.get(variant.id)?.available ?? 0,
        components: parts.map((part, index) => ({
          variantId: part.componentId,
          sku: part.sku,
          productId: part.productId,
          productName: pick(part.productName, locale),
          title: pick(part.title, locale),
          qty: part.qty,
          available: availability.get(part.componentId)?.available ?? 0,
          sets: sets[index],
          limiting: sets[index] === scarcest,
          isActive: part.isActive,
          productStatus: adminStatusOf({ status: part.productStatus, publishedAt: part.publishedAt }),
        })),
      };
    }),
  };
}

export const ComponentInput = z.object({
  productId: zId,
  bundleVariantId: zId,
  component: z.string({ error: "required" }).trim().min(1, "required").max(64, "too_long"),
  qty: z.coerce.number({ error: "invalid" }).int("invalid").min(1, "too_small").max(MAX_COMPONENT_QTY, "too_big"),
});

export async function setBundleComponent(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ componentVariantId: string; previousQty: number | null }> {
  assertCan(actor, "catalog.bundle.manage");
  const input = parseInput(ComponentInput, raw);
  const state = await requireProductState(db, input.productId);
  const bundle = state.variants.find((variant) => variant.id === input.bundleVariantId);
  if (!bundle) throw notFound("variant");
  if (state.product.kind !== "bundle") throw catalogError("bundle_kind", 409);
  const component = await findVariantByCode(db, input.component);
  if (!component) throw catalogError("component_unknown", 400, { fields: { component: "component_unknown" } });
  if (component.id === bundle.id || component.productId === input.productId) throw catalogError("bundle_self", 400, { fields: { component: "bundle_self" } });
  const nesting = await db.get<{ component_is_bundle: number; bundle_is_component: number }>(
    sql`SELECT EXISTS (SELECT 1 FROM bundle_items WHERE bundle_variant_id = ${component.id}) AS component_is_bundle,
               EXISTS (SELECT 1 FROM bundle_items WHERE component_variant_id = ${bundle.id}) AS bundle_is_component`,
  );
  if (Number(nesting?.component_is_bundle) === 1 || Number(nesting?.bundle_is_component) === 1) throw catalogError("bundle_nested", 400, { fields: { component: "bundle_nested" } });

  const current = await db.select({ qty: bundleItems.qty }).from(bundleItems).where(and(eq(bundleItems.bundleVariantId, bundle.id), eq(bundleItems.componentVariantId, component.id))).get();
  if (current?.qty === input.qty) return { componentVariantId: component.id, previousQty: current.qty };
  await runBatch(db, [
    // A bundle has no stock of its own: units, reservations or serials on this variant would be stranded (never sold,
    // never counted) once it has components. Checked here, in the batch, so a receipt cannot slip in between.
    expectThat(
      db,
      sql`NOT EXISTS (SELECT 1 FROM stock_levels WHERE variant_id = ${bundle.id} AND (on_hand <> 0 OR reserved <> 0))
        AND NOT EXISTS (SELECT 1 FROM serials WHERE variant_id = ${bundle.id} AND status IN ('in_stock', 'reserved', 'intake'))
        AND NOT EXISTS (SELECT 1 FROM stock_reservations WHERE variant_id = ${bundle.id} AND status = 'active')`,
      { code: "BUNDLE_STOCKED", detail: bundle.id },
    ),
    db
      .insert(bundleItems)
      .values({ bundleVariantId: bundle.id, componentVariantId: component.id, qty: input.qty })
      .onConflictDoUpdate({ target: [bundleItems.bundleVariantId, bundleItems.componentVariantId], set: { qty: input.qty } }),
    auditStatement(db, {
      actor,
      action: current ? "catalog.bundle.update" : "catalog.bundle.add",
      entityType: "variant",
      entityId: bundle.id,
      summary: `${bundle.sku} ← ${component.sku} × ${input.qty}`,
      before: current ? { component: component.sku, qty: current.qty } : null,
      after: { component: component.sku, qty: input.qty },
      at: now,
    }),
  ]).catch(rethrowCatalog);
  return { componentVariantId: component.id, previousQty: current?.qty ?? null };
}

export const RemoveComponentInput = z.object({ productId: zId, bundleVariantId: zId, componentVariantId: zId, reason: zReason(true) });

export async function removeBundleComponent(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ removed: boolean }> {
  assertCan(actor, "catalog.bundle.manage");
  const input = parseInput(RemoveComponentInput, raw);
  const state = await requireProductState(db, input.productId);
  const bundle = state.variants.find((variant) => variant.id === input.bundleVariantId);
  if (!bundle) throw notFound("variant");
  const current = await db
    .select({ qty: bundleItems.qty, sku: variants.sku })
    .from(bundleItems)
    .innerJoin(variants, eq(variants.id, bundleItems.componentVariantId))
    .where(and(eq(bundleItems.bundleVariantId, bundle.id), eq(bundleItems.componentVariantId, input.componentVariantId)))
    .get();
  if (!current) return { removed: false };
  const remaining = await db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM bundle_items WHERE bundle_variant_id = ${bundle.id}`);
  let guard: BatchStatement | null = null;
  if (bundle.isActive && (state.product.status === "published" || state.product.status === "scheduled")) {
    const before = await productCompleteness(db, input.productId);
    // The last component: the variant would become a bundle of nothing.
    if (before && Number(remaining?.n ?? 0) <= 1) assertNoRegression(state.product.status, before.completeness, completenessWith(before.facts, { variantsWithoutComponents: before.facts.variantsWithoutComponents + 1 }));
    // Two tabs removing the last two components at once each see two: the batch checks again.
    if (before && requirementsOf(state.product.kind).includes("bundle_components") && before.facts.variantsWithoutComponents === 0) {
      guard = expectThat(db, sql`EXISTS (SELECT 1 FROM bundle_items WHERE bundle_variant_id = ${bundle.id})`, { code: "REGRESSION", detail: "bundle_components" });
    }
  }
  if (!input.componentVariantId) throw invalid({ componentVariantId: "required" });
  await runBatch(db, [
    db.delete(bundleItems).where(and(eq(bundleItems.bundleVariantId, bundle.id), eq(bundleItems.componentVariantId, input.componentVariantId))),
    ...(guard ? [guard] : []),
    auditStatement(db, { actor, action: "catalog.bundle.remove", entityType: "variant", entityId: bundle.id, summary: `${bundle.sku} − ${current.sku}`, before: { component: current.sku, qty: current.qty }, reason: input.reason, at: now }),
  ]).catch(rethrowCatalog);
  return { removed: true };
}
