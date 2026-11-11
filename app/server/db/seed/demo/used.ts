/**
 * DEMO used devices and trade-in reference prices.
 *
 * Six listed units across the four grades, each an instance of a serial-tracked catalogue variant
 * (a console or handheld PC). They are flagged is_demo, which is the only reason the database lets
 * them be listed without real photographs: their pictures are the maker's official photos of the
 * MODEL, flagged as illustrations (`is_illustration = 1`; the storefront labels them
 * "صورة توضيحية"). What comes with each unit is a subset of the researched box contents.
 * Checklists follow the inspection templates of the reference seed (itpl_console_v1 /
 * itpl_handheld_pc_v1). Serial numbers are obviously fake ("DEMO-USED-…") and, like all serials,
 * never shown on public pages.
 *
 * No trade-in requests are seeded: a request belongs to a person (it needs a phone number), and the
 * seed creates no people. The units therefore have no `trade_in_id`.
 *
 * Money follows the demo prices (./pricing.ts): a unit sells at a grade share of its new variant's
 * price; the trade-in guide of each device model we buy pays a share of the model's new price
 * (`base_iqd` for grade A+), times the grade multiplier, less a deduction per missing item; what the
 * store paid for each unit follows that guide, so margin reports on used units add up.
 */
import type { ChecklistResult, IncludedItem, UsedDefect, UsedGrade } from "../../schema";
import type { CatalogProduct } from "./catalog/types";
import type { DeviceModelSeed } from "./devices";
import { PRICE_STEP_IQD } from "./pricing";
import { t3, type T3 } from "./text";

type ChecklistItem = { key: string; result: ChecklistResult | null; value?: string | number };

export type UsedUnitSeed = {
  slug: string;
  /** SKU of the catalogue variant this unit is an instance of (serial-tracked). */
  sku: string;
  serial: string;
  grade: UsedGrade;
  batteryHealthPct?: number;
  cosmeticNotes: T3;
  defects: UsedDefect[];
  included: IncludedItem[];
  /** Deduction keys of the device's trade-in guide for what this unit came without. */
  missing: string[];
  templateId: "itpl_console_v1" | "itpl_handheld_pc_v1";
  checklist: ChecklistItem[];
  warrantyDays: number;
  /** Days before the seed time at which the unit was inspected and listed. */
  inspectedDaysAgo: number;
  listedDaysAgo: number;
};

const pass = (key: string): ChecklistItem => ({ key, result: "pass" });
const na = (key: string): ChecklistItem => ({ key, result: "na" });
const battery = (pct: number): ChecklistItem => ({ key: "battery", result: "pass", value: pct });
/** Free-text line as a technician would type it (staff language: Arabic). */
const noted = (key: string, value: string): ChecklistItem => ({ key, result: null, value });

const ITEM = {
  dualsense: { key: "controller", label: t3("يد DualSense واحدة", "One DualSense controller", "یەک دەسکی DualSense") },
  xboxController: { key: "controller", label: t3("يد تحكم Xbox اللاسلكية", "Xbox Wireless Controller", "دەسکی یاریی بێتەلی Xbox") },
  detachableControllers: { key: "controllers", label: t3("يدا التحكم القابلتان للفصل", "Both detachable controllers", "هەردوو دەسکە جیاکراوەکە") },
  powerCable: { key: "power_cable", label: t3("كيبل الطاقة", "Power cord", "کێبڵی کارەبا") },
  hdmiCable: { key: "hdmi_cable", label: t3("كيبل HDMI", "HDMI cable", "کێبڵی HDMI") },
  originalBox: { key: "original_box", label: t3("العلبة الأصلية", "Original box", "قوتووی ئەسڵی") },
  dock: { key: "dock", label: t3("القاعدة", "Dock", "بنکە") },
  joyConPair: { key: "joy_con_pair", label: t3("يدا Joy-Con (يمنى ويسرى)", "Joy-Con pair (L and R)", "جووتە دەسکی Joy-Con (چەپ و ڕاست)") },
  joyConGrip: { key: "joy_con_grip", label: t3("مقبض Joy-Con", "Joy-Con grip", "گرتەی Joy-Con") },
  acAdapter: { key: "ac_adapter", label: t3("محوّل الطاقة الأصلي", "Original AC adapter", "ئەداپتەری کارەبای ئەسڵی") },
  charger: { key: "charger", label: t3("الشاحن الأصلي", "Original charger", "بارگاویکەری ئەسڵی") },
  carryingCase: { key: "carrying_case", label: t3("حقيبة الحمل", "Carrying case", "جانتای هەڵگرتن") },
} satisfies Record<string, IncludedItem>;

/** Added to the alt text of every picture of a used unit: it is the maker's photo of the model. */
export const USED_PHOTO_NOTE: T3 = t3(
  "صورة توضيحية من الشركة المصنّعة، ليست صورة هذا الجهاز",
  "the maker's photo for illustration, not a photo of this unit",
  "وێنەی ڕوونکەرەوەی کۆمپانیای دروستکەر، وێنەی ئەم ئامێرە نییە",
);

/** Pictures a used unit shows: the first official photos of its variant. */
export const USED_UNIT_PHOTOS = 2;

export const DEMO_USED_UNITS: readonly UsedUnitSeed[] = [
  {
    slug: "used-ps5-slim-disc-01",
    sku: "PS5-SLIM-DISC-1TB",
    serial: "DEMO-USED-PS5S-0001",
    grade: "A+",
    cosmeticNotes: t3(
      "حالة شبه جديدة: لا خدوش ظاهرة على الألواح البيضاء ولا على الواجهة السوداء اللامعة.",
      "Near-new condition: no visible scratches on the white plates or the glossy black front.",
      "دۆخی نزیک لە نوێ: هیچ ڕووشانێکی دیار لەسەر پلێتە سپییەکان و ڕووی ڕەشی بریقەدار نییە.",
    ),
    defects: [],
    included: [ITEM.dualsense, ITEM.powerCable, ITEM.hdmiCable, ITEM.originalBox],
    missing: [],
    templateId: "itpl_console_v1",
    checklist: [
      pass("power"),
      pass("video_output"),
      na("screen"),
      na("battery"),
      pass("ports"),
      pass("disc_drive"),
      pass("buttons"),
      na("sticks"),
      pass("heat"),
      pass("wifi"),
      pass("storage"),
      pass("account_lock"),
      noted("accessories", "يد DualSense، كيبل طاقة، كيبل HDMI، العلبة الأصلية"),
    ],
    warrantyDays: 30,
    inspectedDaysAgo: 3,
    listedDaysAgo: 2,
  },
  {
    slug: "used-switch-oled-white-01",
    sku: "NSW-OLED-WHT",
    serial: "DEMO-USED-NSWO-0001",
    grade: "A",
    batteryHealthPct: 91,
    cosmeticNotes: t3(
      "خدوش خفيفة جداً على ظهر الجهاز لا تُرى إلا تحت ضوء مباشر. الشاشة بلا خدوش.",
      "Very light scratches on the back, visible only under direct light. The screen has no scratches.",
      "ڕووشانی زۆر سووک لەسەر پشتی ئامێرەکە کە تەنها لەژێر ڕووناکیی ڕاستەوخۆدا دەبینرێت. شاشەکە هیچ ڕووشانێکی نییە.",
    ),
    defects: [{ area: "back", severity: "minor", note: t3("خدوش سطحية خفيفة على الظهر", "Light surface scratches on the back", "ڕووشانی سووکی ڕووکەش لەسەر پشت") }],
    included: [ITEM.dock, ITEM.joyConPair, ITEM.joyConGrip, ITEM.acAdapter, ITEM.hdmiCable],
    missing: [],
    templateId: "itpl_console_v1",
    checklist: [
      pass("power"),
      pass("video_output"),
      pass("screen"),
      battery(91),
      pass("ports"),
      pass("disc_drive"),
      pass("buttons"),
      pass("sticks"),
      pass("heat"),
      pass("wifi"),
      pass("storage"),
      pass("account_lock"),
      noted("accessories", "القاعدة، يدا Joy-Con، مقبض Joy-Con، محوّل الطاقة، كيبل HDMI"),
    ],
    warrantyDays: 30,
    inspectedDaysAgo: 5,
    listedDaysAgo: 4,
  },
  {
    slug: "used-xbox-series-s-512-01",
    sku: "XSS-512-WHT",
    serial: "DEMO-USED-XSS-0001",
    grade: "B",
    cosmeticNotes: t3(
      "خدوش واضحة على السطح العلوي وأثر احتكاك على إحدى الزوايا. لا تؤثر في الأداء.",
      "Clear scratches on the top surface and a scuff on one corner. They do not affect performance.",
      "ڕووشانی دیار لەسەر ڕووی سەرەوە و شوێنەواری لێخشان لەسەر یەکێک لە گۆشەکان. کار ناکەنە سەر توانای ئامێرەکە.",
    ),
    defects: [
      { area: "top", severity: "moderate", note: t3("خدوش واضحة على السطح العلوي", "Clear scratches on the top surface", "ڕووشانی دیار لەسەر ڕووی سەرەوە") },
      { area: "corner", severity: "minor", note: t3("أثر احتكاك على إحدى الزوايا", "A scuff on one corner", "شوێنەواری لێخشان لەسەر یەکێک لە گۆشەکان") },
    ],
    included: [ITEM.xboxController, ITEM.powerCable, ITEM.hdmiCable],
    missing: [],
    templateId: "itpl_console_v1",
    checklist: [
      pass("power"),
      pass("video_output"),
      na("screen"),
      na("battery"),
      pass("ports"),
      na("disc_drive"),
      pass("buttons"),
      na("sticks"),
      pass("heat"),
      pass("wifi"),
      pass("storage"),
      pass("account_lock"),
      noted("accessories", "يد Xbox بيضاء، كيبل طاقة، كيبل HDMI"),
    ],
    warrantyDays: 14,
    inspectedDaysAgo: 7,
    listedDaysAgo: 6,
  },
  {
    slug: "used-steam-deck-oled-512-01",
    sku: "SD-OLED-512",
    serial: "DEMO-USED-SDO-0001",
    grade: "A",
    batteryHealthPct: 94,
    cosmeticNotes: t3(
      "آثار استخدام خفيفة على المقابض الخلفية. الشاشة والعصي بحالة ممتازة.",
      "Light signs of use on the rear grips. The screen and sticks are in excellent condition.",
      "شوێنەواری سووکی بەکارهێنان لەسەر گرتەکانی پشتەوە. شاشە و جۆیستیکەکان لە دۆخێکی نایابدان.",
    ),
    defects: [{ area: "grips", severity: "minor", note: t3("لمعان خفيف من الاستخدام على المقابض", "Slight shine from use on the grips", "بریقەیەکی سووک لە بەکارهێنان لەسەر گرتەکان") }],
    included: [ITEM.charger, ITEM.carryingCase],
    missing: [],
    templateId: "itpl_handheld_pc_v1",
    checklist: [
      pass("power"),
      pass("screen"),
      pass("touch"),
      battery(94),
      pass("ports"),
      pass("buttons"),
      pass("sticks"),
      pass("triggers"),
      pass("heat"),
      pass("wifi"),
      pass("storage"),
      pass("audio"),
      pass("account_lock"),
      noted("accessories", "الشاحن الأصلي 45 واط، حقيبة الحمل"),
    ],
    warrantyDays: 30,
    inspectedDaysAgo: 9,
    listedDaysAgo: 8,
  },
  {
    slug: "used-legion-go-512-01",
    sku: "LEGO1-Z1E-512",
    serial: "DEMO-USED-LGO-0001",
    grade: "B",
    batteryHealthPct: 86,
    cosmeticNotes: t3(
      "خدوش على المسند الخلفي وتآكل خفيف في غطاء العصا اليمنى، وخدش رفيع قرب حافة الشاشة لا يظهر أثناء اللعب. حقيبة الحمل الأصلية غير مرفقة.",
      "Scratches on the kickstand, slight wear on the right stick cap, and a hairline scratch near the screen edge that does not show during play. The original carry bag is not included.",
      "ڕووشان لەسەر پاڵپشتی پشتەوە، داخورانێکی سووک لە سەرپۆشی جۆیستیکی ڕاست، و ڕووشانێکی باریک لە نزیک لێواری شاشە کە لە کاتی یاریدا دەرناکەوێت. جانتای هەڵگرتنی ئەسڵی لەگەڵیدا نییە.",
    ),
    defects: [
      { area: "kickstand", severity: "moderate", note: t3("خدوش على المسند الخلفي", "Scratches on the kickstand", "ڕووشان لەسەر پاڵپشتی پشتەوە") },
      { area: "screen", severity: "minor", note: t3("خدش رفيع قرب حافة الشاشة", "A hairline scratch near the screen edge", "ڕووشانێکی باریک لە نزیک لێواری شاشە") },
      { area: "right_stick", severity: "minor", note: t3("تآكل خفيف في غطاء العصا اليمنى", "Slight wear on the right stick cap", "داخورانێکی سووک لە سەرپۆشی جۆیستیکی ڕاست") },
    ],
    included: [ITEM.detachableControllers, ITEM.charger],
    missing: ["missing_case"],
    templateId: "itpl_handheld_pc_v1",
    checklist: [
      pass("power"),
      pass("screen"),
      pass("touch"),
      battery(86),
      pass("ports"),
      pass("buttons"),
      pass("sticks"),
      pass("triggers"),
      pass("heat"),
      pass("wifi"),
      pass("storage"),
      pass("audio"),
      pass("account_lock"),
      noted("accessories", "يدا التحكم، الشاحن الأصلي 65 واط — بلا حقيبة"),
    ],
    warrantyDays: 14,
    inspectedDaysAgo: 11,
    listedDaysAgo: 10,
  },
  {
    slug: "used-switch-lite-turquoise-01",
    sku: "NSW-LITE-TRQ",
    serial: "DEMO-USED-NSWL-0001",
    grade: "C",
    batteryHealthPct: 78,
    cosmeticNotes: t3(
      "خدوش واضحة على الظهر والحواف، وخدش على الشاشة يُرى وهي مطفأة. كل الأزرار والعصي تعمل.",
      "Clear scratches on the back and edges, and a screen scratch visible when the display is off. All buttons and sticks work.",
      "ڕووشانی دیار لەسەر پشت و لێوارەکان، و ڕووشانێک لەسەر شاشە کە کاتێک کوژاوەتەوە دەبینرێت. هەموو دوگمە و جۆیستیکەکان کاردەکەن.",
    ),
    defects: [
      { area: "screen", severity: "moderate", note: t3("خدش يُرى والشاشة مطفأة", "A scratch visible when the screen is off", "ڕووشانێک کە کاتێک شاشە کوژاوەتەوە دەبینرێت") },
      { area: "shell", severity: "moderate", note: t3("خدوش واضحة على الظهر والحواف", "Clear scratches on the back and edges", "ڕووشانی دیار لەسەر پشت و لێوارەکان") },
    ],
    included: [ITEM.acAdapter],
    missing: [],
    templateId: "itpl_console_v1",
    checklist: [
      pass("power"),
      pass("video_output"),
      pass("screen"),
      battery(78),
      pass("ports"),
      pass("disc_drive"),
      pass("buttons"),
      pass("sticks"),
      pass("heat"),
      pass("wifi"),
      pass("storage"),
      pass("account_lock"),
      noted("accessories", "محوّل الطاقة فقط"),
    ],
    warrantyDays: 7,
    inspectedDaysAgo: 13,
    listedDaysAgo: 12,
  },
];

// ───────────────────────────────────────────────────────────────── money

/** A used unit sells at this share of its new variant's (demo) price. */
export const USED_PRICE_SHARE: Record<UsedGrade, number> = { "A+": 0.84, A: 0.76, B: 0.66, C: 0.52 };
/** Basis points of `baseIqd` paid per grade. */
export const TRADE_IN_GRADE_MULTIPLIERS: Record<UsedGrade, number> = { "A+": 10_000, A: 9_000, B: 7_500, C: 5_500 };
/** A trade-in guide's grade-A+ price: this share of the model's new price, rounded to 5,000 IQD. */
export const TRADE_IN_BASE_SHARE = 0.55;

const HOME_CONSOLE_DEDUCTIONS = { missing_controller: 40_000, missing_power_cable: 5_000, missing_hdmi_cable: 5_000 };
const SWITCH_DOCKED_DEDUCTIONS = { missing_dock: 40_000, missing_joy_con: 50_000, missing_charger: 15_000 };

/** The device models the store buys: consoles and handheld PCs (the inspection templates it has). */
export const buysDevice = (model: DeviceModelSeed): boolean => model.product !== null && (model.deviceKind === "console" || model.deviceKind === "handheld_pc");

/** What a missing item takes off a trade-in, per device: from what the researched box contains. */
export function tradeInDeductions(model: DeviceModelSeed, product: CatalogProduct | null): Record<string, number> {
  const box = (product?.inTheBox ?? []).map((item) => item.en).join(" | ");
  if (model.deviceKind === "handheld_pc") return /\b(case|bag)\b/i.test(box) ? { missing_charger: 20_000, missing_case: 15_000 } : { missing_charger: 20_000 };
  if (model.generation === "switch-2" || model.slug === "switch" || model.slug === "switch-oled") return SWITCH_DOCKED_DEDUCTIONS;
  if (model.slug === "switch-lite") return { missing_charger: 15_000 };
  if (model.slug === "ps-portal") return {};
  return HOME_CONSOLE_DEDUCTIONS;
}

const roundTo = (value: number, step: number) => Math.round(value / step) * step;

export const tradeInBaseIqd = (newPriceIqd: number): number => roundTo(newPriceIqd * TRADE_IN_BASE_SHARE, 5_000);

export const usedPriceIqd = (newPriceIqd: number, grade: UsedGrade): number => roundTo(newPriceIqd * USED_PRICE_SHARE[grade], PRICE_STEP_IQD);

/** What the store paid for a unit: the guide's price for its grade, less what it came without. */
export function acquisitionCostIqd(baseIqd: number, grade: UsedGrade, deductions: Record<string, number>, missing: readonly string[]): number {
  const byGrade = (baseIqd * TRADE_IN_GRADE_MULTIPLIERS[grade]) / 10_000;
  const less = missing.reduce((sum, key) => sum + (deductions[key] ?? 0), 0);
  return roundTo(byGrade - less, PRICE_STEP_IQD);
}
