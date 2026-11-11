/**
 * Admin catalogue — the category tree (02.02, catalog.category.manage) and the device knowledge graph: platforms,
 * generations and device models (catalog.platform.manage).
 *
 *   const tree = await getCategoryTree(db, actor, locale);          // nested, with product counts
 *   await saveCategory(db, actor, raw, now);                         // create (no id) or edit, incl. moving it
 *   await moveCategory(db, actor, { id, direction: "up" }, now);     // order among its siblings
 *   await deleteCategory(db, actor, { id, reason }, now);            // only when empty
 *   const graph = await getDeviceTaxonomy(db, actor, locale);
 *   await savePlatform / saveGeneration / saveDeviceModel(db, actor, raw, now);
 *
 * Rules: slugs are unique; a category cannot move under itself or its descendants and the tree is at most 4 levels
 * deep; a category with products or subcategories is deactivated, not deleted; switching off a category with products
 * on sale or scheduled under it (its whole branch) needs a reason (`reason_required`). Products keep their category by id
 * (entity rule: relations hold the original reference, never a name). A device model's generation belongs to the
 * same platform. Nothing here is deleted that other records point to: platforms are deactivated, models archived.
 * Every change is audited, and the storefront's cached menus and search vocabulary are dropped at once.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { categories, deviceGenerations, deviceModels, DEVICE_KINDS, DEVICE_MODEL_STATUSES, platforms, type Category } from "~/server/db/schema";
import { expectThat, isDbError, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { invalidateSearchCaches } from "~/server/services/search.server";
import { invalidateNavTaxonomy } from "~/server/services/catalog/taxonomy.server";
import { catalogError, parseInput, rethrowCatalog, specRows, specsFromRows, zBool, zId, zL10n, zL10nRequired, zOptionalId, zReason, zSpecRows, zText, type SpecRow } from "./common.server";
import { PLATFORM_ACCENTS, SLUG_PATTERN } from "./rules";

const zSlug = z.string({ error: "required" }).trim().toLowerCase().min(1, "required").max(80, "too_long").regex(SLUG_PATTERN, "slug_invalid");
const zSort = z.preprocess((value) => (value === "" || value === undefined ? undefined : value), z.coerce.number({ error: "invalid" }).int("invalid").min(0, "too_small").max(100_000, "too_big").optional());

/** How deep the tree may go (root = level 1). */
export const MAX_CATEGORY_DEPTH = 4;

function dropCaches(db: Db) {
  invalidateNavTaxonomy(db);
  invalidateSearchCaches(db);
}

// ───────────────────────────────────────────────────────────────── categories

export type CategoryNodeAdmin = {
  id: string;
  parentId: string | null;
  slug: string;
  name: L10n;
  label: string;
  kind: string;
  sort: number;
  isActive: boolean;
  description: L10n | null;
  /** Products directly in this category / in its whole subtree, and how many of those are on the storefront or
   *  scheduled for it (published / scheduled). */
  products: number;
  subtreeProducts: number;
  subtreeLive: number;
  depth: number;
  children: CategoryNodeAdmin[];
};

export async function getCategoryTree(db: Db, actor: Actor, locale: Locale): Promise<{ roots: CategoryNodeAdmin[]; flat: CategoryNodeAdmin[] }> {
  assertCan(actor, "catalog.product.read");
  const [rows, counts] = await Promise.all([
    db.select().from(categories).orderBy(asc(categories.sort), asc(categories.id)),
    db.all<{ category_id: string; n: number; live: number }>(sql`SELECT category_id, COUNT(*) AS n, SUM(status IN ('published', 'scheduled')) AS live FROM products WHERE category_id IS NOT NULL GROUP BY category_id`),
  ]);
  const countOf = new Map(counts.map((row) => [row.category_id, row]));
  const nodes = new Map<string, CategoryNodeAdmin>();
  for (const row of rows) {
    const own = countOf.get(row.id);
    nodes.set(row.id, {
      id: row.id,
      parentId: row.parentId,
      slug: row.slug,
      name: row.name,
      label: pick(row.name, locale),
      kind: row.kind,
      sort: row.sort,
      isActive: row.isActive,
      description: row.description,
      products: Number(own?.n ?? 0),
      subtreeProducts: 0,
      subtreeLive: 0,
      depth: 0,
      children: [],
    });
  }
  const roots: CategoryNodeAdmin[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const flat: CategoryNodeAdmin[] = [];
  const walk = (node: CategoryNodeAdmin, depth: number): { products: number; live: number } => {
    node.depth = depth;
    flat.push(node);
    let total = node.products;
    let live = Number(countOf.get(node.id)?.live ?? 0);
    for (const child of node.children) {
      const sub = walk(child, depth + 1);
      total += sub.products;
      live += sub.live;
    }
    node.subtreeProducts = total;
    node.subtreeLive = live;
    return { products: total, live };
  };
  for (const root of roots) walk(root, 0);
  return { roots, flat };
}

export const CategoryInput = z.object({
  id: zOptionalId,
  parentId: zOptionalId,
  slug: zSlug,
  name: zL10nRequired(120),
  description: zL10n(1000, false),
  kind: z.preprocess((value) => (value === undefined || value === null || (typeof value === "string" && value.trim() === "") ? "standard" : value), z.string().trim().max(40, "too_long").regex(/^[a-z][a-z0-9_-]*$/, "invalid")),
  isActive: zBool,
  reason: zReason(false),
});

/** Ancestors of a category (nearest first), from all rows. */
function ancestorsOf(rows: ReadonlyArray<Pick<Category, "id" | "parentId">>, id: string | null): string[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: string[] = [];
  let current = id ? byId.get(id) : undefined;
  while (current && out.length < 32) {
    out.push(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return out;
}

function subtreeHeight(rows: ReadonlyArray<Pick<Category, "id" | "parentId">>, id: string): number {
  const children = rows.filter((row) => row.parentId === id);
  return children.length === 0 ? 1 : 1 + Math.max(...children.map((child) => subtreeHeight(rows, child.id)));
}

/** A category and every category below it. */
function branchOf(rows: ReadonlyArray<Pick<Category, "id" | "parentId">>, id: string): string[] {
  const out = [id];
  for (let index = 0; index < out.length && out.length < 512; index++) for (const row of rows) if (row.parentId === out[index] && !out.includes(row.id)) out.push(row.id);
  return out;
}

/** Products on the storefront or scheduled for it (published / scheduled) in these categories. */
const liveProductsIn = (ids: readonly string[]) => sql`SELECT 1 FROM products WHERE status IN ('published', 'scheduled') AND category_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`;

export async function saveCategory(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string; replayed: boolean }> {
  assertCan(actor, "catalog.category.manage");
  const input = parseInput(CategoryInput, raw);
  const rows = await db.select().from(categories);
  const existing = input.id ? rows.find((row) => row.id === input.id) : undefined;
  if (input.id && !existing) throw notFound("category");

  const slugOwner = rows.find((row) => row.slug === input.slug);
  if (slugOwner && slugOwner.id !== existing?.id) {
    // A double submit of the same new category: answer with the one already made.
    if (!existing && slugOwner.name.ar === input.name.ar && (slugOwner.parentId ?? null) === (input.parentId ?? null)) return { id: slugOwner.id, replayed: true };
    throw catalogError("slug_taken", 409, { fields: { slug: "slug_taken" } });
  }
  if (input.parentId && !rows.some((row) => row.id === input.parentId)) throw invalid({ parentId: "invalid" });
  if (existing && input.parentId && ancestorsOf(rows, input.parentId).includes(existing.id)) throw catalogError("category_cycle", 409, { fields: { parentId: "category_cycle" } });
  const depthAbove = input.parentId ? ancestorsOf(rows, input.parentId).length : 0;
  const height = existing ? subtreeHeight(rows, existing.id) : 1;
  if (depthAbove + height > MAX_CATEGORY_DEPTH) throw catalogError("category_depth", 409, { fields: { parentId: "category_depth" } });

  // Switching a category off takes its page and menu entry — and its subcategories' — off the store. With products on
  // sale or scheduled under it, that needs a reason (the page asks for it with the impact shown). Checked again inside
  // the batch, so a product published under it meanwhile cannot slip past without one.
  let reasonGuard: BatchStatement | null = null;
  if (existing?.isActive && !input.isActive && (input.reason ?? "").length < 3) {
    const branch = branchOf(rows, existing.id);
    if (await db.get(sql`${liveProductsIn(branch)} LIMIT 1`)) throw invalid({ reason: "reason_required" });
    reasonGuard = expectThat(db, sql`NOT EXISTS (${liveProductsIn(branch)})`, { code: "REASON_REQUIRED", detail: existing.id });
  }

  const id = existing?.id ?? newId("cat");
  const parentId = input.parentId ?? null;
  const siblings = rows.filter((row) => (row.parentId ?? null) === parentId && row.id !== id);
  const sort = existing && (existing.parentId ?? null) === parentId ? existing.sort : (siblings.reduce((max, row) => Math.max(max, row.sort), 0) + 10);
  const values = { parentId, slug: input.slug, name: input.name, description: input.description, kind: input.kind, isActive: input.isActive, sort };
  const statements: BatchStatement[] = [
    ...(reasonGuard ? [reasonGuard] : []),
    existing ? db.update(categories).set(values).where(eq(categories.id, id)) : db.insert(categories).values({ id, ...values }),
    auditStatement(db, {
      actor,
      action: existing ? "catalog.category.update" : "catalog.category.create",
      entityType: "category",
      entityId: id,
      summary: input.slug,
      before: existing ? { parentId: existing.parentId, slug: existing.slug, name: existing.name, kind: existing.kind, isActive: existing.isActive } : null,
      after: { parentId, slug: input.slug, name: input.name, kind: input.kind, isActive: input.isActive },
      reason: input.reason ?? null,
      at: now,
    }),
  ];
  await runBatch(db, statements).catch((error: unknown) => {
    if (isDbError(error, "REASON_REQUIRED")) throw invalid({ reason: "reason_required" });
    return rethrowCatalog(error);
  });
  dropCaches(db);
  return { id, replayed: false };
}

export const MoveInput = z.object({ id: zId, direction: z.enum(["up", "down"], { error: "invalid" }) });

/** Swaps a category with its neighbour among its siblings (order is per parent). */
export async function moveCategory(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "catalog.category.manage");
  const input = parseInput(MoveInput, raw);
  const row = await db.select().from(categories).where(eq(categories.id, input.id)).get();
  if (!row) throw notFound("category");
  const siblings = await db
    .select()
    .from(categories)
    .where(row.parentId ? eq(categories.parentId, row.parentId) : sql`${categories.parentId} IS NULL`)
    .orderBy(asc(categories.sort), asc(categories.id));
  const index = siblings.findIndex((entry) => entry.id === row.id);
  const swapWith = siblings[input.direction === "up" ? index - 1 : index + 1];
  if (!swapWith) return;
  // Re-number the whole sibling list (10, 20, …) with the two swapped, so equal sort values cannot stick.
  const order = siblings.map((entry) => entry.id);
  [order[index], order[siblings.indexOf(swapWith)]] = [order[siblings.indexOf(swapWith)], order[index]];
  await runBatch(db, [
    ...order.map((id, position) => db.update(categories).set({ sort: (position + 1) * 10 }).where(eq(categories.id, id))),
    auditStatement(db, { actor, action: "catalog.category.reorder", entityType: "category", entityId: row.id, summary: `${row.slug} ${input.direction}`, at: now }),
  ]);
  dropCaches(db);
}

export const DeleteInput = z.object({ id: zId, reason: zReason(true) });

export async function deleteCategory(db: Db, actor: Actor, raw: unknown, now: number): Promise<void> {
  assertCan(actor, "catalog.category.manage");
  const input = parseInput(DeleteInput, raw);
  const row = await db.select().from(categories).where(eq(categories.id, input.id)).get();
  if (!row) throw notFound("category");
  const used = await db.get<{ products: number; children: number }>(
    sql`SELECT (SELECT COUNT(*) FROM products WHERE category_id = ${row.id}) AS products, (SELECT COUNT(*) FROM categories WHERE parent_id = ${row.id}) AS children`,
  );
  if (Number(used?.products ?? 0) > 0 || Number(used?.children ?? 0) > 0) throw catalogError("category_not_empty");
  await runBatch(db, [
    db.delete(categories).where(and(eq(categories.id, row.id), sql`NOT EXISTS (SELECT 1 FROM products WHERE category_id = ${row.id})`, sql`NOT EXISTS (SELECT 1 FROM categories c2 WHERE c2.parent_id = ${row.id})`)),
    auditStatement(db, { actor, action: "catalog.category.delete", entityType: "category", entityId: row.id, summary: row.slug, before: { slug: row.slug, name: row.name, parentId: row.parentId }, reason: input.reason, at: now }),
  ]);
  dropCaches(db);
}

// ───────────────────────────────────────────────────────────────── platforms, generations, device models

export { PLATFORM_ACCENTS };

export type DeviceTaxonomy = {
  platforms: { id: string; slug: string; name: L10n; label: string; accent: string; sort: number; isActive: boolean; products: number }[];
  generations: { id: string; platformId: string; slug: string; name: L10n; label: string; sort: number; models: number }[];
  models: {
    id: string;
    platformId: string;
    generationId: string | null;
    slug: string;
    name: L10n;
    label: string;
    summary: L10n | null;
    status: string;
    deviceKind: string;
    releasedOn: string | null;
    sort: number;
    specCount: number;
    rules: number;
  }[];
  canManage: boolean;
};

export async function getDeviceTaxonomy(db: Db, actor: Actor, locale: Locale): Promise<DeviceTaxonomy> {
  assertCan(actor, "catalog.product.read");
  const [platformRows, generationRows, modelRows, productCounts, ruleCounts] = await Promise.all([
    db.select().from(platforms).orderBy(asc(platforms.sort), asc(platforms.id)),
    db.select().from(deviceGenerations).orderBy(asc(deviceGenerations.sort), asc(deviceGenerations.id)),
    db.select().from(deviceModels).orderBy(asc(deviceModels.sort), asc(deviceModels.id)),
    db.all<{ platform_id: string; n: number }>(sql`SELECT platform_id, COUNT(*) AS n FROM products WHERE platform_id IS NOT NULL GROUP BY platform_id`),
    db.all<{ target_id: string; n: number }>(sql`SELECT target_id, COUNT(*) AS n FROM compatibility_rules WHERE target_type = 'device_model' GROUP BY target_id`),
  ]);
  const productsOf = new Map(productCounts.map((row) => [row.platform_id, Number(row.n)]));
  const rulesOf = new Map(ruleCounts.map((row) => [row.target_id, Number(row.n)]));
  return {
    platforms: platformRows.map((row) => ({ id: row.id, slug: row.slug, name: row.name, label: pick(row.name, locale), accent: row.accent, sort: row.sort, isActive: row.isActive, products: productsOf.get(row.id) ?? 0 })),
    generations: generationRows.map((row) => ({ id: row.id, platformId: row.platformId, slug: row.slug, name: row.name, label: pick(row.name, locale), sort: row.sort, models: modelRows.filter((model) => model.generationId === row.id).length })),
    models: modelRows.map((row) => ({
      id: row.id,
      platformId: row.platformId,
      generationId: row.generationId,
      slug: row.slug,
      name: row.name,
      label: pick(row.name, locale),
      summary: row.summary,
      status: row.status,
      deviceKind: row.deviceKind,
      releasedOn: row.releasedOn,
      sort: row.sort,
      specCount: specRows(row.specs).length,
      rules: rulesOf.get(row.id) ?? 0,
    })),
    canManage: can(actor, "catalog.platform.manage"),
  };
}

export const PlatformInput = z.object({
  id: zOptionalId,
  slug: zSlug,
  name: zL10nRequired(80),
  accent: z.enum(PLATFORM_ACCENTS, { error: "invalid" }),
  sort: zSort,
  isActive: zBool,
  reason: zReason(false),
});

export async function savePlatform(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string }> {
  assertCan(actor, "catalog.platform.manage");
  const input = parseInput(PlatformInput, raw);
  const existing = input.id ? await db.select().from(platforms).where(eq(platforms.id, input.id)).get() : undefined;
  if (input.id && !existing) throw notFound("platform");
  const owner = await db.select({ id: platforms.id }).from(platforms).where(eq(platforms.slug, input.slug)).get();
  if (owner && owner.id !== existing?.id) throw catalogError("slug_taken", 409, { fields: { slug: "slug_taken" } });
  const id = existing?.id ?? newId("plt");
  const values = { slug: input.slug, name: input.name, accent: input.accent, sort: input.sort ?? existing?.sort ?? 100, isActive: input.isActive };
  await runBatch(db, [
    existing ? db.update(platforms).set(values).where(eq(platforms.id, id)) : db.insert(platforms).values({ id, ...values }),
    auditStatement(db, { actor, action: existing ? "catalog.platform.update" : "catalog.platform.create", entityType: "platform", entityId: id, summary: input.slug, before: existing ?? null, after: values, reason: input.reason ?? null, at: now }),
  ]).catch(rethrowCatalog);
  dropCaches(db);
  return { id };
}

export const GenerationInput = z.object({
  id: zOptionalId,
  platformId: zId,
  slug: zSlug,
  name: zL10nRequired(80),
  sort: zSort,
  reason: zReason(false),
});

export async function saveGeneration(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string }> {
  assertCan(actor, "catalog.platform.manage");
  const input = parseInput(GenerationInput, raw);
  const [existing, platform, owner] = await Promise.all([
    input.id ? db.select().from(deviceGenerations).where(eq(deviceGenerations.id, input.id)).get() : Promise.resolve(undefined),
    db.select({ id: platforms.id }).from(platforms).where(eq(platforms.id, input.platformId)).get(),
    db.select({ id: deviceGenerations.id }).from(deviceGenerations).where(eq(deviceGenerations.slug, input.slug)).get(),
  ]);
  if (input.id && !existing) throw notFound("generation");
  if (!platform) throw invalid({ platformId: "invalid" });
  if (owner && owner.id !== existing?.id) throw catalogError("slug_taken", 409, { fields: { slug: "slug_taken" } });
  // Moving a generation to another platform would leave its device models on the old one.
  if (existing && existing.platformId !== input.platformId) {
    const models = await db.get<{ n: number }>(sql`SELECT COUNT(*) AS n FROM device_models WHERE generation_id = ${existing.id}`);
    if (Number(models?.n ?? 0) > 0) throw catalogError("generation_platform", 409, { fields: { platformId: "generation_platform" } });
  }
  const id = existing?.id ?? newId("gen");
  const values = { platformId: input.platformId, slug: input.slug, name: input.name, sort: input.sort ?? existing?.sort ?? 100 };
  await runBatch(db, [
    existing ? db.update(deviceGenerations).set(values).where(eq(deviceGenerations.id, id)) : db.insert(deviceGenerations).values({ id, ...values }),
    auditStatement(db, { actor, action: existing ? "catalog.generation.update" : "catalog.generation.create", entityType: "device_generation", entityId: id, summary: input.slug, before: existing ?? null, after: values, reason: input.reason ?? null, at: now }),
  ]).catch(rethrowCatalog);
  dropCaches(db);
  return { id };
}

export const DeviceModelInput = z.object({
  id: zOptionalId,
  platformId: zId,
  generationId: zOptionalId,
  slug: zSlug,
  name: zL10nRequired(120),
  summary: zL10n(400, false),
  releasedOn: z.preprocess((value) => (value === "" ? undefined : value), z.string().trim().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "invalid").optional()),
  status: z.enum(DEVICE_MODEL_STATUSES, { error: "invalid" }),
  deviceKind: z.enum(DEVICE_KINDS, { error: "invalid" }),
  sort: zSort,
  specs: zSpecRows,
  reason: zReason(false),
});

export async function saveDeviceModel(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string }> {
  assertCan(actor, "catalog.platform.manage");
  const input = parseInput(DeviceModelInput, raw);
  const [existing, platform, generation, owner] = await Promise.all([
    input.id ? db.select().from(deviceModels).where(eq(deviceModels.id, input.id)).get() : Promise.resolve(undefined),
    db.select({ id: platforms.id }).from(platforms).where(eq(platforms.id, input.platformId)).get(),
    input.generationId ? db.select().from(deviceGenerations).where(eq(deviceGenerations.id, input.generationId)).get() : Promise.resolve(undefined),
    db.select({ id: deviceModels.id }).from(deviceModels).where(eq(deviceModels.slug, input.slug)).get(),
  ]);
  if (input.id && !existing) throw notFound("device_model");
  if (!platform) throw invalid({ platformId: "invalid" });
  if (input.generationId && !generation) throw invalid({ generationId: "invalid" });
  if (generation && generation.platformId !== input.platformId) throw catalogError("generation_platform", 409, { fields: { generationId: "generation_platform" } });
  if (owner && owner.id !== existing?.id) throw catalogError("slug_taken", 409, { fields: { slug: "slug_taken" } });
  const id = existing?.id ?? newId("dvm");
  const values = {
    platformId: input.platformId,
    generationId: input.generationId ?? null,
    slug: input.slug,
    name: input.name,
    summary: input.summary,
    releasedOn: input.releasedOn ?? null,
    status: input.status,
    deviceKind: input.deviceKind,
    sort: input.sort ?? existing?.sort ?? 100,
    specs: specsFromRows(input.specs),
    updatedAt: now,
  };
  await runBatch(db, [
    existing ? db.update(deviceModels).set(values).where(eq(deviceModels.id, id)) : db.insert(deviceModels).values({ id, ...values }),
    auditStatement(db, {
      actor,
      action: existing ? "catalog.device_model.update" : "catalog.device_model.create",
      entityType: "device_model",
      entityId: id,
      summary: input.slug,
      before: existing ? { ...existing, specs: specRows(existing.specs).length } : null,
      after: { ...values, specs: input.specs.length },
      reason: input.reason ?? null,
      at: now,
    }),
  ]).catch(rethrowCatalog);
  dropCaches(db);
  return { id };
}

/** One device model with its spec rows, for its editor. */
export async function getDeviceModel(db: Db, actor: Actor, id: string): Promise<(typeof deviceModels.$inferSelect & { specRows: SpecRow[] }) | null> {
  assertCan(actor, "catalog.product.read");
  const row = await db.select().from(deviceModels).where(eq(deviceModels.id, id)).get();
  return row ? { ...row, specRows: specRows(row.specs) } : null;
}
