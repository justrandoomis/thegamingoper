/**
 * DEMO compatibility graph and editorial product relations.
 *
 * Every rule here states something the maker of the product or of the console documents
 * (`source: "manufacturer"`), or that follows from a published standard (`source: "standard"`).
 * Where we do not know, there is NO row — a missing rule means "not verified", never "compatible".
 * Generic and third-party items carry explicit `unverified` rows with a note saying so, which is
 * also what lets the storefront show that state.
 *
 * Targets are as precise as the fact:
 *   device model   when models of one generation differ (PS5 Pro has no disc drive, Series S neither;
 *                  PlayStation Portal belongs to the PS5 generation but takes no controller or disc)
 *   generation     only for Xbox Series X|S, where the statement holds for both consoles
 *   platform       for store credit, which belongs to an account, not to a console
 *
 * Nobody has tested anything in the store yet, so `verified_by` stays empty; `verified_at` is the
 * time the documented fact was recorded.
 */
import type { CompatibilityStatus, ProductRelationKind } from "../../schema";
import type { PlatformSlug } from "./devices";
import { t3, type T3 } from "./text";

export type CompatSubject = { product: string } | { variant: string };
export type CompatTarget = { model: string } | { generation: string } | { platform: PlatformSlug };
export type CompatSeed = {
  /** Product slug, or a SKU when editions of one product differ. */
  subject: CompatSubject;
  target: CompatTarget;
  status: CompatibilityStatus;
  note?: T3;
  /** "manufacturer" | "standard"; empty for unverified rows. */
  source?: string;
};

// ───────────────────────────────────────────────────────────────── notes

const NOTE = {
  switch2Only: t3(
    "لعبة حصرية لـ Nintendo Switch 2 ولا تعمل على أجهزة Switch السابقة.",
    "A Nintendo Switch 2 exclusive; it does not run on earlier Switch consoles.",
    "یارییەکی تایبەت بە Nintendo Switch 2ـە و لەسەر ئامێرەکانی پێشووی Switch کارناکات.",
  ),
  switchOnSwitch2: t3(
    "نسخة Nintendo Switch الأصلية، وتعمل على Switch 2 ضمن دعمه لألعاب Switch.",
    "The original Nintendo Switch version; it runs on Switch 2 through its support for Switch games.",
    "وەشانی ئەسڵیی Nintendo Switch؛ لەسەر Switch 2 لە ڕێگەی پشتگیریی یارییەکانی Switchـەوە کاردەکات.",
  ),
  switch2Edition: t3(
    "إصدار Nintendo Switch 2 Edition يعمل على Switch 2 فقط.",
    "The Nintendo Switch 2 Edition runs on Switch 2 only.",
    "وەشانی Nintendo Switch 2 Edition تەنها لەسەر Switch 2 کاردەکات.",
  ),
  ps5DiscSlim: t3(
    "يعمل مباشرة على نسخة الأقراص. النسخة الرقمية من الجهاز تحتاج مشغّل الأقراص المنفصل.",
    "Plays directly on the disc edition. The Digital Edition needs the separately sold disc drive.",
    "ڕاستەوخۆ لەسەر وەشانی دیسک کاردەکات. وەشانی دیجیتاڵیی ئامێرەکە پێویستی بە خوێنەری دیسکی جیا هەیە.",
  ),
  ps5DiscPro: t3(
    "PS5 Pro يأتي بلا مشغّل أقراص: القرص يعمل بعد تركيب مشغّل أقراص PS5 المنفصل (يُباع على حدة).",
    "PS5 Pro ships without a disc drive: the disc works once the separately sold PS5 disc drive is attached.",
    "PS5 Pro بێ خوێنەری دیسک دێت: دیسکەکە دوای لکاندنی خوێنەری دیسکی جیای PS5 کاردەکات (بە جیا دەفرۆشرێت).",
  ),
  seriesSNoDisc: t3(
    "Xbox Series S بلا مشغّل أقراص، فلا يقرأ النسخ الفيزيائية. اللعبة متاحة له رقمياً من متجر Xbox.",
    "Xbox Series S has no disc drive, so it cannot read physical copies. The game is available for it digitally from the Xbox store.",
    "Xbox Series S خوێنەری دیسکی نییە، بۆیە وەشانی فیزیکی ناخوێنێتەوە. یارییەکە بە دیجیتاڵی لە فرۆشگای Xbox بۆی بەردەستە.",
  ),
  switch2Controller: t3(
    "مخصصة لـ Nintendo Switch 2 ولا تعمل مع أجهزة Switch السابقة.",
    "Made for Nintendo Switch 2; it does not work with earlier Switch consoles.",
    "بۆ Nintendo Switch 2 دروستکراوە و لەگەڵ ئامێرەکانی پێشووی Switch کارناکات.",
  ),
  pulsePs5: t3(
    "تتصل عبر محوّل PlayStation Link المرفق.",
    "Connects through the included PlayStation Link adapter.",
    "لە ڕێگەی ئەداپتەری PlayStation Linkـی هاوپێچەوە دەبەسترێت.",
  ),
  pulsePortal: t3(
    "تتصل بـ PlayStation Portal مباشرة عبر PlayStation Link، من دون محوّل.",
    "Connects to PlayStation Portal directly over PlayStation Link, with no adapter.",
    "ڕاستەوخۆ لە ڕێگەی PlayStation Linkـەوە بە PlayStation Portal دەبەسترێت، بێ ئەداپتەر.",
  ),
  xboxWireless: t3(
    "تتصل بالجهاز مباشرة عبر Xbox Wireless من دون محوّل.",
    "Connects to the console directly over Xbox Wireless, with no adapter.",
    "ڕاستەوخۆ لە ڕێگەی Xbox Wirelessـەوە بە ئامێرەکە دەبەسترێت، بێ ئەداپتەر.",
  ),
  expressOnSwitch2: t3(
    "Switch 2 يقبل بطاقات microSD Express فقط لتخزين الألعاب وتشغيلها.",
    "Switch 2 accepts only microSD Express cards for storing and running games.",
    "Switch 2 تەنها کارتی microSD Express بۆ هەڵگرتن و کارپێکردنی یارییەکان وەردەگرێت.",
  ),
  expressAtUhs: t3(
    "تعمل كبطاقة microSD عادية بسرعة UHS-I؛ سرعة Express غير مدعومة على هذا الجهاز.",
    "Works as a regular microSD card at UHS-I speed; Express speed is not supported on this console.",
    "وەک کارتێکی ئاسایی microSD بە خێرایی UHS-I کاردەکات؛ خێرایی Express لەم ئامێرەدا پشتگیری ناکرێت.",
  ),
  m2OnPs5: t3(
    "يطابق متطلبات Sony لقرص التوسعة: واجهة PCIe Gen4 x4 NVMe مع مشتّت حراري. يُركَّب في الفتحة الداخلية.",
    "Meets Sony's requirements for the expansion drive: PCIe Gen4 x4 NVMe with a heatsink. It fits the internal slot.",
    "لەگەڵ مەرجەکانی Sony بۆ دیسکی فراوانکردن دەگونجێت: PCIe Gen4 x4 NVMe لەگەڵ هیتسینک. لە شوێنە ناوەکییەکەدا دادەنرێت.",
  ),
  expansionCard: t3(
    "تُدخل في منفذ توسعة التخزين خلف الجهاز وتشغّل ألعاب Series X|S مباشرة.",
    "Plugs into the Storage Expansion port at the back and runs Series X|S games directly.",
    "دەخرێتە دەرچەی فراوانکردنی بیرگە لە پشتەوە و یارییەکانی Series X|S ڕاستەوخۆ کارپێدەکات.",
  ),
  usbOnPs5: t3(
    "يخزّن ألعاب PS5 و PS4 ويشغّل ألعاب PS4 مباشرة. ألعاب PS5 تُنقل إلى القرص الداخلي أو قرص M.2 لتشغيلها.",
    "Stores PS5 and PS4 games and runs PS4 games directly. PS5 games must be moved to the internal drive or an M.2 SSD to play.",
    "یارییەکانی PS5 و PS4 هەڵدەگرێت و یارییەکانی PS4 ڕاستەوخۆ کارپێدەکات. یارییەکانی PS5 دەبێت بۆ دیسکی ناوەکی یان M.2 SSD بگوازرێنەوە تا کاربکەن.",
  ),
  usbOnXbox: t3(
    "يشغّل ألعاب Xbox One والأجيال السابقة مباشرة، ويخزّن ألعاب Series X|S التي تُنقل إلى القرص الداخلي أو بطاقة التوسعة لتشغيلها.",
    "Runs Xbox One and earlier games directly, and stores Series X|S games, which must be moved to the internal drive or an expansion card to play.",
    "یارییەکانی Xbox One و نەوەکانی پێشوو ڕاستەوخۆ کارپێدەکات، و یارییەکانی Series X|S هەڵدەگرێت کە دەبێت بۆ دیسکی ناوەکی یان کارتی فراوانکردن بگوازرێنەوە تا کاربکەن.",
  ),
  usbOnSwitch: t3(
    "أجهزة Nintendo Switch لا تدعم أقراص USB الخارجية لتخزين الألعاب.",
    "Nintendo Switch consoles do not support external USB drives for game storage.",
    "ئامێرەکانی Nintendo Switch دیسکی دەرەکیی USB بۆ هەڵگرتنی یاری پشتگیری ناکەن.",
  ),
  liteNoTv: t3("Switch Lite لا يدعم وضع التلفاز.", "Switch Lite does not support TV mode.", "Switch Lite دۆخی تەلەفزیۆن پشتگیری ناکات."),
  chargingStation: t3(
    "تشحن يدَي DualSense أو DualSense Edge لهذا الجهاز، وتعمل بمحوّلها الخاص.",
    "Charges this console's DualSense or DualSense Edge controllers, from its own adapter.",
    "دەسکەکانی DualSense یان DualSense Edgeـی ئەم ئامێرە بارگاوی دەکات، بە ئەداپتەری خۆی.",
  ),
  untested: t3(
    "قطعة عامة: التوافق مع هذا الجهاز لم يُختبر في المتجر بعد.",
    "A generic item: compatibility with this device has not been tested in the store yet.",
    "پارچەیەکی گشتییە: گونجانی لەگەڵ ئەم ئامێرە هێشتا لە فرۆشگا تاقی نەکراوەتەوە.",
  ),
  partNeedsMatching: t3(
    "قطعة بديلة غير أصلية: يطابقها الفني مع الجهاز في الورشة قبل التركيب.",
    "A third-party replacement part: a technician matches it to the device in the workshop before fitting.",
    "پارچەیەکی جێگرەوەی نائەسڵی: تەکنیکار پێش دانان لە وەرشە لەگەڵ ئامێرەکە بەراوردی دەکات.",
  ),
  usAccountOnly: t3(
    "الرصيد يُضاف إلى حساب مسجَّل في الولايات المتحدة فقط، ولا يعمل مع حسابات المناطق الأخرى.",
    "The credit can be added only to an account registered in the United States; it does not work with accounts from other regions.",
    "باڵانسەکە تەنها بۆ هەژمارێک زیاد دەکرێت کە لە ویلایەتە یەکگرتووەکان تۆمارکراوە، و لەگەڵ هەژماری ناوچەکانی تر کارناکات.",
  ),
} as const;

// ───────────────────────────────────────────────────────────────── rule builders

const product = (slug: string): CompatSubject => ({ product: slug });
const sku = (value: string): CompatSubject => ({ variant: value });
const model = (slug: string): CompatTarget => ({ model: slug });
const XBOX_SERIES: CompatTarget = { generation: "xbox-series" };

const rule = (subject: CompatSubject, target: CompatTarget, status: CompatibilityStatus, note?: T3, source?: string): CompatSeed => ({
  subject,
  target,
  status,
  ...(note ? { note } : {}),
  ...(status === "unverified" ? {} : { source: source ?? "manufacturer" }),
});

/** A game that only exists for Switch 2. */
const switch2Exclusive = (subject: CompatSubject): CompatSeed[] => [
  rule(subject, model("switch-2"), "verified"),
  rule(subject, model("switch-oled"), "incompatible", NOTE.switch2Only),
  rule(subject, model("switch-lite"), "incompatible", NOTE.switch2Only),
];
/** A Nintendo Switch game card: plays on the Switch family and, through backward compatibility, on Switch 2. */
const switchGame = (subject: CompatSubject): CompatSeed[] => [
  rule(subject, model("switch-oled"), "verified"),
  rule(subject, model("switch-lite"), "verified"),
  rule(subject, model("switch-2"), "verified", NOTE.switchOnSwitch2),
];
/** A "Nintendo Switch 2 Edition" game card. */
const switch2Edition = (subject: CompatSubject): CompatSeed[] => [
  rule(subject, model("switch-2"), "verified"),
  rule(subject, model("switch-oled"), "incompatible", NOTE.switch2Edition),
  rule(subject, model("switch-lite"), "incompatible", NOTE.switch2Edition),
];
/** A PS5 game disc. */
const ps5Disc = (slug: string): CompatSeed[] => [
  rule(product(slug), model("ps5-slim"), "verified", NOTE.ps5DiscSlim),
  rule(product(slug), model("ps5-pro"), "partial", NOTE.ps5DiscPro),
];
/** An Xbox game disc. */
const xboxDisc = (slug: string): CompatSeed[] => [
  rule(product(slug), model("xbox-series-x"), "verified"),
  rule(product(slug), model("xbox-series-s"), "incompatible", NOTE.seriesSNoDisc),
];
/** A Switch 2 controller. */
const switch2Controller = (slug: string): CompatSeed[] => [
  rule(product(slug), model("switch-2"), "verified"),
  rule(product(slug), model("switch-oled"), "incompatible", NOTE.switch2Controller),
  rule(product(slug), model("switch-lite"), "incompatible", NOTE.switch2Controller),
];
const ps5Consoles = (slug: string, note?: T3, status: CompatibilityStatus = "verified"): CompatSeed[] => [
  rule(product(slug), model("ps5-slim"), status, note),
  rule(product(slug), model("ps5-pro"), status, note),
];

// ───────────────────────────────────────────────────────────────── rules

export const DEMO_COMPATIBILITY: readonly CompatSeed[] = [
  // Games — Nintendo
  ...switch2Exclusive(product("mario-kart-world")),
  ...switch2Exclusive(product("donkey-kong-bananza")),
  ...switchGame(sku("NSW-TOTK")),
  ...switch2Edition(sku("NSW2-TOTK-ED")),
  ...switchGame(product("super-mario-bros-wonder")),
  ...switchGame(sku("NSW-PLZA")),
  ...switch2Edition(sku("NSW2-PLZA-ED")),
  ...switchGame(product("animal-crossing-new-horizons")),
  // Games — PlayStation
  ...ps5Disc("spider-man-2"),
  ...ps5Disc("god-of-war-ragnarok"),
  ...ps5Disc("gran-turismo-7"),
  ...ps5Disc("ghost-of-yotei"),
  ...ps5Disc("ea-sports-fc-26-ps5"),
  ...ps5Disc("elden-ring-ps5"),
  // Games — Xbox
  ...xboxDisc("forza-horizon-5"),
  ...xboxDisc("halo-infinite"),
  ...xboxDisc("ea-sports-fc-26-xbox"),
  ...xboxDisc("minecraft-xbox"),

  // Controllers
  ...ps5Consoles("dualsense-wireless-controller"),
  ...ps5Consoles("dualsense-edge-wireless-controller"),
  rule(product("xbox-wireless-controller"), XBOX_SERIES, "verified"),
  rule(product("xbox-elite-wireless-controller-series-2"), XBOX_SERIES, "verified"),
  ...switch2Controller("nintendo-switch-2-pro-controller"),
  ...switch2Controller("joy-con-2-pair"),

  // Headsets
  ...ps5Consoles("pulse-elite-wireless-headset", NOTE.pulsePs5),
  rule(product("pulse-elite-wireless-headset"), model("ps-portal"), "verified", NOTE.pulsePortal),
  rule(product("xbox-wireless-headset"), XBOX_SERIES, "verified", NOTE.xboxWireless),

  // Storage
  rule(product("sandisk-microsd-express"), model("switch-2"), "verified", NOTE.expressOnSwitch2),
  rule(product("sandisk-microsd-express"), model("switch-oled"), "partial", NOTE.expressAtUhs, "standard"),
  rule(product("sandisk-microsd-express"), model("switch-lite"), "partial", NOTE.expressAtUhs, "standard"),
  ...ps5Consoles("wd-black-sn850x-nvme-ssd-heatsink", NOTE.m2OnPs5),
  rule(product("seagate-storage-expansion-card-xbox"), XBOX_SERIES, "verified", NOTE.expansionCard),
  ...ps5Consoles("sandisk-extreme-portable-ssd", NOTE.usbOnPs5, "partial"),
  rule(product("sandisk-extreme-portable-ssd"), XBOX_SERIES, "partial", NOTE.usbOnXbox),
  rule(product("sandisk-extreme-portable-ssd"), model("switch-oled"), "incompatible", NOTE.usbOnSwitch),
  rule(product("sandisk-extreme-portable-ssd"), model("switch-lite"), "incompatible", NOTE.usbOnSwitch),

  // Accessories
  rule(product("nintendo-switch-2-dock-set"), model("switch-2"), "verified"),
  rule(product("nintendo-switch-2-dock-set"), model("switch-lite"), "incompatible", NOTE.liteNoTv),
  rule(product("nintendo-switch-2-carrying-case-screen-protector"), model("switch-2"), "verified"),
  ...ps5Consoles("dualsense-charging-station", NOTE.chargingStation),
  rule(product("tempered-glass-screen-protector-switch-2"), model("switch-2"), "unverified", NOTE.untested),
  rule(product("usb-c-gan-charger-65w"), model("steam-deck-oled"), "unverified", NOTE.untested),
  rule(product("usb-c-gan-charger-65w"), model("rog-ally-x"), "unverified", NOTE.untested),
  rule(product("usb-c-gan-charger-65w"), model("legion-go"), "unverified", NOTE.untested),

  // Store credit — tied to the account's region, not to a console
  rule(product("playstation-store-wallet-top-up-us"), { platform: "playstation" }, "partial", NOTE.usAccountOnly),
  rule(product("nintendo-eshop-card-us"), { platform: "nintendo" }, "partial", NOTE.usAccountOnly),
  rule(product("xbox-gift-card-us"), { platform: "xbox" }, "partial", NOTE.usAccountOnly),

  // Spare parts — matched by a technician, never assumed
  rule(product("steam-deck-oled-replacement-battery"), model("steam-deck-oled"), "unverified", NOTE.partNeedsMatching),
  rule(product("ps5-slim-replacement-cooling-fan"), model("ps5-slim"), "unverified", NOTE.partNeedsMatching),
];

// ───────────────────────────────────────────────────────────────── relations

export type RelationSeed = { product: string; related: string; kind: ProductRelationKind; pinned: boolean; sort: number };

/** `related` in display order; the first `pin` entries are pinned to the top of the shelf. */
const relate = (kind: ProductRelationKind, from: string, related: readonly string[], pin = 0): RelationSeed[] =>
  related.map((slug, index) => ({ product: from, related: slug, kind, pinned: index < pin, sort: index }));

/**
 * Editorial links (admin 02.08). `setup` is the "complete your setup" shelf of a console,
 * `accessory` what goes with a product, `upsell` a better version of the same thing, `upgrade` the
 * next console up, `alternative` a comparable device. The recommendation service still applies the
 * compatibility rules above before showing any of them as compatible.
 */
export const DEMO_RELATIONS: readonly RelationSeed[] = [
  ...relate(
    "setup",
    "nintendo-switch-2",
    [
      "nintendo-switch-2-pro-controller",
      "sandisk-microsd-express",
      "nintendo-switch-2-carrying-case-screen-protector",
      "mario-kart-world",
      "joy-con-2-pair",
      "nintendo-switch-2-dock-set",
    ],
    3,
  ),
  ...relate("setup", "nintendo-switch-oled", ["sandisk-microsd-express", "zelda-tears-of-the-kingdom", "super-mario-bros-wonder", "animal-crossing-new-horizons"], 2),
  ...relate("setup", "nintendo-switch-lite", ["sandisk-microsd-express", "animal-crossing-new-horizons", "pokemon-legends-z-a", "super-mario-bros-wonder"], 2),
  ...relate(
    "setup",
    "playstation-5-slim",
    [
      "dualsense-wireless-controller",
      "dualsense-charging-station",
      "wd-black-sn850x-nvme-ssd-heatsink",
      "pulse-elite-wireless-headset",
      "spider-man-2",
      "ea-sports-fc-26-ps5",
    ],
    3,
  ),
  ...relate(
    "setup",
    "playstation-5-pro",
    [
      "dualsense-edge-wireless-controller",
      "wd-black-sn850x-nvme-ssd-heatsink",
      "pulse-elite-wireless-headset",
      "dualsense-charging-station",
      "ghost-of-yotei",
      "gran-turismo-7",
    ],
    3,
  ),
  ...relate("setup", "playstation-portal", ["pulse-elite-wireless-headset"], 1),
  ...relate(
    "setup",
    "xbox-series-x",
    [
      "xbox-wireless-controller",
      "seagate-storage-expansion-card-xbox",
      "xbox-wireless-headset",
      "forza-horizon-5",
      "ea-sports-fc-26-xbox",
      "xbox-elite-wireless-controller-series-2",
    ],
    3,
  ),
  ...relate("setup", "xbox-series-s", ["xbox-wireless-controller", "seagate-storage-expansion-card-xbox", "xbox-wireless-headset", "xbox-gift-card-us"], 3),
  ...relate("setup", "steam-deck-oled", ["usb-c-gan-charger-65w", "sandisk-extreme-portable-ssd", "silicone-thumb-grip-caps"]),
  ...relate("setup", "rog-ally-x", ["usb-c-gan-charger-65w", "sandisk-extreme-portable-ssd"]),
  ...relate("setup", "legion-go", ["usb-c-gan-charger-65w", "sandisk-extreme-portable-ssd"]),

  ...relate("upgrade", "nintendo-switch-oled", ["nintendo-switch-2"]),
  ...relate("upgrade", "nintendo-switch-lite", ["nintendo-switch-2"]),
  ...relate("upgrade", "playstation-5-slim", ["playstation-5-pro"]),
  ...relate("upgrade", "xbox-series-s", ["xbox-series-x"]),

  ...relate("alternative", "steam-deck-oled", ["rog-ally-x", "legion-go"]),
  ...relate("alternative", "rog-ally-x", ["steam-deck-oled", "legion-go"]),
  ...relate("alternative", "legion-go", ["steam-deck-oled", "rog-ally-x"]),
  ...relate("alternative", "nintendo-switch-lite", ["nintendo-switch-oled"]),

  ...relate("upsell", "dualsense-wireless-controller", ["dualsense-edge-wireless-controller"]),
  ...relate("upsell", "xbox-wireless-controller", ["xbox-elite-wireless-controller-series-2"]),

  ...relate("accessory", "dualsense-wireless-controller", ["dualsense-charging-station", "silicone-thumb-grip-caps"], 1),
  ...relate("accessory", "dualsense-edge-wireless-controller", ["dualsense-charging-station"], 1),
  ...relate("accessory", "xbox-wireless-controller", ["silicone-thumb-grip-caps"]),
  ...relate("accessory", "mario-kart-world", ["joy-con-2-pair", "nintendo-switch-2-pro-controller"]),
  ...relate("accessory", "ea-sports-fc-26-ps5", ["dualsense-wireless-controller"]),
  ...relate("accessory", "ea-sports-fc-26-xbox", ["xbox-wireless-controller"]),
  ...relate("accessory", "playstation-5-slim", ["playstation-store-wallet-top-up-us"]),
  ...relate("accessory", "nintendo-switch-2", ["nintendo-eshop-card-us"]),
];
