/**
 * DEMO catalogue — controllers and headsets. All are first-party products, so what they work with
 * is documented by their makers (see ../compatibility.ts).
 */
import { t3 } from "../text";
import type { ProductSeed } from "./types";

const XBOX_CONNECTION = t3("Xbox Wireless و Bluetooth و USB-C", "Xbox Wireless, Bluetooth and USB-C", "Xbox Wireless و Bluetooth و USB-C");
const PS_CONNECTION = t3("Bluetooth و USB-C", "Bluetooth and USB-C", "Bluetooth و USB-C");

export const CONTROLLER_PRODUCTS: readonly ProductSeed[] = [
  {
    slug: "dualsense-wireless-controller",
    kind: "controller",
    name: t3("يد تحكم DualSense اللاسلكية", "DualSense Wireless Controller", "دەسکی یاریی بێتەلی DualSense"),
    short: t3(
      "يد PS5 بالاهتزاز اللمسي والزنادات التكيفية",
      "The PS5 controller with haptic feedback and adaptive triggers",
      "دەسکی PS5 بە لەرزینی هەستپێکراو و تریگەری گونجاو",
    ),
    description: t3(
      "يد التحكم الأصلية لـ PS5: اهتزاز لمسي تشعر معه بتفاصيل اللعبة، زنادات تتغير مقاومتها بحسب الحدث، ميكروفون مدمج ومنفذ سماعة 3.5 ملم. تُشحن عبر USB-C.",
      "The original PS5 controller: haptic feedback that lets you feel the detail of a game, triggers whose resistance changes with the action, a built-in microphone and a 3.5 mm headset jack. It charges over USB-C.",
      "دەسکی ئەسڵیی PS5: لەرزینی هەستپێکراو کە وردەکارییەکانی یارییەکەی پێ هەست پێدەکەیت، تریگەر کە بەرگرییەکەی بەپێی ڕووداو دەگۆڕێت، مایکرۆفۆنی لکاو و دەرچەی هێدفۆنی 3.5 ملم. لە ڕێگەی USB-Cـەوە بارگاوی دەکرێت.",
    ),
    brand: "Sony",
    platform: "playstation",
    category: "controllers",
    specs: {
      connection: PS_CONNECTION,
      battery: t3("بطارية داخلية قابلة للشحن", "Built-in rechargeable battery", "پاتریی ناوەکیی بارگاویکراو"),
      headset_jack: true,
      microphone: true,
    },
    warrantyMonths: 6,
    art: ["dualsense-white", "dualsense-white@front", "dualsense-black", "dualsense-red"],
    keywords: { ar: "دوال سنس دوالسنس يد بلايستيشن 5 يدة بي اس 5 جوستك بلايستيشن", en: "dual sense ps5 controller pad", ckb: "دواڵ سێنس دەسکی پلەیستەیشن" },
    variants: [
      { sku: "DS-WHT", title: t3("أبيض", "White", "سپی"), options: { color: "white" }, priceIqd: 105_000, stock: 12, art: ["dualsense-white", "dualsense-white@front"] },
      { sku: "DS-BLK", title: t3("أسود منتصف الليل", "Midnight Black", "ڕەشی نیوەشەو"), options: { color: "midnight-black" }, priceIqd: 105_000, stock: 7, art: ["dualsense-black"] },
      { sku: "DS-RED", title: t3("أحمر كوني", "Cosmic Red", "سووری گەردوونی"), options: { color: "cosmic-red" }, priceIqd: 110_000, stock: 0, art: ["dualsense-red"] },
    ],
  },
  {
    slug: "dualsense-edge-wireless-controller",
    kind: "controller",
    name: t3("يد تحكم DualSense Edge اللاسلكية", "DualSense Edge Wireless Controller", "دەسکی یاریی بێتەلی DualSense Edge"),
    short: t3("يد PS5 الاحترافية القابلة للتخصيص", "The customisable pro controller for PS5", "دەسکی پیشەگەرانەی PS5 کە دەگونجێنرێت"),
    description: t3(
      "نسخة احترافية من DualSense: أزرار خلفية قابلة للتبديل، ملفات إعداد تتنقل بينها أثناء اللعب، ومدى زناد قابل للتعديل. وحدتا العصا قابلتان للاستبدال من دون أدوات، وتأتي مع حقيبة وكيبل مضفور.",
      "A pro version of the DualSense: swappable back buttons, profiles you can switch during play and adjustable trigger travel. The stick modules can be replaced without tools, and it comes with a case and a braided cable.",
      "وەشانێکی پیشەگەرانەی DualSense: دوگمەی پشتەوە کە دەگۆڕدرێن، پرۆفایل کە لە کاتی یاریدا لە نێوانیاندا دەگوازیتەوە، و مەودای تریگەر کە ڕێکدەخرێت. یەکەکانی جۆیستیک بێ ئامراز دەگۆڕدرێن، و لەگەڵ جانتا و کێبڵی هۆنراو دێت.",
    ),
    brand: "Sony",
    platform: "playstation",
    category: "controllers",
    specs: { connection: PS_CONNECTION, back_buttons: true, replaceable_sticks: true, headset_jack: true, microphone: true },
    warrantyMonths: 6,
    art: ["dualsense-edge"],
    keywords: { ar: "دوال سنس ايدج دوالسنس ادج يد احترافية بلايستيشن", en: "dual sense edge pro controller", ckb: "دواڵ سێنس ئێج" },
    variants: [{ sku: "DSE-WHT", options: { color: "white" }, priceIqd: 295_000, stock: 4 }],
  },
  {
    slug: "xbox-wireless-controller",
    kind: "controller",
    name: t3("يد تحكم Xbox اللاسلكية", "Xbox Wireless Controller", "دەسکی یاریی بێتەلی Xbox"),
    short: t3(
      "يد Xbox Series X|S · تعمل أيضاً عبر Bluetooth",
      "The Xbox Series X|S controller · also works over Bluetooth",
      "دەسکی Xbox Series X|S · لە ڕێگەی Bluetoothـیشەوە کاردەکات",
    ),
    description: t3(
      "يد التحكم الأصلية لأجهزة Xbox Series X|S: مقابض محبّبة، زر مشاركة لالتقاط الصور والمقاطع، ومنفذ سماعة 3.5 ملم. تتصل بالجهاز عبر Xbox Wireless وبالأجهزة الأخرى عبر Bluetooth، وتعمل ببطاريتَي AA.",
      "The original controller for Xbox Series X|S: textured grips, a Share button for screenshots and clips, and a 3.5 mm headset jack. It connects to the console over Xbox Wireless and to other devices over Bluetooth, and runs on two AA batteries.",
      "دەسکی ئەسڵیی ئامێرەکانی Xbox Series X|S: گرتەی زبر، دوگمەی هاوبەشکردن بۆ گرتنی وێنە و ڤیدیۆ، و دەرچەی هێدفۆنی 3.5 ملم. لە ڕێگەی Xbox Wirelessـەوە بە ئامێرەکە و لە ڕێگەی Bluetoothـەوە بە ئامێرەکانی تر دەبەسترێت، و بە دوو پاتریی AA کاردەکات.",
    ),
    brand: "Microsoft",
    platform: "xbox",
    category: "controllers",
    specs: {
      connection: XBOX_CONNECTION,
      battery: t3("بطاريتا AA (مرفقتان)", "Two AA batteries (included)", "دوو پاتریی AA (لەگەڵیدایە)"),
      headset_jack: true,
    },
    warrantyMonths: 6,
    art: ["xbox-controller-black", "xbox-controller-black@front", "xbox-controller-white", "xbox-controller-blue"],
    keywords: { ar: "يد اكس بوكس يدة اكسبوكس جوستك اكس بوكس", en: "xbox controller pad", ckb: "دەسکی ئێکس بۆکس" },
    variants: [
      { sku: "XWC-BLK", title: t3("أسود كربوني", "Carbon Black", "ڕەشی کاربۆنی"), options: { color: "carbon-black" }, priceIqd: 90_000, stock: 9, art: ["xbox-controller-black", "xbox-controller-black@front"] },
      { sku: "XWC-WHT", title: t3("أبيض", "Robot White", "سپی"), options: { color: "robot-white" }, priceIqd: 90_000, stock: 6, art: ["xbox-controller-white"] },
      { sku: "XWC-BLU", title: t3("أزرق", "Shock Blue", "شین"), options: { color: "shock-blue" }, priceIqd: 95_000, stock: 2, art: ["xbox-controller-blue"] },
    ],
  },
  {
    slug: "xbox-elite-wireless-controller-series-2",
    kind: "controller",
    name: t3("يد تحكم Xbox Elite اللاسلكية Series 2", "Xbox Elite Wireless Controller Series 2", "دەسکی یاریی بێتەلی Xbox Elite Series 2"),
    short: t3(
      "يد Xbox الاحترافية بأزرار خلفية وعصي قابلة للتعديل",
      "The pro Xbox controller with back paddles and adjustable sticks",
      "دەسکی پیشەگەرانەی Xbox بە دوگمەی پشتەوە و جۆیستیکی ڕێکخراو",
    ),
    description: t3(
      "عصي بشدّ قابل للتعديل، أربعة أزرار خلفية، أقفال تقصّر مدى الزناد ومقابض مطاطية محيطة. بطارية داخلية تدوم حتى 40 ساعة، وتأتي مع حقيبة وقاعدة شحن.",
      "Sticks with adjustable tension, four back paddles, trigger locks that shorten travel and wrap-around rubberised grips. The built-in battery lasts up to 40 hours, and it comes with a case and a charging dock.",
      "جۆیستیک بە توندیی ڕێکخراو، چوار دوگمەی پشتەوە، قفڵ کە مەودای تریگەر کورت دەکاتەوە و گرتەی لاستیکیی دەورەدراو. پاتریی ناوەکی تا 40 کاتژمێر بەردەوام دەبێت، و لەگەڵ جانتا و بنکەی بارگاویکردن دێت.",
    ),
    brand: "Microsoft",
    platform: "xbox",
    category: "controllers",
    specs: {
      connection: XBOX_CONNECTION,
      battery: t3("بطارية داخلية، حتى 40 ساعة", "Built-in battery, up to 40 hours", "پاتریی ناوەکی، تا 40 کاتژمێر"),
      back_buttons: true,
      headset_jack: true,
    },
    warrantyMonths: 6,
    art: ["xbox-elite-2"],
    keywords: { ar: "يد ايليت اكس بوكس اليت سيريس 2 يد احترافية", en: "elite controller series 2", ckb: "ئێلیت دەسکی ئێکس بۆکس" },
    variants: [{ sku: "XEL2-BLK", options: { color: "black" }, priceIqd: 275_000, stock: 4 }],
  },
  {
    slug: "nintendo-switch-2-pro-controller",
    kind: "controller",
    name: t3("يد تحكم Nintendo Switch 2 Pro", "Nintendo Switch 2 Pro Controller", "دەسکی یاریی Nintendo Switch 2 Pro"),
    short: t3(
      "يد كاملة الحجم لـ Switch 2 بأزرار خلفية",
      "A full-size controller for Switch 2 with back buttons",
      "دەسکێکی قەبارە تەواو بۆ Switch 2 بە دوگمەی پشتەوە",
    ),
    description: t3(
      "يد لاسلكية كاملة الحجم للّعب الطويل على التلفاز: زرّا GL و GR الخلفيان قابلان للتعيين، زر C لمحادثة GameChat، اهتزاز HD Rumble 2، قارئ amiibo ومنفذ سماعة.",
      "A full-size wireless controller for long sessions on the TV: assignable GL and GR back buttons, a C button for GameChat, HD Rumble 2, an amiibo reader and a headset jack.",
      "دەسکێکی بێتەلی قەبارە تەواو بۆ یاریی درێژ لەسەر تەلەفزیۆن: دوو دوگمەی پشتەوەی GL و GR کە دیاری دەکرێن، دوگمەی C بۆ GameChat، لەرزینی HD Rumble 2، خوێنەری amiibo و دەرچەی هێدفۆن.",
    ),
    brand: "Nintendo",
    platform: "nintendo",
    deviceModel: "switch-2",
    category: "controllers",
    specs: { connection: t3("لاسلكي و USB-C", "Wireless and USB-C", "بێتەل و USB-C"), back_buttons: true, headset_jack: true },
    warrantyMonths: 6,
    art: ["switch-pro-controller-2"],
    keywords: { ar: "برو كنترولر سويتش 2 يد سويتش برو يدة سويتش", en: "pro controller switch 2", ckb: "پرۆ کۆنترۆڵەر سویچ 2" },
    variants: [{ sku: "NSW2-PRO", priceIqd: 130_000, stock: 2 }],
  },
  {
    slug: "joy-con-2-pair",
    kind: "controller",
    name: t3("زوج يدَي Joy-Con 2 (أزرق فاتح وأحمر فاتح)", "Joy-Con 2 Pair (Light Blue and Light Red)", "جووتە دەسکی Joy-Con 2 (شینی کاڵ و سووری کاڵ)"),
    short: t3("يدان إضافيتان لـ Switch 2، يمنى ويسرى", "A spare left and right controller for Switch 2", "دوو دەسکی زیادە بۆ Switch 2، چەپ و ڕاست"),
    description: t3(
      "زوج إضافي من يدَي Joy-Con 2 للّعب الجماعي: يثبتان بالجهاز مغناطيسياً، يعمل كل منهما كفأرة في الألعاب التي تدعم ذلك، وفي اليد اليمنى زر C لمحادثة GameChat.",
      "A spare pair of Joy-Con 2 controllers for multiplayer: they attach to the console magnetically, each works as a mouse in games that support it, and the right one has the C button for GameChat.",
      "جووتێکی زیادەی دەسکەکانی Joy-Con 2 بۆ یاریی بەکۆمەڵ: بە موگناتیس بە ئامێرەکەوە دەلکێن، هەر یەکەیان لەو یارییانەی پشتگیری دەکەن وەک ماوس کاردەکات، و دەسکی ڕاست دوگمەی Cـی بۆ GameChat تێدایە.",
    ),
    brand: "Nintendo",
    platform: "nintendo",
    deviceModel: "switch-2",
    category: "controllers",
    warrantyMonths: 6,
    art: ["joy-con-2-pair"],
    keywords: { ar: "جوي كون 2 جويكون يد سويتش 2 يدة سويتش", en: "joycon joy con 2", ckb: "جۆی کۆن 2" },
    variants: [{ sku: "NSW2-JC2", options: { color: "light-blue-light-red" }, priceIqd: 140_000, stock: 5 }],
  },
];

export const HEADSET_PRODUCTS: readonly ProductSeed[] = [
  {
    slug: "pulse-elite-wireless-headset",
    kind: "headset",
    name: t3("سماعة PULSE Elite اللاسلكية", "PULSE Elite Wireless Headset", "هێدسێتی بێتەلی PULSE Elite"),
    short: t3(
      "سماعة PS5 بميكروفون يُسحب عند الحاجة واتصال PlayStation Link",
      "PS5 headset with a pull-out microphone and PlayStation Link",
      "هێدسێتی PS5 بە مایکرۆفۆنێک کە دەردەهێنرێت و PlayStation Link",
    ),
    description: t3(
      "سماعة لاسلكية بمشغّلات مغناطيسية مستوية وميكروفون يُسحب عند الحاجة ويعزل الضجيج. تتصل بـ PS5 والحاسوب عبر محوّل PlayStation Link المرفق، وبـ PlayStation Portal مباشرة، وبالهاتف عبر Bluetooth.",
      "A wireless headset with planar magnetic drivers and a pull-out, noise-rejecting microphone. It connects to PS5 and PC through the included PlayStation Link adapter, to PlayStation Portal directly, and to a phone over Bluetooth.",
      "هێدسێتێکی بێتەل بە درایڤەری موگناتیسیی تەخت و مایکرۆفۆنێک کە لە کاتی پێویستدا دەردەهێنرێت و ژاوەژاو کەم دەکاتەوە. لە ڕێگەی ئەداپتەری PlayStation Linkـی هاوپێچەوە بە PS5 و کۆمپیوتەر، ڕاستەوخۆ بە PlayStation Portal، و لە ڕێگەی Bluetoothـەوە بە مۆبایل دەبەسترێت.",
    ),
    brand: "Sony",
    platform: "playstation",
    category: "headsets",
    specs: {
      connection: t3("PlayStation Link و Bluetooth", "PlayStation Link and Bluetooth", "PlayStation Link و Bluetooth"),
      battery: t3("حتى 30 ساعة", "Up to 30 hours", "تا 30 کاتژمێر"),
      microphone: true,
    },
    warrantyMonths: 6,
    art: ["headset-white"],
    keywords: { ar: "سماعة بلايستيشن بلس ايليت سماعة سوني سماعة بي اس 5", en: "pulse elite ps5 headset", ckb: "هێدسێتی پلەیستەیشن پەڵس ئێلیت" },
    variants: [{ sku: "PULSE-ELITE-WHT", options: { color: "white" }, priceIqd: 220_000, compareAtIqd: 240_000, stock: 4 }],
  },
  {
    slug: "xbox-wireless-headset",
    kind: "headset",
    name: t3("سماعة Xbox اللاسلكية", "Xbox Wireless Headset", "هێدسێتی بێتەلی Xbox"),
    short: t3("تتصل بـ Xbox مباشرة من دون محوّل", "Connects to Xbox directly, with no adapter", "ڕاستەوخۆ بە Xbox دەبەسترێت، بێ ئەداپتەر"),
    description: t3(
      "سماعة لاسلكية تتصل بأجهزة Xbox عبر Xbox Wireless مباشرة، وبالهاتف أو الحاسوب عبر Bluetooth. قرصان دوّاران على السماعتين لضبط مستوى الصوت والموازنة بين اللعبة والمحادثة، وميكروفون قابل للثني.",
      "A wireless headset that connects to Xbox consoles directly over Xbox Wireless, and to a phone or PC over Bluetooth. Rotating dials on the earcups set the volume and the game/chat balance, and the microphone bends out of the way.",
      "هێدسێتێکی بێتەل کە ڕاستەوخۆ لە ڕێگەی Xbox Wirelessـەوە بە ئامێرەکانی Xbox، و لە ڕێگەی Bluetoothـەوە بە مۆبایل یان کۆمپیوتەر دەبەسترێت. دوو بازنەی سووڕاو لەسەر گوێچکەکان ئاستی دەنگ و هاوسەنگیی یاری و گفتوگۆ ڕێکدەخەن، و مایکرۆفۆنەکە دەچەمێتەوە.",
    ),
    brand: "Microsoft",
    platform: "xbox",
    category: "headsets",
    specs: { connection: t3("Xbox Wireless و Bluetooth", "Xbox Wireless and Bluetooth", "Xbox Wireless و Bluetooth"), microphone: true },
    warrantyMonths: 6,
    art: ["headset-black"],
    keywords: { ar: "سماعة اكس بوكس سماعة اكسبوكس", en: "xbox headset", ckb: "هێدسێتی ئێکس بۆکس" },
    variants: [{ sku: "XWH-BLK", options: { color: "black" }, priceIqd: 155_000, stock: 5 }],
  },
];
