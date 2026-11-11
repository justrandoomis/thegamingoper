/**
 * DEMO search vocabulary: synonym sets for the search service and the extra keywords indexed with
 * each product (how shoppers in Iraq actually type things — "بلي ستيشن", "جوستك", "ميموري",
 * "فيفا" for EA SPORTS FC, "سويتش ٢", "ستيم ديك" — next to the official names).
 *
 * `search_synonyms` rows are EQUIVALENCE SETS: one row per set and language, `term` is the set's
 * main form and `synonyms` the other forms (other spellings, dialect words, the Latin form).
 * A query token that equals the term or any synonym may be expanded to all of them. Both columns
 * are stored normalized with normalizeSearchText(), like the index itself.
 */
import type { ProductKind } from "../../schema";
import type { SearchDoc } from "../../search.server";
import type { PlatformSlug } from "./devices";
import { SEED_LOCALES, t3, type SeedLocale, type T3 } from "./text";

// ───────────────────────────────────────────────────────────────── synonyms

/** First entry of each language = the term; the rest = its synonyms. */
export type SynonymGroup = { key: string; ar: readonly [string, ...string[]]; en: readonly [string, ...string[]]; ckb: readonly [string, ...string[]] };

export const DEMO_SYNONYM_GROUPS: readonly SynonymGroup[] = [
  // ── platforms and families
  {
    key: "playstation",
    ar: ["بلايستيشن", "بلي ستيشن", "بلاي ستيشن", "بليستيشن", "بلستيشن", "سوني", "بي اس", "ps", "playstation"],
    en: ["playstation", "play station", "ps", "sony"],
    ckb: ["پلەیستەیشن", "پلەی ستەیشن", "پلایستەیشن", "سۆنی", "پی ئێس", "playstation"],
  },
  {
    key: "ps5",
    ar: ["بلايستيشن 5", "بلي ستيشن 5", "بي اس 5", "سوني 5", "بلايستيشن فايف", "بلايستيشن ٥", "ps5"],
    en: ["ps5", "ps 5", "playstation 5", "playstation5"],
    ckb: ["پلەیستەیشن 5", "پی ئێس 5", "ps5"],
  },
  {
    key: "ps5-pro",
    ar: ["بلايستيشن 5 برو", "بلايستيشن ٥ برو", "بلي ستيشن 5 برو", "بي اس 5 برو", "سوني 5 برو", "ps5 pro"],
    en: ["ps5 pro", "ps5pro", "playstation 5 pro"],
    ckb: ["پلەیستەیشن 5 پرۆ", "پی ئێس 5 پرۆ", "ps5 pro"],
  },
  {
    key: "nintendo-switch",
    ar: ["سويتش", "سوتش", "ننتندو", "نينتندو", "نينتيندو", "switch", "nintendo"],
    en: ["switch", "nintendo", "nintendo switch", "nsw"],
    ckb: ["سویچ", "نینتێندۆ", "نینتەندۆ", "switch", "nintendo"],
  },
  {
    key: "switch-2",
    ar: ["سويتش 2", "سويتش ٢", "سوتش 2", "نينتندو سويتش 2", "ننتندو سويتش 2", "سويتش تو", "switch 2"],
    en: ["switch 2", "switch2", "nintendo switch 2", "ns2"],
    ckb: ["سویچ 2", "سویچ ٢", "نینتێندۆ سویچ 2", "switch 2"],
  },
  {
    key: "xbox",
    ar: ["اكس بوكس", "اكسبوكس", "ايكس بوكس", "مايكروسوفت", "xbox"],
    en: ["xbox", "x box", "microsoft"],
    ckb: ["ئێکس بۆکس", "ئێکسبۆکس", "ئیکس بۆکس", "مایکرۆسۆفت", "xbox"],
  },
  {
    key: "steam-deck",
    ar: ["ستيم ديك", "ستيم دك", "steam deck"],
    en: ["steam deck", "steamdeck", "deck"],
    ckb: ["ستیم دێک", "steam deck"],
  },
  {
    key: "rog-ally",
    ar: ["روج الاي", "روغ الاي", "روك الاي", "اسوس الاي", "rog ally"],
    en: ["rog ally", "rogally", "asus ally", "ally"],
    ckb: ["ڕۆگ ئەلای", "ئەسووس ئەلای", "rog ally"],
  },
  {
    key: "legion-go",
    ar: ["ليجن جو", "ليجن قو", "لينوفو ليجن", "legion go"],
    en: ["legion go", "legiongo", "lenovo legion"],
    ckb: ["لیجن گۆ", "لینۆڤۆ لیجن", "legion go"],
  },
  {
    key: "msi-claw",
    ar: ["ام اس اي كلو", "كلو", "msi claw"],
    en: ["msi claw", "claw"],
    ckb: ["ئێم ئێس ئای کلاو", "کلاو", "msi claw"],
  },
  {
    key: "ps-portal",
    ar: ["بورتال", "بلايستيشن بورتال", "portal"],
    en: ["portal", "playstation portal", "ps portal", "remote player"],
    ckb: ["پۆرتاڵ", "پلەیستەیشن پۆرتاڵ", "portal"],
  },
  {
    key: "vr",
    ar: ["واقع افتراضي", "نظارة واقع افتراضي", "في ار", "vr"],
    en: ["vr", "virtual reality", "psvr2", "ps vr2"],
    ckb: ["ڕاستیی مەجازی", "چاویلکەی ڕاستیی مەجازی", "vr"],
  },
  // ── kinds of product
  {
    key: "controller",
    ar: ["يد تحكم", "ذراع", "ذراع تحكم", "كنترولر", "كونترولر", "جويستك", "جوستك", "يدة", "قبضة", "controller"],
    en: ["controller", "gamepad", "joystick", "joypad", "pad"],
    ckb: ["دەسکی یاری", "دەستە", "کۆنترۆڵەر", "جۆیستیک", "controller"],
  },
  {
    key: "dualsense",
    ar: ["دوال سنس", "دول سنس", "دوالسنس", "dualsense"],
    en: ["dualsense", "dual sense", "ps5 controller"],
    ckb: ["دوال سێنس", "dualsense"],
  },
  {
    key: "joy-con",
    ar: ["جوي كون", "جويكون", "joy con"],
    en: ["joy con", "joycon"],
    ckb: ["جۆی کۆن", "joy con"],
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
    key: "microsd-express",
    ar: ["مايكرو اس دي", "مايكرو اس دي اكسبرس", "micro sd"],
    en: ["micro sd", "microsd", "microsd express", "sd express"],
    ckb: ["مایکرۆ ئێس دی", "micro sd"],
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
    key: "ps-plus",
    ar: ["بلايستيشن بلس", "بي اس بلس", "ps plus"],
    en: ["ps plus", "playstation plus", "psn plus"],
    ckb: ["پلەیستەیشن پلەس", "ps plus"],
  },
  {
    key: "game-pass",
    ar: ["قيم باس", "جيم باس", "اكس بوكس قيم باس", "game pass"],
    en: ["game pass", "gamepass", "xbox game pass"],
    ckb: ["گەیم پاس", "game pass"],
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
  // ── game names as people say them
  {
    key: "fifa",
    ar: ["فيفا", "فيفا 27", "اف سي", "اف سي 27", "fc 27", "fifa"],
    en: ["fifa", "fifa 27", "fc 27", "fc27", "ea fc", "ea sports fc"],
    ckb: ["فیفا", "فیفا 27", "ئێف سی", "fc 27", "fifa"],
  },
  {
    key: "gta",
    ar: ["جي تي اي", "جاتا", "جي تي ايه", "gta"],
    en: ["gta", "gta 6", "gta vi", "grand theft auto"],
    ckb: ["جی تی ئەی", "gta"],
  },
  {
    key: "call-of-duty",
    ar: ["كول اوف ديوتي", "كود", "cod"],
    en: ["cod", "call of duty", "modern warfare"],
    ckb: ["کۆڵ ئۆف دیوتی", "cod"],
  },
  {
    key: "mario",
    ar: ["ماريو", "سوبر ماريو", "mario"],
    en: ["mario", "super mario"],
    ckb: ["ماریۆ", "mario"],
  },
  {
    key: "zelda",
    ar: ["زيلدا", "زلدا", "zelda"],
    en: ["zelda", "legend of zelda"],
    ckb: ["زێڵدا", "zelda"],
  },
  {
    key: "pokemon",
    ar: ["بوكيمون", "بوكمون", "pokemon"],
    en: ["pokemon", "pokemon legends"],
    ckb: ["پۆکیمۆن", "pokemon"],
  },
  {
    key: "spider-man",
    ar: ["سبايدر مان", "سبايدرمان", "spider man"],
    en: ["spider man", "spiderman"],
    ckb: ["سپایدەر مان", "spider man"],
  },
  {
    key: "god-of-war",
    ar: ["قود اوف وار", "جود اوف وار", "god of war"],
    en: ["god of war", "gow"],
    ckb: ["گۆد ئۆف وۆڕ", "god of war"],
  },
  {
    key: "resident-evil",
    ar: ["ريزدنت ايفل", "رزدنت ايفل", "resident evil"],
    en: ["resident evil", "re9"],
    ckb: ["ڕێزیدێنت ئیڤڵ", "resident evil"],
  },
  {
    key: "red-dead",
    ar: ["ريد ديد", "ريد ديد ريدمبشن", "red dead"],
    en: ["red dead", "rdr2", "red dead redemption"],
    ckb: ["ڕێد دێد", "red dead"],
  },
  {
    key: "minecraft",
    ar: ["ماينكرافت", "ماين كرافت", "minecraft"],
    en: ["minecraft", "mine craft"],
    ckb: ["ماینکرافت", "minecraft"],
  },
];

// ───────────────────────────────────────────────────────────────── product keywords

/**
 * The synonym set of each platform. Its spellings are also indexed with every product of the
 * platform: the search helper (searchProductIds) matches the index as it is and expands no synonyms,
 * so a spelling that lives only in `search_synonyms` ("بليستيشن", "ايكس بوكس") would find nothing.
 */
const PLATFORM_SYNONYM_GROUP: Record<PlatformSlug, string | null> = { nintendo: "nintendo-switch", playstation: "playstation", xbox: "xbox", handheld: "handheld", pc: null };

const platformSpellings = (platform: PlatformSlug, locale: SeedLocale): string => {
  const key = PLATFORM_SYNONYM_GROUP[platform];
  return key ? (DEMO_SYNONYM_GROUPS.find((group) => group.key === key)?.[locale].join(" ") ?? "") : "";
};

const PLATFORM_KEYWORDS: Record<PlatformSlug, T3> = {
  nintendo: t3("ننتندو نينتندو سويتش سوتش", "nintendo switch", "نینتێندۆ سویچ"),
  playstation: t3("بلايستيشن بلي ستيشن بلاي ستيشن سوني بي اس", "playstation ps sony", "پلەیستەیشن سۆنی پی ئێس"),
  xbox: t3("اكس بوكس إكس بوكس اكسبوكس مايكروسوفت", "xbox microsoft", "ئێکس بۆکس ئێکسبۆکس مایکرۆسۆفت"),
  handheld: t3("محمول هاندهيلد حاسوب العاب محمول", "handheld portable pc", "دەستی هاندهێڵد کۆمپیوتەری دەستی"),
  pc: t3("حاسوب كمبيوتر ويندوز", "pc computer windows", "کۆمپیوتەر ویندۆز"),
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
  bundle: t3("حزمة باقة عرض طقم", "bundle set", "پاکێج سێت"),
};

/** Nicknames and transliterations of individual products (Arabic and Kurdish spellings people type). */
const PRODUCT_NICKNAMES: Readonly<Record<string, Partial<T3>>> = {
  "nintendo-switch-2": { ar: "سويتش 2 سوتش 2 سويتش ٢ نينتندو سويتش 2 ننتندو سويتش تو", en: "switch2 ns2", ckb: "سویچ 2 سویچ ٢ نینتێندۆ سویچ 2" },
  "nintendo-switch-2-mario-kart-world-bundle": { ar: "سويتش 2 ماريو كارت بكج", en: "switch 2 mario kart bundle", ckb: "سویچ 2 ماریۆ کارت پاکێج" },
  "nintendo-switch-2-pokemon-legends-z-a-bundle": { ar: "سويتش 2 بوكيمون بكج", en: "switch 2 pokemon bundle", ckb: "سویچ 2 پۆکیمۆن پاکێج" },
  "nintendo-switch-2-sports-resort-bundle": { ar: "سويتش 2 سبورتس بكج", en: "switch 2 sports bundle", ckb: "سویچ 2 سپۆرتس پاکێج" },
  "nintendo-switch-2-zelda-40th-anniversary-edition": { ar: "سويتش 2 زيلدا نسخة خاصة", en: "switch 2 zelda edition", ckb: "سویچ 2 زێڵدا" },
  "nintendo-switch-oled": { ar: "سويتش اوليد سوتش اوليد نينتندو سويتش أوليد", en: "switch oled", ckb: "سویچ ئۆلێد" },
  "nintendo-switch-lite": { ar: "سويتش لايت سوتش لايت", en: "switch lite", ckb: "سویچ لایت" },
  "nintendo-switch": { ar: "سويتش سوتش سويتش 1", en: "switch 1", ckb: "سویچ 1" },
  "playstation-5-pro": { ar: "بلايستيشن 5 برو بلي ستيشن 5 برو بي اس 5 برو بلايستيشن ٥ برو سوني 5 برو", en: "ps5 pro ps5pro", ckb: "پلەیستەیشن 5 پرۆ پی ئێس 5 پرۆ" },
  "playstation-5-slim": { ar: "بلايستيشن 5 سليم بلي ستيشن 5 بي اس 5 سوني 5 نسخة الاقراص", en: "ps5 slim disc", ckb: "پلەیستەیشن 5 سلیم پی ئێس 5" },
  "playstation-5-slim-digital-edition": { ar: "بلايستيشن 5 ديجيتال بي اس 5 ديجيتال سليم", en: "ps5 digital slim", ckb: "پلەیستەیشن 5 دیجیتاڵ" },
  "playstation-5": { ar: "بلايستيشن 5 بي اس 5 سوني 5 القديم", en: "ps5 original fat", ckb: "پلەیستەیشن 5 پی ئێس 5" },
  "playstation-portal": { ar: "بورتال بلايستيشن بورتال", en: "portal ps portal", ckb: "پۆرتاڵ" },
  "playstation-vr2": { ar: "نظارة بلايستيشن في ار 2 واقع افتراضي", en: "psvr2 ps vr2 vr", ckb: "چاویلکەی پلەیستەیشن ڕاستیی مەجازی" },
  "xbox-series-x": { ar: "اكس بوكس سيريس اكس اكسبوكس سيريس", en: "xsx series x", ckb: "ئێکس بۆکس سێریس ئێکس" },
  "xbox-series-s": { ar: "اكس بوكس سيريس اس اكسبوكس اس", en: "xss series s", ckb: "ئێکس بۆکس سێریس ئێس" },
  "xbox-series-x-digital": { ar: "اكس بوكس سيريس اكس ديجيتال", en: "xsx digital", ckb: "ئێکس بۆکس سێریس ئێکس دیجیتاڵ" },
  "xbox-series-x-2tb-galaxy-black": { ar: "اكس بوكس سيريس اكس جالاكسي", en: "xsx galaxy", ckb: "ئێکس بۆکس گالاکسی" },
  "xbox-series-x25-limited-edition": { ar: "اكس بوكس اكس 25 نسخة محدودة", en: "xsx x25 limited", ckb: "ئێکس بۆکس X25" },
  "steam-deck-oled": { ar: "ستيم ديك ستيم دك اوليد", en: "steamdeck deck oled", ckb: "ستیم دێک ئۆلێد" },
  "steam-deck-lcd": { ar: "ستيم ديك ستيم دك", en: "steamdeck deck lcd", ckb: "ستیم دێک" },
  "rog-ally": { ar: "روج الاي روغ الاي اسوس", en: "asus rog ally", ckb: "ڕۆگ ئەلای ئەسووس" },
  "rog-ally-x": { ar: "روج الاي اكس روغ الاي اسوس", en: "asus rog ally x", ckb: "ڕۆگ ئەلای ئێکس ئەسووس" },
  "rog-xbox-ally": { ar: "روج الاي اكس بوكس اسوس", en: "asus rog xbox ally", ckb: "ڕۆگ ئێکس بۆکس ئەلای" },
  "rog-xbox-ally-x": { ar: "روج الاي اكس بوكس اكس اسوس", en: "asus rog xbox ally x", ckb: "ڕۆگ ئێکس بۆکس ئەلای ئێکس" },
  "rog-xbox-ally-x20": { ar: "روج الاي اكس بوكس اكس 20 اسوس", en: "asus rog xbox ally x20", ckb: "ڕۆگ ئێکس بۆکس ئەلای X20" },
  "lenovo-legion-go": { ar: "ليجن جو ليجن قو لينوفو", en: "lenovo legion go", ckb: "لیجن گۆ لینۆڤۆ" },
  "lenovo-legion-go-2": { ar: "ليجن جو 2 ليجن قو 2 لينوفو", en: "lenovo legion go 2", ckb: "لیجن گۆ 2 لینۆڤۆ" },
  "lenovo-legion-go-s": { ar: "ليجن جو اس ليجن قو اس لينوفو", en: "lenovo legion go s", ckb: "لیجن گۆ ئێس لینۆڤۆ" },
  "msi-claw-8-ex-ai-plus": { ar: "ام اس اي كلو 8", en: "msi claw 8", ckb: "ئێم ئێس ئای کلاو 8" },
  "msi-claw-a8": { ar: "ام اس اي كلو اي 8", en: "msi claw a8", ckb: "ئێم ئێس ئای کلاو" },
  dualsense: { ar: "دوال سنس دول سنس يد بلايستيشن 5 جوستك بلايستيشن", en: "ps5 controller dual sense", ckb: "دوال سێنس دەسکی پلەیستەیشن" },
  "dualsense-edge": { ar: "دوال سنس ايدج يد احترافية", en: "edge pro controller", ckb: "دوال سێنس ئێج" },
  "xbox-wireless-controller": { ar: "يد اكس بوكس جوستك اكس بوكس", en: "xbox controller", ckb: "دەسکی ئێکس بۆکس" },
  "xbox-elite-series-2": { ar: "يد ايليت اكس بوكس", en: "elite controller", ckb: "دەسکی ئێلیت" },
  "joy-con-2": { ar: "جوي كون 2 جويكون", en: "joycon 2", ckb: "جۆی کۆن 2" },
  "nintendo-switch-2-pro-controller": { ar: "برو كنترولر سويتش 2", en: "pro controller switch 2", ckb: "پرۆ کۆنترۆڵەر سویچ 2" },
  "mario-kart-world": { ar: "ماريو كارت ماريو كارت ورلد", en: "mario kart", ckb: "ماریۆ کارت" },
  "grand-theft-auto-vi": { ar: "جي تي اي 6 جاتا 6 جي تي ايه", en: "gta 6 gta vi gta6", ckb: "جی تی ئەی 6" },
  "ea-sports-fc-27": { ar: "فيفا 27 فيفا اف سي 27", en: "fifa 27 fc27", ckb: "فیفا 27" },
  "ea-sports-fc-27-nintendo-switch-2": { ar: "فيفا 27 فيفا سويتش", en: "fifa 27 fc27 switch", ckb: "فیفا 27 سویچ" },
  "call-of-duty-modern-warfare-4": { ar: "كول اوف ديوتي كود مودرن وورفير", en: "cod mw4", ckb: "کۆڵ ئۆف دیوتی" },
  "marvels-spider-man-2": { ar: "سبايدر مان 2 سبايدرمان", en: "spiderman 2", ckb: "سپایدەر مان 2" },
  "god-of-war-ragnarok": { ar: "قود اوف وار راجناروك جود اوف وار", en: "gow ragnarok", ckb: "گۆد ئۆف وۆڕ" },
  "god-of-war-laufey": { ar: "قود اوف وار لوفي جود اوف وار", en: "gow laufey", ckb: "گۆد ئۆف وۆڕ" },
  "red-dead-redemption-2": { ar: "ريد ديد 2 ريد ديد ريدمبشن", en: "rdr2 red dead", ckb: "ڕێد دێد 2" },
  "resident-evil-requiem": { ar: "ريزدنت ايفل 9 رزدنت ايفل", en: "re9 resident evil 9", ckb: "ڕێزیدێنت ئیڤڵ" },
  minecraft: { ar: "ماينكرافت ماين كرافت", en: "mine craft", ckb: "ماینکرافت" },
  "forza-horizon-6": { ar: "فورزا هورايزن 6 فورزا", en: "forza 6 fh6", ckb: "فۆرزا" },
  "battlefield-6": { ar: "باتلفيلد 6 باتل فيلد", en: "bf6", ckb: "باتڵفیڵد" },
  "gran-turismo-7": { ar: "جران توريزمو قران توريزمو", en: "gt7", ckb: "گران تووریزمۆ" },
  "ghost-of-yotei": { ar: "جوست اوف يوتي قوست", en: "ghost yotei", ckb: "گۆست" },
  "elden-ring-nightreign": { ar: "الدن رنج ايلدن رينغ", en: "elden ring", ckb: "ئێلدن ڕینگ" },
  "nba-2k27": { ar: "ان بي اي 2كي", en: "nba 2k", ckb: "ئێن بی ئەی" },
  "the-legend-of-zelda-tears-of-the-kingdom-nintendo-switch-2-edition": { ar: "زيلدا زلدا تيرز اوف ذا كينجدم", en: "zelda totk", ckb: "زێڵدا" },
  "the-legend-of-zelda-breath-of-the-wild-nintendo-switch-2-edition": { ar: "زيلدا زلدا بريث اوف ذا وايلد", en: "zelda botw", ckb: "زێڵدا" },
  "the-legend-of-zelda-ocarina-of-time": { ar: "زيلدا زلدا اوكارينا", en: "zelda ocarina", ckb: "زێڵدا" },
  "pokemon-legends-z-a": { ar: "بوكيمون ليجندز", en: "pokemon za", ckb: "پۆکیمۆن" },
  "pokemon-pokopia": { ar: "بوكيمون بوكوبيا", en: "pokopia", ckb: "پۆکیمۆن" },
  "playstation-plus": { ar: "بلايستيشن بلس بي اس بلس اشتراك", en: "ps plus psn plus", ckb: "پلەیستەیشن پلەس بەشداری" },
  "xbox-game-pass": { ar: "قيم باس جيم باس اشتراك اكس بوكس", en: "gamepass", ckb: "گەیم پاس بەشداری" },
  "playstation-store-gift-card": { ar: "بطاقة بلايستيشن ستور كارت بلي ستيشن رصيد", en: "psn card playstation store card", ckb: "کارتی پلەیستەیشن" },
  "xbox-gift-card": { ar: "بطاقة اكس بوكس كارت اكس بوكس", en: "xbox card", ckb: "کارتی ئێکس بۆکس" },
  "nintendo-eshop-card": { ar: "بطاقة ايشوب كارت نينتندو", en: "eshop card nintendo card", ckb: "کارتی ئیشۆپ" },
  "steam-wallet-card": { ar: "بطاقة ستيم كارت ستيم", en: "steam card", ckb: "کارتی ستیم" },
  "sandisk-microsd-express": { ar: "ميموري سويتش 2 مايكرو اس دي اكسبرس", en: "micro sd express switch 2", ckb: "میمۆری سویچ 2" },
  "samsung-microsd-express-for-nintendo-switch-2": { ar: "ميموري سويتش 2 مايكرو اس دي سامسونج", en: "micro sd express switch 2", ckb: "میمۆری سویچ 2 سامسۆنگ" },
  "wd-black-sn850x": { ar: "هارد بلايستيشن 5 اس اس دي", en: "ssd nvme ps5", ckb: "هاردی پلەیستەیشن 5" },
  "samsung-990-pro-heatsink": { ar: "هارد بلايستيشن 5 اس اس دي سامسونج", en: "ssd nvme ps5", ckb: "هاردی پلەیستەیشن 5" },
  "sandisk-optimus-gx-pro-850p": { ar: "هارد بلايستيشن 5 اس اس دي", en: "ssd nvme ps5", ckb: "هاردی پلەیستەیشن 5" },
  "seagate-storage-expansion-card": { ar: "كارت توسعة اكس بوكس هارد اكس بوكس", en: "expansion card xbox", ckb: "کارتی فراوانکردنی ئێکس بۆکس" },
  "sandisk-optimus-gx-c50-expansion-card": { ar: "كارت توسعة اكس بوكس هارد اكس بوكس", en: "expansion card xbox", ckb: "کارتی فراوانکردنی ئێکس بۆکس" },
  "ps5-disc-drive": { ar: "مشغل اقراص مشغل الاقراص درايف ديسك قارئ اقراص", en: "disc drive blu-ray drive", ckb: "دڕایڤی دیسک خوێنەری دیسک" },
  "ps5-vertical-stand": { ar: "ستاند حامل عمودي قاعدة عمودية", en: "stand vertical stand", ckb: "ستاند ڕاگری ستوونی" },
  "dualsense-charging-station": { ar: "شاحن يد بلايستيشن شاحن دوال سنس قاعدة شحن", en: "controller charger charging dock", ckb: "بارگاویکەری دەسک" },
};

const words = (...parts: Array<string | null | undefined>) => parts.filter(Boolean).join(" ");

/** The words of a keyword list, each once, in order (the index matches words, not phrases). */
const uniqueWords = (text: string) => [...new Set(text.split(/\s+/).filter(Boolean))].join(" ");

/** What `productSearchKeywords` needs to know about a product. */
export type KeywordSource = { slug: string; kind: ProductKind; platforms: readonly PlatformSlug[]; extra?: Partial<T3> };

/** What goes into `products.search_keywords`: platform and kind vocabulary plus the product's own nicknames. */
export function productSearchKeywords(product: KeywordSource): T3 {
  const nicknames = PRODUCT_NICKNAMES[product.slug];
  const forLocale = (locale: SeedLocale) =>
    uniqueWords(
      words(
        ...product.platforms.map((platform) => words(PLATFORM_KEYWORDS[platform][locale], platformSpellings(platform, locale))),
        KIND_KEYWORDS[product.kind][locale],
        nicknames?.[locale],
        product.extra?.[locale],
      ),
    );
  return { ar: forLocale("ar"), en: forLocale("en"), ckb: forLocale("ckb") };
}

/** What `productSearchDocs` needs to know about a product. */
export type SearchSource = {
  name: T3;
  short: T3;
  description: T3;
  brand: string | null;
  searchKeywords: T3;
  /** SKUs, manufacturer model numbers and barcodes — staff search by them. */
  codes: readonly string[];
  variantTitles: ReadonlyArray<T3 | null>;
};

/**
 * The three `search_index` documents of a product (one per language). Arabic and Kurdish documents
 * also carry the English keywords, because shoppers mix scripts ("ps5 يد").
 */
export function productSearchDocs(product: SearchSource): SearchDoc[] {
  const codes = product.codes.join(" ");
  return SEED_LOCALES.map((locale) => ({
    locale,
    name: product.name[locale],
    keywords: words(product.brand, codes, product.searchKeywords[locale], locale === "en" ? null : product.searchKeywords.en),
    body: words(product.short[locale], product.description[locale], ...product.variantTitles.map((title) => title?.[locale])),
  }));
}

/** Keys of the product nickname table (the tests check each is a catalogue product). */
export const NICKNAMED_PRODUCTS: readonly string[] = Object.keys(PRODUCT_NICKNAMES);
