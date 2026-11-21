/**
 * Switch bundle builder — the store side (docs/switch-builder.md §5): what TamTam sells for the builder, the plan the
 * browser sends back, and the review step's quote. Server only. Prices and stock are read now; nothing the browser
 * sends is trusted for money (it names variants and games, the server prices them).
 *
 *   const catalog = await loadBuilderCatalog(db, ctx.locale, ctx.now);                  // loader data — no stock counts
 *   const plan = parsePlan(form.get("plan"));                                           // null: not a valid plan
 *   const quote = await quoteBuilderPlan(db, ctx.locale, plan, await getLibraryPrices(db, plan.games.map((game) => game.id)), ctx.now);
 *
 * SOLD MEANS WHAT THE CART SELLS (cart.server.ts isSellableProduct, inventory getAvailability): a product `published`,
 * or `scheduled` once its publish time has passed; an active variant with a price above 0; free units > 0 →
 * `orderable`. A listed option that cannot be bought right now says `orderable: false` (reason "out_of_stock") — never
 * how many units there are: availability stays inside this module, where it decides `orderable` and the eShop mix.
 *
 *   devices     consoles (kind console) that ARE one of the three Switch 1 models (products.device_model_id): every
 *               active variant (colour) of every such product, the main product first; null = TamTam does not sell
 *               this model now (the shopper may still own one).
 *   cards       storage products that are VERIFIED on every Switch 1 model (compatibility.server.ts resolveForModel —
 *               the most specific rule decides; a microSD Express card is only "partial" there, at ordinary microSD
 *               speed, so it is not offered), by `options.storage` 64GB/128GB/256GB/512GB/1TB: per size the cheapest
 *               orderable variant, else the cheapest one (orderable false). A size nobody sells is missing.
 *   cartridges  physical games (kind game; a cartridge, never a key card or a code) for a Switch 1 model
 *               (`attributes.game.platforms`), by LIBRARY ID: the nintendo.com US store key that the product's own
 *               research sources link (`<key>` of …/us/store/products/<key>/, a Switch 1 key ending in "-switch") —
 *               the key named after the product's slug, else the only one (a product citing several games' pages, a
 *               compilation, maps to its own key only). Variants for Switch 2 (platform or edition "Nintendo Switch
 *               2") never count: a Switch 2 only game (the 2026 Ocarina of Time remake) or a Switch 2 Edition is never
 *               a Switch 1 cartridge. Several products for one game: the orderable, cheapest one.
 *   eshop       US Nintendo eShop wallet top-ups (kind digital, licence wallet_topup, verified on every Switch 1
 *               model, variant region "United States", value "N USD"), one variant per value; `sold` = one is orderable.
 *
 * THE QUOTE (BuilderQuote, the review step):
 *   · a console line when the shopper buys one and chose a colour TamTam sells for that model; otherwise, when not
 *     owned, `notSold` says TamTam cannot sell that console now;
 *   · a card line when the shopper buys a card of a size TamTam sells; else `notSold` names the size;
 *   · a cartridge line per game wanted as a cartridge that TamTam sells (sold out → a line with orderable false); a
 *     cartridge TamTam does not sell is counted as a digital game;
 *   · digital games: the eShop total of those with a TamTam price (LibraryExtras.priceUsdCents; a hidden game has none),
 *     the others listed as unpriced; eShop card lines covering that total when cards are sold — eshop-mix.ts with the
 *     units in stock (least money left over, then fewest cards). When the stock cannot cover it, every card in stock
 *     is proposed and `cardsCents` < `pricedCents` says so.
 *   `totalIqd` = the orderable lines at today's catalogue prices. The cart prices the order itself (flash sales,
 *   coupons, delivery) and re-checks everything at checkout.
 *
 * ROUND TRIPS: two per call — one batch (the three models, the candidate products' active variants with their first
 * pictures, the compatibility rules of the candidate cards and eShop cards on those models) and getAvailability.
 */
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { allEshopCards, mixEshopCards } from "~/lib/switch-builder/eshop-mix";
import { isCardSize } from "~/lib/switch-builder/storage";
import { CARD_SIZES, PLAN_LIMITS, SWITCH_MODELS } from "~/lib/switch-builder/types";
import type { BuilderCatalog, BuilderPlan, BuilderQuote, CardSize, CatalogOption, LibraryExtras, LibraryGameId, QuoteLine, SwitchModel } from "~/lib/switch-builder/types";
import type { Db } from "~/server/db.server";
import { batchSql, runBatch } from "~/server/db/tx.server";
import { MAX_LINE_QTY } from "~/server/services/cart.server";
import { resolveForModel, toRules, type RuleLite, type VariantLite } from "~/server/services/compatibility.server";
import { getAvailability } from "~/server/services/inventory/stock.server";

// ───────────────────────────────────────────────────────────────── rows and small readers

type ModelRow = { id: string; slug: string; generation_id: string | null; platform_id: string };

type CandidateRow = {
  variant_id: string;
  variant_title: string | null;
  options: string | null;
  price_iqd: number;
  is_default: number;
  sort: number;
  product_id: string;
  slug: string;
  kind: string;
  name: string;
  license_type: string | null;
  created_at: number;
  model_slug: string | null;
  game_platforms: string | null;
  physical_format: string | null;
  sources: string | null;
  variant_art: string | null;
  product_art: string | null;
};

type RuleRow = { subject_type: string; subject_id: string; product_id: string | null; target_type: string; target_id: string; status: string; note: string | null };

const rowsOf = <T>(result: unknown): T[] => ((result as { results?: T[] } | null)?.results ?? []) as T[];

/** JSON columns read through raw SQL arrive as text. Malformed JSON reads as null (left out, never guessed). */
function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

const l10nOf = (value: unknown): L10n | null => {
  const json = parsed(value);
  return json && typeof json === "object" && typeof (json as L10n).ar === "string" ? (json as L10n) : null;
};

/** A variant's options as plain strings (anything else is left out). */
function optionsOf(value: unknown): Record<string, string> {
  const json = parsed(value);
  const out: Record<string, string> = {};
  if (json && typeof json === "object" && !Array.isArray(json)) {
    for (const [key, entry] of Object.entries(json as Record<string, unknown>)) if (typeof entry === "string" && entry.trim() !== "") out[key] = entry.trim();
  }
  return out;
}

const stringList = (value: unknown): string[] => {
  const json = parsed(value);
  return Array.isArray(json) ? json.filter((entry): entry is string => typeof entry === "string") : [];
};

// ───────────────────────────────────────────────────────────────── the catalogue's facts, as the builder reads them

/** A card size from a variant's `options.storage` ("256GB", "1TB"), when it is one the builder offers. */
export function cardSizeOf(storage: string | null | undefined): Exclude<CardSize, 0> | null {
  const match = /^\s*(\d{1,4})\s*(GB|TB)\s*$/i.exec(storage ?? "");
  if (!match) return null;
  const gb = Number(match[1]) * (match[2].toUpperCase() === "TB" ? 1000 : 1);
  return gb !== 0 && isCardSize(gb) ? (gb as Exclude<CardSize, 0>) : null;
}

/** US cents of an eShop card's `options.value` ("10 USD", "10.50 USD"), else null. */
export function usdCentsOf(value: string | null | undefined): number | null {
  const match = /^\s*(\d{1,5})(?:\.(\d{1,2}))?\s*USD\s*$/i.exec(value ?? "");
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "0").padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

const US_REGION = /^(united states|us|usa|u\.s\.a?\.?)$/i;
/** A variant made for Switch 2 (its platform or edition says so) — never a Switch 1 cartridge. */
const SWITCH_2 = /switch\s*2/i;
/** A game "format" that is not the game itself on a cartridge (a key card, a code in a box, a download). */
const NOT_A_CARTRIDGE = /key|code|download|digital/i;
const US_STORE_KEY = /^https?:\/\/(?:www\.)?nintendo\.com\/us\/store\/products\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?(?:[?#].*)?$/i;

/**
 * The library id (a Switch 1 nintendo.com US store key) a game product IS, from its research sources: the key named
 * after its slug when the sources hold it, else the only Switch 1 key they hold; null when there is none or several
 * (a page cited for a fact about another game must not turn this cartridge into that game).
 */
export function libraryIdOf(slug: string, sources: unknown): LibraryGameId | null {
  const list = parsed(sources);
  if (!Array.isArray(list)) return null;
  const keys = new Set<string>();
  for (const source of list) {
    const url = source && typeof source === "object" ? (source as { url?: unknown }).url : null;
    if (typeof url !== "string") continue;
    const match = US_STORE_KEY.exec(url.trim());
    const key = match?.[1].toLowerCase();
    if (key && key.endsWith("-switch")) keys.add(key);
  }
  const own = `${slug}-switch`;
  if (keys.has(own)) return own;
  return keys.size === 1 ? [...keys][0] : null;
}

/** Best option first: orderable, then cheapest, then the product's default, then catalogue order. */
const optionRank = (a: Ranked, b: Ranked) =>
  Number(b.option.orderable) - Number(a.option.orderable) || a.option.priceIqd - b.option.priceIqd || b.isDefault - a.isDefault || a.sort - b.sort || a.option.variantId.localeCompare(b.option.variantId);

type Ranked = { option: CatalogOption; isDefault: number; sort: number };

type Facts = {
  catalog: BuilderCatalog;
  /** Free units per candidate variant — server only, never in loader data. */
  available: Map<string, number>;
  /** The eShop denominations' options (name, value title, picture), by variant id. */
  eshopOptions: Map<string, CatalogOption>;
};

const MODELS_JSON = JSON.stringify(SWITCH_MODELS);

/** The three Switch 1 device models (ids for the compatibility rules). */
const modelsSql = (): SQL => sql`SELECT id, slug, generation_id, platform_id FROM device_models WHERE slug IN (SELECT value FROM json_each(${MODELS_JSON}))`;

/** A rule (alias r) whose target is one of the Switch 1 models — the model itself, its generation or its platform. */
const touchesSwitchModels = (): SQL => {
  const models = sql`(SELECT value FROM json_each(${MODELS_JSON}))`;
  return sql`((r.target_type = 'device_model' AND r.target_id IN (SELECT id FROM device_models WHERE slug IN ${models}))
    OR (r.target_type = 'generation' AND r.target_id IN (SELECT generation_id FROM device_models WHERE generation_id IS NOT NULL AND slug IN ${models}))
    OR (r.target_type = 'platform' AND r.target_id IN (SELECT platform_id FROM device_models WHERE slug IN ${models})))`;
};

/**
 * Active variants of the live products the builder may offer: Switch 1 consoles, physical games for a Switch 1 model,
 * and storage / digital products with a compatibility rule on a Switch 1 model — with each variant's and each
 * product's first catalogue picture. Malformed `attributes` JSON counts as "no facts" instead of failing the read.
 */
function candidatesSql(now: number): SQL {
  const models = sql`(SELECT value FROM json_each(${MODELS_JSON}))`;
  const ruleProducts = sql`(SELECT CASE WHEN r.subject_type = 'product' THEN r.subject_id ELSE (SELECT rv.product_id FROM variants AS rv WHERE rv.id = r.subject_id) END
    FROM compatibility_rules AS r WHERE ${touchesSwitchModels()})`;
  return sql`SELECT v.id AS variant_id, v.title AS variant_title, v.options, v.price_iqd, v.is_default, v.sort,
  p.id AS product_id, p.slug, p.kind, p.name, p.license_type, p.created_at, dm.slug AS model_slug,
  CASE WHEN p.kind = 'game' AND json_valid(p.attributes) THEN json_extract(p.attributes, '$.game.platforms') END AS game_platforms,
  CASE WHEN p.kind = 'game' AND json_valid(p.attributes) THEN json_extract(p.attributes, '$.game.physicalFormat') END AS physical_format,
  CASE WHEN p.kind = 'game' AND json_valid(p.attributes) THEN json_extract(p.attributes, '$.sources') END AS sources,
  (SELECT m.art_key FROM media AS m WHERE m.owner_type = 'variant' AND m.owner_id = v.id AND m.kind IN ('image', 'render') AND m.art_key IS NOT NULL ORDER BY m.sort, m.id LIMIT 1) AS variant_art,
  (SELECT m.art_key FROM media AS m WHERE m.owner_type = 'product' AND m.owner_id = p.id AND m.kind IN ('image', 'render') AND m.art_key IS NOT NULL ORDER BY m.sort, m.id LIMIT 1) AS product_art
FROM variants AS v
JOIN products AS p ON p.id = v.product_id
LEFT JOIN device_models AS dm ON dm.id = p.device_model_id
WHERE v.is_active = 1 AND v.price_iqd > 0
  AND (p.status = 'published' OR (p.status = 'scheduled' AND p.publish_at IS NOT NULL AND p.publish_at <= ${now}))
  AND (
    (p.kind = 'console' AND dm.slug IN ${models})
    OR (p.kind = 'game' AND (p.media_format IS NULL OR p.media_format = 'physical')
        AND CASE WHEN json_valid(p.attributes) THEN EXISTS (SELECT 1 FROM json_each(p.attributes, '$.game.platforms') AS gp WHERE gp.value IN ${models}) ELSE 0 END)
    OR (p.kind IN ('storage', 'digital') AND p.id IN ${ruleProducts})
  )
ORDER BY p.created_at, p.id, v.is_default DESC, v.sort, v.id`;
}

/** The compatibility rules of storage and digital products on the Switch 1 models (each with its product). */
function rulesSql(): SQL {
  return sql`SELECT r.subject_type, r.subject_id, r.target_type, r.target_id, r.status, NULL AS note,
  CASE WHEN r.subject_type = 'product' THEN r.subject_id ELSE rv.product_id END AS product_id
FROM compatibility_rules AS r
LEFT JOIN variants AS rv ON r.subject_type = 'variant' AND rv.id = r.subject_id
WHERE ${touchesSwitchModels()}
  AND (CASE WHEN r.subject_type = 'product' THEN r.subject_id ELSE rv.product_id END) IN (SELECT id FROM products WHERE kind IN ('storage', 'digital'))`;
}

function optionOf(row: CandidateRow, available: number, locale: Locale): CatalogOption {
  const name = pick(l10nOf(row.name), locale).trim() || row.slug;
  const variantTitle = pick(l10nOf(row.variant_title), locale).trim();
  const art = row.variant_art ?? row.product_art;
  const orderable = available > 0;
  return {
    variantId: row.variant_id,
    productSlug: row.slug,
    name,
    ...(variantTitle && variantTitle !== name ? { variantTitle } : {}),
    priceIqd: Number(row.price_iqd),
    orderable,
    ...(orderable ? {} : { reason: "out_of_stock" as const }),
    ...(art ? { art } : {}),
  };
}

/** Everything the builder offers right now, plus the stock behind it (for this module only). */
async function readFacts(db: Db, locale: Locale, now: number): Promise<Facts> {
  const [modelResult, candidateResult, ruleResult] = await runBatch(db, [batchSql(db, modelsSql()), batchSql(db, candidatesSql(now)), batchSql(db, rulesSql())]);
  const models = rowsOf<ModelRow>(modelResult).map((row) => ({ id: row.id, generationId: row.generation_id ?? null, platformId: row.platform_id }));
  const rows = rowsOf<CandidateRow>(candidateResult);
  const rules: RuleLite[] = toRules(rowsOf<RuleRow>(ruleResult));
  const stock = await getAvailability(
    db,
    rows.map((row) => row.variant_id),
  );
  const available = new Map<string, number>();
  for (const row of rows) available.set(row.variant_id, Math.max(0, stock.get(row.variant_id)?.available ?? 0));

  const byProduct = new Map<string, CandidateRow[]>();
  for (const row of rows) byProduct.set(row.product_id, [...(byProduct.get(row.product_id) ?? []), row]);
  const ranked = (row: CandidateRow): Ranked => ({ option: optionOf(row, available.get(row.variant_id) ?? 0, locale), isDefault: Number(row.is_default) ? 1 : 0, sort: Number(row.sort) || 0 });

  /** The product's answer is "verified" on every Switch 1 model the database knows (never better than the rules say). */
  const verifiedEverywhere = (productId: string, variantRows: readonly CandidateRow[]) => {
    if (models.length === 0) return false;
    const own = rules.filter((rule) => rule.productId === productId);
    const units: VariantLite[] = variantRows.map((row) => ({ id: row.variant_id, productId, title: l10nOf(row.variant_title), isDefault: Number(row.is_default) === 1, sort: Number(row.sort) || 0 }));
    return models.every((model) => resolveForModel(productId, units, own, model).status === "verified");
  };

  // ── consoles, by model: every product that IS the model, the one with the most orderable colours first
  const devices = Object.fromEntries(SWITCH_MODELS.map((model) => [model, null])) as BuilderCatalog["devices"];
  for (const model of SWITCH_MODELS) {
    const consoles = [...byProduct.values()]
      .filter((list) => list[0].kind === "console" && list[0].model_slug === model)
      .map((list) => ({ list, options: list.map(ranked).sort((a, b) => b.isDefault - a.isDefault || a.sort - b.sort || a.option.variantId.localeCompare(b.option.variantId)) }))
      .sort((a, b) => b.options.filter((entry) => entry.option.orderable).length - a.options.filter((entry) => entry.option.orderable).length);
    if (consoles.length === 0) continue;
    const main = consoles[0].list[0];
    const name = pick(l10nOf(main.name), locale).trim() || main.slug;
    devices[model] = { productSlug: main.slug, name, ...(main.product_art ? { art: main.product_art } : {}), variants: consoles.flatMap((entry) => entry.options.map((item) => item.option)) };
  }

  // ── memory cards and eShop cards: verified on every Switch 1 model
  const cardChoices = new Map<Exclude<CardSize, 0>, Ranked[]>();
  const eshopChoices = new Map<number, Ranked[]>();
  for (const [productId, list] of byProduct) {
    const kind = list[0].kind;
    if (kind !== "storage" && kind !== "digital") continue;
    if (kind === "digital" && list[0].license_type !== "wallet_topup") continue;
    if (!verifiedEverywhere(productId, list)) continue;
    for (const row of list) {
      const options = optionsOf(row.options);
      if (kind === "storage") {
        const size = cardSizeOf(options.storage);
        if (size) cardChoices.set(size, [...(cardChoices.get(size) ?? []), ranked(row)]);
      } else if (US_REGION.test(options.region ?? "")) {
        const cents = usdCentsOf(options.value);
        if (cents) eshopChoices.set(cents, [...(eshopChoices.get(cents) ?? []), ranked(row)]);
      }
    }
  }
  const cards: BuilderCatalog["cards"] = {};
  for (const size of CARD_SIZES) {
    if (size === 0) continue;
    const best = cardChoices.get(size)?.sort(optionRank)[0];
    if (best) cards[size] = best.option;
  }
  const eshopOptions = new Map<string, CatalogOption>();
  const denominations: BuilderCatalog["eshop"]["denominations"] = [];
  for (const [cents, choices] of [...eshopChoices.entries()].sort((a, b) => a[0] - b[0])) {
    const best = choices.sort(optionRank)[0].option;
    eshopOptions.set(best.variantId, best);
    denominations.push({ cents, variantId: best.variantId, priceIqd: best.priceIqd, orderable: best.orderable });
  }

  // ── cartridges, by library id
  const cartridgeChoices = new Map<LibraryGameId, Ranked>();
  for (const list of byProduct.values()) {
    const head = list[0];
    if (head.kind !== "game") continue;
    if (!stringList(head.game_platforms).some((slug) => (SWITCH_MODELS as readonly string[]).includes(slug))) continue;
    if (head.physical_format !== null && head.physical_format !== "cartridge") continue;
    const libraryId = libraryIdOf(head.slug, head.sources);
    if (!libraryId) continue;
    const switch1 = list.filter((row) => {
      const options = optionsOf(row.options);
      return !SWITCH_2.test(options.platform ?? "") && !SWITCH_2.test(options.edition ?? "") && !NOT_A_CARTRIDGE.test(options.format ?? "");
    });
    const best = switch1.map(ranked).sort(optionRank)[0];
    if (!best) continue;
    const known = cartridgeChoices.get(libraryId);
    if (!known || optionRank(best, known) < 0) cartridgeChoices.set(libraryId, best);
  }
  const cartridges: BuilderCatalog["cartridges"] = {};
  for (const [libraryId, choice] of cartridgeChoices) cartridges[libraryId] = choice.option;

  return {
    catalog: { devices, cards, cartridges, eshop: { sold: denominations.some((entry) => entry.orderable), denominations } },
    available,
    eshopOptions,
  };
}

// ───────────────────────────────────────────────────────────────── the three exported functions

/** What TamTam sells for the builder right now: consoles, cards, cartridges, eShop cards (no stock counts leave). */
export async function loadBuilderCatalog(db: Db, locale: Locale, now: number): Promise<BuilderCatalog> {
  return (await readFacts(db, locale, now)).catalog;
}

const VARIANT_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** A library id: a Nintendo US store slug (lower-case words joined by "-"). */
const GAME_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** A plan in JSON is a few KB (120 games ≈ 7 KB); anything far larger is not a plan. */
export const MAX_PLAN_CHARS = 32 * 1024;

const variantId = z.string().max(128).regex(VARIANT_ID);

const PlanSchema = z.object({
  v: z.literal(1),
  device: z.object({ model: z.enum(SWITCH_MODELS), owned: z.boolean(), variantId: variantId.optional() }),
  card: z.object({ sizeGB: z.custom<CardSize>((value) => isCardSize(value)), owned: z.boolean(), variantId: variantId.optional() }),
  games: z
    .array(z.object({ id: z.string().min(1).max(160).regex(GAME_ID), format: z.enum(["digital", "cartridge"]) }))
    .max(PLAN_LIMITS.maxGames),
});

/**
 * A plan sent by the browser — the object, or its JSON text — checked; null when it is not a valid plan (wrong
 * version, unknown model or card size, malformed ids, more than PLAN_LIMITS.maxGames games, …). Unknown keys are
 * dropped, a game listed twice counts once, and ids that only matter for something bought (a colour, a card) are
 * dropped when the shopper owns it.
 */
export function parsePlan(raw: unknown): BuilderPlan | null {
  let value = raw;
  if (typeof raw === "string") {
    if (raw.length === 0 || raw.length > MAX_PLAN_CHARS) return null;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  const result = PlanSchema.safeParse(value);
  if (!result.success) return null;
  const plan = result.data;
  const seen = new Set<string>();
  const games = plan.games.filter((game) => !seen.has(game.id) && Boolean(seen.add(game.id)));
  const device: BuilderPlan["device"] = { model: plan.device.model as SwitchModel, owned: plan.device.owned, ...(!plan.device.owned && plan.device.variantId ? { variantId: plan.device.variantId } : {}) };
  const noCard = plan.card.sizeGB === 0;
  const card: BuilderPlan["card"] = { sizeGB: plan.card.sizeGB, owned: noCard ? false : plan.card.owned, ...(!noCard && !plan.card.owned && plan.card.variantId ? { variantId: plan.card.variantId } : {}) };
  return { v: 1, device, card, games };
}

function lineOf(kind: QuoteLine["kind"], option: CatalogOption, qty: number): QuoteLine {
  return {
    kind,
    variantId: option.variantId,
    productSlug: option.productSlug,
    qty,
    name: option.name,
    ...(option.variantTitle ? { variantTitle: option.variantTitle } : {}),
    unitPriceIqd: option.priceIqd,
    orderable: option.orderable,
    ...(option.reason ? { reason: option.reason } : {}),
    ...(option.art ? { art: option.art } : {}),
  };
}

/** A digital game's TamTam eShop price in US cents, when it has a usable one (a hidden game has none). */
function priceCentsOf(extras: Record<LibraryGameId, LibraryExtras>, id: LibraryGameId): number | null {
  if (!Object.hasOwn(extras, id)) return null;
  const entry = extras[id];
  const cents = entry && !entry.hidden ? entry.priceUsdCents : undefined;
  return typeof cents === "number" && Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

/** The review step's lines and totals for a plan (prices and availability read now; the cart prices the order). */
export async function quoteBuilderPlan(db: Db, locale: Locale, plan: BuilderPlan, extras: Record<LibraryGameId, LibraryExtras>, now: number): Promise<BuilderQuote> {
  const { catalog, available, eshopOptions } = await readFacts(db, locale, now);
  const lines: QuoteLine[] = [];
  const notSold: BuilderQuote["notSold"] = [];

  // the console: a colour TamTam sells for the chosen model (a stale or foreign variant id is not sold)
  if (!plan.device.owned) {
    const device = catalog.devices[plan.device.model];
    const option = plan.device.variantId ? device?.variants.find((entry) => entry.variantId === plan.device.variantId) : undefined;
    if (option) lines.push(lineOf("device", option, 1));
    else if (!device || plan.device.variantId) notSold.push({ kind: "device", model: plan.device.model });
  }

  // the memory card: the card TamTam sells in that size (the catalogue's choice — never the browser's variant id)
  if (plan.card.sizeGB !== 0 && !plan.card.owned) {
    const option = catalog.cards[plan.card.sizeGB];
    if (option) lines.push(lineOf("card", option, 1));
    else notSold.push({ kind: "card", sizeGB: plan.card.sizeGB });
  }

  // the games: a cartridge TamTam sells, else digital
  const digital: LibraryGameId[] = [];
  for (const game of plan.games) {
    const cartridge = game.format === "cartridge" && Object.hasOwn(catalog.cartridges, game.id) ? catalog.cartridges[game.id] : undefined;
    if (cartridge) lines.push({ ...lineOf("cartridge", cartridge, 1), gameId: game.id });
    else digital.push(game.id);
  }
  let pricedCents = 0;
  let pricedCount = 0;
  const unpricedIds: LibraryGameId[] = [];
  for (const id of digital) {
    const cents = priceCentsOf(extras, id);
    if (cents === null) unpricedIds.push(id);
    else {
      pricedCents += cents;
      pricedCount++;
    }
  }

  // eShop cards covering the priced digital games, with the units in stock
  let cardsCents = 0;
  if (pricedCents > 0 && catalog.eshop.sold) {
    const offer = catalog.eshop.denominations
      .filter((entry) => entry.orderable)
      .map((entry) => ({ cents: entry.cents, max: Math.min(MAX_LINE_QTY, available.get(entry.variantId) ?? 0), variantId: entry.variantId }));
    const mix = mixEshopCards(pricedCents, offer) ?? allEshopCards(offer);
    for (const card of mix.cards) {
      const denomination = offer.find((entry) => entry.cents === card.cents);
      const option = denomination ? eshopOptions.get(denomination.variantId) : undefined;
      if (option) lines.push(lineOf("eshop", option, card.qty));
    }
    cardsCents = mix.totalCents;
  }

  const totalIqd = lines.reduce((sum, line) => (line.orderable ? sum + line.unitPriceIqd * line.qty : sum), 0);
  return {
    lines,
    totalIqd,
    digital: { pricedCents, pricedCount, unpricedIds, cardsCents, cardsSold: catalog.eshop.sold },
    notSold,
  };
}
