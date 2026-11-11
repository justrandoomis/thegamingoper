/**
 * DEMO category tree (admin 02.02): ten top-level categories, with consoles and games split by
 * platform. Products sit on the deepest fitting category, so a category page lists its own
 * products plus those of its children. `kind` is the navigation group and is the same for a parent
 * and its children.
 */
import { t3, type T3 } from "./text";

export type CategorySeed = {
  slug: string;
  parent?: string;
  kind: string;
  name: T3;
  description?: T3;
  /** Art key in scripts/art/catalog.json for the category tile. */
  artKey: string;
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
    artKey: "switch-2",
  },
  { slug: "nintendo-consoles", parent: "consoles", kind: "consoles", name: t3("أجهزة Nintendo", "Nintendo consoles", "ئامێرەکانی Nintendo"), artKey: "switch-2" },
  { slug: "playstation-consoles", parent: "consoles", kind: "consoles", name: t3("أجهزة PlayStation", "PlayStation consoles", "ئامێرەکانی PlayStation"), artKey: "ps5-slim" },
  { slug: "xbox-consoles", parent: "consoles", kind: "consoles", name: t3("أجهزة Xbox", "Xbox consoles", "ئامێرەکانی Xbox"), artKey: "xbox-series-x" },
  {
    slug: "handheld-pcs",
    kind: "handhelds",
    name: t3("حواسيب الألعاب المحمولة", "Handheld PCs", "کۆمپیوتەری یاریی دەستی"),
    description: t3(
      "حواسيب محمولة تشغّل ألعاب الحاسوب: Steam Deck و ROG Ally و Legion Go.",
      "Portable PCs that run PC games: Steam Deck, ROG Ally and Legion Go.",
      "کۆمپیوتەری دەستی کە یارییەکانی کۆمپیوتەر کارپێدەکەن: Steam Deck و ROG Ally و Legion Go.",
    ),
    artKey: "steam-deck-oled",
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
    artKey: "game-mario-kart-world",
  },
  { slug: "nintendo-games", parent: "games", kind: "games", name: t3("ألعاب Nintendo Switch", "Nintendo Switch games", "یارییەکانی Nintendo Switch"), artKey: "game-zelda-tears-of-the-kingdom" },
  { slug: "playstation-games", parent: "games", kind: "games", name: t3("ألعاب PlayStation", "PlayStation games", "یارییەکانی PlayStation"), artKey: "game-spider-man-2" },
  { slug: "xbox-games", parent: "games", kind: "games", name: t3("ألعاب Xbox", "Xbox games", "یارییەکانی Xbox"), artKey: "game-forza-horizon-5" },
  {
    slug: "controllers",
    kind: "controllers",
    name: t3("أيدي التحكم", "Controllers", "دەسکەکانی یاری"),
    description: t3("أيدي تحكم أصلية لكل منصة.", "First-party controllers for every platform.", "دەسکی یاریی ئەسڵی بۆ هەموو پلاتفۆرمێک."),
    artKey: "dualsense-white",
  },
  {
    slug: "headsets",
    kind: "headsets",
    name: t3("سماعات الرأس", "Headsets", "هێدسێتەکان"),
    description: t3("سماعات لاسلكية للّعب والمحادثة.", "Wireless headsets for play and chat.", "هێدسێتی بێتەل بۆ یاری و گفتوگۆ."),
    artKey: "headset-white",
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
    artKey: "microsd-express",
  },
  {
    slug: "accessories",
    kind: "accessories",
    name: t3("الملحقات", "Accessories", "پاشکۆکان"),
    description: t3(
      "قواعد شحن، حقائب، واقيات شاشة وشواحن.",
      "Charging docks, cases, screen protectors and chargers.",
      "بنکەی بارگاویکردن، جانتا، پارێزەری شاشە و بارگاویکەر.",
    ),
    artKey: "charging-station",
  },
  {
    slug: "digital-cards",
    kind: "digital",
    name: t3("البطاقات الرقمية", "Digital cards", "کارتە دیجیتاڵییەکان"),
    description: t3(
      "أرصدة متاجر PlayStation و Nintendo و Xbox على شكل رموز رقمية.",
      "PlayStation, Nintendo and Xbox store credit as digital codes.",
      "باڵانسی فرۆشگاکانی PlayStation و Nintendo و Xbox وەک کۆدی دیجیتاڵی.",
    ),
    artKey: "gift-card-playstation",
  },
  {
    slug: "parts",
    kind: "parts",
    name: t3("قطع الغيار", "Spare parts", "پارچەی یەدەگ"),
    description: t3(
      "قطع بديلة تُركَّب في ورشة الصيانة.",
      "Replacement parts fitted in the repair workshop.",
      "پارچەی جێگرەوە کە لە وەرشەی چاککردنەوە دادەنرێن.",
    ),
    artKey: "part-thumbstick",
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
    artKey: "xbox-series-s",
  },
];
