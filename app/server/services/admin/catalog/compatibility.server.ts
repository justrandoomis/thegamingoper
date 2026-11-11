/**
 * Admin catalogue — the compatibility-rule editor and the device comparison (02.10).
 *
 *   const view = await getProductCompatibility(db, actor, productId, locale);
 *   const list = await listCompatibilityRules(db, actor, filters, locale);
 *   await saveCompatibilityRule(db, actor, raw, now);          // verified needs catalog.compatibility.verify
 *   await deleteCompatibilityRule(db, actor, { id, productId, reason }, now);
 *   const table = await compareDevices(db, actor, ["ps5", "ps5-slim", "ps5-pro"], locale);
 *
 * A rule says "<product|variant> works with <device model|generation|platform>" with a status: verified (needs the
 * source of the fact and the verify permission — whoever marks it verified is recorded), partial (works with a
 * condition: the note is required), incompatible (the note says why), unverified. A missing rule means "not
 * verified", never "compatible" (brief §6). Lowering a verified rule needs only catalog.compatibility.manage: it
 * claims less. A live product that is required to have compatibility keeps at least one verified or partial rule.
 *
 * The comparison puts the spec sheets of 2–4 device models side by side (rows by spec key, differences marked) and
 * shows, for the products with rules on those devices, the status per device — the most specific rule wins
 * (device model › generation › platform), as on the storefront.
 */
import { and, asc, eq, inArray, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { actorRef, assertCan, can, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { compatibilityRules, deviceGenerations, deviceModels, employees, platforms, products, variants, type CompatibilityRule } from "~/server/db/schema";
import { expectThat, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { assertNoRegression, catalogError, completenessWith, parseInput, productCompleteness, requireProductState, rethrowCatalog, specRows, zId, zL10n, zOptionalId, zReason, zText } from "./common.server";
import { adminStatusOf, COMPAT_STATUS_LIST, COMPAT_TARGET_LIST, requirementsOf, type AdminStatus } from "./rules";

type Status = (typeof COMPAT_STATUS_LIST)[number];
type TargetType = (typeof COMPAT_TARGET_LIST)[number];

export type TargetOption = { type: TargetType; id: string; label: string; platformId: string | null };

/** Every device model, generation and platform as a rule target, labelled "Platform › Generation › Model". */
export async function targetOptions(db: Db, locale: Locale): Promise<TargetOption[]> {
  const [platformRows, generationRows, modelRows] = await Promise.all([
    db.select().from(platforms).orderBy(asc(platforms.sort), asc(platforms.id)),
    db.select().from(deviceGenerations).orderBy(asc(deviceGenerations.sort), asc(deviceGenerations.id)),
    db.select().from(deviceModels).orderBy(asc(deviceModels.sort), asc(deviceModels.id)),
  ]);
  const out: TargetOption[] = [];
  for (const platform of platformRows) {
    out.push({ type: "platform", id: platform.id, label: pick(platform.name, locale), platformId: platform.id });
    for (const generation of generationRows.filter((row) => row.platformId === platform.id)) {
      out.push({ type: "generation", id: generation.id, label: `${pick(platform.name, locale)} › ${pick(generation.name, locale)}`, platformId: platform.id });
      for (const model of modelRows.filter((row) => row.generationId === generation.id)) {
        out.push({ type: "device_model", id: model.id, label: `${pick(platform.name, locale)} › ${pick(generation.name, locale)} › ${pick(model.name, locale)}`, platformId: platform.id });
      }
    }
    for (const model of modelRows.filter((row) => row.platformId === platform.id && !row.generationId)) {
      out.push({ type: "device_model", id: model.id, label: `${pick(platform.name, locale)} › ${pick(model.name, locale)}`, platformId: platform.id });
    }
  }
  return out;
}

export type RuleView = {
  id: string;
  subjectType: "product" | "variant";
  subjectId: string;
  subjectLabel: string;
  productId: string;
  productName: string;
  productSlug: string;
  productStatus: AdminStatus;
  targetType: TargetType;
  targetId: string;
  targetLabel: string;
  status: Status;
  note: L10n | null;
  noteText: string;
  source: string | null;
  verifiedBy: string | null;
  verifiedAt: number | null;
  updatedAt: number;
};

type RuleRow = CompatibilityRule & { verifierName: string | null };

async function viewsOf(db: Db, rows: readonly RuleRow[], locale: Locale): Promise<RuleView[]> {
  if (rows.length === 0) return [];
  const targets = new Map((await targetOptions(db, locale)).map((target) => [`${target.type}:${target.id}`, target.label]));
  const variantIds = rows.filter((row) => row.subjectType === "variant").map((row) => row.subjectId);
  const variantRows = variantIds.length > 0 ? await db.select({ id: variants.id, sku: variants.sku, productId: variants.productId }).from(variants).where(inArray(variants.id, variantIds)) : [];
  const variantOf = new Map(variantRows.map((row) => [row.id, row]));
  const productIds = [...new Set(rows.map((row) => (row.subjectType === "product" ? row.subjectId : (variantOf.get(row.subjectId)?.productId ?? ""))).filter(Boolean))];
  const productRows = productIds.length > 0 ? await db.select({ id: products.id, slug: products.slug, name: products.name, status: products.status, publishedAt: products.publishedAt }).from(products).where(inArray(products.id, productIds)) : [];
  const productOf = new Map(productRows.map((row) => [row.id, row]));
  return rows.flatMap((row) => {
    const variant = row.subjectType === "variant" ? variantOf.get(row.subjectId) : undefined;
    const productId = row.subjectType === "product" ? row.subjectId : (variant?.productId ?? null);
    const product = productId ? productOf.get(productId) : undefined;
    if (!product) return [];
    return [
      {
        id: row.id,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        subjectLabel: variant ? variant.sku : pick(product.name, locale),
        productId: product.id,
        productName: pick(product.name, locale),
        productSlug: product.slug,
        productStatus: adminStatusOf(product),
        targetType: row.targetType,
        targetId: row.targetId,
        targetLabel: targets.get(`${row.targetType}:${row.targetId}`) ?? row.targetId,
        status: row.status,
        note: row.note,
        noteText: pick(row.note, locale),
        source: row.source,
        verifiedBy: row.verifierName,
        verifiedAt: row.verifiedAt,
        updatedAt: row.updatedAt,
      },
    ];
  });
}

const ruleQuery = (db: Db) =>
  db
    .select({
      id: compatibilityRules.id,
      subjectType: compatibilityRules.subjectType,
      subjectId: compatibilityRules.subjectId,
      targetType: compatibilityRules.targetType,
      targetId: compatibilityRules.targetId,
      status: compatibilityRules.status,
      note: compatibilityRules.note,
      source: compatibilityRules.source,
      verifiedBy: compatibilityRules.verifiedBy,
      verifiedAt: compatibilityRules.verifiedAt,
      createdAt: compatibilityRules.createdAt,
      updatedAt: compatibilityRules.updatedAt,
      verifierName: employees.name,
    })
    .from(compatibilityRules)
    .leftJoin(employees, eq(employees.id, compatibilityRules.verifiedBy));

export type ProductCompatibility = {
  productId: string;
  live: boolean;
  rules: RuleView[];
  variants: { id: string; sku: string }[];
  targets: TargetOption[];
  canManage: boolean;
  canVerify: boolean;
};

export async function getProductCompatibility(db: Db, actor: Actor, productId: string, locale: Locale): Promise<ProductCompatibility> {
  assertCan(actor, "catalog.product.read");
  const state = await requireProductState(db, productId);
  const ids = state.variants.map((variant) => variant.id);
  const rows = await ruleQuery(db)
    .where(
      ids.length > 0
        ? sql`(${compatibilityRules.subjectType} = 'product' AND ${compatibilityRules.subjectId} = ${productId}) OR (${compatibilityRules.subjectType} = 'variant' AND ${inArray(compatibilityRules.subjectId, ids)})`
        : and(eq(compatibilityRules.subjectType, "product"), eq(compatibilityRules.subjectId, productId)),
    )
    .orderBy(asc(compatibilityRules.targetType), asc(compatibilityRules.targetId));
  const views = await viewsOf(db, rows, locale);
  return {
    productId,
    live: state.product.status === "published" || state.product.status === "scheduled",
    rules: views.sort((a, b) => a.targetLabel.localeCompare(b.targetLabel)),
    variants: state.variants.map((variant) => ({ id: variant.id, sku: variant.sku })),
    targets: await targetOptions(db, locale),
    canManage: can(actor, "catalog.compatibility.manage"),
    canVerify: can(actor, "catalog.compatibility.verify"),
  };
}

// ───────────────────────────────────────────────────────────────── the rule list

export type RuleFilters = { status: Status | null; target: string | null; q: string; page: number };

export function parseRuleFilters(params: URLSearchParams): RuleFilters {
  const status = params.get("status") ?? "";
  const target = (params.get("target") ?? "").trim();
  const page = Number.parseInt(params.get("page") ?? "1", 10);
  return {
    status: (COMPAT_STATUS_LIST as readonly string[]).includes(status) ? (status as Status) : null,
    target: /^(device_model|generation|platform):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(target) ? target : null,
    q: (params.get("q") ?? "").trim().slice(0, 120),
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
  };
}

export const RULES_PAGE_SIZE = 50;

export async function listCompatibilityRules(db: Db, actor: Actor, filters: RuleFilters, locale: Locale): Promise<{ rules: RuleView[]; total: number; page: number; pageCount: number; counts: Record<Status, number>; targets: TargetOption[]; canVerify: boolean }> {
  assertCan(actor, "catalog.product.read");
  const where: SQL[] = [];
  if (filters.target) {
    const [type, ...rest] = filters.target.split(":");
    where.push(sql`${compatibilityRules.targetType} = ${type} AND ${compatibilityRules.targetId} = ${rest.join(":")}`);
  }
  if (filters.q) {
    const like = `%${filters.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push(sql`((${compatibilityRules.subjectType} = 'product' AND ${compatibilityRules.subjectId} IN (SELECT id FROM products WHERE name LIKE ${like} ESCAPE '\\' OR slug LIKE ${like} ESCAPE '\\'))
      OR (${compatibilityRules.subjectType} = 'variant' AND ${compatibilityRules.subjectId} IN (SELECT v.id FROM variants v JOIN products p ON p.id = v.product_id WHERE v.sku LIKE ${like} ESCAPE '\\' OR p.name LIKE ${like} ESCAPE '\\')))`);
  }
  const base = where.length > 0 ? sql.join(where, sql` AND `) : sql`1 = 1`;
  const countRows = await db.all<{ status: Status; n: number }>(sql`SELECT status, COUNT(*) AS n FROM compatibility_rules WHERE ${base} GROUP BY status`);
  const counts = Object.fromEntries(COMPAT_STATUS_LIST.map((status) => [status, 0])) as Record<Status, number>;
  for (const row of countRows) counts[row.status] = Number(row.n);
  const filtered = filters.status ? sql`${base} AND ${compatibilityRules.status} = ${filters.status}` : base;
  const total = filters.status ? counts[filters.status] : Object.values(counts).reduce((sum, n) => sum + n, 0);
  const pageCount = Math.max(1, Math.ceil(total / RULES_PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const rows = await ruleQuery(db)
    .where(filtered)
    .orderBy(sql`CASE ${compatibilityRules.status} WHEN 'unverified' THEN 0 WHEN 'partial' THEN 1 WHEN 'incompatible' THEN 2 ELSE 3 END`, asc(compatibilityRules.targetId), asc(compatibilityRules.id))
    .limit(RULES_PAGE_SIZE)
    .offset((page - 1) * RULES_PAGE_SIZE);
  return { rules: await viewsOf(db, rows, locale), total, page, pageCount, counts, targets: await targetOptions(db, locale), canVerify: can(actor, "catalog.compatibility.verify") };
}

// ───────────────────────────────────────────────────────────────── save / delete

export const RuleInput = z.object({
  id: zOptionalId,
  productId: zId,
  /** "product" or a variant id of this product. */
  subject: z.string({ error: "required" }).trim().min(1, "required").max(128),
  /** "<type>:<id>" from targetOptions. */
  target: z.string({ error: "required" }).trim().regex(/^(device_model|generation|platform):[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/, "target_unknown"),
  status: z.enum(COMPAT_STATUS_LIST, { error: "invalid" }),
  note: zL10n(500, false),
  source: zText(500),
  reason: zReason(false),
});

async function targetExists(db: Db, type: TargetType, id: string): Promise<boolean> {
  const table = type === "device_model" ? deviceModels : type === "generation" ? deviceGenerations : platforms;
  return Boolean(await db.select({ id: table.id }).from(table).where(eq(table.id, id)).get());
}

/** The product a rule's subject belongs to. */
async function productOfSubject(db: Db, subjectType: string, subjectId: string): Promise<string | null> {
  if (subjectType === "product") return subjectId;
  return (await db.select({ productId: variants.productId }).from(variants).where(eq(variants.id, subjectId)).get())?.productId ?? null;
}

/**
 * Keeps a live product that needs compatibility from losing its last verified or partial rule. Checked now, and — for a
 * live product that needs and has one — again INSIDE the batch by the returned guard (place it after the change): two
 * tabs removing the last two rules at once each see two. (Wrapped: a query builder is a thenable, so an async function
 * returning it bare would run it.)
 */
async function keepsCompatibility(db: Db, productId: string, losing: number): Promise<{ guard: BatchStatement | null }> {
  if (losing <= 0) return { guard: null };
  const state = await productCompleteness(db, productId);
  if (!state) return { guard: null };
  const product = await requireProductState(db, productId);
  assertNoRegression(product.product.status, state.completeness, completenessWith(state.facts, { compatibleRules: Math.max(0, state.facts.compatibleRules - losing) }));
  const live = product.product.status === "published" || product.product.status === "scheduled";
  if (!live || state.facts.compatibleRules === 0 || !requirementsOf(product.product.kind).includes("compatibility")) return { guard: null };
  const guard = expectThat(
    db,
    sql`EXISTS (SELECT 1 FROM compatibility_rules r WHERE r.status IN ('verified', 'partial')
      AND ((r.subject_type = 'product' AND r.subject_id = ${productId}) OR (r.subject_type = 'variant' AND r.subject_id IN (SELECT id FROM variants WHERE product_id = ${productId}))))`,
    { code: "REGRESSION", detail: "compatibility" },
  );
  return { guard };
}

const counts = (status: string) => (status === "verified" || status === "partial" ? 1 : 0);

export async function saveCompatibilityRule(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ id: string; replayed: boolean }> {
  assertCan(actor, "catalog.compatibility.manage");
  const input = parseInput(RuleInput, raw);
  if (input.status === "verified") assertCan(actor, "catalog.compatibility.verify");
  const fields: Record<string, string> = {};
  if (input.status === "verified" && !input.source) fields.source = "source_required";
  if ((input.status === "partial" || input.status === "incompatible") && !input.note) fields["note.ar"] = "note_required";
  if (Object.keys(fields).length > 0) throw invalid(fields);

  const state = await requireProductState(db, input.productId);
  const subjectType = input.subject === "product" ? "product" : "variant";
  const subjectId = subjectType === "product" ? input.productId : input.subject;
  if (subjectType === "variant" && !state.variants.some((variant) => variant.id === subjectId)) throw catalogError("subject_unknown", 400, { fields: { subject: "subject_unknown" } });
  const [targetType, ...rest] = input.target.split(":") as [TargetType, ...string[]];
  const targetId = rest.join(":");
  if (!(await targetExists(db, targetType, targetId))) throw catalogError("target_unknown", 400, { fields: { target: "target_unknown" } });

  // One rule per edge: editing another rule onto an existing edge updates that edge.
  const edge = await db
    .select()
    .from(compatibilityRules)
    .where(and(eq(compatibilityRules.subjectType, subjectType), eq(compatibilityRules.subjectId, subjectId), eq(compatibilityRules.targetType, targetType), eq(compatibilityRules.targetId, targetId)))
    .get();
  const editing = input.id ? await db.select().from(compatibilityRules).where(eq(compatibilityRules.id, input.id)).get() : undefined;
  if (input.id && !editing) throw notFound("rule");
  if (editing && (await productOfSubject(db, editing.subjectType, editing.subjectId)) !== input.productId) throw notFound("rule");
  const existing = edge ?? editing;
  const sameContent =
    existing && existing.status === input.status && JSON.stringify(existing.note ?? null) === JSON.stringify(input.note ?? null) && (existing.source ?? null) === (input.source ?? null) && existing === edge;
  if (sameContent && (!editing || editing.id === edge?.id)) return { id: existing.id, replayed: true };

  // A rule that stops counting as compatible (status lowered, or moved to another edge) must not strip a live product.
  const losing = (editing ? counts(editing.status) : 0) + (edge && edge.id !== editing?.id ? counts(edge.status) : 0) - counts(input.status);
  const { guard } = await keepsCompatibility(db, input.productId, losing);

  const by = actorRef(actor).actorId;
  const verified = input.status === "verified";
  const id = edge?.id ?? editing?.id ?? newId("cmp");
  const values = {
    subjectType,
    subjectId,
    targetType,
    targetId,
    status: input.status,
    note: input.note,
    source: input.source ?? null,
    // The verifier is whoever marked it verified; re-saving a verified rule re-verifies it.
    verifiedBy: verified ? by : null,
    verifiedAt: verified ? now : null,
    updatedAt: now,
  } as const;
  const statements = [];
  if (editing && edge && edge.id !== editing.id) statements.push(db.delete(compatibilityRules).where(eq(compatibilityRules.id, editing.id)));
  statements.push(
    existing && (edge || editing) ? db.update(compatibilityRules).set(values).where(eq(compatibilityRules.id, id)) : db.insert(compatibilityRules).values({ id, ...values, createdAt: now }),
    ...(guard ? [guard] : []),
    auditStatement(db, {
      actor,
      action: existing ? "catalog.compatibility.update" : "catalog.compatibility.create",
      entityType: "product",
      entityId: input.productId,
      summary: `${subjectType}:${subjectId} ↔ ${targetType}:${targetId} = ${input.status}`,
      before: existing ? { status: existing.status, note: existing.note, source: existing.source, edge: `${existing.targetType}:${existing.targetId}` } : null,
      after: { status: input.status, note: input.note, source: input.source ?? null, edge: `${targetType}:${targetId}` },
      reason: input.reason ?? null,
      at: now,
    }),
  );
  await runBatch(db, statements).catch(rethrowCatalog);
  return { id, replayed: false };
}

export const DeleteRuleInput = z.object({ id: zId, productId: zId, reason: zReason(true) });

export async function deleteCompatibilityRule(db: Db, actor: Actor, raw: unknown, now: number): Promise<{ removed: boolean }> {
  assertCan(actor, "catalog.compatibility.manage");
  const input = parseInput(DeleteRuleInput, raw);
  const rule = await db.select().from(compatibilityRules).where(eq(compatibilityRules.id, input.id)).get();
  if (!rule) return { removed: false };
  if ((await productOfSubject(db, rule.subjectType, rule.subjectId)) !== input.productId) throw notFound("rule");
  const { guard } = await keepsCompatibility(db, input.productId, counts(rule.status));
  await runBatch(db, [
    db.delete(compatibilityRules).where(eq(compatibilityRules.id, rule.id)),
    ...(guard ? [guard] : []),
    auditStatement(db, {
      actor,
      action: "catalog.compatibility.delete",
      entityType: "product",
      entityId: input.productId,
      summary: `${rule.subjectType}:${rule.subjectId} ↔ ${rule.targetType}:${rule.targetId}`,
      before: { status: rule.status, note: rule.note, source: rule.source },
      reason: input.reason,
      at: now,
    }),
  ]).catch(rethrowCatalog);
  return { removed: true };
}

// ───────────────────────────────────────────────────────────────── device comparison (02.10)

export type DeviceComparison = {
  models: { id: string; slug: string; name: string; generation: string | null; platform: string; releasedOn: string | null; status: string }[];
  /** One row per spec key, in the order the keys first appear. */
  specs: { key: string; label: string; values: (string | null)[]; differs: boolean }[];
  /** Products with a rule on any of the devices: their status per device (null = no rule = not verified). */
  compatibility: { productId: string; slug: string; name: string; kind: string; statuses: (Status | null)[] }[];
  /** Per device: how many of those products are verified, partial, incompatible, or without a rule. */
  totals: { verified: number; partial: number; incompatible: number; unverified: number; none: number }[];
  all: { slug: string; label: string }[];
};

export const MAX_COMPARED = 4;

export async function compareDevices(db: Db, actor: Actor, slugs: readonly string[], locale: Locale): Promise<DeviceComparison> {
  assertCan(actor, "catalog.product.read");
  const [modelRows, generationRows, platformRows] = await Promise.all([
    db.select().from(deviceModels).orderBy(asc(deviceModels.sort), asc(deviceModels.id)),
    db.select().from(deviceGenerations),
    db.select().from(platforms),
  ]);
  const generationOf = new Map(generationRows.map((row) => [row.id, row]));
  const platformOf = new Map(platformRows.map((row) => [row.id, row]));
  const all = modelRows.map((row) => ({ slug: row.slug, label: `${pick(platformOf.get(row.platformId)?.name, locale)} › ${pick(row.name, locale)}` }));
  const chosen = [...new Set(slugs)]
    .map((slug) => modelRows.find((row) => row.slug === slug))
    .filter((row): row is (typeof modelRows)[number] => Boolean(row))
    .slice(0, MAX_COMPARED);

  const models = chosen.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: pick(row.name, locale),
    generation: row.generationId ? pick(generationOf.get(row.generationId)?.name, locale) : null,
    platform: pick(platformOf.get(row.platformId)?.name, locale),
    releasedOn: row.releasedOn,
    status: row.status,
  }));

  const sheets = chosen.map((row) => specRows(row.specs));
  const keys: string[] = [];
  const labelOf = new Map<string, string>();
  for (const sheet of sheets) {
    for (const spec of sheet) {
      if (!keys.includes(spec.key)) keys.push(spec.key);
      if (!labelOf.has(spec.key)) labelOf.set(spec.key, pick(spec.label, locale) || spec.key);
    }
  }
  const specs = keys.map((key) => {
    const values = sheets.map((sheet) => {
      const spec = sheet.find((entry) => entry.key === key);
      return spec ? pick(spec.value, locale) || null : null;
    });
    const present = values.filter((value): value is string => value !== null);
    return { key, label: labelOf.get(key) ?? key, values, differs: present.length !== values.length || new Set(present).size > 1 };
  });

  let compatibility: DeviceComparison["compatibility"] = [];
  const totals = chosen.map(() => ({ verified: 0, partial: 0, incompatible: 0, unverified: 0, none: 0 }));
  if (chosen.length > 0) {
    const targetIds = [...new Set(chosen.flatMap((row) => [row.id, row.generationId, row.platformId].filter((id): id is string => Boolean(id))))];
    const rules = await db
      .select({ subjectId: compatibilityRules.subjectId, targetType: compatibilityRules.targetType, targetId: compatibilityRules.targetId, status: compatibilityRules.status })
      .from(compatibilityRules)
      .where(and(eq(compatibilityRules.subjectType, "product"), inArray(compatibilityRules.targetId, targetIds)));
    const productIds = [...new Set(rules.map((rule) => rule.subjectId))];
    const productRows = productIds.length > 0 ? await db.select({ id: products.id, slug: products.slug, name: products.name, kind: products.kind }).from(products).where(inArray(products.id, productIds)) : [];
    compatibility = productRows
      .map((product) => {
        const statuses = chosen.map((model) => {
          const mine = rules.filter((rule) => rule.subjectId === product.id);
          const exact = mine.find((rule) => rule.targetType === "device_model" && rule.targetId === model.id);
          const byGeneration = model.generationId ? mine.find((rule) => rule.targetType === "generation" && rule.targetId === model.generationId) : undefined;
          const byPlatform = mine.find((rule) => rule.targetType === "platform" && rule.targetId === model.platformId);
          return (exact ?? byGeneration ?? byPlatform)?.status ?? null;
        });
        return { productId: product.id, slug: product.slug, name: pick(product.name, locale), kind: product.kind, statuses };
      })
      .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
    for (const row of compatibility) row.statuses.forEach((status, index) => totals[index][status ?? "none"]++);
  }
  return { models, specs, compatibility, totals, all };
}
