/**
 * Reference data the store needs in every environment, including production:
 * Iraq's governorates and districts, the settings defaults of ARCHITECTURE §10, the default stock
 * location, the built-in sales channels, a basic chart of accounts and the inspection templates
 * for used consoles, handheld PCs, controllers and games.
 *
 *   await seedReference(db, now)                       // insert what is missing, never touch existing rows
 *   await seedReference(db, now, { overwrite: true })  // also restore names/labels to the values below
 *
 * Idempotent and safe to run on every deploy: by default it only INSERTs rows that do not exist, so
 * anything an admin has changed (a shipping fee, a district switched off, a renamed account) stays.
 * Settings are never overwritten, even with `overwrite`.
 *
 * Worker-safe (no Node APIs): the first-run setup route can call it with getDb().
 * This is real reference data, not demo data — nothing here is flagged is_demo.
 */
import { sql, type SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import type { L10n } from "~/lib/locales";
import type { BatchStatement, Db } from "../drizzle.server";
import {
  accounts,
  channels,
  districts,
  governorates,
  inspectionTemplates,
  inventoryLocations,
  settings,
  type InspectionTemplateItem,
  type NewAccount,
  type NewDistrict,
  type NewGovernorate,
  type NewInspectionTemplate,
  type SystemAccountKey,
} from "../schema";
import { chunkRows } from "../tx.server";

// ───────────────────────────────────────────────────────────────── settings (ARCHITECTURE §10)

export const SETTINGS_DEFAULTS = {
  "shipping.flat_fee_iqd": 5000,
  "shipping.overrides_enabled": false,
  "payments.cod": { enabled: true },
  "payments.wallet": { enabled: true },
  "payments.bank_transfer": { enabled: true, account_number: "9269317427", recipient_name: "علي خليفة" },
  "payments.zaincash": { enabled: true, number: "07719061852" },
  "checkout.reservation_minutes": 30,
  "checkout.transfer_proof_hours": 24,
  "returns.window_days": 7,
  "tradein.estimate_valid_days": 7,
  "store.contact": {},
  "locale.numbering": { ar: "latn", en: "latn", ckb: "latn" },
} as const;
export type SettingKey = keyof typeof SETTINGS_DEFAULTS;

// ───────────────────────────────────────────────────────────────── stable ids

/** The one sellable stock location every fresh database has. */
export const DEFAULT_LOCATION_ID = "loc_main";
export const governorateId = (slug: string) => `gov_${slug}`;
export const districtId = (governorateSlug: string, districtSlug: string) => `dst_${governorateSlug}_${districtSlug}`;
export const accountId = (key: SystemAccountKey) => `acc_${key}`;

// ───────────────────────────────────────────────────────────────── governorates and districts

type DistrictSeed = readonly [slug: string, ar: string, en: string, ckb: string];
type GovernorateSeed = { slug: string; ar: string; en: string; ckb: string; districts: readonly DistrictSeed[] };

/**
 * The 18 traditional governorates plus Halabja (the 19th, since 2025), each with its main
 * districts (qadhas). The governorate's centre comes first. Names are the ones in everyday use;
 * Kurdish is Sorani (ckb).
 *
 * A few districts are administered differently from their legal governorate (Akre, Shekhan and
 * Bardarash are served from Duhok; Makhmur is listed under Erbil). They are placed where shoppers
 * and couriers look for them; this is a delivery list, not a statement about boundaries, and
 * staff can move or add districts in the admin.
 */
export const IRAQ_GOVERNORATES: readonly GovernorateSeed[] = [
  {
    slug: "baghdad", ar: "بغداد", en: "Baghdad", ckb: "بەغدا",
    districts: [
      ["rusafa", "الرصافة", "Rusafa", "ڕوسافە"],
      ["karkh", "الكرخ", "Karkh", "کەرخ"],
      ["adhamiyah", "الأعظمية", "Adhamiyah", "ئەعزەمیە"],
      ["kadhimiya", "الكاظمية", "Kadhimiya", "کازمیە"],
      ["mansour", "المنصور", "Mansour", "مەنسوور"],
      ["karrada", "الكرادة", "Karrada", "کەڕادە"],
      ["sadr-city", "مدينة الصدر", "Sadr City", "شاری سەدر"],
      ["new-baghdad", "بغداد الجديدة", "New Baghdad", "بەغدای نوێ"],
      ["rashid", "الرشيد", "Al-Rashid", "ڕەشید"],
      ["abu-ghraib", "أبو غريب", "Abu Ghraib", "ئەبو غرێب"],
      ["mahmudiya", "المحمودية", "Mahmudiya", "مەحموودیە"],
      ["madain", "المدائن", "Al-Mada'in", "مەدائین"],
      ["tarmiya", "الطارمية", "Tarmiya", "تارمیە"],
      ["taji", "التاجي", "Taji", "تاجی"],
    ],
  },
  {
    slug: "basra", ar: "البصرة", en: "Basra", ckb: "بەسرە",
    districts: [
      ["basra", "البصرة", "Basra", "بەسرە"],
      ["zubair", "الزبير", "Al-Zubair", "زوبێر"],
      ["abu-al-khaseeb", "أبو الخصيب", "Abu Al-Khaseeb", "ئەبولخەسیب"],
      ["qurna", "القرنة", "Al-Qurna", "قوڕنە"],
      ["shatt-al-arab", "شط العرب", "Shatt Al-Arab", "شەتولعەرەب"],
      ["faw", "الفاو", "Al-Faw", "فاو"],
      ["midaina", "المدينة", "Al-Midaina", "مەدەینە"],
    ],
  },
  {
    slug: "nineveh", ar: "نينوى", en: "Nineveh", ckb: "نەینەوا",
    districts: [
      ["mosul", "الموصل", "Mosul", "مووسڵ"],
      ["tel-afar", "تلعفر", "Tel Afar", "تەلەعفەر"],
      ["sinjar", "سنجار", "Sinjar", "شنگال"],
      ["hamdaniya", "الحمدانية", "Al-Hamdaniya", "حەمدانیە"],
      ["tel-kaif", "تلكيف", "Tel Kaif", "تلکێف"],
      ["hatra", "الحضر", "Hatra", "حەزەر"],
      ["baaj", "البعاج", "Al-Ba'aj", "بەعاج"],
    ],
  },
  {
    slug: "erbil", ar: "أربيل", en: "Erbil", ckb: "هەولێر",
    districts: [
      ["erbil", "أربيل", "Erbil", "هەولێر"],
      ["dashti-hawler", "دشتي هولير", "Dashti Hawler", "دەشتی هەولێر"],
      ["soran", "سوران", "Soran", "سۆران"],
      ["shaqlawa", "شقلاوة", "Shaqlawa", "شەقڵاوە"],
      ["koya", "كويسنجق", "Koya", "کۆیە"],
      ["choman", "جومان", "Choman", "چۆمان"],
      ["mergasor", "ميركسور", "Mergasor", "مێرگەسۆر"],
      ["rawanduz", "راوندوز", "Rawanduz", "ڕەواندز"],
      ["khabat", "خبات", "Khabat", "خەبات"],
      ["makhmur", "مخمور", "Makhmur", "مەخموور"],
    ],
  },
  {
    slug: "sulaymaniyah", ar: "السليمانية", en: "Sulaymaniyah", ckb: "سلێمانی",
    districts: [
      ["sulaymaniyah", "السليمانية", "Sulaymaniyah", "سلێمانی"],
      ["ranya", "رانية", "Ranya", "ڕانیە"],
      ["pshdar", "بشدر", "Pshdar", "پشدەر"],
      ["dukan", "دوكان", "Dukan", "دوکان"],
      ["chamchamal", "جمجمال", "Chamchamal", "چەمچەماڵ"],
      ["kalar", "كلار", "Kalar", "کەلار"],
      ["darbandikhan", "دربندخان", "Darbandikhan", "دەربەندیخان"],
      ["penjwen", "بنجوين", "Penjwen", "پێنجوێن"],
      ["sharbazher", "شهربازار", "Sharbazher", "شارباژێڕ"],
      ["said-sadiq", "سيد صادق", "Said Sadiq", "سەید سادق"],
      ["sharazur", "شهرزور", "Sharazur", "شارەزوور"],
      ["qaradagh", "قره داغ", "Qaradagh", "قەرەداغ"],
      ["mawat", "ماوت", "Mawat", "ماوەت"],
    ],
  },
  {
    slug: "duhok", ar: "دهوك", en: "Duhok", ckb: "دهۆک",
    districts: [
      ["duhok", "دهوك", "Duhok", "دهۆک"],
      ["zakho", "زاخو", "Zakho", "زاخۆ"],
      ["sumel", "سميل", "Sumel", "سێمێل"],
      ["amedi", "العمادية", "Amedi", "ئامێدی"],
      ["akre", "عقرة", "Akre", "ئاکرێ"],
      ["shekhan", "الشيخان", "Shekhan", "شێخان"],
      ["bardarash", "بردرش", "Bardarash", "بەردەڕەش"],
    ],
  },
  {
    slug: "kirkuk", ar: "كركوك", en: "Kirkuk", ckb: "کەرکووک",
    districts: [
      ["kirkuk", "كركوك", "Kirkuk", "کەرکووک"],
      ["hawija", "الحويجة", "Hawija", "حەویجە"],
      ["daquq", "داقوق", "Daquq", "داقووق"],
      ["dibis", "الدبس", "Dibis", "دوبز"],
    ],
  },
  {
    slug: "diyala", ar: "ديالى", en: "Diyala", ckb: "دیالە",
    districts: [
      ["baqubah", "بعقوبة", "Baqubah", "بەعقووبە"],
      ["muqdadiya", "المقدادية", "Al-Muqdadiya", "شارەبان"],
      ["khalis", "الخالص", "Al-Khalis", "خالس"],
      ["khanaqin", "خانقين", "Khanaqin", "خانەقین"],
      ["baladruz", "بلدروز", "Baladruz", "بەلەدرووز"],
      ["kifri", "كفري", "Kifri", "کفری"],
    ],
  },
  {
    slug: "anbar", ar: "الأنبار", en: "Anbar", ckb: "ئەنبار",
    districts: [
      ["ramadi", "الرمادي", "Ramadi", "ڕومادی"],
      ["fallujah", "الفلوجة", "Fallujah", "فەللووجە"],
      ["hit", "هيت", "Hit", "هیت"],
      ["haditha", "حديثة", "Haditha", "حەدیسە"],
      ["anah", "عنه", "Anah", "عانە"],
      ["rawa", "راوة", "Rawa", "ڕاوە"],
      ["qaim", "القائم", "Al-Qa'im", "قائیم"],
      ["rutba", "الرطبة", "Ar-Rutba", "ڕوتبە"],
    ],
  },
  {
    slug: "babil", ar: "بابل", en: "Babil", ckb: "بابل",
    districts: [
      ["hillah", "الحلة", "Hillah", "حیللە"],
      ["mahawil", "المحاويل", "Al-Mahawil", "مەحاویل"],
      ["hashimiya", "الهاشمية", "Al-Hashimiya", "هاشمیە"],
      ["musayyib", "المسيب", "Al-Musayyib", "موسەییب"],
    ],
  },
  {
    slug: "karbala", ar: "كربلاء", en: "Karbala", ckb: "کەربەلا",
    districts: [
      ["karbala", "كربلاء", "Karbala", "کەربەلا"],
      ["hindiya", "الهندية", "Al-Hindiya", "هیندیە"],
      ["ain-al-tamur", "عين التمر", "Ain Al-Tamur", "عەین تەمر"],
    ],
  },
  {
    slug: "najaf", ar: "النجف", en: "Najaf", ckb: "نەجەف",
    districts: [
      ["najaf", "النجف", "Najaf", "نەجەف"],
      ["kufa", "الكوفة", "Kufa", "کووفە"],
      ["manathera", "المناذرة", "Al-Manathera", "مەنازرە"],
      ["mishkhab", "المشخاب", "Al-Mishkhab", "مشخاب"],
    ],
  },
  {
    slug: "wasit", ar: "واسط", en: "Wasit", ckb: "واست",
    districts: [
      ["kut", "الكوت", "Kut", "کووت"],
      ["numaniyah", "النعمانية", "An-Numaniyah", "نوعمانیە"],
      ["hai", "الحي", "Al-Hai", "حەی"],
      ["badra", "بدرة", "Badra", "بەدرە"],
      ["suwaira", "الصويرة", "As-Suwaira", "سوەیرە"],
      ["aziziyah", "العزيزية", "Al-Aziziyah", "عەزیزیە"],
    ],
  },
  {
    slug: "salah-al-din", ar: "صلاح الدين", en: "Salah Al-Din", ckb: "سەڵاحەدین",
    districts: [
      ["tikrit", "تكريت", "Tikrit", "تکریت"],
      ["samarra", "سامراء", "Samarra", "سامەڕا"],
      ["balad", "بلد", "Balad", "بەلەد"],
      ["baiji", "بيجي", "Baiji", "بێجی"],
      ["dujail", "الدجيل", "Dujail", "دوجەیل"],
      ["shirqat", "الشرقاط", "Al-Shirqat", "شەرقات"],
      ["tuz-khurmatu", "طوز خورماتو", "Tuz Khurmatu", "دووزخورماتوو"],
      ["dawr", "الدور", "Ad-Dawr", "دوور"],
    ],
  },
  {
    slug: "qadisiyah", ar: "القادسية", en: "Al-Qadisiyah", ckb: "قادسیە",
    districts: [
      ["diwaniyah", "الديوانية", "Diwaniyah", "دیوانیە"],
      ["afak", "عفك", "Afak", "عەفەک"],
      ["shamiya", "الشامية", "Ash-Shamiya", "شامیە"],
      ["hamza", "الحمزة", "Al-Hamza", "حەمزە"],
    ],
  },
  {
    slug: "maysan", ar: "ميسان", en: "Maysan", ckb: "مەیسان",
    districts: [
      ["amarah", "العمارة", "Amarah", "عەمارە"],
      ["ali-al-gharbi", "علي الغربي", "Ali Al-Gharbi", "عەلی غەربی"],
      ["maimouna", "الميمونة", "Al-Maimouna", "مەیموونە"],
      ["qalat-saleh", "قلعة صالح", "Qal'at Saleh", "قەلعە ساڵح"],
      ["majar-al-kabir", "المجر الكبير", "Al-Majar Al-Kabir", "مەجەڕی گەورە"],
      ["kahla", "الكحلاء", "Al-Kahla", "کەحلا"],
    ],
  },
  {
    slug: "dhi-qar", ar: "ذي قار", en: "Dhi Qar", ckb: "زیقار",
    districts: [
      ["nasiriyah", "الناصرية", "Nasiriyah", "ناسریە"],
      ["rifai", "الرفاعي", "Ar-Rifa'i", "ڕیفاعی"],
      ["suq-al-shuyukh", "سوق الشيوخ", "Suq Al-Shuyukh", "سووق شیوخ"],
      ["chibayish", "الجبايش", "Al-Chibayish", "چبایش"],
      ["shatra", "الشطرة", "Ash-Shatra", "شەترە"],
    ],
  },
  {
    slug: "muthanna", ar: "المثنى", en: "Al-Muthanna", ckb: "موسەننا",
    districts: [
      ["samawah", "السماوة", "Samawah", "سەماوە"],
      ["rumaitha", "الرميثة", "Ar-Rumaitha", "ڕومەیسە"],
      ["khidhir", "الخضر", "Al-Khidhir", "خزر"],
      ["salman", "السلمان", "As-Salman", "سەلمان"],
    ],
  },
  {
    slug: "halabja", ar: "حلبجة", en: "Halabja", ckb: "هەڵەبجە",
    districts: [
      ["halabja", "حلبجة", "Halabja", "هەڵەبجە"],
      ["sirwan", "سيروان", "Sirwan", "سیروان"],
      ["khurmal", "خورمال", "Khurmal", "خورماڵ"],
      ["byara", "بيارة", "Byara", "بیارە"],
    ],
  },
];

// ───────────────────────────────────────────────────────────────── chart of accounts

type AccountSeed = { key: SystemAccountKey; code: string; type: NewAccount["type"]; isContra?: boolean; parent?: SystemAccountKey; name: L10n };

/** A basic chart; services find accounts by `system_key`, so an accountant can renumber or rename freely. */
export const CHART_OF_ACCOUNTS: readonly AccountSeed[] = [
  { key: "cash", code: "1000", type: "asset", name: { ar: "الصندوق (النقد)", en: "Cash on hand", ckb: "سندوق (نەختینە)" } },
  { key: "bank_clearing", code: "1010", type: "asset", name: { ar: "مقاصة التحويلات (البطاقة المصرفية وزين كاش)", en: "Bank and transfer clearing", ckb: "پاککردنەوەی حەواڵەکان (کارتی بانکی و زەین کاش)" } },
  { key: "cod_receivable", code: "1020", type: "asset", name: { ar: "ذمم الدفع عند الاستلام", en: "Cash-on-delivery receivable", ckb: "وەرگیراوی پارەدان لە کاتی وەرگرتن" } },
  { key: "inventory", code: "1200", type: "asset", name: { ar: "المخزون", en: "Inventory", ckb: "کۆگا" } },
  { key: "accounts_payable", code: "2000", type: "liability", name: { ar: "ذمم الموردين", en: "Accounts payable", ckb: "قەرزی دابینکەران" } },
  { key: "wallet_liability", code: "2100", type: "liability", name: { ar: "أرصدة محافظ العملاء", en: "Customer wallet liability", ckb: "باڵانسی جزدانی کڕیاران" } },
  { key: "owner_equity", code: "3000", type: "equity", name: { ar: "حقوق الملكية", en: "Owner's equity", ckb: "مافی خاوەندارێتی" } },
  { key: "sales_revenue", code: "4000", type: "revenue", name: { ar: "إيراد المبيعات", en: "Sales revenue", ckb: "داهاتی فرۆشتن" } },
  { key: "shipping_income", code: "4100", type: "revenue", name: { ar: "إيراد التوصيل", en: "Shipping income", ckb: "داهاتی گەیاندن" } },
  { key: "sales_discounts", code: "4800", type: "revenue", isContra: true, name: { ar: "خصومات المبيعات", en: "Sales discounts", ckb: "داشکاندنی فرۆشتن" } },
  { key: "sales_refunds", code: "4900", type: "revenue", isContra: true, name: { ar: "مردودات واستردادات المبيعات", en: "Sales returns and refunds", ckb: "گەڕاندنەوە و پارەگەڕاندنەوەی فرۆشتن" } },
  { key: "cogs", code: "5000", type: "expense", name: { ar: "تكلفة البضاعة المباعة", en: "Cost of goods sold", ckb: "تێچووی کاڵای فرۆشراو" } },
  { key: "inventory_adjustments", code: "5100", type: "expense", name: { ar: "تسويات المخزون (تلف وفروقات جرد)", en: "Inventory adjustments", ckb: "ڕێکخستنی کۆگا (تێکچوون و جیاوازیی ژماردن)" } },
  { key: "operating_expenses", code: "6000", type: "expense", name: { ar: "مصروفات تشغيلية", en: "Operating expenses", ckb: "خەرجییەکانی کارپێکردن" } },
  { key: "shipping_costs", code: "6100", type: "expense", parent: "operating_expenses", name: { ar: "تكاليف الشحن والتوصيل", en: "Shipping and delivery costs", ckb: "تێچووی گەیاندن" } },
  { key: "commissions", code: "6200", type: "expense", parent: "operating_expenses", name: { ar: "عمولات", en: "Commissions", ckb: "کۆمیسیۆن" } },
  { key: "payroll", code: "6300", type: "expense", parent: "operating_expenses", name: { ar: "رواتب وأجور", en: "Payroll", ckb: "مووچە" } },
  { key: "marketing", code: "6400", type: "expense", parent: "operating_expenses", name: { ar: "تسويق وإعلان", en: "Marketing and advertising", ckb: "مارکێتینگ و ڕیکلام" } },
  { key: "cash_over_short", code: "6900", type: "expense", parent: "operating_expenses", name: { ar: "عجز وزيادة الصندوق", en: "Cash over and short", ckb: "زیادە و کەمیی سندوق" } },
];

// ───────────────────────────────────────────────────────────────── inspection templates (13.02)

const item = (key: string, ar: string, en: string, ckb: string, options: Partial<Omit<InspectionTemplateItem, "key" | "label">> = {}): InspectionTemplateItem => ({
  key,
  label: { ar, en, ckb },
  input: options.input ?? "pass_fail",
  required: options.required ?? true,
  ...(options.critical ? { critical: true } : {}),
  ...(options.hint ? { hint: options.hint } : {}),
});

const HANDHELD_ONLY = { ar: "للأجهزة ذات الشاشة فقط — اختر «لا ينطبق» للأجهزة المنزلية.", en: "Devices with a built-in screen only — choose “not applicable” for home consoles.", ckb: "تەنها بۆ ئامێرە شاشەدارەکان — بۆ ئامێری ماڵەوە «ناگونجێت» هەڵبژێرە." };

/** Checklists a technician fills in before a used device can be listed. Editable in the admin. */
export const INSPECTION_TEMPLATES: ReadonlyArray<{ id: string; deviceKind: NewInspectionTemplate["deviceKind"]; name: L10n; items: InspectionTemplateItem[] }> = [
  {
    id: "itpl_console_v1",
    deviceKind: "console",
    name: { ar: "فحص جهاز ألعاب", en: "Console inspection", ckb: "پشکنینی ئامێری یاری" },
    items: [
      item("power", "يشتغل ويقلع إلى الواجهة الرئيسية", "Powers on and boots to the home screen", "دادەگیرسێت و دەگاتە شاشەی سەرەکی", { critical: true }),
      item("video_output", "إخراج الصورة والصوت (HDMI أو الشاشة)", "Video and audio output (HDMI or built-in screen)", "دەرچوونی وێنە و دەنگ (HDMI یان شاشە)"),
      item("screen", "الشاشة: بكسلات ميتة، خدوش، اللمس", "Screen: dead pixels, scratches, touch", "شاشە: پیکسڵی مردوو، ڕووشان، دەستلێدان", { required: false, hint: HANDHELD_ONLY }),
      item("battery", "صحة البطارية (٪)", "Battery health (%)", "تەندروستیی پاتری (٪)", { input: "percent", required: false, hint: HANDHELD_ONLY }),
      item("ports", "المنافذ: الشحن، USB، HDMI، السماعة", "Ports: charging, USB, HDMI, headphone", "دەرچەکان: بارگاویکردن، USB، HDMI، هێدفۆن"),
      item("disc_drive", "قارئ الأقراص أو فتحة بطاقات الألعاب", "Disc drive or game-card slot", "خوێنەری دیسک یان شوێنی کارتی یاری", { required: false }),
      item("buttons", "أزرار الجهاز", "Console buttons", "دوگمەکانی ئامێر"),
      item("sticks", "عصي التحكم المرفقة: انحراف واستجابة", "Attached sticks: drift and response", "جۆیستیکە لکاوەکان: لادان و وەڵامدانەوە", { required: false }),
      item("heat", "الحرارة وصوت المروحة أثناء اللعب", "Heat and fan noise under load", "گەرمی و دەنگی پانکە لە کاتی یاریکردن"),
      item("wifi", "Wi-Fi والبلوتوث", "Wi-Fi and Bluetooth", "وای‌فای و بلوتوس"),
      item("storage", "وحدة التخزين: السعة وسلامة القراءة والكتابة", "Storage: capacity and read/write health", "بیرگە: قەبارە و تەندروستیی خوێندنەوە و نووسین"),
      item("account_lock", "الحسابات مُزالة ولا يوجد قفل أو حظر على الجهاز", "Accounts removed; no lock or ban on the console", "هەژمارەکان لابراون و هیچ قفڵ یان باندێک لەسەر ئامێرەکە نییە", { critical: true }),
      item("accessories", "الملحقات المرفقة (يد تحكم، كيبلات، قاعدة)", "Included accessories (controller, cables, dock)", "پاشکۆ هاوپێچەکان (دەسکی یاری، کێبڵ، بنکە)", { input: "text", required: false }),
    ],
  },
  {
    id: "itpl_handheld_pc_v1",
    deviceKind: "handheld_pc",
    name: { ar: "فحص حاسوب ألعاب محمول", en: "Handheld PC inspection", ckb: "پشکنینی کۆمپیوتەری یاریی دەستی" },
    items: [
      item("power", "يشتغل ويقلع إلى النظام", "Powers on and boots to the system", "دادەگیرسێت و دەگاتە سیستەم", { critical: true }),
      item("screen", "الشاشة: بكسلات ميتة، خدوش، سطوع", "Screen: dead pixels, scratches, brightness", "شاشە: پیکسڵی مردوو، ڕووشان، ڕووناکی"),
      item("touch", "اللمس على كامل الشاشة", "Touch across the whole screen", "دەستلێدان لە هەموو شاشەکە"),
      item("battery", "صحة البطارية (٪)", "Battery health (%)", "تەندروستیی پاتری (٪)", { input: "percent" }),
      item("ports", "المنافذ: USB-C والشحن والسماعة وقارئ البطاقات", "Ports: USB-C, charging, headphone, card reader", "دەرچەکان: USB-C، بارگاویکردن، هێدفۆن، خوێنەری کارت"),
      item("buttons", "الأزرار والأزرار الخلفية", "Buttons and back paddles", "دوگمەکان و دوگمەکانی پشتەوە"),
      item("sticks", "عصي التحكم: انحراف واستجابة", "Sticks: drift and response", "جۆیستیکەکان: لادان و وەڵامدانەوە"),
      item("triggers", "الأزرار الكتفية والزنادات", "Bumpers and triggers", "دوگمەکانی شان و تریگەرەکان"),
      item("heat", "الحرارة وصوت المروحة أثناء اللعب", "Heat and fan noise under load", "گەرمی و دەنگی پانکە لە کاتی یاریکردن"),
      item("wifi", "Wi-Fi والبلوتوث", "Wi-Fi and Bluetooth", "وای‌فای و بلوتوس"),
      item("storage", "وحدة التخزين: السعة والسلامة", "Storage: capacity and health", "بیرگە: قەبارە و تەندروستی"),
      item("audio", "السماعات والميكروفون", "Speakers and microphone", "بلندگۆ و مایکرۆفۆن", { required: false }),
      item("account_lock", "حسابات المستخدم مُزالة ولا يوجد قفل على النظام أو الـ BIOS", "User accounts removed; no system or BIOS lock", "هەژمارەکانی بەکارهێنەر لابراون و هیچ قفڵێک لەسەر سیستەم یان BIOS نییە", { critical: true }),
      item("accessories", "الملحقات المرفقة (شاحن، حافظة، قاعدة)", "Included accessories (charger, case, dock)", "پاشکۆ هاوپێچەکان (بارگاویکەر، بەرگ، بنکە)", { input: "text", required: false }),
    ],
  },
  {
    id: "itpl_controller_v1",
    deviceKind: "controller",
    name: { ar: "فحص يد تحكم", en: "Controller inspection", ckb: "پشکنینی دەسکی یاری" },
    items: [
      item("buttons", "جميع الأزرار وأسهم الاتجاهات", "All buttons and the D-pad", "هەموو دوگمەکان و دوگمەی ئاڕاستەکان", { critical: true }),
      item("sticks", "عصي التحكم: انحراف واستجابة ونقر", "Sticks: drift, response and click", "جۆیستیکەکان: لادان، وەڵامدانەوە و کلیک", { critical: true }),
      item("triggers", "الأزرار الكتفية والزنادات", "Bumpers and triggers", "دوگمەکانی شان و تریگەرەکان"),
      item("vibration", "الاهتزاز", "Vibration", "لەرزین", { required: false }),
      item("battery", "البطارية والشحن", "Battery and charging", "پاتری و بارگاویکردن"),
      item("ports", "منفذ الشحن ومنفذ السماعة", "Charging port and headphone jack", "دەرچەی بارگاویکردن و دەرچەی هێدفۆن"),
      item("wireless", "الاتصال اللاسلكي والاقتران", "Wireless connection and pairing", "پەیوەندیی بێتەل و جووتکردن"),
      item("shell", "الحالة الخارجية: خدوش، كسور، مقابض", "Exterior: scratches, cracks, grips", "دۆخی دەرەوە: ڕووشان، شکان، دەسک", { input: "text", required: false }),
      item("accessories", "الملحقات المرفقة (كيبل، علبة)", "Included accessories (cable, box)", "پاشکۆ هاوپێچەکان (کێبڵ، قوتوو)", { input: "text", required: false }),
    ],
  },
  {
    id: "itpl_game_v1",
    deviceKind: "game",
    name: { ar: "فحص لعبة مستعملة", en: "Used game inspection", ckb: "پشکنینی یاریی بەکارهاتوو" },
    items: [
      item("media", "سطح القرص أو البطاقة: خدوش وتشققات", "Disc or cartridge surface: scratches and cracks", "ڕووی دیسک یان کارت: ڕووشان و درز", { critical: true }),
      item("boots", "تعمل على الجهاز وتبدأ اللعبة", "Loads and starts on the console", "لەسەر ئامێر کاردەکات و یارییەکە دەست پێدەکات", { critical: true }),
      item("case", "العلبة والغلاف", "Case and cover art", "قوتوو و بەرگ", { required: false }),
      item("region", "المنطقة والتوافق مع المنصة", "Region and platform compatibility", "ناوچە و گونجان لەگەڵ پلاتفۆرم", { input: "text" }),
      item("codes", "رموز المحتوى الإضافي غير مستخدمة، إن وجدت", "Bundled content codes unused, if any", "کۆدی ناوەڕۆکی زیادە بەکارنەهاتووە، ئەگەر هەبێت", { required: false }),
    ],
  },
];

// ───────────────────────────────────────────────────────────────── seeding

export type SeedReferenceOptions = {
  /** Also reset names, labels and template items of existing reference rows to the values in this file. Never touches settings. */
  overwrite?: boolean;
};

export type SeedReferenceResult = { governorates: number; districts: number; settings: number; accounts: number; inspectionTemplates: number; locations: number; channels: number };

/** `excluded.<column>` for ON CONFLICT DO UPDATE. */
const excluded = (column: SQLiteColumn): SQL => sql.raw(`excluded.${column.name}`);

/**
 * Insert-if-missing statements for `rows`, sized to D1's bound-parameter limit. With `update`
 * (column → value) existing rows are refreshed instead of left alone.
 */
function upsert<T extends SQLiteTable>(db: Db, table: T, rows: T["$inferInsert"][], target: SQLiteColumn | SQLiteColumn[], update?: Record<string, SQL>): BatchStatement[] {
  return chunkRows(table, rows).map((part) => {
    const insert = db.insert(table).values(part);
    return update ? insert.onConflictDoUpdate({ target, set: update as never }) : insert.onConflictDoNothing({ target });
  });
}

export async function seedReference(db: Db, now: number, options: SeedReferenceOptions = {}): Promise<SeedReferenceResult> {
  const overwrite = options.overwrite === true;

  const governorateRows: NewGovernorate[] = IRAQ_GOVERNORATES.map((g, index) => ({
    id: governorateId(g.slug),
    slug: g.slug,
    name: { ar: g.ar, en: g.en, ckb: g.ckb },
    sort: (index + 1) * 10,
  }));

  const districtRows: NewDistrict[] = IRAQ_GOVERNORATES.flatMap((g) =>
    g.districts.map(([slug, ar, en, ckb], index) => ({
      id: districtId(g.slug, slug),
      governorateId: governorateId(g.slug),
      slug,
      name: { ar, en, ckb },
      sort: (index + 1) * 10,
    })),
  );

  const settingRows = Object.entries(SETTINGS_DEFAULTS).map(([key, value]) => ({ key, value: value as unknown, updatedAt: now, updatedBy: null }));

  const accountRows: NewAccount[] = CHART_OF_ACCOUNTS.map((a) => ({
    id: accountId(a.key),
    code: a.code,
    name: a.name,
    type: a.type,
    systemKey: a.key,
    isContra: a.isContra ?? false,
    parentId: a.parent ? accountId(a.parent) : null,
    isSystem: true,
  }));

  const templateRows: NewInspectionTemplate[] = INSPECTION_TEMPLATES.map((t) => ({
    id: t.id,
    deviceKind: t.deviceKind,
    name: t.name,
    items: t.items,
    version: 1,
    updatedAt: now,
  }));

  const statements: BatchStatement[] = [
    ...upsert(db, governorates, governorateRows, governorates.id, overwrite ? { name: excluded(governorates.name), slug: excluded(governorates.slug) } : undefined),
    ...upsert(db, districts, districtRows, districts.id, overwrite ? { name: excluded(districts.name), slug: excluded(districts.slug), governorateId: excluded(districts.governorateId) } : undefined),
    // Settings: insert defaults only. An existing value is the owner's decision and is never replaced.
    ...upsert(db, settings, settingRows, settings.key),
    ...upsert(
      db,
      inventoryLocations,
      [{ id: DEFAULT_LOCATION_ID, code: "MAIN", name: "المخزن الرئيسي", kind: "warehouse", isSellable: true }],
      inventoryLocations.id,
    ),
    ...upsert(
      db,
      channels,
      [
        { id: "chn_web", key: "web", name: { ar: "المتجر الإلكتروني", en: "Online store", ckb: "فرۆشگای ئۆنلاین" }, kind: "online", isSystem: true, createdAt: now },
        { id: "chn_pos", key: "pos", name: { ar: "نقطة البيع", en: "Point of sale", ckb: "خاڵی فرۆشتن" }, kind: "pos", isSystem: true, createdAt: now },
      ],
      channels.id,
    ),
    // Parents (no `parent`) come first in CHART_OF_ACCOUNTS, so the self-reference is always satisfied.
    ...upsert(db, accounts, accountRows, accounts.id, overwrite ? { name: excluded(accounts.name), type: excluded(accounts.type), isContra: excluded(accounts.isContra) } : undefined),
    ...upsert(
      db,
      inspectionTemplates,
      templateRows,
      inspectionTemplates.id,
      overwrite ? { name: excluded(inspectionTemplates.name), items: excluded(inspectionTemplates.items), updatedAt: excluded(inspectionTemplates.updatedAt) } : undefined,
    ),
  ];

  // One batch = one transaction: either all reference data is there, or none of this run's rows are.
  await db.batch(statements as [BatchStatement, ...BatchStatement[]]);

  return {
    governorates: governorateRows.length,
    districts: districtRows.length,
    settings: settingRows.length,
    accounts: accountRows.length,
    inspectionTemplates: templateRows.length,
    locations: 1,
    channels: 2,
  };
}
