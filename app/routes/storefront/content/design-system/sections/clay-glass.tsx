// lint-design: allow primary-count — the reference page shows the primary key in both themes side by side; it is not a shopping view.
import { useState, type CSSProperties, type ReactNode } from "react";

import { GLYPH_GROUPS, Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat } from "~/i18n/react";
import type { ImageRef, ProductCardData } from "~/lib/dto";
import { CountUp } from "~/motion";
import { Accordion } from "~/ui/Accordion";
import { Carousel } from "~/ui/Carousel";
import { CategoryTile, CategoryTiles } from "~/ui/CategoryTile";
import { Chip } from "~/ui/Chip";
import { EntryCard } from "~/ui/EntryCard";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { PLATFORMS, PlatformLabel, type Platform } from "~/ui/PlatformLed";
import { PlatformTile, PlatformTiles } from "~/ui/PlatformTile";
import { Price } from "~/ui/Price";
import { ProductCard } from "~/ui/ProductCard";
import { Reveal } from "~/ui/reveal";
import { Segmented } from "~/ui/Segmented";
import { Stepper } from "~/ui/Stepper";
import { SuccessMark } from "~/ui/SuccessMark";
import { Tabs } from "~/ui/Tabs";
import { TextLink } from "~/ui/TextLink";
import { DsBlock, defineCopy, useCopy, type DsSectionMeta } from "../kit";

/**
 * Design v2.1 "Clay & Glass" (the client's first feedback round, docs/DESIGN.md §15): every new or restyled piece, the
 * light and the dark theme side by side. The other sections show the same components in context; this one is how the
 * look is judged at a glance.
 */
export const section: DsSectionMeta = {
  id: "clay-glass",
  order: 1,
  title: { ar: "الطين والزجاج 2.1", en: "Clay & Glass 2.1", ckb: "قوڕ و شووشە 2.1" },
  owner: "app/styles (tokens, materials, components, pieces) · app/ui · app/art · app/motion · docs/DESIGN.md §15",
};

const COPY = defineCopy({
  ar: {
    intro: "ردّ على ملاحظات العميل: خط المتجر القديم (Kufam للعناوين والأسعار والأزرار، وIBM Plex للنص)، وأزرار طينية بارزة، وبطاقات ناعمة، وزجاج حقيقي في الوضع الداكن، وألوان المنصات حيّة في الوضعين، وحركة هادئة. كل عيّنة هنا في الفاتح والداكن معاً.",
    light: "فاتح",
    dark: "داكن",
    type: "الخط",
    typeNote: "Kufam 600 للعناوين وأسماء الأزرار (لا يقل عن 15 بكسل)، وKufam 700 للأسعار والأرقام، وIBM Plex Sans Arabic 400/500/600 للنص. نص القراءة 16 بكسل بتباعد 1.75.",
    display: "العب على",
    h2: "تسوّق حسب المنصّة",
    h3: "أبرز ما فيه",
    read: "التوصيل 5,000 د.ع لكل المحافظات، والدفع عند الاستلام أو بزين كاش أو بتحويل إلى بطاقة ماستركارد.",
    keys: "الأزرار",
    keysNote: "الأساسي أحمر لامع (واحد في كل شاشة) يرتفع بكسلاً عند المرور ويغوص على جداره عند الضغط؛ الثانوي طين أبيض؛ الشبحي مسطّح. أسماء الأزرار بخط Kufam.",
    add: "أضف إلى السلة",
    details: "تفاصيل الجهاز",
    cancel: "إلغاء",
    remove: "احذف العنوان",
    small: "زر صغير",
    busy: "جارٍ",
    off: "غير متاح",
    buy: "اشترِ Nintendo Switch 2",
    iconKeys: "أزرار الأيقونات والرقائق والعدّاد",
    iconKeysNote: "دوائر طينية 44 بكسل بأيقونات أعرض؛ الرقاقة المختارة حبر مضغوط مع علامة صح؛ العدّاد صينية مضغوطة و«+» بارز.",
    fav: "أضف إلى المفضلة",
    share: "شارك",
    zoom: "كبّر الصورة",
    back: "رجوع",
    all: "الكل",
    games: "الألعاب",
    consoles: "أجهزة الألعاب",
    seg: "المظهر",
    segLight: "فاتح",
    segDark: "داكن",
    segSystem: "النظام",
    tabsLabel: "تفاصيل الجهاز",
    tabSpecs: "المواصفات",
    tabBox: "في العلبة",
    tabWorks: "يعمل مع",
    specsText: "شاشة 7.9 بوصة بدقة 1080p · حتى 4K على التلفاز.",
    boxText: "الجهاز، ذراعا Joy-Con 2، القاعدة، كابل HDMI.",
    worksText: "ألعاب Nintendo Switch 2 ومعظم ألعاب Nintendo Switch.",
    surfaces: "الأسطح والزجاج والضوء",
    surfacesNote: "البطاقة ورقة ناعمة بارزة (في الداكن زجاج مزيّف بحافة مضيئة)؛ الزجاج الحقيقي مصقول ومضاء الحافة؛ ضوء ملوّن خافت خلف الواجهات ليُظهر الزجاج.",
    card: "بطاقة",
    cardText: "ورقة بضوء علوي وظل دافئ.",
    glass: "زجاج",
    glassText: "شفاف ومصقول بحافة مضيئة.",
    tiles: "مربعات المنصات",
    tilesNote: "ألوان المنصات حيّة ولامعة في الوضعين، لا رمادي أبداً؛ الكلام الأبيض على اللون الصريح أو الأغمق.",
    cards: "البطاقات",
    cardsNote: "بطاقة المنتج ورقة ناعمة بارزة بخط لون المنصة، وأيقونات أعرض في دوائر طينية؛ ترتفع 3 بكسل وتكبر الصورة 1.03 تحت المؤشر.",
    nameSwitch: "Nintendo Switch 2",
    subSwitch: "256GB · شاشة 7.9 بوصة",
    kindSwitch: "جهاز Switch 2",
    subPro: "2TB · رسوميات أقوى",
    kindPs5: "جهاز PS5",
    entries: "البطاقات المدخل وبلاطات الأصناف",
    entriesNote: "الشكل القديم لصفوف الدعم: دائرة طينية بالأيقونة، والعنوان وسطره، وسهم في النهاية. وبلاطة الصنف صورة على بئر دافئ أو أيقونة حمراء على مربع طيني.",
    diagnose: "شخّص المشكلة خطوة بخطوة",
    diagnoseLine: "أسئلة قصيرة وخطوات آمنة من أدلتنا المعتمدة.",
    repair: "احجز صيانة",
    repairLine: "صِف المشكلة وأرفق صوراً.",
    used: "المستعمل والمفحوص",
    usedLine: "أجهزة مفحوصة بتقرير وصور الجهاز نفسه.",
    usedCta: "تصفّح المستعمل",
    controllers: "أذرع التحكم",
    headsets: "السماعات",
    storage: "التخزين",
    charging: "الشحن",
    cardsTopup: "بطاقات الشحن",
    notes: "الملاحظات",
    notesNote: "نمط واحد للمعلومة الجانبية: بطاقة محايدة ودائرة أيقونة وعنوان قصير وسطر هادئ وإجراء في سطر وحده بسهم. اللون في الدائرة فقط حين يهم.",
    guestTitle: "أكمل الطلب بدون حساب",
    guestText: "الحساب اختياري: يحفظ عناوينك ويسهّل تتبّع طلباتك.",
    signIn: "سجّل الدخول",
    payTitle: "طرق الدفع",
    payText: "الدفع عند الاستلام، أو زين كاش، أو تحويل إلى بطاقة ماستركارد. التحويل يبقى بانتظار التحقق حتى يراجعه موظف.",
    okTitle: "استلمنا صورة الحوالة",
    okText: "نراجعها ثم نؤكد طلبك.",
    warnTitle: "قبل أن تطلب",
    warnText: "تأكد أن اللعبة تعمل على جهازك.",
    demoText: "طلب تجريبي: لن يُشحن الطلب ولن يُحصَّل أي مبلغ.",
    lineText: "الحوالة تبقى بانتظار التحقق حتى يراجعها موظف.",
    icons: "الأيقونات",
    iconsNote: "خطوط بعرض 2 بكسل بأطراف مستديرة. صور الأجهزة الأربعة (لا شعارات رسمية) وأيقونات الأصناف متاحة بالاسم.",
    motion: "الحركة",
    motionNote: "الأقسام تظهر صاعدة عند وصولها مرة واحدة، والأرقام المهمة تعدّ مرة واحدة، وعلامة النجاح ترسم نفسها، والعرض المتتابع يتوقف عند المرور أو اللمس وله زر إيقاف. كل ذلك فوري عند تقليل الحركة.",
    points: "نقاطك",
    carousel: "عروض المتجر",
    slide1: "العب على Nintendo Switch 2",
    slide2: "PlayStation 5 Pro",
    slide3: "الأجهزة المحمولة",
    acc: "الأكورديون",
    q1: "ما الذي يشمله الضمان؟",
    a1: "ضمان الشركة المصنّعة حين يكون معروفاً. اسألنا عن شروط الضمان قبل الطلب.",
    q2: "متى يصل طلبي؟",
    a2: "نتواصل معك بخصوص الطلب برقم موبايلك. وقت التوصيل المفضّل ليس موعداً مؤكداً.",
    staggerA: "يصل أولاً",
    staggerB: "ثم هذا",
    staggerC: "ثم هذا",
    staggerD: "وأخيراً هذا",
  },
  en: {
    intro: "The answer to the client's notes: the store's original type (Kufam for headings, prices and keys; IBM Plex for text), raised clay keys, soft cards, real glass in dark mode, vivid platform colours in both themes and calm motion. Every specimen here is shown light and dark side by side.",
    light: "Light",
    dark: "Dark",
    type: "Type",
    typeNote: "Kufam 600 for headings and key labels (never under 15px), Kufam 700 for prices and numerals, IBM Plex Sans Arabic 400/500/600 for text. Reading text is 16px with a 1.6 line height in English (1.75 in Arabic).",
    display: "Play on",
    h2: "Shop by platform",
    h3: "Highlights",
    read: "Delivery is 5,000 IQD to every governorate; pay cash on delivery, with Zain Cash or by transfer to a Mastercard card.",
    keys: "Keys",
    keysNote: "The primary is glossy red (one per view): it rises a pixel under the pointer and sinks onto its wall when pressed; the secondary is white clay; ghost keys are flat. Key labels are set in Kufam.",
    add: "Add to cart",
    details: "Device details",
    cancel: "Cancel",
    remove: "Delete address",
    small: "Small key",
    busy: "Busy",
    off: "Unavailable",
    buy: "Buy Nintendo Switch 2",
    iconKeys: "Icon keys, chips and the stepper",
    iconKeysNote: "44px clay circles with bolder icons; the chosen chip is ink, held down, with a check; the stepper is a pressed-in tray with a raised «+».",
    fav: "Add to favourites",
    share: "Share",
    zoom: "Zoom the picture",
    back: "Back",
    all: "All",
    games: "Games",
    consoles: "Consoles",
    seg: "Theme",
    segLight: "Light",
    segDark: "Dark",
    segSystem: "System",
    tabsLabel: "Device details",
    tabSpecs: "Specs",
    tabBox: "In the box",
    tabWorks: "Works with",
    specsText: "7.9-inch 1080p screen · up to 4K on a TV.",
    boxText: "The console, two Joy-Con 2 controllers, the dock, an HDMI cable.",
    worksText: "Nintendo Switch 2 games and most Nintendo Switch games.",
    surfaces: "Surfaces, glass and light",
    surfacesNote: "A card is soft raised paper (dark: faux glass with a rim light); real glass is frosted and rim-lit; a low coloured light behind showcases gives the glass something to show.",
    card: "Card",
    cardText: "Paper with a top light and a warm shadow.",
    glass: "Glass",
    glassText: "Translucent, frosted, rim-lit.",
    tiles: "Platform tiles",
    tilesNote: "Platform colours are vivid and glossy in both themes, never grey; white words sit on the flat colour or deeper.",
    cards: "Cards",
    cardsNote: "The product card is soft raised paper with the platform's colour line and bolder icons in clay circles; it lifts 3px and its photo grows 1.03 under the pointer.",
    nameSwitch: "Nintendo Switch 2",
    subSwitch: "256GB · 7.9-inch screen",
    kindSwitch: "Switch 2 console",
    subPro: "2TB · stronger graphics",
    kindPs5: "PS5 console",
    entries: "Entry cards and category tiles",
    entriesNote: "The original support rows: a clay disc with the icon, the title and its line, an arrow at the end. A category tile is a photo on the warm well, or a red line icon on a clay square.",
    diagnose: "Diagnose the problem step by step",
    diagnoseLine: "Short questions and safe steps from our approved guides.",
    repair: "Book a repair",
    repairLine: "Describe the problem and add photos.",
    used: "Used & inspected",
    usedLine: "Inspected devices with a report and photos of the unit itself.",
    usedCta: "Browse used",
    controllers: "Controllers",
    headsets: "Headsets",
    storage: "Storage",
    charging: "Charging",
    cardsTopup: "Top-up cards",
    notes: "Notes",
    notesNote: "One pattern for side information: a neutral card, an icon circle, a short title, a quiet line and an action on its own line with an arrow. Colour only in the circle, only when it matters.",
    guestTitle: "Check out without an account",
    guestText: "An account is optional: it saves your addresses and makes tracking easier.",
    signIn: "Sign in",
    payTitle: "Payment",
    payText: "Cash on delivery, Zain Cash, or a transfer to a Mastercard card. A transfer waits until a person has checked it.",
    okTitle: "We received your transfer photo",
    okText: "We review it, then confirm your order.",
    warnTitle: "Before you order",
    warnText: "Make sure the game works on your console.",
    demoText: "Demo order: nothing is shipped and nothing is charged.",
    lineText: "A transfer waits until a person has checked it.",
    icons: "Icons",
    iconsNote: "2px strokes with round ends. The four device silhouettes (no official logos) and the catalogue kinds are available by name.",
    motion: "Motion",
    motionNote: "Sections fade up once as they arrive, numbers that matter count up once, the success mark draws itself, the carousel pauses under the pointer or a touch and has a pause key. All of it is instant with reduced motion.",
    points: "Your points",
    carousel: "Store offers",
    slide1: "Play on Nintendo Switch 2",
    slide2: "PlayStation 5 Pro",
    slide3: "Handheld PCs",
    acc: "Accordion",
    q1: "What does the warranty cover?",
    a1: "The manufacturer's warranty when it is known. Ask us about the terms before you order.",
    q2: "When will my order arrive?",
    a2: "We contact you about the order on your mobile number. A preferred delivery time is not a confirmed time.",
    staggerA: "Arrives first",
    staggerB: "then this",
    staggerC: "then this",
    staggerD: "and this last",
  },
  ckb: {
    intro: "وەڵامی تێبینییەکانی کڕیار: فۆنتی سەرەتای فرۆشگا (Kufam بۆ سەردێڕ و نرخ و دوگمە، IBM Plex بۆ دەق)، دوگمەی قوڕی بەرز، کارتی نەرم، شووشەی ڕاستەقینە لە دۆخی تاریک، ڕەنگی زیندووی پلاتفۆرمەکان لە هەردوو دۆخدا و جووڵەی هێمن. هەر نموونەیەک لێرە ڕوون و تاریک پێکەوە پیشان دەدرێت.",
    light: "ڕوون",
    dark: "تاریک",
    type: "فۆنت",
    typeNote: "Kufam 600 بۆ سەردێڕ و ناوی دوگمەکان (هەرگیز کەمتر لە 15 پیکسڵ)، Kufam 700 بۆ نرخ و ژمارە، IBM Plex Sans Arabic 400/500/600 بۆ دەق. دەقی خوێندنەوە 16 پیکسڵە بە بۆشایی 1.75.",
    display: "یاری بکە لەسەر",
    h2: "بەپێی پلاتفۆرم بازاڕ بکە",
    h3: "گرنگترینەکان",
    read: "گەیاندن 5,000 د.ع بۆ هەموو پارێزگاکان؛ پارەدان لە کاتی وەرگرتن، یان بە زەین کاش، یان بە گواستنەوە بۆ کارتی ماستەرکارد.",
    keys: "دوگمەکان",
    keysNote: "دوگمەی سەرەکی سووری بریقەدارە (یەک دانە لە هەر شاشەیەک): لە کاتی هاتنی نیشاندەر پیکسڵێک بەرز دەبێتەوە و لە کاتی پەستاندن دادەنیشێت؛ دوگمەی لاوەکی قوڕی سپییە؛ دوگمەی شەبەح تەختە. ناوی دوگمەکان بە Kufam نووسراون.",
    add: "بیخە ناو سەبەتە",
    details: "وردەکاری ئامێر",
    cancel: "هەڵوەشاندنەوە",
    remove: "ناونیشان بسڕەوە",
    small: "دوگمەی بچووک",
    busy: "خەریکە",
    off: "بەردەست نییە",
    buy: "Nintendo Switch 2 بکڕە",
    iconKeys: "دوگمەی ئایکۆن، چیپ و ژمێرەر",
    iconKeysNote: "بازنەی قوڕی 44 پیکسڵ بە ئایکۆنی پانتر؛ چیپی هەڵبژێردراو مەرەکەبیی پەستێنراوە لەگەڵ نیشانەی ڕاست؛ ژمێرەر سینییەکی پەستێنراوە و «+»ی بەرز.",
    fav: "بیخە ناو دڵخوازەکان",
    share: "هاوبەشی بکە",
    zoom: "وێنەکە گەورە بکە",
    back: "گەڕانەوە",
    all: "هەموو",
    games: "یارییەکان",
    consoles: "ئامێرەکانی یاری",
    seg: "ڕووکار",
    segLight: "ڕوون",
    segDark: "تاریک",
    segSystem: "سیستەم",
    tabsLabel: "وردەکاری ئامێر",
    tabSpecs: "تایبەتمەندییەکان",
    tabBox: "لەناو قوتووەکەدا",
    tabWorks: "کار دەکات لەگەڵ",
    specsText: "شاشەی 7.9 ئینج بە 1080p · تا 4K لەسەر تەلەفزیۆن.",
    boxText: "ئامێرەکە، دوو Joy-Con 2، بنکەکە، کێبڵی HDMI.",
    worksText: "یارییەکانی Nintendo Switch 2 و زۆربەی یارییەکانی Nintendo Switch.",
    surfaces: "ڕووەکان، شووشە و ڕووناکی",
    surfacesNote: "کارت کاغەزێکی نەرمی بەرزە (لە تاریکدا شووشەی ساختە بە لێوارێکی ڕووناک)؛ شووشەی ڕاستەقینە تەماوی و لێوار ڕووناکە؛ ڕووناکییەکی ڕەنگاوڕەنگی کز لە پشت پیشانگاکان.",
    card: "کارت",
    cardText: "کاغەز بە ڕووناکییەکی سەرەوە و سێبەرێکی گەرم.",
    glass: "شووشە",
    glassText: "ڕوون، تەماوی، لێوار ڕووناک.",
    tiles: "خانەکانی پلاتفۆرم",
    tilesNote: "ڕەنگی پلاتفۆرمەکان زیندوو و بریقەدارن لە هەردوو دۆخدا، هەرگیز خۆڵەمێشی نین؛ وشەی سپی لەسەر ڕەنگی ڕاستەوخۆ یان تۆختر.",
    cards: "کارتەکان",
    cardsNote: "کارتی بەرهەم کاغەزێکی نەرمی بەرزە بە هێڵی ڕەنگی پلاتفۆرم و ئایکۆنی پانتر لە بازنەی قوڕیدا؛ لە ژێر نیشاندەردا 3 پیکسڵ بەرز دەبێتەوە و وێنەکەی 1.03 گەورە دەبێت.",
    nameSwitch: "Nintendo Switch 2",
    subSwitch: "256GB · شاشەی 7.9 ئینج",
    kindSwitch: "ئامێری Switch 2",
    subPro: "2TB · گرافیکی بەهێزتر",
    kindPs5: "ئامێری PS5",
    entries: "کارتی چوونەژوورەوە و خانەی پۆلەکان",
    entriesNote: "شێوەی سەرەتای ڕیزەکانی پشتگیری: بازنەیەکی قوڕی بە ئایکۆنەکە، سەردێڕ و دێڕەکەی، تیرێک لە کۆتاییدا. خانەی پۆل وێنەیەکە لەسەر بیرێکی گەرم، یان ئایکۆنێکی سوور لەسەر چوارگۆشەیەکی قوڕی.",
    diagnose: "کێشەکە هەنگاو بە هەنگاو دەستنیشان بکە",
    diagnoseLine: "پرسیاری کورت و هەنگاوی سەلامەت لە ڕێنماییە پەسەندکراوەکانمان.",
    repair: "چاککردنەوە حیجز بکە",
    repairLine: "کێشەکە باس بکە و وێنە زیاد بکە.",
    used: "بەکارهاتوو و پشکنراو",
    usedLine: "ئامێری پشکنراو بە ڕاپۆرت و وێنەی خودی ئامێرەکە.",
    usedCta: "بەکارهاتووەکان ببینە",
    controllers: "دەستەکان",
    headsets: "هێدسێتەکان",
    storage: "هەڵگرتن",
    charging: "بارگاویکردن",
    cardsTopup: "کارتی بارکردن",
    notes: "تێبینییەکان",
    notesNote: "یەک شێواز بۆ زانیاری لاوەکی: کارتێکی بێلایەن، بازنەی ئایکۆن، سەردێڕێکی کورت، دێڕێکی هێمن و کردارێک لە دێڕی خۆیدا بە تیرێک. ڕەنگ تەنها لە بازنەکەدا، تەنها کاتێک گرنگە.",
    guestTitle: "بەبێ هەژمار داواکارییەکەت تەواو بکە",
    guestText: "هەژمار ئارەزوومەندانەیە: ناونیشانەکانت هەڵدەگرێت و بەدواداچوون ئاسانتر دەکات.",
    signIn: "چوونەژوورەوە",
    payTitle: "پارەدان",
    payText: "پارەدان لە کاتی وەرگرتن، زەین کاش، یان گواستنەوە بۆ کارتی ماستەرکارد. گواستنەوە چاوەڕێ دەکات تا کارمەندێک دەیپشکنێت.",
    okTitle: "وێنەی حەواڵەکەمان پێگەیشت",
    okText: "پێداچوونەوەی بۆ دەکەین، پاشان داواکارییەکەت پشتڕاست دەکەینەوە.",
    warnTitle: "پێش داواکردن",
    warnText: "دڵنیابە یارییەکە لەسەر ئامێرەکەت کار دەکات.",
    demoText: "داواکاری تاقیکاری: هیچ شتێک نانێردرێت و هیچ پارەیەک وەرناگیرێت.",
    lineText: "گواستنەوە چاوەڕێ دەکات تا کارمەندێک دەیپشکنێت.",
    icons: "ئایکۆنەکان",
    iconsNote: "هێڵی 2 پیکسڵ بە کۆتایی خڕ. وێنەی چوار ئامێرەکە (بێ لۆگۆی فەرمی) و ئایکۆنی پۆلەکان بە ناو بەردەستن.",
    motion: "جووڵە",
    motionNote: "بەشەکان یەک جار لە کاتی گەیشتن بەرز دەبنەوە، ژمارە گرنگەکان یەک جار دەژمێرن، نیشانەی سەرکەوتن خۆی دەکێشێت، پیشاندانی سلاید لە ژێر نیشاندەر یان دەستلێدان ڕادەوەستێت و دوگمەی ڕاگرتنی هەیە. هەمووی خێرایە کاتێک جووڵە کەم کراوەتەوە.",
    points: "خاڵەکانت",
    carousel: "پێشکەشکراوەکانی فرۆشگا",
    slide1: "یاری بکە لەسەر Nintendo Switch 2",
    slide2: "PlayStation 5 Pro",
    slide3: "ئامێرە دەستییەکان",
    acc: "ئەکۆردیۆن",
    q1: "گەرەنتی چی دەگرێتەوە؟",
    a1: "گەرەنتی کۆمپانیای بەرهەمهێنەر کاتێک زانراوە. پێش داواکردن پرسیارمان لێ بکە دەربارەی مەرجەکان.",
    q2: "داواکارییەکەم کەی دەگات؟",
    a2: "دەربارەی داواکارییەکە بە ژمارە مۆبایلەکەت پەیوەندیت پێوە دەکەین. کاتی دڵخوازی گەیاندن کاتێکی دڵنیاکراوە نییە.",
    staggerA: "یەکەم دەگات",
    staggerB: "پاشان ئەمە",
    staggerC: "پاشان ئەمە",
    staggerD: "و ئەمە لە کۆتاییدا",
  },
});
type C = (typeof COPY)["ar"];

const TILE_ART: Record<Platform, string> = {
  nintendo: "nintendo-switch-2--1",
  playstation: "playstation-5-slim--1",
  xbox: "xbox-series-x--1",
  handheld: "lenovo-legion-go-2--1",
};
const TILE_COUNT: Record<Platform, number> = { nintendo: 39, playstation: 42, xbox: 28, handheld: 15 };
const photo = (artKey: string): ImageRef => ({ artKey, mediaKey: null, alt: "", isIllustration: false });

function sampleCards(c: C): ProductCardData[] {
  const base = {
    kind: "console" as const,
    hasVariants: false,
    compareAtIqd: null,
    compareAtDemo: false,
    stock: "in_stock" as const,
    badge: null,
    isNew: false,
    rating: null,
    isDemo: true,
    releaseAt: null,
  };
  return [
    { ...base, id: "prd_nintendo-switch-2", slug: "nintendo-switch-2", name: c.nameSwitch, subtitle: c.subSwitch, kindLabel: c.kindSwitch, platformSlug: "nintendo", platformName: "Nintendo", variantId: "var_nsw2-con-256", priceIqd: 667_750, badge: "new", isNew: true, image: photo("nintendo-switch-2--1") },
    { ...base, id: "prd_playstation-5-pro", slug: "playstation-5-pro", name: "PlayStation 5 Pro", subtitle: c.subPro, kindLabel: c.kindPs5, platformSlug: "playstation", platformName: "PlayStation", variantId: "var_ps5-pro-2tb", priceIqd: 1_026_750, image: photo("playstation-5-pro--1") },
  ];
}

/** The same specimen twice: a light island and a dark island side by side (stacked on phones). */
function Themes({ c, children, className }: { c: C; children: (theme: "light" | "dark") => ReactNode; className?: string }) {
  return (
    <div className="cg-themes">
      {(["light", "dark"] as const).map((theme) => (
        <div key={theme} data-theme={theme} className={className ? `cg-island ${className}` : "cg-island"}>
          <p className="cg-island__label">{theme === "light" ? c.light : c.dark}</p>
          {children(theme)}
        </div>
      ))}
    </div>
  );
}

export default function ClayGlassSection() {
  const c = useCopy(COPY);
  const f = useFormat();
  const [chip, setChip] = useState("all");
  const [theme, setTheme] = useState("light");
  const cards = sampleCards(c);
  const kinds: Array<[IconName, string]> = [
    ["kind-controller", c.controllers],
    ["kind-headset", c.headsets],
    ["kind-storage", c.storage],
    ["kind-charging", c.charging],
    ["kind-topup", c.cardsTopup],
    ["kind-used", c.used],
  ];

  return (
    <div className="grid gap-2">
      <p className="ds-note max-w-[72ch] type-read text-ink-2">{c.intro}</p>

      <DsBlock title={c.type} note={c.typeNote}>
        <Themes c={c}>
          {() => (
            <div className="grid gap-3">
              <p className="type-display">
                {c.display}
                <br />
                <bdi>Nintendo Switch 2</bdi>
              </p>
              <h4 className="type-h2">{c.h2}</h4>
              <p className="type-h3">{c.h3}</p>
              <Price amountIqd={667_750} size="xl" />
              <p className="type-read text-ink-2">{c.read}</p>
            </div>
          )}
        </Themes>
      </DsBlock>

      <DsBlock title={c.keys} note={c.keysNote}>
        <Themes c={c}>
          {() => (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <Key variant="primary" icon="bag-plus">
                  {c.add}
                </Key>
                <Key iconEnd="arrow-right">{c.details}</Key>
                <Key variant="ghost">{c.cancel}</Key>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <Key size="sm">{c.small}</Key>
                <Key variant="danger" size="sm" icon="trash">
                  {c.remove}
                </Key>
                <Key loading>{c.busy}</Key>
                <Key disabled>{c.off}</Key>
              </div>
              <div className="band band--hero grid justify-items-start gap-3 p-5">
                <span className="band__light" aria-hidden="true" />
                <Key variant="onBand">{c.buy}</Key>
              </div>
            </div>
          )}
        </Themes>
      </DsBlock>

      <DsBlock title={c.iconKeys} note={c.iconKeysNote}>
        <Themes c={c}>
          {() => (
            <div className="grid gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <IconKey icon="heart" label={c.fav} className="key--wish" />
                <IconKey icon="heart" label={c.fav} className="key--wish" held />
                <IconKey icon="share-network" label={c.share} />
                <IconKey icon="corners-out" label={c.zoom} />
                <IconKey icon="arrow-left" label={c.back} />
                <IconKey icon="heart" label={c.fav} variant="onImage" size="sm" className="key--wish" />
              </div>
              <div className="chips">
                <Chip selected={chip === "all"} count={42} onClick={() => setChip("all")}>
                  {c.all}
                </Chip>
                <Chip selected={chip === "games"} count={18} onClick={() => setChip("games")}>
                  {c.games}
                </Chip>
                <Chip selected={chip === "consoles"} count={4} platform="playstation" onClick={() => setChip("consoles")}>
                  {c.consoles}
                </Chip>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <Stepper defaultValue={1} max={9} />
                <Stepper size="sm" defaultValue={2} max={9} />
              </div>
              <Segmented
                inline
                aria-label={c.seg}
                value={theme}
                onChange={setTheme}
                options={[
                  { value: "light", label: c.segLight, icon: "sun" },
                  { value: "dark", label: c.segDark, icon: "moon" },
                  { value: "system", label: c.segSystem },
                ]}
              />
              <Tabs
                aria-label={c.tabsLabel}
                defaultValue="specs"
                items={[
                  { value: "specs", label: c.tabSpecs, content: <p className="type-read text-ink-2">{c.specsText}</p> },
                  { value: "box", label: c.tabBox, content: <p className="type-read text-ink-2">{c.boxText}</p> },
                  { value: "works", label: c.tabWorks, content: <p className="type-read text-ink-2">{c.worksText}</p> },
                ]}
              />
            </div>
          )}
        </Themes>
      </DsBlock>

      <DsBlock title={c.surfaces} note={c.surfacesNote}>
        <Themes c={c}>
          {() => (
            <div className="glow glow--wide grid grid-cols-1 gap-4 py-4 sm:grid-cols-2" style={{ "--glow-y": "60%" } as CSSProperties}>
              <div className="surface grid gap-1 p-5">
                <p className="type-h3">{c.card}</p>
                <p className="type-read text-ink-2">{c.cardText}</p>
              </div>
              <div className="surface--glass grid gap-1 rounded-lg p-5">
                <p className="type-h3">{c.glass}</p>
                <p className="type-read text-ink-2">{c.glassText}</p>
              </div>
              <div data-gel="playstation" className="glow glow--strong grid min-h-24 place-items-center rounded-lg">
                <PlatformLabel platform="playstation" bar />
              </div>
              <div className="glass glass--panel grid gap-1 rounded-lg p-3">
                <span className="menu__row">{c.tabSpecs}</span>
                <span className="menu__row">{c.tabBox}</span>
              </div>
            </div>
          )}
        </Themes>
      </DsBlock>

      <DsBlock title={c.tiles} note={c.tilesNote}>
        <Themes c={c}>
          {() => (
            <div className="grid gap-6">
              <PlatformTiles className="!grid-cols-2">
                {PLATFORMS.map((p) => (
                  <PlatformTile key={p} platform={p} to={`/platform/${p}`} count={TILE_COUNT[p]} art={TILE_ART[p]} />
                ))}
              </PlatformTiles>
              <div className="grid grid-cols-2 gap-3">
                {PLATFORMS.map((p) => (
                  <PlatformTile key={p} compact platform={p} to={`/platform/${p}`} count={TILE_COUNT[p]} art={TILE_ART[p]} />
                ))}
              </div>
            </div>
          )}
        </Themes>
      </DsBlock>

      <DsBlock title={c.cards} note={c.cardsNote}>
        <Themes c={c}>
          {(island) => (
            <div className="cards !grid-cols-2">
              {cards.map((card) => (
                <ProductCard key={card.id} card={card} slot={`cg-${island}`} wishlist demoNote={false} />
              ))}
            </div>
          )}
        </Themes>
      </DsBlock>

      <DsBlock title={c.entries} note={c.entriesNote}>
        <Themes c={c}>
          {() => (
            <div className="grid gap-4">
              <EntryCard to="/support" icon="lifebuoy" title={c.diagnose} text={c.diagnoseLine} />
              <EntryCard to="/support/repair" icon="wrench" title={c.repair} text={c.repairLine} />
              <EntryCard to="/used" title={c.used} text={c.usedLine} cta={c.usedCta} art="playstation-5-slim--1" />
              <CategoryTiles className="!grid-cols-3">
                {kinds.slice(0, 3).map(([icon, label]) => (
                  <CategoryTile key={icon} to="/search" label={label} icon={icon} />
                ))}
              </CategoryTiles>
            </div>
          )}
        </Themes>
      </DsBlock>

      <DsBlock title={c.notes} note={c.notesNote}>
        <Themes c={c}>
          {() => (
            <div className="grid gap-3">
              <Note
                icon="shopping-bag"
                title={c.guestTitle}
                action={
                  <TextLink as={LocaleLink} to="/account">
                    {c.signIn}
                  </TextLink>
                }
              >
                {c.guestText}
              </Note>
              <Note tone="info" icon="credit-card" title={c.payTitle}>
                {c.payText}
              </Note>
              <Note tone="success" title={c.okTitle}>
                {c.okText}
              </Note>
              <Note tone="warning" title={c.warnTitle}>
                {c.warnText}
              </Note>
              <Note tone="demo">{c.demoText}</Note>
              <Note variant="line" icon="clock">
                {c.lineText}
              </Note>
            </div>
          )}
        </Themes>
      </DsBlock>

      <DsBlock title={c.icons} note={c.iconsNote}>
        <Themes c={c}>
          {() => (
            <div className="grid gap-4">
              <div className="flex flex-wrap gap-3">
                {GLYPH_GROUPS.devices.map((name) => (
                  <span key={name} className="clay-disc" title={name}>
                    <Icon name={name} size={24} />
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-3 text-red-ink">
                {GLYPH_GROUPS.kinds.map((name) => (
                  <span key={name} className="grid size-11 place-items-center" title={name}>
                    <Icon name={name} size={24} />
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-3">
                {(["house", "squares-four", "shopping-bag", "heart", "user", "magnifying-glass", "truck", "wrench", "lifebuoy", "credit-card"] as const).map((name) => (
                  <span key={name} className="grid size-11 place-items-center" title={name}>
                    <Icon name={name} size={24} />
                  </span>
                ))}
              </div>
            </div>
          )}
        </Themes>
      </DsBlock>

      <DsBlock title={c.motion} note={c.motionNote}>
        <div className="grid gap-6">
          <div className="flex flex-wrap items-center gap-6">
            <SuccessMark />
            <div className="grid">
              <span className="type-xs text-ink-2">{c.points}</span>
              <CountUp value={2000} format={f.number} className="type-h1" />
            </div>
          </div>
          <Carousel
            label={c.carousel}
            autoplay={6000}
            aspect="16 / 7"
            slides={[c.slide1, c.slide2, c.slide3].map((text, i) => (
              <div key={text} data-gel={(["nintendo", "playstation", "handheld"] as const)[i]} className="band band--platform grid h-full place-items-center p-6 text-center">
                <span className="band__light" aria-hidden="true" />
                <p className="type-h2 carousel__parallax">
                  <bdi>{text}</bdi>
                </p>
              </div>
            ))}
          />
          <Accordion
            items={[
              { id: "q1", summary: c.q1, content: <p className="type-read text-ink-2">{c.a1}</p> },
              { id: "q2", summary: c.q2, content: <p className="type-read text-ink-2">{c.a2}</p> },
            ]}
          />
          <Reveal stagger className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {[c.staggerA, c.staggerB, c.staggerC, c.staggerD].map((text, i) => (
              <div key={i} className="surface p-4 type-card">
                {text}
              </div>
            ))}
          </Reveal>
        </div>
      </DsBlock>
    </div>
  );
}
