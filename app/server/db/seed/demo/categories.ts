/**
 * DEMO category tree (admin 02.02). Products sit on the deepest fitting category, so a category page
 * lists its own products plus those of its children; `kind` is the navigation group and is the same
 * for a parent and its children. `categoryOf()` files every catalogue product.
 *
 * Games sold for PlayStation and Xbox in one product (a variant per platform) go to
 * "multiplatform-games": a product has one category, and filing them under one platform would hide
 * them from the other. A product may name its category itself (`category` in its research file: a gaming chair, a
 * keyboard, a UPS) — it must be a leaf of this tree. No catalogue game is Xbox-only, so "xbox-games" is empty for now; "parts" and
 * "used-devices" hold no products either (spare parts are not researched yet; used units are listed
 * through their own pages). The navigation hides empty categories.
 */
import type { CatalogProduct } from "./catalog/types";
import { t3, type T3 } from "./text";

export type CategorySeed = {
  slug: string;
  parent?: string;
  kind: string;
  name: T3;
  description?: T3;
  /** Product photo key ("<slug>--<n>") for the category tile, or null. */
  artKey: string | null;
};

export const DEMO_CATEGORIES: readonly CategorySeed[] = [
  {
    slug: "consoles",
    kind: "consoles",
    name: t3("أجهزة الألعاب", "Consoles", "ئامێرەکانی یاری"),
    description: t3(
      "أجهزة منزلية وهجينة من Nintendo و PlayStation و Xbox.",
      "Home and hybrid consoles from Nintendo, PlayStation and Xbox.",
      "ئامێری ماڵەوە و هایبرید لە Nintendo و PlayStation و Xbox.",
    ),
    artKey: "nintendo-switch-2--1",
  },
  { slug: "nintendo-consoles", parent: "consoles", kind: "consoles", name: t3("أجهزة Nintendo", "Nintendo consoles", "ئامێرەکانی Nintendo"), artKey: "nintendo-switch-2--1" },
  { slug: "playstation-consoles", parent: "consoles", kind: "consoles", name: t3("أجهزة PlayStation", "PlayStation consoles", "ئامێرەکانی PlayStation"), artKey: "playstation-5-slim--1" },
  { slug: "xbox-consoles", parent: "consoles", kind: "consoles", name: t3("أجهزة Xbox", "Xbox consoles", "ئامێرەکانی Xbox"), artKey: "xbox-series-x--1" },
  {
    slug: "handheld-pcs",
    kind: "handhelds",
    name: t3("حواسيب الألعاب المحمولة", "Handheld PCs", "کۆمپیوتەری یاریی دەستی"),
    description: t3(
      "حواسيب محمولة تشغّل ألعاب الحاسوب: Steam Deck و ROG Ally و ROG Xbox Ally و Legion Go و MSI Claw.",
      "Portable PCs that run PC games: Steam Deck, ROG Ally, ROG Xbox Ally, Legion Go and MSI Claw.",
      "کۆمپیوتەری دەستی کە یارییەکانی کۆمپیوتەر کارپێدەکەن: Steam Deck و ROG Ally و ROG Xbox Ally و Legion Go و MSI Claw.",
    ),
    artKey: "steam-deck-oled--1",
  },
  {
    slug: "games",
    kind: "games",
    name: t3("الألعاب", "Games", "یارییەکان"),
    description: t3(
      "نسخ فيزيائية من الألعاب: بطاقات Nintendo وأقراص PlayStation و Xbox.",
      "Physical games: Nintendo game cards and PlayStation and Xbox discs.",
      "وەشانی فیزیکیی یارییەکان: کارتی Nintendo و دیسکی PlayStation و Xbox.",
    ),
    artKey: "mario-kart-world--1",
  },
  { slug: "nintendo-games", parent: "games", kind: "games", name: t3("ألعاب Nintendo Switch", "Nintendo Switch games", "یارییەکانی Nintendo Switch"), artKey: "the-legend-of-zelda-tears-of-the-kingdom-nintendo-switch-2-edition--1" },
  { slug: "playstation-games", parent: "games", kind: "games", name: t3("ألعاب PlayStation", "PlayStation games", "یارییەکانی PlayStation"), artKey: "marvels-spider-man-2--1" },
  { slug: "xbox-games", parent: "games", kind: "games", name: t3("ألعاب Xbox", "Xbox games", "یارییەکانی Xbox"), artKey: "forza-horizon-6--1" },
  {
    slug: "multiplatform-games",
    parent: "games",
    kind: "games",
    name: t3("ألعاب PlayStation و Xbox", "PlayStation & Xbox games", "یارییەکانی PlayStation و Xbox"),
    description: t3(
      "ألعاب تُباع لـ PlayStation و Xbox: اختر نسخة جهازك من صفحة اللعبة.",
      "Games sold for both PlayStation and Xbox: choose your console's version on the game's page.",
      "ئەو یاریانەی بۆ PlayStation و Xbox دەفرۆشرێن: وەشانی ئامێرەکەت لە پەڕەی یارییەکەدا هەڵبژێرە.",
    ),
    artKey: "grand-theft-auto-vi--1",
  },
  {
    slug: "controllers",
    kind: "controllers",
    name: t3("أيدي التحكم", "Controllers", "دەسکەکانی یاری"),
    description: t3("أيدي تحكم أصلية لكل منصة.", "First-party controllers for every platform.", "دەسکی یاریی ئەسڵی بۆ هەموو پلاتفۆرمێک."),
    artKey: "dualsense--1",
  },
  {
    slug: "headsets",
    kind: "headsets",
    name: t3("سماعات الرأس", "Headsets", "هێدسێتەکان"),
    description: t3("سماعات لاسلكية للّعب والمحادثة.", "Wireless headsets for play and chat.", "هێدسێتی بێتەل بۆ یاری و گفتوگۆ."),
    artKey: "pulse-elite--1",
  },
  {
    slug: "storage",
    kind: "storage",
    name: t3("التخزين", "Storage", "بیرگە"),
    description: t3(
      "بطاقات ذاكرة وأقراص SSD لتوسيع مساحة جهازك.",
      "Memory cards and SSDs to expand your console's space.",
      "کارتی میمۆری و SSD بۆ فراوانکردنی بیرگەی ئامێرەکەت.",
    ),
    artKey: "sandisk-microsd-express--1",
  },
  {
    slug: "accessories",
    kind: "accessories",
    name: t3("الإكسسوارات", "Accessories", "پاشکۆکان"),
    description: t3(
      "قواعد ومقابض شحن، حقائب، حوامل، مشغّل الأقراص، كاميرا و PlayStation Portal.",
      "Charging stations and grips, cases, stands, the disc drive, a camera and PlayStation Portal.",
      "بنکە و دەسگرەی بارگاویکردن، جانتا، ڕاگر، خوێنەری دیسک، کامێرا و PlayStation Portal.",
    ),
    artKey: "dualsense-charging-station--1",
  },
  {
    slug: "vr",
    kind: "vr",
    name: t3("الواقع الافتراضي", "Virtual reality", "ڕاستیی مەجازی"),
    description: t3("نظارات الواقع الافتراضي وما يعمل معها.", "Virtual reality headsets.", "چاویلکەکانی ڕاستیی مەجازی."),
    artKey: "playstation-vr2--1",
  },
  // ── added for the owner's sheet (2026-11-18): PC gear, chairs, cables and power, lighting ──
  {
    slug: "pc-peripherals",
    kind: "pc",
    name: t3("ملحقات الحاسوب", "PC gaming gear", "پاشکۆکانی کۆمپیوتەر"),
    description: t3(
      "لوحات مفاتيح وماوس ولوحات ماوس ومايكروفونات وسماعات خارجية وشاشات ونظارات ألعاب.",
      "Keyboards, mice, mouse pads, microphones, speakers, monitors and gaming glasses.",
      "تەختەکلیل، ماوس، ماوس پاد، مایکرۆفۆن، سپیکەر، شاشە و چاویلکەی یاری.",
    ),
    artKey: "redragon-ucal-k673-pro--1",
  },
  { slug: "keyboards", parent: "pc-peripherals", kind: "pc", name: t3("لوحات المفاتيح", "Keyboards", "تەختەکلیلەکان"), artKey: "redragon-ucal-k673-pro--1" },
  { slug: "mice", parent: "pc-peripherals", kind: "pc", name: t3("الماوس", "Mice", "ماوسەکان"), artKey: "redragon-storm-pro-m808-ks--1" },
  { slug: "mouse-pads", parent: "pc-peripherals", kind: "pc", name: t3("لوحات الماوس", "Mouse pads", "ماوس پادەکان"), artKey: "redragon-p032-flick-xl--1" },
  { slug: "microphones", parent: "pc-peripherals", kind: "pc", name: t3("المايكروفونات", "Microphones", "مایکرۆفۆنەکان"), artKey: "hyperx-quadcast--3" },
  { slug: "speakers", parent: "pc-peripherals", kind: "pc", name: t3("السماعات الخارجية", "Speakers", "سپیکەرەکان"), artKey: "redragon-yorick-gs511--1" },
  { slug: "monitors", parent: "pc-peripherals", kind: "pc", name: t3("الشاشات", "Monitors", "شاشەکان"), artKey: "asus-tuf-gaming-vg249qm1a--1" },
  { slug: "gaming-glasses", parent: "pc-peripherals", kind: "pc", name: t3("نظارات الألعاب", "Gaming glasses", "چاویلکەی یاری"), artKey: null },
  {
    slug: "gaming-chairs",
    kind: "chairs",
    name: t3("كراسي الألعاب", "Gaming chairs", "کورسیی یاری"),
    description: t3("كراسي ألعاب مريحة للجلسات الطويلة.", "Gaming chairs for long sessions.", "کورسیی یاری بۆ دانیشتنی درێژ."),
    artKey: "dxracer-master-series--1",
  },
  {
    slug: "cables-power",
    kind: "cables",
    name: t3("الكابلات والطاقة", "Cables & power", "کێبڵ و وزە"),
    description: t3(
      "كابلات HDMI و USB ومحولات، وأجهزة UPS تحمي أجهزتك عند انقطاع الكهرباء.",
      "HDMI and USB cables, adapters, and UPS units that keep your setup running through power cuts.",
      "کێبڵی HDMI و USB و گۆڕەر، و ئامێری UPS کە ئامێرەکانت لە کاتی بڕانی کارەبادا دەپارێزێت.",
    ),
    artKey: null,
  },
  { slug: "cables", parent: "cables-power", kind: "cables", name: t3("الكابلات والمحولات", "Cables & adapters", "کێبڵ و گۆڕەر"), artKey: null },
  { slug: "ups-power", parent: "cables-power", kind: "cables", name: t3("أجهزة UPS والطاقة الاحتياطية", "UPS & backup power", "وزەی یەدەگ و UPS"), artKey: null },
  {
    slug: "lighting",
    kind: "lighting",
    name: t3("الإضاءة", "Lighting", "ڕووناکی"),
    description: t3("أشرطة إضاءة RGB لغرفة الألعاب والتلفاز.", "RGB light strips for your gaming room and TV.", "پەتی ڕووناکیی RGB بۆ ژووری یاری و تەلەفزیۆن."),
    artKey: null,
  },
  {
    slug: "digital-cards",
    kind: "digital",
    name: t3("بطاقات الشحن والاشتراكات", "Gift cards & subscriptions", "کارتی باڵانس و بەشداری"),
    description: t3(
      "أرصدة المتاجر واشتراكات PlayStation Plus و Game Pass على شكل رموز رقمية، تطابق دولة حسابك.",
      "Store credit and PlayStation Plus and Game Pass memberships as digital codes, matched to your account's country.",
      "باڵانسی فرۆشگا و بەشداریی PlayStation Plus و Game Pass وەک کۆدی دیجیتاڵ، گونجاو لەگەڵ وڵاتی هەژمارەکەت.",
    ),
    artKey: "playstation-store-gift-card--1",
  },
  { slug: "gift-cards", parent: "digital-cards", kind: "digital", name: t3("بطاقات الشحن", "Gift cards", "کارتی باڵانس"), artKey: "xbox-gift-card--1" },
  { slug: "subscriptions", parent: "digital-cards", kind: "digital", name: t3("الاشتراكات", "Subscriptions", "بەشدارییەکان"), artKey: "playstation-plus--1" },
  {
    slug: "parts",
    kind: "parts",
    name: t3("قطع الغيار", "Spare parts", "پارچەی یەدەگ"),
    description: t3(
      "قطع بديلة تُركَّب في ورشة الصيانة.",
      "Replacement parts fitted in the repair workshop.",
      "پارچەی جێگرەوە کە لە وەرشەی چاککردنەوە دادەنرێن.",
    ),
    artKey: null,
  },
  {
    slug: "used-devices",
    kind: "used",
    name: t3("الأجهزة المستعملة", "Used devices", "ئامێری بەکارهاتوو"),
    description: t3(
      "أجهزة مستعملة مفحوصة، بدرجة حالة معلنة لكل جهاز.",
      "Inspected used devices, each with a stated condition grade.",
      "ئامێری بەکارهاتووی پشکنراو، هەر یەکە بە پلەی دۆخی ڕاگەیەنراو.",
    ),
    artKey: "xbox-series-s--1",
  },
];

/** A category with no child category: the only kind a product is filed under. */
export const isLeafCategory = (slug: string): boolean => DEMO_CATEGORIES.some((category) => category.slug === slug) && !DEMO_CATEGORIES.some((category) => category.parent === slug);

/** A digital product sold by length of membership (PlayStation Plus, Game Pass) rather than by face value. */
export const isSubscription = (product: CatalogProduct): boolean => product.kind === "digital" && product.variants.some((variant) => variant.options?.duration !== undefined);

/** The category a catalogue product is filed under. */
export function categoryOf(product: CatalogProduct): string {
  // The research chose one (a chair, a keyboard, a UPS): it wins over the kind's default.
  if (product.category) return product.category;
  switch (product.kind) {
    case "console":
      if (product.platform === "nintendo" || product.platform === "playstation" || product.platform === "xbox") return `${product.platform}-consoles`;
      break;
    case "handheld_pc":
      return "handheld-pcs";
    case "game":
      if (product.platform === "multi") return "multiplatform-games";
      if (product.platform === "nintendo" || product.platform === "playstation" || product.platform === "xbox") return `${product.platform}-games`;
      break;
    case "controller":
      return "controllers";
    case "headset":
      return "headsets";
    case "storage":
      return "storage";
    case "accessory":
      return "accessories";
    case "vr":
      return "vr";
    case "digital":
      return isSubscription(product) ? "subscriptions" : "gift-cards";
  }
  throw new Error(`Demo seed: no category for "${product.slug}" (${product.kind} on ${product.platform}) — extend categoryOf() in app/server/db/seed/demo/categories.ts`);
}
