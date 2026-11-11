/**
 * Compatibility — what works with which device, exactly as recorded (docs/CONTRACTS.md §3 "devices", brief §6).
 *
 *   const rows = await getCompatibilityForProduct(db, ctx.locale, product.id);
 *   // [{ deviceSlug: "ps5-pro", deviceName: "PlayStation 5 Pro", status: "partial", note: "Needs the add-on Disc Drive.", … }]
 *   <CompatBadge status={row.status} device={row.deviceName} note={row.note} />
 *
 * THE RULES (compatibility_rules) are edges "<product | variant> works with <device model | generation | platform>"
 * with a status: verified · partial (works, with the condition in `note`) · incompatible · unverified.
 *
 *   · The most specific rule wins: a rule for the device MODEL beats one for its GENERATION, which beats one for its
 *     PLATFORM ("Series S: no disc drive" overrides "Xbox Series generation: works"). At the same level a rule on a
 *     VARIANT beats the product's own rule (the variant is the more specific subject).
 *   · No rule = "unverified". Nothing is ever inferred from similar names, from the platform alone, or from a sibling
 *     model: a game verified on PS5 Slim says nothing about PS5 Pro until a rule says so.
 *   · "partial" is never rounded up. A product whose variants disagree (one edition works, another does not) is
 *     reported as "partial" with a note that names the versions that work — it is not "verified".
 *
 * Which devices getCompatibilityForProduct() lists: every published device model that a rule of the product (or of
 * one of its active variants) touches — directly, through its generation or through its platform — plus, for
 * products that are not devices themselves, the other consoles and handheld PCs of the platforms the product is
 * made for (its own platform, the platforms of its game.platforms list, the platforms its non-incompatible rules
 * name) with an explicit "unverified": the shopper sees "not checked with PlayStation Portal" instead of silence.
 * Models of inactive platforms (the generic Windows PC target) appear only when a rule names them, and `hasHub`
 * is false for them (there is no /device page for a PC).
 *
 * Also used by the device hub (devices.server.ts) and the recommendations (recommendations.server.ts):
 * `loadDeviceTargets()` and `compatibilityForModels()` compute the same answers for many products at once.
 *
 * Services take `db` first and never import "cloudflare:workers" (tests run them against a local D1).
 * Errors: AppError("invalid", 400) for a malformed id; an unknown product id is an empty list, not an error.
 */
import { sql } from "drizzle-orm";
import { serverT } from "~/i18n/i18n.server";
import type { CompatibilityStatus } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { invalid } from "~/server/errors";

// ───────────────────────────────────────────────────────────────── types

export type CompatibilityTargetLevel = "device_model" | "generation" | "platform";

/** One device in a product's compatibility list (the contract shape plus three facts the UI needs). */
export type ProductCompatibility = {
  deviceSlug: string;
  deviceName: string;
  status: CompatibilityStatus;
  /** The rule's condition or reason in the page's language ("Needs the add-on Disc Drive."), or null. */
  note: string | null;
  /** Platform of the device ("playstation", …; "pc" for the generic Windows PC target). */
  platformSlug: string;
  /** A /device/<slug> hub exists (published model on an active platform). */
  hasHub: boolean;
  /** Where the answer comes from — a rule for this model, its generation, its platform — or null: no rule at all. */
  level: CompatibilityTargetLevel | null;
};

/** A published device model with what rules can target. */
export type DeviceTarget = {
  id: string;
  slug: string;
  name: L10n;
  generationId: string | null;
  platformId: string;
  platformSlug: string;
  platformActive: boolean;
  deviceKind: string;
  artKey: string | null;
  sort: number;
  platformSort: number;
};

/** A compatibility rule, with the product it belongs to (a variant rule's product is the variant's). */
export type RuleLite = {
  subjectType: "product" | "variant";
  subjectId: string;
  productId: string;
  targetType: CompatibilityTargetLevel;
  targetId: string;
  status: CompatibilityStatus;
  note: L10n | null;
};

/** An active variant (the unit a shopper actually buys). */
export type VariantLite = { id: string; productId: string; title: L10n | null; isDefault: boolean; sort: number };

/** What a product is, as far as compatibility and recommendations care. */
export type ProductMeta = {
  id: string;
  slug: string;
  kind: string;
  platformId: string | null;
  /** The device model this product IS (consoles, handhelds, PS VR2 …), or null. */
  deviceModelId: string | null;
  categoryId: string | null;
  /** Games: the device models the game exists for (research, not a statement about the box). */
  gamePlatforms: string[];
};

/** The answer for one product on one device model. */
export type Resolution = {
  status: CompatibilityStatus;
  /** The deciding rule's note (when every variant is decided by rules with the same status). */
  note: L10n | null;
  /** Level of the deciding rule; null when no rule touches the model at all. */
  level: CompatibilityTargetLevel | null;
  /** Set when the product's variants disagree: which ones work (verified or partial) and which do not. */
  split: { works: VariantLite[]; fails: VariantLite[] } | null;
};

// ───────────────────────────────────────────────────────────────── pure resolution

const LEVEL_RANK: Record<CompatibilityTargetLevel, number> = { device_model: 3, generation: 2, platform: 1 };

/** Does a rule's target cover this model? */
export function ruleTargets(rule: Pick<RuleLite, "targetType" | "targetId">, model: Pick<DeviceTarget, "id" | "generationId" | "platformId">): boolean {
  if (rule.targetType === "device_model") return rule.targetId === model.id;
  if (rule.targetType === "generation") return model.generationId !== null && rule.targetId === model.generationId;
  return rule.targetId === model.platformId;
}

/**
 * The rule that decides one variant on one model: the most specific target first (model › generation › platform),
 * then the most specific subject (variant › product). `variantId` null = the product as a whole.
 */
export function decidingRule(rules: readonly RuleLite[], productId: string, variantId: string | null, model: Pick<DeviceTarget, "id" | "generationId" | "platformId">): RuleLite | null {
  let best: RuleLite | null = null;
  let bestRank = -1;
  for (const rule of rules) {
    const subjectOk = rule.subjectType === "product" ? rule.subjectId === productId : variantId !== null && rule.subjectId === variantId;
    if (!subjectOk || !ruleTargets(rule, model)) continue;
    const rank = LEVEL_RANK[rule.targetType] * 2 + (rule.subjectType === "variant" ? 1 : 0);
    if (rank > bestRank) {
      best = rule;
      bestRank = rank;
    }
  }
  return best;
}

const WORKS: ReadonlySet<CompatibilityStatus> = new Set(["verified", "partial"]);

/**
 * The product's answer on one model, from its active variants. All variants agree → that status (and the note of
 * the default variant's deciding rule). They disagree → "partial" when at least one works, else "unverified"
 * (some are incompatible, others unknown), with `split` saying which is which. Never better than the evidence.
 */
export function resolveForModel(productId: string, variants: readonly VariantLite[], rules: readonly RuleLite[], model: Pick<DeviceTarget, "id" | "generationId" | "platformId">): Resolution {
  const units = variants.length > 0 ? [...variants].sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || a.sort - b.sort || a.id.localeCompare(b.id)) : null;
  if (!units) {
    const rule = decidingRule(rules, productId, null, model);
    return { status: rule?.status ?? "unverified", note: rule?.note ?? null, level: rule?.targetType ?? null, split: null };
  }
  const decided = units.map((variant) => ({ variant, rule: decidingRule(rules, productId, variant.id, model) }));
  const statuses = decided.map((entry) => entry.rule?.status ?? "unverified");
  const first = decided[0];
  if (statuses.every((status) => status === statuses[0])) {
    const level = decided.find((entry) => entry.rule)?.rule?.targetType ?? null;
    return { status: statuses[0], note: first.rule?.note ?? decided.find((entry) => entry.rule?.note)?.rule?.note ?? null, level, split: null };
  }
  const works = decided.filter((entry, index) => WORKS.has(statuses[index])).map((entry) => entry.variant);
  const fails = decided.filter((entry, index) => !WORKS.has(statuses[index])).map((entry) => entry.variant);
  const level = decided.find((entry) => entry.rule)?.rule?.targetType ?? null;
  return { status: works.length > 0 ? "partial" : "unverified", note: null, level, split: { works, fails } };
}

/** "a، b" / "a, b" — names in the reading order of the language. */
function listOf(names: string[], locale: Locale): string {
  return names.join(locale === "en" ? ", " : "، ");
}

/** The note to show for a resolution, in the page's language (a split names the versions that work). */
export function resolutionNote(resolution: Resolution, locale: Locale): string | null {
  if (resolution.split) {
    const t = serverT(locale, "devices");
    const name = (variant: VariantLite) => `⁨${pick(variant.title, locale) || variant.id}⁩`;
    if (resolution.split.works.length > 0) return t("compat.variantsWork", { variants: listOf(resolution.split.works.map(name), locale) });
    return t("compat.variantsFail", { variants: listOf(resolution.split.fails.map(name), locale) });
  }
  const text = pick(resolution.note, locale).trim();
  return text === "" ? null : text;
}

// ───────────────────────────────────────────────────────────────── rows → values

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];

function parseJson<T>(text: unknown): T | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const l10n = (value: unknown): L10n | null => {
  const parsed = typeof value === "string" ? parseJson<L10n>(value) : (value as L10n | null);
  return parsed && typeof parsed === "object" && typeof parsed.ar === "string" ? parsed : null;
};

const stringList = (value: unknown): string[] => {
  const parsed = typeof value === "string" ? parseJson<unknown>(value) : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
};

const STATUSES: ReadonlySet<string> = new Set(["verified", "partial", "incompatible", "unverified"]);
const LEVELS: ReadonlySet<string> = new Set(["device_model", "generation", "platform"]);

type TargetRow = {
  id: string;
  slug: string;
  name: string;
  generation_id: string | null;
  platform_id: string;
  platform_slug: string;
  platform_active: number;
  device_kind: string;
  art_key: string | null;
  sort: number;
  platform_sort: number;
};

const toTarget = (row: TargetRow): DeviceTarget => ({
  id: row.id,
  slug: row.slug,
  name: l10n(row.name) ?? { ar: row.slug },
  generationId: row.generation_id ?? null,
  platformId: row.platform_id,
  platformSlug: row.platform_slug,
  platformActive: row.platform_active === 1,
  deviceKind: row.device_kind,
  artKey: row.art_key ?? null,
  sort: Number(row.sort) || 0,
  platformSort: Number(row.platform_sort) || 0,
});

/** Published device models in menu order (platform, then model). */
export const DEVICE_TARGETS_SQL = sql`SELECT dm.id, dm.slug, dm.name, dm.generation_id, dm.platform_id, dm.device_kind, dm.art_key, dm.sort,
  pl.slug AS platform_slug, pl.sort AS platform_sort, pl.is_active AS platform_active
FROM device_models AS dm
JOIN platforms AS pl ON pl.id = dm.platform_id
WHERE dm.status = 'published'
ORDER BY pl.sort, dm.sort, dm.id`;

export const targetsOf = (result: unknown): DeviceTarget[] => rowsOf<TargetRow>(result).map(toTarget);

/** Every published device model (26 in the demo catalogue — one small indexed read). */
export async function loadDeviceTargets(db: Db): Promise<DeviceTarget[]> {
  return (await db.all<TargetRow>(DEVICE_TARGETS_SQL)).map(toTarget);
}

type RuleRow = { subject_type: string; subject_id: string; product_id: string | null; target_type: string; target_id: string; status: string; note: string | null };

export function toRules(rows: readonly RuleRow[]): RuleLite[] {
  const rules: RuleLite[] = [];
  for (const row of rows) {
    if (!row.product_id || !STATUSES.has(row.status) || !LEVELS.has(row.target_type)) continue;
    if (row.subject_type !== "product" && row.subject_type !== "variant") continue;
    rules.push({
      subjectType: row.subject_type,
      subjectId: row.subject_id,
      productId: row.product_id,
      targetType: row.target_type as CompatibilityTargetLevel,
      targetId: row.target_id,
      status: row.status as CompatibilityStatus,
      note: l10n(row.note),
    });
  }
  return rules;
}

/** A variant row that repeats its product's columns (select it with VARIANT_META_COLUMNS). */
export type VariantMetaRow = {
  variant_id: string;
  title: string | null;
  is_default: number;
  sort: number;
  product_id: string;
  slug: string;
  kind: string;
  platform_id: string | null;
  device_model_id: string | null;
  category_id: string | null;
  game_platforms: string | null;
};

/** Variant rows that repeat their product's columns → products and their active variants. */
export function toProductsAndVariants(rows: readonly VariantMetaRow[]): { products: Map<string, ProductMeta>; variants: Map<string, VariantLite[]> } {
  const products = new Map<string, ProductMeta>();
  const variants = new Map<string, VariantLite[]>();
  for (const row of rows) {
    if (!products.has(row.product_id)) {
      products.set(row.product_id, {
        id: row.product_id,
        slug: row.slug,
        kind: row.kind,
        platformId: row.platform_id ?? null,
        deviceModelId: row.device_model_id ?? null,
        categoryId: row.category_id ?? null,
        gamePlatforms: stringList(row.game_platforms),
      });
    }
    const list = variants.get(row.product_id) ?? [];
    list.push({ id: row.variant_id, productId: row.product_id, title: l10n(row.title), isDefault: row.is_default === 1, sort: Number(row.sort) || 0 });
    variants.set(row.product_id, list);
  }
  return { products, variants };
}

/** The columns of a "variant + its product" row (VariantMetaRow), for statements that feed toProductsAndVariants. */
export const VARIANT_META_COLUMNS = sql`v.id AS variant_id, v.title, v.is_default, v.sort, p.id AS product_id, p.slug, p.kind, p.platform_id,
  p.device_model_id, p.category_id, json_extract(p.attributes, '$.game.platforms') AS game_platforms`;

// ───────────────────────────────────────────────────────────────── many products on a set of models

/** Rules whose target is one of these models, their generations or their platforms (with each rule's product). */
function rulesForModelsSql(models: readonly DeviceTarget[]) {
  const modelIds = JSON.stringify(models.map((model) => model.id));
  const generationIds = JSON.stringify([...new Set(models.map((model) => model.generationId).filter((id): id is string => id !== null))]);
  const platformIds = JSON.stringify([...new Set(models.map((model) => model.platformId))]);
  const where = sql`(r.target_type = 'device_model' AND r.target_id IN (SELECT value FROM json_each(${modelIds})))
   OR (r.target_type = 'generation' AND r.target_id IN (SELECT value FROM json_each(${generationIds})))
   OR (r.target_type = 'platform' AND r.target_id IN (SELECT value FROM json_each(${platformIds})))`;
  return {
    rules: sql`SELECT r.subject_type, r.subject_id, r.target_type, r.target_id, r.status, r.note,
  CASE WHEN r.subject_type = 'product' THEN r.subject_id ELSE rv.product_id END AS product_id
FROM compatibility_rules AS r
LEFT JOIN variants AS rv ON r.subject_type = 'variant' AND rv.id = r.subject_id
WHERE ${where}`,
    variants: sql`SELECT ${VARIANT_META_COLUMNS}
FROM variants AS v
JOIN products AS p ON p.id = v.product_id
WHERE v.is_active = 1 AND p.status = 'published' AND p.id IN (
  SELECT CASE WHEN r.subject_type = 'product' THEN r.subject_id ELSE (SELECT rv.product_id FROM variants AS rv WHERE rv.id = r.subject_id) END
  FROM compatibility_rules AS r
  WHERE ${where}
)
ORDER BY p.id, v.is_default DESC, v.sort, v.id`,
  };
}

/** Statements for compatibilityForModels(), so a caller can put them in its own batch. */
export function compatibilityStatements(db: Db, models: readonly DeviceTarget[]) {
  const query = rulesForModelsSql(models);
  return [batchSql(db, query.rules), batchSql(db, query.variants)] as const;
}

/**
 * The same statements for model ids only (generations and platforms are looked up in SQL), so they can share a batch
 * with the read of the models themselves. Read the results with readCompatibility(models, …) once the models are known.
 */
export function compatibilityStatementsByIds(db: Db, modelIds: readonly string[]) {
  const ids = JSON.stringify([...new Set(modelIds)]);
  const where = sql`(r.target_type = 'device_model' AND r.target_id IN (SELECT value FROM json_each(${ids})))
   OR (r.target_type = 'generation' AND r.target_id IN (SELECT generation_id FROM device_models WHERE generation_id IS NOT NULL AND id IN (SELECT value FROM json_each(${ids}))))
   OR (r.target_type = 'platform' AND r.target_id IN (SELECT platform_id FROM device_models WHERE id IN (SELECT value FROM json_each(${ids}))))`;
  return [
    batchSql(
      db,
      sql`SELECT r.subject_type, r.subject_id, r.target_type, r.target_id, r.status, r.note,
  CASE WHEN r.subject_type = 'product' THEN r.subject_id ELSE rv.product_id END AS product_id
FROM compatibility_rules AS r
LEFT JOIN variants AS rv ON r.subject_type = 'variant' AND rv.id = r.subject_id
WHERE ${where}`,
    ),
    batchSql(
      db,
      sql`SELECT ${VARIANT_META_COLUMNS}
FROM variants AS v
JOIN products AS p ON p.id = v.product_id
WHERE v.is_active = 1 AND p.status = 'published' AND p.id IN (
  SELECT CASE WHEN r.subject_type = 'product' THEN r.subject_id ELSE (SELECT rv.product_id FROM variants AS rv WHERE rv.id = r.subject_id) END
  FROM compatibility_rules AS r
  WHERE ${where}
)
ORDER BY p.id, v.is_default DESC, v.sort, v.id`,
    ),
  ] as const;
}

export type ModelCompatibility = {
  /** Published products that have at least one rule touching one of the models. */
  products: Map<string, ProductMeta>;
  variants: Map<string, VariantLite[]>;
  rules: RuleLite[];
  /** model id → product id → the answer (only products with a rule touching that model). */
  byModel: Map<string, Map<string, Resolution>>;
};

/** Turns the results of compatibilityStatements() into answers per model and product. */
export function readCompatibility(models: readonly DeviceTarget[], rulesResult: unknown, variantsResult: unknown): ModelCompatibility {
  const rules = toRules(rowsOf<RuleRow>(rulesResult));
  const { products, variants } = toProductsAndVariants(rowsOf<VariantMetaRow>(variantsResult));
  const rulesByProduct = new Map<string, RuleLite[]>();
  for (const rule of rules) {
    if (!products.has(rule.productId)) continue; // unpublished, or no active variant
    const list = rulesByProduct.get(rule.productId) ?? [];
    list.push(rule);
    rulesByProduct.set(rule.productId, list);
  }
  const byModel = new Map<string, Map<string, Resolution>>();
  for (const model of models) {
    const answers = new Map<string, Resolution>();
    for (const [productId, productRules] of rulesByProduct) {
      if (!productRules.some((rule) => ruleTargets(rule, model))) continue;
      answers.set(productId, resolveForModel(productId, variants.get(productId) ?? [], productRules, model));
    }
    byModel.set(model.id, answers);
  }
  return { products, variants, rules, byModel };
}

/** Every published product with a rule touching one of these models, answered per model. One round trip. */
export async function compatibilityForModels(db: Db, models: readonly DeviceTarget[]): Promise<ModelCompatibility> {
  if (models.length === 0) return { products: new Map(), variants: new Map(), rules: [], byModel: new Map() };
  const [rulesResult, variantsResult] = await runBatch(db, compatibilityStatements(db, models));
  return readCompatibility(models, rulesResult, variantsResult);
}

// ───────────────────────────────────────────────────────────────── a set of products on every device

/**
 * Statements reading the rules, the product facts and the active variants of some products — named by product id
 * and/or by the id of one of their variants (a cart) — for readProductsCompatibility().
 */
export function productRulesStatements(db: Db, which: { productIds?: readonly string[]; variantIds?: readonly string[] }) {
  const productIds = JSON.stringify([...new Set(which.productIds ?? [])]);
  const variantIds = JSON.stringify([...new Set(which.variantIds ?? [])]);
  const products = sql`(SELECT value FROM json_each(${productIds}) UNION SELECT product_id FROM variants WHERE id IN (SELECT value FROM json_each(${variantIds})))`;
  return [
    batchSql(
      db,
      sql`SELECT r.subject_type, r.subject_id, r.target_type, r.target_id, r.status, r.note,
  CASE WHEN r.subject_type = 'product' THEN r.subject_id ELSE rv.product_id END AS product_id
FROM compatibility_rules AS r
LEFT JOIN variants AS rv ON r.subject_type = 'variant' AND rv.id = r.subject_id
WHERE (r.subject_type = 'product' AND r.subject_id IN ${products})
   OR (r.subject_type = 'variant' AND rv.product_id IN ${products})`,
    ),
    batchSql(
      db,
      sql`SELECT ${VARIANT_META_COLUMNS}
FROM variants AS v
JOIN products AS p ON p.id = v.product_id
WHERE v.is_active = 1 AND p.id IN ${products}
ORDER BY p.id, v.is_default DESC, v.sort, v.id`,
    ),
  ] as const;
}

export type ProductsCompatibility = {
  products: Map<string, ProductMeta>;
  /** product id → model id → the answer, for every model a rule of the product touches. */
  byProduct: Map<string, Map<string, Resolution>>;
};

/** Turns the results of productRulesStatements() into answers per product and touched model. */
export function readProductsCompatibility(targets: readonly DeviceTarget[], rulesResult: unknown, variantsResult: unknown): ProductsCompatibility {
  const rules = toRules(rowsOf<RuleRow>(rulesResult));
  const { products, variants } = toProductsAndVariants(rowsOf<VariantMetaRow>(variantsResult));
  const byProduct = new Map<string, Map<string, Resolution>>();
  for (const [productId] of products) {
    const own = rules.filter((rule) => rule.productId === productId);
    const answers = new Map<string, Resolution>();
    for (const model of targets) {
      if (!own.some((rule) => ruleTargets(rule, model))) continue;
      answers.set(model.id, resolveForModel(productId, variants.get(productId) ?? [], own, model));
    }
    byProduct.set(productId, answers);
  }
  return { products, byProduct };
}

// ───────────────────────────────────────────────────────────────── one product on every device

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Device kinds a product can be "used on" — the ones that get an explicit "unverified" when no rule exists. */
const PLAY_DEVICE_KINDS: ReadonlySet<string> = new Set(["console", "handheld_pc"]);

type ProductRow = { id: string; kind: string; platform_id: string | null; device_model_id: string | null; game_platforms: string | null };

/**
 * Every device the product's rules speak about, plus an explicit "unverified" for the other consoles and handheld
 * PCs of the platforms it is made for (see the file header). Ordered like the menus: platform, then model.
 * Unknown product → []. Works for any status (the admin may preview a draft); storefront callers pass published ids.
 */
export async function getCompatibilityForProduct(db: Db, locale: Locale, productId: string): Promise<ProductCompatibility[]> {
  if (typeof productId !== "string" || !ID.test(productId)) throw invalid({ productId: "invalid" }, "compatibility.getCompatibilityForProduct");
  const [productResult, variantResult, ruleResult, targetResult] = await runBatch(db, [
    batchSql(db, sql`SELECT p.id, p.kind, p.platform_id, p.device_model_id, json_extract(p.attributes, '$.game.platforms') AS game_platforms FROM products AS p WHERE p.id = ${productId}`),
    batchSql(db, sql`SELECT v.id, v.title, v.is_default, v.sort FROM variants AS v WHERE v.product_id = ${productId} AND v.is_active = 1 ORDER BY v.is_default DESC, v.sort, v.id`),
    batchSql(
      db,
      sql`SELECT r.subject_type, r.subject_id, r.target_type, r.target_id, r.status, r.note, ${productId} AS product_id
FROM compatibility_rules AS r
WHERE (r.subject_type = 'product' AND r.subject_id = ${productId})
   OR (r.subject_type = 'variant' AND r.subject_id IN (SELECT id FROM variants WHERE product_id = ${productId} AND is_active = 1))`,
    ),
    batchSql(db, DEVICE_TARGETS_SQL),
  ]);
  const product = rowsOf<ProductRow>(productResult)[0];
  if (!product) return [];
  const variants: VariantLite[] = rowsOf<{ id: string; title: string | null; is_default: number; sort: number }>(variantResult).map((row) => ({
    id: row.id,
    productId,
    title: l10n(row.title),
    isDefault: row.is_default === 1,
    sort: Number(row.sort) || 0,
  }));
  const rules = toRules(rowsOf<RuleRow>(ruleResult));
  const targets = targetsOf(targetResult);

  const touched = targets.filter((model) => rules.some((rule) => ruleTargets(rule, model)));
  const rows: { model: DeviceTarget; resolution: Resolution }[] = touched.map((model) => ({ model, resolution: resolveForModel(productId, variants, rules, model) }));

  // Explicit "unverified" for the platforms the product is made for — never for products that are devices themselves.
  const isDevice = product.device_model_id !== null || product.kind === "console";
  if (!isDevice) {
    const platforms = new Set<string>();
    if (product.platform_id) platforms.add(product.platform_id);
    for (const slug of stringList(product.game_platforms)) {
      const model = targets.find((target) => target.slug === slug);
      if (model) platforms.add(model.platformId);
    }
    for (const { model, resolution } of rows) if (resolution.status !== "incompatible") platforms.add(model.platformId);
    const listed = new Set(touched.map((model) => model.id));
    for (const model of targets) {
      if (listed.has(model.id) || !model.platformActive || !platforms.has(model.platformId) || !PLAY_DEVICE_KINDS.has(model.deviceKind)) continue;
      rows.push({ model, resolution: { status: "unverified", note: null, level: null, split: null } });
    }
  }

  const order = new Map(targets.map((model, index) => [model.id, index]));
  rows.sort((a, b) => (order.get(a.model.id) ?? 0) - (order.get(b.model.id) ?? 0));
  return rows.map(({ model, resolution }) => ({
    deviceSlug: model.slug,
    deviceName: pick(model.name, locale),
    status: resolution.status,
    note: resolutionNote(resolution, locale),
    platformSlug: model.platformSlug,
    hasHub: model.platformActive,
    level: resolution.level,
  }));
}
