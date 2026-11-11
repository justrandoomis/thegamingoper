/**
 * DEMO catalogue — digital wallet top-ups and spare parts.
 *
 * Top-ups: the products exist so the digital flow can be designed, but NO codes are seeded
 * (codes are stored encrypted with DATA_KEY by the digital-codes service, and inventing codes
 * would be selling something that does not exist). Stock is therefore 0 until real codes are
 * loaded in the admin.
 *
 * Parts: generic replacement parts for the repair workshop. They are never offered as a
 * do-it-yourself fix — the text says so — and their compatibility is "unverified" until a
 * technician has matched the part to a device.
 */
import { same, t3, type T3 } from "../text";
import type { ProductSeed, VariantSeed } from "./types";

const CODE_SHORT = t3(
  "رمز رقمي يضيف رصيداً بالدولار إلى حسابك",
  "A digital code that adds US-dollar credit to your account",
  "کۆدێکی دیجیتاڵی کە باڵانس بە دۆلار بۆ هەژمارەکەت زیاد دەکات",
);

/** `$10`, `$25`… denominations of a US-region top-up; SKU "<prefix>-<value>". */
const denominations = (prefix: string, values: ReadonlyArray<readonly [usd: number, priceIqd: number]>): VariantSeed[] =>
  values.map(([usd, priceIqd]) => ({
    sku: `${prefix}-${usd}`,
    title: same(`$${usd}`),
    options: { value: String(usd), currency: "USD" },
    priceIqd,
    stock: 0,
  }));

export const DIGITAL_PRODUCTS: readonly ProductSeed[] = [
  {
    slug: "playstation-store-wallet-top-up-us",
    kind: "digital",
    name: t3(
      "رصيد محفظة PlayStation Store (حساب أمريكي)",
      "PlayStation Store Wallet Top-Up (US account)",
      "باڵانسی جزدانی PlayStation Store (هەژماری ئەمریکی)",
    ),
    short: CODE_SHORT,
    description: t3(
      "رمز رقمي، لا بطاقة ورقية. يضيف قيمته إلى محفظة PlayStation Store لشراء الألعاب والإضافات والاشتراكات. يعمل مع الحسابات المسجَّلة في الولايات المتحدة فقط؛ تأكد من منطقة حسابك قبل الشراء.",
      "A digital code, not a physical card. It adds its value to your PlayStation Store wallet for games, add-ons and subscriptions. It works only with accounts registered in the United States; check your account's region before you buy.",
      "کۆدێکی دیجیتاڵییە، نەک کارتی کاغەزی. بەهاکەی بۆ جزدانی PlayStation Store زیاد دەکات بۆ کڕینی یاری و زیادکراو و بەشداریکردن. تەنها لەگەڵ ئەو هەژمارانە کاردەکات کە لە ویلایەتە یەکگرتووەکان تۆمارکراون؛ پێش کڕین ناوچەی هەژمارەکەت بپشکنە.",
    ),
    brand: "Sony",
    platform: "playstation",
    category: "digital-cards",
    region: "US",
    licenseType: "wallet_topup",
    mediaFormat: "digital",
    art: ["gift-card-playstation"],
    keywords: { ar: "بطاقة بلايستيشن ستور كارت بلايستيشن رصيد بلايستيشن بي اس ان ستور امريكي", en: "psn card playstation gift card wallet code", ckb: "کارتی پلەیستەیشن باڵانسی پلەیستەیشن" },
    variants: denominations("PSN-US", [
      [10, 14_000],
      [25, 34_500],
      [50, 68_000],
    ]),
  },
  {
    slug: "nintendo-eshop-card-us",
    kind: "digital",
    name: t3("بطاقة Nintendo eShop (حساب أمريكي)", "Nintendo eShop Card (US account)", "کارتی Nintendo eShop (هەژماری ئەمریکی)"),
    short: CODE_SHORT,
    description: t3(
      "رمز رقمي يضيف قيمته إلى رصيد Nintendo eShop لشراء الألعاب والإضافات على Switch و Switch 2. يعمل مع حسابات Nintendo المضبوطة على الولايات المتحدة فقط؛ تأكد من منطقة حسابك قبل الشراء.",
      "A digital code that adds its value to your Nintendo eShop balance for games and add-ons on Switch and Switch 2. It works only with Nintendo Accounts set to the United States; check your account's region before you buy.",
      "کۆدێکی دیجیتاڵی کە بەهاکەی بۆ باڵانسی Nintendo eShop زیاد دەکات بۆ کڕینی یاری و زیادکراو لەسەر Switch و Switch 2. تەنها لەگەڵ ئەو هەژمارانەی Nintendo کاردەکات کە لەسەر ویلایەتە یەکگرتووەکان ڕێکخراون؛ پێش کڕین ناوچەی هەژمارەکەت بپشکنە.",
    ),
    brand: "Nintendo",
    platform: "nintendo",
    category: "digital-cards",
    region: "US",
    licenseType: "wallet_topup",
    mediaFormat: "digital",
    art: ["gift-card-nintendo"],
    keywords: { ar: "بطاقة نينتندو ايشوب كارت ننتندو رصيد سويتش اي شوب ستور امريكي", en: "eshop card nintendo gift card code", ckb: "کارتی نینتێندۆ ئی‌شۆپ" },
    variants: denominations("ESHOP-US", [
      [10, 14_000],
      [20, 27_500],
      [50, 68_000],
    ]),
  },
  {
    slug: "xbox-gift-card-us",
    kind: "digital",
    name: t3("بطاقة هدايا Xbox (حساب أمريكي)", "Xbox Gift Card (US account)", "کارتی دیاریی Xbox (هەژماری ئەمریکی)"),
    short: CODE_SHORT,
    description: t3(
      "رمز رقمي يضيف قيمته إلى رصيد حساب Microsoft لشراء الألعاب والإضافات من متجر Xbox. يعمل مع الحسابات المضبوطة على الولايات المتحدة فقط؛ تأكد من منطقة حسابك قبل الشراء.",
      "A digital code that adds its value to your Microsoft account balance for games and add-ons from the Xbox store. It works only with accounts set to the United States; check your account's region before you buy.",
      "کۆدێکی دیجیتاڵی کە بەهاکەی بۆ باڵانسی هەژماری Microsoft زیاد دەکات بۆ کڕینی یاری و زیادکراو لە فرۆشگای Xbox. تەنها لەگەڵ ئەو هەژمارانە کاردەکات کە لەسەر ویلایەتە یەکگرتووەکان ڕێکخراون؛ پێش کڕین ناوچەی هەژمارەکەت بپشکنە.",
    ),
    brand: "Microsoft",
    platform: "xbox",
    category: "digital-cards",
    region: "US",
    licenseType: "wallet_topup",
    mediaFormat: "digital",
    art: ["gift-card-xbox"],
    keywords: { ar: "بطاقة اكس بوكس كارت اكس بوكس رصيد اكس بوكس قفت كارد ستور امريكي", en: "xbox gift card code microsoft", ckb: "کارتی ئێکس بۆکس باڵانسی ئێکس بۆکس" },
    variants: denominations("XBX-US", [
      [10, 14_000],
      [25, 34_500],
      [50, 68_000],
    ]),
  },
];

const WORKSHOP_ONLY: T3 = t3("قطعة غيار تُركَّب في الورشة فقط", "A spare part fitted in the workshop only", "پارچەیەکی یەدەگ کە تەنها لە وەرشە دادەنرێت");

export const PART_PRODUCTS: readonly ProductSeed[] = [
  {
    slug: "dualsense-analog-stick-module",
    kind: "part",
    name: t3("وحدة عصا تحكم بديلة ليد DualSense", "Replacement Analog Stick Module for DualSense", "یەکەی جۆیستیکی جێگرەوە بۆ دەسکی DualSense"),
    short: t3(
      "قطعة غيار تُركَّب في الورشة — تحتاج لحاماً",
      "A spare part fitted in the workshop — needs soldering",
      "پارچەیەکی یەدەگ کە لە وەرشە دادەنرێت — پێویستی بە لەحیمکردن هەیە",
    ),
    description: t3(
      "وحدة عصا بديلة غير أصلية لعلاج الانحراف الناتج عن تآكل الوحدة الأصلية. تركيبها يتطلب فتح اليد وفكّ لحام الوحدة القديمة، وهو عمل للفني ويُبطل ضمان اليد إن أُجري خارج مركز معتمد. احجز صيانة ونركّبها لك.",
      "A third-party replacement stick module for drift caused by wear of the original. Fitting it means opening the controller and desoldering the old module — work for a technician, and it voids the controller's warranty if done outside an authorised centre. Book a repair and we fit it for you.",
      "یەکەیەکی جۆیستیکی جێگرەوەی نائەسڵی بۆ چارەسەری ئەو لادانەی بەهۆی داخورانی یەکە ئەسڵییەکەوە دروست دەبێت. دانانی پێویستی بە کردنەوەی دەسکەکە و لابردنی لەحیمی یەکە کۆنەکە هەیە، ئەمەش کاری تەکنیکارە و ئەگەر لە دەرەوەی ناوەندێکی ڕێپێدراو بکرێت گەرەنتیی دەسکەکە بەتاڵ دەکاتەوە. چاککردنەوە تۆمار بکە و بۆت دادەنێین.",
    ),
    platform: "playstation",
    category: "parts",
    art: ["part-thumbstick"],
    keywords: { ar: "قطعة غيار يد بلايستيشن جوستك انالوج تصليح انحراف يد", en: "analog stick replacement drift repair part", ckb: "پارچەی دەسکی پلەیستەیشن جۆیستیک" },
    variants: [{ sku: "PART-DS-STICK", priceIqd: 7_500, stock: 20 }],
  },
  {
    slug: "steam-deck-oled-replacement-battery",
    kind: "part",
    name: t3("بطارية بديلة لـ Steam Deck OLED", "Replacement Battery for Steam Deck OLED", "پاتریی جێگرەوە بۆ Steam Deck OLED"),
    short: WORKSHOP_ONLY,
    description: t3(
      "بطارية ليثيوم بديلة غير أصلية بسعة البطارية الأصلية (50 واط ساعي). لا تستبدل البطارية بنفسك: بطاريات الليثيوم قد تشتعل إذا ثُقبت أو انثنت أثناء نزعها. نطابق القطعة مع جهازك ونركّبها في الورشة.",
      "A third-party replacement lithium battery with the capacity of the original (50Wh). Do not replace the battery yourself: lithium batteries can catch fire if punctured or bent while being removed. We match the part to your device and fit it in the workshop.",
      "پاتریی لیتیۆمی جێگرەوەی نائەسڵی بە هەمان توانای پاتریی ئەسڵی (50 وات‌کاتژمێر). خۆت پاترییەکە مەگۆڕە: پاتریی لیتیۆم ئەگەر لە کاتی دەرهێناندا کون ببێت یان بچەمێتەوە دەتوانێت ئاگر بگرێت. پارچەکە لەگەڵ ئامێرەکەت بەراورد دەکەین و لە وەرشە دایدەنێین.",
    ),
    platform: "handheld",
    deviceModel: "steam-deck-oled",
    category: "parts",
    specs: { capacity_wh: 50 },
    art: ["part-battery"],
    keywords: { ar: "بطارية ستيم ديك بطارية بديلة قطعة غيار", en: "steam deck battery replacement part", ckb: "پاتریی ستیم دێک" },
    variants: [{ sku: "PART-SDO-BATT", priceIqd: 45_000, stock: 2 }],
  },
  {
    slug: "ps5-slim-replacement-cooling-fan",
    kind: "part",
    name: t3(
      "مروحة تبريد بديلة لـ PlayStation 5 (النموذج النحيف)",
      "Replacement Cooling Fan for PlayStation 5 (Slim)",
      "پانکەی ساردکەرەوەی جێگرەوە بۆ PlayStation 5 (مۆدێلی باریک)",
    ),
    short: WORKSHOP_ONLY,
    description: t3(
      "مروحة بديلة غير أصلية للأجهزة التي صار صوت مروحتها مرتفعاً أو توقفت عن الدوران. تركيبها يتطلب فتح الجهاز، وهذا يُبطل الضمان إن أُجري خارج مركز معتمد. نطابق القطعة مع جهازك ونركّبها في الورشة.",
      "A third-party replacement fan for consoles whose fan has become loud or stopped spinning. Fitting it means opening the console, which voids the warranty if done outside an authorised centre. We match the part to your console and fit it in the workshop.",
      "پانکەیەکی جێگرەوەی نائەسڵی بۆ ئەو ئامێرانەی دەنگی پانکەکەیان بەرز بووەتەوە یان لە سووڕان وەستاوە. دانانی پێویستی بە کردنەوەی ئامێرەکە هەیە، ئەمەش ئەگەر لە دەرەوەی ناوەندێکی ڕێپێدراو بکرێت گەرەنتی بەتاڵ دەکاتەوە. پارچەکە لەگەڵ ئامێرەکەت بەراورد دەکەین و لە وەرشە دایدەنێین.",
    ),
    platform: "playstation",
    deviceModel: "ps5-slim",
    category: "parts",
    art: ["part-fan"],
    keywords: { ar: "مروحة بلايستيشن 5 مروحة بي اس 5 قطعة غيار تبريد", en: "ps5 fan replacement cooling part", ckb: "پانکەی پلەیستەیشن 5" },
    variants: [{ sku: "PART-PS5S-FAN", priceIqd: 30_000, stock: 4 }],
  },
];
