/**
 * DEMO catalogue — the 16 physical games of scripts/art/catalog.json (art key = "game-<slug>").
 * Names are the official titles in every language; a platform is added in brackets only where the
 * catalogue holds the same title for two platforms. Covers are generated typography — no real
 * cover art — and every picture is flagged as an illustration.
 */
import type { PlatformSlug } from "../devices";
import { same, t3, type T3 } from "../text";
import type { ProductSeed, VariantSeed } from "./types";

const GENRE = {
  racing: t3("سباق", "Racing", "پێشبڕکێ"),
  platformer3d: t3("منصات ثلاثية الأبعاد", "3D platformer", "پلاتفۆرمەری سێ ڕەهەندی"),
  platformer2d: t3("منصات ثنائية الأبعاد", "2D platformer", "پلاتفۆرمەری دوو ڕەهەندی"),
  actionAdventure: t3("مغامرات وحركة", "Action-adventure", "سەرکێشی و ئاکشن"),
  actionRpg: t3("تقمّص أدوار وحركة", "Action RPG", "ڕۆڵگێڕان و ئاکشن"),
  lifeSim: t3("محاكاة حياة", "Life simulation", "هاوشێوەکردنی ژیان"),
  drivingSim: t3("محاكاة قيادة", "Driving simulator", "هاوشێوەکردنی لێخوڕین"),
  football: t3("كرة قدم", "Football", "تۆپی پێ"),
  shooter: t3("تصويب من منظور الشخص الأول", "First-person shooter", "تەقەکردن لە دیدی کەسی یەکەم"),
  sandbox: t3("بناء واستكشاف", "Sandbox", "دروستکردن و گەڕان"),
} as const;

/** What the box holds, and for which family of consoles — the line under the title. */
const MEDIA = {
  switch2: t3("بطاقة لعبة · Nintendo Switch 2", "Game card · Nintendo Switch 2", "کارتی یاری · Nintendo Switch 2"),
  switch: t3("بطاقة لعبة · Nintendo Switch", "Game card · Nintendo Switch", "کارتی یاری · Nintendo Switch"),
  ps5: t3("قرص · PlayStation 5", "Disc · PlayStation 5", "دیسک · PlayStation 5"),
  xbox: t3("قرص · Xbox", "Disc · Xbox", "دیسک · Xbox"),
} as const;

const CATEGORY: Record<Exclude<PlatformSlug, "handheld">, string> = { nintendo: "nintendo-games", playstation: "playstation-games", xbox: "xbox-games" };

type GameSeed = {
  /** Slug in scripts/art/catalog.json and in the storefront URL. */
  slug: string;
  name: string;
  platform: Exclude<PlatformSlug, "handheld">;
  media: keyof typeof MEDIA;
  genre: T3;
  publisher: string;
  developer?: string;
  year?: number;
  ageRating: string;
  description: T3;
  keywords: Partial<T3>;
  variants: VariantSeed[];
};

const SWITCH_VERSION = t3("نسخة Nintendo Switch", "Nintendo Switch version", "وەشانی Nintendo Switch");
const SWITCH_2_EDITION = same("Nintendo Switch 2 Edition");

const GAMES: readonly GameSeed[] = [
  {
    slug: "mario-kart-world",
    name: "Mario Kart World",
    platform: "nintendo",
    media: "switch2",
    genre: GENRE.racing,
    publisher: "Nintendo",
    year: 2025,
    ageRating: "PEGI 3",
    description: t3(
      "سباقات Mario Kart في عالم مترابط تقود فيه بين المضامير، وسباقات تجمع حتى 24 متسابقاً. طور Knockout Tour يُقصي المتأخرين عند كل نقطة عبور حتى يبقى فائز واحد.",
      "Mario Kart racing in a connected world where you drive between the tracks, with races of up to 24 drivers. Knockout Tour eliminates the stragglers at every checkpoint until one winner is left.",
      "پێشبڕکێی Mario Kart لە جیهانێکی پێکەوەبەستراودا کە لە نێوان ڕێگاکاندا لێدەخوڕیت، بە پێشبڕکێی تا 24 پێشبڕکێکار. دۆخی Knockout Tour لە هەر خاڵێکی پشکنیندا دواکەوتووەکان دەردەکات تا یەک براوە دەمێنێتەوە.",
    ),
    keywords: { ar: "ماريو كارت وورلد ماريو كارت ورلد سباق ماريو", ckb: "ماریۆ کارت وۆرڵد" },
    variants: [{ sku: "NSW2-MKW", priceIqd: 110_000, stock: 9 }],
  },
  {
    slug: "donkey-kong-bananza",
    name: "Donkey Kong Bananza",
    platform: "nintendo",
    media: "switch2",
    genre: GENRE.platformer3d,
    publisher: "Nintendo",
    year: 2025,
    ageRating: "PEGI 7",
    description: t3(
      "مغامرة منصات ثلاثية الأبعاد يحطّم فيها Donkey Kong الأرض والجدران ليشق طريقه نحو أعماق العالم برفقة Pauline.",
      "A 3D platforming adventure in which Donkey Kong smashes through ground and walls to dig his way toward the depths of the world, with Pauline at his side.",
      "سەرکێشییەکی پلاتفۆرمەری سێ ڕەهەندی کە تێیدا Donkey Kong زەوی و دیوارەکان دەشکێنێت تا ڕێگای خۆی بەرەو قووڵایی جیهان بکاتەوە، لەگەڵ Pauline.",
    ),
    keywords: { ar: "دونكي كونغ بانانزا دونكي كونج", ckb: "دۆنکی کۆنگ بانانزا" },
    variants: [{ sku: "NSW2-DKB", priceIqd: 98_000, stock: 6 }],
  },
  {
    slug: "zelda-tears-of-the-kingdom",
    name: "The Legend of Zelda: Tears of the Kingdom",
    platform: "nintendo",
    media: "switch",
    genre: GENRE.actionAdventure,
    publisher: "Nintendo",
    year: 2023,
    ageRating: "PEGI 12",
    description: t3(
      "تكملة Breath of the Wild: استكشف أرض Hyrule وجزر سمائها وأعماقها، وابنِ مركبات وأدوات بقدرات Link الجديدة. إصدار Nintendo Switch 2 Edition يرفع الدقة ومعدل الإطارات على Switch 2.",
      "The sequel to Breath of the Wild: explore the land of Hyrule, its sky islands and its depths, and build vehicles and tools with Link's new abilities. The Nintendo Switch 2 Edition raises resolution and frame rate on Switch 2.",
      "درێژەی Breath of the Wild: خاکی Hyrule و دوورگەکانی ئاسمانی و قووڵاییەکانی بگەڕێ، و بە تواناکانی نوێی Link گالیسکە و ئامراز دروست بکە. وەشانی Nintendo Switch 2 Edition وردی و ڕێژەی فرەیم لەسەر Switch 2 بەرز دەکاتەوە.",
    ),
    keywords: { ar: "زيلدا تيرز اوف ذا كينغدم زيلدا دموع المملكة", ckb: "زێلدا" },
    variants: [
      { sku: "NSW-TOTK", title: SWITCH_VERSION, options: { edition: "switch" }, priceIqd: 85_000, stock: 5 },
      { sku: "NSW2-TOTK-ED", title: SWITCH_2_EDITION, options: { edition: "switch-2-edition" }, priceIqd: 105_000, stock: 4 },
    ],
  },
  {
    slug: "super-mario-bros-wonder",
    name: "Super Mario Bros. Wonder",
    platform: "nintendo",
    media: "switch",
    genre: GENRE.platformer2d,
    publisher: "Nintendo",
    year: 2023,
    ageRating: "PEGI 3",
    description: t3(
      "لعبة منصات ثنائية الأبعاد تقلب فيها «زهرة العجائب» شكل المرحلة وقواعدها. تدعم اللعب الجماعي المحلي حتى أربعة لاعبين.",
      "A 2D platformer in which Wonder Flowers turn a level's shape and rules upside down. It supports local multiplayer for up to four players.",
      "یارییەکی پلاتفۆرمەری دوو ڕەهەندی کە تێیدا «گوڵی سەرسوڕهێنەر» شێوە و یاساکانی قۆناغەکە دەگۆڕێت. یاریی بەکۆمەڵی ناوخۆیی تا چوار یاریزان پشتگیری دەکات.",
    ),
    keywords: { ar: "سوبر ماريو وندر ماريو وندر سوبر ماريو بروس", ckb: "سوپەر ماریۆ وەندەر" },
    variants: [{ sku: "NSW-SMBW", priceIqd: 75_000, stock: 7 }],
  },
  {
    slug: "pokemon-legends-z-a",
    name: "Pokémon Legends: Z-A",
    platform: "nintendo",
    media: "switch",
    genre: GENRE.actionRpg,
    publisher: "Nintendo / The Pokémon Company",
    developer: "Game Freak",
    year: 2025,
    ageRating: "PEGI 7",
    description: t3(
      "مغامرة تقمّص أدوار تدور كلها في مدينة Lumiose، بمعارك Pokémon في الوقت الفعلي بدل الأدوار المتعاقبة. إصدار Nintendo Switch 2 Edition يرفع الدقة ومعدل الإطارات على Switch 2.",
      "A role-playing adventure set entirely in Lumiose City, with Pokémon battles in real time instead of turns. The Nintendo Switch 2 Edition raises resolution and frame rate on Switch 2.",
      "سەرکێشییەکی ڕۆڵگێڕان کە هەمووی لە شاری Lumiose ڕوودەدات، بە شەڕی Pokémon لە کاتی ڕاستەقینەدا لەبری نۆرە. وەشانی Nintendo Switch 2 Edition وردی و ڕێژەی فرەیم لەسەر Switch 2 بەرز دەکاتەوە.",
    ),
    keywords: { ar: "بوكيمون ليجندز زد اي بوكيمون ليجند", en: "pokemon legends za", ckb: "پۆکیمۆن لێجێندز" },
    variants: [
      { sku: "NSW-PLZA", title: SWITCH_VERSION, options: { edition: "switch" }, priceIqd: 80_000, stock: 4 },
      { sku: "NSW2-PLZA-ED", title: SWITCH_2_EDITION, options: { edition: "switch-2-edition" }, priceIqd: 95_000, stock: 2 },
    ],
  },
  {
    slug: "animal-crossing-new-horizons",
    name: "Animal Crossing: New Horizons",
    platform: "nintendo",
    media: "switch",
    genre: GENRE.lifeSim,
    publisher: "Nintendo",
    year: 2020,
    ageRating: "PEGI 3",
    description: t3(
      "محاكاة حياة هادئة: ابنِ جزيرتك وزيّنها وتعرّف على سكانها بوتيرتك. الوقت في اللعبة يسير مع ساعة العالم الحقيقي وفصوله.",
      "A calm life simulation: build and decorate your island and get to know its residents at your own pace. Time in the game follows the real-world clock and seasons.",
      "هاوشێوەکردنێکی هێمنی ژیان: دوورگەکەت دروست بکە و بیڕازێنەوە و بە خێرایی خۆت دانیشتووانەکەی بناسە. کات لە یارییەکەدا لەگەڵ کاتژمێر و وەرزەکانی جیهانی ڕاستەقینە دەڕوات.",
    ),
    keywords: { ar: "انيمال كروسنج انيمل كروسينغ نيو هورايزنز", ckb: "ئەنیماڵ کرۆسینگ" },
    variants: [{ sku: "NSW-ACNH", priceIqd: 70_000, stock: 6 }],
  },
  {
    slug: "spider-man-2",
    name: "Marvel's Spider-Man 2",
    platform: "playstation",
    media: "ps5",
    genre: GENRE.actionAdventure,
    publisher: "Sony Interactive Entertainment",
    developer: "Insomniac Games",
    year: 2023,
    ageRating: "PEGI 16",
    description: t3(
      "العب بشخصيتَي Peter Parker و Miles Morales وتنقّل بينهما في نيويورك موسّعة، وواجه Kraven و Venom.",
      "Play as both Peter Parker and Miles Morales, switching between them across an expanded New York, and face Kraven and Venom.",
      "بە هەردوو کەسایەتیی Peter Parker و Miles Morales یاری بکە و لە نیویۆرکێکی فراوانکراودا لە نێوانیاندا بگۆڕە، و ڕووبەڕووی Kraven و Venom ببەوە.",
    ),
    keywords: { ar: "سبايدرمان 2 سبايدر مان الرجل العنكبوت مارفل", en: "spiderman 2 spider man", ckb: "سپایدەرمان 2" },
    variants: [{ sku: "PS5-MSM2", priceIqd: 87_000, compareAtIqd: 95_000, stock: 8 }],
  },
  {
    slug: "god-of-war-ragnarok",
    name: "God of War Ragnarök",
    platform: "playstation",
    media: "ps5",
    genre: GENRE.actionAdventure,
    publisher: "Sony Interactive Entertainment",
    developer: "Santa Monica Studio",
    year: 2022,
    ageRating: "PEGI 18",
    description: t3(
      "يواصل Kratos وابنه Atreus رحلتهما عبر العوالم التسعة مع اقتراب Ragnarök، في تكملة مباشرة لـ God of War (2018).",
      "Kratos and his son Atreus continue their journey across the Nine Realms as Ragnarök approaches, in a direct sequel to God of War (2018).",
      "Kratos و کوڕەکەی Atreus گەشتەکەیان بە نۆ جیهانەکەدا بەردەوام دەکەن لە کاتێکدا Ragnarök نزیک دەبێتەوە، وەک درێژەیەکی ڕاستەوخۆی God of War (2018).",
    ),
    keywords: { ar: "قود اوف وار راجناروك غود اوف وور راغناروك كريتوس", en: "god of war ragnarok gow", ckb: "گۆد ئۆف وۆر ڕاگنارۆک" },
    variants: [{ sku: "PS5-GOWR", priceIqd: 65_000, stock: 5 }],
  },
  {
    slug: "gran-turismo-7",
    name: "Gran Turismo 7",
    platform: "playstation",
    media: "ps5",
    genre: GENRE.drivingSim,
    publisher: "Sony Interactive Entertainment",
    developer: "Polyphony Digital",
    year: 2022,
    ageRating: "PEGI 3",
    description: t3(
      "محاكاة قيادة بأكثر من 400 سيارة ومضامير حقيقية وخيالية، مع طور مهني تجمع فيه السيارات وتعدّلها.",
      "A driving simulator with more than 400 cars and real and fictional circuits, with a career mode in which you collect and tune cars.",
      "هاوشێوەکردنێکی لێخوڕین بە زیاتر لە 400 ئۆتۆمبێل و ڕێگای ڕاستەقینە و خەیاڵی، لەگەڵ دۆخێکی پیشەیی کە تێیدا ئۆتۆمبێل کۆدەکەیتەوە و ڕێکیان دەخەیت.",
    ),
    keywords: { ar: "جران توريزمو 7 غران توريسمو سباق سيارات", en: "gt7 gran turismo", ckb: "گران توریزمۆ 7" },
    variants: [{ sku: "PS5-GT7", priceIqd: 70_000, stock: 4 }],
  },
  {
    slug: "ghost-of-yotei",
    name: "Ghost of Yōtei",
    platform: "playstation",
    media: "ps5",
    genre: GENRE.actionAdventure,
    publisher: "Sony Interactive Entertainment",
    developer: "Sucker Punch Productions",
    year: 2025,
    ageRating: "PEGI 18",
    description: t3(
      "مغامرة عالم مفتوح في أرض Ezo حول جبل Yōtei عام 1603، تتبع المحاربة Atsu في سعيها وراء من قتلوا عائلتها.",
      "An open-world adventure in the land of Ezo around Mount Yōtei in 1603, following the warrior Atsu as she hunts those who killed her family.",
      "سەرکێشییەکی جیهانی کراوە لە خاکی Ezo لە دەوری چیای Yōtei لە ساڵی 1603، کە بەدوای جەنگاوەر Atsu دەکەوێت لە گەڕانیدا بەدوای ئەوانەی خێزانەکەیان کوشت.",
    ),
    keywords: { ar: "غوست اوف يوتي قوست اوف يوتاي شبح يوتي", en: "ghost of yotei", ckb: "گۆست ئۆف یۆتەی" },
    variants: [{ sku: "PS5-GOY", priceIqd: 98_000, stock: 0 }],
  },
  {
    slug: "ea-sports-fc-26-ps5",
    name: "EA SPORTS FC 26 (PS5)",
    platform: "playstation",
    media: "ps5",
    genre: GENRE.football,
    publisher: "Electronic Arts",
    year: 2025,
    ageRating: "PEGI 3",
    description: t3(
      "إصدار موسم 2025–2026 من سلسلة كرة القدم من EA SPORTS، بأطوار Ultimate Team والمهنة والأندية.",
      "The 2025–26 season entry in EA SPORTS' football series, with Ultimate Team, Career and Clubs modes.",
      "وەشانی وەرزی 2025–2026ـی زنجیرەی تۆپی پێی EA SPORTS، بە دۆخەکانی Ultimate Team و پیشە و یانەکان.",
    ),
    keywords: { ar: "فيفا 26 اف سي 26 فيفا ٢٦ كرة قدم اي ايه سبورتس", en: "fifa 26 fc26 football soccer", ckb: "فیفا 26 ئێف سی 26 تۆپی پێ" },
    variants: [{ sku: "PS5-FC26", priceIqd: 95_000, stock: 14 }],
  },
  {
    slug: "elden-ring-ps5",
    name: "Elden Ring (PS5)",
    platform: "playstation",
    media: "ps5",
    genre: GENRE.actionRpg,
    publisher: "Bandai Namco Entertainment",
    developer: "FromSoftware",
    year: 2022,
    ageRating: "PEGI 16",
    description: t3(
      "لعبة تقمّص أدوار وحركة في عالم مفتوح من FromSoftware، شارك George R. R. Martin في بناء عالمها. معروفة بصعوبتها وبحرية الاستكشاف.",
      "An open-world action RPG from FromSoftware, with a world co-created by George R. R. Martin. Known for its difficulty and its freedom to explore.",
      "یارییەکی ڕۆڵگێڕان و ئاکشنی جیهانی کراوە لە FromSoftware، کە George R. R. Martin لە دروستکردنی جیهانەکەیدا بەشدار بووە. بە سەختییەکەی و ئازادیی گەڕان ناسراوە.",
    ),
    keywords: { ar: "الدن رينغ ايلدن رنق الدن رنج", en: "eldenring", ckb: "ئێڵدن ڕینگ" },
    variants: [{ sku: "PS5-ER", priceIqd: 60_000, compareAtIqd: 75_000, stock: 2 }],
  },
  {
    slug: "forza-horizon-5",
    name: "Forza Horizon 5",
    platform: "xbox",
    media: "xbox",
    genre: GENRE.racing,
    publisher: "Xbox Game Studios",
    developer: "Playground Games",
    year: 2021,
    ageRating: "PEGI 3",
    description: t3(
      "سباقات عالم مفتوح في المكسيك: مئات السيارات، مواسم تتبدل كل أسبوع، وطرق من الصحراء إلى الأدغال.",
      "Open-world racing in Mexico: hundreds of cars, seasons that change every week, and roads from desert to jungle.",
      "پێشبڕکێی جیهانی کراوە لە مەکسیک: سەدان ئۆتۆمبێل، وەرز کە هەموو هەفتەیەک دەگۆڕێت، و ڕێگا لە بیابانەوە تا دارستان.",
    ),
    keywords: { ar: "فورزا هورايزن 5 فورزا سباق سيارات", en: "fh5 forza", ckb: "فۆرزا هۆرایزن 5" },
    variants: [{ sku: "XB-FH5", priceIqd: 45_000, compareAtIqd: 60_000, stock: 6 }],
  },
  {
    slug: "halo-infinite",
    name: "Halo Infinite",
    platform: "xbox",
    media: "xbox",
    genre: GENRE.shooter,
    publisher: "Xbox Game Studios",
    developer: "343 Industries",
    year: 2021,
    ageRating: "PEGI 16",
    description: t3(
      "حملة Master Chief على حلقة Zeta Halo بمساحات مفتوحة وخطّاف للتنقل، مع طور جماعي على الشبكة.",
      "Master Chief's campaign on the Zeta Halo ring, with open areas and a grappling hook, plus online multiplayer.",
      "هەڵمەتی Master Chief لەسەر بازنەی Zeta Halo بە ناوچەی کراوە و قولاپێک بۆ جووڵە، لەگەڵ یاریی بەکۆمەڵی ئۆنلاین.",
    ),
    keywords: { ar: "هيلو انفنت هالو انفينيت ماستر تشيف", ckb: "هەیلۆ ئینفینیت" },
    variants: [{ sku: "XB-HALO", priceIqd: 40_000, stock: 4 }],
  },
  {
    slug: "ea-sports-fc-26-xbox",
    name: "EA SPORTS FC 26 (Xbox)",
    platform: "xbox",
    media: "xbox",
    genre: GENRE.football,
    publisher: "Electronic Arts",
    year: 2025,
    ageRating: "PEGI 3",
    description: t3(
      "إصدار موسم 2025–2026 من سلسلة كرة القدم من EA SPORTS، بأطوار Ultimate Team والمهنة والأندية.",
      "The 2025–26 season entry in EA SPORTS' football series, with Ultimate Team, Career and Clubs modes.",
      "وەشانی وەرزی 2025–2026ـی زنجیرەی تۆپی پێی EA SPORTS، بە دۆخەکانی Ultimate Team و پیشە و یانەکان.",
    ),
    keywords: { ar: "فيفا 26 اف سي 26 فيفا ٢٦ كرة قدم اي ايه سبورتس", en: "fifa 26 fc26 football soccer", ckb: "فیفا 26 ئێف سی 26 تۆپی پێ" },
    variants: [{ sku: "XB-FC26", priceIqd: 95_000, stock: 10 }],
  },
  {
    slug: "minecraft-xbox",
    name: "Minecraft (Xbox)",
    platform: "xbox",
    media: "xbox",
    genre: GENRE.sandbox,
    publisher: "Xbox Game Studios",
    developer: "Mojang Studios",
    ageRating: "PEGI 7",
    description: t3(
      "ابنِ واستكشف وانجُ في عوالم مكعّبة تُولَّد عشوائياً، منفرداً أو مع أصدقائك.",
      "Build, explore and survive in randomly generated block worlds, alone or with friends.",
      "لە جیهانی بلۆکیی هەڕەمەکی دروستکراودا دروست بکە، بگەڕێ و بمێنەوە، بە تەنها یان لەگەڵ هاوڕێکانت.",
    ),
    keywords: { ar: "ماين كرافت ماينكرافت", ckb: "ماینکرافت" },
    variants: [{ sku: "XB-MC", priceIqd: 35_000, stock: 5, cost: false }],
  },
];

export const GAME_PRODUCTS: readonly ProductSeed[] = GAMES.map((game) => ({
  slug: game.slug,
  kind: "game",
  name: same(game.name),
  short: { ar: `${game.genre.ar} · ${MEDIA[game.media].ar}`, en: `${game.genre.en} · ${MEDIA[game.media].en}`, ckb: `${game.genre.ckb} · ${MEDIA[game.media].ckb}` },
  description: game.description,
  brand: game.publisher,
  platform: game.platform,
  category: CATEGORY[game.platform],
  specs: {
    genre: game.genre,
    publisher: game.publisher,
    ...(game.developer ? { developer: game.developer } : {}),
    ...(game.year ? { release_year: game.year } : {}),
  },
  ageRating: game.ageRating,
  mediaFormat: "physical",
  art: [`game-${game.slug}`],
  keywords: game.keywords,
  variants: game.variants,
}));
