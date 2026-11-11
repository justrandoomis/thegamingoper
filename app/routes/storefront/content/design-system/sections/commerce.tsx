// lint-design: allow commit-count — specimens of the add key in every state (cards, the buy bar), not a shopping view.
import { useState, type ReactNode } from "react";

import { useT } from "~/i18n/react";
import type { CartLine, ImageRef, ProductCardData, Shelf, UsedUnitCardData } from "~/lib/dto";
import { AddToCartKey, BuyBar } from "~/ui/AddToCartKey";
import { CartLineRow } from "~/ui/CartLineRow";
import { CompatBadge } from "~/ui/CompatBadge";
import { DemoNote } from "~/ui/DemoNote";
import { Gallery } from "~/ui/Gallery";
import { GradeBadge } from "~/ui/GradeBadge";
import { InspectionCard } from "~/ui/InspectionCard";
import { OrderSummary } from "~/ui/OrderSummary";
import { PlatformBank } from "~/ui/PlatformBank";
import type { Platform } from "~/ui/PlatformLed";
import { PriceTag } from "~/ui/PriceTag";
import { ProductCard, ProductCardPlaceholder } from "~/ui/ProductCard";
import { ProofUploader, type ProofUploadControls, type ProofUploadResult } from "~/ui/ProofUploader";
import { RatingStars } from "~/ui/RatingStars";
import { ShelfRail } from "~/ui/ShelfRail";
import { StockNote } from "~/ui/StockNote";
import { Toaster } from "~/ui/Toast";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { WalletBalance, type WalletEntry } from "~/ui/WalletBalance";
import { WishlistKey } from "~/ui/WishlistKey";
import { DsBlock, defineCopy, Specimen, SpecimenGrid, SpecimenRow, useCopy, type DsSectionMeta } from "../kit";

export const section: DsSectionMeta = {
  id: "commerce",
  order: 20,
  title: { ar: "التسوّق", en: "Commerce", ckb: "بازاڕکردن" },
  owner: "app/ui — ProductCard, AddToCartKey, Gallery, CartLineRow, OrderSummary, ProofUploader, WalletBalance, InspectionCard … · docs/ui/commerce.md",
};

const COPY = defineCopy({
  ar: {
    sample: "عيّنة للعرض: الأسماء حقيقية، والأسعار والمخزون من بيانات المتجر التجريبية. الإضافة إلى السلة تعمل فعلاً على سلة هذا المتصفح في المتجر التجريبي، والمفضلة تفشل بصدق لأن خدمتها لم تُبنَ بعد.",
    cards: "بطاقة المنتج",
    cardsNote: "بطاقة واحدة لكل المنتجات: كوّة مسطّحة بلا إطار، اسم بسطرين، سطر حقائق، السعر في البداية، والمفتاح الأحمر في مقبسه في النهاية. الصور المفرّغة تطفو؛ الصور غير المفرّغة وأغلفة الألعاب تجلس في إطارها.",
    default: "عادي",
    deal: "تخفيض حقيقي",
    lowStock: "كمية محدودة",
    soldOut: "نفد",
    options: "يحتاج اختياراً",
    longName: "اسم طويل بلغتين",
    opaque: "صورة غير مفرّغة",
    boxArt: "غلاف لعبة",
    loading: "قيد التحميل",
    used: "جهاز مستعمل",
    failing: "إضافة تفشل",
    failingNote: "معرّف غير موجود: يتراجع العدّاد ويعود الحبّة، وتظهر جملة الخطأ و«أعد المحاولة».",
    rtl: "من اليمين",
    ltr: "من اليسار",
    nameSwitch: "Nintendo Switch 2",
    subSwitch: "256GB · ضمان سنة",
    subPro: "2TB · بدون قارئ أقراص",
    subOled: "أبيض · ضمان سنة",
    subLite: "تركوازي",
    subDeck: "512GB أو 1TB",
    subMkw: "لعبة Nintendo Switch 2",
    namePulse: "سماعة PlayStation Pulse Elite اللاسلكية مع قاعدة الشحن",
    subPulse: "لاسلكية · PS5 و PS Portal",
    nameUsed: "Nintendo Switch OLED مستعمل",
    subUsed: "أبيض · 64GB",
    add: "مفتاح الإضافة إلى السلة",
    addNote: "متفائل ولا يعطّل شيئاً: العدّاد يتغير فوراً، والحبّة تطير، والطلب يخرج خلال 250 جزءاً من الثانية مع أي نقرات أخرى. بعد التأكيد علامة صح لثانية وربع ورسالة منبثقة فيها «تراجع».",
    socket: "في المقبس",
    keyVariant: "مفتاح بنص",
    buyBar: "شريط الشراء",
    buyBarNote: "زجاج مثبّت في أسفل صفحة المنتج على الهاتف: العدّاد في البداية والمفتاح الأحمر بعرض كامل في النهاية.",
    specs: "المواصفات",
    display: "الشاشة",
    displayValue: "7.9 بوصة · 120Hz",
    storage: "التخزين",
    battery: "البطارية",
    wishlist: "المفضلة",
    shelf: "الرفّ",
    shelfTitle: "وصل حديثاً",
    shelfReason: "اقتراحات المتجر — عيّنة للعرض",
    bank: "بنك المنصّات",
    bankNote: "أربعة مفاتيح بأيقونة جهاز محايدة وضوء صغير واسم المنصة نصاً. لا شعارات ولا أسطح ملوّنة.",
    onboarding: "اختيار عدة منصّات (البداية)",
    gallery: "معرض الصور",
    galleryNote: "مسرح مضاء بلون المنصة، ومفاتيح مصغّرة في مجرى، والتعليق والعدّ. اسحب أو استخدم الأسهم، واضغط الصورة لعرضها بملء الشاشة. صور الأجهزة المستعملة لا تُضاء أبداً.",
    galleryGame: "لعبة: غلاف ولقطات",
    galleryUsed: "مستعمل: صورة توضيحية فقط",
    badges: "السعر والمخزون والتوافق والتقييم والدرجة",
    badgesNote: "حبر مسطّح للمال، ونقطة مع كلمات للحالة، وأيقونة مع كلمات للتوافق. التقييم لا يظهر إلا مع مراجعات حقيقية؛ الأرقام هنا عيّنة.",
    ratingNull: "rating = null: لا شيء يُعرض",
    lines: "سطور السلة وملخص الطلب",
    linesNote: "عيّنة محلية: العدّاد والإزالة يعملان هنا دون إرسال أي شيء. في صفحة السلة يملك useCartEditor الطلبات.",
    summaryFlat: "قبل اختيار المحافظة",
    summaryCoupon: "مع رمز خصم",
    summaryPending: "تغيير قيد الإرسال",
    summaryUnserved: "محافظة لا نوصل إليها",
    summaryBroken: "أرقام لا تتطابق",
    couponLabel: "خصم 50,000 د.ع على الطلب",
    compatNote: "الصوت عبر USB فقط، دون الميكروفون.",
    white: "أبيض",
    proof: "رفع صورة الحوالة",
    proofNote: "كل الحالات. المثالان التفاعليان محاكاة داخل المتصفح: لا يُرسل أي ملف إلى أي خادم. الثاني ينقطع عند 60% في المحاولة الأولى.",
    simulated: "محاكاة تنجح",
    simulatedBreak: "محاكاة تنقطع ثم تكتمل",
    rejectedNote: "المبلغ في الصورة 745,000 د.ع ومبلغ الطلب 765,000 د.ع.",
    wallet: "المحفظة",
    walletNote: "الرصيد مجموع الحركات ولا يُكتب يدوياً أبداً. الضيف يرى جملة ورابط دخول.",
    walletPay: "عند الدفع: يكفي",
    walletShort: "عند الدفع: لا يكفي",
    guest: "ضيف",
    inspection: "تقرير فحص الجهاز المستعمل",
    checkScreen: "الشاشة واللمس",
    checkSticks: "الأزرار وعصا التحكم",
    checkSticksNote: "انحراف بسيط في العصا اليسرى، لا يؤثر في اللعب.",
    checkPorts: "المنافذ والقاعدة",
    checkCharging: "الشحن",
    checkWifi: "Wi-Fi و Bluetooth",
    defect1: "خدش خفيف على الحافة العلوية للشاشة.",
    defect2: "أثر استعمال على ذراع Joy-Con اليمنى.",
    included1: "القاعدة وكابل HDMI",
    included2: "ذراعا Joy-Con مع الحامل",
    included3: "الشاحن الأصلي",
  },
  en: {
    sample: "Sample data: the names are real; prices and stock come from the demo store. Adding to the cart really works on this browser's demo cart; favourites fail honestly because their service is not built yet.",
    cards: "Product card",
    cardsNote: "One card for every product: a flat niche with no chrome, a two-line name, a fact line, the price at the start and the red key in its socket at the end. Cut-out photos float; opaque photos and box art sit in their own frame.",
    default: "Default",
    deal: "Genuine reduction",
    lowStock: "Limited stock",
    soldOut: "Sold out",
    options: "Needs a choice",
    longName: "Long mixed-script name",
    opaque: "Opaque photo",
    boxArt: "Game box art",
    loading: "Loading",
    used: "Used device",
    failing: "An add that fails",
    failingNote: "An unknown id: the count rolls back, the bead returns, the sentence and “Try again” appear.",
    rtl: "Right to left",
    ltr: "Left to right",
    nameSwitch: "Nintendo Switch 2",
    subSwitch: "256GB · 1-year warranty",
    subPro: "2TB · no disc drive",
    subOled: "White · 1-year warranty",
    subLite: "Turquoise",
    subDeck: "512GB or 1TB",
    subMkw: "Nintendo Switch 2 game",
    namePulse: "PlayStation Pulse Elite wireless headset with charging stand",
    subPulse: "Wireless · PS5 and PS Portal",
    nameUsed: "Used Nintendo Switch OLED",
    subUsed: "White · 64GB",
    add: "Add-to-cart key",
    addNote: "Optimistic and never blocking: the count changes at once, the bead flies, and the request leaves within 250 ms together with any other taps. Once confirmed: a check for 1.2 s and a toast with “Undo”.",
    socket: "In its socket",
    keyVariant: "Labelled key",
    buyBar: "Buy bar",
    buyBarNote: "Glass pinned to the bottom of the product page on phones: the stepper at the start, the full-width red key at the end.",
    specs: "Specifications",
    display: "Display",
    displayValue: "7.9 inch · 120Hz",
    storage: "Storage",
    battery: "Battery",
    wishlist: "Favourite",
    shelf: "Shelf",
    shelfTitle: "New arrivals",
    shelfReason: "Store picks — sample",
    bank: "Platform bank",
    bankNote: "Four keys with a neutral device pictogram, a small LED and the platform's name as text. No logos, no coloured surfaces.",
    onboarding: "Several platforms (onboarding)",
    gallery: "Gallery",
    galleryNote: "A stage lit in the platform's colour, thumbnail keys in a well, the caption and the count. Swipe or use the arrows; tap the picture for full screen. Used-device photos are never lit.",
    galleryGame: "A game: box art and screenshots",
    galleryUsed: "Used: an illustration only",
    badges: "Price, stock, compatibility, rating, grade",
    badgesNote: "Flat ink for money, a dot and words for state, an icon and words for compatibility. A rating appears only with real reviews; the numbers here are a sample.",
    ratingNull: "rating = null: nothing is drawn",
    lines: "Cart lines and order summary",
    linesNote: "Local sample: the stepper and removal work here without sending anything. On the cart page useCartEditor owns the requests.",
    summaryFlat: "Before a governorate is chosen",
    summaryCoupon: "With a discount code",
    summaryPending: "A change in flight",
    summaryUnserved: "A governorate we do not serve",
    summaryBroken: "Figures that do not reconcile",
    couponLabel: "50,000 IQD off the order",
    compatNote: "Sound over USB only, without the microphone.",
    white: "White",
    proof: "Transfer proof upload",
    proofNote: "Every state. The two interactive ones are simulations inside the browser: no file is sent to any server. The second stops at 60% on its first attempt.",
    simulated: "Simulation that succeeds",
    simulatedBreak: "Simulation that breaks, then finishes",
    rejectedNote: "The photo shows 745,000 IQD; the order is 765,000 IQD.",
    wallet: "Wallet",
    walletNote: "The balance is the sum of the entries and is never typed in. A guest sees one sentence and a sign-in link.",
    walletPay: "At payment: enough",
    walletShort: "At payment: not enough",
    guest: "Guest",
    inspection: "Used-device inspection report",
    checkScreen: "Screen and touch",
    checkSticks: "Buttons and sticks",
    checkSticksNote: "Slight drift on the left stick; it does not affect play.",
    checkPorts: "Ports and dock",
    checkCharging: "Charging",
    checkWifi: "Wi-Fi and Bluetooth",
    defect1: "A light scratch on the top edge of the screen.",
    defect2: "Signs of use on the right Joy-Con.",
    included1: "Dock and HDMI cable",
    included2: "Both Joy-Con with the grip",
    included3: "The original charger",
  },
  ckb: {
    sample: "داتای نموونە: ناوەکان ڕاستەقینەن؛ نرخ و کۆگا لە فرۆشگای تاقیکارییەوەن. خستنە ناو سەبەتە بەڕاستی کار دەکات لەسەر سەبەتەی ئەم وێبگەڕە لە فرۆشگای تاقیکاری؛ دڵخوازەکان بە ڕاستگۆیی سەرناکەون چونکە خزمەتگوزارییەکەیان هێشتا دروست نەکراوە.",
    cards: "کارتی کاڵا",
    cardsNote: "یەک کارت بۆ هەموو کاڵاکان: کووەیەکی تەخت بێ چوارچێوە، ناوێکی دوو دێڕی، دێڕێکی زانیاری، نرخ لە سەرەتا و کلیلە سوورەکە لە سۆکێتەکەیدا لە کۆتایی. وێنە بڕدراوەکان دەفڕن؛ وێنە ناڕوونەکان و بەرگی یارییەکان لە چوارچێوەی خۆیاندا دادەنیشن.",
    default: "ئاسایی",
    deal: "داشکاندنی ڕاستەقینە",
    lowStock: "بڕی سنووردار",
    soldOut: "نەماوە",
    options: "پێویستی بە هەڵبژاردنە",
    longName: "ناوی درێژی دوو زمان",
    opaque: "وێنەی نەبڕدراو",
    boxArt: "بەرگی یاری",
    loading: "بارکردن",
    used: "ئامێری بەکارهاتوو",
    failing: "زیادکردنێک کە سەرناکەوێت",
    failingNote: "ناسێنەرێکی نەناسراو: ژمێرەرەکە دەگەڕێتەوە، دەنکەکە دەگەڕێتەوە، ڕستەکە و «دووبارە هەوڵ بدەوە» دەردەکەون.",
    rtl: "لە ڕاستەوە",
    ltr: "لە چەپەوە",
    nameSwitch: "Nintendo Switch 2",
    subSwitch: "256GB · گەرەنتی ساڵێک",
    subPro: "2TB · بێ خوێنەری دیسک",
    subOled: "سپی · گەرەنتی ساڵێک",
    subLite: "فیرۆزەیی",
    subDeck: "512GB یان 1TB",
    subMkw: "یاریی Nintendo Switch 2",
    namePulse: "بیستۆکی بێتەلی PlayStation Pulse Elite لەگەڵ وێستگەی شەحن",
    subPulse: "بێتەل · PS5 و PS Portal",
    nameUsed: "Nintendo Switch OLEDی بەکارهاتوو",
    subUsed: "سپی · 64GB",
    add: "کلیلی خستنە ناو سەبەتە",
    addNote: "گەشبینە و هیچ ڕاناگرێت: ژمێرەرەکە دەستبەجێ دەگۆڕێت، دەنکەکە دەفڕێت، و داواکارییەکە لە ماوەی 250 میلیچرکەدا لەگەڵ هەر کرتەیەکی تر دەڕوات. دوای پشتڕاستکردنەوە: نیشانەی ڕاست بۆ 1.2 چرکە و پەیامێک لەگەڵ «پاشگەزبوونەوە».",
    socket: "لە سۆکێتەکەدا",
    keyVariant: "کلیلی نووسراو",
    buyBar: "شریتی کڕین",
    buyBarNote: "شووشەیەکی جێگیر لە خوارەوەی پەڕەی کاڵا لەسەر مۆبایل: ژمێرەرەکە لە سەرەتا، کلیلە سوورەکە بە پانیی تەواو لە کۆتایی.",
    specs: "تایبەتمەندییەکان",
    display: "شاشە",
    displayValue: "7.9 ئینچ · 120Hz",
    storage: "بیرگە",
    battery: "پاتری",
    wishlist: "دڵخواز",
    shelf: "ڕەف",
    shelfTitle: "تازە گەیشتووەکان",
    shelfReason: "پێشنیاری فرۆشگا — نموونە",
    bank: "بانکی پلاتفۆرمەکان",
    bankNote: "چوار کلیل بە وێنۆچکەی ئامێرێکی بێلایەن و ڕووناکییەکی بچووک و ناوی پلاتفۆرم بە نووسین. بێ لۆگۆ و بێ ڕووی ڕەنگاوڕەنگ.",
    onboarding: "چەند پلاتفۆرمێک (سەرەتا)",
    gallery: "پیشانگای وێنە",
    galleryNote: "شانۆیەکی ڕووناک بە ڕەنگی پلاتفۆرم، کلیلی وێنۆچکە لە جۆگەیەکدا، ڕوونکردنەوە و ژماردن. ڕایبکێشە یان تیرەکان بەکاربهێنە؛ وێنەکە دابگرە بۆ پڕی شاشە. وێنەی ئامێری بەکارهاتوو هەرگیز ڕووناک ناکرێت.",
    galleryGame: "یارییەک: بەرگ و وێنەی شاشە",
    galleryUsed: "بەکارهاتوو: تەنها وێنەی ڕوونکردنەوە",
    badges: "نرخ، کۆگا، گونجاندن، هەڵسەنگاندن، پلە",
    badgesNote: "مەرەکەبی تەخت بۆ پارە، خاڵ و وشە بۆ دۆخ، وێنۆچکە و وشە بۆ گونجاندن. هەڵسەنگاندن تەنها لەگەڵ پێداچوونەوەی ڕاستەقینە دەردەکەوێت؛ ژمارەکان لێرە نموونەن.",
    ratingNull: "rating = null: هیچ پیشان نادرێت",
    lines: "دێڕەکانی سەبەتە و پوختەی داواکاری",
    linesNote: "نموونەی ناوخۆیی: ژمێرەر و لابردن لێرە کار دەکەن بێ ناردنی هیچ شتێک. لە پەڕەی سەبەتەدا useCartEditor خاوەنی داواکارییەکانە.",
    summaryFlat: "پێش هەڵبژاردنی پارێزگا",
    summaryCoupon: "لەگەڵ کۆدی داشکاندن",
    summaryPending: "گۆڕانکارییەک لە ڕێگادایە",
    summaryUnserved: "پارێزگایەک کە نایگەیەنین",
    summaryBroken: "ژمارەگەلێک کە یەک ناگرنەوە",
    couponLabel: "50,000 د.ع داشکاندن لە داواکارییەکە",
    compatNote: "دەنگ تەنها لە ڕێگەی USB، بێ مایکرۆفۆن.",
    white: "سپی",
    proof: "بارکردنی وێنەی حەواڵە",
    proofNote: "هەموو دۆخەکان. دووە کارلێکەرەکە لاساییکردنەوەن لەناو وێبگەڕدا: هیچ فایلێک بۆ هیچ ڕاژەکارێک نانێردرێت. دووەمیان لە یەکەم هەوڵدا لە 60% دەوەستێت.",
    simulated: "لاساییکردنەوەیەک کە سەردەکەوێت",
    simulatedBreak: "لاساییکردنەوەیەک کە دەپچڕێت و پاشان تەواو دەبێت",
    rejectedNote: "وێنەکە 745,000 د.ع پیشان دەدات؛ داواکارییەکە 765,000 د.ع ـە.",
    wallet: "جزدان",
    walletNote: "باڵانس کۆی جووڵەکانە و هەرگیز بە دەست نانووسرێت. میوان ڕستەیەک و بەستەری چوونەژوورەوە دەبینێت.",
    walletPay: "لە کاتی پارەدان: بەسە",
    walletShort: "لە کاتی پارەدان: بەس نییە",
    guest: "میوان",
    inspection: "ڕاپۆرتی پشکنینی ئامێری بەکارهاتوو",
    checkScreen: "شاشە و دەستلێدان",
    checkSticks: "دوگمەکان و دەستەی کۆنترۆڵ",
    checkSticksNote: "لادانێکی کەم لە دەستەی چەپ، کاریگەری لەسەر یاریکردن نییە.",
    checkPorts: "دەروازەکان و بنکە",
    checkCharging: "شەحنکردن",
    checkWifi: "Wi-Fi و Bluetooth",
    defect1: "خەتێکی سووک لەسەر لێواری سەرەوەی شاشەکە.",
    defect2: "شوێنەواری بەکارهێنان لەسەر Joy-Conی ڕاست.",
    included1: "بنکە و کێبڵی HDMI",
    included2: "هەردوو Joy-Con لەگەڵ هەڵگرەکە",
    included3: "شەحنکەرە ڕەسەنەکە",
  },
});

type C = (typeof COPY)["ar"];

/* ───────────────────────────── sample data (real photo keys from app/art/photos, demo-store ids) ───────────────────────────── */

const photo = (artKey: string, alt = "", isIllustration = false): ImageRef => ({ artKey, mediaKey: null, alt, isIllustration });

function sampleCards(c: C): Record<string, ProductCardData> {
  const base = { kind: "console" as const, platformSlug: "nintendo", platformName: "Nintendo", hasVariants: false, compareAtIqd: null, stock: "in_stock" as const, badge: null, rating: null, isDemo: true };
  return {
    switch2: { ...base, id: "prd_nintendo-switch-2", slug: "nintendo-switch-2", name: c.nameSwitch, subtitle: c.subSwitch, variantId: "var_nsw2-con-256", priceIqd: 675_000, badge: "new", image: photo("nintendo-switch-2--1") },
    pro: { ...base, id: "prd_playstation-5-pro", slug: "playstation-5-pro", name: "PlayStation 5 Pro", subtitle: c.subPro, platformSlug: "playstation", platformName: "PlayStation", variantId: "var_ps5-pro-2tb", priceIqd: 1_095_000, stock: "low_stock", badge: "new", image: photo("playstation-5-pro--1") },
    oled: { ...base, id: "prd_nintendo-switch-oled", slug: "nintendo-switch-oled", name: "Nintendo Switch OLED", subtitle: c.subOled, variantId: "var_nsw-oled-wht", priceIqd: 435_000, compareAtIqd: 455_000, badge: "deal", image: photo("nintendo-switch-oled--1") },
    lite: { ...base, id: "prd_nintendo-switch-lite", slug: "nintendo-switch-lite", name: "Nintendo Switch Lite", subtitle: c.subLite, variantId: "var_nsw-lite-trq", priceIqd: 285_000, stock: "out_of_stock", image: photo("nintendo-switch-lite--1") },
    deck: { ...base, id: "prd_steam-deck-oled", slug: "steam-deck-oled", name: "Steam Deck OLED", subtitle: c.subDeck, platformSlug: "handheld", platformName: "Handheld", variantId: "var_sdo-512", hasVariants: true, priceIqd: 790_000, image: photo("steam-deck-oled--1") },
    mkw: { ...base, id: "prd_mario-kart-world", slug: "mario-kart-world", kind: "game", name: "Mario Kart World", subtitle: c.subMkw, variantId: "var_nsw2-mkw", priceIqd: 110_000, badge: "new", image: photo("mario-kart-world--1") },
    pulse: { ...base, id: "prd_pulse-elite-wireless-headset", slug: "pulse-elite-wireless-headset", kind: "headset", name: c.namePulse, subtitle: c.subPulse, platformSlug: "playstation", platformName: "PlayStation", variantId: "var_pulse-elite-wht", priceIqd: 220_000, compareAtIqd: 240_000, image: photo("pulse-elite--1") },
    failing: { ...base, id: "prd_design-system-missing", slug: "xbox-series-s", name: "Xbox Series S", subtitle: "512GB", platformSlug: "xbox", platformName: "Xbox", variantId: "var_design-system-missing", priceIqd: 485_000, image: photo("xbox-series-s--1") },
  };
}

function sampleUsed(c: C): UsedUnitCardData {
  return {
    id: "usd_used-switch-oled-white-01",
    slug: "used-switch-oled-white-01",
    name: c.nameUsed,
    subtitle: c.subUsed,
    platformSlug: "nintendo",
    grade: "A",
    batteryHealthPct: 91,
    priceIqd: 320_000,
    warrantyDays: 90,
    // The demo seed has no photo of this unit yet: the manufacturer's picture, flagged as an illustration.
    image: photo("nintendo-switch-oled--1", "", true),
    hasRealPhotos: false,
    isDemo: true,
  };
}

const DAY = 86_400_000;
const NOW_SAMPLE = Date.UTC(2026, 10, 10, 9); // fixed, so server and client render the same dates

function sampleLines(c: C): CartLine[] {
  const line = (over: Partial<CartLine> & Pick<CartLine, "id" | "name" | "unitPriceIqd" | "image" | "href">): CartLine => ({
    kind: "variant",
    variantId: over.id.replace("cit_", "var_"),
    usedUnitId: null,
    optionsLabel: null,
    qty: 1,
    maxQty: 10,
    lineTotalIqd: over.unitPriceIqd * (over.qty ?? 1),
    stock: "in_stock",
    problem: null,
    ...over,
  });
  return [
    line({ id: "cit_nsw2-con-256", name: c.nameSwitch, optionsLabel: c.subSwitch, unitPriceIqd: 675_000, image: photo("nintendo-switch-2--1"), href: "/p/nintendo-switch-2" }),
    line({ id: "cit_ds-wht", name: "DualSense", optionsLabel: c.white, unitPriceIqd: 105_000, qty: 2, maxQty: 7, image: photo("dualsense--1"), href: "/p/dualsense-wireless-controller" }),
    line({ id: "cit_used", kind: "used_unit", variantId: null, usedUnitId: "usd_used-switch-oled-white-01", name: c.nameUsed, optionsLabel: "A · 91%", unitPriceIqd: 320_000, maxQty: 1, image: photo("nintendo-switch-oled--1", "", true), href: "/used/used-switch-oled-white-01" }),
    line({ id: "cit_ps5-pro-2tb", name: "PlayStation 5 Pro", unitPriceIqd: 1_095_000, qty: 1, maxQty: 1, problem: "qty_reduced", stock: "low_stock", image: photo("playstation-5-pro--1"), href: "/p/playstation-5-pro" }),
    line({ id: "cit_nsw-oled-wht", name: "Nintendo Switch OLED", unitPriceIqd: 435_000, problem: "price_changed", image: photo("nintendo-switch-oled--1"), href: "/p/nintendo-switch-oled" }),
    line({ id: "cit_dse-wht", name: "DualSense Edge", unitPriceIqd: 295_000, image: photo("dualsense-edge--1"), href: "/p/dualsense-edge-wireless-controller" }),
    line({ id: "cit_nsw-lite-trq", name: "Nintendo Switch Lite", optionsLabel: c.subLite, unitPriceIqd: 285_000, maxQty: 0, problem: "out_of_stock", stock: "out_of_stock", image: photo("nintendo-switch-lite--1"), href: "/p/nintendo-switch-lite" }),
  ];
}

const WALLET: WalletEntry[] = [
  { id: "wle_4", kind: "refund", amountIqd: 105_000, at: NOW_SAMPLE - 1 * DAY, orderRef: "TT-3H8D5R2W" },
  { id: "wle_3", kind: "purchase", amountIqd: -675_000, at: NOW_SAMPLE - 4 * DAY, orderRef: "TT-7K4M2Q9X" },
  { id: "wle_2", kind: "trade_in_credit", amountIqd: 250_000, at: NOW_SAMPLE - 9 * DAY, orderRef: null },
  { id: "wle_1", kind: "topup", amountIqd: 500_000, at: NOW_SAMPLE - 12 * DAY, orderRef: null },
];
const WALLET_BALANCE = WALLET.reduce((sum, entry) => sum + entry.amountIqd, 0);

/** A browser-only stand-in for an upload endpoint: progress in steps, nothing leaves the page. */
function simulatedUpload(breakFirstAt: number | null) {
  let attempts = 0;
  return (_file: File, { signal, onProgress }: ProofUploadControls) =>
    new Promise<ProofUploadResult>((resolve) => {
      attempts++;
      const breakAt = attempts === 1 ? breakFirstAt : null;
      let progress = 0;
      const timer = setInterval(() => {
        if (signal.aborted) {
          clearInterval(timer);
          resolve({ ok: false, code: "aborted" });
          return;
        }
        progress = Math.min(1, progress + 0.07);
        onProgress(progress);
        if (breakAt !== null && progress >= breakAt) {
          clearInterval(timer);
          resolve({ ok: false, code: "network" });
        } else if (progress >= 1) {
          clearInterval(timer);
          resolve({ ok: true, previewUrl: null });
        }
      }, 140);
    });
}

/* ───────────────────────────── the section ───────────────────────────── */

export default function Commerce() {
  const c = useCopy(COPY);
  const cards = sampleCards(c);
  return (
    <>
      {/* Shows the toasts only when the layout has no toaster of its own. */}
      <Toaster fallback />
      <p className="ds-note max-w-[52ch]">{c.sample}</p>
      <Cards c={c} cards={cards} />
      <AddKeys c={c} cards={cards} />
      <ShelfBlock c={c} cards={cards} />
      <BankBlock c={c} />
      <GalleryBlock c={c} />
      <Badges c={c} />
      <Lines c={c} />
      <Proof c={c} />
      <Wallet c={c} />
      <Inspection c={c} />
    </>
  );
}

/** A specimen with a human caption (and the API in code beside it). */
function Spec({ title, code, wide = false, className, children }: { title?: ReactNode; code?: string; wide?: boolean; className?: string; children: ReactNode }) {
  return (
    <figure className={["ds-spec", wide ? "ds-spec--wide" : "", className ?? ""].join(" ")}>
      <div className="ds-spec__body">{children}</div>
      {title || code ? (
        <figcaption className="ds-spec__label">
          {title}
          {title && code ? " · " : null}
          {code ? <code dir="ltr">{code}</code> : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

const CARD_GRID = "grid grid-cols-2 items-start gap-x-3 gap-y-8 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6";

function Cards({ c, cards }: { c: C; cards: Record<string, ProductCardData> }) {
  const used = sampleUsed(c);
  return (
    <DsBlock id="commerce-cards" title={c.cards} note={c.cardsNote}>
      <div className={CARD_GRID}>
        <Spec title={c.default} code="<ProductCard card />">
          <ProductCard card={cards.switch2} slot="ds" />
        </Spec>
        <Spec title={c.deal} code="compareAtIqd">
          <ProductCard card={cards.oled} slot="ds" />
        </Spec>
        <Spec title={c.lowStock} code='stock="low_stock"'>
          <ProductCard card={cards.pro} slot="ds" />
        </Spec>
        <Spec title={`${c.soldOut} · ${c.opaque}`} code='stock="out_of_stock"'>
          <ProductCard card={cards.lite} slot="ds" />
        </Spec>
        <Spec title={c.options} code="hasVariants">
          <ProductCard card={cards.deck} slot="ds" />
        </Spec>
        <Spec title={c.boxArt} code="kind: box-art">
          <ProductCard card={cards.mkw} slot="ds" />
        </Spec>
        <Spec title={c.longName}>
          <ProductCard card={cards.pulse} slot="ds" />
        </Spec>
        <Spec title={c.used} code="<UsedUnitCard unit />">
          <UsedUnitCard unit={used} slot="ds" />
        </Spec>
        <Spec title={c.loading} code="<ProductCardPlaceholder />">
          <ProductCardPlaceholder />
        </Spec>
        <Spec title={c.failing}>
          <ProductCard card={cards.failing} slot="ds" />
          <p className="mt-2 type-caption text-ink-2">{c.failingNote}</p>
        </Spec>
        <Spec title={c.rtl} code='dir="rtl"'>
          <div dir="rtl">
            <ProductCard card={cards.pulse} slot="ds-rtl" />
          </div>
        </Spec>
        <Spec title={c.ltr} code='dir="ltr"'>
          <div dir="ltr">
            <ProductCard card={cards.pulse} slot="ds-ltr" />
          </div>
        </Spec>
      </div>
    </DsBlock>
  );
}

function AddKeys({ c, cards }: { c: C; cards: Record<string, ProductCardData> }) {
  const specs = [
    [c.display, c.displayValue],
    [c.storage, "256GB"],
    [c.battery, "5220mAh"],
  ];
  return (
    <DsBlock id="commerce-add" title={c.add} note={c.addNote}>
      <SpecimenGrid wide>
        <Spec title={c.socket} code='variant="socket"'>
          <SpecimenRow>
            <AddToCartKey item={{ variantId: cards.mkw.variantId }} name={cards.mkw.name} image={cards.mkw.image} />
            <AddToCartKey item={{ variantId: cards.deck.variantId }} name={cards.deck.name} chooseHref={`/p/${cards.deck.slug}`} />
            <AddToCartKey item={{ variantId: cards.lite.variantId }} name={cards.lite.name} stock="out_of_stock" />
            <AddToCartKey item={{ variantId: cards.failing.variantId }} name={cards.failing.name} image={cards.failing.image} />
          </SpecimenRow>
        </Spec>
        <Spec title={c.keyVariant} code='variant="key"'>
          <div className="grid gap-3">
            <SpecimenRow>
              <AddToCartKey variant="key" item={{ variantId: cards.switch2.variantId }} name={cards.switch2.name} image={cards.switch2.image} optionsLabel={cards.switch2.subtitle} />
              <AddToCartKey variant="key" item={{ variantId: cards.lite.variantId }} name={cards.lite.name} stock="out_of_stock" />
            </SpecimenRow>
            <SpecimenRow>
              <AddToCartKey variant="key" item={{ variantId: cards.deck.variantId }} name={cards.deck.name} chooseHref={`/p/${cards.deck.slug}`} />
              <span className="inline-flex flex-wrap items-center gap-2 type-caption text-ink-2">
                {c.wishlist}
                <WishlistKey productId={cards.switch2.id} name={cards.switch2.name} />
              </span>
            </SpecimenRow>
          </div>
        </Spec>
        <Spec title={c.buyBar} code="<BuyBar fixed={false} />" wide className="max-w-[30rem]">
          <p className="mb-2 type-caption text-ink-2">{c.buyBarNote}</p>
          <div className="ds-scroll">
            <div className="px-4 pt-4 pb-6">
              <p className="type-sub text-ink">{c.specs}</p>
              <dl className="grid grid-cols-[auto_1fr] gap-x-5 type-body">
                {[...specs, ...specs].map(([key, value], index) => (
                  <div key={index} className="contents">
                    <dt className="border-b border-line py-2.5 text-ink-2">{key}</dt>
                    <dd className="border-b border-line py-2.5 font-medium">
                      <bdi>{value}</bdi>
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
            <BuyBar
              fixed={false}
              item={{ variantId: cards.switch2.variantId }}
              name={cards.switch2.name}
              image={cards.switch2.image}
              optionsLabel={cards.switch2.subtitle}
              maxQty={4}
              maxReason="stock"
            />
          </div>
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function ShelfBlock({ c, cards }: { c: C; cards: Record<string, ProductCardData> }) {
  const shelf: Shelf<ProductCardData> = {
    key: "ds-new",
    title: c.shelfTitle,
    reason: c.shelfReason,
    items: [cards.switch2, cards.pro, cards.oled, cards.mkw, cards.deck, cards.pulse, cards.lite],
  };
  return (
    <DsBlock id="commerce-shelf" title={c.shelf}>
      <ShelfRail shelf={shelf} href="#commerce-shelf" headingLevel={3} />
    </DsBlock>
  );
}

function BankBlock({ c }: { c: C }) {
  const [platform, setPlatform] = useState<Platform | null>("playstation");
  const [chosen, setChosen] = useState<Platform[]>(["nintendo", "handheld"]);
  return (
    <DsBlock id="commerce-bank" title={c.bank} note={c.bankNote}>
      <SpecimenGrid wide>
        <Spec code="<PlatformBank value onChange />">
          <PlatformBank value={platform} onChange={setPlatform} />
        </Spec>
        <Spec title={c.onboarding} code="multiple values onToggle">
          <PlatformBank multiple values={chosen} onToggle={(p, on) => setChosen((list) => (on ? [...list, p] : list.filter((x) => x !== p)))} />
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function GalleryBlock({ c }: { c: C }) {
  const switchItems = [1, 2, 4, 5].map((n) => ({ image: photo(`nintendo-switch-2--${n}`, "Nintendo Switch 2") }));
  const gameItems = [1, 2, 3].map((n) => ({ image: photo(`mario-kart-world--${n}`, "Mario Kart World") }));
  const usedItems = [{ image: photo("nintendo-switch-oled--1", c.nameUsed, true) }, { image: photo("nintendo-switch-oled--3", c.nameUsed, true) }];
  return (
    <DsBlock id="commerce-gallery" title={c.gallery} note={c.galleryNote}>
      <div className="ds-stage-grid">
        <Spec code='<Gallery gel="nintendo" items />'>
          <Gallery name="Nintendo Switch 2" items={switchItems} gel="nintendo" />
        </Spec>
        <Spec title={c.galleryGame}>
          <Gallery name="Mario Kart World" items={gameItems} gel="nintendo" />
        </Spec>
        <Spec title={c.galleryUsed} code='evidence="used"'>
          <Gallery name={c.nameUsed} items={usedItems} evidence="used" />
        </Spec>
      </div>
    </DsBlock>
  );
}

function Badges({ c }: { c: C }) {
  return (
    <DsBlock id="commerce-badges" title={c.badges} note={c.badgesNote}>
      <SpecimenGrid>
        <Spec code="<PriceTag priceIqd />">
          <PriceTag priceIqd={749_000} />
        </Spec>
        <Spec code="compareAtIqd">
          <PriceTag priceIqd={435_000} compareAtIqd={455_000} />
        </Spec>
        <Spec code='size="page" deliveryIqd aside' wide>
          <PriceTag size="page" priceIqd={899_000} deliveryIqd={5_000} aside={<StockNote stock="in_stock" />} />
        </Spec>
        <Spec code="priceIqd={NaN}">
          <PriceTag priceIqd={Number.NaN} />
        </Spec>
        <Spec code="<StockNote stock />">
          <div className="grid gap-1.5">
            <StockNote stock="in_stock" />
            <StockNote stock="low_stock" />
            <StockNote stock="out_of_stock" />
            <StockNote stock="preorder" />
          </div>
        </Spec>
        <Spec code="<CompatBadge status device note />" wide>
          <div className="grid gap-2">
            <CompatBadge status="verified" device="Nintendo Switch 2" />
            <CompatBadge status="partial" device="PlayStation 5" note={c.compatNote} />
            <CompatBadge status="incompatible" device="Xbox Series S" />
            <CompatBadge status="unverified" device="Steam Deck OLED" />
          </div>
        </Spec>
        <Spec code="<RatingStars rating />">
          <div className="grid gap-2">
            <RatingStars rating={{ average: 4.6, count: 12 }} />
            <RatingStars rating={{ average: 3.5, count: 2 }} size="md" verified />
            <span className="type-caption text-ink-2">{c.ratingNull}</span>
            <RatingStars rating={null} />
          </div>
        </Spec>
        <Spec code="<GradeBadge grade legend />">
          <div className="grid justify-items-start gap-2">
            <GradeBadge grade="A+" />
            <GradeBadge grade="A" />
            <GradeBadge grade="B" legend />
            <GradeBadge grade="C" />
          </div>
        </Spec>
        <Spec code="<DemoNote /> · compact">
          <div className="grid gap-2">
            <DemoNote />
            <DemoNote compact />
          </div>
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Lines({ c }: { c: C }) {
  const [lines, setLines] = useState(() => sampleLines(c));
  const [removed, setRemoved] = useState<ReadonlySet<string>>(() => new Set(["cit_dse-wht"]));
  const [hidden, setHidden] = useState<ReadonlySet<string>>(() => new Set());
  const setQty = (id: string, qty: number) => setLines((list) => list.map((line) => (line.id === id ? { ...line, qty, lineTotalIqd: line.unitPriceIqd * qty } : line)));
  const mark = (id: string, on: boolean) =>
    setRemoved((set) => {
      const next = new Set(set);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  return (
    <DsBlock id="commerce-lines" title={c.lines} note={c.linesNote}>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <ul className="grid gap-3">
          {lines
            .filter((line) => !hidden.has(line.id))
            .map((line) => (
              <CartLineRow
                key={line.id}
                line={line}
                removed={removed.has(line.id)}
                error={line.id === "cit_ds-wht" ? "rate_limited" : null}
                onQtyChange={(qty) => setQty(line.id, qty)}
                onRemove={() => mark(line.id, true)}
                onRestore={() => mark(line.id, false)}
                onDismiss={() => setHidden((set) => new Set(set).add(line.id))}
              />
            ))}
        </ul>
        <div className="grid gap-5">
          <Spec title={c.summaryFlat}>
            <OrderSummary subtotalIqd={1_205_000} discountIqd={0} shippingIqd={5_000} totalIqd={1_210_000} count={4} headingLevel={3} />
          </Spec>
          <Spec title={c.summaryCoupon} code='shipping="governorate"'>
            <OrderSummary subtotalIqd={1_205_000} discountIqd={50_000} coupon={{ code: "SAMPLE50", label: c.couponLabel }} shippingIqd={5_000} totalIqd={1_160_000} count={4} shipping="governorate" title={null} />
          </Spec>
          <Spec title={c.summaryPending} code="pending">
            <OrderSummary subtotalIqd={675_000} discountIqd={0} shippingIqd={5_000} totalIqd={680_000} count={1} pending title={null} />
          </Spec>
          <Spec title={c.summaryUnserved} code='shipping="unserved"'>
            <OrderSummary subtotalIqd={675_000} discountIqd={0} shippingIqd={null} totalIqd={675_000} count={1} shipping="unserved" title={null} />
          </Spec>
          <Spec title={c.summaryBroken} code="totalIqd={NaN}">
            <OrderSummary subtotalIqd={675_000} discountIqd={0} shippingIqd={5_000} totalIqd={Number.NaN} count={1} title={null} />
          </Spec>
        </div>
      </div>
    </DsBlock>
  );
}

const never = () => new Promise<ProofUploadResult>(() => {});

function Proof({ c }: { c: C }) {
  const [simulate] = useState(() => simulatedUpload(null));
  const [simulateBreak] = useState(() => simulatedUpload(0.6));
  const file = { name: "transfer-receipt.jpg", size: 1_840_000, type: "image/jpeg" };
  return (
    <DsBlock id="commerce-proof" title={c.proof} note={c.proofNote}>
      <SpecimenGrid wide>
        <Spec title={c.simulated} code="onUpload">
          <ProofUploader onUpload={simulate} />
        </Spec>
        <Spec title={c.simulatedBreak}>
          <ProofUploader onUpload={simulateBreak} />
        </Spec>
        <Spec code='defaultState phase="uploading"'>
          <ProofUploader onUpload={never} defaultState={{ phase: "uploading", file, progress: 0.35 }} />
        </Spec>
        <Spec code='phase="interrupted"'>
          <ProofUploader onUpload={simulate} defaultState={{ phase: "interrupted", file, progress: 0.6 }} />
        </Spec>
        <Spec code='phase="failed" problem="type"'>
          <ProofUploader onUpload={simulate} defaultState={{ phase: "failed", file: { name: "statement.pdf", size: 240_000, type: "application/pdf" }, problem: "type", retry: false }} />
        </Spec>
        <Spec code='phase="uploaded" status="submitted"'>
          <ProofUploader onUpload={simulate} defaultState={{ phase: "uploaded", file, previewUrl: null }} status={{ state: "submitted" }} />
        </Spec>
        <Spec code='status="rejected" note'>
          <ProofUploader onUpload={simulate} status={{ state: "rejected", note: c.rejectedNote }} />
        </Spec>
        <Spec code='status="approved"'>
          <ProofUploader onUpload={simulate} status={{ state: "approved" }} current={{ fileName: file.name }} />
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Wallet({ c }: { c: C }) {
  return (
    <DsBlock id="commerce-wallet" title={c.wallet} note={c.walletNote}>
      <SpecimenGrid wide>
        <Spec code="<WalletBalance balanceIqd pendingIqd entries />">
          <WalletBalance balanceIqd={WALLET_BALANCE} pendingIqd={50_000} entries={WALLET} headingLevel={3} />
        </Spec>
        <div className="grid content-start gap-5">
          <Spec title={c.walletPay} code="compact payIqd">
            <WalletBalance balanceIqd={WALLET_BALANCE} payIqd={110_000} compact />
          </Spec>
          <Spec title={c.walletShort} code="compact payIqd">
            <WalletBalance balanceIqd={WALLET_BALANCE} payIqd={675_000} compact />
          </Spec>
          <Spec title={c.guest} code="balanceIqd={null}">
            <WalletBalance balanceIqd={null} />
          </Spec>
        </div>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Inspection({ c }: { c: C }) {
  const checks = [
    { key: "screen", label: c.checkScreen, ok: true },
    { key: "sticks", label: c.checkSticks, ok: false, note: c.checkSticksNote },
    { key: "ports", label: c.checkPorts, ok: true },
    { key: "charging", label: c.checkCharging, ok: true },
    { key: "wireless", label: c.checkWifi, ok: true },
  ];
  return (
    <DsBlock id="commerce-inspection" title={c.inspection}>
      <div className="max-w-[40rem]">
        <InspectionCard
          grade="B"
          inspectedAt={NOW_SAMPLE - 2 * DAY}
          batteryHealthPct={87}
          checklist={checks}
          defects={[{ text: c.defect1 }, { text: c.defect2 }]}
          included={[c.included1, c.included2, c.included3]}
          photos={[photo("nintendo-switch-oled--1", c.nameUsed, true)]}
          warrantyDays={90}
          returnDays={7}
          ownershipChecked
          dataWiped
          isDemo
          headingLevel={3}
        />
      </div>
    </DsBlock>
  );
}
