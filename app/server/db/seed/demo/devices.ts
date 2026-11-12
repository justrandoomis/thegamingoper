/**
 * DEMO device knowledge graph: platforms → generations → device models.
 *
 * Every device the researched catalogue names exists here: the device a console or handheld product
 * IS (its `deviceModel`, or its `family` where one `deviceModel` value covers several different
 * devices — the two MSI Claw models), and every device key its compatibility lists and game
 * platform lists use. A model takes its name from this table and everything else — specifications,
 * pictures, release date, fact line — from the catalogue product that is that device (`product`,
 * plus `variant` when one product covers two models: the 2020 PS5 disc and Digital Editions).
 * `windows-pc` is the generic target of the catalogue's PC compatibility notes; it has no product,
 * belongs to the inactive "pc" platform (not in the storefront menus) and carries no specifications.
 *
 * Specifications are stored as researched: `specs[key]` is the localized value and carries its
 * localized `label` (`{ ar, en, ckb, label: { ar, en, ckb } }`, see ./import.ts), so a device hub can
 * show the sheet without a translation table of its own.
 */
import type { DeviceKind } from "../../schema";
import type { CatalogProduct } from "./catalog/types";
import { same, t3, type T3 } from "./text";

// ───────────────────────────────────────────────────────────────── platforms

export type PlatformSlug = "nintendo" | "playstation" | "xbox" | "handheld" | "pc";

/**
 * `accent` is the design-token name of the platform light (`--gel-<accent>`); `artKey` a product
 * photo key for the platform tile. The "pc" platform only anchors the generic Windows PC target and
 * is not shown in the storefront (is_active = 0).
 */
export type PlatformSeed = { slug: PlatformSlug; name: T3; accent: string; artKey: string | null; isActive: boolean };

export const DEMO_PLATFORMS: readonly PlatformSeed[] = [
  // Platform names follow the copy glossary (Design System v2 §9, DESIGN.md): the three brands are written in Latin in
  // every language; their Arabic and Sorani spellings stay searchable through the synonym groups (search.ts).
  { slug: "nintendo", name: same("Nintendo"), accent: "nintendo", artKey: "nintendo-switch-2--1", isActive: true },
  { slug: "playstation", name: same("PlayStation"), accent: "playstation", artKey: "playstation-5-slim--1", isActive: true },
  { slug: "xbox", name: same("Xbox"), accent: "xbox", artKey: "xbox-series-x--1", isActive: true },
  { slug: "handheld", name: t3("الأجهزة المحمولة", "Handheld PCs", "کۆمپیوتەری یاریی دەستی"), accent: "handheld", artKey: "steam-deck-oled--1", isActive: true },
  { slug: "pc", name: t3("الحاسوب الشخصي", "PC", "کۆمپیوتەری کەسی"), accent: "brand", artKey: null, isActive: false },
];

/** Catalogue platform → store platform. "multi" products (sold for several platforms) have none. */
export const PLATFORM_OF_CATALOG: Record<CatalogProduct["platform"], PlatformSlug | null> = {
  nintendo: "nintendo",
  playstation: "playstation",
  xbox: "xbox",
  pc_handheld: "handheld",
  multi: null,
};

// ───────────────────────────────────────────────────────────────── generations

export type GenerationSeed = { slug: string; platform: PlatformSlug; name: T3 };

export const DEMO_GENERATIONS: readonly GenerationSeed[] = [
  { slug: "switch-2", platform: "nintendo", name: same("Nintendo Switch 2") },
  { slug: "switch", platform: "nintendo", name: t3("عائلة Nintendo Switch", "Nintendo Switch family", "خێزانی Nintendo Switch") },
  { slug: "ps5", platform: "playstation", name: t3("جيل PlayStation 5", "PlayStation 5 generation", "نەوەی PlayStation 5") },
  { slug: "xbox-series", platform: "xbox", name: same("Xbox Series X|S") },
  { slug: "steam-deck", platform: "handheld", name: same("Steam Deck") },
  { slug: "rog-ally", platform: "handheld", name: same("ROG Ally") },
  { slug: "rog-xbox-ally", platform: "handheld", name: same("ROG Xbox Ally") },
  { slug: "legion-go", platform: "handheld", name: same("Lenovo Legion Go") },
  { slug: "msi-claw", platform: "handheld", name: same("MSI Claw") },
  { slug: "windows-pc", platform: "pc", name: t3("حواسيب Windows", "Windows PCs", "کۆمپیوتەرەکانی Windows") },
];

// ───────────────────────────────────────────────────────────────── device models

export type DeviceModelSeed = {
  slug: string;
  platform: PlatformSlug;
  generation: string;
  name: T3;
  /** Selects the inspection template for used units and trade-ins. */
  deviceKind: DeviceKind;
  /** Catalogue product that is this device: specifications, pictures, release date and fact line. */
  product: string | null;
  /** The variant of `product` that is this device, when the product covers two models. */
  variant?: string;
  /** Only for a model without a product. */
  summary?: T3;
};

export const DEMO_DEVICE_MODELS: readonly DeviceModelSeed[] = [
  { slug: "switch-2", platform: "nintendo", generation: "switch-2", name: same("Nintendo Switch 2"), deviceKind: "console", product: "nintendo-switch-2" },
  { slug: "switch-oled", platform: "nintendo", generation: "switch", name: same("Nintendo Switch – OLED Model"), deviceKind: "console", product: "nintendo-switch-oled" },
  { slug: "switch", platform: "nintendo", generation: "switch", name: same("Nintendo Switch"), deviceKind: "console", product: "nintendo-switch" },
  { slug: "switch-lite", platform: "nintendo", generation: "switch", name: same("Nintendo Switch Lite"), deviceKind: "console", product: "nintendo-switch-lite" },
  { slug: "ps5-pro", platform: "playstation", generation: "ps5", name: same("PlayStation 5 Pro"), deviceKind: "console", product: "playstation-5-pro" },
  { slug: "ps5-slim", platform: "playstation", generation: "ps5", name: same("PlayStation 5 Slim"), deviceKind: "console", product: "playstation-5-slim" },
  { slug: "ps5-slim-digital", platform: "playstation", generation: "ps5", name: same("PlayStation 5 Slim Digital Edition"), deviceKind: "console", product: "playstation-5-slim-digital-edition" },
  {
    slug: "ps5",
    platform: "playstation",
    generation: "ps5",
    // a Latin title stays Latin (design v2 spec §4.11: «PlayStation 5 (الطراز» / «الأصلي 2020)» reordered in RTL rows);
    // the year says which model, as the short name «PS5 (2020)» does
    name: same("PlayStation 5 (2020)"),
    deviceKind: "console",
    product: "playstation-5",
    variant: "PS5-ORIG-DISC",
  },
  {
    slug: "ps5-digital",
    platform: "playstation",
    generation: "ps5",
    name: same("PlayStation 5 Digital Edition (2020)"),
    deviceKind: "console",
    product: "playstation-5",
    variant: "PS5-ORIG-DIGITAL",
  },
  // A remote player, not a console — but it is graded with the console checklist (screen, battery, sticks).
  { slug: "ps-portal", platform: "playstation", generation: "ps5", name: same("PlayStation Portal"), deviceKind: "console", product: "playstation-portal" },
  { slug: "ps-vr2", platform: "playstation", generation: "ps5", name: same("PlayStation VR2"), deviceKind: "other", product: "playstation-vr2" },
  { slug: "xbox-series-x", platform: "xbox", generation: "xbox-series", name: same("Xbox Series X"), deviceKind: "console", product: "xbox-series-x" },
  { slug: "xbox-series-x-digital", platform: "xbox", generation: "xbox-series", name: same("Xbox Series X Digital Edition"), deviceKind: "console", product: "xbox-series-x-digital" },
  { slug: "xbox-series-s", platform: "xbox", generation: "xbox-series", name: same("Xbox Series S"), deviceKind: "console", product: "xbox-series-s" },
  { slug: "steam-deck-oled", platform: "handheld", generation: "steam-deck", name: same("Steam Deck OLED"), deviceKind: "handheld_pc", product: "steam-deck-oled" },
  { slug: "steam-deck-lcd", platform: "handheld", generation: "steam-deck", name: same("Steam Deck LCD"), deviceKind: "handheld_pc", product: "steam-deck-lcd" },
  { slug: "rog-xbox-ally-x", platform: "handheld", generation: "rog-xbox-ally", name: same("ROG Xbox Ally X"), deviceKind: "handheld_pc", product: "rog-xbox-ally-x" },
  { slug: "rog-xbox-ally", platform: "handheld", generation: "rog-xbox-ally", name: same("ROG Xbox Ally"), deviceKind: "handheld_pc", product: "rog-xbox-ally" },
  { slug: "rog-ally-x", platform: "handheld", generation: "rog-ally", name: same("ROG Ally X"), deviceKind: "handheld_pc", product: "rog-ally-x" },
  { slug: "rog-ally", platform: "handheld", generation: "rog-ally", name: same("ROG Ally"), deviceKind: "handheld_pc", product: "rog-ally" },
  { slug: "legion-go-2", platform: "handheld", generation: "legion-go", name: same("Lenovo Legion Go 2"), deviceKind: "handheld_pc", product: "lenovo-legion-go-2" },
  { slug: "legion-go-s", platform: "handheld", generation: "legion-go", name: same("Lenovo Legion Go S"), deviceKind: "handheld_pc", product: "lenovo-legion-go-s" },
  { slug: "legion-go", platform: "handheld", generation: "legion-go", name: same("Lenovo Legion Go"), deviceKind: "handheld_pc", product: "lenovo-legion-go" },
  { slug: "msi-claw-8-ex-ai-plus", platform: "handheld", generation: "msi-claw", name: same("MSI Claw 8 EX AI+"), deviceKind: "handheld_pc", product: "msi-claw-8-ex-ai-plus" },
  { slug: "msi-claw-a8", platform: "handheld", generation: "msi-claw", name: same("MSI Claw A8"), deviceKind: "handheld_pc", product: "msi-claw-a8" },
  {
    slug: "windows-pc",
    platform: "pc",
    generation: "windows-pc",
    name: t3("حاسوب Windows", "Windows PC", "کۆمپیوتەری Windows"),
    deviceKind: "other",
    product: null,
    summary: t3(
      "أي حاسوب يعمل بنظام Windows. ملاحظات التوافق مع الحاسوب لأيدي التحكم والسماعات والتخزين والبطاقات الرقمية تشير إليه.",
      "Any PC running Windows. The PC compatibility notes of controllers, headsets, storage and store cards point here.",
      "هەر کۆمپیوتەرێک کە Windows کار پێدەکات. تێبینییەکانی گونجان لەگەڵ کۆمپیوتەر بۆ دەسک، هێدسێت، بیرگە و کارتە دیجیتاڵییەکان ئاماژە بەمە دەکەن.",
    ),
  },
];

export const deviceModelBySlug = (slug: string): DeviceModelSeed => {
  const model = DEMO_DEVICE_MODELS.find((entry) => entry.slug === slug);
  if (!model) throw new Error(`Demo seed: unknown device model "${slug}" — add it to app/server/db/seed/demo/devices.ts`);
  return model;
};

/**
 * The device model each catalogue product IS (`null` for everything that is not a device). Normally
 * the product's `deviceModel`; when one `deviceModel` value is shared by products of different
 * families (a product line such as "msi-claw", whose models differ in chip, memory and battery),
 * each family is its own device model and the shared value is their generation.
 */
export function deviceModelsOfProducts(products: readonly CatalogProduct[]): Map<string, string | null> {
  const families = new Map<string, Set<string>>();
  for (const product of products) {
    if (!product.deviceModel) continue;
    const set = families.get(product.deviceModel) ?? new Set<string>();
    set.add(product.family ?? product.deviceModel);
    families.set(product.deviceModel, set);
  }
  const result = new Map<string, string | null>();
  for (const product of products) {
    if (!product.deviceModel) result.set(product.slug, null);
    else result.set(product.slug, (families.get(product.deviceModel)?.size ?? 1) > 1 && product.family ? product.family : product.deviceModel);
  }
  return result;
}
