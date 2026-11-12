// lint-design: allow primary-count — the reference page shows the primary button in every state; it is not a shopping view.
import { useState, type CSSProperties, type ReactNode } from "react";

import { Icon, ICON_GROUPS, type IconName } from "~/art/Icon";
import { LocaleLink, useT } from "~/i18n/react";
import { LOCALE_CODES, LOCALES } from "~/lib/locales";
import { Band } from "~/ui/Band";
import { Chip, ChipGroup } from "~/ui/Chip";
import { CompatBadge } from "~/ui/CompatBadge";
import { DemoNote } from "~/ui/DemoNote";
import { Glass } from "~/ui/Glass";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { PLATFORMS, PlatformLabel, PlatformLed } from "~/ui/PlatformLed";
import { Price } from "~/ui/Price";
import { DeliveryNote, PriceTag, SafePrice } from "~/ui/PriceTag";
import { Segmented } from "~/ui/Segmented";
import { Render } from "~/ui/Stage";
import { StockNote } from "~/ui/StockNote";
import { Status, StockStatus, Tag } from "~/ui/Tag";
import { Tabs } from "~/ui/Tabs";
import { TextLink } from "~/ui/TextLink";
import { DsBlock, defineCopy, Specimen, SpecimenGrid, SpecimenRow, useCopy, type DsSectionMeta } from "../kit";

export const section: DsSectionMeta = {
  id: "core",
  order: 0,
  title: { ar: "الأساس", en: "Core", ckb: "بنەڕەت" },
  owner: "app/styles · app/ui — Design System v2 §2, §4.3–§4.8 · docs/ui/core.md",
};

const COPY = defineCopy({
  ar: {
    colours: "الألوان والسطوح",
    coloursNote: "الأحمر والأبيض هوية المتجر، وألوان المنصات الأربع أبوابه. كل ما عدا ذلك أبيض دافئ وجرافيت وخطوط رفيعة. الكوّة (--niche) أرضية المنتج وحدها.",
    type: "الخطوط",
    typeNote: "خط المتجر الأول عاد: Kufam 600 للعناوين وأسماء الأزرار (لا يقل عن 15 بكسل) وKufam 700 للأسعار والأرقام، وIBM Plex Sans Arabic 400/500/600 لكل ما يُقرأ. مقاسات صحيحة فقط، ولا نص عربي تحت 13 بكسل إلا الوسوم والخرزة.",
    displaySample: "العب على",
    h1Sample: "PlayStation 5 Slim",
    h2Sample: "وصل حديثاً",
    tileSample: "الأجهزة المحمولة",
    h3Sample: "اختر المحافظة",
    leadSample: "أجهزة وألعاب وإكسسوارات، جديدة ومستعملة.",
    bodySample: "التوصيل 5,000 د.ع لكل المحافظات. الدفع عند الاستلام متاح.",
    cardSample: "Nintendo Switch 2 · حزمة Mario Kart World",
    smSample: "متوفر · ضمان الشركة المصنّعة",
    xsSample: "وقت مفضّل وليس موعداً مؤكداً.",
    tagSample: "جديد",
    partialNote: "يحتاج تحديث البرنامج",
    shape: "الزوايا والظلال",
    shapeNote: "ست زوايا فقط وسبع وصفات ظل. لا ظل على شيء ساكن؛ الطين على المفتاح الأساسي وبلاطات المنصات وحدها.",
    icons: "الأيقونات",
    iconsNote: "أيقونات Phosphor بثلاثة مقاسات (16، 20، 24). الأسهم والأسهم الصغيرة تنعكس في العربية والكردية وحدها.",
    buttons: "الأزرار",
    buttonsNote: "زر أساسي أحمر واحد في كل شاشة: ما يحرّك الشراء إلى الأمام. الحبر يعني «مختار» وليس «إجراء». الزر المعطّل يُكتب سببه بجانبه.",
    add: "أضف إلى السلة",
    filters: "الفلاتر",
    sort: "الترتيب",
    undo: "تراجع",
    cancel: "إلغاء",
    remove: "أزل من السلة",
    buy: "اشترِ Nintendo Switch 2",
    viewCart: "عرض السلة",
    checkout: "إتمام الطلب",
    soldOutReason: "نفد حالياً.",
    placeOrder: "أكّد الطلب",
    iconButtons: "أزرار الأيقونات",
    iconButtonsNote: "دائرة 40 بكسل (32 على الصور فقط) ومساحة لمس 44 دائماً. الاسم مطلوب ويسمّي الشيء. المفعَّل أيقونة ممتلئة مع aria-pressed.",
    close: "أغلق",
    favAdd: "أضف PlayStation 5 Slim إلى المفضلة",
    favRemove: "أزل PlayStation 5 Slim من المفضلة",
    next: "تسوّق Xbox",
    share: "شارك هذا المنتج",
    links: "الروابط",
    linksNote: "حبر بوزن 600 مع خط رفيع يصير حبراً تحت المؤشر، وسهم ينعكس مع اتجاه القراءة. الأيقونة خارج الكلمات المسطّرة. الروابط لا تكون حمراء.",
    allOf: "كل منتجات PlayStation",
    edit: "عدّل العنوان",
    returnsBefore: "يمكنك إرجاع الجهاز خلال 7 أيام. اقرأ",
    returnsLink: "سياسة الإرجاع",
    returnsAfter: "قبل الطلب.",
    deleteAddress: "احذف هذا العنوان",
    choices: "الرقائق والتحكم المجزّأ والتبويبات",
    choicesNote: "الرقاقة حالة لا إجراء: حبّة 40 بكسل، والمختارة حبر مع علامة صح. التحكم المجزّأ لاختيار واحد من قليل. التبويبات تبدّل المحتوى في مكانه.",
    all: "الكل",
    games: "الألعاب",
    worksWith: "يعمل مع PS5 Slim",
    soon: "قريباً",
    theme: "المظهر",
    system: "النظام",
    light: "فاتح",
    dark: "داكن",
    language: "اللغة",
    supportNav: "الدعم",
    help: "المساعدة",
    track: "تتبّع",
    repair: "الصيانة",
    contact: "تواصل",
    specs: "المواصفات",
    inBox: "في العلبة",
    compat: "التوافق",
    specsText: "شاشة 7.9 بوصة بدقة 1080p، وذاكرة 256GB.",
    inBoxText: "الجهاز ووحدتا Joy-Con 2 والقاعدة والكوابل.",
    compatText: "يعمل مع ألعاب Nintendo Switch 2 وأغلب ألعاب Switch.",
    badges: "الشارات والحالة والوضع التجريبي",
    badgesNote: "شارة واحدة لكل بطاقة تذكر حقيقة. الحالة نقطة وكلمات دائماً. الوضع التجريبي هادئ وصادق ولا يُعكس في الوضع الداكن.",
    gradeSample: "كالجديد",
    pendingReview: "بانتظار التحقق",
    stOk: "متوفر",
    stInfo: "تم الشحن",
    stBad: "مرفوضة",
    kindPs5: "جهاز PS5",
    kindSwitch: "لعبة Switch 2",
    soonOn: "قريباً · 19 تشرين الثاني",
    footerDemo: "المتجر في وضع العرض التجريبي: الأسعار والمخزون بيانات مؤقتة للعرض.",
    price: "السعر",
    priceNote: "أرقام Kufam 700 بعرض ثابت والعملة بعد الرقم بمقاس أصغر ثابت لا يقل عن 12 بكسل. السعر لا يتحرك. أحمر واحد في كل ملخص: الإجمالي.",
    platform: "المنصات",
    platformNote: "لون المنصة سطح في أربعة أماكن فقط (البلاطات وشريط المنصة ورأس صفحة الجهاز والحملات). في كل مكان آخر نقطة 8 بكسل بجانب اسمها.",
    glass: "الزجاج",
    glassNote: "الزجاج للأشرطة الرفيعة الثابتة وحدها، ولوحتان حيّتان في الشاشة على الأكثر. القوائم والصفائح والحوارات والإشعارات مُعتمة. مرّر داخل الصندوق.",
    scrollMe: "مرّر هنا: المحتوى يمر تحت الشريط الزجاجي.",
    results: "24 منتجاً",
    sample: "الأسعار وأسماء المنتجات هنا أمثلة للعرض.",
    pageSoon: "قريباً · 19 تشرين الثاني",
    pageStatus: "سطر الحالة بكلماتك (منتج قادم)، والسعر السابق على سطر 13px",
    pageDemoWas: "سعر سابق تجريبي: يُشطب ولا يُقال «توفّر»",
    segScroll: "روابط لا تتسع: المسار يتمرر جانبياً ويبقى الحالي ظاهراً (aria-current=\"true\" لقسم)",
    assistant: "المساعد",
    status: "حالة الصيانة",
    tabsInView: "صف تبويبات أطول من مكانه: التبويب الحالي يبقى ظاهراً",
    tabMore: "الأسئلة",
    tabUsed: "المستعمل",
    tabGuides: "الأدلة",
    tabRepairs: "الصيانة",
  },
  en: {
    colours: "Colour and surfaces",
    coloursNote: "Red and white is the brand; the four platform colours are the doors. Everything else is warm white, graphite and hairlines. --niche is the product ground and nothing else.",
    type: "Type",
    typeNote: "The store's original type is back: Kufam 600 for headings and key labels (never under 15px), Kufam 700 for prices and numerals, IBM Plex Sans Arabic 400/500/600 for everything read. Integer sizes only; no Arabic under 13px except tags and the bead.",
    displaySample: "Play on",
    h1Sample: "PlayStation 5 Slim",
    h2Sample: "New arrivals",
    tileSample: "Handheld PCs",
    h3Sample: "Choose your governorate",
    leadSample: "Consoles, games and accessories, new and used.",
    bodySample: "Delivery 5,000 IQD to every governorate. Cash on delivery available.",
    cardSample: "Nintendo Switch 2 · Mario Kart World bundle",
    smSample: "In stock · manufacturer warranty",
    xsSample: "A preference, not a confirmed time.",
    tagSample: "New",
    partialNote: "Needs a software update",
    shape: "Radius and elevation",
    shapeNote: "Six radii and seven shadow recipes. Nothing at rest has a shadow; clay belongs to the primary button and the platform tiles only.",
    icons: "Icons",
    iconsNote: "Phosphor icons in three sizes (16, 20, 24). Only arrows and carets mirror in Arabic and Kurdish.",
    buttons: "Buttons",
    buttonsNote: "One red primary per view: the action that moves the purchase forward. Ink means selected, never action. A disabled button states its reason beside it.",
    add: "Add to cart",
    filters: "Filters",
    sort: "Sort",
    undo: "Undo",
    cancel: "Cancel",
    remove: "Remove from cart",
    buy: "Buy Nintendo Switch 2",
    viewCart: "View cart",
    checkout: "Check out",
    soldOutReason: "Sold out.",
    placeOrder: "Place order",
    iconButtons: "Icon buttons",
    iconButtonsNote: "A 40px circle (32 only on photos), always a 44px hit area. The name is required and names the object. Held: a filled glyph with aria-pressed.",
    close: "Close",
    favAdd: "Add PlayStation 5 Slim to favourites",
    favRemove: "Remove PlayStation 5 Slim from favourites",
    next: "Shop Xbox",
    share: "Share this product",
    links: "Links",
    linksNote: "Ink 600 with a hairline underline that turns ink under the pointer, and an arrow that mirrors with the reading direction. The icon stays outside the underlined words. Links are never red.",
    allOf: "All PlayStation products",
    edit: "Edit the address",
    returnsBefore: "You can return the device within 7 days. Read the",
    returnsLink: "returns policy",
    returnsAfter: "before ordering.",
    deleteAddress: "Delete this address",
    choices: "Chips, segmented control and tabs",
    choicesNote: "A chip is state, never action: a 40px pill; chosen is ink with a check. The segmented control picks one of a few. Tabs switch content in place.",
    all: "All",
    games: "Games",
    worksWith: "Works with PS5 Slim",
    soon: "Coming soon",
    theme: "Theme",
    system: "System",
    light: "Light",
    dark: "Dark",
    language: "Language",
    supportNav: "Support",
    help: "Help",
    track: "Track",
    repair: "Repair",
    contact: "Contact",
    specs: "Specs",
    inBox: "In the box",
    compat: "Compatibility",
    specsText: "A 7.9-inch 1080p screen and 256GB of storage.",
    inBoxText: "The console, two Joy-Con 2, the dock and the cables.",
    compatText: "Plays Nintendo Switch 2 games and most Switch games.",
    badges: "Badges, status and demo marking",
    badgesNote: "One badge per card, stating a fact. Status is always a dot and words. The demo marking is quiet, honest and never inverted in dark mode.",
    gradeSample: "Like new",
    pendingReview: "Awaiting verification",
    stOk: "In stock",
    stInfo: "Shipped",
    stBad: "Rejected",
    kindPs5: "PS5 console",
    kindSwitch: "Switch 2 game",
    soonOn: "Coming soon · 19 November",
    footerDemo: "The store is in demo mode: prices and stock are temporary display data.",
    price: "Price",
    priceNote: "Kufam 700 tabular figures; the currency after the figure at a smaller fixed size, never under 12px. Money never moves. One red figure per summary: the total.",
    platform: "Platforms",
    platformNote: "A platform's colour is a surface in four places only (tiles, the hub band, the device head, campaigns). Everywhere else it is an 8px dot beside its name.",
    glass: "Glass",
    glassNote: "Glass is for thin fixed bars only, two live panes per viewport at most. Menus, sheets, dialogs and toasts are opaque. Scroll inside the box.",
    scrollMe: "Scroll here: the content passes under the glass bar.",
    results: "24 products",
    sample: "Prices and product names here are display examples.",
    pageSoon: "Coming soon · 19 November",
    pageStatus: "The status line in your words (a coming product); the previous price on a 13px line",
    pageDemoWas: "A demo previous price: struck, no «You save»",
    segScroll: "Links that do not fit: the track scrolls sideways, the current one in view (aria-current=\"true\" for a section)",
    assistant: "Assistant",
    status: "Repair status",
    tabsInView: "A row of tabs longer than its room: the current tab stays in view",
    tabMore: "Questions",
    tabUsed: "Used",
    tabGuides: "Guides",
    tabRepairs: "Repairs",
  },
  ckb: {
    colours: "ڕەنگ و ڕووکارەکان",
    coloursNote: "سوور و سپی ناسنامەی فرۆشگایە، چوار ڕەنگی پلاتفۆرمەکان دەرگاکانین. هەموو شتێکی تر سپیی گەرم و گرافیت و هێڵی باریکە. --niche تەنها زەوی بەرهەمە.",
    type: "فۆنت",
    typeNote: "فۆنتی سەرەتای فرۆشگا گەڕایەوە: Kufam 600 بۆ ناونیشان و ناوی دوگمەکان (هەرگیز کەمتر لە 15 پیکسڵ)، Kufam 700 بۆ نرخ و ژمارە، IBM Plex Sans Arabic 400/500/600 بۆ هەموو ئەوەی دەخوێندرێتەوە. تەنها قەبارەی تەواو.",
    displaySample: "یاری بکە لەسەر",
    h1Sample: "PlayStation 5 Slim",
    h2Sample: "تازە گەیشتوو",
    tileSample: "ئامێرە دەستییەکان",
    h3Sample: "پارێزگاکەت هەڵبژێرە",
    leadSample: "ئامێر و یاری و پاشکۆ، نوێ و بەکارهاتوو.",
    bodySample: "گەیاندن 5,000 دینار بۆ هەموو پارێزگاکان. پارەدان لە کاتی وەرگرتن بەردەستە.",
    cardSample: "Nintendo Switch 2 · پاکێجی Mario Kart World",
    smSample: "بەردەستە · گەرەنتیی کۆمپانیا",
    xsSample: "کاتێکی دڵخوازە، کاتێکی دووپاتکراوە نییە.",
    tagSample: "نوێ",
    partialNote: "پێویستی بە نوێکردنەوەی نەرمەکاڵا هەیە",
    shape: "گۆشە و سێبەر",
    shapeNote: "تەنها شەش گۆشە و حەوت سێبەر. هیچ شتێکی وەستاو سێبەری نییە؛ قوڕ تەنها بۆ دوگمەی سەرەکی و تایلەکانی پلاتفۆرمە.",
    icons: "ئایکۆنەکان",
    iconsNote: "ئایکۆنی Phosphor بە سێ قەبارە (16، 20، 24). تەنها تیر و تیرۆکەکان لە عەرەبی و کوردیدا هەڵدەگەڕێنەوە.",
    buttons: "دوگمەکان",
    buttonsNote: "تەنها یەک دوگمەی سەرەکیی سوور لە هەر شاشەیەکدا: ئەوەی کڕین بەرەوپێش دەبات. مەرەکەب واتە «هەڵبژێردراو»، نەک «کردار». دوگمەی ناچالاک هۆکارەکەی لە تەنیشتیەوە دەنووسرێت.",
    add: "بیخە ناو سەبەتە",
    filters: "فلتەرەکان",
    sort: "ڕیزکردن",
    undo: "پاشگەزبوونەوە",
    cancel: "هەڵوەشاندنەوە",
    remove: "لە سەبەتە لای بدە",
    buy: "Nintendo Switch 2 بکڕە",
    viewCart: "سەبەتە ببینە",
    checkout: "تەواوکردنی داواکاری",
    soldOutReason: "ئێستا نەماوە.",
    placeOrder: "داواکارییەکە دووپات بکەرەوە",
    iconButtons: "دوگمەی ئایکۆن",
    iconButtonsNote: "بازنەیەکی 40 پیکسڵی (32 تەنها لەسەر وێنە)، هەمیشە ڕووبەری 44 پیکسڵی دەستلێدان. ناو پێویستە و شتەکە ناو دەبات.",
    close: "دایبخە",
    favAdd: "PlayStation 5 Slim بخە ناو دڵخوازەکان",
    favRemove: "PlayStation 5 Slim لە دڵخوازەکان لابە",
    next: "بازاڕی Xbox بکە",
    share: "ئەم بەرهەمە هاوبەش بکە",
    links: "بەستەرەکان",
    linksNote: "مەرەکەبی 600 لەگەڵ هێڵێکی باریک کە لە ژێر نیشاندەردا مەرەکەب دەبێت، و تیرێک کە لەگەڵ ئاراستەی خوێندنەوە هەڵدەگەڕێتەوە. بەستەر هەرگیز سوور نییە.",
    allOf: "هەموو بەرهەمەکانی PlayStation",
    edit: "ناونیشانەکە دەستکاری بکە",
    returnsBefore: "دەتوانیت ئامێرەکە لە ماوەی 7 ڕۆژدا بگەڕێنیتەوە. پێش داواکردن",
    returnsLink: "سیاسەتی گەڕاندنەوە",
    returnsAfter: "بخوێنەوە.",
    deleteAddress: "ئەم ناونیشانە بسڕەوە",
    choices: "چیپ و کۆنترۆڵی بەشکراو و تابەکان",
    choicesNote: "چیپ دۆخە نەک کردار: حەبێکی 40 پیکسڵی؛ هەڵبژێردراو مەرەکەبە لەگەڵ نیشانەی ڕاست. کۆنترۆڵی بەشکراو یەکێک لە چەند دانەیەک هەڵدەبژێرێت.",
    all: "هەموو",
    games: "یارییەکان",
    worksWith: "لەگەڵ PS5 Slim کار دەکات",
    soon: "بەم زووانە",
    theme: "ڕووکار",
    system: "سیستەم",
    light: "ڕوون",
    dark: "تاریک",
    language: "زمان",
    supportNav: "پشتگیری",
    help: "یارمەتی",
    track: "بەدواداچوون",
    repair: "چاککردنەوە",
    contact: "پەیوەندی",
    specs: "تایبەتمەندییەکان",
    inBox: "لە ناو قوتوودا",
    compat: "گونجاندن",
    specsText: "شاشەی 7.9 ئینج بە وردیی 1080p و بیرگەی 256GB.",
    inBoxText: "ئامێرەکە و دوو Joy-Con 2 و بنکەکە و کێبڵەکان.",
    compatText: "یارییەکانی Nintendo Switch 2 و زۆربەی یارییەکانی Switch.",
    badges: "نیشانە و دۆخ و نیشانەی تاقیکاری",
    badgesNote: "بۆ هەر کارتێک یەک نیشانە کە ڕاستییەک دەڵێت. دۆخ هەمیشە خاڵ و وشەیە. نیشانەی تاقیکاری بێدەنگ و ڕاستگۆیە.",
    gradeSample: "وەک نوێ",
    pendingReview: "چاوەڕێی پشتڕاستکردنەوە",
    stOk: "بەردەستە",
    stInfo: "نێردرا",
    stBad: "ڕەتکرایەوە",
    kindPs5: "ئامێری PS5",
    kindSwitch: "یاریی Switch 2",
    soonOn: "بەم زووانە · 19 تشرینی دووەم",
    footerDemo: "فرۆشگاکە لە دۆخی پیشاندانی تاقیکارییە: نرخ و کۆگا داتای کاتین بۆ پیشاندان.",
    price: "نرخ",
    priceNote: "ژمارەی Kufam 700 بە پانیی جێگیر؛ دراو دوای ژمارە بە قەبارەیەکی بچووکتری جێگیر، هەرگیز کەمتر لە 12 پیکسڵ. پارە هەرگیز ناجووڵێت. یەک سوور لە هەر پوختەیەکدا: کۆی گشتی.",
    platform: "پلاتفۆرمەکان",
    platformNote: "ڕەنگی پلاتفۆرم تەنها لە چوار شوێندا ڕووکارە. لە هەموو شوێنێکی تر خاڵێکی 8 پیکسڵییە لە تەنیشت ناوەکەی.",
    glass: "شووشە",
    glassNote: "شووشە تەنها بۆ شریتە باریکە جێگیرەکانە، لە هەر شاشەیەکدا دووان بە زۆری. لیست و پەڕە و دیالۆگ و ئاگادارکردنەوەکان ناڕوونن.",
    scrollMe: "لێرە بخولێنەوە: ناوەڕۆکەکە بە ژێر شریتە شووشەییەکەدا تێدەپەڕێت.",
    results: "24 بەرهەم",
    sample: "نرخ و ناوی بەرهەمەکان لێرە نموونەی پیشاندانن.",
    pageSoon: "بەم زووانە · 19ی تشرینی دووەم",
    pageStatus: "دێڕی دۆخ بە وشەی خۆت (بەرهەمێکی داهاتوو)؛ نرخی پێشوو لە دێڕێکی 13px",
    pageDemoWas: "نرخی پێشووی نموونەیی: هێڵی بەسەردا دێت، «پاشەکەوت» ناگوترێت",
    segScroll: "بەستەرێک کە جێی نابێتەوە: ڕێڕەوەکە بە لادا دەجووڵێت و ئێستاکە دیار دەمێنێت (aria-current=\"true\" بۆ بەشێک)",
    assistant: "یاریدەدەر",
    status: "دۆخی چاککردنەوە",
    tabsInView: "ڕیزێک تاب درێژتر لە شوێنەکەی: تابی ئێستا دیار دەمێنێت",
    tabMore: "پرسیارەکان",
    tabUsed: "بەکارهاتوو",
    tabGuides: "ڕێبەرەکان",
    tabRepairs: "چاککردنەوە",
  },
});

type C = (typeof COPY)["ar"];

export default function CoreSection() {
  const c = useCopy(COPY);
  return (
    <>
      <p className="ds-note">{c.sample}</p>
      <Colours c={c} />
      <TypeRoles c={c} />
      <Shape c={c} />
      <Icons c={c} />
      <Buttons c={c} />
      <IconButtons c={c} />
      <Links c={c} />
      <Choices c={c} />
      <Badges c={c} />
      <Prices c={c} />
      <Platforms c={c} />
      <GlassBars c={c} />
    </>
  );
}

/* ───────────────────────────── colour ───────────────────────────── */

const SWATCH_GROUPS: { title: string; tokens: string[] }[] = [
  { title: "surfaces", tokens: ["--ground", "--paper", "--niche", "--niche-2", "--band"] },
  { title: "ink & lines", tokens: ["--ink", "--ink-2", "--ink-3", "--line", "--line-2", "--line-strong"] },
  { title: "brand", tokens: ["--red", "--red-hover", "--red-deep", "--red-ink", "--red-tint", "--hero"] },
  { title: "state", tokens: ["--ok", "--ok-tint", "--warn", "--warn-tint", "--info", "--info-tint", "--danger", "--danger-tint", "--demo-ink", "--demo-bg"] },
  { title: "platforms", tokens: ["--plat-nintendo", "--plat-playstation", "--plat-xbox", "--plat-handheld", "--dot-nintendo", "--dot-playstation", "--dot-xbox", "--dot-handheld"] },
];

function Colours({ c }: { c: C }) {
  return (
    <DsBlock id="core-colours" title={c.colours} note={c.coloursNote}>
      {SWATCH_GROUPS.map((group) => (
        <div key={group.title} className="grid gap-2">
          <p className="ds-spec__label" dir="ltr">
            {group.title}
          </p>
          <div className="ds-grid ds-grid--swatches">
            {group.tokens.map((token) => (
              <figure key={token} className="ds-spec">
                <span className="ds-swatch" style={{ background: `var(${token})` } as CSSProperties} aria-hidden="true" />
                <figcaption className="ds-spec__label">
                  <code dir="ltr">{token}</code>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      ))}
    </DsBlock>
  );
}

/* ───────────────────────────── type ───────────────────────────── */

function TypeRoles({ c }: { c: C }) {
  const rows: [string, ReactNode][] = [
    ["type-display", <span key="d" className="type-display">{c.displaySample}<br /><bdi>Nintendo&nbsp;Switch&nbsp;2</bdi></span>],
    ["type-h1", <span key="1" className="type-h1"><bdi>{c.h1Sample}</bdi></span>],
    ["type-h2", <span key="2" className="type-h2">{c.h2Sample}</span>],
    ["type-tile", <span key="t" className="type-tile">{c.tileSample}</span>],
    ["type-day", <span key="day" className="type-day">19</span>],
    ["type-h3", <span key="3" className="type-h3">{c.h3Sample}</span>],
    ["type-code", <span key="c" className="type-code" dir="ltr">TT-7K4M2Q9X</span>],
    ["type-lead", <span key="l" className="type-lead">{c.leadSample}</span>],
    ["type-body", <span key="b" className="type-body">{c.bodySample}</span>],
    ["type-card", <span key="cd" className="type-card">{c.cardSample}</span>],
    ["type-sm · type-sm-strong", <span key="s" className="type-sm">{c.smSample} · <b className="type-sm-strong">{c.smSample}</b></span>],
    ["type-xs · type-xs-strong", <span key="x" className="type-xs text-ink-2">{c.xsSample}</span>],
    ["type-tag", <span key="tg" className="tag tag--new justify-self-start">{c.tagSample}</span>],
    ['Price size="xl" · "lg" · "md" · "sm"', <span key="p" className="flex flex-wrap items-baseline gap-x-6 gap-y-2"><Price amountIqd={667750} size="xl" approx="off" as="span" /><Price amountIqd={1513750} size="lg" approx="off" as="span" /><Price amountIqd={99750} size="md" approx="off" as="span" /><Price amountIqd={5000} size="sm" approx="off" as="span" /></span>],
  ];
  return (
    <DsBlock id="core-type" title={c.type} note={c.typeNote}>
      <div className="ds-type">
        {rows.map(([label, sample]) => (
          <div key={label}>
            {sample}
            <code dir="ltr" className="ds-spec__label">
              {label}
            </code>
          </div>
        ))}
      </div>
    </DsBlock>
  );
}

/* ───────────────────────────── shape ───────────────────────────── */

function Shape({ c }: { c: C }) {
  const radii: [string, string][] = [
    ["--r-xs 8", "var(--r-xs)"],
    ["--r-sm 12", "var(--r-sm)"],
    ["--r-lg 20", "var(--r-lg)"],
    ["--r-xl 28", "var(--r-xl)"],
    ["--r-full", "var(--r-full)"],
    ["--r-check 6", "var(--r-check)"],
  ];
  const shadows = ["--e-bar", "--e-float", "--e-overlay", "--e-art"];
  return (
    <DsBlock id="core-shape" title={c.shape} note={c.shapeNote}>
      <SpecimenGrid className="ds-grid--swatches">
        {radii.map(([label, radius]) => (
          <Specimen key={label} label={label}>
            <span className="block h-16 border border-line-strong bg-paper" style={{ borderRadius: radius }} />
          </Specimen>
        ))}
      </SpecimenGrid>
      <SpecimenGrid>
        {shadows.map((token) => (
          <Specimen key={token} label={token}>
            <span className="block h-16 rounded-lg bg-paper" style={{ boxShadow: `var(${token})` }} />
          </Specimen>
        ))}
        <Specimen label="--clay-cap + --clay-cast (Key primary, PlatformTile)">
          <Key variant="primary" block>
            {c.add}
          </Key>
        </Specimen>
        <Specimen label="--rim (dark cabinets, the dark release band)">
          <span className="block h-16 rounded-lg bg-band" style={{ boxShadow: "var(--rim)" }} />
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── icons ───────────────────────────── */

const SHOWN_ICONS: IconName[] = [
  "bag-plus",
  "heart",
  "magnifying-glass",
  "user",
  "house",
  "squares-four",
  "truck",
  "money",
  "credit-card",
  "device-mobile",
  "calendar",
  "calendar-blank",
  "shield-check",
  "arrow-counter-clockwise",
  "game-controller",
  "headphones",
  "hard-drives",
  "gift",
  "wrench",
  "chat-circle",
  "wifi-slash",
  "corners-out",
  "clipboard-text",
  "check-circle",
];

function Icons({ c }: { c: C }) {
  return (
    <DsBlock id="core-icons" title={c.icons} note={c.iconsNote}>
      <SpecimenRow className="gap-4">
        {SHOWN_ICONS.map((name) => (
          <span key={name} className="grid justify-items-center gap-1" title={name}>
            <Icon name={name} size={24} />
            <code dir="ltr" className="ds-spec__label">
              {name}
            </code>
          </span>
        ))}
      </SpecimenRow>
      <SpecimenRow className="gap-6">
        <Specimen label="16 · 20 · 24">
          <span className="flex items-end gap-3">
            <Icon name="truck" size={16} />
            <Icon name="truck" size={20} />
            <Icon name="truck" size={24} />
          </span>
        </Specimen>
        <Specimen label="arrow-right · caret-right (mirror in RTL)">
          <span className="flex items-center gap-3">
            <Icon name="arrow-right" size={24} />
            <Icon name="caret-right" size={24} />
          </span>
        </Specimen>
        <Specimen label={`${ICON_GROUPS.commerce.length + ICON_GROUPS.navigation.length}+ icons · public/icons.svg`}>
          <span className="flex items-center gap-3">
            <Icon name="heart" size={24} filled className="text-red-ink" />
            <Icon name="house" size={24} filled />
          </span>
        </Specimen>
      </SpecimenRow>
    </DsBlock>
  );
}

/* ───────────────────────────── buttons ───────────────────────────── */

function Buttons({ c }: { c: C }) {
  const [held, setHeld] = useState(false);
  return (
    <DsBlock id="core-buttons" title={c.buttons} note={c.buttonsNote}>
      <SpecimenGrid>
        <Specimen label='variant="primary" icon="bag-plus"'>
          <Key variant="primary" icon="bag-plus">
            {c.add}
          </Key>
        </Specimen>
        <Specimen label='variant="secondary" (default) icon'>
          <Key icon="sliders-horizontal">{c.filters}</Key>
        </Specimen>
        <Specimen label='variant="ghost"'>
          <Key variant="ghost">{c.undo}</Key>
        </Specimen>
        <Specimen label='variant="danger"'>
          <Key variant="danger" icon="trash">
            {c.remove}
          </Key>
        </Specimen>
        <Specimen label='size="sm" (40)'>
          <SpecimenRow>
            <Key variant="primary" size="sm">
              {c.checkout}
            </Key>
            <Key size="sm" iconEnd="caret-down">
              {c.sort}
            </Key>
            <Key variant="ghost" size="sm">
              {c.cancel}
            </Key>
          </SpecimenRow>
        </Specimen>
        <Specimen label="held (aria-pressed: ink = selected)">
          <Key held={held} icon="sliders-horizontal" onClick={() => setHeld((on) => !on)}>
            {c.filters}
          </Key>
        </Specimen>
        <Specimen label="disabled + the reason beside it">
          <span className="grid justify-items-start gap-1">
            <Key variant="primary" disabled icon="bag-plus" aria-describedby="ds-core-reason">
              {c.add}
            </Key>
            <span id="ds-core-reason" className="type-xs text-ink-2">
              {c.soldOutReason}
            </span>
          </span>
        </Specimen>
        <Specimen label="loading (same width, aria-busy)">
          <SpecimenRow>
            <Key variant="primary" loading icon="bag-plus">
              {c.add}
            </Key>
            <Key loading>{c.filters}</Key>
          </SpecimenRow>
        </Specimen>
        <Specimen label="as={LocaleLink} iconEnd">
          <Key as={LocaleLink} to="/cart" iconEnd="arrow-right">
            {c.viewCart}
          </Key>
        </Specimen>
        <Specimen label="block (sheets, task bars, the phone hero)" wide>
          <Key variant="primary" block>
            {c.placeOrder}
          </Key>
        </Specimen>
        <Specimen label='variant="onBand" on the hero band (dark theme: the red primary)' wide>
          <Band kind="hero" as="div" className="p-6" contentClassName="flex flex-wrap items-center gap-4">
            <Key variant="onBand">{c.buy}</Key>
            <TextLink as={LocaleLink} to="/p/nintendo-switch-2">
              <bdi>Nintendo Switch 2</bdi>
            </TextLink>
          </Band>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function IconButtons({ c }: { c: C }) {
  const [fav, setFav] = useState(true);
  return (
    <DsBlock id="core-iconbuttons" title={c.iconButtons} note={c.iconButtonsNote}>
      <SpecimenGrid>
        <Specimen label='variant="outline" (default) · "plain"'>
          <SpecimenRow>
            <IconKey icon="x" label={c.close} />
            <IconKey icon="share-network" label={c.share} />
            <IconKey icon="x" variant="plain" label={c.close} />
          </SpecimenRow>
        </Specimen>
        <Specimen label="held → filled heart in --red-ink (.key--wish)">
          <SpecimenRow>
            <IconKey icon="heart" label={fav ? c.favRemove : c.favAdd} held={fav} onClick={() => setFav((on) => !on)} className="key--wish" />
            <IconKey icon="heart" label={c.favAdd} className="key--wish" />
          </SpecimenRow>
        </Specimen>
        <Specimen label='size="sm" 36 · disabled'>
          <SpecimenRow>
            <IconKey icon="minus" size="sm" label={c.close} />
            <IconKey icon="plus" size="sm" label={c.close} disabled />
          </SpecimenRow>
        </Specimen>
        <Specimen label='variant="onImage" size="xs" (32, on a photo)'>
          <Niche as="span" className="w-36" fav={<IconKey icon="heart" variant="onImage" size="xs" label={c.favAdd} className="key--wish" />}>
            <Render name="playstation-5-slim--1" alt="" sizes="144px" />
          </Niche>
        </Specimen>
        <Specimen label='variant="onColor" (the disc on tiles and bands)'>
          <Band kind="platform" platform="xbox" as="div" className="grid min-h-24 items-end p-4">
            <IconKey as={LocaleLink} to="/platform/xbox" icon="arrow-right" variant="onColor" label={c.next} />
          </Band>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Links({ c }: { c: C }) {
  return (
    <DsBlock id="core-links" title={c.links} note={c.linksNote}>
      <SpecimenGrid>
        <Specimen label="<TextLink> (arrow toward the reading end)">
          <TextLink as={LocaleLink} to="/platform/playstation">
            {c.allOf}
          </TextLink>
        </Specimen>
        <Specimen label='icon="pencil-simple" arrow={false}'>
          <TextLink as={LocaleLink} to="/account/addresses" icon="pencil-simple" arrow={false}>
            {c.edit}
          </TextLink>
        </Specimen>
        <Specimen label="inline (always underlined)">
          <p className="type-body">
            {c.returnsBefore}{" "}
            <TextLink as={LocaleLink} to="/policies/returns" inline>
              {c.returnsLink}
            </TextLink>{" "}
            {c.returnsAfter}
          </p>
        </Specimen>
        <Specimen label='external · tone="danger"'>
          <span className="grid justify-items-start">
            <TextLink as="a" href="https://www.playstation.com/" external>
              <bdi>playstation.com</bdi>
            </TextLink>
            <TextLink as="button" type="button" tone="danger" arrow={false}>
              {c.deleteAddress}
            </TextLink>
          </span>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── chips, segmented, tabs ───────────────────────────── */

function Choices({ c }: { c: C }) {
  const t = useT("ui");
  const [games, setGames] = useState(false);
  const [platform, setPlatform] = useState<string | null>("all");
  const [theme, setTheme] = useState("system");
  const [lang, setLang] = useState<string>("ar");
  return (
    <DsBlock id="core-choices" title={c.choices} note={c.choicesNote}>
      <SpecimenGrid wide>
        <Specimen label="<Chip> · selected · count · platform dot · removable · disabled" wide>
          <div className="chips">
            <Chip selected>{c.all}</Chip>
            <Chip selected={games} count={18} onClick={() => setGames((on) => !on)}>
              {c.games}
            </Chip>
            <Chip platform="playstation">PlayStation</Chip>
            <Chip onRemove={() => undefined}>{c.worksWith}</Chip>
            <Chip disabled>{c.soon}</Chip>
            <Chip as={LocaleLink} to="/platform/xbox" platform="xbox">
              Xbox
            </Chip>
          </div>
        </Specimen>
        <Specimen label="<ChipGroup rail bleed> (radiogroup; scrolls on phones, wraps from 768)" wide>
          <ChipGroup
            aria-label={c.games}
            rail
            bleed
            value={platform}
            onChange={setPlatform}
            options={[
              { value: "all", label: c.all, count: 42 },
              ...PLATFORMS.map((p) => ({ value: p, label: t(`platform.${p}`), platform: p })),
            ]}
          />
        </Specimen>
        <Specimen label="<Segmented> theme (inline)">
          <Segmented
            inline
            aria-label={c.theme}
            value={theme}
            onChange={setTheme}
            options={[
              { value: "system", label: c.system },
              { value: "light", label: c.light, icon: "sun" },
              { value: "dark", label: c.dark, icon: "moon" },
            ]}
          />
        </Specimen>
        <Specimen label="<Segmented> language (each name in its own script)">
          <Segmented inline aria-label={c.language} value={lang} onChange={setLang} options={LOCALE_CODES.map((code) => ({ value: code, label: LOCALES[code].label, lang: LOCALES[code].bcp47 }))} />
        </Specimen>
        <Specimen label="<Segmented> links (the support sub-navigation)" wide>
          <Segmented
            aria-label={c.supportNav}
            value="help"
            options={[
              { value: "help", label: c.help, href: "/support" },
              { value: "track", label: c.track, href: "/track" },
              { value: "repair", label: c.repair, href: "/support/repair" },
              { value: "contact", label: c.contact, href: "/contact" },
            ]}
          />
        </Specimen>
        <Specimen label={`<Segmented current="true"> · ${c.segScroll}`}>
          <div className="max-w-[17rem]">
            <Segmented
              aria-label={c.supportNav}
              value="status"
              current="true"
              options={[
                { value: "help", label: c.help, href: "/support" },
                { value: "assistant", label: c.assistant, href: "/support/assistant" },
                { value: "repair", label: c.repair, href: "/support/repair" },
                { value: "status", label: c.status, href: "/support/repair/status" },
              ]}
            />
          </div>
        </Specimen>
        <Specimen label="<Tabs> (panels switch in place; 2px ink underline)" wide>
          <Tabs
            aria-label={c.specs}
            items={[
              { value: "specs", label: c.specs, content: <p className="type-body">{c.specsText}</p> },
              { value: "box", label: c.inBox, content: <p className="type-body">{c.inBoxText}</p> },
              { value: "compat", label: c.compat, content: <p className="type-body">{c.compatText}</p> },
            ]}
          />
        </Specimen>
        <Specimen label={`<Tabs defaultValue> · ${c.tabsInView}`}>
          <div className="max-w-[17rem]">
            <Tabs
              aria-label={c.specs}
              defaultValue="more"
              items={[
                { value: "specs", label: c.specs, content: <p className="type-body">{c.specsText}</p> },
                { value: "box", label: c.inBox, content: <p className="type-body">{c.inBoxText}</p> },
                { value: "compat", label: c.compat, content: <p className="type-body">{c.compatText}</p> },
                { value: "guides", label: c.tabGuides, content: <p className="type-body">{c.tabGuides}</p> },
                { value: "repairs", label: c.tabRepairs, content: <p className="type-body">{c.tabRepairs}</p> },
                { value: "used", label: c.tabUsed, content: <p className="type-body">{c.tabUsed}</p> },
                { value: "more", label: c.tabMore, content: <p className="type-body">{c.tabMore}</p> },
              ]}
            />
          </div>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── badges, status, demo ───────────────────────────── */

function Badges({ c }: { c: C }) {
  return (
    <DsBlock id="core-badges" title={c.badges} note={c.badgesNote}>
      <SpecimenGrid>
        <Specimen label='<Tag kind="new" | "soon" | "sale" | "out">'>
          <SpecimenRow>
            <Tag kind="new" />
            <Tag kind="soon" />
            <Tag kind="sale" />
            <Tag kind="out" />
          </SpecimenRow>
        </Specimen>
        <Specimen label='kind="grade" (GradeBadge) · "photo" · "ok"'>
          <SpecimenRow>
            <Tag kind="grade">
              <bdi dir="ltr">A+</bdi> · {c.gradeSample}
            </Tag>
            <Tag kind="photo" />
            <Tag kind="ok">{c.pendingReview}</Tag>
          </SpecimenRow>
        </Specimen>
        <Specimen label='<Status tone> ok · warn · info · bad · out · soon'>
          <span className="grid justify-items-start gap-1">
            <Status tone="ok">{c.stOk}</Status>
            <Status tone="warn">{c.pendingReview}</Status>
            <Status tone="info">{c.stInfo}</Status>
            <Status tone="bad">{c.stBad}</Status>
            <Status tone="out">{c.soldOutReason}</Status>
            <Status tone="soon">{c.soonOn}</Status>
          </span>
        </Specimen>
        <Specimen label="<StockStatus quantity> · <StockNote stock> (no notify-me)">
          <span className="grid justify-items-start gap-1">
            <StockStatus quantity={12} />
            <StockStatus quantity={2} />
            <StockStatus quantity={0} />
            <StockNote stock="preorder" />
          </span>
        </Specimen>
        <Specimen label='<DemoNote variant="tag" what="price" | "priceStock" | "order">'>
          <SpecimenRow>
            <DemoNote variant="tag" what="price" />
            <DemoNote variant="tag" what="priceStock" />
            <DemoNote variant="tag" what="order" />
          </SpecimenRow>
        </Specimen>
        <Specimen label='variant="tag" onColor (on crimson)'>
          <Band kind="hero" as="div" className="p-4" contentClassName="flex items-center gap-3">
            <Price amountIqd={667750} size="lg" tone="onColor" approx="off" as="span" />
            <DemoNote variant="tag" what="price" onColor />
          </Band>
        </Specimen>
        <Specimen label='variant="strip" (phones, a link to the full note)' wide>
          <DemoNote variant="strip" to="/about" />
        </Specimen>
        <Specimen label='variant="chip" (desktop nav row: full from 1280, compact below)'>
          <DemoNote variant="chip" />
        </Specimen>
        <Specimen label='variant="line"'>
          <DemoNote variant="line">{c.footerDemo}</DemoNote>
        </Specimen>
        <Specimen label="<CompatBadge status> (icon AND words)">
          <span className="grid justify-items-start gap-2">
            <CompatBadge status="verified" device="PlayStation 5 Slim" />
            <CompatBadge status="partial" device="PlayStation 5 Pro" note={c.partialNote} />
            <CompatBadge status="incompatible" device="Xbox Series S" />
            <CompatBadge status="unverified" />
          </span>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── price ───────────────────────────── */

function Prices({ c }: { c: C }) {
  return (
    <DsBlock id="core-price" title={c.price} note={c.priceNote}>
      <SpecimenGrid>
        <Specimen label='size="xl" (rate details when USD is chosen above)'>
          <Price amountIqd={667_750} size="xl" />
        </Specimen>
        <Specimen label='tone="sale" ← compareAtIqd (a real previous price)'>
          <Price amountIqd={99_000} compareAtIqd={115_000} />
        </Specimen>
        <Specimen label='size="lg" tone="total" (one red figure per summary)'>
          <Price amountIqd={1_513_750} size="lg" tone="total" approx="off" />
        </Specimen>
        <Specimen label='tone="muted" (sold out)'>
          <Price amountIqd={13_000} tone="muted" approx="off" />
        </Specimen>
        <Specimen label='tone="onColor"'>
          <Band kind="wallet" as="div" className="p-4">
            <Price amountIqd={756_500} size="xl" tone="onColor" approx="off" />
          </Band>
        </Specimen>
        <Specimen label='size="sm" as="span" (in a sentence)'>
          <DeliveryNote feeIqd={5_000} strong />
        </Specimen>
        <Specimen label='<PriceTag size="page" stock deliveryIqd demo>' wide>
          <PriceTag size="page" priceIqd={667_750} stock="in_stock" deliveryIqd={5_000} demo />
        </Specimen>
        <Specimen label={`<PriceTag size="page" compareAtIqd stock="preorder" status> · ${c.pageStatus}`} wide>
          <PriceTag size="page" priceIqd={99_000} compareAtIqd={115_000} stock="preorder" status={c.pageSoon} deliveryIqd={5_000} />
        </Specimen>
        <Specimen label={`<PriceTag size="page" compareAtIqd compareAtDemo demo> · ${c.pageDemoWas}`} wide>
          <PriceTag size="page" priceIqd={435_000} compareAtIqd={455_000} compareAtDemo stock="in_stock" deliveryIqd={5_000} demo />
        </Specimen>
        <Specimen label="<SafePrice amountIqd={NaN}> (never a number)">
          <SafePrice amountIqd={Number.NaN} />
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── platforms ───────────────────────────── */

function Platforms({ c }: { c: C }) {
  return (
    <DsBlock id="core-platform" title={c.platform} note={c.platformNote}>
      <SpecimenGrid>
        <Specimen label="<PlatformLabel platform>">
          <span className="grid justify-items-start gap-2">
            {PLATFORMS.map((p) => (
              <PlatformLabel key={p} platform={p} />
            ))}
          </span>
        </Specimen>
        <Specimen label="<PlatformLabel label> (a card's kind line)">
          <span className="grid justify-items-start gap-2">
            <PlatformLabel platform="playstation" label={c.kindPs5} />
            <PlatformLabel platform="nintendo" label={c.kindSwitch} />
          </span>
        </Specimen>
        <Specimen label=".plat-line (the nav underline in the dot colour)">
          <span className="plat-line inline-flex min-h-11 items-center gap-1.5 type-sm-strong" data-gel="nintendo">
            <PlatformLed />
            Nintendo
          </span>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── glass ───────────────────────────── */

function GlassBars({ c }: { c: C }) {
  return (
    <DsBlock id="core-glass" title={c.glass} note={c.glassNote}>
      <SpecimenGrid wide>
        <Specimen label="<Glass> sticky bar over scrolling content" wide>
          <div className="ds-scroll">
            <Glass className="ds-scroll__bar">
              <span className="type-sm-strong">{c.filters}</span>
              <span className="type-xs text-ink-2">{c.results}</span>
              <IconKey icon="x" variant="plain" label={c.close} />
            </Glass>
            <div className="grid gap-3 p-4">
              <p className="type-body">{c.scrollMe}</p>
              <div className="grid grid-cols-3 gap-3">
                {["nintendo-switch-2--1", "playstation-5-slim--1", "xbox-series-x--1", "dualsense--1", "joy-con-2--1", "steam-deck-oled--1"].map((art) => (
                  <Niche key={art} as="span">
                    <Render name={art} alt="" sizes="160px" />
                  </Niche>
                ))}
              </div>
            </div>
          </div>
        </Specimen>
        <Specimen label='<Glass variant="solid">'>
          <Glass variant="solid" className="flex min-h-14 items-center justify-between rounded-lg px-4">
            <span className="type-sm-strong">{c.filters}</span>
            <IconKey icon="x" variant="plain" label={c.close} />
          </Glass>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}
