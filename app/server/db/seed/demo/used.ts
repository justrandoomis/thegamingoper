/**
 * DEMO used devices and trade-in reference prices.
 *
 * Six listed units across the four grades. They are flagged is_demo, which is the only reason
 * the database lets them be listed without real photographs: their pictures are clay renders of the
 * MODEL, flagged as illustrations, and the storefront must say so. Checklists follow the inspection
 * templates of the reference seed (itpl_console_v1 / itpl_handheld_pc_v1). Serial numbers are
 * obviously fake ("DEMO-USED-…") and, like all serials, never shown on public pages.
 *
 * No trade-in requests are seeded: a request belongs to a person (it needs a phone number), and
 * the seed creates no people. The units therefore have no `trade_in_id`.
 *
 * Trade-in guides: `base_iqd` is what the store would pay for a grade-A+ unit (placeholder),
 * multiplied per grade and reduced per missing item. The demo acquisition costs above follow the
 * same guide, so margin reports on used units add up.
 */
import type { ChecklistResult, IncludedItem, UsedDefect, UsedGrade } from "../../schema";
import { t3, type T3 } from "./text";

type ChecklistItem = { key: string; result: ChecklistResult | null; value?: string | number };

export type UsedUnitSeed = {
  slug: string;
  /** SKU of the catalogue variant this unit is an instance of. */
  sku: string;
  serial: string;
  grade: UsedGrade;
  batteryHealthPct?: number;
  cosmeticNotes: T3;
  defects: UsedDefect[];
  included: IncludedItem[];
  templateId: "itpl_console_v1" | "itpl_handheld_pc_v1";
  checklist: ChecklistItem[];
  priceIqd: number;
  /** [P] What the store paid — follows the trade-in guide below. */
  acquisitionCostIqd: number;
  warrantyDays: number;
  art: string[];
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

/** Shown wherever a demo unit's picture appears. */
export const USED_ILLUSTRATION_ALT: T3 = t3(
  "رسم توضيحي للطراز — ليس صورة الجهاز المعروض",
  "Illustration of the model — not a photo of this unit",
  "وێنەیەکی ڕوونکەرەوەی مۆدێلەکە — وێنەی ئەم ئامێرە نییە",
);

export const DEMO_USED_UNITS: readonly UsedUnitSeed[] = [
  {
    slug: "used-ps5-slim-disc-01",
    sku: "PS5-SLIM-DISC",
    serial: "DEMO-USED-PS5S-0001",
    grade: "A+",
    cosmeticNotes: t3(
      "حالة شبه جديدة: لا خدوش ظاهرة على الألواح البيضاء ولا على الواجهة السوداء اللامعة.",
      "Near-new condition: no visible scratches on the white plates or the glossy black front.",
      "دۆخی نزیک لە نوێ: هیچ ڕووشانێکی دیار لەسەر پلێتە سپییەکان و ڕووی ڕەشی بریقەدار نییە.",
    ),
    defects: [],
    included: [ITEM.dualsense, ITEM.powerCable, ITEM.hdmiCable, ITEM.originalBox],
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
    priceIqd: 560_000,
    acquisitionCostIqd: 420_000,
    warrantyDays: 30,
    art: ["ps5-slim", "ps5-slim@front", "ps5-slim@back"],
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
    priceIqd: 320_000,
    acquisitionCostIqd: 216_000,
    warrantyDays: 30,
    art: ["switch-oled", "switch-oled@front"],
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
    priceIqd: 285_000,
    acquisitionCostIqd: 165_000,
    warrantyDays: 14,
    art: ["xbox-series-s", "xbox-series-s@front"],
    inspectedDaysAgo: 7,
    listedDaysAgo: 6,
  },
  {
    slug: "used-steam-deck-oled-512-01",
    sku: "SDO-512",
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
    priceIqd: 610_000,
    acquisitionCostIqd: 432_000,
    warrantyDays: 30,
    art: ["steam-deck-oled", "steam-deck-oled@front"],
    inspectedDaysAgo: 9,
    listedDaysAgo: 8,
  },
  {
    slug: "used-legion-go-512-01",
    sku: "LGO-512",
    serial: "DEMO-USED-LGO-0001",
    grade: "B",
    batteryHealthPct: 86,
    cosmeticNotes: t3(
      "خدوش على المسند الخلفي وتآكل خفيف في غطاء العصا اليمنى، وخدش رفيع قرب حافة الشاشة لا يظهر أثناء اللعب. حقيبة الحمل الأصلية غير مرفقة.",
      "Scratches on the kickstand, slight wear on the right stick cap, and a hairline scratch near the screen edge that does not show during play. The original carrying case is not included.",
      "ڕووشان لەسەر پاڵپشتی پشتەوە، داخورانێکی سووک لە سەرپۆشی جۆیستیکی ڕاست، و ڕووشانێکی باریک لە نزیک لێواری شاشە کە لە کاتی یاریدا دەرناکەوێت. جانتای هەڵگرتنی ئەسڵی لەگەڵیدا نییە.",
    ),
    defects: [
      { area: "kickstand", severity: "moderate", note: t3("خدوش على المسند الخلفي", "Scratches on the kickstand", "ڕووشان لەسەر پاڵپشتی پشتەوە") },
      { area: "screen", severity: "minor", note: t3("خدش رفيع قرب حافة الشاشة", "A hairline scratch near the screen edge", "ڕووشانێکی باریک لە نزیک لێواری شاشە") },
      { area: "right_stick", severity: "minor", note: t3("تآكل خفيف في غطاء العصا اليمنى", "Slight wear on the right stick cap", "داخورانێکی سووک لە سەرپۆشی جۆیستیکی ڕاست") },
    ],
    included: [ITEM.detachableControllers, ITEM.charger],
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
    priceIqd: 620_000,
    acquisitionCostIqd: 375_000,
    warrantyDays: 14,
    art: ["legion-go", "legion-go@front"],
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
    priceIqd: 135_000,
    acquisitionCostIqd: 66_000,
    warrantyDays: 7,
    art: ["switch-lite"],
    inspectedDaysAgo: 13,
    listedDaysAgo: 12,
  },
];

// ───────────────────────────────────────────────────────────────── trade-in price guides

/** Basis points of `baseIqd` paid per grade. */
export const TRADE_IN_GRADE_MULTIPLIERS: Record<UsedGrade, number> = { "A+": 10_000, A: 9_000, B: 7_500, C: 5_500 };

const HOME_CONSOLE_DEDUCTIONS = { missing_controller: 40_000, missing_power_cable: 5_000, missing_hdmi_cable: 5_000 };
const SWITCH_DOCKED_DEDUCTIONS = { missing_dock: 40_000, missing_joy_con: 50_000, missing_charger: 15_000 };
const HANDHELD_DEDUCTIONS = { missing_charger: 20_000, missing_case: 15_000 };

export type TradeInGuideSeed = { deviceModel: string; baseIqd: number; deductions: Record<string, number> };

export const DEMO_TRADE_IN_GUIDES: readonly TradeInGuideSeed[] = [
  { deviceModel: "switch-2", baseIqd: 430_000, deductions: SWITCH_DOCKED_DEDUCTIONS },
  { deviceModel: "switch-oled", baseIqd: 240_000, deductions: SWITCH_DOCKED_DEDUCTIONS },
  { deviceModel: "switch-lite", baseIqd: 120_000, deductions: { missing_charger: 15_000 } },
  { deviceModel: "ps5-slim", baseIqd: 420_000, deductions: HOME_CONSOLE_DEDUCTIONS },
  { deviceModel: "ps5-pro", baseIqd: 700_000, deductions: HOME_CONSOLE_DEDUCTIONS },
  { deviceModel: "ps-portal", baseIqd: 170_000, deductions: {} },
  { deviceModel: "xbox-series-x", baseIqd: 430_000, deductions: HOME_CONSOLE_DEDUCTIONS },
  { deviceModel: "xbox-series-s", baseIqd: 220_000, deductions: HOME_CONSOLE_DEDUCTIONS },
  { deviceModel: "steam-deck-oled", baseIqd: 480_000, deductions: HANDHELD_DEDUCTIONS },
  { deviceModel: "rog-ally-x", baseIqd: 720_000, deductions: { missing_charger: 20_000 } },
  { deviceModel: "legion-go", baseIqd: 520_000, deductions: HANDHELD_DEDUCTIONS },
];
