/**
 * Recommendations — explainable, privacy-conscious shelves and the consented signals behind them
 * (brief §6, docs/CONTRACTS.md §3 "devices").
 *
 *   const who = await personalizationFor(db, { cookie: ctx.cookie, customerId: customer?.customer.id ?? null });
 *   const shelves = await getRecommendations(db, { locale: ctx.locale, context: "product", productId, ...who }, 8);
 *   shelves.map((shelf) => <ShelfRail key={shelf.key} shelf={shelf} />)            // each shelf says why it is there
 *
 *   await recordEvent(db, who, { kind: "view", productId, source: "pdp" }, ctx.now);   // a no-op without consent
 *
 * THE RULES EVERY SHELF FOLLOWS
 *   1. Hard compatibility filter. Whenever a context has devices — the hub's device, the device a product IS, the
 *      devices a product is VERIFIED on, the consoles in a cart, the devices a consenting shopper looked at — every
 *      recommended accessory or game must be VERIFIED on one of them (compatibility.server.ts: model › generation ›
 *      platform, variant › product; a product whose versions disagree is not verified). Partial, unverified and
 *      incompatible products never go on a shelf that implies they fit. A console may appear only as one of those
 *      devices (the console a game runs on) or on the "alternatives" shelf, which claims nothing.
 *   2. Stock-aware: out-of-stock cards are dropped; pre-orders come after what can be bought now.
 *   3. De-duplicated: a product appears once across the shelves of one answer, never the product being viewed, never
 *      what is already in the cart.
 *   4. Diverse: accessory shelves take turns between kinds (controller, headset, storage, …), the store's picks between
 *      platforms and kinds.
 *   5. Admin controls (`recommendation_rules`, active and inside their dates): `exclude` removes a product from every
 *      matching shelf, `pin` puts it first (it still has to pass rules 1 and 2), `boost` adds its weight to the score.
 *      A rule's context ({ placement, productId, platformId, deviceModelId, categoryId }) must match in full;
 *      `placement` is a context name ("product") or a context and a shelf ("product:related").
 *   6. Honest reasons: each shelf's `reason` says what it is built from — "verified to work with Switch 2", "store
 *      picks", "based on what you looked at, with your permission". "Customers also bought" exists only from real
 *      orders (not demo, not cancelled or returned), at least MIN_CO_PURCHASE_ORDERS of them per product, and says so.
 *   7. Cold start: without consent or signals, the store's picks (pins, then the newest in-stock products of the
 *      shopper's chosen platforms) — and the reason says the shelf does not use their browsing. A device context with
 *      nothing verified falls back to the newest consoles of the device's platform (alternatives, not add-ons).
 *
 * SIGNALS (`recommendation_events`): view, click, add — and purchase, which only server code may record (the public
 * endpoint refuses it, so nobody can forge "bought together" data). Recorded ONLY with personalization consent: a
 * signed-in customer's latest `consents` answer, else the device's `tt_consent` cookie (set by the home area's
 * onboarding and the account area). A guest's events are keyed by the SHA-256 of a random first-party cookie
 * (`tt_rs`, set on the first consented event); a customer's by their id — never both, no IP, no user agent, no
 * fingerprint, no cross-device stitching. Events older than RECOMMENDATION_EVENT_RETENTION_DAYS are ignored and
 * deleted by purgeRecommendationEvents() (the daily retention job, app/server/jobs.server.ts, since 2026-11-11);
 * forgetEvents() deletes a shopper's events at once (privacy control: the home panel's "stop", the account settings,
 * POST /api/events intent=forget).
 *
 * FOR PAGES (the integration pass): `recommendationsFor(db, { cookie, customerId }, { locale, context, … })` is what a
 * loader streams (not awaited) to the shared <RecommendationShelves> (routes/storefront/devices/components); it never
 * rejects. `recordPurchaseSignals` is called by the checkout's own server file after a new order — never by the
 * commerce core. `orderItemsOf` / `usedUnitVariantIds` give the cart and order pages their anchors.
 *
 * Services take `db` first and never import "cloudflare:workers". Invalid input → AppError("invalid", 400).
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { serverT } from "~/i18n/i18n.server";
import type { ProductCardData, Shelf } from "~/lib/dto";
import { newId, sha256Hex } from "~/lib/ids";
import { LOCALE_CODES, pick, type L10n, type Locale } from "~/lib/locales";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { invalid, zodFieldErrors } from "~/server/errors";
import { getCardsByIds, getNewArrivals, MAX_CARD_IDS } from "~/server/services/catalog/cards.server";
import {
  compatibilityStatements,
  compatibilityStatementsByIds,
  DEVICE_TARGETS_SQL,
  productRulesStatements,
  readCompatibility,
  readProductsCompatibility,
  targetsOf,
  type DeviceTarget,
  type ModelCompatibility,
} from "./compatibility.server";

// ───────────────────────────────────────────────────────────────── constants

export const RECOMMENDATION_CONTEXTS = ["home", "product", "cart", "post_purchase", "device_hub", "search"] as const;
export type RecommendationContextName = (typeof RECOMMENDATION_CONTEXTS)[number];

/** Most items one shelf returns. */
export const MAX_SHELF_ITEMS = 24;
/** Signals older than this are ignored, and deleted by purgeRecommendationEvents(). */
export const RECOMMENDATION_EVENT_RETENTION_DAYS = 90;
/** "Customers also bought" needs at least this many real orders containing both products. */
export const MIN_CO_PURCHASE_ORDERS = 5;
/** The first-party cookie that keys a consenting guest's signals (only its SHA-256 is stored). */
export const REC_SESSION_COOKIE = "tt_rs";
export const REC_SESSION_MAX_AGE_SEC = RECOMMENDATION_EVENT_RETENTION_DAYS * 24 * 60 * 60;
/** The cookie the home and account areas set with the device's personalization answer ("1" / "0"). */
export const CONSENT_COOKIE = "tt_consent";

export const RECOMMENDATION_EVENT_KINDS = ["view", "click", "add", "purchase"] as const;
export type RecommendationEventKind = (typeof RECOMMENDATION_EVENT_KINDS)[number];
/** What the public endpoint (POST /api/events) accepts; purchases are recorded by server code only. */
export const PUBLIC_EVENT_KINDS = ["view", "click", "add"] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = RECOMMENDATION_EVENT_RETENTION_DAYS * DAY_MS;
/** The same signal for the same product from the same shopper inside this window is stored once. */
const DEDUPE_MS: Record<RecommendationEventKind, number> = { view: 30 * 60_000, click: 30 * 60_000, add: 10_000, purchase: 60_000 };
/** Devices a shelf of "complete your setup" is built for, at most (more would be more shelves than a page shows). */
const MAX_SETUP_DEVICES = 2;
/** Kinds that are add-ons to a device. */
const ADDON_KINDS: ReadonlySet<string> = new Set(["controller", "headset", "storage", "accessory", "digital", "part", "bundle"]);

// ───────────────────────────────────────────────────────────────── input

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;
const id = z.string().regex(ID, "invalid");

const RecommendationInputSchema = z.object({
  locale: z.enum(LOCALE_CODES as [Locale, ...Locale[]]),
  context: z.enum(RECOMMENDATION_CONTEXTS),
  productId: id.nullish(),
  deviceModelId: id.nullish(),
  cartVariantIds: z.array(id).max(50, "too_big").optional(),
  platformSlugs: z.array(z.string().max(40, "invalid").regex(SLUG, "invalid")).max(8, "too_big").optional(),
  sessionHash: z.string().regex(/^[0-9a-f]{64}$/, "invalid").nullish(),
  customerId: id.nullish(),
  consent: z.boolean(),
  /** Request time (ctx.now); default Date.now(). */
  now: z.number().int().min(0).optional(),
});

export type RecommendationInput = z.input<typeof RecommendationInputSchema>;

function parseInput(raw: unknown): z.output<typeof RecommendationInputSchema> {
  const result = RecommendationInputSchema.safeParse(raw ?? {});
  if (!result.success) throw invalid(zodFieldErrors(result.error), "recommendations.getRecommendations");
  return result.data;
}

// ───────────────────────────────────────────────────────────────── reads

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];
const jsonIds = (ids: readonly string[]) => sql`(SELECT value FROM json_each(${JSON.stringify([...new Set(ids)])}))`;
const fsi = (text: string) => `⁨${text}⁩`;

function parseJson<T>(text: unknown): T | null {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** Named statements for one db.batch; results come back by name (null when a name was not added). */
function reads(db: Db) {
  const statements: BatchStatement[] = [];
  const names = new Map<string, number>();
  return {
    sql(name: string, query: SQL) {
      names.set(name, statements.push(batchSql(db, query)) - 1);
    },
    statement(name: string, statement: BatchStatement) {
      names.set(name, statements.push(statement) - 1);
    },
    async run(): Promise<(name: string) => unknown> {
      const results = await runBatch(db, statements);
      return (name: string) => {
        const index = names.get(name);
        return index === undefined ? null : results[index];
      };
    },
  };
}

type RuleRow = { id: string; kind: string; context: string | null; product_id: string; weight: number };
type AdminRule = { kind: "pin" | "exclude" | "boost"; productId: string; weight: number; context: { placement?: string; productId?: string; platformId?: string; deviceModelId?: string; categoryId?: string } };
type RelationRow = { product_id: string; related_product_id: string; kind: string; pinned: number; sort: number; related_kind: string; related_device_model_id: string | null };
type PlatformRow = { id: string; slug: string; name: string };
type EventRow = { product_id: string; kind: string; last_at: number; n: number };
type TogetherRow = { product_id: string; orders: number; kind: string; device_model_id: string | null };

const RULES_SQL = (now: number) => sql`SELECT r.id, r.kind, r.context, r.product_id, r.weight
FROM recommendation_rules AS r JOIN products AS p ON p.id = r.product_id
WHERE r.is_active = 1 AND (r.starts_at IS NULL OR r.starts_at <= ${now}) AND (r.ends_at IS NULL OR r.ends_at > ${now}) AND p.status = 'published'
ORDER BY r.weight DESC, r.id`;

/** The store's links from some products to published products, with what the related product is. */
const RELATIONS_SQL = (productIds: SQL) => sql`SELECT r.product_id, r.related_product_id, r.kind, r.pinned, r.sort, p.kind AS related_kind, p.device_model_id AS related_device_model_id
FROM product_relations AS r JOIN products AS p ON p.id = r.related_product_id
WHERE p.status = 'published' AND r.product_id IN ${productIds}
ORDER BY r.pinned DESC, r.sort, r.related_product_id`;

const PLATFORMS_SQL = sql`SELECT id, slug, name FROM platforms WHERE is_active = 1 ORDER BY sort, id`;

function toAdminRules(rows: readonly RuleRow[]): AdminRule[] {
  return rows
    .filter((row) => row.kind === "pin" || row.kind === "exclude" || row.kind === "boost")
    .map((row) => ({ kind: row.kind as AdminRule["kind"], productId: row.product_id, weight: Number(row.weight) || 0, context: parseJson<AdminRule["context"]>(row.context) ?? {} }));
}

// ───────────────────────────────────────────────────────────────── plans → shelves

/** Where a shelf is shown — what admin rules are matched against. */
type ShelfPlace = { context: RecommendationContextName; shelf: string; productId: string | null; categoryId: string | null; platformIds: ReadonlySet<string>; deviceModelId: string | null };

function ruleMatches(rule: AdminRule, place: ShelfPlace): boolean {
  const c = rule.context;
  if (c.placement && c.placement !== place.context && c.placement !== `${place.context}:${place.shelf}`) return false;
  if (c.productId && c.productId !== place.productId) return false;
  if (c.platformId && !place.platformIds.has(c.platformId)) return false;
  if (c.deviceModelId && c.deviceModelId !== place.deviceModelId) return false;
  if (c.categoryId && c.categoryId !== place.categoryId) return false;
  return true;
}

type Plan = {
  key: string;
  title: string;
  reason: string | null;
  place: ShelfPlace;
  /** Candidates and their scores (higher first). */
  scores: Map<string, number>;
  /** The hard filter: may this product be on this shelf at all (also for pins)? */
  accepts: (productId: string) => boolean;
  /** Take turns between these groups (kind, platform…); null keeps the score order. */
  diversity: ((card: ProductCardData) => string) | null;
};

function addScore(scores: Map<string, number>, productId: string, score: number): void {
  scores.set(productId, Math.max(scores.get(productId) ?? Number.NEGATIVE_INFINITY, score));
}

const STOCK_RANK: Record<ProductCardData["stock"], number> = { in_stock: 0, low_stock: 0, preorder: 1, out_of_stock: 2 };

/** Round robin over groups, each in its own order; groups are visited in the order of their best item. */
export function takeTurns<T>(items: readonly T[], groupOf: (item: T) => string): T[] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = groupOf(item);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }
  const queues = [...groups.values()];
  const out: T[] = [];
  for (let round = 0; out.length < items.length; round++) for (const queue of queues) if (round < queue.length) out.push(queue[round]);
  return out;
}

/** Rules 2–5 of the file header for one plan; null when nothing is left. Marks what it shows in `taken`. */
function finishPlan(plan: Plan, cards: ReadonlyMap<string, ProductCardData>, rules: readonly AdminRule[], taken: Set<string>, size: number): Shelf<ProductCardData> | null {
  const applicable = rules.filter((rule) => ruleMatches(rule, plan.place));
  const excluded = new Set(applicable.filter((rule) => rule.kind === "exclude").map((rule) => rule.productId));
  const boosts = new Map<string, number>();
  for (const rule of applicable) if (rule.kind === "boost") boosts.set(rule.productId, (boosts.get(rule.productId) ?? 0) + rule.weight);

  const usable = (productId: string): ProductCardData | null => {
    if (taken.has(productId) || excluded.has(productId) || !plan.accepts(productId)) return null;
    const card = cards.get(productId);
    return card && card.stock !== "out_of_stock" ? card : null;
  };
  const pinned: ProductCardData[] = [];
  for (const rule of applicable) {
    if (rule.kind !== "pin") continue;
    const card = usable(rule.productId);
    if (card && !pinned.includes(card)) pinned.push(card);
  }
  const scored = [...plan.scores.entries()]
    .map(([productId, score]) => ({ card: usable(productId), score: score + (boosts.get(productId) ?? 0) }))
    .filter((entry): entry is { card: ProductCardData; score: number } => entry.card !== null && !pinned.includes(entry.card))
    .sort((a, b) => STOCK_RANK[a.card.stock] - STOCK_RANK[b.card.stock] || b.score - a.score || a.card.id.localeCompare(b.card.id))
    .map((entry) => entry.card);
  const ordered = plan.diversity ? takeTurns(scored, plan.diversity) : scored;
  const items = [...pinned, ...ordered].slice(0, size);
  if (items.length === 0) return null;
  for (const card of items) taken.add(card.id);
  return { key: plan.key, title: plan.title, reason: plan.reason, items };
}

type Fallback = () => Promise<{ plan: Plan; cards: ProductCardData[] }>;

/**
 * Loads the cards of every candidate (≤ 100 per read), then finishes the plans in order — de-duplicating across them.
 * Only when none of them found anything honest to show is the fallback built (one more read) and finished.
 */
async function finish(db: Db, locale: Locale, now: number, plans: readonly Plan[], rules: readonly AdminRule[], hidden: ReadonlySet<string>, size: number, known: readonly ProductCardData[], fallback?: Fallback): Promise<Shelf<ProductCardData>[]> {
  const cards = new Map(known.map((card) => [card.id, card]));
  const load = async (list: readonly Plan[]) => {
    const wanted = new Set<string>();
    for (const plan of list) {
      const pins = rules.filter((rule) => rule.kind === "pin" && ruleMatches(rule, plan.place)).map((rule) => rule.productId);
      const best = [...plan.scores.entries()].sort((a, b) => b[1] - a[1]).map(([productId]) => productId);
      for (const productId of [...pins, ...best.slice(0, size * 3)]) if (!cards.has(productId) && !hidden.has(productId) && plan.accepts(productId)) wanted.add(productId);
    }
    const ids = [...wanted];
    for (let i = 0; i < ids.length; i += MAX_CARD_IDS) for (const card of await getCardsByIds(db, locale, ids.slice(i, i + MAX_CARD_IDS), { now })) cards.set(card.id, card);
  };
  await load(plans);
  const taken = new Set(hidden);
  const shelves = plans.map((plan) => finishPlan(plan, cards, rules, taken, size)).filter((shelf): shelf is Shelf<ProductCardData> => shelf !== null);
  if (shelves.length > 0 || !fallback) return shelves;
  const extra = await fallback();
  for (const card of extra.cards) cards.set(card.id, card);
  await load([extra.plan]);
  const last = finishPlan(extra.plan, cards, rules, taken, size);
  return last ? [last] : [];
}

// ───────────────────────────────────────────────────────────────── shelf kinds

type Engine = {
  db: Db;
  locale: Locale;
  now: number;
  size: number;
  t: ReturnType<typeof serverT>;
  targetById: Map<string, DeviceTarget>;
  platforms: PlatformRow[];
};

const deviceName = (engine: Engine, model: DeviceTarget) => fsi(pick(model.name, engine.locale) || model.slug);

/** The four storefront platforms use the design system's names ("Nintendo", "أجهزة محمولة" — ui:platform.*), others their own. */
const UI_PLATFORMS: ReadonlySet<string> = new Set(["nintendo", "playstation", "xbox", "handheld"]);
const platformName = (engine: Engine, platform: { slug: string; name: string } | undefined, fallbackSlug: string) =>
  fsi(UI_PLATFORMS.has(platform?.slug ?? fallbackSlug) ? serverT(engine.locale, "ui")(`platform.${platform?.slug ?? fallbackSlug}`) : pick(parseJson<L10n>(platform?.name) ?? { ar: fallbackSlug }, engine.locale));

/** Products verified on at least one of the models (the hard filter of rule 1). */
function verifiedSet(compat: ModelCompatibility, models: readonly DeviceTarget[]): Set<string> {
  const out = new Set<string>();
  for (const model of models) for (const [productId, resolution] of compat.byModel.get(model.id) ?? []) if (resolution.status === "verified") out.add(productId);
  return out;
}

const RELATION_SCORE: Record<string, number> = { setup: 40, accessory: 30, upsell: 20, upgrade: 10 };

/** "Complete your setup" for one device: verified add-ons, the device's own editorial links first, kinds taking turns. */
function setupPlan(engine: Engine, at: { context: RecommendationContextName; title: string; place: ShelfPlace }, model: DeviceTarget, compat: ModelCompatibility, relations: readonly RelationRow[], own: ReadonlySet<string>): Plan {
  const verified = verifiedSet(compat, [model]);
  const isAddon = (productId: string) => ADDON_KINDS.has(compat.products.get(productId)?.kind ?? "");
  const scores = new Map<string, number>();
  for (const relation of relations) {
    if (!own.has(relation.product_id)) continue;
    const score = (RELATION_SCORE[relation.kind] ?? 0) + (relation.pinned === 1 ? 15 : 0) - Math.min(Number(relation.sort) || 0, 9);
    if (score > 0) addScore(scores, relation.related_product_id, score);
  }
  for (const productId of verified) if (isAddon(productId)) addScore(scores, productId, 1);
  return {
    key: `${at.context}:setup:${model.slug}`,
    title: at.title,
    reason: engine.t("rec.setup.reason", { device: deviceName(engine, model) }),
    place: at.place,
    scores,
    accepts: (productId) => verified.has(productId) && isAddon(productId) && !own.has(productId),
    diversity: (card) => card.kind,
  };
}

/** The store's picks: pins first, then the newest in-stock products (of the chosen platforms); platforms and kinds take turns. */
async function picksPlan(engine: Engine, context: RecommendationContextName, platformSlugs: readonly string[], consent: boolean): Promise<{ plan: Plan; cards: ProductCardData[] }> {
  const chosen = engine.platforms.filter((platform) => platformSlugs.includes(platform.slug));
  const cards = await getNewArrivals(engine.db, engine.locale, { platform: chosen.length > 0 ? chosen.map((platform) => platform.slug) : undefined, limit: Math.min(60, engine.size * 3), now: engine.now });
  const scores = new Map<string, number>();
  cards.forEach((card, index) => addScore(scores, card.id, cards.length - index));
  const names = chosen.map((platform) => platformName(engine, platform, platform.slug));
  const reason =
    names.length > 0 ? engine.t("rec.picks.reasonPlatforms", { platforms: names.join(engine.locale === "en" ? ", " : "، ") }) : consent ? engine.t("rec.picks.reason") : engine.t("rec.picks.reasonPrivate");
  return {
    cards,
    plan: {
      key: `${context}:picks`,
      title: engine.t("rec.picks.title"),
      reason,
      place: { context, shelf: "picks", productId: null, categoryId: null, platformIds: new Set(chosen.map((platform) => platform.id)), deviceModelId: null },
      scores,
      accepts: () => true,
      diversity: (card) => `${card.platformSlug ?? "-"}:${card.kind}`,
    },
  };
}

/** New consoles of a device's platform — the cold start of a device context (alternatives, not add-ons). */
async function newForPlan(engine: Engine, context: RecommendationContextName, model: DeviceTarget, exclude: ReadonlySet<string>): Promise<{ plan: Plan; cards: ProductCardData[] }> {
  const cards = (await getNewArrivals(engine.db, engine.locale, { platform: model.platformSlug, limit: 30, now: engine.now })).filter((card) => card.kind === "console" && !exclude.has(card.id));
  const scores = new Map<string, number>();
  cards.forEach((card, index) => addScore(scores, card.id, cards.length - index));
  const platform = engine.platforms.find((row) => row.id === model.platformId);
  return {
    cards,
    plan: {
      key: `${context}:new:${model.slug}`,
      title: engine.t("rec.newFor.title", { platform: platformName(engine, platform, model.platformSlug) }),
      reason: engine.t("rec.newFor.reason"),
      place: { context, shelf: "new", productId: null, categoryId: null, platformIds: new Set([model.platformId]), deviceModelId: model.id },
      scores,
      accepts: (productId) => !exclude.has(productId),
      diversity: null,
    },
  };
}

/** Devices sorted by weight (only published models on active platforms), at most `max`. */
function rankDevices(engine: Engine, weights: ReadonlyMap<string, number>, max: number): DeviceTarget[] {
  return [...weights.entries()]
    .map(([modelId, weight]) => ({ model: engine.targetById.get(modelId), weight }))
    .filter((entry): entry is { model: DeviceTarget; weight: number } => entry.model !== undefined && entry.model.platformActive)
    .sort((a, b) => b.weight - a.weight || a.model.platformSort - b.model.platformSort || a.model.sort - b.model.sort)
    .slice(0, max)
    .map((entry) => entry.model);
}

async function compatibilityForAnchors(db: Db, anchors: readonly DeviceTarget[]): Promise<ModelCompatibility> {
  const [rulesResult, variantsResult] = await runBatch(db, compatibilityStatements(db, anchors));
  return readCompatibility(anchors, rulesResult, variantsResult);
}

// ───────────────────────────────────────────────────────────────── the engine

/**
 * Shelves for one place in the store, each with an honest `reason` (rules in the file header). `limit` is the most
 * items per shelf (1–MAX_SHELF_ITEMS). An empty array means there is nothing honest to recommend there.
 */
export async function getRecommendations(db: Db, raw: RecommendationInput, limit = 8): Promise<Shelf<ProductCardData>[]> {
  const input = parseInput(raw);
  const size = Math.min(Math.max(Math.trunc(limit) || 8, 1), MAX_SHELF_ITEMS);
  const now = input.now ?? Date.now();
  const personal = input.consent && (input.customerId != null || input.sessionHash != null);
  const cartVariantIds = input.cartVariantIds ?? [];
  const productContext = input.context === "product" || input.context === "cart" || input.context === "post_purchase";
  const anchorProductId = input.context === "product" ? (input.productId ?? null) : null;
  const deviceId = input.context === "device_hub" ? (input.deviceModelId ?? null) : null;

  // ── round trip 1: devices, platforms, admin rules, and what the context names
  const first = reads(db);
  first.sql("targets", DEVICE_TARGETS_SQL);
  first.sql("platforms", PLATFORMS_SQL);
  first.sql("rules", RULES_SQL(now));
  if (deviceId) {
    const [rules, variants] = compatibilityStatementsByIds(db, [deviceId]);
    first.statement("deviceRules", rules);
    first.statement("deviceVariants", variants);
    first.sql("deviceOwn", sql`SELECT id FROM products WHERE status = 'published' AND device_model_id = ${deviceId}`);
    first.sql("relations", RELATIONS_SQL(sql`(SELECT id FROM products WHERE status = 'published' AND device_model_id = ${deviceId})`));
  }
  const productIdsSql = anchorProductId ? jsonIds([anchorProductId]) : sql`(SELECT product_id FROM variants WHERE id IN (SELECT value FROM json_each(${JSON.stringify(cartVariantIds)})))`;
  if (productContext && (anchorProductId || cartVariantIds.length > 0)) {
    const [rules, variants] = productRulesStatements(db, anchorProductId ? { productIds: [anchorProductId] } : { variantIds: cartVariantIds });
    first.statement("anchorRules", rules);
    first.statement("anchorVariants", variants);
    first.sql("relations", RELATIONS_SQL(productIdsSql));
  }
  if (anchorProductId) {
    first.sql(
      "together",
      sql`SELECT v2.product_id AS product_id, COUNT(DISTINCT o.id) AS orders, p2.kind, p2.device_model_id
FROM order_items AS oi1
JOIN variants AS v1 ON v1.id = oi1.variant_id
JOIN orders AS o ON o.id = oi1.order_id
JOIN order_items AS oi2 ON oi2.order_id = o.id AND oi2.id <> oi1.id
JOIN variants AS v2 ON v2.id = oi2.variant_id
JOIN products AS p2 ON p2.id = v2.product_id
WHERE v1.product_id = ${anchorProductId} AND v2.product_id <> ${anchorProductId} AND o.is_demo = 0 AND o.status NOT IN ('cancelled', 'returned') AND p2.status = 'published'
GROUP BY v2.product_id
HAVING COUNT(DISTINCT o.id) >= ${MIN_CO_PURCHASE_ORDERS}
ORDER BY orders DESC, v2.product_id
LIMIT ${MAX_SHELF_ITEMS}`,
    );
  }
  if (personal && (input.context === "home" || input.context === "search")) {
    const subject = input.customerId ? sql`e.customer_id = ${input.customerId}` : sql`e.session_hash = ${input.sessionHash ?? ""} AND e.customer_id IS NULL`;
    first.sql(
      "events",
      sql`SELECT e.product_id, e.kind, MAX(e.at) AS last_at, COUNT(*) AS n
FROM recommendation_events AS e JOIN products AS p ON p.id = e.product_id
WHERE ${subject} AND e.at >= ${now - RETENTION_MS} AND p.status = 'published'
GROUP BY e.product_id, e.kind
ORDER BY last_at DESC
LIMIT 60`,
    );
    if (input.customerId) first.sql("saved", sql`SELECT device_model_id FROM saved_devices WHERE customer_id = ${input.customerId}`);
  }
  const got = await first.run();

  const targets = targetsOf(got("targets"));
  const engine: Engine = { db, locale: input.locale, now, size, t: serverT(input.locale, "devices"), targetById: new Map(targets.map((model) => [model.id, model])), platforms: rowsOf<PlatformRow>(got("platforms")) };
  const adminRules = toAdminRules(rowsOf<RuleRow>(got("rules")));
  const relations = rowsOf<RelationRow>(got("relations"));

  // ── the device hub: complete the setup of its device
  if (input.context === "device_hub") {
    const model = deviceId ? engine.targetById.get(deviceId) : undefined;
    if (!model || !model.platformActive) return [];
    const compat = readCompatibility([model], got("deviceRules"), got("deviceVariants"));
    const own = new Set(rowsOf<{ id: string }>(got("deviceOwn")).map((row) => row.id));
    const place: ShelfPlace = { context: "device_hub", shelf: "setup", productId: null, categoryId: null, platformIds: new Set([model.platformId]), deviceModelId: model.id };
    const setup = setupPlan(engine, { context: "device_hub", title: engine.t("rec.setup.title", { device: deviceName(engine, model) }), place }, model, compat, relations, own);
    return finish(db, input.locale, now, [setup], adminRules, own, size, [], () => newForPlan(engine, "device_hub", model, own));
  }

  // ── a product, a cart, an order
  if (productContext) {
    const anchor = readProductsCompatibility(targets, got("anchorRules"), got("anchorVariants"));
    const anchorProducts = [...anchor.products.values()];
    if (anchorProducts.length === 0) return [];
    const hidden = new Set(anchorProducts.map((product) => product.id));

    // The devices: the ones the products ARE; else every device a product is verified on (for the hard filter).
    const deviceProducts = new Map<string, Set<string>>();
    for (const product of anchorProducts) if (product.deviceModelId) deviceProducts.set(product.deviceModelId, new Set([...(deviceProducts.get(product.deviceModelId) ?? []), product.id]));
    const verifiedOn = new Map<string, number>();
    for (const product of anchorProducts) for (const [modelId, resolution] of anchor.byProduct.get(product.id) ?? []) if (resolution.status === "verified") verifiedOn.set(modelId, (verifiedOn.get(modelId) ?? 0) + 1);
    const setupDevices = rankDevices(engine, new Map([...deviceProducts.keys()].map((modelId) => [modelId, deviceProducts.get(modelId)?.size ?? 1])), MAX_SETUP_DEVICES);
    const anchors = deviceProducts.size > 0 ? rankDevices(engine, new Map([...deviceProducts.keys()].map((modelId) => [modelId, 1])), targets.length) : rankDevices(engine, verifiedOn, targets.length);
    const anchorIds = new Set(anchors.map((model) => model.id));
    const compat = anchors.length > 0 ? await compatibilityForAnchors(db, anchors) : null;
    const verified = compat ? verifiedSet(compat, anchors) : new Set<string>();
    const claim = anchors.length === 1 ? anchors[0] : null;
    const first = anchorProducts[0];
    const place = (shelf: string, deviceModelId: string | null): ShelfPlace => ({
      context: input.context,
      shelf,
      productId: anchorProductId,
      categoryId: input.context === "product" ? first.categoryId : null,
      platformIds: new Set([...anchorProducts.map((product) => product.platformId).filter((platformId): platformId is string => platformId !== null), ...anchors.map((model) => model.platformId)]),
      deviceModelId,
    });
    /**
     * Rule 1: with devices, an add-on or a game must be verified on one of them; a console only as one of those
     * devices (the console a game runs on). A device that is also an add-on (PS VR2, PlayStation Portal) is an add-on.
     */
    const fits = (productId: string, kind: string | undefined, deviceModelId: string | null) => {
      if (anchors.length === 0) return true; // nothing to be compatible with: an editorial shelf that claims nothing
      if (kind === "console") return deviceModelId !== null && anchorIds.has(deviceModelId);
      return verified.has(productId);
    };

    const plans: Plan[] = [];
    // 1. complete the setup of each device that is the product / is in the cart / was bought
    for (const model of setupDevices) {
      if (!compat) break;
      const titleKey = input.context === "cart" ? "rec.cart.title" : input.context === "post_purchase" ? "rec.purchase.title" : "rec.setup.title";
      plans.push(setupPlan(engine, { context: input.context, title: engine.t(titleKey, { device: deviceName(engine, model) }), place: place("setup", model.id) }, model, compat, relations, deviceProducts.get(model.id) ?? new Set()));
    }
    // 2. the store's own links for the product(s)
    const relatedScores = new Map<string, number>();
    const alternativeScores = new Map<string, number>();
    const relatedFacts = new Map<string, { kind: string; deviceModelId: string | null }>();
    for (const relation of relations) {
      relatedFacts.set(relation.related_product_id, { kind: relation.related_kind, deviceModelId: relation.related_device_model_id ?? null });
      const score = 100 - Math.min(Number(relation.sort) || 0, 50) + (relation.pinned === 1 ? 50 : 0);
      addScore(relation.kind === "alternative" ? alternativeScores : relatedScores, relation.related_product_id, score);
    }
    plans.push({
      key: `${input.context}:related`,
      title: engine.t(input.context === "product" ? "rec.related.title" : "rec.related.cartTitle"),
      reason: claim ? engine.t("rec.related.reasonDevice", { device: deviceName(engine, claim) }) : engine.t("rec.related.reason"),
      place: place("related", claim?.id ?? null),
      scores: relatedScores,
      accepts: (productId) => fits(productId, relatedFacts.get(productId)?.kind, relatedFacts.get(productId)?.deviceModelId ?? null),
      diversity: null,
    });
    if (input.context === "product") {
      // 3. customers also bought — real orders only, past the threshold
      const together = rowsOf<TogetherRow>(got("together"));
      if (together.length > 0) {
        const facts = new Map(together.map((row) => [row.product_id, row]));
        plans.push({
          key: "product:together",
          title: engine.t("rec.together.title"),
          reason: engine.t("rec.together.reason", { count: MIN_CO_PURCHASE_ORDERS, n: MIN_CO_PURCHASE_ORDERS }),
          place: place("together", claim?.id ?? null),
          scores: new Map(together.map((row) => [row.product_id, Number(row.orders) || 0])),
          accepts: (productId) => fits(productId, facts.get(productId)?.kind, facts.get(productId)?.device_model_id ?? null),
          diversity: null,
        });
      }
      // 4. alternatives the store links (similar products, not add-ons: no compatibility claim)
      plans.push({
        key: "product:alternatives",
        title: engine.t("rec.alternatives.title"),
        reason: engine.t("rec.alternatives.reason"),
        place: place("alternatives", null),
        scores: alternativeScores,
        accepts: () => true,
        diversity: null,
      });
    }
    // cold start of a device context: the newest consoles of its platform
    const device = setupDevices[0];
    return finish(db, input.locale, now, plans, adminRules, hidden, size, [], device ? () => newForPlan(engine, input.context, device, deviceProducts.get(device.id) ?? new Set()) : undefined);
  }

  // ── home and search: the shopper's own (consented) signals, then the store's picks
  const plans: Plan[] = [];
  const hidden = new Set<string>();
  if (personal) {
    const events = rowsOf<EventRow>(got("events"));
    const KIND_WEIGHT: Record<string, number> = { purchase: 4, add: 3, click: 1, view: 1 };
    const interest = new Map<string, number>();
    events.forEach((event, index) => interest.set(event.product_id, (interest.get(event.product_id) ?? 0) + (KIND_WEIGHT[event.kind] ?? 1) * Math.max(1, 6 - Math.floor(index / 10))));
    const saved = rowsOf<{ device_model_id: string }>(got("saved")).map((row) => row.device_model_id);
    if (interest.size > 0 || saved.length > 0) {
      const interestIds = [...interest.keys()].slice(0, 24);
      const second = reads(db);
      const [rules, variants] = productRulesStatements(db, { productIds: interestIds });
      second.statement("rules", rules);
      second.statement("variants", variants);
      second.sql("relations", RELATIONS_SQL(jsonIds(interestIds)));
      const got2 = await second.run();
      const anchor = readProductsCompatibility(targets, got2("rules"), got2("variants"));
      const weights = new Map<string, number>();
      for (const modelId of saved) weights.set(modelId, (weights.get(modelId) ?? 0) + 8);
      for (const product of anchor.products.values()) {
        const weight = interest.get(product.id) ?? 1;
        if (product.deviceModelId) weights.set(product.deviceModelId, (weights.get(product.deviceModelId) ?? 0) + weight * 3);
        else for (const [modelId, resolution] of anchor.byProduct.get(product.id) ?? []) if (resolution.status === "verified") weights.set(modelId, (weights.get(modelId) ?? 0) + weight);
      }
      const anchors = rankDevices(engine, weights, MAX_SETUP_DEVICES);
      if (anchors.length > 0) {
        const compat = await compatibilityForAnchors(db, anchors);
        const verified = verifiedSet(compat, anchors);
        const isFit = (productId: string) => verified.has(productId) && compat.products.get(productId)?.kind !== "console";
        const scores = new Map<string, number>();
        for (const relation of rowsOf<RelationRow>(got2("relations"))) addScore(scores, relation.related_product_id, 20 + (interest.get(relation.product_id) ?? 0) - Math.min(Number(relation.sort) || 0, 9));
        for (const productId of verified) addScore(scores, productId, ADDON_KINDS.has(compat.products.get(productId)?.kind ?? "") ? 5 : 3);
        for (const productId of interestIds) hidden.add(productId); // something new, not what they already looked at
        plans.push({
          key: `${input.context}:personal`,
          title: engine.t("rec.personal.title"),
          // a customer's signals follow the account (and its saved devices); a guest's stay with this device's key
          reason: engine.t(input.customerId ? "rec.personal.reasonAccount" : "rec.personal.reason"),
          place: { context: input.context, shelf: "personal", productId: null, categoryId: null, platformIds: new Set(anchors.map((model) => model.platformId)), deviceModelId: anchors[0].id },
          scores,
          accepts: isFit,
          diversity: (card) => card.kind,
        });
      }
    }
  }
  const picks = await picksPlan(engine, input.context, input.platformSlugs ?? [], input.consent);
  plans.push(picks.plan);
  return finish(db, input.locale, now, plans, adminRules, hidden, size, picks.cards);
}

// ───────────────────────────────────────────────────────────────── consent and the session key

export type RecommendationSubject = { consent: boolean; sessionHash: string | null; customerId: string | null };

const SESSION_TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/** Is this a plausible `tt_rs` value (random base64url, 32–128 characters)? */
export const isRecSessionToken = (value: unknown): value is string => typeof value === "string" && SESSION_TOKEN.test(value);

/**
 * Who is asking, as recommendations may know it: the personalization answer (a signed-in customer's latest consents
 * row, else this device's `tt_consent` cookie; no answer = no) and — only with consent — the hashed session key of a
 * guest. Pass the result to getRecommendations() and recordEvent().
 */
export async function personalizationFor(db: Db, who: { cookie: (name: string) => string | null; customerId: string | null }): Promise<RecommendationSubject> {
  let consent = who.cookie(CONSENT_COOKIE) === "1";
  if (who.customerId) {
    const row = (
      await db.all<{ granted: number }>(sql`SELECT granted FROM consents WHERE subject_type = 'customer' AND subject_id = ${who.customerId} AND kind = 'personalization' ORDER BY at DESC, id DESC LIMIT 1`)
    )[0];
    if (row) consent = Number(row.granted) === 1;
  }
  const token = who.cookie(REC_SESSION_COOKIE);
  const sessionHash = consent && !who.customerId && isRecSessionToken(token) ? await sha256Hex(token) : null;
  return { consent, sessionHash, customerId: who.customerId };
}

/** A new `tt_rs` value: 32 random bytes, base64url. */
export function newRecSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ───────────────────────────────────────────────────────────────── signals

const EventInput = z.object({
  kind: z.enum(RECOMMENDATION_EVENT_KINDS),
  productId: id,
  source: z.preprocess((value) => (value === "" ? undefined : value), z.string().trim().max(64, "too_long").regex(/^[a-z0-9_:.-]+$/i, "invalid").nullish()),
});
export type RecordEventInput = z.input<typeof EventInput>;

export type RecordEventResult = { recorded: boolean; reason: "recorded" | "no_consent" | "no_subject" | "duplicate" | "unknown_product" };

/**
 * Stores one signal — only with consent (otherwise nothing is written: "no_consent"). Keyed by the customer when
 * signed in, else by the guest's hashed session key; a repeat inside the kind's window is stored once ("duplicate").
 * Products that are not published are refused quietly ("unknown_product"). Invalid input → AppError("invalid", 400).
 */
export async function recordEvent(db: Db, who: RecommendationSubject, raw: RecordEventInput, now: number): Promise<RecordEventResult> {
  const parsed = EventInput.safeParse(raw ?? {});
  if (!parsed.success) throw invalid(zodFieldErrors(parsed.error), "recommendations.recordEvent");
  if (!who.consent) return { recorded: false, reason: "no_consent" };
  const input = parsed.data;
  const customerId = who.customerId ?? null;
  const sessionHash = customerId ? null : (who.sessionHash ?? null);
  if (!customerId && !sessionHash) return { recorded: false, reason: "no_subject" };
  const subject = customerId ? sql`e.customer_id = ${customerId}` : sql`e.session_hash = ${sessionHash} AND e.customer_id IS NULL`;
  const result = await db.run(sql`INSERT INTO recommendation_events (id, session_hash, customer_id, kind, product_id, source, at)
SELECT ${newId("rev")}, ${sessionHash}, ${customerId}, ${input.kind}, p.id, ${input.source ?? null}, ${now}
FROM products AS p
WHERE p.id = ${input.productId} AND p.status = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM recommendation_events AS e
    WHERE ${subject} AND e.product_id = p.id AND e.kind = ${input.kind} AND e.at > ${now - DEDUPE_MS[input.kind]}
  )`);
  const changes = Number((result as { meta?: { changes?: unknown } } | null)?.meta?.changes ?? 0);
  if (changes > 0) return { recorded: true, reason: "recorded" };
  const exists = (await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM products WHERE id = ${input.productId} AND status = 'published'`))[0];
  return { recorded: false, reason: Number(exists?.n ?? 0) > 0 ? "duplicate" : "unknown_product" };
}

/** Deletes every signal of one shopper (a guest's session key and/or a customer's id). Returns how many rows went. */
export async function forgetEvents(db: Db, who: { sessionHash: string | null; customerId: string | null }): Promise<number> {
  const conditions: SQL[] = [];
  if (who.sessionHash) conditions.push(sql`session_hash = ${who.sessionHash}`);
  if (who.customerId) conditions.push(sql`customer_id = ${who.customerId}`);
  if (conditions.length === 0) return 0;
  const result = await db.run(sql`DELETE FROM recommendation_events WHERE ${sql.join(conditions, sql` OR `)}`);
  return Number((result as { meta?: { changes?: unknown } } | null)?.meta?.changes ?? 0);
}

/** Retention: deletes signals older than RECOMMENDATION_EVENT_RETENTION_DAYS. For the daily retention job. */
export async function purgeRecommendationEvents(db: Db, now: number): Promise<number> {
  const result = await db.run(sql`DELETE FROM recommendation_events WHERE at < ${now - RETENTION_MS}`);
  return Number((result as { meta?: { changes?: unknown } } | null)?.meta?.changes ?? 0);
}

// ───────────────────────────────────────────────────────────────── for pages (the integration pass)

/**
 * What a page's loader streams for its recommendation shelves. Never rejects: a failure is `ok: false` (logged on
 * the server), so the page shows the failure in the shelves' space and everything else stands.
 */
export type RecommendationResult = { ok: true; shelves: Shelf<ProductCardData>[] } | { ok: false; shelves: Shelf<ProductCardData>[] };

/** The contexts whose shelves read the shopper's own (consented) signals; the others never need the consent lookup. */
const PERSONAL_CONTEXTS: ReadonlySet<RecommendationContextName> = new Set(["home", "search"]);

export type PageShelvesRequest = {
  locale: Locale;
  context: RecommendationContextName;
  productId?: string | null;
  deviceModelId?: string | null;
  cartVariantIds?: readonly string[];
  platformSlugs?: readonly string[];
  now?: number;
  /**
   * Only these shelves (by key). Pages that already show their own editorial shelves keep only the personal one
   * (`personalOnly`) — the store's picks would repeat what the page lists.
   */
  keep?: (shelf: Shelf<ProductCardData>) => boolean;
  /** Show nothing (and read nothing) unless the shopper said yes to personalization: the personal shelf alone. */
  personalOnly?: boolean;
};

/** A shelf built from the shopper's own signals (`<context>:personal`). */
export const isPersonalShelf = (shelf: Shelf<ProductCardData>): boolean => shelf.key.endsWith(":personal");

/**
 * The shelves of one page, for its loader to return WITHOUT awaiting (streamed to the shared <RecommendationShelves>).
 * Home and search read the shopper's consent and session key first (personalizationFor: the account's answer, else
 * the device's `tt_consent`); product, cart, order and device contexts do not use personal signals at all.
 */
export async function recommendationsFor(db: Db, who: { cookie: (name: string) => string | null; customerId: string | null }, request: PageShelvesRequest, limit = 8): Promise<RecommendationResult> {
  try {
    const personal = PERSONAL_CONTEXTS.has(request.context);
    const subject: RecommendationSubject = personal ? await personalizationFor(db, who) : { consent: false, sessionHash: null, customerId: null };
    if (request.personalOnly && !subject.consent) return { ok: true, shelves: [] };
    const shelves = await getRecommendations(
      db,
      {
        locale: request.locale,
        context: request.context,
        productId: request.productId ?? null,
        deviceModelId: request.deviceModelId ?? null,
        cartVariantIds: request.cartVariantIds ? [...new Set(request.cartVariantIds)].slice(0, 50) : undefined,
        platformSlugs: request.platformSlugs ? [...request.platformSlugs] : undefined,
        sessionHash: subject.sessionHash,
        customerId: subject.customerId,
        consent: subject.consent,
        now: request.now,
      },
      limit,
    );
    const keep = request.personalOnly ? isPersonalShelf : request.keep;
    return { ok: true, shelves: keep ? shelves.filter(keep) : shelves };
  } catch (error) {
    console.error(`[recommendations] ${request.context} shelves failed`, error);
    return { ok: false, shelves: [] };
  }
}

/**
 * The purchase signal (kind "purchase"), one per product of a NEW order — recorded only with consent (recordEvent is a
 * no-op without it). Called by the checkout's own server file after placeOrder succeeded, never by the commerce core,
 * and never for a replayed attempt. Returns how many were stored. A failure here never undoes the order.
 */
export async function recordPurchaseSignals(db: Db, who: RecommendationSubject, productIds: readonly string[], now: number): Promise<number> {
  if (!who.consent || (!who.customerId && !who.sessionHash)) return 0;
  let stored = 0;
  for (const productId of [...new Set(productIds)].slice(0, 50)) {
    if (!ID.test(productId)) continue;
    const result = await recordEvent(db, who, { kind: "purchase", productId, source: "checkout" }, now);
    if (result.recorded) stored++;
  }
  return stored;
}

/** The products and variants of one order (a used unit through its catalogue variant) — anchors and signals. */
export async function orderItemsOf(db: Db, ref: string): Promise<{ productIds: string[]; variantIds: string[] }> {
  if (typeof ref !== "string" || ref.length > 40) return { productIds: [], variantIds: [] };
  const rows = await db.all<{ variant_id: string; product_id: string }>(sql`SELECT oi.variant_id, v.product_id
FROM order_items AS oi
JOIN orders AS o ON o.id = oi.order_id
JOIN variants AS v ON v.id = oi.variant_id
WHERE o.ref = ${ref}
ORDER BY oi.id`);
  return { productIds: [...new Set(rows.map((row) => row.product_id))], variantIds: [...new Set(rows.map((row) => row.variant_id))] };
}

/** The catalogue variants of some used units (the cart view does not carry them) — anchors for the cart's shelves. */
export async function usedUnitVariantIds(db: Db, usedUnitIds: readonly string[]): Promise<string[]> {
  const ids = [...new Set(usedUnitIds)].filter((value) => ID.test(value)).slice(0, 50);
  if (ids.length === 0) return [];
  const rows = await db.all<{ variant_id: string }>(sql`SELECT variant_id FROM used_units WHERE id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`);
  return [...new Set(rows.map((row) => row.variant_id))];
}
