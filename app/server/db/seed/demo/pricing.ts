/**
 * DEMO prices, costs, deals and stock levels — placeholders, never researched figures (the catalogue
 * has no prices on purpose: shop prices come from the owner's price file). Every value here is
 * deterministic: the same SKU gets the same price, cost and stock level on every run, from a hash
 * of the SKU (and of the product slug for the product's price level).
 *
 *   price      the default variant's price is drawn inside its product's band (PRODUCT_BANDS: shaped
 *              after what such hardware sells for in Iraq; kind-wide bands for anything not listed),
 *              then each variant follows the default by capacity, chip and edition, ±1 %, rounded
 *              to 250 IQD. Gift cards cost their face value at the demo USD rate; subscriptions a
 *              monthly band × the length of the plan. Plausible, not exact: a 512GB model never
 *              costs more than the 1TB one, a Core controller less than the Elite.
 *   deal       a handful of default variants — one per kind, in stock, on sale for at least
 *              DEAL_MIN_DAYS_ON_SALE before the research date (a "was" price needs a time it was
 *              charged) — get a previous price 8–18 % above their price.
 *   cost       landed cost 70–85 % of the price (digital codes 92–96 %: they sell at face value),
 *              rounded to 250 IQD without leaving that band.
 *   stock      out of stock ≈ 8 %, low ≈ 18 %, the rest in stock; discontinued and limited
 *              editions 0–2 units; pre-orders (the product's or the variant's release date still
 *              ahead) none; a digital variant DEMO_CODES_PER_VARIANT — as many as its demo codes
 *              (./codes.ts), one code per unit sold.
 */
import type { ProductKind } from "../../schema";
import type { CatalogKind, CatalogProduct, CatalogVariant } from "./catalog/types";
import { isSubscription } from "./categories";
import { DEMO_FX_RATE } from "./commerce";

export const PRICE_STEP_IQD = 250;
/** Asia/Baghdad is UTC+3 all year. */
export const BAGHDAD_OFFSET_MS = 3 * 60 * 60 * 1000;
/**
 * Prices do not drift with the calendar: game price levels by age are measured from the date of the
 * research (catalog/README.md), not from the day the seed runs.
 */
export const PRICE_REFERENCE_DATE = "2026-11-11";
/** Placeholder pound → dollar factor for the UK eShop cards (the store only has a USD rate). */
export const DEMO_USD_PER_GBP = 1.3;

// ───────────────────────────────────────────────────────────────── hashing

/** FNV-1a, then the murmur3 finaliser: a well-spread 32-bit hash of a string, as a number in [0, 1). */
export function unitHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x85ebca6b);
  hash ^= hash >>> 13;
  hash = Math.imul(hash, 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 0x1_0000_0000;
}

const roundToStep = (value: number) => Math.max(PRICE_STEP_IQD, Math.round(value / PRICE_STEP_IQD) * PRICE_STEP_IQD);
const ceilToStep = (value: number) => Math.ceil(value / PRICE_STEP_IQD) * PRICE_STEP_IQD;
const floorToStep = (value: number) => Math.floor(value / PRICE_STEP_IQD) * PRICE_STEP_IQD;
const within = ([min, max]: Band, u: number) => min + (max - min) * u;

// ───────────────────────────────────────────────────────────────── bands

type Band = readonly [min: number, max: number];

/** Price band (IQD) of each product's DEFAULT variant. */
export const PRODUCT_BANDS: Readonly<Record<string, Band>> = {
  // Nintendo hardware
  "nintendo-switch-lite": [270_000, 310_000],
  "nintendo-switch": [400_000, 450_000],
  "nintendo-switch-oled": [480_000, 540_000],
  "nintendo-switch-2": [640_000, 700_000],
  "nintendo-switch-2-mario-kart-world-bundle": [720_000, 780_000],
  "nintendo-switch-2-pokemon-legends-z-a-bundle": [720_000, 780_000],
  "nintendo-switch-2-sports-resort-bundle": [700_000, 760_000],
  "nintendo-switch-2-zelda-40th-anniversary-edition": [760_000, 830_000],
  // PlayStation hardware
  "playstation-5": [620_000, 690_000],
  "playstation-5-slim": [700_000, 770_000],
  "playstation-5-slim-digital-edition": [610_000, 670_000],
  "playstation-5-pro": [1_000_000, 1_100_000],
  "playstation-portal": [260_000, 300_000],
  "playstation-vr2": [450_000, 530_000],
  // Xbox hardware
  "xbox-series-s": [500_000, 540_000],
  "xbox-series-x": [790_000, 860_000],
  "xbox-series-x-digital": [720_000, 780_000],
  "xbox-series-x-2tb-galaxy-black": [950_000, 1_050_000],
  "xbox-series-x25-limited-edition": [1_150_000, 1_300_000],
  // Handheld PCs
  "steam-deck-lcd": [540_000, 600_000],
  "steam-deck-oled": [740_000, 800_000],
  "rog-ally": [760_000, 830_000],
  "rog-ally-x": [1_080_000, 1_160_000],
  "rog-xbox-ally": [800_000, 870_000],
  "rog-xbox-ally-x": [1_350_000, 1_450_000],
  "rog-xbox-ally-x20": [1_550_000, 1_700_000],
  "lenovo-legion-go": [920_000, 1_000_000],
  "lenovo-legion-go-2": [1_480_000, 1_600_000],
  "lenovo-legion-go-s": [1_050_000, 1_150_000],
  "msi-claw-8-ex-ai-plus": [1_350_000, 1_450_000],
  "msi-claw-a8": [1_100_000, 1_200_000],
  // Controllers
  dualsense: [85_000, 100_000],
  "dualsense-edge": [250_000, 290_000],
  "access-controller": [115_000, 135_000],
  "xbox-wireless-controller": [75_000, 90_000],
  "xbox-elite-series-2": [230_000, 270_000],
  "xbox-adaptive-controller": [125_000, 145_000],
  "xbox-nano-controller": [55_000, 70_000],
  "joy-con-2": [125_000, 140_000],
  "nintendo-switch-2-pro-controller": [110_000, 125_000],
  "nintendo-switch-2-gamecube-controller": [85_000, 100_000],
  // Headsets
  "pulse-3d": [120_000, 140_000],
  "pulse-elite": [190_000, 215_000],
  "pulse-explore": [265_000, 300_000],
  "playstation-pulse-wireless-headset": [150_000, 180_000],
  "xbox-wireless-headset": [140_000, 160_000],
  "hyperx-cloud-iii-s-wireless": [175_000, 205_000],
  "razer-blackshark-v2-x": [55_000, 70_000],
  "steelseries-arctis-nova-7-gen-2": [235_000, 270_000],
  // Storage (the default capacity)
  "sandisk-microsd-express": [70_000, 85_000],
  "samsung-microsd-express-for-nintendo-switch-2": [70_000, 85_000],
  "samsung-990-pro-heatsink": [150_000, 175_000],
  "sandisk-optimus-gx-pro-850p": [135_000, 160_000],
  "wd-black-sn850x": [140_000, 165_000],
  "sandisk-optimus-gx-c50-expansion-card": [190_000, 220_000],
  "seagate-storage-expansion-card": [185_000, 215_000],
  // Games priced below the usual level for their age
  minecraft: [40_000, 55_000],
  // Accessories
  "dualsense-charging-station": [38_000, 48_000],
  "ps5-vertical-stand": [35_000, 45_000],
  "ps5-disc-drive": [100_000, 120_000],
  "joy-con-2-charging-grip": [45_000, 55_000],
  "joy-con-2-wheel": [30_000, 38_000],
  "nintendo-switch-2-camera": [65_000, 78_000],
  "nintendo-switch-2-carrying-case": [45_000, 58_000],
  "nintendo-switch-2-dock-set": [130_000, 155_000],
  "xbox-rechargeable-battery-usb-c": [30_000, 38_000],
};

/** For products added to the catalogue later and not yet in PRODUCT_BANDS. */
const KIND_BANDS: Record<Exclude<CatalogKind, "game" | "digital">, Band> = {
  console: [400_000, 1_300_000],
  handheld_pc: [700_000, 1_800_000],
  controller: [40_000, 350_000],
  headset: [40_000, 350_000],
  storage: [60_000, 450_000],
  accessory: [30_000, 150_000],
  vr: [400_000, 600_000],
};

/** Price step per doubling of capacity: storage scales strongly, hardware a little. */
const CAPACITY_STEP: Readonly<Record<string, number>> = {
  "sandisk-microsd-express": 1.85,
  "samsung-990-pro-heatsink": 1.7,
  "sandisk-optimus-gx-pro-850p": 1.75,
  "wd-black-sn850x": 1.75,
  "sandisk-optimus-gx-c50-expansion-card": 1.6,
  "seagate-storage-expansion-card": 1.7,
};
const HARDWARE_CAPACITY_STEP = 1.12;
const STORAGE_CAPACITY_STEP = 1.75;

/** Edition multipliers (first match wins), relative to the default variant's edition. */
const EDITION_FACTORS: ReadonlyArray<readonly [RegExp, number]> = [
  [/mega dimension/i, 1.4],
  [/nintendo switch 2 edition/i, 1.15],
  [/\b(complete|collector'?s?|deluxe)\b/i, 1.35],
  [/x25 special/i, 1.15],
  [/40th anniversary|resident evil requiem/i, 1.12],
  [/prism collection/i, 1.06],
  [/^core$/i, 0.72],
  [/^bundle$/i, 1.35],
  [/^digital(?: edition)?$/i, 0.88],
];

const gameBand = (product: CatalogProduct): Band => {
  const reference = Date.parse(`${PRICE_REFERENCE_DATE}T00:00:00Z`);
  const released = product.releaseDate ? Date.parse(`${product.releaseDate}T00:00:00Z`) : null;
  const years = released === null ? null : (reference - released) / (365.25 * 24 * 60 * 60 * 1000);
  if (years !== null && years >= 3) return [40_000, 65_000];
  // Nintendo's own games keep their price for years.
  if (product.brand === "Nintendo") return [80_000, 105_000];
  if (years === null) return [50_000, 90_000];
  return years < 1 ? [75_000, 110_000] : [55_000, 85_000];
};

const bandOf = (product: CatalogProduct): Band => {
  const band = PRODUCT_BANDS[product.slug];
  if (band) return band;
  if (product.kind === "game") return gameBand(product);
  if (product.kind === "digital") return [20_000, 100_000];
  return KIND_BANDS[product.kind];
};

// ───────────────────────────────────────────────────────────────── variant factors

/** "256GB", "1TB", "64GB eMMC" → gigabytes; null when the variant states no capacity. */
export function capacityGb(variant: CatalogVariant): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(TB|GB)\b/i.exec(variant.options?.storage ?? variant.options?.capacity ?? "");
  if (!match) return null;
  return Number(match[1]) * (match[2].toUpperCase() === "TB" ? 1000 : 1);
}

function capacityFactor(product: CatalogProduct, variant: CatalogVariant, reference: CatalogVariant): number {
  const own = capacityGb(variant);
  const base = capacityGb(reference);
  if (own === null || base === null || own === base) return 1;
  const step = CAPACITY_STEP[product.slug] ?? (product.kind === "storage" ? STORAGE_CAPACITY_STEP : HARDWARE_CAPACITY_STEP);
  const factor = step ** Math.log2(own / base);
  // Small capacity differences (825GB / 1TB) still order the prices clearly.
  return own > base ? Math.max(1.05, factor) : Math.min(0.95, factor);
}

const editionFactorOf = (variant: CatalogVariant) => {
  const edition = variant.options?.edition ?? "";
  return EDITION_FACTORS.find(([pattern]) => pattern.test(edition))?.[1] ?? 1;
};

/** A non-"Extreme" chip next to an "Extreme" one (Ryzen Z1 vs Z1 Extreme, Arc G3 vs G3 Extreme). */
function chipFactorOf(product: CatalogProduct, variant: CatalogVariant): number {
  const chip = variant.options?.chip;
  if (!chip || /extreme/i.test(chip)) return 1;
  return product.variants.some((other) => /extreme/i.test(other.options?.chip ?? "")) ? 0.85 : 1;
}

export const defaultVariantOf = (product: CatalogProduct): CatalogVariant => product.variants.find((variant) => variant.isDefault) ?? product.variants[0];

// ───────────────────────────────────────────────────────────────── digital

/** "10 USD" / "15 GBP" → dollars. */
function faceValueUsd(variant: CatalogVariant): number | null {
  const match = /(\d+(?:\.\d+)?)\s*(USD|GBP)\b/i.exec(variant.options?.value ?? "");
  if (!match) return null;
  return Number(match[1]) * (match[2].toUpperCase() === "GBP" ? DEMO_USD_PER_GBP : 1);
}

const MONTHLY_BANDS: Readonly<Record<string, Band>> = {
  "playstation-plus:essential": [12_000, 14_000],
  "playstation-plus:extra": [19_000, 21_000],
  "playstation-plus:premium": [23_000, 25_000],
  "xbox-game-pass:essential": [12_500, 14_000],
  "xbox-game-pass:premium": [19_000, 21_000],
  "xbox-game-pass:ultimate": [38_000, 41_000],
};
/** Longer plans cost less per month. */
const PLAN_FACTOR: Readonly<Record<number, number>> = { 1: 1, 3: 2.7, 12: 8.4 };

function digitalPrice(product: CatalogProduct, variant: CatalogVariant): number {
  const face = faceValueUsd(variant);
  if (face !== null) return roundToStep(face * DEMO_FX_RATE.iqdPerUnit);
  const months = Number(/(\d+)\s*month/i.exec(variant.options?.duration ?? "")?.[1] ?? 0);
  const band = MONTHLY_BANDS[`${product.slug}:${(variant.options?.tier ?? "").toLowerCase()}`];
  if (months > 0 && band) return roundToStep(within(band, unitHash(`${variant.sku}:price`)) * (PLAN_FACTOR[months] ?? months));
  return roundToStep(within(bandOf(product), unitHash(`${variant.sku}:price`)));
}

// ───────────────────────────────────────────────────────────────── prices

/** The demo price (IQD) of a variant — before any deal. */
export function demoPrice(product: CatalogProduct, variant: CatalogVariant): number {
  if (product.kind === "digital") return digitalPrice(product, variant);
  const reference = defaultVariantOf(product);
  const base = within(bandOf(product), unitHash(`${product.slug}:price`));
  const factor =
    (capacityFactor(product, variant, reference) * editionFactorOf(variant) * chipFactorOf(product, variant)) / (editionFactorOf(reference) * chipFactorOf(product, reference));
  const jitter = variant === reference ? 1 : 1 + (unitHash(`${variant.sku}:price`) - 0.5) * 0.02;
  return roundToStep(base * factor * jitter);
}

/** Epoch ms of a catalogue date ("YYYY-MM-DD"): midnight in Baghdad. */
const dateAt = (date: string | undefined): number | null => (date ? Date.parse(`${date}T00:00:00Z`) - BAGHDAD_OFFSET_MS : null);

/** Epoch ms of a catalogue release date: midnight in Baghdad. */
export const releaseAtOf = (product: CatalogProduct): number | null => dateAt(product.releaseDate);

/** When a variant goes on sale: its own release date when it comes out after its product, else the product's. */
export const variantReleaseAtOf = (product: CatalogProduct, variant: CatalogVariant): number | null => dateAt(variant.releaseDate) ?? releaseAtOf(product);

const REFERENCE_AT = Date.parse(`${PRICE_REFERENCE_DATE}T00:00:00Z`) - BAGHDAD_OFFSET_MS;

/** A previous price needs a time it was charged: a deal only on items on sale this long before the research date. */
export const DEAL_MIN_DAYS_ON_SALE = 90;

/** On sale as a normal item since well before the research date: available, released long enough, physical. */
const onSaleAtReference = (product: CatalogProduct) =>
  product.status === "available" && product.kind !== "digital" && (releaseAtOf(product) ?? 0) <= REFERENCE_AT - DEAL_MIN_DAYS_ON_SALE * 24 * 60 * 60 * 1000;

/** The kinds that get one deal each. */
const DEAL_KINDS: readonly CatalogKind[] = ["console", "handheld_pc", "game", "controller", "headset", "storage", "accessory"];

/**
 * The SKUs that carry a previous price, with that price: per kind, the in-stock default variant that
 * ranks first by hash. A genuine-looking reduction of 8–18 %.
 */
export function demoDeals(products: readonly CatalogProduct[]): Map<string, number> {
  const deals = new Map<string, number>();
  for (const kind of DEAL_KINDS) {
    const candidates = products
      .filter((product) => product.kind === kind && onSaleAtReference(product))
      .map((product) => ({ product, variant: defaultVariantOf(product) }))
      .filter(({ product, variant }) => demoStock(product, variant, REFERENCE_AT).onHand > 0)
      .sort((a, b) => unitHash(`${a.variant.sku}:deal`) - unitHash(`${b.variant.sku}:deal`));
    const pick = candidates[0];
    if (!pick) continue;
    const price = demoPrice(pick.product, pick.variant);
    deals.set(pick.variant.sku, roundToStep(price * (1.08 + unitHash(`${pick.variant.sku}:deal-size`) * 0.1)));
  }
  return deals;
}

// ───────────────────────────────────────────────────────────────── costs

/** Margin policy per product kind (admin 03.03): a price may not be published below `minMarginBps`. */
export const KIND_MARGINS: Record<ProductKind, { minMarginBps: number; targetMarginBps: number }> = {
  console: { minMarginBps: 300, targetMarginBps: 800 },
  controller: { minMarginBps: 700, targetMarginBps: 1500 },
  headset: { minMarginBps: 800, targetMarginBps: 1700 },
  storage: { minMarginBps: 700, targetMarginBps: 1600 },
  accessory: { minMarginBps: 1200, targetMarginBps: 3000 },
  game: { minMarginBps: 800, targetMarginBps: 1700 },
  digital: { minMarginBps: 200, targetMarginBps: 500 },
  part: { minMarginBps: 1500, targetMarginBps: 4000 },
  bundle: { minMarginBps: 300, targetMarginBps: 800 },
};

export type DemoCost = { landedCostIqd: number; unitCostMinor: number; minMarginBps: number; targetMarginBps: number };

/** Landed cost as a share of the price: [lowest, highest]. Digital codes sell at face value, so they cost close to it. */
export const COST_SHARE: Readonly<Record<"digital" | "physical", readonly [number, number]>> = { digital: [0.92, 0.96], physical: [0.7, 0.85] };

/**
 * Landed cost of a variant: 70–85 % of its price (digital codes 92–96 %), a multiple of 250 IQD that
 * stays inside that band (plain rounding could step out of it: 84,750 × 0.70 rounds to 69.9 %).
 * 94 % of it is taken as the purchase price in US cents at the demo rate; the rest stands for
 * freight and customs.
 */
export function demoCost(kind: ProductKind, sku: string, priceIqd: number): DemoCost {
  const [low, high] = COST_SHARE[kind === "digital" ? "digital" : "physical"];
  const u = unitHash(`${sku}:cost`);
  const lowest = ceilToStep(priceIqd * low);
  const highest = Math.min(priceIqd - PRICE_STEP_IQD, floorToStep(priceIqd * high));
  const drawn = roundToStep(priceIqd * (low + u * (high - low)));
  // A band narrower than one step (prices under ~6,250 IQD for codes) keeps the plain rounding.
  const landedCostIqd = lowest <= highest ? Math.min(highest, Math.max(lowest, drawn)) : Math.min(priceIqd - PRICE_STEP_IQD, drawn);
  return { landedCostIqd, unitCostMinor: Math.round((landedCostIqd * 94) / DEMO_FX_RATE.iqdPerUnit), ...KIND_MARGINS[kind] };
}

// ───────────────────────────────────────────────────────────────── stock

/** At or below this many units an item is "low on stock". Digital codes have no reorder point (see DEMO_CODES_PER_VARIANT). */
export const REORDER_POINTS: Record<ProductKind, number | null> = {
  console: 2,
  controller: 3,
  headset: 2,
  storage: 3,
  accessory: 4,
  game: 3,
  digital: null,
  part: 3,
  bundle: null,
};
/** How far above the reorder point an in-stock item may sit. */
const IN_STOCK_SPAN: Record<ProductKind, number> = { console: 6, controller: 10, headset: 6, storage: 10, accessory: 12, game: 12, digital: 0, part: 8, bundle: 0 };

/** The store's product kind of a catalogue kind (handheld PCs are consoles; VR headsets accessories). */
export const productKindOf = (kind: CatalogKind): ProductKind => (kind === "handheld_pc" ? "console" : kind === "vr" ? "accessory" : kind);

export type DemoStock = { onHand: number; reorderPoint: number | null };

/**
 * DEMO codes of each digital variant (./codes.ts), and so its units on hand: one unit sold = one code delivered once
 * the order is paid (orders/digital.server.ts). Design QA 2026-11-12: with none on hand every gift card and
 * subscription read «نفد حالياً», and the digital template's orderable state could not be seen in the demo.
 */
export const DEMO_CODES_PER_VARIANT = 5;

/**
 * Demo codes (= units on hand) of each variant of a code product: DEMO_CODES_PER_VARIANT; the last 2 of a discontinued
 * or limited one (as for any discontinued item: 0–2 units — the Steam cards Valve stops selling through shops); none
 * while it is not out. 0 for anything that is not a code product.
 */
export function demoCodeCount(product: CatalogProduct): number {
  if (product.kind !== "digital" || product.status === "upcoming") return 0;
  return product.status === "discontinued" || product.status === "limited" ? 2 : DEMO_CODES_PER_VARIANT;
}

/** Units on hand at the main location for a variant, as of `now`. */
export function demoStock(product: CatalogProduct, variant: CatalogVariant, now: number): DemoStock {
  const kind = productKindOf(product.kind);
  const reorderPoint = REORDER_POINTS[kind];
  // a code product: its demo codes (no reorder point — codes are imported in batches, not reordered by count)
  if (product.kind === "digital") return { onHand: demoCodeCount(product), reorderPoint: null };
  if (reorderPoint === null) return { onHand: 0, reorderPoint: null };
  // Not out yet — the product, or this variant (a later colour or platform version): sold as a
  // pre-order (or not at all), never from stock.
  if (product.status === "upcoming" || (variantReleaseAtOf(product, variant) ?? 0) > now) return { onHand: 0, reorderPoint };
  const u = unitHash(`${variant.sku}:stock`);
  const v = unitHash(`${variant.sku}:units`);
  if (product.status === "discontinued" || product.status === "limited") return { onHand: u < 0.4 ? 0 : 1 + Math.floor(v * 2), reorderPoint };
  if (u < 0.08) return { onHand: 0, reorderPoint };
  if (u < 0.26) return { onHand: 1 + Math.floor(v * reorderPoint), reorderPoint };
  return { onHand: reorderPoint + 1 + Math.floor(v * IN_STOCK_SPAN[kind]), reorderPoint };
}

export const isPreorderAt = (product: CatalogProduct, now: number): boolean => product.status !== "upcoming" && (releaseAtOf(product) ?? 0) > now;

/** A subscription or gift card: what the code grants. */
export const licenseTypeOf = (product: CatalogProduct) => (product.kind !== "digital" ? null : isSubscription(product) ? ("subscription" as const) : ("wallet_topup" as const));
