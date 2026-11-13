/**
 * Card facts — the pure rules behind what a product card says beyond its database row (design v2 spec §4.7, §4.11,
 * §6.2, §7.5, §9). Client-safe: no server imports, so loaders, the kit and tests may use these too. The catalogue
 * read layer (./cards.server, ./listing.server, ./product.server) applies them; callers receive the results on
 * ProductCardData / ImageRef (~/lib/dto) and never re-derive them.
 *
 *   isNewProduct({ releasedOn: "2026-10-29", listedAt, isDemo: true, now })   released ≤ 30 days ago → true
 *   shoppingTier({ preorder: false, st: 1 })                                     2 in stock · 1 coming soon · 0 sold out
 *   kindLabelOf({ kind: "console", families, ownPlatform: "playstation" }, "ar") «جهاز PS5»
 *   opaqueOf("pulse-3d--2")                                                      { background: "#ffffff", tone: "light" }
 *   shortModelName("ps5-slim-digital", "PlayStation 5 Slim Digital Edition")      "PS5 Slim Digital"
 *
 * HONESTY (spec §9, §13 row 8):
 *   · «جديد» only from real dates: the researched release date (attributes.catalogue.releaseDate), or the listing time
 *     of a row that is not demo. A demo row's listing time is the seed's clock (every demo product was "listed" the
 *     day the database was seeded), so it never makes a demo product new.
 *   · A coming-soon product is never "new" (its release is ahead), and a sold-out one carries no badge.
 */
import { getArt, isPhoto } from "~/art";
import type { ImageRef } from "~/lib/dto";
import { pick, type L10n, type Locale } from "~/lib/locales";
import { baghdadMidnight } from "./product-types";

export const DAY_MS = 86_400_000;

/** «جديد» lasts this many days after the release, or after a real listing. */
export const NEW_WINDOW_DAYS = 30;

// ───────────────────────────────────────────────────────────────── «جديد»

export type NewInput = {
  /** The researched release date, "YYYY-MM-DD" (00:00 Baghdad). */
  releasedOn: string | null | undefined;
  /** When the product was listed (published_at, else created_at), epoch ms. */
  listedAt: number | null | undefined;
  /** A demo row: its listing time is the seed's, not a fact. */
  isDemo: boolean;
  now: number;
};

/**
 * Released, or really listed, within the last NEW_WINDOW_DAYS days (both ends inclusive). A product whose release is
 * still ahead is not new (it is coming soon).
 */
export function isNewProduct({ releasedOn, listedAt, isDemo, now }: NewInput): boolean {
  const window = NEW_WINDOW_DAYS * DAY_MS;
  const released = baghdadMidnight(releasedOn ?? null);
  if (released !== null && released > now) return false;
  if (released !== null && now - released <= window) return true;
  return !isDemo && typeof listedAt === "number" && Number.isFinite(listedAt) && listedAt <= now && now - listedAt <= window;
}

// ───────────────────────────────────────────────────────────────── the shopping tier («المقترَح»)

/**
 * Where a product stands for the suggested order (spec §6.2): 2 = can be bought now (in stock or low), 1 = coming soon
 * (its release is ahead; the store takes no pre-orders), 0 = sold out. `st` is the stock rank 0 out · 1 low · 2 in.
 */
export function shoppingTier({ preorder, st }: { preorder: boolean; st: number }): 0 | 1 | 2 {
  if (preorder) return 1;
  return st > 0 ? 2 : 0;
}

/** Stock rank as a card reports it: a demo row never says "low" (its stock is a placeholder, so is its scarcity). */
export const shownStockRank = (st: number, isDemo: boolean): 0 | 1 | 2 => (st <= 0 ? 0 : st >= 2 || isDemo ? 2 : 1);

// ───────────────────────────────────────────────────────────────── the kind label

/** A device family the product is for: a device generation ("ps5"), or a whole platform (a platform-wide rule). */
export type DeviceFamily = {
  /** Generation slug, null for a platform-wide fact. */
  generation: string | null;
  /** The generation's own name (localized JSON text) — the fallback for a family the table below does not know. */
  generationName?: string | null;
  generationSort: number;
  platform: string;
  platformName?: string | null;
  platformSort: number;
};

/** Short family names, the same in every language (Latin names stay Latin). A new generation falls back to its own name. */
const FAMILY_NAMES: Readonly<Record<string, string>> = {
  "switch-2": "Switch 2",
  switch: "Switch",
  ps5: "PS5",
  "xbox-series": "Xbox Series X|S",
  "steam-deck": "Steam Deck",
  "rog-ally": "ROG Ally",
  "rog-xbox-ally": "ROG Xbox Ally",
  "legion-go": "Legion Go",
  "msi-claw": "MSI Claw",
  "windows-pc": "PC",
};

/**
 * Short device-model names for tight places — the mega menu's model column and the platform hub's model switcher
 * (spec §5.4 "short model names, not SKU titles", §6.2 "PS5 Pro · PS5 Slim · PS5 Slim Digital · PlayStation Portal ·
 * PS VR2"). The platform's name already stands beside them, so its brand word is dropped ("Switch 2", "Series X");
 * names that are short already stay whole. The same in every language (Latin names stay Latin); the qualifier of the
 * 2020 PS5 models becomes the year. A model this table does not know keeps its full name (shortModelName).
 */
const MODEL_SHORT_NAMES: Readonly<Record<string, string>> = {
  "switch-2": "Switch 2",
  "switch-oled": "Switch OLED",
  switch: "Switch",
  "switch-lite": "Switch Lite",
  "ps5-pro": "PS5 Pro",
  "ps5-slim": "PS5 Slim",
  "ps5-slim-digital": "PS5 Slim Digital",
  ps5: "PS5 (2020)",
  "ps5-digital": "PS5 Digital (2020)",
  "ps-portal": "PlayStation Portal",
  "ps-vr2": "PS VR2",
  "xbox-series-x": "Series X",
  "xbox-series-x-digital": "Series X Digital",
  "xbox-series-s": "Series S",
  "steam-deck-oled": "Steam Deck OLED",
  "steam-deck-lcd": "Steam Deck LCD",
  "rog-xbox-ally-x": "ROG Xbox Ally X",
  "rog-xbox-ally": "ROG Xbox Ally",
  "rog-ally-x": "ROG Ally X",
  "rog-ally": "ROG Ally",
  "legion-go-2": "Legion Go 2",
  "legion-go-s": "Legion Go S",
  "legion-go": "Legion Go",
  "msi-claw-8-ex-ai-plus": "MSI Claw 8 EX AI+",
  "msi-claw-a8": "MSI Claw A8",
};

/** A device model's short name (MODEL_SHORT_NAMES), else its full name as given. */
export function shortModelName(slug: string, fullName: string): string {
  return MODEL_SHORT_NAMES[slug] ?? fullName;
}

/** Platform names on the card line, as the glossary writes them (spec §9): Latin in every language. */
const PLATFORM_NAMES: Readonly<Record<string, L10n>> = {
  nintendo: { ar: "Nintendo", en: "Nintendo", ckb: "Nintendo" },
  playstation: { ar: "PlayStation", en: "PlayStation", ckb: "PlayStation" },
  xbox: { ar: "Xbox", en: "Xbox", ckb: "Xbox" },
  handheld: { ar: "الأجهزة المحمولة", en: "Handheld PCs", ckb: "ئامێرە دەستییەکان" },
};

/**
 * What the product is, per kind. `of` = the Sorani construct (ezafe) form placed before a family name; `tight` = the
 * noun takes the family straight after it in Arabic and Sorani («جهاز PS5», «لعبة Switch 2»); the others put « · »
 * between («يد تحكم · PS5»). English always uses « · » ("Controller · PS5", "Console · PS5").
 * Sorani strings follow the store's ckb register and are flagged for the native reader (spec §13 row 10).
 */
type Noun = { ar: string; en: string; ckb: string; of?: string; tight?: boolean };
const NOUNS: Readonly<Record<string, Noun>> = {
  console: { ar: "جهاز", en: "Console", ckb: "ئامێر", of: "ئامێری", tight: true },
  handheld_pc: { ar: "جهاز محمول", en: "Handheld PC", ckb: "ئامێری دەستی" },
  game: { ar: "لعبة", en: "Game", ckb: "یاری", of: "یاریی", tight: true },
  controller: { ar: "يد تحكم", en: "Controller", ckb: "دەسکی یاری" },
  headset: { ar: "سماعة", en: "Headset", ckb: "هێدسێت" },
  vr: { ar: "نظارة واقع افتراضي", en: "VR headset", ckb: "چاویلکەی VR" },
  storage: { ar: "تخزين", en: "Storage", ckb: "بیرگە" },
  accessory: { ar: "إكسسوار", en: "Accessory", ckb: "پاشکۆ" },
  digital: { ar: "رمز رقمي", en: "Digital code", ckb: "کۆدی دیجیتاڵ" },
  part: { ar: "قطعة غيار", en: "Spare part", ckb: "پارچەی یەدەگ" },
  bundle: { ar: "حزمة", en: "Bundle", ckb: "باندڵ" },
};
const MULTI: L10n = { ar: "متعددة المنصات", en: "Multi-platform", ckb: "فرە پلاتفۆرم" };

/** Research kinds that say more than products.kind (handheld PCs are stored as consoles, VR as accessories). */
const RESEARCH_NOUNS = new Set(["handheld_pc", "vr"]);

export type KindLabelInput = {
  kind: string;
  /** attributes.catalogue.kind of a researched product ("handheld_pc", "vr", …). */
  researchKind?: string | null;
  /** The device families the product is for (any order; duplicates allowed). */
  families: readonly DeviceFamily[];
  /** Platforms the product is for (the store's researched platforms). When given, families of other platforms are dropped. */
  forPlatforms?: readonly string[];
  /** The product's own platform (platform_id) — the target when no family is known. */
  ownPlatform?: string | null;
  ownPlatformName?: string | null;
};

const parseL10n = (text: string | null | undefined): L10n | null => {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && typeof (value as L10n).ar === "string" ? (value as L10n) : null;
  } catch {
    return null;
  }
};

const familyName = (family: DeviceFamily, locale: Locale): string =>
  (family.generation ? FAMILY_NAMES[family.generation] : undefined) ??
  (family.generation ? pick(parseL10n(family.generationName), locale) : "") ??
  "";

const platformName = (slug: string, raw: string | null | undefined, locale: Locale): string =>
  pick(PLATFORM_NAMES[slug] ?? parseL10n(raw), locale) || slug;

/**
 * What the device part of the label says: «متعددة المنصات» when the product is for two platforms or more; the
 * family names when it is for one or two families of one platform ("PS5", "Switch 2 · Switch"); the platform's name
 * when it is for a whole platform (a platform-wide rule, more than two families, or nothing more precise known).
 */
export function kindTarget(input: KindLabelInput, locale: Locale): { text: string; multi: boolean } | null {
  const allowed = input.forPlatforms && input.forPlatforms.length > 0 ? new Set(input.forPlatforms) : null;
  const families = input.families.filter((family) => !allowed || allowed.has(family.platform));
  const platforms = [...new Set(families.map((family) => family.platform))];
  if (platforms.length >= 2 || (allowed && allowed.size >= 2)) return { text: pick(MULTI, locale), multi: true };
  if (platforms.length === 1) {
    const ordered = [...families].sort((a, b) => a.generationSort - b.generationSort || String(a.generation).localeCompare(String(b.generation)));
    const named = [...new Set(ordered.filter((family) => family.generation !== null).map((family) => familyName(family, locale)).filter(Boolean))];
    const wholePlatform = families.some((family) => family.generation === null);
    if (!wholePlatform && named.length >= 1 && named.length <= 2) return { text: named.join(" · "), multi: false };
    const first = families[0];
    return { text: platformName(first.platform, first.platformName, locale), multi: false };
  }
  if (input.ownPlatform) return { text: platformName(input.ownPlatform, input.ownPlatformName, locale), multi: false };
  if (allowed && allowed.size === 1) return { text: platformName([...allowed][0], null, locale), multi: false };
  return null;
}

/** The card's platform line: «جهاز PS5», «لعبة Switch 2», «يد تحكم · PS5», «سماعة · متعددة المنصات» (spec §4.11). */
export function kindLabelOf(input: KindLabelInput, locale: Locale): string {
  const key = input.researchKind && RESEARCH_NOUNS.has(input.researchKind) ? input.researchKind : input.kind;
  const noun = NOUNS[key] ?? NOUNS.accessory;
  const target = kindTarget(input, locale);
  const bare = locale === "en" ? noun.en : locale === "ckb" ? noun.ckb : noun.ar;
  if (!target) return bare;
  if (locale === "en" || !noun.tight) return `${bare} · ${target.text}`;
  return `${locale === "ckb" ? (noun.of ?? noun.ckb) : noun.ar} ${target.text}`;
}

// ───────────────────────────────────────────────────────────────── the qualifier (spec §4.11)

/**
 * The words a Latin title leaves out (products.attributes.qualifier, from the catalogue's `qualifier`): «نسخة الأقراص»
 * for «PlayStation 5 Slim · 1TB», «الطراز الأصلي» for «PlayStation 5 (2020)». An Arabic or Sorani qualifier inside the
 * Latin name made the runs reorder in RTL rows, so surfaces print it on the meta or kind line instead (spec §4.11:
 * "never into the Latin title"). `attributes` is the column as stored (JSON text) or parsed; "" when there is none
 * for this language.
 */
export function qualifierOf(attributes: unknown, locale: Locale): string {
  let value: unknown = attributes;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      return "";
    }
  }
  const qualifier = value && typeof value === "object" ? (value as { qualifier?: unknown }).qualifier : undefined;
  if (!qualifier || typeof qualifier !== "object") return "";
  const text = (qualifier as Partial<Record<Locale, unknown>>)[locale];
  return typeof text === "string" ? text.trim() : "";
}

/**
 * A meta line that opens with the qualifier: qualifiedLine("نسخة الأقراص", "قارئ أقراص … · DualSense في العلبة")
 * → «نسخة الأقراص · قارئ أقراص … · DualSense في العلبة» (facts joined by " · ", as the cards split them). Either
 * part may be empty; null when both are.
 */
export function qualifiedLine(qualifier: string | null | undefined, line: string | null | undefined): string | null {
  const parts = [qualifier?.trim(), line?.trim()].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : null;
}

// ───────────────────────────────────────────────────────────────── opaque photos (spec §7.5)

/** CIE L* (0–100) of an sRGB "#rrggbb". */
export function lightnessOf(hex: string): number | null {
  const match = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!match) return null;
  const [r, g, b] = match.slice(1, 4).map((part) => {
    const c = parseInt(part, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

/**
 * The opaque-photo flag of a catalogue photo (ImageRef.opaque): set when the photo kept its own background instead
 * of being cut out — an object on a plain box (`background` "#rrggbb") or a picture that fills its frame (`background`
 * null) — unless it is box art or a screenshot, which are framed rectangles by design. Null for cut-outs, for keys
 * without a built photo and for anything else. `tone`: "light" when the box (else the picture's dominant colour) has
 * L* ≥ 50.
 */
export function opaqueOf(artKey: string | null | undefined): NonNullable<ImageRef["opaque"]> | null {
  if (!artKey) return null;
  const art = getArt(artKey);
  if (!isPhoto(art) || art.transparent || art.kind === "box-art" || art.kind === "screenshot") return null;
  const lightness = lightnessOf(art.background ?? art.dominant ?? "") ?? 100;
  return { background: art.background ?? null, tone: lightness >= 50 ? "light" : "dark" };
}

/** The ref with its opaque-photo flag (only when there is one, so cut-outs keep their shape). */
export function withOpaque(ref: ImageRef): ImageRef {
  const opaque = ref.artKey ? opaqueOf(ref.artKey) : null;
  return opaque ? { ...ref, opaque } : ref;
}
