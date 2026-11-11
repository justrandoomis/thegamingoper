/**
 * DEMO search vocabulary: synonym sets for the search service and the extra keywords indexed with
 * each product (how shoppers in Iraq actually type things — "بلي ستيشن", "جوستك", "ميموري",
 * "فيفا" for EA SPORTS FC — next to the official names).
 *
 * `search_synonyms` rows are EQUIVALENCE SETS: one row per set and language, `term` is the set's
 * main form and `synonyms` the other forms (other spellings, dialect words, the Latin form).
 * A query token that equals the term or any synonym may be expanded to all of them. Both columns
 * are stored normalized with normalizeSearchText(), like the index itself.
 */
import type { ProductKind } from "../../schema";
import type { SearchDoc } from "../../search.server";
import type { PlatformSlug } from "./devices";
import type { ProductSeed } from "./products";
import { SEED_LOCALES, t3, type SeedLocale, type T3 } from "./text";

// ───────────────────────────────────────────────────────────────── synonyms

/** First entry of each language = the term; the rest = its synonyms. */
export type SynonymGroup = { key: string; ar: readonly [string, ...string[]]; en: readonly [string, ...string[]]; ckb: readonly [string, ...string[]] };

export const DEMO_SYNONYM_GROUPS: readonly SynonymGroup[] = [
  {
    key: "playstation",
    ar: ["بلايستيشن", "بلي ستيشن", "بلاي ستيشن", "بليستيشن", "سوني", "بي اس", "ps", "playstation"],
    en: ["playstation", "play station", "ps", "sony"],
    ckb: ["پلەیستەیشن", "پلەی ستەیشن", "پلایستەیشن", "سۆنی", "پی ئێس", "playstation"],
  },
  {
    key: "ps5",
    ar: ["بلايستيشن 5", "بلي ستيشن 5", "بي اس 5", "سوني 5", "بلايستيشن فايف", "ps5"],
    en: ["ps5", "ps 5", "playstation 5", "playstation5"],
    ckb: ["پلەیستەیشن 5", "پی ئێس 5", "ps5"],
  },
  {
    key: "nintendo-switch",
    ar: ["سويتش", "سوتش", "ننتندو", "نينتندو", "نينتيندو", "switch", "nintendo"],
    en: ["switch", "nintendo", "nintendo switch", "nsw"],
    ckb: ["سویچ", "نینتێندۆ", "نینتەندۆ", "switch", "nintendo"],
  },
  {
    key: "xbox",
    ar: ["اكس بوكس", "اكسبوكس", "ايكس بوكس", "مايكروسوفت", "xbox"],
    en: ["xbox", "x box", "microsoft"],
    ckb: ["ئێکس بۆکس", "ئێکسبۆکس", "ئیکس بۆکس", "مایکرۆسۆفت", "xbox"],
  },
  {
    key: "controller",
    ar: ["يد تحكم", "ذراع", "ذراع تحكم", "كنترولر", "كونترولر", "جويستك", "جوستك", "يدة", "قبضة", "controller"],
    en: ["controller", "gamepad", "joystick", "joypad", "pad"],
    ckb: ["دەسکی یاری", "دەستە", "کۆنترۆڵەر", "جۆیستیک", "controller"],
  },
  {
    key: "headset",
    ar: ["سماعة", "سماعات", "سماعة رأس", "هيدسيت", "هيدفون", "headset"],
    en: ["headset", "headphones", "headphone", "earphones"],
    ckb: ["هێدسێت", "هێدفۆن", "بیستۆک", "headset"],
  },
  {
    key: "storage",
    ar: ["ذاكرة", "ميموري", "ميموري كارد", "بطاقة ذاكرة", "كارت ميموري", "تخزين", "هارد", "memory"],
    en: ["memory", "memory card", "storage", "sd card", "ssd", "hard drive"],
    ckb: ["میمۆری", "بیرگە", "کارتی میمۆری", "هارد", "memory"],
  },
  {
    key: "used",
    ar: ["مستعمل", "مستعملة", "مستخدم", "يوزد", "used"],
    en: ["used", "second hand", "pre-owned", "preowned", "refurbished"],
    ckb: ["بەکارهاتوو", "دەستی دوو", "دەستی دووەم", "used"],
  },
  {
    key: "game",
    ar: ["لعبة", "ألعاب", "شريط", "سيدي", "دسك", "game"],
    en: ["game", "games", "cartridge"],
    ckb: ["یاری", "گەیم", "game"],
  },
  {
    key: "console",
    ar: ["جهاز", "أجهزة", "كونسول", "console"],
    en: ["console", "system"],
    ckb: ["ئامێر", "کۆنسۆڵ", "console"],
  },
  {
    key: "handheld",
    ar: ["محمول", "هاندهيلد", "جهاز محمول", "handheld"],
    en: ["handheld", "portable", "handheld pc"],
    ckb: ["دەستی", "هاندهێڵد", "handheld"],
  },
  {
    key: "charger",
    ar: ["شاحن", "شاحنة", "جارجر", "چارجر", "charger"],
    en: ["charger", "adapter", "power adapter"],
    ckb: ["بارگاویکەر", "چارجەر", "شارژەر", "charger"],
  },
  {
    key: "gift-card",
    ar: ["بطاقة رقمية", "بطاقة شحن", "كارت شحن", "رصيد", "ستور", "قسيمة", "gift card"],
    en: ["gift card", "top up", "wallet", "voucher", "store credit"],
    ckb: ["کارتی دیاری", "کارتی باڵانس", "باڵانس", "gift card"],
  },
  {
    key: "case",
    ar: ["حقيبة", "شنطة", "جنطة", "كفر", "حافظة", "case"],
    en: ["case", "bag", "pouch", "cover"],
    ckb: ["جانتا", "کیف", "بەرگ", "case"],
  },
  {
    key: "screen-protector",
    ar: ["واقي شاشة", "حماية شاشة", "لزقة شاشة", "سكرين", "screen protector"],
    en: ["screen protector", "tempered glass", "glass"],
    ckb: ["پارێزەری شاشە", "گلاس", "screen protector"],
  },
  {
    key: "spare-parts",
    ar: ["قطع غيار", "قطعة غيار", "قطع تبديل", "spare parts"],
    en: ["spare parts", "spare part", "replacement part", "parts"],
    ckb: ["پارچەی یەدەگ", "پارچەی جێگرەوە", "spare parts"],
  },
  {
    key: "dock",
    ar: ["قاعدة", "دوك", "قاعدة شحن", "dock"],
    en: ["dock", "docking station", "charging station"],
    ckb: ["بنکە", "دۆک", "dock"],
  },
  {
    key: "fifa",
    ar: ["فيفا", "فيفا 26", "اف سي", "اف سي 26", "fc 26", "fifa"],
    en: ["fifa", "fifa 26", "fc 26", "fc26", "ea fc", "ea sports fc"],
    ckb: ["فیفا", "ئێف سی", "fc 26", "fifa"],
  },
  {
    key: "steam-deck",
    ar: ["ستيم ديك", "ستيم دك", "steam deck"],
    en: ["steam deck", "steamdeck", "deck"],
    ckb: ["ستیم دێک", "steam deck"],
  },
];

// ───────────────────────────────────────────────────────────────── product keywords

const PLATFORM_KEYWORDS: Record<PlatformSlug, T3> = {
  nintendo: t3("ننتندو نينتندو سويتش سوتش", "nintendo switch", "نینتێندۆ سویچ"),
  playstation: t3("بلايستيشن بلي ستيشن بلاي ستيشن سوني بي اس", "playstation ps sony", "پلەیستەیشن سۆنی پی ئێس"),
  xbox: t3("اكس بوكس إكس بوكس اكسبوكس مايكروسوفت", "xbox microsoft", "ئێکس بۆکس ئێکسبۆکس مایکرۆسۆفت"),
  handheld: t3("محمول هاندهيلد حاسوب العاب محمول", "handheld portable pc", "دەستی هاندهێڵد کۆمپیوتەری دەستی"),
};

const KIND_KEYWORDS: Record<ProductKind, T3> = {
  console: t3("جهاز العاب كونسول", "console system", "ئامێری یاری کۆنسۆڵ"),
  controller: t3("يد تحكم ذراع كنترولر جويستك جوستك يدة قبضة", "controller gamepad joystick pad", "دەسکی یاری دەستە کۆنترۆڵەر جۆیستیک"),
  headset: t3("سماعة سماعات هيدسيت هيدفون سماعة رأس", "headset headphones", "هێدسێت هێدفۆن بیستۆک"),
  storage: t3("ذاكرة ميموري تخزين هارد بطاقة ذاكرة", "memory storage", "میمۆری بیرگە هارد"),
  accessory: t3("ملحقات اكسسوارات", "accessories accessory", "پاشکۆ ئێکسسوارات"),
  game: t3("لعبة العاب شريط قرص سيدي", "game disc cartridge", "یاری گەیم دیسک"),
  digital: t3("بطاقة رقمية رصيد كود شحن ستور قسيمة", "gift card code top up wallet voucher", "کارت باڵانس کۆد"),
  part: t3("قطع غيار قطعة غيار صيانة تصليح", "spare part replacement repair", "پارچەی یەدەگ چاککردنەوە"),
  bundle: t3("حزمة باقة عرض", "bundle", "پاکێج"),
};

const words = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" ");

/** What goes into `products.search_keywords`: platform and kind vocabulary plus the product's own nicknames. */
export function productSearchKeywords(product: ProductSeed): T3 {
  const forLocale = (locale: SeedLocale) =>
    words(product.platform ? PLATFORM_KEYWORDS[product.platform][locale] : null, KIND_KEYWORDS[product.kind][locale], product.keywords?.[locale]);
  return { ar: forLocale("ar"), en: forLocale("en"), ckb: forLocale("ckb") };
}

/**
 * The three `search_index` documents of a product (one per language). Arabic and Kurdish documents
 * also carry the English keywords, because shoppers mix scripts ("ps5 يد").
 */
export function productSearchDocs(product: ProductSeed): SearchDoc[] {
  const keywords = productSearchKeywords(product);
  const skus = product.variants.map((variant) => variant.sku).join(" ");
  return SEED_LOCALES.map((locale) => ({
    locale,
    name: product.name[locale],
    keywords: words(product.brand, skus, keywords[locale], locale === "en" ? null : keywords.en),
    body: words(product.short[locale], product.description[locale], ...product.variants.map((variant) => variant.title?.[locale])),
  }));
}
