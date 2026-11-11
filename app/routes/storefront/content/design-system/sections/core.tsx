// lint-design: allow commit-count — specimens of the commit key in every state, not a shopping view.
import { useState, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import { Chip, ChipGroup } from "~/ui/Chip";
import { Checkbox, FieldGroup, Radio, Select, Switch, TextArea, TextField } from "~/ui/Field";
import { Glass } from "~/ui/Glass";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { KeyBank } from "~/ui/KeyBank";
import { Niche } from "~/ui/Niche";
import { PLATFORMS, PlatformGlyph, PlatformLabel, PlatformLed, type Platform } from "~/ui/PlatformLed";
import { Price } from "~/ui/Price";
import { AddGlyph, Socket, useAddedFlash } from "~/ui/Socket";
import { Render, Stage, StageTag } from "~/ui/Stage";
import { Stepper } from "~/ui/Stepper";
import { StockStatus, Status, Tag } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { DsBlock, defineCopy, Specimen, SpecimenGrid, SpecimenRow, useCopy, type DsSectionMeta } from "../kit";

export const section: DsSectionMeta = {
  id: "core",
  order: 0,
  title: { ar: "الأساس", en: "Core", ckb: "بنەڕەت" },
  owner: "app/styles · app/ui",
};

/* Example products for the specimens. Names are real hardware; the prices are display examples only. */
const DEMO: Record<Platform, { art: string; name: string; priceIqd: number }> = {
  nintendo: { art: "nintendo-switch-2--1", name: "Nintendo Switch 2", priceIqd: 749000 },
  playstation: { art: "playstation-5-slim--1", name: "PlayStation 5 Slim", priceIqd: 445000 },
  xbox: { art: "xbox-series-x--1", name: "Xbox Series X", priceIqd: 689000 },
  handheld: { art: "lenovo-legion-go--1", name: "Lenovo Legion Go", priceIqd: 899000 },
};

const COPY = defineCopy({
  ar: {
    surfaces: "السطوح والحبر",
    surfacesNote: "السطوح مسطّحة: الأرضية والكوّة والمسرح والمجرى والورق. النص حبر وحبر ثانٍ؛ الحبر الثالث للزينة والمعطّل فقط. الأحمر للالتزام وحده.",
    type: "الخطوط",
    typeNote: "كوفام للعناوين ومفاتيح الأزرار والأسعار، وبلكس العربي لكل ما يُقرأ. لا تباعد بين الحروف أبداً، والأرقام بعرض ثابت.",
    heroSample: "وصل",
    sectionSample: "وصل حديثاً",
    subSample: "اختر المحافظة",
    bodySample: "جهاز ألعاب محمول بشاشة 8 بوصة، وضمان سنة من المتجر.",
    strongSample: "مع ذراع تحكم إضافي",
    labelSample: "رقم الهاتف",
    captionSample: "نتصل بك لتأكيد الطلب.",
    keys: "المفاتيح",
    keysNote: "المفتاح الأحمر واحد في كل شاشة: ما يحرّك الطلب إلى الأمام. كل ما عداه طين. المفتاح المفعَّل يبقى مضغوطاً بالحبر، والمعطَّل مسطّح ويُكتب سببه بجانبه.",
    add: "أضف إلى السلة",
    keepShopping: "تابع التسوّق",
    show24: "اعرض 24 منتجاً",
    undo: "تراجع",
    viewCart: "اعرض السلة",
    checkout: "تابع إلى الدفع",
    darkMode: "الوضع الداكن",
    soldOut: "نفدت الكمية.",
    iconKeys: "مفاتيح الأيقونات",
    fav: "أضف إلى المفضلة",
    close: "أغلق",
    copyAccount: "انسخ رقم الحساب",
    bank: "بنك المفاتيح",
    bankNote: "اضغط مفتاحاً فيبقى مضغوطاً، ويرتفع السابق، ويضيء المسرح بلون المنصة. الأسهم تتبع اتجاه القراءة.",
    turn: "دورك.",
    pick: "اختر منصّتك",
    gallery: "صور المنتج",
    viewHero: "المنظر الرئيسي",
    viewFront: "الواجهة",
    viewBack: "الخلف",
    count: "{n} من {total}",
    layout: "طريقة العرض",
    grid: "شبكة",
    list: "قائمة",
    chips: "الرقائق",
    chipsNote: "الرقاقة للاختيار فقط. المختارة مضغوطة بالحبر مع علامة صح، والعلامة محجوزة فلا يتحرك السطر. الحقائق تُكتب نصاً أو وسماً.",
    storage: "التخزين",
    today: "اليوم",
    tomorrow: "غداً",
    morning: "صباحاً",
    evening: "مساءً",
    tags: "الوسوم والحالات",
    tagsNote: "وسم واحد لكل منتج يذكر حقيقة، ويختلف بالشكل لا باللون. الحالة نقطة وكلمات دائماً.",
    excellent: "ممتاز",
    paid: "مدفوع",
    pending: "بانتظار التحقق",
    shipped: "تم الشحن",
    rejected: "مرفوض",
    draft: "مسودة",
    warranty: "ضمان سنة",
    fields: "الحقول",
    fieldsNote: "ورق مسطّح بحدّ حقيقي. الخطأ جملة تقول ما الخطأ وماذا تكتب، مع أيقونة وحدّ بلون الحبر الأحمر، ولا تعبئة حمراء. أرقام الهاتف تبقى من اليسار إلى اليمين.",
    phone: "رقم الهاتف",
    phoneHint: "نتصل بك لتأكيد الطلب.",
    phoneError: "ينقص الرقم 4 أرقام. اكتبه مثل ⁦0770 123 4567⁩.",
    fullName: "الاسم الكامل",
    notes: "ملاحظات للمندوب",
    address: "العنوان الكامل",
    addressHint: "الحي، الشارع، أقرب نقطة دالة.",
    governorate: "المحافظة",
    baghdad: "بغداد",
    basra: "البصرة",
    erbil: "أربيل",
    amount: "المبلغ المحوَّل",
    orderRef: "رقم الطلب",
    offers: "أرسلوا لي العروض على هذا الرقم",
    returnsRead: "قرأت سياسة الإرجاع",
    tickToContinue: "علّم المربع لتتابع.",
    selectAll: "اختر كل الطلبات",
    payment: "طريقة الدفع",
    cod: "الدفع عند الاستلام",
    codHint: "تدفع للمندوب نقداً عند وصول الطلب.",
    zain: "تحويل زين كاش",
    zainHint: "ترفع صورة الحوالة، ونؤكد الطلب بعد التحقق منها.",
    notify: "أعلمني عند التوفّر",
    stepper: "العدّاد",
    stepperNote: "مفتاحان مستديران في مجرى. الناقص في البداية والزائد في النهاية بكل اللغات. اضغط مطوّلاً للتكرار.",
    price: "السعر",
    priceNote: "حبر مسطّح، أرقام بعرض ثابت، والعملة بعد الرقم. اختر USD في الأعلى لترى السطر المحوَّل التقريبي؛ الدفع يبقى بالدينار.",
    deliveryLine: "التوصيل {price} لكل المحافظات.",
    niche: "سطح البطاقة",
    nicheNote: "سطح البطاقة الوحيد: بلا حدّ ولا ظل ولا ضوء. لونه هو بديل الصورة، فلا هيكل رمادي ولا قفزة.",
    emptyTitle: "سلتك فارغة. دورك.",
    emptyText: "اختر منصّتك ونرتّب لك الرف.",
    browse: "تصفّح الأجهزة",
    socket: "المقعد",
    socketNote: "مفتاح السلة في مقعده: أضف · أُضيف (علامة صح لثانية) · مقعد فارغ عندما ينفد.",
    stage: "المسرح المضاء",
    stageNote: "المنتج يطفو داخل بقعة ضوء بلون منصته، وبطاقة السعر الزجاجية معلّقة على الحافة بجانب المفتاح الأحمر. ثلاثة أحجام: الرئيسية، وصفحة المنتج، والمراكز.",
    lights: "ضوء كل منصة",
    platform: "مؤشر المنصة",
    platformNote: "لون المنصة ضوء فقط: مؤشر 16×5 بجانب اسمها مكتوباً. لا شعارات رسمية، والرسوم أشكال أجهزة محايدة.",
    links: "الروابط",
    linksNote: "شكل واحد: حبر بوزن 600 وسهم يتبع اتجاه القراءة. داخل الفقرة يبقى مسطَّراً. الروابط ليست حمراء ولا طيناً.",
    allOf: "كل {name}",
    returnsBefore: "يمكنك إرجاع الجهاز خلال 7 أيام. اقرأ",
    returnsLink: "سياسة الإرجاع",
    returnsAfter: "قبل الطلب.",
    deleteAddress: "احذف العنوان",
    glass: "الزجاج",
    glassNote: "الزجاج الحي فقط على الشرائط الثابتة التي يمرّ المحتوى تحتها، واثنان كحد أقصى في الشاشة. الزجاج الثابت فوق الأسطح الملساء فقط. مرّر داخل الصندوق.",
    filters: "الفلاتر",
    results: "24 منتجاً",
    added: "أُضيف إلى السلة",
    back: "رجوع",
    cart: "السلة",
    table: "جدول البيانات (الإدارة)",
    tableNote: "ورق مسطّح وخطوط رفيعة ورأس ثابت مصمت. الأرقام بعرض ثابت عند نهاية السطر، والسالب بإشارة ناقص ولون الحبر الأحمر.",
    colOrder: "الطلب",
    colStatus: "الحالة",
    colAmount: "المبلغ (د.ع)",
    refund: "استرجاع",
  },
  en: {
    surfaces: "Surfaces and ink",
    surfacesNote: "Surfaces are flat: floor, niche, stage, well and paper. Text is ink and ink-2; ink-3 is decorative and disabled only. Red is for the commit alone.",
    type: "Type",
    typeNote: "Kufam for headlines, key labels and prices; IBM Plex Sans Arabic for everything you read. Never letter-spacing; tabular figures.",
    heroSample: "is here",
    sectionSample: "New arrivals",
    subSample: "Choose your governorate",
    bodySample: "A handheld gaming PC with an 8-inch screen and a one-year store warranty.",
    strongSample: "with an extra controller",
    labelSample: "Phone number",
    captionSample: "We call you to confirm the order.",
    keys: "Keys",
    keysNote: "One red key per view: the action that moves the order forward. Everything else is clay. A key that is on stays down in ink; a disabled key goes flat and says why next to it.",
    add: "Add to cart",
    keepShopping: "Keep shopping",
    show24: "Show 24 products",
    undo: "Undo",
    viewCart: "View cart",
    checkout: "Continue to payment",
    darkMode: "Dark mode",
    soldOut: "Sold out.",
    iconKeys: "Icon keys",
    fav: "Add to favourites",
    close: "Close",
    copyAccount: "Copy the account number",
    bank: "Key bank",
    bankNote: "Press a key and it stays down, the previous one springs up and the stage lights in that platform's colour. Arrow keys follow the reading direction.",
    turn: "Your turn.",
    pick: "Pick your platform",
    gallery: "Product images",
    viewHero: "Main view",
    viewFront: "Front",
    viewBack: "Back",
    count: "{n} of {total}",
    layout: "Layout",
    grid: "Grid",
    list: "List",
    chips: "Chips",
    chipsNote: "Chips are for choices. The chosen one is held down in ink with a check; the mark is reserved, so the row never reflows. Facts are text or a tag.",
    storage: "Storage",
    today: "Today",
    tomorrow: "Tomorrow",
    morning: "Morning",
    evening: "Evening",
    tags: "Tags and status",
    tagsNote: "One tag per product, stating a fact; tags differ by shape, not colour. Status is always a dot and words.",
    excellent: "Excellent",
    paid: "Paid",
    pending: "Awaiting verification",
    shipped: "Shipped",
    rejected: "Rejected",
    draft: "Draft",
    warranty: "1-year warranty",
    fields: "Fields",
    fieldsNote: "Flat paper with a real border. An error is a sentence that says what is wrong and what to type, with an icon and a red-ink border — never a red fill. Phone numbers stay left-to-right.",
    phone: "Phone number",
    phoneHint: "We call you to confirm the order.",
    phoneError: "The number is 4 digits short. Write it like 0770 123 4567.",
    fullName: "Full name",
    notes: "Notes for the courier",
    address: "Full address",
    addressHint: "District, street, nearest landmark.",
    governorate: "Governorate",
    baghdad: "Baghdad",
    basra: "Basra",
    erbil: "Erbil",
    amount: "Amount transferred",
    orderRef: "Order reference",
    offers: "Send me offers on this number",
    returnsRead: "I have read the returns policy",
    tickToContinue: "Tick the box to continue.",
    selectAll: "Select all orders",
    payment: "Payment method",
    cod: "Cash on delivery",
    codHint: "You pay the courier in cash when the order arrives.",
    zain: "Zain Cash transfer",
    zainHint: "You upload the transfer photo; we confirm the order after checking it.",
    notify: "Tell me when it is back",
    stepper: "Stepper",
    stepperNote: "Two round keys in a well. Minus at the start, plus at the end, in every language. Press and hold to repeat.",
    price: "Price",
    priceNote: "Flat ink, tabular figures, the currency after the figure. Choose USD above to see the approximate converted line; payment stays in dinars.",
    deliveryLine: "Delivery {price} to every governorate.",
    niche: "Niche",
    nicheNote: "The one card surface: no border, no shadow, no light. Its colour is the image placeholder — no grey skeleton, no jump.",
    emptyTitle: "Your cart is empty. Your turn.",
    emptyText: "Pick your platform and we will stock the shelf.",
    browse: "Browse devices",
    socket: "Socket",
    socketNote: "The cart key in its socket: add · added (a check for a second) · an empty socket when it is sold out.",
    stage: "The lit stage",
    stageNote: "The product floats in one pool of its platform's light; the glass price tag hangs off the rim beside the red key. Three sizes: home, product page and hubs.",
    lights: "Each platform's light",
    platform: "Platform light",
    platformNote: "Platform colour is light only: a 16×5 LED beside the platform's name written as text. No official logos; the pictograms are neutral device shapes.",
    links: "Links",
    linksNote: "One look: ink, weight 600, an arrow that follows the reading direction. Inside a paragraph it stays underlined. Links are never red and never clay.",
    allOf: "All {name}",
    returnsBefore: "You can return the device within 7 days. Read",
    returnsLink: "the returns policy",
    returnsAfter: "before you order.",
    deleteAddress: "Delete the address",
    glass: "Glass",
    glassNote: "Live glass only on fixed or sticky bars that content scrolls under — two per screen at most. Static glass only over smooth surfaces. Scroll inside the box.",
    filters: "Filters",
    results: "24 products",
    added: "Added to cart",
    back: "Back",
    cart: "Cart",
    table: "Data table (admin)",
    tableNote: "Flat paper, hairlines, a solid sticky head. Numbers are tabular at the inline end; negatives carry a minus sign and red-ink.",
    colOrder: "Order",
    colStatus: "Status",
    colAmount: "Amount (IQD)",
    refund: "Refund",
  },
  ckb: {
    surfaces: "ڕووکار و مەرەکەب",
    surfacesNote: "ڕووکارەکان تەختن: زەوی، تاقچە، شانۆ، جۆگە و کاغەز. دەق مەرەکەب و مەرەکەبی دووەمە؛ مەرەکەبی سێیەم تەنها بۆ جوانکاری و ناچالاکە. سوور تەنها بۆ پابەندبوونە.",
    type: "فۆنت",
    typeNote: "کوفام بۆ سەردێڕ، دوگمە و نرخ؛ IBM Plex Sans Arabic بۆ هەموو ئەوەی دەخوێنرێتەوە. هەرگیز بۆشایی نێوان پیتەکان نییە.",
    heroSample: "گەیشت",
    sectionSample: "تازە گەیشتوون",
    subSample: "پارێزگا هەڵبژێرە",
    bodySample: "ئامێری یاریی دەستی بە شاشەی 8 ئینچ و یەک ساڵ گەرەنتی فرۆشگا.",
    strongSample: "لەگەڵ دەسکێکی زیادە",
    labelSample: "ژمارەی مۆبایل",
    captionSample: "پەیوەندیت پێوە دەکەین بۆ پشتڕاستکردنەوەی داواکاری.",
    keys: "کلیلەکان",
    keysNote: "لە هەر شاشەیەکدا یەک کلیلی سوور: ئەوەی داواکاری دەباتە پێشەوە. هەموو ئەوانی تر قوڕن. کلیلی چالاک بە مەرەکەب داگیراو دەمێنێتەوە؛ کلیلی ناچالاک تەخت دەبێت و هۆکارەکەی لە تەنیشتی دەنووسرێت.",
    add: "بیخە ناو سەبەتە",
    keepShopping: "بەردەوامبە لە بازاڕکردن",
    show24: "24 کاڵا پیشان بدە",
    undo: "پاشگەزبوونەوە",
    viewCart: "سەبەتە ببینە",
    checkout: "بەردەوامبە بۆ پارەدان",
    darkMode: "دۆخی تاریک",
    soldOut: "نەماوە.",
    iconKeys: "کلیلی ئایکۆن",
    fav: "بیخە ناو دڵخوازەکان",
    close: "دایبخە",
    copyAccount: "ژمارەی هەژمار کۆپی بکە",
    bank: "بانکی کلیل",
    bankNote: "کلیلێک دابگرە و داگیراو دەمێنێتەوە، پێشووەکە بەرز دەبێتەوە و شانۆکە بە ڕەنگی پلاتفۆرمەکە ڕووناک دەبێت. تیرەکان ئاراستەی خوێندنەوە دەگرن.",
    turn: "نۆرەی تۆیە.",
    pick: "پلاتفۆرمەکەت هەڵبژێرە",
    gallery: "وێنەکانی کاڵا",
    viewHero: "دیمەنی سەرەکی",
    viewFront: "پێشەوە",
    viewBack: "پشتەوە",
    count: "{n} لە {total}",
    layout: "شێوازی پیشاندان",
    grid: "تۆڕ",
    list: "لیست",
    chips: "هەڵبژاردنەکان",
    chipsNote: "هەڵبژاردن تەنها بۆ بژاردنە. هەڵبژێردراو بە مەرەکەب و نیشانەی ڕاست داگیراوە؛ نیشانەکە جێی پاراستراوە بۆیە ڕیزەکە ناجووڵێت.",
    storage: "بیرگە",
    today: "ئەمڕۆ",
    tomorrow: "سبەینێ",
    morning: "بەیانی",
    evening: "ئێوارە",
    tags: "تاگ و دۆخ",
    tagsNote: "بۆ هەر کاڵایەک یەک تاگ کە ڕاستییەک دەڵێت؛ بە شێوە جیادەکرێنەوە نەک بە ڕەنگ. دۆخ هەمیشە خاڵ و وشەیە.",
    excellent: "نایاب",
    paid: "پارەدراوە",
    pending: "چاوەڕێی پشتڕاستکردنەوە",
    shipped: "نێردرا",
    rejected: "ڕەتکرایەوە",
    draft: "ڕەشنووس",
    warranty: "یەک ساڵ گەرەنتی",
    fields: "خانەکان",
    fieldsNote: "کاغەزی تەخت بە سنووری ڕاستەقینە. هەڵە ڕستەیەکە کە دەڵێت چی هەڵەیە و چی بنووسیت، لەگەڵ ئایکۆن و سنووری سووری مەرەکەبی. ژمارەی مۆبایل لە چەپەوە بۆ ڕاست دەمێنێتەوە.",
    phone: "ژمارەی مۆبایل",
    phoneHint: "پەیوەندیت پێوە دەکەین بۆ پشتڕاستکردنەوەی داواکاری.",
    phoneError: "ژمارەکە 4 ژمارەی کەمە. وەک ⁦0770 123 4567⁩ بینووسە.",
    fullName: "ناوی تەواو",
    notes: "تێبینی بۆ گەیەنەر",
    address: "ناونیشانی تەواو",
    addressHint: "گەڕەک، شەقام، نزیکترین نیشانە.",
    governorate: "پارێزگا",
    baghdad: "بەغدا",
    basra: "بەسرە",
    erbil: "هەولێر",
    amount: "بڕی گواستراوە",
    orderRef: "ژمارەی داواکاری",
    offers: "ئۆفەرەکانم بۆ ئەم ژمارەیە بنێرن",
    returnsRead: "سیاسەتی گەڕاندنەوەم خوێندەوە",
    tickToContinue: "بۆ بەردەوامبوون نیشانەی بکە.",
    selectAll: "هەموو داواکارییەکان هەڵبژێرە",
    payment: "شێوازی پارەدان",
    cod: "پارەدان لە کاتی وەرگرتن",
    codHint: "کاتێک داواکارییەکە گەیشت بە نەختی بە گەیەنەر دەدەیت.",
    zain: "گواستنەوەی زەین کاش",
    zainHint: "وێنەی حەواڵە بار دەکەیت، دوای پشکنین داواکارییەکە پشتڕاست دەکەینەوە.",
    notify: "کاتێک گەڕایەوە ئاگادارم بکەرەوە",
    stepper: "ژمێرەر",
    stepperNote: "دوو کلیلی خڕ لە جۆگەیەکدا. کەمکردنەوە لە سەرەتا و زیادکردن لە کۆتایی، لە هەموو زمانەکاندا. بۆ دووبارەکردنەوە دایبگرە.",
    price: "نرخ",
    priceNote: "مەرەکەبی تەخت، ژمارەی پانی جێگیر، دراو دوای ژمارە. USD لە سەرەوە هەڵبژێرە بۆ بینینی هێڵی گۆڕدراوی نزیکەیی؛ پارەدان بە دینار دەمێنێتەوە.",
    deliveryLine: "گەیاندن {price} بۆ هەموو پارێزگاکان.",
    niche: "ڕووی کارت",
    nicheNote: "تاکە ڕووی کارت: بێ سنوور، بێ سێبەر، بێ ڕووناکی. ڕەنگەکەی جێگرەوەی وێنەیە، بۆیە نە پێکهاتەی خۆڵەمێشی هەیە نە بازدان.",
    emptyTitle: "سەبەتەکەت بەتاڵە. نۆرەی تۆیە.",
    emptyText: "پلاتفۆرمەکەت هەڵبژێرە و ڕەفەکەت بۆ ڕێک دەخەین.",
    browse: "ئامێرەکان ببینە",
    socket: "شوێنی کلیل",
    socketNote: "کلیلی سەبەتە لە شوێنی خۆیدا: زیادکردن · زیادکرا (نیشانەی ڕاست بۆ چرکەیەک) · شوێنی بەتاڵ کاتێک نەماوە.",
    stage: "شانۆی ڕووناک",
    stageNote: "کاڵاکە لە ناو یەک ڕووناکیی ڕەنگی پلاتفۆرمەکەیدا دەفڕێت؛ تاگی شووشەیی نرخ لە لێوارەکە هەڵواسراوە لە تەنیشت کلیلی سوور. سێ قەبارە: سەرەکی، پەڕەی کاڵا و ناوەندەکان.",
    lights: "ڕووناکیی هەر پلاتفۆرمێک",
    platform: "ڕووناکیی پلاتفۆرم",
    platformNote: "ڕەنگی پلاتفۆرم تەنها ڕووناکییە: گڵۆپێکی 16×5 لە تەنیشت ناوە نووسراوەکەی. هیچ لۆگۆیەکی فەرمی نییە؛ وێنەکان شێوەی بێلایەنی ئامێرن.",
    links: "بەستەرەکان",
    linksNote: "یەک شێوە: مەرەکەب، کێشی 600 و تیرێک کە ئاراستەی خوێندنەوە دەگرێت. لە ناو بڕگەدا هێڵی ژێرەوەی دەمێنێت. بەستەر هەرگیز سوور یان قوڕ نییە.",
    allOf: "هەموو {name}",
    returnsBefore: "دەتوانیت ئامێرەکە لە ماوەی 7 ڕۆژدا بگەڕێنیتەوە. پێش داواکردن",
    returnsLink: "سیاسەتی گەڕاندنەوە",
    returnsAfter: "بخوێنەوە.",
    deleteAddress: "ناونیشانەکە بسڕەوە",
    glass: "شووشە",
    glassNote: "شووشەی زیندوو تەنها لەسەر شریتە جێگیرەکان کە ناوەڕۆک بە ژێریاندا تێدەپەڕێت — لە هەر شاشەیەکدا دووان بە زۆری. شووشەی جێگیر تەنها لەسەر ڕووکاری لووس. لە ناو سندووقەکەدا بخولێنەوە.",
    filters: "فلتەرەکان",
    results: "24 کاڵا",
    added: "خرایە ناو سەبەتە",
    back: "گەڕانەوە",
    cart: "سەبەتە",
    table: "خشتەی داتا (بەڕێوەبردن)",
    tableNote: "کاغەزی تەخت، هێڵی باریک، سەرێکی جێگیری پڕ. ژمارەکان پانی جێگیرن لە کۆتایی دێڕ؛ نەرێنی بە نیشانەی کەم و ڕەنگی سووری مەرەکەبی.",
    colOrder: "داواکاری",
    colStatus: "دۆخ",
    colAmount: "بڕ (د.ع)",
    refund: "گەڕاندنەوەی پارە",
  },
});

const fill = (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (match, key: string) => vars[key] ?? match);

export default function CoreSection() {
  const c = useCopy(COPY);
  return (
    <>
      <Surfaces c={c} />
      <TypeRoles c={c} />
      <Keys c={c} />
      <IconKeys c={c} />
      <Banks c={c} />
      <Chips c={c} />
      <Tags c={c} />
      <Fields c={c} />
      <Steppers c={c} />
      <Prices c={c} />
      <Niches c={c} />
      <Sockets c={c} />
      <Stages c={c} />
      <PlatformLights c={c} />
      <Links c={c} />
      <GlassPanes c={c} />
      <DataTable c={c} />
    </>
  );
}

type C = (typeof COPY)["ar"];

/** The four platform keys: LED, pictogram and the platform name (ui:platform.*). */
function usePlatformItems() {
  const t = useT("ui");
  return PLATFORMS.map((p) => ({ value: p, gel: p, label: t(`platform.${p}`) }));
}

function Surfaces({ c }: { c: C }) {
  const swatches: [string, string, string][] = [
    ["--ground", "var(--ground)", "var(--ink)"],
    ["--niche", "var(--niche)", "var(--ink)"],
    ["--stage", "var(--stage)", "var(--ink)"],
    ["--well", "var(--well)", "var(--ink)"],
    ["--paper", "var(--paper)", "var(--ink)"],
    ["--ink", "var(--ink)", "var(--ground)"],
  ];
  return (
    <DsBlock id="core-surfaces" title={c.surfaces} note={c.surfacesNote}>
      <SpecimenGrid className="ds-grid--swatches">
        {swatches.map(([name, background, color]) => (
          <Specimen key={name} label={name}>
            <div className="ds-swatch" style={{ background, color }} />
          </Specimen>
        ))}
      </SpecimenGrid>
      <SpecimenGrid>
        <Specimen label="ink · ink-2 · ink-3">
          <p className="type-strong">{c.labelSample}</p>
          <p className="type-caption text-ink-2">{c.captionSample}</p>
          <p className="type-caption text-ink-3">{c.draft}</p>
        </Specimen>
        <Specimen label="ok · warn · info · red-ink">
          <SpecimenRow>
            <Status tone="ok">{c.paid}</Status>
            <Status tone="warn">{c.pending}</Status>
            <Status tone="info">{c.shipped}</Status>
            <Status tone="bad">{c.rejected}</Status>
          </SpecimenRow>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function TypeRoles({ c }: { c: C }) {
  const rows: [string, ReactNode][] = [
    ["type-hero", <>{c.heroSample} <bdi>PS5 Pro</bdi></>],
    ["type-title", <bdi>Lenovo Legion Go</bdi>],
    ["type-section", c.sectionSample],
    ["type-sub", c.subSample],
    ["type-button", c.add],
    ["type-body", c.bodySample],
    ["type-strong", <><bdi>Xbox Series X</bdi> {c.strongSample}</>],
    ["type-label", c.labelSample],
    ["type-caption", c.captionSample],
    ["type-data", <bdi>TT-7K4M2Q9X · 1,239,000</bdi>],
    ["type-kpi", <bdi>1,239,000</bdi>],
  ];
  return (
    <DsBlock id="core-type" title={c.type} note={c.typeNote}>
      <div className="ds-type">
        {rows.map(([role, sample]) => (
          <div key={role}>
            <span className={role}>{sample}</span>
            <code className="ds-spec__label" dir="ltr">
              {role}
            </code>
          </div>
        ))}
      </div>
    </DsBlock>
  );
}

function Keys({ c }: { c: C }) {
  const [held, setHeld] = useState(true);
  const [busy, setBusy] = useState(false);
  return (
    <DsBlock id="core-keys" title={c.keys} note={c.keysNote}>
      <SpecimenGrid>
        <Specimen label='variant="commit"'>
          <Key variant="commit" icon={<AddGlyph />}>
            {c.add}
          </Key>
        </Specimen>
        <Specimen label='variant="clay" (default)'>
          <Key>{c.keepShopping}</Key>
        </Specimen>
        <Specimen label='variant="ink"'>
          <Key variant="ink">{c.show24}</Key>
        </Specimen>
        <Specimen label='variant="quiet" icon="moon"'>
          <Key variant="quiet" icon="moon">
            {c.darkMode}
          </Key>
        </Specimen>
        <Specimen label="held (aria-pressed)">
          <Key held={held} onClick={() => setHeld((on) => !on)} icon="sliders-horizontal">
            {c.filters}
          </Key>
        </Specimen>
        <Specimen label="loading (press it) · loading">
          <SpecimenRow>
            <Key loading>{c.keepShopping}</Key>
            <Key variant="commit" loading={busy} onClick={() => { setBusy(true); setTimeout(() => setBusy(false), 1600); }}>
              {c.checkout}
            </Key>
          </SpecimenRow>
        </Specimen>
        <Specimen label="disabled + reason">
          <SpecimenRow>
            <Key variant="commit" disabled icon={<AddGlyph />} aria-describedby="ds-sold-out">
              {c.add}
            </Key>
            <span id="ds-sold-out" className="type-caption text-ink-2">
              {c.soldOut}
            </span>
          </SpecimenRow>
        </Specimen>
        <Specimen label='size="sm" · "md" · "lg"'>
          <SpecimenRow>
            <Key size="sm">{c.undo}</Key>
            <Key>{c.undo}</Key>
            <Key size="lg">{c.undo}</Key>
          </SpecimenRow>
        </Specimen>
        <Specimen label='as="a" href · iconEnd="arrow-right"'>
          <Key as="a" href="#core" iconEnd="arrow-right">
            {c.viewCart}
          </Key>
        </Specimen>
        <Specimen label='as={MotionLink} nav="push" to="/motion"'>
          <Key as={MotionLink} nav="push" to="/motion" size="sm" iconEnd="arrow-right">
            <bdi>/motion</bdi>
          </Key>
        </Specimen>
        <Specimen label="block" wide>
          <Key variant="commit" block icon={<AddGlyph />}>
            {c.add}
          </Key>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function IconKeys({ c }: { c: C }) {
  const [fav, setFav] = useState(false);
  return (
    <DsBlock id="core-iconkeys" title={c.iconKeys}>
      <SpecimenGrid>
        <Specimen label="IconKey (clay)">
          <SpecimenRow>
            <IconKey icon="x" label={c.close} />
            <IconKey icon="copy" label={c.copyAccount} />
            <IconKey icon="copy" label={c.copyAccount} size="sm" />
          </SpecimenRow>
        </Specimen>
        <Specimen label="held → filled + aria-pressed">
          <SpecimenRow>
            <IconKey icon="heart" label={c.fav} held={fav} onClick={() => setFav((on) => !on)} />
            <IconKey icon="heart" label={c.fav} held />
          </SpecimenRow>
        </Specimen>
        <Specimen label='variant="commit" · "ink" · "quiet" · disabled'>
          <SpecimenRow>
            <IconKey variant="commit" icon={<AddGlyph />} label={c.add} />
            <IconKey variant="ink" icon="arrow-right" label={c.checkout} />
            <IconKey variant="quiet" icon="moon" label={c.darkMode} />
            <IconKey icon="x" label={c.close} disabled />
          </SpecimenRow>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Banks({ c }: { c: C }) {
  const [platform, setPlatform] = useState<string>("playstation");
  const [view, setView] = useState("hero");
  const [layout, setLayout] = useState("grid");
  const views = ["hero", "front", "back"] as const;
  const viewLabel = { hero: c.viewHero, front: c.viewFront, back: c.viewBack };
  return (
    <DsBlock id="core-bank" title={c.bank} note={c.bankNote}>
      <SpecimenGrid wide>
        <Specimen label='kind="platform" (radiogroup, roving tabindex)'>
          <KeyBank
            label={
              <>
                <b>{c.turn}</b> {c.pick}
              </>
            }
            items={usePlatformItems()}
            value={platform}
            onChange={setPlatform}
          />
        </Specimen>
        <Specimen label='kind="thumb"'>
          <KeyBank
            kind="thumb"
            aria-label={c.gallery}
            items={views.map((v) => ({ value: v, ariaLabel: viewLabel[v], media: <Render name={`nintendo-switch-2--${views.indexOf(v) + 1}`} alt="" shadow={false} sizes="48px" /> }))}
            value={view}
            onChange={setView}
          />
        </Specimen>
        <Specimen label='kind="segment"'>
          <KeyBank
            kind="segment"
            aria-label={c.layout}
            items={[
              { value: "grid", label: c.grid, icon: "squares-four" },
              { value: "list", label: c.list, icon: "list" },
            ]}
            value={layout}
            onChange={setLayout}
          />
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Chips({ c }: { c: C }) {
  const t = useT("ui");
  const [storage, setStorage] = useState("512");
  const [days, setDays] = useState<string[]>(["today"]);
  const [filters, setFilters] = useState(["1 TB", c.excellent]);
  const toggle = (value: string) => setDays((list) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]));
  return (
    <DsBlock id="core-chips" title={c.chips} note={c.chipsNote}>
      <SpecimenGrid wide>
        <Specimen label="ChipGroup (one choice)">
          <ChipGroup
            aria-label={c.storage}
            options={[
              { value: "512", label: <bdi>512 GB</bdi> },
              { value: "1024", label: <bdi>1 TB</bdi> },
              { value: "2048", label: <bdi>2 TB</bdi>, disabled: true },
            ]}
            value={storage}
            onChange={setStorage}
          />
        </Specimen>
        <Specimen label="selected (aria-pressed, several)">
          <div className="chips">
            {(["today", "tomorrow", "morning", "evening"] as const).map((day) => (
              <Chip key={day} selected={days.includes(day)} onClick={() => toggle(day)}>
                {c[day]}
              </Chip>
            ))}
          </div>
        </Specimen>
        <Specimen label='input="checkbox" (native, form-ready)'>
          <div className="chips">
            <Chip input="checkbox" name="condition" value="new" defaultChecked>
              {t("tag.new")}
            </Chip>
            <Chip input="checkbox" name="condition" value="used">
              {t("tag.used")}
            </Chip>
          </div>
        </Specimen>
        <Specimen label="onRemove (active filters)">
          <div className="chips">
            {filters.map((label) => (
              <Chip key={label} onRemove={() => setFilters((list) => list.filter((v) => v !== label))}>
                {label}
              </Chip>
            ))}
          </div>
        </Specimen>
        <Specimen label='as="a" (link chip)'>
          <div className="chips">
            <Chip as="a" href="#core" selected>
              <bdi>PlayStation</bdi>
            </Chip>
            <Chip as="a" href="#core">
              <bdi>Xbox</bdi>
            </Chip>
          </div>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Tags({ c }: { c: C }) {
  return (
    <DsBlock id="core-tags" title={c.tags} note={c.tagsNote}>
      <SpecimenGrid>
        <Specimen label='Tag kind="new" · "used" detail'>
          <SpecimenRow>
            <Tag kind="new" />
            <Tag kind="used" detail={c.excellent} />
          </SpecimenRow>
        </Specimen>
        <Specimen label='kind="preorder" · "refurbished"'>
          <SpecimenRow>
            <Tag kind="preorder" />
            <Tag kind="refurbished" />
          </SpecimenRow>
        </Specimen>
        <Specimen label="StockStatus quantity=12 · 2 · 0">
          <div className="grid gap-1">
            <StockStatus quantity={12} detail={c.warranty} />
            <StockStatus quantity={2} />
            <StockStatus quantity={0} />
          </div>
        </Specimen>
        <Specimen label='Status tone="neutral"'>
          <Status tone="neutral">{c.draft}</Status>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Fields({ c }: { c: C }) {
  const [phone, setPhone] = useState("0770 123");
  const [pay, setPay] = useState("cod");
  return (
    <DsBlock id="core-fields" title={c.fields} note={c.fieldsNote}>
      <SpecimenGrid wide>
        <Specimen label='TextField type="tel" required hint'>
          <TextField label={c.phone} type="tel" autoComplete="tel-national" required hint={c.phoneHint} defaultValue="0770 123 4567" name="phone" />
        </Specimen>
        <Specimen label="error">
          <TextField label={c.phone} type="tel" required value={phone} onChange={(e) => setPhone(e.target.value)} error={phone.replace(/\D/g, "").length < 11 ? c.phoneError : undefined} />
        </Specimen>
        <Specimen label="optional">
          <TextField label={c.notes} optional name="notes" />
        </Specimen>
        <Specimen label='inputMode="numeric" end'>
          <TextField label={c.amount} inputMode="numeric" defaultValue="1,239,000" end={<span className="type-caption">IQD</span>} />
        </Specimen>
        <Specimen label="disabled · readOnly">
          <div className="grid gap-4">
            <TextField label={c.fullName} disabled defaultValue="" />
            <TextField label={c.orderRef} readOnly defaultValue="TT-7K4M2Q9X" ltr />
          </div>
        </Specimen>
        <Specimen label="TextArea">
          <TextArea label={c.address} required hint={c.addressHint} />
        </Specimen>
        <Specimen label="Select placeholder">
          <Select
            label={c.governorate}
            required
            placeholder="—"
            options={[
              { value: "baghdad", label: c.baghdad },
              { value: "basra", label: c.basra },
              { value: "erbil", label: c.erbil },
            ]}
          />
        </Specimen>
        <Specimen label="Checkbox · checked · indeterminate · error · disabled">
          <div className="grid">
            <Checkbox label={c.offers} />
            <Checkbox label={c.returnsRead} defaultChecked />
            <Checkbox label={c.selectAll} indeterminate />
            <Checkbox label={c.returnsRead} error={c.tickToContinue} />
            <Checkbox label={c.offers} disabled />
          </div>
        </Specimen>
        <Specimen label="FieldGroup + Radio row (option rows)">
          <FieldGroup legend={c.payment} required>
            <Radio row name="ds-pay" value="cod" label={c.cod} hint={c.codHint} checked={pay === "cod"} onChange={() => setPay("cod")} />
            <Radio row name="ds-pay" value="zain" label={c.zain} hint={c.zainHint} checked={pay === "zain"} onChange={() => setPay("zain")} />
          </FieldGroup>
        </Specimen>
        <Specimen label="Switch (role=switch)">
          <div className="grid">
            <Switch label={c.notify} defaultChecked />
            <Switch label={c.offers} />
          </div>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Steppers({ c }: { c: C }) {
  const [qty, setQty] = useState(2);
  return (
    <DsBlock id="core-stepper" title={c.stepper} note={c.stepperNote}>
      <SpecimenGrid>
        <Specimen label='max={3} maxReason="stock"'>
          <Stepper value={qty} onChange={setQty} max={3} maxReason="stock" />
        </Specimen>
        <Specimen label="at min (minus flat)">
          <Stepper defaultValue={1} max={9} />
        </Specimen>
        <Specimen label='size="sm"'>
          <Stepper size="sm" defaultValue={4} max={9} />
        </Specimen>
        <Specimen label="disabled">
          <Stepper defaultValue={1} disabled />
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Prices({ c }: { c: C }) {
  const [before, after = ""] = fill(c.deliveryLine, { price: "\u0000" }).split("\u0000");
  return (
    <DsBlock id="core-price" title={c.price} note={c.priceNote}>
      <SpecimenGrid>
        <Specimen label='size="xl" (rateDetails)'>
          <Price amountIqd={899000} size="xl" />
        </Specimen>
        <Specimen label='size="lg"'>
          <Price amountIqd={1099000} size="lg" />
        </Specimen>
        <Specimen label='size="md" compareAtIqd'>
          <Price amountIqd={749000} compareAtIqd={819000} />
        </Specimen>
        <Specimen label='size="sm" as="span" approx="off"'>
          <p className="type-caption text-ink-2">
            {before}
            <Price amountIqd={5000} size="sm" as="span" approx="off" />
            {after}
          </p>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Niches({ c }: { c: C }) {
  return (
    <DsBlock id="core-niche" title={c.niche} note={c.nicheNote}>
      <SpecimenGrid>
        <Specimen label='ratio="3/2" tag'>
          <Niche as="a" href="#core" aria-label={DEMO.nintendo.name} tag={<Tag kind="new" />}>
            <Render name="nintendo-switch-2--1" alt="" sizes="(min-width: 768px) 240px, 45vw" />
          </Niche>
        </Specimen>
        <Specimen label='tag kind="used"'>
          <Niche tag={<Tag kind="used" />}>
            <Render name="xbox-series-x--1" alt={DEMO.xbox.name} sizes="(min-width: 768px) 240px, 45vw" />
          </Niche>
        </Specimen>
        <Specimen label='ratio="1/1" tagZone={false}'>
          <Niche ratio="1/1" tagZone={false}>
            <Render name="dualsense--1" alt="" sizes="(min-width: 768px) 200px, 30vw" />
          </Niche>
        </Specimen>
        <Specimen label='variant="panel" + Socket inset' wide>
          <Niche variant="panel" className="flex items-center gap-3 p-3">
            <Socket state="empty" inset />
            <p className="grid min-w-0 flex-1">
              <b className="type-strong">{c.emptyTitle}</b>
              <span className="type-caption text-ink-2">{c.emptyText}</span>
            </p>
            <Key size="sm" as="a" href="#core">
              {c.browse}
            </Key>
          </Niche>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Sockets({ c }: { c: C }) {
  const [added, flash] = useAddedFlash();
  return (
    <DsBlock id="core-socket" title={c.socket} note={c.socketNote}>
      <SpecimenGrid>
        <Specimen label='state="ready" (press it)'>
          <SpecimenRow>
            <Price amountIqd={DEMO.nintendo.priceIqd} />
            <Socket name={DEMO.nintendo.name} state={added ? "added" : "ready"} onAdd={flash} />
          </SpecimenRow>
        </Specimen>
        <Specimen label='state="added"'>
          <Socket name={DEMO.xbox.name} state="added" />
        </Specimen>
        <Specimen label='state="empty"'>
          <SpecimenRow>
            <Socket state="empty" />
            <StockStatus quantity={0} />
          </SpecimenRow>
        </Specimen>
        <Specimen label="loading">
          <Socket name={DEMO.handheld.name} loading />
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Stages({ c }: { c: C }) {
  const platformItems = usePlatformItems();
  const [platform, setPlatform] = useState<Platform>("nintendo");
  const [view, setView] = useState<"hero" | "front" | "back">("hero");
  const [added, flash] = useAddedFlash();
  const demo = DEMO[platform];
  const views = ["hero", "front", "back"] as const;
  const viewLabel = { hero: c.viewHero, front: c.viewFront, back: c.viewBack };
  return (
    <DsBlock id="core-stage" title={c.stage} note={c.stageNote}>
      <div className="grid max-w-[46rem] gap-1">
        <Specimen label='<Stage size="hero" gel tag action> + KeyBank'>
          <Stage
            size="hero"
            gel={platform}
            tag={<StageTag name={demo.name} priceIqd={demo.priceIqd} />}
            action={
              <Key variant="commit" icon={added ? <Icon name="check" size={20} /> : <AddGlyph />} onClick={flash}>
                {added ? c.added : c.add}
              </Key>
            }
          >
            <Render name={demo.art} alt={demo.name} sizes="(min-width: 1200px) 520px, (min-width: 768px) 60vw, 70vw" />
          </Stage>
          <KeyBank
            label={
              <>
                <b>{c.turn}</b> {c.pick}
              </>
            }
            items={platformItems}
            value={platform}
            onChange={(value) => setPlatform(value as Platform)}
          />
        </Specimen>
      </div>
      <div className="ds-stage-grid">
        <Specimen label='<Stage size="product" top bottom>' wide className="max-w-[46rem]">
          <Stage
            size="product"
            gel="nintendo"
            top={
              <div className="flex justify-between">
                <Glass as="a" href="#core" variant="static" className="grid size-11 place-items-center rounded-full" aria-label={c.back}>
                  <Icon name="arrow-left" size={20} />
                </Glass>
                <Glass as="a" href="#core" variant="static" className="relative grid size-11 place-items-center rounded-full" aria-label={c.cart}>
                  <Icon name="shopping-bag" size={20} />
                  <b className="bead absolute -end-1.5 -top-1">2</b>
                </Glass>
              </div>
            }
            bottom={
              <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2.5 type-caption text-ink-2">
                <span>{viewLabel[view]}</span>
                <KeyBank
                  kind="thumb"
                  aria-label={c.gallery}
                  items={views.map((v) => ({ value: v, ariaLabel: viewLabel[v], media: <Render name={`nintendo-switch-2--${views.indexOf(v) + 1}`} alt="" shadow={false} sizes="48px" /> }))}
                  value={view}
                  onChange={(value) => setView(value as typeof view)}
                />
                <span className="text-end">
                  <bdi>{fill(c.count, { n: String(views.indexOf(view) + 1), total: String(views.length) })}</bdi>
                </span>
              </div>
            }
          >
            <Render name={`nintendo-switch-2--${views.indexOf(view) + 1}`} alt={`${DEMO.nintendo.name} — ${viewLabel[view]}`} sizes="(min-width: 768px) 360px, 80vw" />
          </Stage>
        </Specimen>
        <Specimen label='<Stage size="compact">'>
          <Stage size="compact" gel="playstation">
            <Render name="playstation-5-slim--1" alt={DEMO.playstation.name} sizes="160px" />
          </Stage>
          <PlatformLabel platform="playstation" />
        </Specimen>
      </div>
      <h4 className="type-label mt-4 text-ink-2">{c.lights}</h4>
      <div className="ds-stage-grid">
        {PLATFORMS.map((p) => (
          <Specimen key={p} label={`gel="${p}" · ${DEMO[p].art}`}>
            <Stage size="hero" gel={p} tag={<StageTag name={DEMO[p].name} priceIqd={DEMO[p].priceIqd} />}>
              <Render name={DEMO[p].art} alt={DEMO[p].name} sizes="(min-width: 768px) 300px, 70vw" />
            </Stage>
          </Specimen>
        ))}
      </div>
    </DsBlock>
  );
}

function PlatformLights({ c }: { c: C }) {
  return (
    <DsBlock id="core-platform" title={c.platform} note={c.platformNote}>
      <SpecimenGrid>
        <Specimen label="PlatformLabel">
          <div className="grid gap-1">
            {PLATFORMS.map((p) => (
              <PlatformLabel key={p} platform={p} />
            ))}
          </div>
        </Specimen>
        <Specimen label="PlatformLed · solid · on">
          <div className="grid gap-3">
            {PLATFORMS.map((p) => (
              <SpecimenRow key={p}>
                <PlatformLed platform={p} />
                <PlatformLed platform={p} solid />
                <PlatformLed platform={p} on />
              </SpecimenRow>
            ))}
          </div>
        </Specimen>
        <Specimen label="PlatformGlyph">
          <SpecimenRow>
            {PLATFORMS.map((p) => (
              <PlatformGlyph key={p} platform={p} />
            ))}
          </SpecimenRow>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Links({ c }: { c: C }) {
  return (
    <DsBlock id="core-links" title={c.links} note={c.linksNote}>
      <SpecimenGrid wide>
        <Specimen label='TextLink as={LocaleLink} to="/" (arrow)'>
          <TextLink as={LocaleLink} to="/">
            {c.allOf.split("{name}")[0]}
            <bdi>PlayStation</bdi>
            {c.allOf.split("{name}")[1]}
          </TextLink>
        </Specimen>
        <Specimen label="inline">
          <p>
            {c.returnsBefore}{" "}
            <TextLink href="#core" inline>
              {c.returnsLink}
            </TextLink>{" "}
            {c.returnsAfter}
          </p>
        </Specimen>
        <Specimen label="external · tone=danger">
          <SpecimenRow>
            <TextLink href="https://www.whatsapp.com/" external>
              WhatsApp
            </TextLink>
            <TextLink as="button" type="button" tone="danger" arrow={false}>
              {c.deleteAddress}
            </TextLink>
          </SpecimenRow>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function GlassPanes({ c }: { c: C }) {
  return (
    <DsBlock id="core-glass" title={c.glass} note={c.glassNote}>
      <SpecimenGrid wide>
        <Specimen label='Glass (live, sticky) · variant="solid"'>
          <div className="ds-scroll scroll-thin">
            <Glass className="ds-scroll__bar">
              <span className="type-strong">{c.filters}</span>
              <span className="type-caption text-ink-2">{c.results}</span>
              <IconKey icon="x" label={c.close} size="sm" />
            </Glass>
            <div className="grid grid-cols-2 gap-3 p-3">
              {PLATFORMS.map((p) => (
                <Niche key={p}>
                  <Render name={DEMO[p].art} alt="" sizes="160px" />
                </Niche>
              ))}
            </div>
            <Glass variant="solid" className="m-3 rounded-md p-3 type-caption">
              {c.added}
            </Glass>
          </div>
        </Specimen>
        <Specimen label='variant="static" (over the stage)'>
          <Stage size="hero" gel="xbox" tag={<StageTag name={DEMO.xbox.name} priceIqd={DEMO.xbox.priceIqd} />}>
            <Render name="xbox-series-x--1" alt="" sizes="(min-width: 768px) 300px, 70vw" />
          </Stage>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

function DataTable({ c }: { c: C }) {
  const f = useFormat();
  const rows: [string, ReactNode, number][] = [
    ["TT-7K4M2Q9X", <Status tone="ok">{c.paid}</Status>, 1239000],
    ["TT-3HD8P2LQ", <Status tone="warn">{c.pending}</Status>, 749000],
    ["TT-9QW4N7ZT", <Status tone="bad">{c.refund}</Status>, -445000],
  ];
  return (
    <DsBlock id="core-table" title={c.table} note={c.tableNote}>
      <div data-density="admin" className="scroll-thin overflow-x-auto rounded-sm">
        <table className="table">
          <thead>
            <tr>
              <th scope="col">{c.colOrder}</th>
              <th scope="col">{c.colStatus}</th>
              <th scope="col" className="is-num">
                {c.colAmount}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([ref, status, amount], index) => (
              <tr key={ref} aria-selected={index === 1 ? true : undefined}>
                <td>
                  <bdi>{ref}</bdi>
                </td>
                <td>{status}</td>
                <td className={amount < 0 ? "is-num is-negative" : "is-num"}>
                  <bdi>{f.number(amount)}</bdi>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DsBlock>
  );
}
