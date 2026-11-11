/**
 * Device hubs — "everything about this device" (/device/:model; brief §3.4, DESIGN.md §8.7, docs/CONTRACTS.md §3).
 *
 *   const hub = await getDeviceHub(db, ctx.locale, params.model, { now: ctx.now });   // null → 404
 *   const hubs = await listDeviceHubs(db, ctx.locale);                                  // every slug that has a hub (sitemap)
 *
 * WHAT A HUB SHOWS — every value is a stored fact; nothing is estimated or invented:
 *   model      name, summary, platform, generation, release date and photos of a published `device_models` row on an
 *              ACTIVE platform. The generic "windows-pc" target (inactive "pc" platform) and drafts have no hub (null).
 *   editions   the catalogue products that ARE this device (`products.device_model_id`), and the product whose photo
 *              the model uses (`device_models.art_key` = "<product-slug>--<n>"; this is how the 2020 PS5 Digital
 *              Edition, a variant of the "playstation-5" product, finds its product). When one product covers two
 *              models, a variant belongs to the model whose photo is the variant's first picture — so the 2020 disc
 *              and digital PS5 each list only their own variant and their own used units.
 *   versions   those variants with the maker's model number (`options.model`), a later release date
 *              (`attributes.variantReleaseDates`) and the research note per version; `notes` = the products' notes.
 *   specs      the researched spec sheet (`device_models.specs`, each value carrying its own label), grouped.
 *   games      games whose researched `game.platforms` lists the model, plus games with a rule for it — each with the
 *              status of the box the store sells (compatibility.server.ts: model › generation › platform rules,
 *              never inferred). A game that exists for the model but whose disc does not fit says so.
 *   accessories  every other product with a rule touching the model, grouped by status (incompatible ones too, so a
 *              shopper does not buy them for this device). Spare parts (kind "part") are listed apart.
 *   compare    up to four sibling models (same platform and catalogue category; same generation first) on a fixed
 *              set of comparable rows; a value the research does not give is null (shown as "not in our sources").
 *   help       approved public knowledge articles of the model, of its platform (no model), and of sibling models
 *              of the same generation (labelled with the model they were written for); approved troubleshooting
 *              trees of the model, its platform, or any device. Links go to /support/article/<slug> and to the
 *              assistant (support area).
 *   faq        questions answered only from the facts above (storage, discs, battery, language, TV, games, box).
 *   used       listed used units of this model (catalogue read layer's used cards, so photos are labelled honestly).
 *   warranty   the STORE's warranty months of the editions (`products.warranty_months`) — empty in the demo catalogue
 *              because the owner has not set a policy (docs/STATUS.md open item 15), and the page says exactly that.
 *
 * Two to three round trips: the model by slug; one batch of eleven reads; then the cards (and used cards).
 * Services take `db` first and never import "cloudflare:workers".
 */
import { sql } from "drizzle-orm";
import { serverT } from "~/i18n/i18n.server";
import type { CompatibilityStatus, ImageRef, ProductCardData, UsedUnitCardData } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import type { Db } from "~/server/db/drizzle.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { getCardsByIds, getUsedSpotlight, MAX_CARD_IDS } from "~/server/services/catalog/cards.server";
import {
  compatibilityStatements,
  readCompatibility,
  resolutionNote,
  toProductsAndVariants,
  VARIANT_META_COLUMNS,
  type DeviceTarget,
  type Resolution,
  type VariantMetaRow,
} from "./compatibility.server";

// ───────────────────────────────────────────────────────────────── types (client-safe shapes)

export type SpecGroupId = "performance" | "display" | "storage" | "battery" | "connectivity" | "design" | "software" | "more";
export type SpecRow = { key: string; label: string; value: string };
export type SpecGroup = { id: SpecGroupId; rows: SpecRow[] };

export type HubModel = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  platform: { slug: string; name: string; accent: string };
  generation: { slug: string; name: string } | null;
  /** "YYYY-MM-DD", "YYYY-MM" or "YYYY" as researched; null when unknown. */
  releasedOn: string | null;
  deviceKind: string;
  /** Global menu order (device_models.sort) — sibling links use it for the sideways push. */
  sort: number;
  images: ImageRef[];
};

export type HubVersion = {
  productSlug: string;
  productName: string;
  variantId: string;
  title: string;
  /** The maker's model number (options.model), or null when the research found none. */
  modelNumber: string | null;
  /** "YYYY-MM-DD" when this version comes out after its product (a pre-order); else null. */
  releaseDate: string | null;
  note: string | null;
};

export type HubNote = { productSlug: string; productName: string; text: string };

export type CompatItem = { card: ProductCardData; status: CompatibilityStatus; note: string | null };
export type CompatGroup = { status: CompatibilityStatus; items: CompatItem[] };
export type StatusCounts = Record<CompatibilityStatus, number>;

export type CompareColumn = { slug: string; name: string; current: boolean; artKey: string | null; sort: number };
export type CompareRowId = "released" | "storage" | "expansion" | "discs" | "display" | "tv" | "performance" | "memory" | "battery" | "connectivity" | "size" | "weight";
/** One comparison row; `cells[i]` belongs to `columns[i]` (null = not in our sources). Dates are raw "YYYY-MM-DD". */
export type CompareRow = { id: CompareRowId; cells: (string[] | null)[] };
export type HubComparison = { columns: CompareColumn[]; rows: CompareRow[] };

export type HubArticle = { slug: string; kind: string; title: string; summary: string | null; scope: "device" | "platform" | "sibling"; writtenFor: string | null };
export type HubTree = { symptomKey: string; title: string; scope: "device" | "platform" | "all" };
export type HubFaq = { id: string; question: string; answer: string[] };
export type HubSource = { url: string; title: string | null; publisher: string | null };

export type DeviceHub = {
  model: HubModel;
  editions: ProductCardData[];
  versions: HubVersion[];
  notes: HubNote[];
  highlights: string[];
  inTheBox: string[];
  specs: SpecGroup[];
  games: CompatGroup[];
  accessories: CompatGroup[];
  parts: CompatItem[];
  counts: { games: StatusCounts; accessories: StatusCounts };
  comparison: HubComparison | null;
  articles: HubArticle[];
  trees: HubTree[];
  faq: HubFaq[];
  used: UsedUnitCardData[];
  /** The store's own warranty, in months, per edition that has one (distinct values); [] = not set by the store. */
  warrantyMonths: number[];
  sources: HubSource[];
  /** For the recommendation shelf (devices hub context) and the meta image. */
  mainProductSlug: string | null;
};

export type DeviceHubListing = { slug: string; name: string; platformSlug: string };

// ───────────────────────────────────────────────────────────────── small helpers

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];

function parseJson<T>(text: unknown): T | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

const isL10n = (value: unknown): value is L10n => !!value && typeof value === "object" && typeof (value as L10n).ar === "string";
const l10n = (value: unknown): L10n | null => {
  const parsed = typeof value === "string" ? parseJson<unknown>(value) : value;
  return isL10n(parsed) ? parsed : null;
};
const text = (value: unknown, locale: Locale): string => (isL10n(value) ? pick(value, locale).trim() : "");

/** "playstation-5--2" → "playstation-5" (photo keys are "<product-slug>--<n>"). */
export function artSlug(artKey: string | null | undefined): string | null {
  if (!artKey) return null;
  const match = /^(.+)--\d+$/.exec(artKey);
  return match ? match[1] : null;
}

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// ───────────────────────────────────────────────────────────────── specs

/** Which group a researched spec key belongs to. Unknown keys fall into "more", in research order. */
const SPEC_GROUP_OF: Readonly<Record<string, SpecGroupId>> = {
  processor: "performance",
  cpu: "performance",
  gpu: "performance",
  "cpu-gpu": "performance",
  chip: "performance",
  memory: "performance",
  performance: "performance",
  display: "display",
  video: "display",
  tv_output: "display",
  hdmi: "display",
  fov: "display",
  storage: "storage",
  expansion: "storage",
  disc: "storage",
  optical: "storage",
  capacity: "storage",
  battery: "battery",
  charging: "battery",
  connectivity: "connectivity",
  network: "connectivity",
  wireless: "connectivity",
  ports: "connectivity",
  connection: "connectivity",
  size: "design",
  dimensions: "design",
  weight: "design",
  controls: "design",
  os: "software",
  system_languages: "software",
  language: "software",
  languages: "software",
};

export const SPEC_GROUP_ORDER: readonly SpecGroupId[] = ["performance", "display", "storage", "battery", "connectivity", "design", "software", "more"];

type SpecValue = string | number | boolean | (L10n & { label?: L10n });

function specValueText(value: unknown, locale: Locale, yesNo: (yes: boolean) => string): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return yesNo(value);
  return text(value, locale);
}

/** The researched spec sheet, grouped (performance, display, storage, battery, …); empty groups are left out. */
export function groupSpecs(specs: Record<string, SpecValue> | null, locale: Locale): SpecGroup[] {
  if (!specs || typeof specs !== "object") return [];
  const t = serverT(locale, "devices");
  const yesNo = (yes: boolean) => t(yes ? "specs.yes" : "specs.no");
  const groups = new Map<SpecGroupId, SpecRow[]>();
  for (const [key, raw] of Object.entries(specs)) {
    const value = specValueText(raw, locale, yesNo);
    if (!value) continue;
    const label = (raw && typeof raw === "object" && "label" in raw ? text((raw as { label?: unknown }).label, locale) : "") || key;
    const group = SPEC_GROUP_OF[key] ?? "more";
    const rows = groups.get(group) ?? [];
    rows.push({ key, label, value });
    groups.set(group, rows);
  }
  return SPEC_GROUP_ORDER.filter((id) => groups.has(id)).map((id) => ({ id, rows: groups.get(id) ?? [] }));
}

// ───────────────────────────────────────────────────────────────── comparison

/** Spec keys each comparison row reads, in order of preference; every key present is shown (one line each). */
const COMPARE_KEYS: readonly { id: Exclude<CompareRowId, "released">; keys: readonly string[]; first?: boolean }[] = [
  { id: "storage", keys: ["storage"] },
  { id: "expansion", keys: ["expansion"] },
  { id: "discs", keys: ["disc", "optical"], first: true },
  { id: "display", keys: ["display"] },
  { id: "tv", keys: ["tv_output", "video"], first: true },
  { id: "performance", keys: ["chip", "cpu-gpu", "processor", "cpu", "gpu"] },
  { id: "memory", keys: ["memory"] },
  { id: "battery", keys: ["battery"] },
  { id: "connectivity", keys: ["connectivity", "network", "wireless"], first: true },
  { id: "size", keys: ["size", "dimensions"], first: true },
  { id: "weight", keys: ["weight"] },
];

export type ComparableModel = { slug: string; name: string; specs: Record<string, SpecValue> | null; releasedOn: string | null; artKey: string | null; sort: number };

/** The comparison table for a model and its siblings. Rows nobody has are dropped; null cells = not researched. */
export function buildComparison(current: ComparableModel, siblings: readonly ComparableModel[], locale: Locale): HubComparison | null {
  if (siblings.length === 0) return null;
  const models = [current, ...siblings];
  const yesNo = (yes: boolean) => serverT(locale, "devices")(yes ? "specs.yes" : "specs.no");
  const rows: CompareRow[] = [];
  rows.push({ id: "released", cells: models.map((model) => (model.releasedOn ? [model.releasedOn] : null)) });
  for (const row of COMPARE_KEYS) {
    const cells = models.map((model) => {
      const values: string[] = [];
      for (const key of row.keys) {
        const value = specValueText(model.specs?.[key], locale, yesNo);
        if (!value) continue;
        values.push(value);
        if (row.first) break;
      }
      return values.length > 0 ? values : null;
    });
    if (cells.some((cell) => cell !== null)) rows.push({ id: row.id, cells });
  }
  // a table with nothing but the release date compares nothing
  if (rows.length <= 1) return null;
  return {
    columns: models.map((model, index) => ({ slug: model.slug, name: model.name, current: index === 0, artKey: model.artKey, sort: model.sort })),
    rows: rows.filter((row) => row.cells.some((cell) => cell !== null)),
  };
}

// ───────────────────────────────────────────────────────────────── FAQ

type FaqFacts = {
  deviceName: string;
  specs: Record<string, SpecValue> | null;
  games: StatusCounts;
  inTheBox: string[];
};

/** Questions answered only from stored facts (a question without a fact is left out). */
export function buildFaq(facts: FaqFacts, locale: Locale): HubFaq[] {
  const t = serverT(locale, "devices");
  const device = `⁨${facts.deviceName}⁩`;
  const yesNo = (yes: boolean) => t(yes ? "specs.yes" : "specs.no");
  const spec = (key: string) => specValueText(facts.specs?.[key], locale, yesNo);
  const faq: HubFaq[] = [];
  const add = (id: string, answer: string[]) => {
    const lines = answer.map((line) => line.trim()).filter((line) => line !== "");
    if (lines.length > 0) faq.push({ id, question: t(`faq.q.${id}`, { device }), answer: lines });
  };
  add("storage", [spec("storage"), spec("expansion")]);
  add("discs", [spec("disc") || spec("optical")]);
  add("battery", [spec("battery"), spec("charging")]);
  add("language", [spec("system_languages") || spec("language")]);
  add("tv", [spec("tv_output") || spec("video")]);
  const { verified, partial } = facts.games;
  if (verified + partial > 0) {
    const lines = [t("faq.gamesVerified", { count: verified, n: verified })];
    if (partial > 0) lines.push(t("faq.gamesPartial", { count: partial, n: partial }));
    add("games", lines);
  }
  if (facts.inTheBox.length > 0) add("box", [facts.inTheBox.join(locale === "en" ? "; " : "؛ ")]);
  return faq;
}

// ───────────────────────────────────────────────────────────────── ordering

const STATUS_ORDER: readonly CompatibilityStatus[] = ["verified", "partial", "unverified", "incompatible"];
const STOCK_ORDER: Record<ProductCardData["stock"], number> = { in_stock: 0, low_stock: 1, preorder: 2, out_of_stock: 3 };
const KIND_ORDER: Record<string, number> = { controller: 0, headset: 1, storage: 2, accessory: 3, digital: 4, part: 5, bundle: 6, console: 7, game: 8 };

function byShelfOrder(locale: Locale) {
  const collator = new Intl.Collator(locale === "ckb" ? "ckb" : locale);
  return (a: CompatItem, b: CompatItem) =>
    STOCK_ORDER[a.card.stock] - STOCK_ORDER[b.card.stock] || (KIND_ORDER[a.card.kind] ?? 9) - (KIND_ORDER[b.card.kind] ?? 9) || collator.compare(a.card.name, b.card.name);
}

function groupByStatus(items: CompatItem[], locale: Locale): CompatGroup[] {
  const sorter = byShelfOrder(locale);
  return STATUS_ORDER.map((status) => ({ status, items: items.filter((item) => item.status === status).sort(sorter) })).filter((group) => group.items.length > 0);
}

const countOf = (groups: readonly CompatGroup[]): StatusCounts => {
  const counts: StatusCounts = { verified: 0, partial: 0, unverified: 0, incompatible: 0 };
  for (const group of groups) counts[group.status] += group.items.length;
  return counts;
};

// ───────────────────────────────────────────────────────────────── SQL rows

type ModelRow = {
  id: string;
  slug: string;
  name: string;
  summary: string | null;
  specs: string | null;
  released_on: string | null;
  status: string;
  device_kind: string;
  art_key: string | null;
  sort: number;
  generation_id: string | null;
  platform_id: string;
  platform_slug: string;
  platform_name: string;
  accent: string;
  platform_active: number;
  platform_sort: number;
  generation_slug: string | null;
  generation_name: string | null;
};

type DeviceProductRow = { id: string; slug: string; kind: string; name: string; attributes: string | null; warranty_months: number | null; device_model_id: string | null; pub: number };
type DeviceVariantRow = { id: string; product_id: string; sku: string; title: string | null; options: string | null; is_default: number; sort: number; art_key: string | null };
type PlatformModelRow = { id: string; slug: string; name: string; specs: string | null; art_key: string | null; sort: number; generation_id: string | null; released_on: string | null; device_kind: string; category_id: string | null };
type ArticleRow = { slug: string; kind: string; title: string; summary: string | null; device_model_id: string | null; model_name: string | null };
type TreeRow = { symptom_key: string; title: string; device_model_id: string | null; platform_id: string | null };
type UsedRow = { id: string; variant_id: string; device_model_id: string | null };
type MediaRow = { art_key: string; alt: string | null };

type ProductAttributes = {
  notes?: L10n | null;
  highlights?: L10n[];
  inTheBox?: L10n[];
  variantNotes?: Record<string, L10n>;
  variantReleaseDates?: Record<string, string>;
  sources?: Array<{ url?: string; title?: string; publisher?: string }>;
};

const MODEL_SQL = (slug: string) => sql`SELECT dm.id, dm.slug, dm.name, dm.summary, dm.specs, dm.released_on, dm.status, dm.device_kind, dm.art_key, dm.sort,
  dm.generation_id, dm.platform_id, pl.slug AS platform_slug, pl.name AS platform_name, pl.accent, pl.is_active AS platform_active,
  pl.sort AS platform_sort, g.slug AS generation_slug, g.name AS generation_name
FROM device_models AS dm
JOIN platforms AS pl ON pl.id = dm.platform_id
LEFT JOIN device_generations AS g ON g.id = dm.generation_id
WHERE dm.slug = ${slug}`;

// ───────────────────────────────────────────────────────────────── public API

/** Every device that has a hub (published model on an active platform), in menu order — for the sitemap. */
export async function listDeviceHubs(db: Db, locale: Locale): Promise<DeviceHubListing[]> {
  const rows = await db.all<{ slug: string; name: string; platform_slug: string }>(sql`SELECT dm.slug, dm.name, pl.slug AS platform_slug
FROM device_models AS dm JOIN platforms AS pl ON pl.id = dm.platform_id
WHERE dm.status = 'published' AND pl.is_active = 1
ORDER BY pl.sort, dm.sort, dm.id`);
  return rows.map((row) => ({ slug: row.slug, name: pick(l10n(row.name), locale) || row.slug, platformSlug: row.platform_slug }));
}

/**
 * The whole hub for one device model, or null when there is none (unknown slug, draft or archived model, model of
 * an inactive platform). See the file header for where each part comes from.
 */
export async function getDeviceHub(db: Db, locale: Locale, slug: string, options: { now?: number } = {}): Promise<DeviceHub | null> {
  if (typeof slug !== "string" || slug.length > 80 || !SLUG.test(slug)) return null;
  const now = options.now ?? Date.now();
  const modelRow = (await db.all<ModelRow>(MODEL_SQL(slug)))[0];
  if (!modelRow || modelRow.status !== "published" || modelRow.platform_active !== 1) return null;

  const target: DeviceTarget = {
    id: modelRow.id,
    slug: modelRow.slug,
    name: l10n(modelRow.name) ?? { ar: modelRow.slug },
    generationId: modelRow.generation_id ?? null,
    platformId: modelRow.platform_id,
    platformSlug: modelRow.platform_slug,
    platformActive: true,
    deviceKind: modelRow.device_kind,
    artKey: modelRow.art_key ?? null,
    sort: Number(modelRow.sort) || 0,
    platformSort: Number(modelRow.platform_sort) || 0,
  };
  const mainSlug = artSlug(modelRow.art_key) ?? "";
  const [rulesStatement, ruleVariantsStatement] = compatibilityStatements(db, [target]);

  const [mediaResult, productsResult, variantsResult, rulesResult, ruleVariantsResult, gamesResult, platformModelsResult, articlesResult, treesResult, usedResult, partsResult] =
    await runBatch(db, [
      batchSql(db, sql`SELECT m.art_key, m.alt FROM media AS m WHERE m.owner_type = 'device_model' AND m.owner_id = ${target.id} AND m.art_key IS NOT NULL ORDER BY m.sort, m.id LIMIT 4`),
      batchSql(
        db,
        sql`SELECT p.id, p.slug, p.kind, p.name, p.attributes, p.warranty_months, p.device_model_id, COALESCE(p.published_at, p.created_at) AS pub
FROM products AS p
WHERE p.status = 'published' AND (p.device_model_id = ${target.id} OR p.slug = ${mainSlug})
ORDER BY CASE WHEN p.slug = ${mainSlug} THEN 0 ELSE 1 END, pub DESC, p.id`,
      ),
      batchSql(
        db,
        sql`SELECT v.id, v.product_id, v.sku, v.title, v.options, v.is_default, v.sort,
  (SELECT m.art_key FROM media AS m WHERE m.owner_type = 'variant' AND m.owner_id = v.id ORDER BY m.sort, m.id LIMIT 1) AS art_key
FROM variants AS v
JOIN products AS p ON p.id = v.product_id
WHERE v.is_active = 1 AND p.status = 'published' AND (p.device_model_id = ${target.id} OR p.slug = ${mainSlug})
ORDER BY p.id, v.is_default DESC, v.sort, v.id`,
      ),
      rulesStatement,
      ruleVariantsStatement,
      batchSql(
        db,
        sql`SELECT ${VARIANT_META_COLUMNS}
FROM variants AS v
JOIN products AS p ON p.id = v.product_id
WHERE v.is_active = 1 AND p.status = 'published' AND p.kind = 'game'
  AND EXISTS (SELECT 1 FROM json_each(p.attributes, '$.game.platforms') AS gp WHERE gp.value = ${target.slug})
ORDER BY p.id, v.is_default DESC, v.sort, v.id`,
      ),
      batchSql(
        db,
        sql`SELECT dm.id, dm.slug, dm.name, dm.specs, dm.art_key, dm.sort, dm.generation_id, dm.released_on, dm.device_kind,
  COALESCE(
    (SELECT p.category_id FROM products AS p WHERE p.status = 'published' AND p.device_model_id = dm.id ORDER BY COALESCE(p.published_at, p.created_at), p.id LIMIT 1),
    (SELECT p.category_id FROM products AS p WHERE p.status = 'published' AND dm.art_key IS NOT NULL AND instr(dm.art_key, '--') > 0 AND p.slug = substr(dm.art_key, 1, instr(dm.art_key, '--') - 1))
  ) AS category_id
FROM device_models AS dm
WHERE dm.platform_id = ${target.platformId} AND dm.status = 'published'
ORDER BY dm.sort, dm.id`,
      ),
      batchSql(
        db,
        sql`SELECT k.slug, k.kind, k.title, k.summary, k.device_model_id, om.name AS model_name
FROM knowledge_articles AS k
LEFT JOIN device_models AS om ON om.id = k.device_model_id
WHERE k.status = 'approved' AND k.audience = 'public'
  AND (k.device_model_id = ${target.id}
    OR (k.device_model_id IS NULL AND k.platform_id = ${target.platformId})
    OR (${target.generationId} IS NOT NULL AND om.generation_id = ${target.generationId} AND om.status = 'published'))
ORDER BY CASE WHEN k.device_model_id = ${target.id} THEN 0 WHEN k.device_model_id IS NULL THEN 1 ELSE 2 END, k.sort, k.updated_at DESC, k.slug`,
      ),
      batchSql(
        db,
        sql`SELECT t.symptom_key, t.title, t.device_model_id, t.platform_id
FROM troubleshooting_trees AS t
WHERE t.status = 'approved'
  AND (t.device_model_id = ${target.id} OR (t.device_model_id IS NULL AND (t.platform_id = ${target.platformId} OR t.platform_id IS NULL)))
ORDER BY CASE WHEN t.device_model_id IS NOT NULL THEN 0 WHEN t.platform_id IS NOT NULL THEN 1 ELSE 2 END, t.symptom_key`,
      ),
      batchSql(
        db,
        sql`SELECT u.id, u.variant_id, p.device_model_id
FROM used_units AS u
JOIN variants AS v ON v.id = u.variant_id
JOIN products AS p ON p.id = v.product_id
WHERE u.status = 'listed' AND (p.device_model_id = ${target.id} OR p.slug = ${mainSlug})
ORDER BY COALESCE(u.listed_at, u.created_at) DESC, u.id DESC`,
      ),
      batchSql(db, sql`SELECT p.id FROM products AS p WHERE p.status = 'published' AND p.kind = 'part' AND p.device_model_id = ${target.id} ORDER BY p.id`),
    ]);

  // ── which device products and variants are THIS model
  const platformModels = rowsOf<PlatformModelRow>(platformModelsResult);
  const modelByArt = new Map(platformModels.filter((row) => row.art_key).map((row) => [row.art_key as string, row.id]));
  const deviceProducts = rowsOf<DeviceProductRow>(productsResult);
  const productById = new Map(deviceProducts.map((row) => [row.id, row]));
  const deviceVariants = rowsOf<DeviceVariantRow>(variantsResult);
  const ownVariants = deviceVariants.filter((variant) => {
    const mapped = variant.art_key ? modelByArt.get(variant.art_key) : undefined;
    if (mapped) return mapped === target.id;
    return productById.get(variant.product_id)?.device_model_id === target.id;
  });
  const ownProductSet = new Set(ownVariants.map((variant) => variant.product_id));
  // main product first, then newest (the order of the products statement)
  const editionProducts = deviceProducts.filter((row) => ownProductSet.has(row.id));
  const editionIds = editionProducts.map((row) => row.id);
  const ownVariantIds = new Set(ownVariants.map((variant) => variant.id));
  const deviceVariantIds = new Set(deviceVariants.map((variant) => variant.id));
  const mainProduct = editionProducts.find((row) => row.slug === mainSlug) ?? editionProducts[0] ?? null;
  const mainAttributes = parseJson<ProductAttributes>(mainProduct?.attributes) ?? {};

  // ── versions and notes
  const versions: HubVersion[] = ownVariants.map((variant) => {
    const product = productById.get(variant.product_id);
    const attributes = parseJson<ProductAttributes>(product?.attributes) ?? {};
    const options = parseJson<Record<string, string>>(variant.options) ?? {};
    return {
      productSlug: product?.slug ?? "",
      productName: text(l10n(product?.name), locale),
      variantId: variant.id,
      title: text(l10n(variant.title), locale) || text(l10n(product?.name), locale),
      modelNumber: typeof options.model === "string" && options.model.trim() !== "" ? options.model.trim() : null,
      releaseDate: attributes.variantReleaseDates?.[variant.sku] ?? null,
      note: text(attributes.variantNotes?.[variant.sku], locale) || null,
    };
  });
  const seenNotes = new Set<string>();
  const notes: HubNote[] = [];
  for (const product of editionProducts) {
    const note = text((parseJson<ProductAttributes>(product.attributes) ?? {}).notes, locale);
    if (!note || seenNotes.has(note)) continue;
    seenNotes.add(note);
    notes.push({ productSlug: product.slug, productName: text(l10n(product.name), locale), text: note });
  }

  // ── compatibility: games and everything else
  const compat = readCompatibility([target], rulesResult, ruleVariantsResult);
  const answers = compat.byModel.get(target.id) ?? new Map<string, Resolution>();
  const listedGames = toProductsAndVariants(rowsOf<VariantMetaRow>(gamesResult));
  const ownProductIds = new Set(deviceProducts.map((row) => row.id));
  type Pending = { productId: string; status: CompatibilityStatus; note: string | null; kind: string };
  const pendingGames: Pending[] = [];
  const pendingOthers: Pending[] = [];
  const pendingParts: Pending[] = [];
  for (const [productId, resolution] of answers) {
    if (ownProductIds.has(productId)) continue;
    const meta = compat.products.get(productId);
    if (!meta || meta.kind === "console") continue; // other devices are not accessories of this one
    const entry = { productId, status: resolution.status, note: resolutionNote(resolution, locale), kind: meta.kind };
    if (meta.kind === "game") pendingGames.push(entry);
    else if (meta.kind === "part") pendingParts.push(entry);
    else pendingOthers.push(entry);
  }
  for (const [productId] of listedGames.products) {
    if (answers.has(productId) || ownProductIds.has(productId)) continue;
    // listed for the model by research, but no rule says whether the box the store sells works: unverified
    pendingGames.push({ productId, status: "unverified", note: null, kind: "game" });
  }
  const partIds = rowsOf<{ id: string }>(partsResult).map((row) => row.id);
  for (const id of partIds) if (!pendingParts.some((part) => part.productId === id)) pendingParts.push({ productId: id, status: "verified", note: null, kind: "part" });

  // ── cards (one read per hundred ids) and used units
  const cardIds = [...new Set([...editionIds, ...pendingGames.map((p) => p.productId), ...pendingOthers.map((p) => p.productId), ...pendingParts.map((p) => p.productId)])];
  // a unit belongs to this model when its variant does; a unit of an inactive variant, when its product IS the model
  const usedIds = rowsOf<UsedRow>(usedResult)
    .filter((row) => (deviceVariantIds.has(row.variant_id) ? ownVariantIds.has(row.variant_id) : row.device_model_id === target.id))
    .map((row) => row.id);
  const chunks: string[][] = [];
  for (let i = 0; i < cardIds.length; i += MAX_CARD_IDS) chunks.push(cardIds.slice(i, i + MAX_CARD_IDS));
  const [cardLists, usedCards] = await Promise.all([
    Promise.all(chunks.map((chunk) => getCardsByIds(db, locale, chunk, { now }))),
    usedIds.length > 0 ? getUsedSpotlight(db, locale, { platform: target.platformSlug, limit: 60 }) : Promise.resolve([] as UsedUnitCardData[]),
  ]);
  const cards = new Map(cardLists.flat().map((card) => [card.id, card]));
  const itemOf = (entry: Pending): CompatItem | null => {
    const card = cards.get(entry.productId);
    return card ? { card, status: entry.status, note: entry.note } : null;
  };
  const games = groupByStatus(pendingGames.map(itemOf).filter((item): item is CompatItem => item !== null), locale);
  const accessories = groupByStatus(pendingOthers.map(itemOf).filter((item): item is CompatItem => item !== null), locale);
  const parts = pendingParts.map(itemOf).filter((item): item is CompatItem => item !== null && item.status !== "incompatible");
  const usedOrder = new Map(usedIds.map((id, index) => [id, index]));
  const used = usedCards.filter((unit) => usedOrder.has(unit.id)).sort((a, b) => (usedOrder.get(a.id) ?? 0) - (usedOrder.get(b.id) ?? 0));
  const editions = editionIds.map((id) => cards.get(id)).filter((card): card is ProductCardData => card !== undefined);

  // ── comparison
  const currentCategory = platformModels.find((row) => row.id === target.id)?.category_id ?? null;
  const name = pick(target.name, locale);
  const comparable = (row: PlatformModelRow): ComparableModel => ({
    slug: row.slug,
    name: pick(l10n(row.name), locale) || row.slug,
    specs: parseJson<Record<string, SpecValue>>(row.specs),
    releasedOn: row.released_on ?? null,
    artKey: row.art_key ?? null,
    sort: Number(row.sort) || 0,
  });
  const siblings = platformModels
    .filter((row) => row.id !== target.id && currentCategory !== null && row.category_id === currentCategory && parseJson(row.specs) !== null)
    .sort((a, b) => Number(b.generation_id === target.generationId) - Number(a.generation_id === target.generationId) || a.sort - b.sort || a.id.localeCompare(b.id))
    .slice(0, 4);
  const specs = parseJson<Record<string, SpecValue>>(modelRow.specs);
  const comparison = specs ? buildComparison({ slug: target.slug, name, specs, releasedOn: modelRow.released_on ?? null, artKey: modelRow.art_key ?? null, sort: target.sort }, siblings.map(comparable), locale) : null;

  // ── help: guides and diagnosis trees
  const articles: HubArticle[] = rowsOf<ArticleRow>(articlesResult).map((row) => ({
    slug: row.slug,
    kind: row.kind,
    title: text(l10n(row.title), locale),
    summary: text(l10n(row.summary), locale) || null,
    scope: row.device_model_id === target.id ? "device" : row.device_model_id === null ? "platform" : "sibling",
    writtenFor: row.device_model_id !== null && row.device_model_id !== target.id ? pick(l10n(row.model_name), locale) || null : null,
  }));
  const trees: HubTree[] = rowsOf<TreeRow>(treesResult).map((row) => ({
    symptomKey: row.symptom_key,
    title: text(l10n(row.title), locale),
    scope: row.device_model_id ? "device" : row.platform_id ? "platform" : "all",
  }));

  // ── facts lists
  const listOf = (values: unknown): string[] => (Array.isArray(values) ? values.map((value) => text(value, locale)).filter((value) => value !== "") : []);
  const inTheBox = listOf(mainAttributes.inTheBox);
  const highlights = listOf(mainAttributes.highlights);
  const sources: HubSource[] = (Array.isArray(mainAttributes.sources) ? mainAttributes.sources : [])
    .filter((source) => typeof source?.url === "string" && /^https:\/\//.test(source.url))
    .slice(0, 12)
    .map((source) => ({ url: source.url as string, title: typeof source.title === "string" ? source.title : null, publisher: typeof source.publisher === "string" ? source.publisher : null }));
  const warrantyMonths = [...new Set(editionProducts.map((row) => row.warranty_months).filter((months): months is number => typeof months === "number" && months > 0))].sort((a, b) => a - b);

  const counts = { games: countOf(games), accessories: countOf(accessories) };
  const media = rowsOf<MediaRow>(mediaResult);
  const images: ImageRef[] = media.map((row) => ({ artKey: row.art_key, mediaKey: null, alt: text(l10n(row.alt), locale) || name, isIllustration: false }));
  if (images.length === 0 && modelRow.art_key) images.push({ artKey: modelRow.art_key, mediaKey: null, alt: name, isIllustration: false });

  return {
    model: {
      id: target.id,
      slug: target.slug,
      name,
      summary: text(l10n(modelRow.summary), locale) || null,
      platform: { slug: modelRow.platform_slug, name: pick(l10n(modelRow.platform_name), locale) || modelRow.platform_slug, accent: modelRow.accent },
      generation: modelRow.generation_slug ? { slug: modelRow.generation_slug, name: pick(l10n(modelRow.generation_name), locale) || modelRow.generation_slug } : null,
      releasedOn: modelRow.released_on ?? null,
      deviceKind: modelRow.device_kind,
      sort: target.sort,
      images,
    },
    editions,
    versions,
    notes,
    highlights,
    inTheBox,
    specs: groupSpecs(specs, locale),
    games,
    accessories,
    parts,
    counts,
    comparison,
    articles,
    trees,
    faq: buildFaq({ deviceName: name, specs, games: counts.games, inTheBox }, locale),
    used,
    warrantyMonths,
    sources,
    mainProductSlug: mainProduct?.slug ?? null,
  };
}
