/**
 * DEMO store sets: bundles the STORE puts together from items it sells separately (admin 02.07 —
 * selling a set moves the stock of its components). They are store offers, like the demo coupons,
 * not researched products, and say so in their own text.
 *
 * Why there is one: every bundle in the researched catalogue is a sealed manufacturer box whose game
 * is a download code (Switch 2 + Mario Kart World, + Pokémon Legends: Z-A, + Switch Sports Resort) or
 * whose extras the store does not carry (ROG Xbox Ally X20 with XREAL glasses, the X25 console). The
 * store buys and stocks those boxes as units of their own, so they carry no `bundle_items`. This set
 * — the console and the Mario Kart World game card — is how the demo shows a real component bundle.
 * Delete the entry to drop it; nothing else depends on it except tests/commerce-cart.test.ts.
 */
import { t3, type T3 } from "./text";

export type StoreSetSeed = {
  slug: string;
  sku: string;
  name: T3;
  short: T3;
  description: T3;
  category: string;
  platform: "nintendo" | "playstation" | "xbox" | "handheld";
  /** The device model the set contains (its device hub lists the set). */
  deviceModel: string | null;
  components: ReadonlyArray<{ sku: string; qty: number }>;
  /** Photo keys of the components, main picture first. */
  images: readonly string[];
  keywords: T3;
};

export const DEMO_STORE_SETS: readonly StoreSetSeed[] = [
  {
    slug: "tamtam-set-switch-2-mario-kart-world",
    sku: "TT-SET-NS2-MKW",
    name: t3("طقم Nintendo Switch 2 مع Mario Kart World", "Nintendo Switch 2 + Mario Kart World set", "سێتی Nintendo Switch 2 لەگەڵ Mario Kart World"),
    short: t3(
      "طقم من المتجر: الجهاز (النسخة الدولية) + بطاقة لعبة Mario Kart World",
      "Store set: the console (international model) + the Mario Kart World game card",
      "سێتی فرۆشگا: ئامێرەکە (مۆدێلی نێودەوڵەتی) + کارتی یاریی Mario Kart World",
    ),
    description: t3(
      "طقم يجمعه المتجر من منتجين يبيعهما منفصلين: Nintendo Switch 2 بنسختها الدولية، ولعبة Mario Kart World على بطاقة لعبة. ليس حزمة Nintendo الرسمية (اللعبة فيها تنزيل رقمي)؛ هنا تحصل على بطاقة اللعبة نفسها. السعر عرض تجريبي.",
      "A set the store puts together from two items it sells separately: the international Nintendo Switch 2 and Mario Kart World on a game card. It is not Nintendo's own bundle (whose game is a digital download): here you get the game card itself. The price is a demo offer.",
      "سێتێک کە فرۆشگا لە دوو بەرهەم پێکی دەهێنێت کە بە جیا دەیانفرۆشێت: Nintendo Switch 2ی نێودەوڵەتی و یاریی Mario Kart World لەسەر کارتی یاری. ئەمە پاکێجی فەرمیی Nintendo نییە (کە یارییەکەی داگرتنی دیجیتاڵە)؛ لێرە کارتی یارییەکە خۆی وەردەگریت. نرخەکە پێشکەشکردنێکی تاقیکارییە.",
    ),
    category: "nintendo-consoles",
    platform: "nintendo",
    deviceModel: "switch-2",
    components: [
      { sku: "NS2-STD", qty: 1 },
      { sku: "NS2G-MARIO-KART-WORLD", qty: 1 },
    ],
    images: ["nintendo-switch-2--1", "mario-kart-world--1"],
    keywords: t3("طقم بكج عرض سويتش 2 ماريو كارت", "set bundle switch 2 mario kart", "سێت پاکێج سویچ 2 ماریۆ کارت"),
  },
];
