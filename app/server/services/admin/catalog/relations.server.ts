/**
 * Admin catalogue — editorial relations between products (02.08, catalog.relation.manage): accessories,
 * alternatives, upgrades, upsells and "complete your setup", plus suggestions of compatible accessories.
 *
 *   const view = await getRelations(db, actor, productId, locale);
 *   await addRelation(db, actor, { productId, related, kind, pinned }, now);    // related: slug, SKU or barcode
 *   await updateRelation(db, actor, { productId, relatedProductId, kind, pinned, sort }, now);
 *   await removeRelation(db, actor, { productId, relatedProductId, kind, reason }, now);
 *
 * Relations hold product ids (the entity rule: the original reference, never an editable name). They are editorial
 * suggestions: the storefront's recommendations still pass the compatibility filter, so an "accessory" link never
 * claims compatibility by itself. Suggestions come from compatibility rules: accessories whose verified or partial
 * rules name this product's device model (or its generation or platform).
 */
import { and, asc, eq, or, sql } from "drizzle-orm";
import { z } from "zod";
import { pick, type Locale } from "~/lib/locales";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { Db } from "~/server/db/drizzle.server";
import { productRelations, products, variants } from "~/server/db/schema";
import { runBatch } from "~/server/db/tx.server";
import { notFound } from "~/server/errors";
import { catalogError, parseInput, requireProductState, zBool, zId, zReason } from "./common.server";
import { adminStatusOf, RELATION_KIND_LIST, type AdminStatus } from "./rules";

export type RelationView = { relatedProductId: string; slug: string; name: string; kind: (typeof RELATION_KIND_LIST)[number]; pinned: boolean; sort: number; status: AdminStatus };

export type RelationsView = {
  productId: string;
  outgoing: RelationView[];
  /** Products that point at this one (read-only here; edit them on their own page). */
  incoming: RelationView[];
  /** Compatible accessories not linked yet (from compatibility rules on this product's device). */
  suggestions: { productId: string; slug: string; name: string; kind: string; status: string }[];
  deviceModelId: string | null;
};

export async function getRelations(db: Db, actor: Actor, productId: string, locale: Locale): Promise<RelationsView> {
  assertCan(actor, "catalog.product.read");
  const state = await requireProductState(db, productId);
  const rows = await db
    .select({
      productId: productRelations.productId,
      relatedProductId: productRelations.relatedProductId,
      kind: productRelations.kind,
      pinned: productRelations.pinned,
      sort: productRelations.sort,
    })
    .from(productRelations)
    .where(or(eq(productRelations.productId, productId), eq(productRelations.relatedProductId, productId)))
    .orderBy(asc(productRelations.kind), asc(productRelations.sort));
  const otherIds = [...new Set(rows.map((row) => (row.productId === productId ? row.relatedProductId : row.productId)))];
  const others =
    otherIds.length === 0
      ? []
      : await db
          .select({ id: products.id, slug: products.slug, name: products.name, status: products.status, publishedAt: products.publishedAt })
          .from(products)
          .where(sql`${products.id} IN (SELECT value FROM json_each(${JSON.stringify(otherIds)}))`);
  const byId = new Map(others.map((row) => [row.id, row]));
  const view = (row: (typeof rows)[number], otherId: string): RelationView | null => {
    const other = byId.get(otherId);
    if (!other) return null;
    return { relatedProductId: otherId, slug: other.slug, name: pick(other.name, locale), kind: row.kind, pinned: row.pinned, sort: row.sort, status: adminStatusOf(other) };
  };
  const outgoing = rows.filter((row) => row.productId === productId).map((row) => view(row, row.relatedProductId)).filter((row): row is RelationView => row !== null);
  const incoming = rows.filter((row) => row.relatedProductId === productId).map((row) => view(row, row.productId)).filter((row): row is RelationView => row !== null);

  const linked = new Set(outgoing.map((row) => row.relatedProductId));
  let suggestions: RelationsView["suggestions"] = [];
  const modelId = state.product.deviceModelId;
  if (modelId) {
    const found = await db.all<{ id: string; slug: string; name: string; kind: string; status: string }>(sql`
      SELECT DISTINCT p.id, p.slug, p.name, p.kind, r.status
      FROM compatibility_rules r
      JOIN products p ON p.id = r.subject_id AND r.subject_type = 'product'
      JOIN device_models dm ON dm.id = ${modelId}
      WHERE r.status IN ('verified', 'partial') AND p.id <> ${productId} AND p.kind IN ('accessory', 'controller', 'headset', 'storage', 'part')
        AND p.status IN ('published', 'scheduled', 'draft', 'review')
        AND ((r.target_type = 'device_model' AND r.target_id = dm.id) OR (r.target_type = 'generation' AND r.target_id = dm.generation_id) OR (r.target_type = 'platform' AND r.target_id = dm.platform_id))
      ORDER BY r.status, p.kind, p.slug
      LIMIT 40`);
    suggestions = found
      .filter((row) => !linked.has(row.id))
      .map((row) => {
        let name = row.slug;
        try {
          name = pick(JSON.parse(row.name), locale) || row.slug;
        } catch {
          /* keep slug */
        }
        return { productId: row.id, slug: row.slug, name, kind: row.kind, status: row.status };
      });
  }
  return { productId, outgoing, incoming, suggestions, deviceModelId: modelId };
}

/** The product a typed or scanned value names: its slug, or a SKU or barcode of one of its variants. */
async function findProduct(db: Db, value: string): Promise<{ id: string; slug: string } | null> {
  const clean = value.trim();
  if (!clean || clean.length > 128) return null;
  const bySlug = await db.select({ id: products.id, slug: products.slug }).from(products).where(eq(products.slug, clean.toLowerCase())).get();
  if (bySlug) return bySlug;
  const byCode = await db
    .select({ id: products.id, slug: products.slug })
    .from(variants)
    .innerJoin(products, eq(products.id, variants.productId))
    .where(or(eq(variants.sku, clean.toUpperCase()), eq(variants.barcode, clean)))
    .get();
  return byCode ?? null;
}

const zKind = z.enum(RELATION_KIND_LIST, { error: "invalid" });

export const AddRelationInput = z.object({ productId: zId, related: z.string({ error: "required" }).trim().min(1, "required").max(128, "too_long"), kind: zKind, pinned: zBool });

export async function addRelation(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ relatedProductId: string; replayed: boolean }> {
  assertCan(actor, "catalog.relation.manage");
  const input = parseInput(AddRelationInput, raw);
  const state = await requireProductState(db, input.productId);
  const related = await findProduct(db, input.related);
  if (!related) throw catalogError("target_unknown", 400, { fields: { related: "target_unknown" } });
  if (related.id === input.productId) throw catalogError("relation_self", 400, { fields: { related: "relation_self" } });
  const exists = await db
    .select({ sort: productRelations.sort })
    .from(productRelations)
    .where(and(eq(productRelations.productId, input.productId), eq(productRelations.relatedProductId, related.id), eq(productRelations.kind, input.kind)))
    .get();
  if (exists) return { relatedProductId: related.id, replayed: true };
  const last = await db.get<{ n: number | null }>(sql`SELECT MAX(sort) AS n FROM product_relations WHERE product_id = ${input.productId} AND kind = ${input.kind}`);
  const sort = last?.n === null || last?.n === undefined ? 0 : Number(last.n) + 1;
  await runBatch(db, [
    db.insert(productRelations).values({ productId: input.productId, relatedProductId: related.id, kind: input.kind, pinned: input.pinned, sort }).onConflictDoNothing(),
    auditStatement(db, { actor, action: "catalog.relation.add", entityType: "product", entityId: input.productId, summary: `${state.product.slug} → ${related.slug} (${input.kind})`, after: { related: related.id, kind: input.kind, pinned: input.pinned }, at: now }),
  ]);
  return { relatedProductId: related.id, replayed: false };
}

export const UpdateRelationInput = z.object({
  productId: zId,
  relatedProductId: zId,
  kind: zKind,
  pinned: zBool,
  direction: z.preprocess((value) => (value === "" ? undefined : value), z.enum(["up", "down"]).optional()),
});

export async function updateRelation(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "catalog.relation.manage");
  const input = parseInput(UpdateRelationInput, raw);
  const siblings = await db
    .select()
    .from(productRelations)
    .where(and(eq(productRelations.productId, input.productId), eq(productRelations.kind, input.kind)))
    .orderBy(asc(productRelations.sort), asc(productRelations.relatedProductId));
  const index = siblings.findIndex((row) => row.relatedProductId === input.relatedProductId);
  if (index === -1) throw notFound("relation");
  const order = siblings.map((row) => row.relatedProductId);
  if (input.direction) {
    const target = input.direction === "up" ? index - 1 : index + 1;
    if (target >= 0 && target < order.length) [order[index], order[target]] = [order[target], order[index]];
  }
  const where = (related: string) => and(eq(productRelations.productId, input.productId), eq(productRelations.relatedProductId, related), eq(productRelations.kind, input.kind));
  await runBatch(db, [
    ...order.map((related, position) => db.update(productRelations).set({ sort: position, ...(related === input.relatedProductId ? { pinned: input.pinned } : {}) }).where(where(related))),
    auditStatement(db, {
      actor,
      action: "catalog.relation.update",
      entityType: "product",
      entityId: input.productId,
      summary: `${input.relatedProductId} (${input.kind})`,
      before: { pinned: siblings[index].pinned, position: index + 1 },
      after: { pinned: input.pinned, position: order.indexOf(input.relatedProductId) + 1 },
      at: now,
    }),
  ]);
}

export const RemoveRelationInput = z.object({ productId: zId, relatedProductId: zId, kind: zKind, reason: zReason(false) });

export async function removeRelation(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ removed: boolean }> {
  assertCan(actor, "catalog.relation.manage");
  const input = parseInput(RemoveRelationInput, raw);
  const where = and(eq(productRelations.productId, input.productId), eq(productRelations.relatedProductId, input.relatedProductId), eq(productRelations.kind, input.kind));
  const row = await db.select().from(productRelations).where(where).get();
  if (!row) return { removed: false };
  await runBatch(db, [
    db.delete(productRelations).where(where),
    auditStatement(db, { actor, action: "catalog.relation.remove", entityType: "product", entityId: input.productId, summary: `${input.relatedProductId} (${input.kind})`, before: row, reason: input.reason ?? null, at: now }),
  ]);
  return { removed: true };
}
