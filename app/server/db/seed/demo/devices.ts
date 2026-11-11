/**
 * DEMO device knowledge graph: platforms → generations → device models.
 *
 * Specifications are the manufacturers' published figures. A field that is not published, or that
 * we are not sure of, is left out — the device hub shows what is here and nothing else.
 * Spec keys are stable identifiers so devices can be compared side by side (labels belong to the
 * storefront's translations):
 *
 *   display_in · display_type · display_resolution · display_refresh_hz · display_hdr · touchscreen
 *   chip · cpu · gpu · ram_gb · storage_type · storage_expansion
 *   storage_gb (models made in one size) · storage_options (models made in several sizes: each
 *     product variant then names its own size, so the sheet never shows one size for all of them)
 *   battery_mah · battery_wh · battery_life_hours · charger_w
 *   weight_g (as played: handhelds with their controllers attached) · dimensions_mm (W × H × D,
 *     in the position the maker measures it)
 *   tv_output · disc_drive · upscaling · os · wifi · bluetooth · usb_c_ports · game_media
 *   controls · audio · requires
 *
 * A figure that differs between editions of one model (the PS5 Slim disc and Digital editions
 * weigh 3.2 and 2.6 kg) is left out rather than shown as if it held for both.
 */
import type { DeviceKind, Specs } from "../../schema";
import { same, t3, type T3 } from "./text";

// ───────────────────────────────────────────────────────────────── platforms

/**
 * `accent` is the design-token name of the platform colour. The four names are the keys of
 * `platformColors` in scripts/art/catalog.json (tests/seed.test.ts checks that they stay in step).
 */
export type PlatformSeed = { slug: "nintendo" | "playstation" | "xbox" | "handheld"; name: T3; accent: string; artKey: string };
export type PlatformSlug = PlatformSeed["slug"];

export const DEMO_PLATFORMS: readonly PlatformSeed[] = [
  { slug: "nintendo", name: t3("نينتندو", "Nintendo", "نینتێندۆ"), accent: "nintendo", artKey: "switch-2" },
  { slug: "playstation", name: t3("بلايستيشن", "PlayStation", "پلەیستەیشن"), accent: "playstation", artKey: "ps5-slim" },
  { slug: "xbox", name: t3("إكس بوكس", "Xbox", "ئێکس بۆکس"), accent: "xbox", artKey: "xbox-series-x" },
  { slug: "handheld", name: t3("حواسيب الألعاب المحمولة", "Handheld PCs", "کۆمپیوتەری یاریی دەستی"), accent: "handheld", artKey: "steam-deck-oled" },
];

// ───────────────────────────────────────────────────────────────── generations

export type GenerationSeed = { slug: string; platform: PlatformSlug; name: T3 };

export const DEMO_GENERATIONS: readonly GenerationSeed[] = [
  { slug: "switch-2", platform: "nintendo", name: same("Nintendo Switch 2") },
  { slug: "switch", platform: "nintendo", name: t3("عائلة Nintendo Switch", "Nintendo Switch family", "خێزانی Nintendo Switch") },
  { slug: "ps5", platform: "playstation", name: t3("جيل PlayStation 5", "PlayStation 5 generation", "نەوەی PlayStation 5") },
  { slug: "xbox-series", platform: "xbox", name: same("Xbox Series X|S") },
  { slug: "steam-deck", platform: "handheld", name: same("Steam Deck") },
  { slug: "rog-ally", platform: "handheld", name: same("ROG Ally") },
  { slug: "legion-go", platform: "handheld", name: same("Legion Go") },
];

// ───────────────────────────────────────────────────────────────── device models

export type DeviceModelSeed = {
  slug: string;
  platform: PlatformSlug;
  generation: string;
  name: T3;
  summary: T3;
  deviceKind: DeviceKind;
  /** "YYYY-MM-DD", or "YYYY" when only the year is certain. */
  releasedOn: string;
  /** Art key in scripts/art/catalog.json; its views become the model's gallery. */
  artKey: string;
  artViews: ReadonlyArray<"hero" | "front" | "back">;
  specs: Specs;
};

const NVIDIA_CUSTOM = t3("معالج مخصص من NVIDIA", "Custom NVIDIA processor", "پرۆسێسەری تایبەتی NVIDIA");
const NVIDIA_TEGRA = t3("معالج NVIDIA Tegra مخصص", "Custom NVIDIA Tegra processor", "پرۆسێسەری تایبەتی NVIDIA Tegra");
const MICROSD_2TB = t3("بطاقات microSD حتى 2TB", "microSD cards up to 2TB", "کارتی microSD تا 2TB");
const MICROSD_SLOT = t3("فتحة بطاقة microSD", "microSD card slot", "شوێنی کارتی microSD");
const SWITCH_GAME_CARDS = t3("بطاقات ألعاب Nintendo Switch", "Nintendo Switch game cards", "کارتی یاریی Nintendo Switch");
const PS5_CPU = t3("AMD Ryzen Zen 2 بثماني أنوية", "8-core AMD Ryzen Zen 2", "AMD Ryzen Zen 2 بە 8 ناوک");
const PS5_EXPANSION = t3("فتحة داخلية لقرص M.2 NVMe SSD، وأقراص USB خارجية", "Internal M.2 NVMe SSD slot, plus USB external drives", "شوێنی ناوەکی بۆ M.2 NVMe SSD، لەگەڵ دیسکی دەرەکیی USB");
const PS5_TV = t3("حتى 4K بمعدل 120 هرتز، مع HDR و VRR", "Up to 4K at 120Hz, with HDR and VRR", "تا 4K بە 120 هێرتز، لەگەڵ HDR و VRR");
const XBOX_EXPANSION = t3(
  "منفذ بطاقة توسعة التخزين، وأقراص USB 3.1 خارجية",
  "Storage Expansion Card port, plus USB 3.1 external drives",
  "دەرچەی کارتی فراوانکردنی بیرگە، لەگەڵ دیسکی دەرەکیی USB 3.1",
);
const SSD_512_OR_1TB = t3("512GB أو 1TB بحسب الإصدار", "512GB or 1TB, depending on the version", "512GB یان 1TB بەپێی وەشان");

export const DEMO_DEVICE_MODELS: readonly DeviceModelSeed[] = [
  {
    slug: "switch-2",
    platform: "nintendo",
    generation: "switch-2",
    name: same("Nintendo Switch 2"),
    summary: t3(
      "جهاز Nintendo الهجين الجديد: شاشة 7.9 بوصة بدقة 1080p، يدا Joy-Con 2 مغناطيسيتان، وإخراج حتى 4K على التلفاز.",
      "Nintendo's new hybrid console: a 7.9-inch 1080p screen, magnetic Joy-Con 2 controllers and up to 4K output on the TV.",
      "ئامێری نوێی هایبریدی Nintendo: شاشەی 7.9 ئینچ بە وردیی 1080p، دەسکەکانی Joy-Con 2 بە موگناتیس، و دەرچوونی تا 4K لەسەر تەلەفزیۆن.",
    ),
    deviceKind: "console",
    releasedOn: "2025-06-05",
    artKey: "switch-2",
    artViews: ["hero", "front", "back"],
    specs: {
      display_in: 7.9,
      display_type: "LCD",
      display_resolution: "1920 × 1080",
      display_refresh_hz: 120,
      display_hdr: true,
      touchscreen: true,
      chip: NVIDIA_CUSTOM,
      storage_gb: 256,
      storage_type: "UFS",
      storage_expansion: t3("بطاقات microSD Express حتى 2TB", "microSD Express cards up to 2TB", "کارتی microSD Express تا 2TB"),
      battery_mah: 5220,
      battery_life_hours: "2–6.5",
      weight_g: 534,
      dimensions_mm: "272 × 116 × 13.9",
      tv_output: t3(
        "حتى 4K بمعدل 60 إطاراً في الثانية مع HDR، عبر القاعدة",
        "Up to 4K at 60 fps with HDR, through the dock",
        "تا 4K بە 60 فرەیم لە چرکەیەکدا لەگەڵ HDR، لە ڕێگەی بنکەوە",
      ),
      wifi: "Wi-Fi 6",
      bluetooth: true,
      usb_c_ports: 2,
      game_media: t3("بطاقات ألعاب Switch 2 و Switch", "Switch 2 and Switch game cards", "کارتی یاریی Switch 2 و Switch"),
    },
  },
  {
    slug: "switch-oled",
    platform: "nintendo",
    generation: "switch",
    name: t3("Nintendo Switch (نموذج OLED)", "Nintendo Switch – OLED Model", "Nintendo Switch (مۆدێلی OLED)"),
    summary: t3(
      "نسخة Switch بشاشة OLED قياس 7 بوصات، مسند عريض قابل للتعديل وقاعدة بمنفذ شبكة سلكية.",
      "The Switch with a 7-inch OLED screen, a wide adjustable stand and a dock with a wired LAN port.",
      "وەشانی Switch بە شاشەی OLEDـی 7 ئینچ، پاڵپشتێکی پانی گۆڕاو و بنکەیەک بە دەرچەی تۆڕی وایەردار.",
    ),
    deviceKind: "console",
    releasedOn: "2021-10-08",
    artKey: "switch-oled",
    artViews: ["hero", "front"],
    specs: {
      display_in: 7,
      display_type: "OLED",
      display_resolution: "1280 × 720",
      display_refresh_hz: 60,
      touchscreen: true,
      chip: NVIDIA_TEGRA,
      storage_gb: 64,
      storage_expansion: MICROSD_2TB,
      battery_mah: 4310,
      battery_life_hours: "4.5–9",
      weight_g: 420,
      dimensions_mm: "242 × 102 × 13.9",
      tv_output: t3("حتى 1080p عبر القاعدة", "Up to 1080p through the dock", "تا 1080p لە ڕێگەی بنکەوە"),
      wifi: "Wi-Fi 5",
      bluetooth: true,
      game_media: SWITCH_GAME_CARDS,
    },
  },
  {
    slug: "switch-lite",
    platform: "nintendo",
    generation: "switch",
    name: same("Nintendo Switch Lite"),
    summary: t3(
      "Switch صغير وخفيف للّعب المحمول فقط، بأزرار مدمجة ومن دون توصيل بالتلفاز.",
      "A small, light Switch for handheld play only, with built-in controls and no TV output.",
      "Switchـێکی بچووک و سووک تەنها بۆ یاریی دەستی، بە دوگمەی لکاو و بێ بەستن بە تەلەفزیۆن.",
    ),
    deviceKind: "console",
    releasedOn: "2019-09-20",
    artKey: "switch-lite",
    artViews: ["hero"],
    specs: {
      display_in: 5.5,
      display_type: "LCD",
      display_resolution: "1280 × 720",
      display_refresh_hz: 60,
      touchscreen: true,
      chip: NVIDIA_TEGRA,
      storage_gb: 32,
      storage_expansion: MICROSD_2TB,
      battery_mah: 3570,
      battery_life_hours: "3–7",
      weight_g: 275,
      dimensions_mm: "208 × 91.1 × 13.9",
      tv_output: t3("لا يدعم التوصيل بالتلفاز", "No TV output (handheld only)", "بەستن بە تەلەفزیۆن پشتگیری ناکات"),
      wifi: "Wi-Fi 5",
      bluetooth: true,
      game_media: SWITCH_GAME_CARDS,
    },
  },
  {
    slug: "ps5-slim",
    platform: "playstation",
    generation: "ps5",
    name: t3("PlayStation 5 (النموذج النحيف)", "PlayStation 5 (Slim)", "PlayStation 5 (مۆدێلی باریک)"),
    summary: t3(
      "جهاز PS5 بحجمه الأصغر وقرص SSD بسعة 1TB، بنسخة أقراص أو نسخة رقمية يمكن إضافة مشغّل أقراص إليها.",
      "The smaller PS5 with a 1TB SSD, as a disc edition or a Digital Edition that can take an add-on disc drive.",
      "PS5 بە قەبارەی بچووکتر و SSDـی 1TB، بە وەشانی دیسک یان وەشانی دیجیتاڵی کە دەتوانرێت خوێنەری دیسکی بۆ زیاد بکرێت.",
    ),
    deviceKind: "console",
    releasedOn: "2023-11-10",
    artKey: "ps5-slim",
    artViews: ["hero", "front", "back"],
    specs: {
      cpu: PS5_CPU,
      gpu: "AMD Radeon RDNA 2, 10.3 TFLOPS",
      ram_gb: 16,
      storage_gb: 1000,
      storage_type: "NVMe SSD",
      storage_expansion: PS5_EXPANSION,
      disc_drive: t3(
        "Ultra HD Blu-ray في نسخة الأقراص؛ النسخة الرقمية تقبل مشغّل أقراص يُباع منفصلاً",
        "Ultra HD Blu-ray on the disc edition; the Digital Edition accepts a separately sold disc drive",
        "Ultra HD Blu-ray لە وەشانی دیسکدا؛ وەشانی دیجیتاڵی خوێنەری دیسکێک وەردەگرێت کە بە جیا دەفرۆشرێت",
      ),
      tv_output: PS5_TV,
      wifi: "Wi-Fi 6",
      bluetooth: true,
    },
  },
  {
    slug: "ps5-pro",
    platform: "playstation",
    generation: "ps5",
    name: same("PlayStation 5 Pro"),
    summary: t3(
      "أقوى أجهزة PS5: معالج رسوميات أسرع، تتبّع أشعة محسَّن، تقنية PSSR لرفع الدقة وقرص SSD بسعة 2TB. يأتي بلا مشغّل أقراص.",
      "The most powerful PS5: a faster GPU, improved ray tracing, PSSR upscaling and a 2TB SSD. It ships without a disc drive.",
      "بەهێزترین PS5: پرۆسێسەری گرافیکی خێراتر، ray tracingـی باشترکراو، تەکنەلۆژیای PSSR بۆ بەرزکردنەوەی وردی و SSDـی 2TB. بێ خوێنەری دیسک دێت.",
    ),
    deviceKind: "console",
    releasedOn: "2024-11-07",
    artKey: "ps5-pro",
    artViews: ["hero", "front"],
    specs: {
      cpu: PS5_CPU,
      gpu: "AMD Radeon, 16.7 TFLOPS",
      ram_gb: 16,
      storage_gb: 2000,
      storage_type: "NVMe SSD",
      storage_expansion: PS5_EXPANSION,
      disc_drive: t3(
        "غير مرفق؛ يقبل مشغّل أقراص PS5 الذي يُباع منفصلاً",
        "Not included; accepts the separately sold PS5 disc drive",
        "لەگەڵیدا نییە؛ خوێنەری دیسکی PS5 وەردەگرێت کە بە جیا دەفرۆشرێت",
      ),
      tv_output: PS5_TV,
      upscaling: "PlayStation Spectral Super Resolution (PSSR)",
      weight_g: 3100,
      dimensions_mm: "388 × 89 × 216",
      wifi: "Wi-Fi 7",
      bluetooth: true,
    },
  },
  {
    slug: "ps-portal",
    platform: "playstation",
    generation: "ps5",
    name: t3("PlayStation Portal (مشغّل اللعب عن بُعد)", "PlayStation Portal Remote Player", "PlayStation Portal (یاریکەری لە دوورەوە)"),
    summary: t3(
      "شاشة 8 بوصات بأزرار DualSense تبثّ ألعاب جهاز PS5 الذي تملكه عبر Wi-Fi. لا يشغّل الألعاب بمفرده.",
      "An 8-inch screen with DualSense controls that streams games from the PS5 you own over Wi-Fi. It does not run games on its own.",
      "شاشەیەکی 8 ئینچ بە دوگمەکانی DualSense کە یارییەکانی ئەو PS5ـەی هەتە لە ڕێگەی Wi-Fiـەوە پەخش دەکات. بە تەنها یاری کارپێناکات.",
    ),
    deviceKind: "console",
    releasedOn: "2023-11-15",
    artKey: "ps-portal",
    artViews: ["hero", "front"],
    specs: {
      display_in: 8,
      display_type: "LCD",
      display_resolution: "1920 × 1080",
      display_refresh_hz: 60,
      touchscreen: true,
      controls: t3(
        "أزرار DualSense مدمجة مع الاهتزاز اللمسي والزنادات التكيفية",
        "Built-in DualSense controls with haptic feedback and adaptive triggers",
        "دوگمەکانی DualSenseـی لکاو لەگەڵ لەرزینی هەستپێکراو و تریگەری گونجاو",
      ),
      audio: t3(
        "PlayStation Link ومنفذ 3.5 ملم؛ لا يدعم سماعات Bluetooth",
        "PlayStation Link and a 3.5 mm jack; no Bluetooth audio",
        "PlayStation Link و دەرچەی 3.5 ملم؛ هێدفۆنی Bluetooth پشتگیری ناکات",
      ),
      requires: t3(
        "جهاز PS5 واتصال Wi-Fi بسرعة 5 ميغابت في الثانية على الأقل (يُفضَّل 15)",
        "A PS5 console and Wi-Fi of at least 5 Mbps (15 Mbps recommended)",
        "ئامێری PS5 و Wi-Fi بە خێرایی لانیکەم 5 مێگابت لە چرکەیەکدا (15 باشترە)",
      ),
      wifi: "Wi-Fi 5",
    },
  },
  {
    slug: "xbox-series-x",
    platform: "xbox",
    generation: "xbox-series",
    name: same("Xbox Series X"),
    summary: t3(
      "أقوى أجهزة Xbox: ألعاب بدقة 4K حتى 120 إطاراً في الثانية، قرص SSD بسعة 1TB ومشغّل أقراص 4K UHD Blu-ray.",
      "The most powerful Xbox: 4K gaming at up to 120 frames per second, a 1TB SSD and a 4K UHD Blu-ray drive.",
      "بەهێزترین Xbox: یاری بە وردیی 4K تا 120 فرەیم لە چرکەیەکدا، SSDـی 1TB و خوێنەری دیسکی 4K UHD Blu-ray.",
    ),
    deviceKind: "console",
    releasedOn: "2020-11-10",
    artKey: "xbox-series-x",
    artViews: ["hero", "front", "back"],
    specs: {
      cpu: t3("AMD Zen 2 مخصص بثماني أنوية، 3.8 غيغاهرتز", "Custom 8-core AMD Zen 2, 3.8 GHz", "AMD Zen 2ـی تایبەت بە 8 ناوک، 3.8 گیگاهێرتز"),
      gpu: "AMD RDNA 2, 12 TFLOPS",
      ram_gb: 16,
      storage_gb: 1000,
      storage_type: "NVMe SSD",
      storage_expansion: XBOX_EXPANSION,
      disc_drive: "4K UHD Blu-ray",
      tv_output: t3("حتى 4K بمعدل 120 إطاراً في الثانية", "Up to 4K at 120 fps", "تا 4K بە 120 فرەیم لە چرکەیەکدا"),
      weight_g: 4450,
      dimensions_mm: "151 × 301 × 151",
      wifi: "Wi-Fi 5",
      bluetooth: false,
    },
  },
  {
    slug: "xbox-series-s",
    platform: "xbox",
    generation: "xbox-series",
    name: same("Xbox Series S"),
    summary: t3(
      "Xbox رقمي بالكامل وصغير الحجم: ألعاب بدقة 1440p حتى 120 إطاراً في الثانية، من دون مشغّل أقراص.",
      "A compact, all-digital Xbox: 1440p gaming at up to 120 frames per second, with no disc drive.",
      "Xboxـێکی بچووک و تەواو دیجیتاڵی: یاری بە وردیی 1440p تا 120 فرەیم لە چرکەیەکدا، بێ خوێنەری دیسک.",
    ),
    deviceKind: "console",
    releasedOn: "2020-11-10",
    artKey: "xbox-series-s",
    artViews: ["hero", "front"],
    specs: {
      cpu: t3("AMD Zen 2 مخصص بثماني أنوية، 3.6 غيغاهرتز", "Custom 8-core AMD Zen 2, 3.6 GHz", "AMD Zen 2ـی تایبەت بە 8 ناوک، 3.6 گیگاهێرتز"),
      gpu: "AMD RDNA 2, 4 TFLOPS",
      ram_gb: 10,
      storage_options: SSD_512_OR_1TB,
      storage_type: "NVMe SSD",
      storage_expansion: XBOX_EXPANSION,
      disc_drive: t3("لا يوجد — جهاز رقمي بالكامل", "None — all-digital console", "نییە — ئامێرێکی تەواو دیجیتاڵی"),
      tv_output: t3("حتى 1440p بمعدل 120 إطاراً في الثانية", "Up to 1440p at 120 fps", "تا 1440p بە 120 فرەیم لە چرکەیەکدا"),
      weight_g: 1930,
      dimensions_mm: "275 × 63.5 × 151",
      wifi: "Wi-Fi 5",
      bluetooth: false,
    },
  },
  {
    slug: "steam-deck-oled",
    platform: "handheld",
    generation: "steam-deck",
    name: same("Steam Deck OLED"),
    summary: t3(
      "حاسوب ألعاب محمول من Valve بشاشة HDR OLED قياس 7.4 بوصة ونظام SteamOS، يشغّل مكتبتك على Steam.",
      "Valve's handheld gaming PC with a 7.4-inch HDR OLED screen and SteamOS, built to play your Steam library.",
      "کۆمپیوتەری یاریی دەستیی Valve بە شاشەی HDR OLEDـی 7.4 ئینچ و سیستەمی SteamOS، بۆ یاریکردنی کتێبخانەکەت لە Steam.",
    ),
    deviceKind: "handheld_pc",
    releasedOn: "2023-11-16",
    artKey: "steam-deck-oled",
    artViews: ["hero", "front"],
    specs: {
      display_in: 7.4,
      display_type: "OLED",
      display_resolution: "1280 × 800",
      display_refresh_hz: 90,
      display_hdr: true,
      touchscreen: true,
      chip: t3("AMD APU مخصص بدقة تصنيع 6 نانومتر (Zen 2 و RDNA 2)", "Custom 6 nm AMD APU (Zen 2 and RDNA 2)", "AMD APUـی تایبەت بە 6 نانۆمەتر (Zen 2 و RDNA 2)"),
      ram_gb: 16,
      storage_options: SSD_512_OR_1TB,
      storage_type: "NVMe SSD",
      storage_expansion: MICROSD_SLOT,
      battery_wh: 50,
      battery_life_hours: "3–12",
      charger_w: 45,
      weight_g: 640,
      dimensions_mm: "298 × 117 × 49",
      os: "SteamOS",
      wifi: "Wi-Fi 6E",
      bluetooth: true,
    },
  },
  {
    slug: "rog-ally-x",
    platform: "handheld",
    generation: "rog-ally",
    name: same("ASUS ROG Ally X"),
    summary: t3(
      "حاسوب ألعاب محمول بنظام Windows 11: معالج AMD Ryzen Z1 Extreme، ذاكرة 24GB وبطارية 80 واط ساعي.",
      "A Windows 11 handheld gaming PC: AMD Ryzen Z1 Extreme, 24GB of memory and an 80Wh battery.",
      "کۆمپیوتەری یاریی دەستی بە Windows 11: پرۆسێسەری AMD Ryzen Z1 Extreme، 24GB ڕام و پاتریی 80 وات‌کاتژمێر.",
    ),
    deviceKind: "handheld_pc",
    releasedOn: "2024-07-22",
    artKey: "rog-ally-x",
    artViews: ["hero", "front"],
    specs: {
      display_in: 7,
      display_type: "LCD",
      display_resolution: "1920 × 1080",
      display_refresh_hz: 120,
      touchscreen: true,
      chip: "AMD Ryzen Z1 Extreme",
      ram_gb: 24,
      storage_gb: 1000,
      storage_type: "NVMe SSD (M.2 2280)",
      storage_expansion: MICROSD_SLOT,
      battery_wh: 80,
      charger_w: 65,
      weight_g: 678,
      dimensions_mm: "280 × 111 × 36.9",
      os: "Windows 11 Home",
      wifi: "Wi-Fi 6E",
      bluetooth: true,
      usb_c_ports: 2,
    },
  },
  {
    slug: "legion-go",
    platform: "handheld",
    generation: "legion-go",
    name: same("Lenovo Legion Go"),
    summary: t3(
      "حاسوب ألعاب محمول بنظام Windows 11 وشاشة 8.8 بوصة بمعدل 144 هرتز، بيدَي تحكم قابلتين للفصل ومسند خلفي.",
      "A Windows 11 handheld gaming PC with an 8.8-inch 144Hz screen, detachable controllers and a kickstand.",
      "کۆمپیوتەری یاریی دەستی بە Windows 11 و شاشەی 8.8 ئینچ بە 144 هێرتز، بە دوو دەسکی جیاکراوە و پاڵپشتی پشتەوە.",
    ),
    deviceKind: "handheld_pc",
    releasedOn: "2023",
    artKey: "legion-go",
    artViews: ["hero", "front"],
    specs: {
      display_in: 8.8,
      display_type: "LCD",
      display_resolution: "2560 × 1600",
      display_refresh_hz: 144,
      touchscreen: true,
      chip: "AMD Ryzen Z1 Extreme",
      ram_gb: 16,
      storage_options: SSD_512_OR_1TB,
      storage_type: "NVMe SSD (M.2 2242)",
      storage_expansion: MICROSD_SLOT,
      battery_wh: 49.2,
      charger_w: 65,
      weight_g: 854,
      dimensions_mm: "299 × 131 × 40.7",
      controls: t3(
        "يدا تحكم قابلتان للفصل بعصي Hall effect",
        "Detachable controllers with Hall-effect sticks",
        "دوو دەسکی جیاکراوە بە جۆیستیکی Hall effect",
      ),
      os: "Windows 11 Home",
      wifi: "Wi-Fi 6E",
      bluetooth: true,
      usb_c_ports: 2,
    },
  },
];

/** "switch-2" → ["switch-2", "switch-2@front", "switch-2@back"] — the form `media.art_key` stores. */
export function artNamesOf(artKey: string, views: ReadonlyArray<"hero" | "front" | "back">): string[] {
  return views.map((view) => (view === "hero" ? artKey : `${artKey}@${view}`));
}

export const deviceModelBySlug = (slug: string): DeviceModelSeed => {
  const model = DEMO_DEVICE_MODELS.find((entry) => entry.slug === slug);
  if (!model) throw new Error(`Demo seed: unknown device model "${slug}"`);
  return model;
};
