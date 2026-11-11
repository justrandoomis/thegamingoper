// lint-design: allow primary-count — the reference page shows every buying state side by side; it is not a shopping view.
import { useState, type ReactNode } from "react";

import type { CartLine, ImageRef, ProductCardData, Shelf, UsedUnitCardData } from "~/lib/dto";
import { AddToCartKey, BuyBar, BuyControls, CardAddButton } from "~/ui/AddToCartKey";
import { CartLineRow } from "~/ui/CartLineRow";
import { ChipGroup } from "~/ui/Chip";
import { Gallery } from "~/ui/Gallery";
import { InspectionCard } from "~/ui/InspectionCard";
import { Key } from "~/ui/Key";
import { CouponField, OrderSummary } from "~/ui/OrderSummary";
import { PLATFORMS } from "~/ui/PlatformLed";
import { ProductCard, ProductCardPlaceholder } from "~/ui/ProductCard";
import { ProofUploader, type ProofUploadControls, type ProofUploadResult } from "~/ui/ProofUploader";
import { ShelfRail } from "~/ui/ShelfRail";
import { Toaster } from "~/ui/Toast";
import { TrustStrip } from "~/ui/TrustStrip";
import { UsedUnitCard } from "~/ui/UsedUnitCard";
import { WalletBalance, type WalletEntry } from "~/ui/WalletBalance";
import { WishlistKey } from "~/ui/WishlistKey";
import { useT } from "~/i18n/react";
import { DsBlock, defineCopy, Specimen, SpecimenGrid, useCopy, type DsSectionMeta } from "../kit";

export const section: DsSectionMeta = {
  id: "commerce",
  order: 20,
  title: { ar: "التسوّق", en: "Commerce", ckb: "بازاڕکردن" },
  owner: "app/ui — ProductCard, AddToCartKey, Gallery, CartLineRow, OrderSummary, UsedUnitCard, InspectionCard, ProofUploader, WalletBalance · docs/ui/commerce.md",
};

const COPY = defineCopy({
  ar: {
    sample: "عيّنة للعرض: الأسماء حقيقية، والأسعار والمخزون من بيانات المتجر التجريبية. الإضافة إلى السلة تعمل فعلاً على سلة هذا المتصفح في المتجر التجريبي.",
    cards: "بطاقة المنتج",
    cardsNote: "بطاقة واحدة بلا إطار: بئر مربع على أرضية المنتج، والشارة في البداية والقلب في النهاية؛ تحتها سطر المنصة والاسم بسطرين وحقيقتان، ثم السعر وزر الإضافة المحايد. البطاقة كلها رابط واحد.",
    inStock: "متوفر",
    isNew: "جديد",
    sale: "تخفيض حقيقي",
    soon: "قريباً",
    out: "نفد",
    options: "بخيارات (نظرة سريعة)",
    boxArt: "غلاف لعبة",
    digital: "بطاقة رقمية",
    wide: "جهاز عريض",
    wish: "مع القلب",
    failing: "صورة لم تُحمَّل",
    loading: "قيد التحميل",
    rows: "بطاقة الصف",
    rowsNote: "بئر 96 بكسل في البداية، والكلمات والسعر بجانبه، والزر في النهاية: لمراكز الأجهزة والاقتراحات العريضة.",
    add: "زر الإضافة",
    addNote: "محايد: دائرة 40 بكسل على الورق، تمتلئ بالأحمر تحت المؤشر، وبعد الإضافة علامة صح بلون النجاح حتى نهاية الجلسة؛ نقرة أخرى تضيف قطعة. المنتج ذو الخيارات يفتح النظرة السريعة.",
    ready: "جاهز",
    choose: "يحتاج اختياراً",
    keyVariant: "الزر الأساسي",
    buy: "أدوات الشراء وشريط الشراء",
    buyNote: "من 1024: العدّاد والزر الأساسي والقلب، وتحتها أزرار نصية. على الهاتف شريط زجاجي في الأسفل: السعر والنسخة في البداية والزر في النهاية؛ بعد الإضافة «في السلة» و«عرض السلة (2)».",
    variant: "النسخة الدولية · 256GB",
    wishlist: "المفضلة",
    compare: "قارن",
    share: "مشاركة",
    barDefault: "عادي",
    barOut: "نفد",
    barSoon: "قريباً",
    gallery: "المعرض والمسرح",
    galleryNote: "أرضية محايدة، المنتج مستقيم وكبير على خط الأرض. داخل المسرح العدّاد وزر ملء الشاشة فقط؛ الصور المصغّرة تحته.",
    galleryUsed: "مستعمل: صورة توضيحية",
    shelf: "الرفّ",
    shelfNote: "رأس القسم ثم صف يمرّر على الهاتف وشبكة من البطاقات الكاملة من 1024. الرفّ الذي فيه أقل من 3 منتجات لا يظهر.",
    shelfTitle: "وصل حديثاً",
    shelfReason: "أحدث ما أضفناه، والمتوفر الآن — عيّنة للعرض",
    all: "الكل",
    used: "الأجهزة المستعملة",
    usedNote: "لا إضافة إلى السلة من القائمة: صفحة الجهاز تعرض الفحص أولاً. الصورة التوضيحية تقول ذلك بالكلمات.",
    lines: "سطور السلة",
    linesNote: "قيمة الخيار وحدها، والتوفّر، والعدّاد، والمجموع، و«إزالة». الإزالة تترك صف التراجع. عيّنة محلية لا ترسل شيئاً.",
    summary: "ملخص الطلب",
    summaryNote: "رقم أحمر واحد: الإجمالي. زر التأكيد داخل البطاقة على سطح المكتب، ثم سطر الثقة وسطر الطلب التجريبي.",
    placeOrder: "أكّد الطلب",
    summaryBroken: "أرقام لا تتطابق",
    summaryUnserved: "محافظة لا نوصل إليها",
    couponLabel: "خصم 50,000 د.ع على الطلب",
    inspection: "تقرير الفحص",
    proof: "رفع صورة الحوالة",
    proofNote: "كل الحالات. المثالان التفاعليان محاكاة داخل المتصفح: لا يُرسل أي ملف إلى أي خادم.",
    simulated: "محاكاة تنجح",
    simulatedBreak: "محاكاة تنقطع ثم تكتمل",
    rejectedNote: "المبلغ في الصورة 745,000 د.ع ومبلغ الطلب 765,000 د.ع.",
    wallet: "المحفظة",
    walletNote: "الرصيد على شريط المحفظة: قرمزي في الفاتح وخزانة مضاءة في الداكن. الرصيد مجموع الحركات ولا يُكتب يدوياً. الضيف يرى جملة ورابط دخول.",
    guest: "ضيف",
    walletPay: "عند الدفع",
    nameSwitch: "Nintendo Switch 2",
    subSwitch: "256GB · ضمان الشركة المصنّعة",
    subPro: "2TB · بدون قارئ أقراص",
    subOled: "أبيض · 64GB",
    subLite: "تركوازي",
    subDeck: "512GB أو 1TB",
    subMkw: "حتى 24 متسابقاً · PEGI 3",
    subCard: "رصيد رقمي · المتجر الأمريكي",
    subLegion: "شاشة 8.8 بوصة · 512GB",
    kindConsoleSwitch: "جهاز Switch 2",
    kindConsolePs5: "جهاز PS5",
    kindGame: "لعبة Switch 2",
    kindHandheld: "جهاز محمول",
    kindCard: "بطاقة شحن · Nintendo",
    kindXbox: "جهاز Xbox",
    nameUsed: "Nintendo Switch OLED مستعمل",
    subUsed: "أبيض · 64GB",
    white: "أبيض",
    checkScreen: "الشاشة واللمس",
    checkSticks: "الأزرار وعصا التحكم",
    checkSticksNote: "انحراف بسيط في العصا اليسرى، لا يؤثر في اللعب.",
    checkPorts: "المنافذ والقاعدة",
    checkCharging: "الشحن",
    defect1: "خدش خفيف على الحافة العلوية للشاشة.",
    included1: "القاعدة وكابل HDMI",
    included2: "ذراعا Joy-Con مع الحامل",
  },
  en: {
    sample: "Sample data: the names are real; prices and stock come from the demo store. Adding to the cart really works on this browser's demo cart.",
    cards: "Product card",
    cardsNote: "One card with no container: a square well on the product ground, the badge at the start and the heart at the end; under it the platform line, the name on two lines and two facts, then the price and the neutral add button. The whole card is one link.",
    inStock: "In stock",
    isNew: "New",
    sale: "A real reduction",
    soon: "Coming soon",
    out: "Sold out",
    options: "With options (quick look)",
    boxArt: "Box art",
    digital: "Digital card",
    wide: "A wide device",
    wish: "With the heart",
    failing: "The picture failed",
    loading: "Loading",
    rows: "Row card",
    rowsNote: "A 96px well at the start, the words and the price beside it, the button at the end: device hubs and wide suggestions.",
    add: "The add button",
    addNote: "Neutral: a 40px circle on paper that fills red under the pointer; after an add an ok check for the rest of the session; another tap adds one more. A product with options opens the quick look.",
    ready: "Ready",
    choose: "Needs a choice",
    keyVariant: "The primary button",
    buy: "Buy controls and the buy bar",
    buyNote: "From 1024: the stepper, the primary and the heart, with text buttons under them. On phones a glass bar at the bottom: the price and version at the start, the button at the end; after an add «In your cart» and «View cart (2)».",
    variant: "International version · 256GB",
    wishlist: "Favourites",
    compare: "Compare",
    share: "Share",
    barDefault: "Default",
    barOut: "Sold out",
    barSoon: "Coming soon",
    gallery: "Gallery and stage",
    galleryNote: "A neutral ground; the product straight and big on the floor line. Inside the stage only the counter and the full-screen button; the thumbnails under it.",
    galleryUsed: "Used: an illustration",
    shelf: "Shelf",
    shelfNote: "The section head, then a row that scrolls on phones and a grid of whole cards from 1024. A shelf with fewer than 3 products does not render.",
    shelfTitle: "New arrivals",
    shelfReason: "The newest we added, in stock now — sample",
    all: "All",
    used: "Used devices",
    usedNote: "No add to cart from a list: the unit's page shows the inspection first. An illustration says so in words.",
    lines: "Cart lines",
    linesNote: "The option value only, availability, the stepper, the line total and «Remove». Removing leaves the undo row. A local sample: nothing is sent.",
    summary: "Order summary",
    summaryNote: "One red figure: the total. The commit button sits inside the card on desktop, then the trust line and the demo-order line.",
    placeOrder: "Place order",
    summaryBroken: "Figures that do not add up",
    summaryUnserved: "A governorate we do not deliver to",
    couponLabel: "50,000 IQD off the order",
    inspection: "Inspection report",
    proof: "Transfer photo upload",
    proofNote: "Every state. The two interactive ones are simulated in the browser: no file is sent anywhere.",
    simulated: "Simulated success",
    simulatedBreak: "Simulated: breaks, then finishes",
    rejectedNote: "The photo shows 745,000 IQD; the order is 765,000 IQD.",
    wallet: "Wallet",
    walletNote: "The balance on the wallet band: crimson in light, a lit cabinet in dark. The balance is the sum of the ledger and never typed in. A guest sees one sentence and a sign-in link.",
    guest: "Guest",
    walletPay: "At payment",
    nameSwitch: "Nintendo Switch 2",
    subSwitch: "256GB · manufacturer warranty",
    subPro: "2TB · no disc drive",
    subOled: "White · 64GB",
    subLite: "Turquoise",
    subDeck: "512GB or 1TB",
    subMkw: "Up to 24 racers · PEGI 3",
    subCard: "Digital credit · US store",
    subLegion: "8.8-inch screen · 512GB",
    kindConsoleSwitch: "Switch 2 console",
    kindConsolePs5: "PS5 console",
    kindGame: "Switch 2 game",
    kindHandheld: "Handheld PC",
    kindCard: "Gift card · Nintendo",
    kindXbox: "Xbox console",
    nameUsed: "Used Nintendo Switch OLED",
    subUsed: "White · 64GB",
    white: "White",
    checkScreen: "Screen and touch",
    checkSticks: "Buttons and sticks",
    checkSticksNote: "A slight drift on the left stick; it does not affect play.",
    checkPorts: "Ports and dock",
    checkCharging: "Charging",
    defect1: "A light scratch on the top edge of the screen.",
    included1: "The dock and an HDMI cable",
    included2: "Two Joy-Con with the grip",
  },
  ckb: {
    sample: "داتای نموونە: ناوەکان ڕاستەقینەن؛ نرخ و کۆگا لە فرۆشگای تاقیکارییەوەن. زیادکردن بۆ سەبەتە لەسەر سەبەتەی تاقیکاریی ئەم وێبگەڕە کار دەکات.",
    cards: "کارتی کاڵا",
    cardsNote: "یەک کارت بێ چوارچێوە: بیرێکی چوارگۆشە لەسەر زەوی کاڵا، نیشانە لە سەرەتا و دڵ لە کۆتایی؛ لە خوارەوە هێڵی پلاتفۆرم و ناو بە دوو دێڕ و دوو ڕاستی، پاشان نرخ و دوگمەی زیادکردنی بێلایەن.",
    inStock: "بەردەستە",
    isNew: "نوێ",
    sale: "داشکاندنی ڕاستەقینە",
    soon: "بەم زووانە",
    out: "نەماوە",
    options: "بە هەڵبژاردن (سەیرکردنی خێرا)",
    boxArt: "بەرگی یاری",
    digital: "کارتی دیجیتاڵ",
    wide: "ئامێرێکی پان",
    wish: "لەگەڵ دڵ",
    failing: "وێنەکە بار نەبوو",
    loading: "بار دەکرێت",
    rows: "کارتی ڕیز",
    rowsNote: "بیرێکی 96 پیکسڵی لە سەرەتا، وشە و نرخ لە تەنیشتی، دوگمە لە کۆتایی.",
    add: "دوگمەی زیادکردن",
    addNote: "بێلایەن: بازنەیەکی 40 پیکسڵی لەسەر کاغەز کە لە ژێر نیشاندەردا سوور دەبێت؛ دوای زیادکردن نیشانەی ڕاست تا کۆتایی دانیشتنەکە.",
    ready: "ئامادە",
    choose: "پێویستی بە هەڵبژاردنە",
    keyVariant: "دوگمەی سەرەکی",
    buy: "ئامرازەکانی کڕین و شریتی کڕین",
    buyNote: "لە 1024 بەرەوژوور: ژمێرەر و دوگمەی سەرەکی و دڵ. لە مۆبایلدا شریتێکی شووشەیی لە خوارەوە: نرخ و وەشان لە سەرەتا و دوگمە لە کۆتایی.",
    variant: "وەشانی نێودەوڵەتی · 256GB",
    wishlist: "دڵخوازەکان",
    compare: "بەراورد",
    share: "هاوبەشکردن",
    barDefault: "ئاسایی",
    barOut: "نەماوە",
    barSoon: "بەم زووانە",
    gallery: "پیشانگا و شانۆ",
    galleryNote: "زەوییەکی بێلایەن؛ کاڵاکە ڕاست و گەورە لەسەر هێڵی زەوی. لە ناو شانۆدا تەنها ژمێرەر و دوگمەی شاشەی پڕ؛ وێنە بچووکەکان لە خوارەوە.",
    galleryUsed: "بەکارهاتوو: وێنەی ڕوونکردنەوە",
    shelf: "ڕەف",
    shelfNote: "سەری بەش، پاشان ڕیزێک کە لە مۆبایلدا دەخولێتەوە و تۆڕێکی کارتی تەواو لە 1024 بەرەوژوور. ڕەفی کەمتر لە 3 کاڵا دەرناکەوێت.",
    shelfTitle: "تازە گەیشتوو",
    shelfReason: "نوێترین ئەوەی زیادمان کرد — نموونە",
    all: "هەموو",
    used: "ئامێرە بەکارهاتووەکان",
    usedNote: "لە لیستەوە زیادکردن بۆ سەبەتە نییە: پەڕەی ئامێرەکە سەرەتا پشکنین پیشان دەدات.",
    lines: "دێڕەکانی سەبەتە",
    linesNote: "تەنها نرخی هەڵبژاردن، بەردەستبوون، ژمێرەر، کۆی دێڕ و «لابردن». نموونەیەکی ناوخۆیی: هیچ نانێردرێت.",
    summary: "پوختەی داواکاری",
    summaryNote: "یەک ژمارەی سوور: کۆی گشتی. دوگمەی دووپاتکردنەوە لە ناو کارتەکەدا لەسەر مێز.",
    placeOrder: "داواکارییەکە دووپات بکەرەوە",
    summaryBroken: "ژمارەی ناڕێک",
    summaryUnserved: "پارێزگایەک کە ناگەیەنینە ئەوێ",
    couponLabel: "50,000 دینار داشکاندن لەسەر داواکاری",
    inspection: "ڕاپۆرتی پشکنین",
    proof: "بارکردنی وێنەی گواستنەوە",
    proofNote: "هەموو دۆخەکان. دوو نموونە کارلێککەرەکە لە ناو وێبگەڕدا لاسایی دەکرێنەوە: هیچ فایلێک نانێردرێت.",
    simulated: "لاساییکردنەوەی سەرکەوتوو",
    simulatedBreak: "لاساییکردنەوە: دەپچڕێت، پاشان تەواو دەبێت",
    rejectedNote: "وێنەکە 745,000 دینار پیشان دەدات؛ داواکارییەکە 765,000 دینارە.",
    wallet: "جزدان",
    walletNote: "باڵانس لەسەر شریتی جزدان: قرمزی لە ڕووندا، کابینەیەکی ڕووناک لە تاریکدا. میوان ڕستەیەک و بەستەری چوونەژوورەوە دەبینێت.",
    guest: "میوان",
    walletPay: "لە کاتی پارەداندا",
    nameSwitch: "Nintendo Switch 2",
    subSwitch: "256GB · گەرەنتیی کۆمپانیا",
    subPro: "2TB · بێ خوێنەری دیسک",
    subOled: "سپی · 64GB",
    subLite: "فیرۆزەیی",
    subDeck: "512GB یان 1TB",
    subMkw: "تا 24 پێشبڕکێکار · PEGI 3",
    subCard: "باڵانسی دیجیتاڵ · فرۆشگای ئەمریکی",
    subLegion: "شاشەی 8.8 ئینج · 512GB",
    kindConsoleSwitch: "ئامێری Switch 2",
    kindConsolePs5: "ئامێری PS5",
    kindGame: "یاریی Switch 2",
    kindHandheld: "ئامێری دەستی",
    kindCard: "کارتی پڕکردنەوە · Nintendo",
    kindXbox: "ئامێری Xbox",
    nameUsed: "Nintendo Switch OLED بەکارهاتوو",
    subUsed: "سپی · 64GB",
    white: "سپی",
    checkScreen: "شاشە و دەستلێدان",
    checkSticks: "دوگمە و دەستکەکان",
    checkSticksNote: "لادانێکی کەم لە دەستکی چەپ، کاریگەری لەسەر یاری نییە.",
    checkPorts: "دەرچەکان و بنکە",
    checkCharging: "بارگاویکردن",
    defect1: "خەتێکی سووک لەسەر لێواری سەرەوەی شاشە.",
    included1: "بنکە و کێبڵی HDMI",
    included2: "دوو Joy-Con لەگەڵ هەڵگرەکە",
  },
});

type C = (typeof COPY)["ar"];

/* ───────────────────────────── sample data (real photo keys, demo-store ids) ───────────────────────────── */

const photo = (artKey: string, alt = "", isIllustration = false): ImageRef => ({ artKey, mediaKey: null, alt, isIllustration });
const DAY = 86_400_000;
const NOW_SAMPLE = Date.UTC(2026, 10, 10, 9); // fixed, so server and client render the same dates

function sampleCards(c: C): Record<string, ProductCardData> {
  const base = {
    kind: "console" as const,
    platformSlug: "nintendo",
    platformName: "Nintendo",
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
  return {
    switch2: { ...base, id: "prd_nintendo-switch-2", slug: "nintendo-switch-2", name: c.nameSwitch, subtitle: c.subSwitch, kindLabel: c.kindConsoleSwitch, variantId: "var_nsw2-con-256", priceIqd: 675_000, badge: "new", isNew: true, image: photo("nintendo-switch-2--1") },
    pro: { ...base, id: "prd_playstation-5-pro", slug: "playstation-5-pro", name: "PlayStation 5 Pro", subtitle: c.subPro, kindLabel: c.kindConsolePs5, platformSlug: "playstation", platformName: "PlayStation", variantId: "var_ps5-pro-2tb", priceIqd: 1_095_000, image: photo("playstation-5-pro--1") },
    oled: { ...base, id: "prd_nintendo-switch-oled", slug: "nintendo-switch-oled", name: "Nintendo Switch OLED", subtitle: c.subOled, kindLabel: c.kindConsoleSwitch, variantId: "var_nsw-oled-wht", priceIqd: 435_000, compareAtIqd: 455_000, badge: "deal", image: photo("nintendo-switch-oled--1") },
    lite: { ...base, id: "prd_nintendo-switch-lite", slug: "nintendo-switch-lite", name: "Nintendo Switch Lite", subtitle: c.subLite, kindLabel: c.kindConsoleSwitch, variantId: "var_nsw-lite-trq", priceIqd: 285_000, stock: "out_of_stock", image: photo("nintendo-switch-lite--1") },
    soon: { ...base, id: "prd_xbox-series-x", slug: "xbox-series-x", name: "Xbox Series X", subtitle: "1TB · 4K", kindLabel: c.kindXbox, platformSlug: "xbox", platformName: "Xbox", variantId: "var_xsx-1tb", priceIqd: 828_750, stock: "preorder", badge: "preorder", releaseAt: NOW_SAMPLE + 8 * DAY, image: photo("xbox-series-x--1") },
    deck: { ...base, id: "prd_steam-deck-oled", slug: "steam-deck-oled", name: "Steam Deck OLED", subtitle: c.subDeck, kindLabel: c.kindHandheld, platformSlug: "handheld", platformName: "Handheld", variantId: "var_sdo-512", hasVariants: true, priceIqd: 790_000, image: photo("steam-deck-oled--1") },
    mkw: { ...base, id: "prd_mario-kart-world", slug: "mario-kart-world", kind: "game", name: "Mario Kart World", subtitle: c.subMkw, kindLabel: c.kindGame, variantId: "var_nsw2-mkw", priceIqd: 110_000, image: photo("mario-kart-world--1") },
    card: { ...base, id: "prd_nintendo-eshop-card", slug: "nintendo-eshop-card", kind: "digital", name: "Nintendo eShop Card $20", subtitle: c.subCard, kindLabel: c.kindCard, variantId: "var_eshop-20", priceIqd: 32_000, image: photo("nintendo-eshop-card--1") },
    legion: { ...base, id: "prd_lenovo-legion-go-2", slug: "lenovo-legion-go-2", name: "Lenovo Legion Go 2", subtitle: c.subLegion, kindLabel: c.kindHandheld, platformSlug: "handheld", platformName: "Handheld", variantId: "var_lgo2-512", priceIqd: 1_099_000, image: photo("lenovo-legion-go-2--1") },
    failing: { ...base, id: "prd_design-system-missing", slug: "xbox-series-s", name: "Xbox Series S", subtitle: "512GB", kindLabel: c.kindXbox, platformSlug: "xbox", platformName: "Xbox", variantId: "var_design-system-missing", priceIqd: 485_000, image: { artKey: null, mediaKey: "design-system/missing.webp", alt: "", isIllustration: false } },
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
    warrantyDays: 30,
    // the demo seed has no photo of this unit yet: the manufacturer's picture, flagged as an illustration
    image: photo("nintendo-switch-oled--1", "", true),
    hasRealPhotos: false,
    isDemo: true,
  };
}

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
    line({ id: "cit_nsw2-con-256", name: c.nameSwitch, optionsLabel: c.variant, unitPriceIqd: 675_000, image: photo("nintendo-switch-2--1"), href: "/p/nintendo-switch-2" }),
    line({ id: "cit_ds-wht", name: "DualSense", optionsLabel: c.white, unitPriceIqd: 105_000, qty: 2, maxQty: 7, image: photo("dualsense--1"), href: "/p/dualsense-wireless-controller" }),
    line({ id: "cit_used", kind: "used_unit", variantId: null, usedUnitId: "usd_used-switch-oled-white-01", name: c.nameUsed, optionsLabel: "A · 91%", unitPriceIqd: 320_000, maxQty: 1, image: photo("nintendo-switch-oled--1", "", true), href: "/used/used-switch-oled-white-01" }),
    line({ id: "cit_ps5-pro-2tb", name: "PlayStation 5 Pro", unitPriceIqd: 1_095_000, qty: 1, maxQty: 1, problem: "qty_reduced", stock: "low_stock", image: photo("playstation-5-pro--1"), href: "/p/playstation-5-pro" }),
    line({ id: "cit_nsw-lite-trq", name: "Nintendo Switch Lite", optionsLabel: c.subLite, unitPriceIqd: 285_000, maxQty: 0, problem: "out_of_stock", stock: "out_of_stock", image: photo("nintendo-switch-lite--1"), href: "/p/nintendo-switch-lite" }),
  ];
}

const WALLET: WalletEntry[] = [
  { id: "wle_4", kind: "refund", amountIqd: 105_000, at: NOW_SAMPLE - 1 * DAY, orderRef: "TT-3H8D5R2W" },
  { id: "wle_3", kind: "purchase", amountIqd: -675_000, at: NOW_SAMPLE - 4 * DAY, orderRef: "TT-7K4M2Q9X" },
  { id: "wle_2", kind: "trade_in_credit", amountIqd: 250_000, at: NOW_SAMPLE - 9 * DAY, orderRef: null },
  { id: "wle_1", kind: "topup", amountIqd: 500_000, at: NOW_SAMPLE - 12 * DAY, orderRef: null, status: "posted" },
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

const CARD_GRID = "cards cards--5";
const FILE = { name: "transfer-zain-cash.jpg", size: 1_840_000, type: "image/jpeg" };

/* ───────────────────────────── the section ───────────────────────────── */

export default function Commerce() {
  const c = useCopy(COPY);
  const cards = sampleCards(c);
  return (
    <>
      {/* shows the toasts only when the layout has no toaster of its own */}
      <Toaster fallback />
      <p className="ds-note max-w-[60ch]">{c.sample}</p>
      <Cards c={c} cards={cards} />
      <Rows c={c} cards={cards} />
      <AddButtons c={c} cards={cards} />
      <Buy c={c} />
      <GalleryBlock c={c} />
      <ShelfBlock c={c} cards={cards} />
      <Used c={c} />
      <Lines c={c} />
      <Summary c={c} />
      <Proof c={c} />
      <Wallet c={c} />
    </>
  );
}

/** A specimen with a human caption and the API beside it. */
function Spec({ title, code, wide = false, children }: { title?: ReactNode; code?: string; wide?: boolean; children: ReactNode }) {
  return (
    <figure className={["ds-spec", wide ? "ds-spec--wide" : ""].join(" ")}>
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

function Cards({ c, cards }: { c: C; cards: Record<string, ProductCardData> }) {
  const states: [string, string, ReactNode][] = [
    [c.isNew, "badge new", <ProductCard key="n" card={cards.switch2} />],
    [c.inStock, "a 7-digit price", <ProductCard key="p" card={cards.pro} />],
    [c.sale, "compareAtIqd", <ProductCard key="s" card={cards.oled} />],
    [c.soon, 'stock="preorder" releaseAt', <ProductCard key="soon" card={cards.soon} />],
    [c.out, 'stock="out_of_stock"', <ProductCard key="o" card={cards.lite} />],
    [c.options, "hasVariants", <ProductCard key="v" card={cards.deck} />],
    [c.boxArt, 'kind="game" (box art)', <ProductCard key="b" card={cards.mkw} />],
    [c.digital, 'kind="digital"', <ProductCard key="d" card={cards.card} />],
    [c.wide, "≥ 1.8:1", <ProductCard key="w" card={cards.legion} />],
    [c.wish, "wishlist wished", <ProductCard key="h" card={{ ...cards.switch2, id: "prd_nintendo-switch-2" }} slot="wish" wishlist wished />],
    [c.failing, "image failed → retry", <ProductCard key="f" card={cards.failing} />],
    [c.loading, "<ProductCardPlaceholder>", <ProductCardPlaceholder key="l" />],
  ];
  return (
    <DsBlock id="commerce-cards" title={c.cards} note={c.cardsNote}>
      <div className={CARD_GRID}>
        {states.map(([title, code, node]) => (
          <Spec key={code} title={title} code={code}>
            {node}
          </Spec>
        ))}
      </div>
    </DsBlock>
  );
}

function Rows({ c, cards }: { c: C; cards: Record<string, ProductCardData> }) {
  return (
    <DsBlock id="commerce-rows" title={c.rows} note={c.rowsNote}>
      <SpecimenGrid wide>
        <Spec code='layout="row"'>
          <ProductCard card={cards.pro} layout="row" slot="row" />
        </Spec>
        <Spec code='layout="row" (sale)'>
          <ProductCard card={cards.oled} layout="row" slot="row" />
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function AddButtons({ c, cards }: { c: C; cards: Record<string, ProductCardData> }) {
  return (
    <DsBlock id="commerce-add" title={c.add} note={c.addNote}>
      <SpecimenGrid>
        <Spec title={c.ready} code="<CardAddButton item name>">
          <CardAddButton item={{ variantId: cards.mkw.variantId }} name={cards.mkw.name} image={cards.mkw.image} />
        </Spec>
        <Spec title={c.choose} code="chooseHref">
          <CardAddButton item={{ variantId: cards.deck.variantId }} name={cards.deck.name} chooseHref="/p/steam-deck-oled" />
        </Spec>
        <Spec title={c.keyVariant} code='<AddToCartKey variant="key">'>
          <AddToCartKey variant="key" item={{ variantId: cards.switch2.variantId }} name={cards.switch2.name} image={cards.switch2.image} optionsLabel={c.variant} />
        </Spec>
        <Spec title={c.out} code='variant="key" stock="out_of_stock"'>
          <AddToCartKey variant="key" item={{ variantId: cards.lite.variantId }} name={cards.lite.name} stock="out_of_stock" />
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Buy({ c }: { c: C }) {
  const ui = useT("ui-shop");
  const item = { variantId: "var_nsw2-con-256" };
  const links = (
    <>
      <Key variant="ghost" size="sm" icon="heart">
        {c.wishlist}
      </Key>
      <Key variant="ghost" size="sm" icon="scales">
        {c.compare}
      </Key>
      <Key variant="ghost" size="sm" icon="share-network">
        {c.share}
      </Key>
    </>
  );
  return (
    <DsBlock id="commerce-buy" title={c.buy} note={c.buyNote}>
      <SpecimenGrid wide>
        <Spec code="<BuyControls aside links> (≥1024)" wide>
          <div className="max-w-[34rem]">
            <BuyControls item={item} name={c.nameSwitch} optionsLabel={c.variant} maxQty={3} aside={<WishlistKey productId="prd_nintendo-switch-2" name={c.nameSwitch} />} links={links} />
          </div>
        </Spec>
        {(
          [
            [c.barDefault, {}],
            [c.barOut, { stock: "out_of_stock" as const, alternativesHref: "#commerce-shelf" }],
            [c.barSoon, { stock: "preorder" as const, releaseAt: NOW_SAMPLE + 8 * DAY }],
          ] as const
        ).map(([title, extra]) => (
          <Spec key={title} title={title} code="<BuyBar fixed={false}>">
            <div className="ds-scroll h-48">
              <div className="grid min-h-60 content-start gap-2 p-4">
                <p className="type-sm text-ink-2">{ui("gallery.label", { name: c.nameSwitch })}</p>
              </div>
              <BuyBar fixed={false} item={item} name={c.nameSwitch} priceIqd={675_000} optionsLabel={c.variant} {...extra} />
            </div>
          </Spec>
        ))}
      </SpecimenGrid>
    </DsBlock>
  );
}

function GalleryBlock({ c }: { c: C }) {
  return (
    <DsBlock id="commerce-gallery" title={c.gallery} note={c.galleryNote}>
      <SpecimenGrid wide>
        <Spec code="<Gallery items>">
          <Gallery name={c.nameSwitch} items={[1, 2, 3, 4].map((n) => ({ image: photo(`nintendo-switch-2--${n}`) }))} />
        </Spec>
        <Spec title={c.galleryUsed} code='evidence="used"'>
          <Gallery name={c.nameUsed} evidence="used" items={[{ image: photo("nintendo-switch-oled--1", "", true) }, { image: photo("nintendo-switch-oled--2", "", true) }]} />
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function ShelfBlock({ c, cards }: { c: C; cards: Record<string, ProductCardData> }) {
  const t = useT("ui");
  const [platform, setPlatform] = useState<string | null>("all");
  const shelf: Shelf<ProductCardData> = {
    key: "ds-new",
    title: c.shelfTitle,
    reason: c.shelfReason,
    items: [cards.switch2, cards.pro, cards.oled, cards.mkw, cards.legion, cards.card],
  };
  return (
    <DsBlock id="commerce-shelf" title={c.shelf} note={c.shelfNote}>
      <ShelfRail
        shelf={shelf}
        href="/c/new"
        headingLevel={3}
        chips={
          <ChipGroup
            aria-label={c.shelfTitle}
            rail
            bleed
            value={platform}
            onChange={setPlatform}
            options={[{ value: "all", label: c.all }, ...PLATFORMS.map((p) => ({ value: p, label: t(`platform.${p}`), platform: p }))]}
          />
        }
      />
    </DsBlock>
  );
}

function Used({ c }: { c: C }) {
  const unit = sampleUsed(c);
  return (
    <DsBlock id="commerce-used" title={c.used} note={c.usedNote}>
      <SpecimenGrid wide>
        <Spec code="<UsedUnitCard>">
          <div className="max-w-[15rem]">
            <UsedUnitCard unit={unit} />
          </div>
        </Spec>
        <Spec code='<UsedUnitCard layout="row">'>
          <UsedUnitCard unit={unit} layout="row" slot="row" />
        </Spec>
        <Spec code="<InspectionCard>" wide>
          <InspectionCard
            grade="A"
            inspectedAt={NOW_SAMPLE - 3 * DAY}
            batteryHealthPct={91}
            checklist={[
              { key: "screen", label: c.checkScreen, ok: true },
              { key: "sticks", label: c.checkSticks, ok: false, note: c.checkSticksNote },
              { key: "ports", label: c.checkPorts, ok: true },
              { key: "charging", label: c.checkCharging, ok: true },
            ]}
            defects={[{ text: c.defect1, photo: null }]}
            included={[c.included1, c.included2]}
            photos={[photo("nintendo-switch-oled--1", "", true)]}
            warrantyDays={30}
            returnDays={7}
            ownershipChecked
            dataWiped
            isDemo
            newPriceIqd={435_000}
            headingLevel={3}
          />
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Lines({ c }: { c: C }) {
  const [lines, setLines] = useState(() => sampleLines(c));
  const [removed, setRemoved] = useState<string[]>([]);
  return (
    <DsBlock id="commerce-lines" title={c.lines} note={c.linesNote}>
      <ul className="max-w-[46rem] border-t border-line">
        {lines.map((line) => (
          <CartLineRow
            key={line.id}
            line={line}
            removed={removed.includes(line.id)}
            onQtyChange={(qty) => setLines((list) => list.map((l) => (l.id === line.id ? { ...l, qty, lineTotalIqd: l.unitPriceIqd * qty } : l)))}
            onRemove={() => setRemoved((ids) => [...ids, line.id])}
            onRestore={() => setRemoved((ids) => ids.filter((id) => id !== line.id))}
            onDismiss={() => {
              setRemoved((ids) => ids.filter((id) => id !== line.id));
              setLines((list) => list.filter((l) => l.id !== line.id));
            }}
          />
        ))}
      </ul>
    </DsBlock>
  );
}

function Summary({ c }: { c: C }) {
  const lines = sampleLines(c)
    .slice(0, 2)
    .map((line) => ({ id: line.id, name: line.name, optionsLabel: line.optionsLabel, lineTotalIqd: line.lineTotalIqd, image: line.image }));
  return (
    <DsBlock id="commerce-summary" title={c.summary} note={c.summaryNote}>
      <SpecimenGrid wide>
        <Spec code="<OrderSummary lines couponField action trust demo>">
          <OrderSummary
            subtotalIqd={885_000}
            discountIqd={0}
            shippingIqd={5_000}
            totalIqd={890_000}
            count={3}
            lines={lines}
            couponField={<CouponField />}
            action={
              <Key variant="primary" block>
                {c.placeOrder}
              </Key>
            }
            trust={<TrustStrip variant="line" cod returnsTo="/policies/returns" />}
            demo
            headingLevel={3}
          />
        </Spec>
        <Spec code="coupon">
          <OrderSummary subtotalIqd={885_000} discountIqd={50_000} shippingIqd={5_000} totalIqd={840_000} coupon={{ code: "TAMTAM50", label: c.couponLabel }} headingLevel={3} />
        </Spec>
        <Spec title={c.summaryUnserved} code='shipping="unserved"'>
          <OrderSummary subtotalIqd={885_000} discountIqd={0} shippingIqd={null} totalIqd={885_000} shipping="unserved" headingLevel={3} />
        </Spec>
        <Spec title={c.summaryBroken} code="totalsReconcile → false">
          <OrderSummary subtotalIqd={885_000} discountIqd={0} shippingIqd={5_000} totalIqd={880_000} headingLevel={3} />
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Proof({ c }: { c: C }) {
  const [simulated] = useState(() => simulatedUpload(null));
  const [breaking] = useState(() => simulatedUpload(0.6));
  const refuse = async () => ({ ok: false as const, code: "network" });
  return (
    <DsBlock id="commerce-proof" title={c.proof} note={c.proofNote}>
      <SpecimenGrid wide>
        <Spec title={c.simulated} code="<ProofUploader onUpload>">
          <ProofUploader onUpload={simulated} />
        </Spec>
        <Spec title={c.simulatedBreak} code="interrupted → resume">
          <ProofUploader onUpload={breaking} />
        </Spec>
        <Spec code='defaultState uploading (60%)'>
          <ProofUploader onUpload={refuse} defaultState={{ phase: "uploading", file: FILE, progress: 0.6 }} />
        </Spec>
        <Spec code="interrupted">
          <ProofUploader onUpload={refuse} defaultState={{ phase: "interrupted", file: FILE, progress: 0.6 }} />
        </Spec>
        <Spec code='failed (problem="size")'>
          <ProofUploader onUpload={refuse} defaultState={{ phase: "failed", file: FILE, problem: "size", retry: false }} />
        </Spec>
        <Spec code="uploaded">
          <ProofUploader onUpload={refuse} defaultState={{ phase: "uploaded", file: FILE, previewUrl: null }} />
        </Spec>
        <Spec code='status={{ state: "submitted" }}'>
          <ProofUploader onUpload={refuse} status={{ state: "submitted", note: null }} current={{ previewUrl: null, fileName: "transfer.jpg" }} />
        </Spec>
        <Spec code='status={{ state: "approved" }}'>
          <ProofUploader onUpload={refuse} status={{ state: "approved", note: null }} current={{ previewUrl: null, fileName: "transfer.jpg" }} />
        </Spec>
        <Spec code='status={{ state: "rejected", note }}'>
          <ProofUploader onUpload={refuse} status={{ state: "rejected", note: c.rejectedNote }} />
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}

function Wallet({ c }: { c: C }) {
  return (
    <DsBlock id="commerce-wallet" title={c.wallet} note={c.walletNote}>
      <SpecimenGrid wide>
        <Spec code="<WalletBalance entries topupHref historyHref>">
          <WalletBalance balanceIqd={WALLET_BALANCE} pendingIqd={100_000} entries={WALLET} topupHref="/account/wallet" historyHref="/account/wallet" headingLevel={3} />
        </Spec>
        <Spec title={c.walletPay} code="compact payIqd">
          <WalletBalance balanceIqd={WALLET_BALANCE} payIqd={890_000} compact />
        </Spec>
        <Spec title={c.guest} code="balanceIqd={null}">
          <WalletBalance balanceIqd={null} />
        </Spec>
      </SpecimenGrid>
    </DsBlock>
  );
}
