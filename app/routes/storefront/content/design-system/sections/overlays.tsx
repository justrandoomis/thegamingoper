import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { useFormat, useLocale, useT } from "~/i18n/react";
import type { Locale } from "~/lib/locales";
import { Accordion } from "~/ui/Accordion";
import { Blocks, type Block } from "~/ui/Blocks";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { Chip } from "~/ui/Chip";
import { DataTable, type DataColumn, type DataSort } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { ErrorState } from "~/ui/ErrorState";
import { Radio } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { KeyBank } from "~/ui/KeyBank";
import { Menu } from "~/ui/Menu";
import { Niche } from "~/ui/Niche";
import { OfflineBanner } from "~/ui/OfflineBanner";
import { Pagination, ShowMore } from "~/ui/Pagination";
import { PLATFORMS } from "~/ui/PlatformLed";
import { Price } from "~/ui/Price";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { Rail } from "~/ui/Rail";
import { Sheet } from "~/ui/Sheet";
import { Render } from "~/ui/Stage";
import { Status } from "~/ui/Tag";
import { Tabs } from "~/ui/Tabs";
import { Toaster } from "~/ui/Toast";
import { toast } from "~/ui/toast-store";
import { DsBlock, defineCopy, Specimen, SpecimenGrid, SpecimenRow, useCopy, type DsSectionMeta } from "../kit";

export const section: DsSectionMeta = {
  id: "overlays",
  order: 10,
  title: { ar: "الطبقات والتنقل والحالات", en: "Overlays, navigation and states", ckb: "چینەکان، گەشت و دۆخەکان" },
  owner: "app/ui · Sheet · Dialog · Menu · Toast · Tabs · Disclosure · Rail · Breadcrumbs · Pagination · ProgressSteps · EmptyState · ErrorState · OfflineBanner · Blocks · DataTable",
};

const COPY = defineCopy({
  ar: {
    layers: "اللوحات والحوارات",
    layersNote:
      "اللوحة تصعد من الحافة السفلى والزجاج في رأسها فقط، والحوار في الوسط على ورق. كلاهما يحبس التركيز ويعيده إلى المفتاح الذي فتحه، ويُغلق بزر Escape، ويوقف تمرير الصفحة دون أن تتحرك. اسحب رأس اللوحة لتغيير ارتفاعها أو لإغلاقها.",
    pickerTitle: "اختر المحافظة",
    pickerNote: "التوصيل 5,000 د.ع لكل المحافظات.",
    chosen: "المحافظة: {name}",
    filters: "الفلاتر",
    results: "24 منتجاً",
    platform: "المنصة",
    condition: "الحالة",
    newItem: "جديد",
    usedItem: "مستعمل",
    clearAll: "امسح الكل",
    show24: "اعرض 24 منتجاً",
    deleteAddress: "احذف العنوان",
    deleteQ: "احذف عنوان «البيت»؟",
    deleteWhat: "يُحذف العنوان من حسابك، ولا يمكن استرجاعه.",
    rejectTransfer: "ارفض الحوالة",
    rejectQ: "ارفض صورة الحوالة؟",
    rejectWhat: "يعود الطلب ⁦TT-3HD8P2LQ⁩ إلى «بانتظار الدفع»، ويمكن للزبون رفع صورة جديدة.",
    impactOrder: "حالة الطلب",
    impactOrderValue: "بانتظار الدفع",
    impactHeld: "مبلغ معلّق",
    codeAmount: "المبلغ لا يطابق الطلب",
    codeUnreadable: "الصورة غير واضحة",
    codeDuplicate: "الحوالة مستخدمة في طلب آخر",
    rejectHint: "اكتب ما يجب أن يصلحه الزبون.",
    rejected: "رُفضت صورة الحوالة. هذا مثال: لم يُرسل شيء.",
    deleted: "حُذف العنوان. هذا مثال: لم يُحذف شيء.",
    menus: "القوائم",
    menusNote: "تنزل من المفتاح الذي فتحها. الأسهم تنقل بين الصفوف، والكتابة تقفز إلى الصف الذي يبدأ بها، وEscape يغلقها ويعيد التركيز إلى المفتاح.",
    orderActions: "إجراءات الطلب",
    edit: "عدّل الطلب",
    copyLink: "انسخ رابط التتبّع",
    print: "اطبع الفاتورة",
    showArchived: "أظهر المؤرشفة",
    cancelOrder: "ألغِ الطلب",
    cancelQ: "ألغِ الطلب ⁦TT-7K4M2Q9X⁩؟",
    cancelWhat: "يُلغى الطلب وتعود قطعه إلى المخزون. لا يمكن التراجع.",
    stockBaghdad: "المخزون في بغداد",
    cancelled: "أُلغي الطلب. هذا مثال: لم يتغيّر شيء.",
    sortBy: "رتّب حسب",
    newest: "الأحدث",
    priceLow: "السعر: من الأقل",
    priceHigh: "السعر: من الأعلى",
    picked: "اخترت: {item}",
    toasts: "الإشعارات",
    toastsNote: "إشعار واحد في كل مرة تحت الرأس: 4 ثوانٍ، يتوقف عند المرور والتركيز، ويُسحب جانباً أو للأعلى ليُغلق. F6 ينقل التركيز إليه. ما يحتاج قراراً لا يكون إشعاراً.",
    info: "معلومة",
    success: "نجاح",
    warning: "تنبيه",
    error: "خطأ",
    cart: "أُضيف إلى السلة",
    dismissAll: "أغلق الكل",
    toastCopied: "نسخنا رقم الحساب.",
    toastSaved: "حُفظ العنوان.",
    toastLow: "بقي 2 فقط من هذا الخيار.",
    toastError: "لم يُحفظ العنوان.",
    toastErrorDetail: "تحقّق من الاتصال، ثم أعد المحاولة.",
    toastUndone: "أزلنا Xbox Series X من السلة.",
    tabs: "التبويبات",
    tabsNote: "مسطّحة مثل شريط التنقل: الاسم يصبح أغمق وتحته خط بالحبر، ولا أحمر. تبويبات اللوحات تنزلق من جهة التبويب المختار، وتبويبات الروابط تحفظ الحالة في عنوان الصفحة.",
    details: "تفاصيل المنتج",
    specs: "المواصفات",
    inBox: "في العلبة",
    warrantyTab: "الضمان",
    specsBody: "شاشة 7.9 بوصة بدقة 1080p، وذاكرة 256GB، ويدا Joy-Con 2 تثبتان بالمغناطيس.",
    inBoxBody: "الجهاز، يدا Joy-Con 2 مع الحامل والأحزمة، القاعدة، محوّل الطاقة، كيبل HDMI وكيبل USB-C.",
    warrantyBody: "الضمان وشروطه تُكتب هنا بجمل واضحة: المدة، وما يشمله، وما لا يشمله.",
    catalogue: "أقسام المتجر",
    all: "الكل",
    consoles: "الأجهزة",
    games: "الألعاب",
    accessories: "الإكسسوارات",
    disclosure: "الإفصاح والأكورديون",
    disclosureNote: "عناصر details أصلية: تعمل قبل تحميل الجافاسكربت، والبحث في الصفحة يفتح الصف الصحيح. مع exclusive يبقى صف واحد مفتوحاً.",
    q1: "كم رسوم التوصيل؟",
    a1: "التوصيل 5,000 د.ع لكل المحافظات.",
    q2: "هل أستطيع الدفع عند الاستلام؟",
    a2: "نعم، تدفع للمندوب نقداً عند وصول الطلب.",
    q3: "متى يتأكد طلبي إذا دفعت بحوالة؟",
    a3: "بعد أن يراجع موظف صورة الحوالة ويتحقق منها. حتى ذلك الحين يبقى الطلب «بانتظار التحقق».",
    checkedQ: "ما الذي فُحص في هذا الجهاز؟",
    checkedA: "الشاشة، الأزرار والعصي، المنافذ، والشحن. نكتب ما وجدناه بجمل واضحة مع صوره.",
    rails: "الرفوف المنزلقة",
    railsNote: "تمرير أصلي بنقاط توقف وزخم المنصة، بلا زجاج. الأسهم تعمل عند التركيز على الرف، ومن 1024px يظهر مفتاحان، والحافة تتلاشى حيث يوجد المزيد.",
    railLabel: "منتجات للعرض",
    navigation: "التنقل",
    navigationNote: "مسار التنقل يُقرأ باتجاه اللغة. الترقيم يحفظ عدداً ثابتاً من الخانات، و«اعرض المزيد» للقوائم ذات المؤشر، وشريط الخطوات للدفع والاستبدال.",
    home: "الرئيسية",
    devices: "الأجهزة",
    address: "العنوان",
    payment: "الدفع",
    review: "المراجعة",
    device: "الجهاز",
    state: "الحالة",
    photos: "الصور",
    estimate: "التقدير",
    inspection: "الفحص",
    states: "الحالات: فارغ، خطأ، بلا اتصال",
    statesNote: "الفارغ لوحة مسطّحة فيها مقعد فارغ وجملة ومفتاح واحد. الخطأ يحفظ المساحة ويعرض إعادة المحاولة ولا يتحرك. انقطاع الاتصال شريط حبر مسطّح تحت الرأس، لا زجاج ولا أحمر.",
    cartEmpty: "سلتك فارغة. دورك.",
    cartEmptyHint: "اختر منصّتك ونرتّب لك الرف.",
    browse: "تصفّح الأجهزة",
    noResults: "لا نتائج لـ «Switch 3».",
    noResultsHint: "جرّب كلمة أقصر، أو ابحث باسم المنصة.",
    clearSearch: "امسح البحث",
    recsFailed: "تعذّر تحميل الاقتراحات.",
    blocks: "المحتوى المنظّم",
    blocksNote: "المقالات تُخزّن كتلاً لا HTML: عنوان، فقرة، قائمة، خطوات، تنبيه، جدول، صورة. كل نص يُعرض نصاً فقط، فالمحتوى آمن بطبيعته.",
    table: "جدول الإدارة",
    tableNote: "ورق مسطّح وخطوط رفيعة ورأس ثابت. الفرز روابط أو أزرار، والاختيار يرفع شريط إجراءات زجاجياً. على الشاشات الصغيرة يُمرَّر الجدول جانباً والعمود الأول ثابت.",
    orders: "الطلبات",
    colOrder: "الطلب",
    colGov: "المحافظة",
    colMethod: "الدفع",
    colStatus: "الحالة",
    colDate: "التاريخ",
    colAmount: "المبلغ (د.ع)",
    cod: "عند الاستلام",
    zaincash: "زين كاش",
    bank: "حوالة مصرفية",
    wallet: "المحفظة",
    stPaid: "مدفوع",
    stPending: "بانتظار التحقق",
    stShipped: "تم الشحن",
    stNew: "جديد",
    stCancelled: "ملغى",
    stRefunded: "مسترجع",
    ready: "جاهز",
    loading: "يحمّل",
    empty: "فارغ",
    failed: "خطأ",
    tableState: "حالة الجدول",
    printLabels: "اطبع الملصقات",
    cancelOrders: "ألغِ الطلبات",
    cancelManyQ: "ألغِ {count} طلبات؟",
    cancelManyWhat: "تُلغى الطلبات المختارة وتعود قطعها إلى المخزون.",
    labelsPrinted: "جهّزنا الملصقات. هذا مثال: لم يُطبع شيء.",
    reasonCustomer: "طلب الزبون",
    reasonStock: "نفد المخزون",
    reasonFraud: "اشتباه احتيال",
  },
  en: {
    layers: "Sheets and dialogs",
    layersNote:
      "A sheet rises from the bottom edge with glass on its header strip only; a dialog sits in the middle on paper. Both trap focus and return it to the key that opened them, close with Escape, and stop the page from scrolling without moving it. Drag a sheet's header to resize or dismiss it.",
    pickerTitle: "Choose your governorate",
    pickerNote: "Delivery is 5,000 IQD to every governorate.",
    chosen: "Governorate: {name}",
    filters: "Filters",
    results: "24 products",
    platform: "Platform",
    condition: "Condition",
    newItem: "New",
    usedItem: "Used",
    clearAll: "Clear all",
    show24: "Show 24 products",
    deleteAddress: "Delete address",
    deleteQ: "Delete the “Home” address?",
    deleteWhat: "The address is removed from your account and cannot be restored.",
    rejectTransfer: "Reject the transfer",
    rejectQ: "Reject this transfer photo?",
    rejectWhat: "Order ⁦TT-3HD8P2LQ⁩ goes back to “awaiting payment”, and the customer can upload a new photo.",
    impactOrder: "Order status",
    impactOrderValue: "Awaiting payment",
    impactHeld: "Amount on hold",
    codeAmount: "The amount does not match the order",
    codeUnreadable: "The photo cannot be read",
    codeDuplicate: "The transfer was used for another order",
    rejectHint: "Write what the customer needs to fix.",
    rejected: "Transfer photo rejected. This is an example: nothing was sent.",
    deleted: "Address deleted. This is an example: nothing was deleted.",
    menus: "Menus",
    menusNote: "They drop from the key that opened them. Arrows move between rows, typing jumps to the row that starts with it, and Escape closes the menu and returns focus to the key.",
    orderActions: "Order actions",
    edit: "Edit the order",
    copyLink: "Copy the tracking link",
    print: "Print the invoice",
    showArchived: "Show archived",
    cancelOrder: "Cancel the order",
    cancelQ: "Cancel order ⁦TT-7K4M2Q9X⁩?",
    cancelWhat: "The order is cancelled and its items go back to stock. This cannot be undone.",
    stockBaghdad: "Stock in Baghdad",
    cancelled: "Order cancelled. This is an example: nothing changed.",
    sortBy: "Sort by",
    newest: "Newest",
    priceLow: "Price: low to high",
    priceHigh: "Price: high to low",
    picked: "Chosen: {item}",
    toasts: "Toasts",
    toastsNote: "One at a time, under the header: 4 seconds, paused on hover and focus, swipe it sideways or up to dismiss. F6 moves focus to it. Anything that needs a decision is not a toast.",
    info: "Info",
    success: "Success",
    warning: "Warning",
    error: "Error",
    cart: "Added to cart",
    dismissAll: "Dismiss all",
    toastCopied: "We copied the account number.",
    toastSaved: "Address saved.",
    toastLow: "Only 2 left of this option.",
    toastError: "The address was not saved.",
    toastErrorDetail: "Check your connection, then try again.",
    toastUndone: "We removed Xbox Series X from the cart.",
    tabs: "Tabs",
    tabsNote: "Flat like the tab bar: the label turns ink and heavier with an ink marker under it, never red. Panel tabs slide in from the side of the chosen tab; link tabs keep the state in the page address.",
    details: "Product details",
    specs: "Specs",
    inBox: "In the box",
    warrantyTab: "Warranty",
    specsBody: "A 7.9-inch 1080p screen, 256GB of storage and two Joy-Con 2 controllers that attach magnetically.",
    inBoxBody: "The console, the Joy-Con 2 controllers with grip and straps, the dock, the AC adapter, an HDMI cable and a USB-C cable.",
    warrantyBody: "The warranty is stated here in plain sentences: how long, what it covers and what it does not.",
    catalogue: "Store sections",
    all: "All",
    consoles: "Consoles",
    games: "Games",
    accessories: "Accessories",
    disclosure: "Disclosure and accordion",
    disclosureNote: "Native details elements: they work before JavaScript loads, and find-in-page opens the right row. With exclusive, one row stays open.",
    q1: "How much is delivery?",
    a1: "Delivery is 5,000 IQD to every governorate.",
    q2: "Can I pay on delivery?",
    a2: "Yes, you pay the courier in cash when the order arrives.",
    q3: "When is my order confirmed if I pay by transfer?",
    a3: "After a member of staff has reviewed and verified the transfer photo. Until then the order is “awaiting verification”.",
    checkedQ: "What was checked on this device?",
    checkedA: "The screen, buttons and sticks, ports and charging. What we found is written in plain sentences, with photos.",
    rails: "Rails",
    railsNote: "Native scrolling with snap points and the platform's momentum, no glass. Arrow keys work when the rail has focus, two keys appear from 1024px, and the edge fades where there is more.",
    railLabel: "Sample products",
    navigation: "Navigation",
    navigationNote: "Breadcrumbs read in the language's direction. Pagination keeps a constant number of slots, “show more” is for cursor lists, and the step rail is for checkout and trade-in.",
    home: "Home",
    devices: "Devices",
    address: "Address",
    payment: "Payment",
    review: "Review",
    device: "Device",
    state: "Condition",
    photos: "Photos",
    estimate: "Estimate",
    inspection: "Inspection",
    states: "States: empty, error, offline",
    statesNote: "Empty is a flat panel with an empty socket, one sentence and one key. Error keeps the space, offers a retry and does not move. Offline is a flat ink banner under the header: not glass, not red.",
    cartEmpty: "Your cart is empty. Your turn.",
    cartEmptyHint: "Pick your platform and we will stock the shelf.",
    browse: "Browse devices",
    noResults: "No results for “Switch 3”.",
    noResultsHint: "Try a shorter word, or search by platform name.",
    clearSearch: "Clear the search",
    recsFailed: "The suggestions did not load.",
    blocks: "Structured content",
    blocksNote: "Articles are stored as blocks, not HTML: heading, paragraph, list, steps, callout, table, picture. Every string is rendered as text only, so the content is safe by construction.",
    table: "Admin table",
    tableNote: "Flat paper, hairlines and a sticky header. Sorting is links or buttons, and selecting rows raises a glass action bar. On small screens the table scrolls sideways with the first column pinned.",
    orders: "Orders",
    colOrder: "Order",
    colGov: "Governorate",
    colMethod: "Payment",
    colStatus: "Status",
    colDate: "Date",
    colAmount: "Amount (IQD)",
    cod: "On delivery",
    zaincash: "Zain Cash",
    bank: "Bank transfer",
    wallet: "Wallet",
    stPaid: "Paid",
    stPending: "Awaiting verification",
    stShipped: "Shipped",
    stNew: "New",
    stCancelled: "Cancelled",
    stRefunded: "Refunded",
    ready: "Ready",
    loading: "Loading",
    empty: "Empty",
    failed: "Error",
    tableState: "Table state",
    printLabels: "Print labels",
    cancelOrders: "Cancel orders",
    cancelManyQ: "Cancel {count} orders?",
    cancelManyWhat: "The selected orders are cancelled and their items go back to stock.",
    labelsPrinted: "Labels prepared. This is an example: nothing was printed.",
    reasonCustomer: "Customer request",
    reasonStock: "Out of stock",
    reasonFraud: "Suspected fraud",
  },
  ckb: {
    layers: "پانێڵ و دیالۆگەکان",
    layersNote:
      "پانێڵ لە لێواری خوارەوە بەرز دەبێتەوە و تەنها سەرەکەی شووشەیە؛ دیالۆگ لە ناوەڕاستدایە لەسەر کاغەز. هەردووکیان سەرنج دەگرن و دەیگەڕێننەوە بۆ ئەو دوگمەیەی کردیانەوە، بە Escape دادەخرێن و پەڕەکە ڕادەگرن بێ ئەوەی بجووڵێت. سەری پانێڵەکە ڕابکێشە بۆ گۆڕینی بەرزی یان داخستنی.",
    pickerTitle: "پارێزگاکەت هەڵبژێرە",
    pickerNote: "گەیاندن 5,000 د.ع بۆ هەموو پارێزگاکان.",
    chosen: "پارێزگا: {name}",
    filters: "فلتەرەکان",
    results: "24 بەرهەم",
    platform: "پلاتفۆرم",
    condition: "دۆخ",
    newItem: "نوێ",
    usedItem: "بەکارهاتوو",
    clearAll: "هەمووی بسڕەوە",
    show24: "24 بەرهەم پیشان بدە",
    deleteAddress: "ناونیشانەکە بسڕەوە",
    deleteQ: "ناونیشانی «ماڵ» بسڕیتەوە؟",
    deleteWhat: "ناونیشانەکە لە هەژمارەکەت دەسڕدرێتەوە و ناگەڕێتەوە.",
    rejectTransfer: "حەواڵەکە ڕەت بکەرەوە",
    rejectQ: "وێنەی حەواڵەکە ڕەت دەکەیتەوە؟",
    rejectWhat: "داواکاریی ⁦TT-3HD8P2LQ⁩ دەگەڕێتەوە بۆ «چاوەڕێی پارەدان»، و کڕیار دەتوانێت وێنەیەکی نوێ بنێرێت.",
    impactOrder: "دۆخی داواکاری",
    impactOrderValue: "چاوەڕێی پارەدان",
    impactHeld: "بڕی ڕاگیراو",
    codeAmount: "بڕەکە لەگەڵ داواکارییەکە ناگونجێت",
    codeUnreadable: "وێنەکە ناخوێندرێتەوە",
    codeDuplicate: "حەواڵەکە بۆ داواکارییەکی تر بەکارهاتووە",
    rejectHint: "بنووسە کڕیار چی چاک بکات.",
    rejected: "وێنەی حەواڵەکە ڕەت کرایەوە. ئەمە نموونەیە: هیچ نەنێردرا.",
    deleted: "ناونیشانەکە سڕایەوە. ئەمە نموونەیە: هیچ نەسڕایەوە.",
    menus: "لیستەکان",
    menusNote: "لەو دوگمەیەوە دادەبەزن کە کردیانەوە. تیرەکان لە نێوان ڕیزەکاندا دەگوازنەوە، نووسین بۆ ئەو ڕیزە بازدەدات کە پێی دەست پێدەکات، و Escape دایدەخات و سەرنج دەگەڕێنێتەوە بۆ دوگمەکە.",
    orderActions: "کردارەکانی داواکاری",
    edit: "داواکارییەکە دەستکاری بکە",
    copyLink: "بەستەری بەدواداچوون کۆپی بکە",
    print: "پسوولەکە چاپ بکە",
    showArchived: "ئەرشیفکراوەکان پیشان بدە",
    cancelOrder: "داواکارییەکە هەڵبوەشێنەوە",
    cancelQ: "داواکاریی ⁦TT-7K4M2Q9X⁩ هەڵدەوەشێنیتەوە؟",
    cancelWhat: "داواکارییەکە هەڵدەوەشێتەوە و کاڵاکانی دەگەڕێنەوە بۆ کۆگا. ناگەڕێتەوە.",
    stockBaghdad: "کۆگا لە بەغدا",
    cancelled: "داواکارییەکە هەڵوەشایەوە. ئەمە نموونەیە: هیچ نەگۆڕا.",
    sortBy: "ڕیزبەندی بەپێی",
    newest: "نوێترین",
    priceLow: "نرخ: لە کەمەوە",
    priceHigh: "نرخ: لە زۆرەوە",
    picked: "هەڵبژێردرا: {item}",
    toasts: "ئاگادارکردنەوەکان",
    toastsNote: "یەک دانە لە یەک کاتدا، لە ژێر سەرپەڕەکە: 4 چرکە، لە کاتی هێنانە سەری نیشاندەر و سەرنجدا ڕادەوەستێت، بۆ لابردنی بیکێشە بۆ لا یان بۆ سەرەوە. F6 سەرنج دەباتە سەری. ئەوەی پێویستی بە بڕیار بێت ئاگادارکردنەوە نییە.",
    info: "زانیاری",
    success: "سەرکەوتن",
    warning: "ئاگاداری",
    error: "هەڵە",
    cart: "خرایە ناو سەبەتە",
    dismissAll: "هەمووی دابخە",
    toastCopied: "ژمارەی هەژمارەکەمان کۆپی کرد.",
    toastSaved: "ناونیشانەکە پاشەکەوت کرا.",
    toastLow: "تەنها 2 ماوە لەم هەڵبژاردەیە.",
    toastError: "ناونیشانەکە پاشەکەوت نەکرا.",
    toastErrorDetail: "پەیوەندییەکەت بپشکنە، پاشان دووبارە هەوڵ بدەوە.",
    toastUndone: "Xbox Series X مان لە سەبەتەکە لابرد.",
    tabs: "تابەکان",
    tabsNote: "تەختن وەک شریتی گەشت: ناوەکە تۆختر دەبێت و هێڵێکی مەرەکەبی لە ژێرییەتی، هەرگیز سوور نییە. تابی پانێڵ لە لای تابە هەڵبژێردراوەکەوە دێتە ناوەوە؛ تابی بەستەر دۆخەکە لە ناونیشانی پەڕەکەدا دەهێڵێتەوە.",
    details: "وردەکاریی بەرهەم",
    specs: "تایبەتمەندییەکان",
    inBox: "لە قوتووەکەدا",
    warrantyTab: "گەرەنتی",
    specsBody: "شاشەیەکی 7.9 ئینجی بە 1080p، بیرگەی 256GB و دوو دەسکی Joy-Con 2 کە بە موگناتیس دەلکێن.",
    inBoxBody: "ئامێرەکە، دەسکەکانی Joy-Con 2 لەگەڵ دەسگر و پەتەکان، بنکە، ئەداپتەری کارەبا، کێبڵی HDMI و کێبڵی USB-C.",
    warrantyBody: "گەرەنتی و مەرجەکانی لێرە بە ڕستەی ڕوون دەنووسرێن: ماوەکەی، چی دەگرێتەوە و چی ناگرێتەوە.",
    catalogue: "بەشەکانی فرۆشگا",
    all: "هەموو",
    consoles: "ئامێرەکان",
    games: "یارییەکان",
    accessories: "پاشکۆکان",
    disclosure: "ئاشکراکردن و ئەکۆردیۆن",
    disclosureNote: "توخمی details ی ڕەسەن: پێش بارکردنی جاڤاسکریپت کار دەکەن، و گەڕان لە پەڕەکەدا ڕیزی دروست دەکاتەوە. لەگەڵ exclusive تەنها یەک ڕیز کراوە دەمێنێت.",
    q1: "کرێی گەیاندن چەندە؟",
    a1: "گەیاندن 5,000 د.ع بۆ هەموو پارێزگاکان.",
    q2: "دەتوانم لە کاتی وەرگرتندا پارە بدەم؟",
    a2: "بەڵێ، کاتێک داواکارییەکە دەگات پارەکە بە نەختینە دەدەیتە گەیەنەرەکە.",
    q3: "ئەگەر بە حەواڵە پارە بدەم، کەی داواکارییەکەم پشتڕاست دەکرێتەوە؟",
    a3: "دوای ئەوەی کارمەندێک وێنەی حەواڵەکە دەبینێت و پشتڕاستی دەکاتەوە. تا ئەو کاتە داواکارییەکە «چاوەڕێی پشتڕاستکردنەوە»یە.",
    checkedQ: "چی لەم ئامێرەدا پشکنرا؟",
    checkedA: "شاشە، دوگمە و جۆیستیکەکان، دەرچەکان و بارگاویکردن. ئەوەی دۆزیمانەوە بە ڕستەی ڕوون لەگەڵ وێنەکانی دەنووسین.",
    rails: "ڕەفە خلیسکێنەکان",
    railsNote: "خلیسکاندنی ڕەسەن بە خاڵی وەستان و تەوژمی پلاتفۆرم، بێ شووشە. تیرەکان کار دەکەن کاتێک سەرنج لەسەر ڕەفەکەیە، لە 1024px دوو دوگمە دەردەکەون، و لێوارەکە کاڵ دەبێتەوە لەو لایەی زیاتری تێدایە.",
    railLabel: "بەرهەمی نموونە",
    navigation: "گەشت",
    navigationNote: "ڕێڕەوی گەشت بە ئاراستەی زمانەکە دەخوێندرێتەوە. لاپەڕەبەندی ژمارەیەکی جێگیر لە خانە دەهێڵێتەوە، «زیاتر پیشان بدە» بۆ لیستی نیشاندەرە، و شریتی هەنگاوەکان بۆ پارەدان و گۆڕینەوەیە.",
    home: "سەرەکی",
    devices: "ئامێرەکان",
    address: "ناونیشان",
    payment: "پارەدان",
    review: "پێداچوونەوە",
    device: "ئامێر",
    state: "دۆخ",
    photos: "وێنەکان",
    estimate: "خەمڵاندن",
    inspection: "پشکنین",
    states: "دۆخەکان: بەتاڵ، هەڵە، بێ پەیوەندی",
    statesNote: "بەتاڵ پانێڵێکی تەختە بە جێگایەکی بەتاڵ، یەک ڕستە و یەک دوگمە. هەڵە شوێنەکە دەپارێزێت، دووبارە هەوڵدان پێشکەش دەکات و ناجووڵێت. بێ پەیوەندی شریتێکی مەرەکەبی تەختە لە ژێر سەرپەڕە: نە شووشەیە، نە سوور.",
    cartEmpty: "سەبەتەکەت بەتاڵە. نۆرەی تۆیە.",
    cartEmptyHint: "پلاتفۆرمەکەت هەڵبژێرە و ڕەفەکەت بۆ پڕ دەکەینەوە.",
    browse: "ئامێرەکان ببینە",
    noResults: "هیچ ئەنجامێک نییە بۆ «Switch 3».",
    noResultsHint: "وشەیەکی کورتتر تاقی بکەرەوە، یان بە ناوی پلاتفۆرم بگەڕێ.",
    clearSearch: "گەڕانەکە بسڕەوە",
    recsFailed: "پێشنیارەکان بار نەبوون.",
    blocks: "ناوەڕۆکی ڕێکخراو",
    blocksNote: "وتارەکان وەک بلۆک هەڵدەگیرێن نەک HTML: سەردێڕ، بڕگە، لیست، هەنگاو، ئاگاداری، خشتە، وێنە. هەموو دەقێک تەنها وەک دەق پیشان دەدرێت، بۆیە ناوەڕۆکەکە بە سروشتی خۆی سەلامەتە.",
    table: "خشتەی بەڕێوەبردن",
    tableNote: "کاغەزی تەخت، هێڵی باریک و سەرێکی جێگیر. ڕیزبەندی بەستەر یان دوگمەیە، و هەڵبژاردنی ڕیز شریتێکی کرداری شووشەیی بەرز دەکاتەوە. لە شاشەی بچووکدا خشتەکە بە لادا دەخلیسکێت و یەکەم ستوون جێگیرە.",
    orders: "داواکارییەکان",
    colOrder: "داواکاری",
    colGov: "پارێزگا",
    colMethod: "پارەدان",
    colStatus: "دۆخ",
    colDate: "بەروار",
    colAmount: "بڕ (د.ع)",
    cod: "لە کاتی وەرگرتن",
    zaincash: "زەین کاش",
    bank: "حەواڵەی بانکی",
    wallet: "جزدان",
    stPaid: "پارە دراوە",
    stPending: "چاوەڕێی پشتڕاستکردنەوە",
    stShipped: "نێردرا",
    stNew: "نوێ",
    stCancelled: "هەڵوەشاوە",
    stRefunded: "گەڕێندراوە",
    ready: "ئامادە",
    loading: "بار دەکرێت",
    empty: "بەتاڵ",
    failed: "هەڵە",
    tableState: "دۆخی خشتە",
    printLabels: "لەیبڵەکان چاپ بکە",
    cancelOrders: "داواکارییەکان هەڵبوەشێنەوە",
    cancelManyQ: "{count} داواکاری هەڵدەوەشێنیتەوە؟",
    cancelManyWhat: "داواکارییە هەڵبژێردراوەکان هەڵدەوەشێنەوە و کاڵاکانیان دەگەڕێنەوە بۆ کۆگا.",
    labelsPrinted: "لەیبڵەکان ئامادە کران. ئەمە نموونەیە: هیچ چاپ نەکرا.",
    reasonCustomer: "داوای کڕیار",
    reasonStock: "کۆگا تەواو بوو",
    reasonFraud: "گومانی فێڵ",
  },
});

type C = (typeof COPY)["ar"];

const fill = (template: string, vars: Record<string, string | number>) => template.replace(/\{(\w+)\}/g, (match, key: string) => String(vars[key] ?? match));

/** A few governorates for the picker specimen (the real list comes from listGovernorates()). */
const GOVERNORATES: { id: string; name: Record<Locale, string> }[] = [
  { id: "baghdad", name: { ar: "بغداد", en: "Baghdad", ckb: "بەغدا" } },
  { id: "basra", name: { ar: "البصرة", en: "Basra", ckb: "بەسرە" } },
  { id: "nineveh", name: { ar: "نينوى", en: "Nineveh", ckb: "نەینەوا" } },
  { id: "erbil", name: { ar: "أربيل", en: "Erbil", ckb: "هەولێر" } },
  { id: "sulaymaniyah", name: { ar: "السليمانية", en: "Sulaymaniyah", ckb: "سلێمانی" } },
  { id: "duhok", name: { ar: "دهوك", en: "Duhok", ckb: "دهۆک" } },
  { id: "najaf", name: { ar: "النجف", en: "Najaf", ckb: "نەجەف" } },
  { id: "karbala", name: { ar: "كربلاء", en: "Karbala", ckb: "کەربەلا" } },
];

export default function OverlaysSection() {
  const c = useCopy(COPY);
  return (
    <>
      {/* Only renders when no layout toaster is mounted (the shell's has the header offset and wins). */}
      <Toaster fallback />
      <SheetsAndDialogs c={c} />
      <Menus c={c} />
      <Toasts c={c} />
      <TabsBlock c={c} />
      <Disclosures c={c} />
      <Rails c={c} />
      <Navigation c={c} />
      <States c={c} />
      <BlocksSample c={c} />
      <Table c={c} />
    </>
  );
}

/* ───────────────────────────── sheets and dialogs ───────────────────────────── */

function SheetsAndDialogs({ c }: { c: C }) {
  const locale = useLocale();
  const ui = useT("ui");
  const [picker, setPicker] = useState(false);
  const [governorate, setGovernorate] = useState("baghdad");
  const [filters, setFilters] = useState(false);
  const [platforms, setPlatforms] = useState<string[]>(["playstation"]);
  const [conditions, setConditions] = useState<string[]>([]);
  const [remove, setRemove] = useState(false);
  const [reject, setReject] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = GOVERNORATES.find((g) => g.id === governorate)?.name[locale] ?? "";
  const toggle = (list: string[], value: string) => (list.includes(value) ? list.filter((item) => item !== value) : [...list, value]);

  return (
    <DsBlock id="overlays-layers" title={c.layers} note={c.layersNote}>
      <SpecimenGrid>
        <Specimen label='<Sheet presentation="picker"> (dialog from 768)'>
          <div className="grid justify-items-start gap-2">
            <Key id="ds-open-picker" aria-haspopup="dialog" iconEnd="caret-down" onClick={() => setPicker(true)}>
              {c.pickerTitle}
            </Key>
            <p className="type-caption text-ink-2">{fill(c.chosen, { name })}</p>
          </div>
        </Specimen>
        <Specimen label='<Sheet presentation="side" snapPoints={[0.5, 1]} footer>'>
          <Key id="ds-open-filters" aria-haspopup="dialog" icon="sliders-horizontal" onClick={() => setFilters(true)}>
            {c.filters}
          </Key>
        </Specimen>
        <Specimen label='<ConfirmDialog tone="destructive">'>
          <Key id="ds-open-delete" className="enabled:[--on:var(--red-ink)]" icon="trash" onClick={() => setRemove(true)}>
            {c.deleteAddress}
          </Key>
        </Specimen>
        <Specimen label="<ConfirmDialog impact reason={{ codes, noteRequired }}> (admin)">
          <div data-density="admin">
            <Key id="ds-open-reject" className="enabled:[--on:var(--red-ink)]" onClick={() => setReject(true)}>
              {c.rejectTransfer}
            </Key>
          </div>
        </Specimen>
      </SpecimenGrid>

      <Sheet open={picker} onClose={() => setPicker(false)} title={c.pickerTitle} description={c.pickerNote} presentation="picker" flush>
        <div role="radiogroup" aria-label={c.pickerTitle} className="grid">
          {GOVERNORATES.map((g) => (
            <Radio
              key={g.id}
              name="ds-governorate"
              value={g.id}
              checked={governorate === g.id}
              onChange={() => {
                setGovernorate(g.id);
                setPicker(false);
              }}
              label={g.name[locale]}
              end={<Price amountIqd={5000} size="sm" as="span" approx="off" />}
              className="border-b border-line px-(--gutter)"
            />
          ))}
        </div>
      </Sheet>

      <Sheet
        open={filters}
        onClose={() => setFilters(false)}
        title={c.filters}
        description={c.results}
        presentation="side"
        snapPoints={[0.5, 1]}
        footer={
          <>
            <Key
              onClick={() => {
                setPlatforms([]);
                setConditions([]);
              }}
            >
              {c.clearAll}
            </Key>
            <Key variant="ink" onClick={() => setFilters(false)}>
              {c.show24}
            </Key>
          </>
        }
      >
        <div className="grid gap-5 pb-2">
          <fieldset className="grid gap-2">
            <legend className="mb-2 type-label text-ink-2">{c.platform}</legend>
            <div className="chips">
              {PLATFORMS.map((p) => (
                <Chip key={p} selected={platforms.includes(p)} onClick={() => setPlatforms((list) => toggle(list, p))}>
                  {ui(`platform.${p}`)}
                </Chip>
              ))}
            </div>
          </fieldset>
          <fieldset className="grid gap-2">
            <legend className="mb-2 type-label text-ink-2">{c.condition}</legend>
            <div className="chips">
              {[
                ["new", c.newItem],
                ["used", c.usedItem],
              ].map(([value, label]) => (
                <Chip key={value} selected={conditions.includes(value)} onClick={() => setConditions((list) => toggle(list, value))}>
                  {label}
                </Chip>
              ))}
            </div>
          </fieldset>
        </div>
      </Sheet>

      <ConfirmDialog
        open={remove}
        onClose={() => setRemove(false)}
        tone="destructive"
        title={c.deleteQ}
        consequence={c.deleteWhat}
        confirmLabel={c.deleteAddress}
        onConfirm={() => {
          setRemove(false);
          toast.success(c.deleted);
        }}
      />

      {/* Opened from inside data-density="admin", so the dialog takes the admin density (inheritSurface). */}
      <ConfirmDialog
        open={reject}
        onClose={() => setReject(false)}
        tone="destructive"
        title={c.rejectQ}
        consequence={c.rejectWhat}
        confirmLabel={c.rejectTransfer}
        impact={[
          { label: c.impactOrder, value: c.impactOrderValue },
          { label: c.impactHeld, value: <Price amountIqd={749000} size="sm" as="span" approx="off" /> },
        ]}
        reason={{
          codes: [
            { value: "amount_mismatch", label: c.codeAmount },
            { value: "unreadable", label: c.codeUnreadable },
            { value: "duplicate", label: c.codeDuplicate },
          ],
          noteRequired: true,
          minLength: 10,
          hint: c.rejectHint,
        }}
        pending={busy}
        onConfirm={() => {
          // A stand-in for the request: the dialog stays open and busy until it "answers".
          setBusy(true);
          setTimeout(() => {
            setBusy(false);
            setReject(false);
            toast.success(c.rejected);
          }, 900);
        }}
      />
    </DsBlock>
  );
}

/* ───────────────────────────── menus ───────────────────────────── */

function Menus({ c }: { c: C }) {
  const [archived, setArchived] = useState(false);
  const [order, setOrder] = useState<"newest" | "priceLow" | "priceHigh">("newest");
  const [cancel, setCancel] = useState(false);
  const say = (item: string) => toast.info(fill(c.picked, { item }));
  const sortLabel = { newest: c.newest, priceLow: c.priceLow, priceHigh: c.priceHigh }[order];
  return (
    <DsBlock id="overlays-menus" title={c.menus} note={c.menusNote}>
      <SpecimenGrid>
        <Specimen label='<Menu label items> — "⋯" trigger, icons, checkbox, danger'>
          <div id="ds-menu" className="flex">
            <Menu
              label={c.orderActions}
              items={[
                { id: "edit", label: c.edit, icon: "pencil-simple", onSelect: () => say(c.edit) },
                { id: "copy", label: c.copyLink, icon: "link", onSelect: () => say(c.copyLink) },
                { id: "print", label: c.print, icon: "printer", hint: "Ctrl+P", onSelect: () => say(c.print) },
                { id: "s1", kind: "separator" },
                { id: "archived", kind: "checkbox", label: c.showArchived, checked: archived, onCheckedChange: setArchived },
                { id: "s2", kind: "separator" },
                { id: "cancel", label: c.cancelOrder, icon: "x-circle", tone: "danger", onSelect: () => setCancel(true) },
              ]}
            />
          </div>
        </Specimen>
        <Specimen label="trigger={(props) => <Key {...props} />} · radio rows · align=&quot;end&quot;">
          <div id="ds-menu-sort" className="flex">
            <Menu
              label={c.sortBy}
              title={c.sortBy}
              align="end"
              trigger={(props) => (
                <Key {...props} iconEnd="caret-down">
                  {sortLabel}
                </Key>
              )}
              items={(["newest", "priceLow", "priceHigh"] as const).map((value) => ({
                id: value,
                kind: "radio" as const,
                label: { newest: c.newest, priceLow: c.priceLow, priceHigh: c.priceHigh }[value],
                checked: order === value,
                onSelect: () => setOrder(value),
              }))}
            />
          </div>
        </Specimen>
      </SpecimenGrid>
      <ConfirmDialog
        open={cancel}
        onClose={() => setCancel(false)}
        tone="destructive"
        title={c.cancelQ}
        consequence={c.cancelWhat}
        confirmLabel={c.cancelOrder}
        impact={[{ label: c.stockBaghdad, value: "+1" }]}
        reason
        onConfirm={() => {
          setCancel(false);
          toast.success(c.cancelled);
        }}
      />
    </DsBlock>
  );
}

/* ───────────────────────────── toasts ───────────────────────────── */

function Toasts({ c }: { c: C }) {
  const ui = useT("ui");
  return (
    <DsBlock id="overlays-toasts" title={c.toasts} note={c.toastsNote}>
      <SpecimenRow>
        <Key size="sm" id="ds-toast-info" icon="info" onClick={() => toast.info(c.toastCopied)}>
          {c.info}
        </Key>
        <Key size="sm" id="ds-toast-success" icon="check-circle" onClick={() => toast.success(c.toastSaved)}>
          {c.success}
        </Key>
        <Key size="sm" id="ds-toast-warning" icon="warning" onClick={() => toast.warning(c.toastLow)}>
          {c.warning}
        </Key>
        <Key
          size="sm"
          id="ds-toast-error"
          icon="warning-circle"
          onClick={() => toast.error(c.toastError, { detail: c.toastErrorDetail, action: { label: ui("retry"), onAction: () => toast.success(c.toastSaved) } })}
        >
          {c.error}
        </Key>
        <Key
          size="sm"
          id="ds-toast-cart"
          icon="shopping-bag"
          onClick={() => toast.cart({ name: "Xbox Series X", variant: "1TB", art: "xbox-series-x--1", onUndo: () => toast.info(c.toastUndone) })}
        >
          {c.cart}
        </Key>
        <Key size="sm" variant="quiet" onClick={() => toast.dismiss()}>
          {c.dismissAll}
        </Key>
      </SpecimenRow>
      <p className="type-caption text-ink-2">
        <code dir="ltr">toast.info · success · warning · error(text, opts) · toast.cart({"{ name, variant, art, onUndo }"}) · toast.dismiss(id?)</code>
      </p>
    </DsBlock>
  );
}

/* ───────────────────────────── tabs ───────────────────────────── */

function TabsBlock({ c }: { c: C }) {
  const [params] = useSearchParams();
  const current = params.get("dstab") ?? "all";
  const href = (value: string) => {
    const next = new URLSearchParams(params);
    if (value === "all") next.delete("dstab");
    else next.set("dstab", value);
    const search = next.toString();
    return `?${search}#overlays-tabs`;
  };
  return (
    <DsBlock id="overlays-tabs" title={c.tabs} note={c.tabsNote}>
      <SpecimenGrid wide>
        <Specimen label='<Tabs items={[{ value, label, content }]} /> — panel tabs' wide>
          <Tabs
            aria-label={c.details}
            defaultValue="specs"
            panelClassName="type-body"
            items={[
              { value: "specs", label: c.specs, content: <p>{c.specsBody}</p> },
              { value: "box", label: c.inBox, content: <p>{c.inBoxBody}</p> },
              { value: "warranty", label: c.warrantyTab, content: <p>{c.warrantyBody}</p> },
            ]}
          />
        </Specimen>
        <Specimen label='<Tabs items={[{ value, label, href: "?dstab=…" }]} value /> — link tabs' wide>
          <Tabs
            aria-label={c.catalogue}
            value={current}
            items={[
              { value: "all", label: c.all, href: href("all") },
              { value: "consoles", label: c.consoles, href: href("consoles") },
              { value: "games", label: c.games, href: href("games") },
              { value: "accessories", label: c.accessories, count: 12, href: href("accessories") },
            ]}
          />
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── disclosure ───────────────────────────── */

function Disclosures({ c }: { c: C }) {
  return (
    <DsBlock id="overlays-disclosure" title={c.disclosure} note={c.disclosureNote}>
      <SpecimenGrid wide>
        <Specimen label="<Accordion exclusive items />">
          <Accordion
            exclusive
            defaultOpen={["q1"]}
            items={[
              { id: "q1", summary: c.q1, content: <p>{c.a1}</p> },
              { id: "q2", summary: c.q2, content: <p>{c.a2}</p> },
              { id: "q3", summary: c.q3, content: <p>{c.a3}</p> },
            ]}
          />
        </Specimen>
        <Specimen label='<Disclosure variant="panel" icon>'>
          <Disclosure variant="panel" icon="clipboard-text" summary={c.checkedQ}>
            <p>{c.checkedA}</p>
          </Disclosure>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── rails ───────────────────────────── */

const RAIL_ITEMS: { art: string; name: string }[] = [
  { art: "nintendo-switch-2--1", name: "Nintendo Switch 2" },
  { art: "playstation-5-pro--1", name: "PlayStation 5 Pro" },
  { art: "xbox-series-x--1", name: "Xbox Series X" },
  { art: "steam-deck-oled--1", name: "Steam Deck OLED" },
  { art: "rog-xbox-ally-x--1", name: "ROG Xbox Ally X" },
  { art: "dualsense--1", name: "DualSense" },
  { art: "mario-kart-world--1", name: "Mario Kart World" },
  { art: "ghost-of-yotei--1", name: "Ghost of Yōtei" },
  { art: "xbox-wireless-controller--1", name: "Xbox Wireless Controller" },
  { art: "nintendo-switch-2-pro-controller--1", name: "Nintendo Switch 2 Pro Controller" },
  { art: "lenovo-legion-go-2--1", name: "Lenovo Legion Go 2" },
  { art: "playstation-portal--1", name: "PlayStation Portal" },
];

function Rails({ c }: { c: C }) {
  return (
    <DsBlock id="overlays-rail" title={c.rails} note={c.railsNote}>
      <Specimen label="<Rail aria-label>{niches}</Rail>" wide>
        <Rail aria-label={c.railLabel}>
          {RAIL_ITEMS.map((item) => (
            <figure key={item.art} className="m-0 grid w-full content-start gap-2">
              <Niche ratio="1/1" tagZone={false}>
                <Render name={item.art} alt="" sizes="(min-width: 1200px) 190px, (min-width: 768px) 23vw, 43vw" />
              </Niche>
              <figcaption className="type-strong text-ink">
                <bdi>{item.name}</bdi>
              </figcaption>
            </figure>
          ))}
        </Rail>
      </Specimen>
    </DsBlock>
  );
}

/* ───────────────────────────── navigation ───────────────────────────── */

function Navigation({ c }: { c: C }) {
  const [page, setPage] = useState(6);
  const [shown, setShown] = useState(24);
  const [loading, setLoading] = useState(false);
  const more = () => {
    setLoading(true);
    setTimeout(() => {
      setShown((n) => Math.min(n + 12, 60));
      setLoading(false);
    }, 700);
  };
  return (
    <DsBlock id="overlays-nav" title={c.navigation} note={c.navigationNote}>
      <SpecimenGrid wide>
        <Specimen label="<Breadcrumbs items jsonLd? />">
          <Breadcrumbs
            items={[
              { label: c.home, href: "#overlays-nav" },
              { label: c.devices, href: "#overlays-nav" },
              { label: "PlayStation 5 Pro" },
            ]}
          />
        </Specimen>
        <Specimen label="<Pagination page pageCount href | onPage />">
          <Pagination page={page} pageCount={20} onPage={setPage} />
        </Specimen>
        <Specimen label="<ShowMore shown total onMore | href loading />">
          <ShowMore shown={shown} total={60} onMore={more} loading={loading} />
        </Specimen>
        <Specimen label="<ProgressSteps steps current={1} />">
          <ProgressSteps current={1} steps={[{ label: c.address, href: "#overlays-nav" }, { label: c.payment }, { label: c.review }]} />
        </Specimen>
        <Specimen label="<ProgressSteps current={3} /> — trade-in, five steps">
          <ProgressSteps
            current={3}
            steps={[{ label: c.device, href: "#overlays-nav" }, { label: c.state, href: "#overlays-nav" }, { label: c.photos, href: "#overlays-nav" }, { label: c.estimate }, { label: c.inspection }]}
          />
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── states ───────────────────────────── */

function States({ c }: { c: C }) {
  const [retrying, setRetrying] = useState(false);
  const retry = () => {
    setRetrying(true);
    setTimeout(() => setRetrying(false), 1200);
  };
  return (
    <DsBlock id="overlays-states" title={c.states} note={c.statesNote}>
      <SpecimenGrid wide>
        <Specimen label="<EmptyState title text action />">
          <EmptyState
            title={c.cartEmpty}
            text={c.cartEmptyHint}
            action={
              <Key size="sm" as="a" href="#overlays-states">
                {c.browse}
              </Key>
            }
          />
        </Specimen>
        <Specimen label='<EmptyState icon layout="stack" />'>
          <EmptyState
            icon="magnifying-glass"
            layout="stack"
            title={c.noResults}
            text={c.noResultsHint}
            action={
              <Key size="sm" as="a" href="#overlays-states">
                {c.clearSearch}
              </Key>
            }
          />
        </Specimen>
        <Specimen label="<ErrorState onRetry retrying />">
          <ErrorState onRetry={retry} retrying={retrying} />
        </Specimen>
        <Specimen label='<ErrorState title code="…" />'>
          <ErrorState title={c.recsFailed} onRetry={retry} retrying={retrying} code="7K4M-2Q9X" />
        </Specimen>
        <Specimen label='<OfflineBanner state="offline" pinned={false} /> · state="back"' wide>
          <div className="grid gap-2 overflow-hidden rounded-sm">
            <OfflineBanner state="offline" pinned={false} />
            <OfflineBanner state="back" pinned={false} />
          </div>
        </Specimen>
      </SpecimenGrid>
    </DsBlock>
  );
}

/* ───────────────────────────── blocks ───────────────────────────── */

type T3 = Record<Locale, string>;
const t3 = (ar: string, en: string, ckb: string): T3 => ({ ar, en, ckb });

/** A safe-fixes article in the shape the demo seed stores (one array per language). */
function sampleArticle(locale: Locale): Block[] {
  const L = (text: T3) => text[locale];
  return [
    { type: "art", name: "playstation-5-slim--1", alt: "PlayStation 5 Slim" },
    { type: "h2", text: L(t3("الجهاز لا يشتغل", "The console will not turn on", "ئامێرەکە داناگیرسێت")) },
    {
      type: "callout",
      tone: "info",
      text: L(
        t3(
          "هذه خطوات آمنة لا تتطلب فتح الجهاز. إن لم تحلّ المشكلة فالخطوة التالية فحص لدى فني، لا محاولة إصلاح في البيت.",
          "These are safe steps that do not involve opening the console. If they do not solve the problem, the next step is a check by a technician, not a home repair.",
          "ئەمانە هەنگاوی سەلامەتن و پێویستیان بە کردنەوەی ئامێرەکە نییە. ئەگەر کێشەکەیان چارەسەر نەکرد، هەنگاوی داهاتوو پشکنینە لەلایەن تەکنیکارەوە، نەک هەوڵی چاککردنەوە لە ماڵەوە.",
        ),
      ),
    },
    {
      type: "steps",
      items: [
        {
          title: L(t3("افصل الكهرباء دقيقة كاملة", "Unplug it for a full minute", "کارەباکەی بۆ خولەکێکی تەواو بپچڕێنە")),
          text: L(
            t3(
              "ثم صِل كيبل الطاقة الأصلي بمقبس في الجدار مباشرة.",
              "Then plug the original power cable straight into a wall socket.",
              "پاشان کێبڵی کارەبای ئەسڵی ڕاستەوخۆ بە پریزی دیوارەکەوە ببەستە.",
            ),
          ),
        },
        { title: L(t3("جرّب كيبلاً ومقبساً آخرين", "Try another cable and socket", "کێبڵ و پریزێکی تر تاقی بکەرەوە")) },
        {
          title: L(t3("لاحظ لون المؤشر", "Look at the light", "سەیری ڕەنگی گڵۆپەکە بکە")),
          text: L(t3("الجدول أدناه يقول ما يعنيه.", "The table below says what it means.", "خشتەکەی خوارەوە دەڵێت مانای چییە.")),
        },
      ],
    },
    {
      type: "table",
      head: [L(t3("المؤشر", "Light", "گڵۆپ")), L(t3("المعنى", "Meaning", "مانا"))],
      rows: [
        [L(t3("أبيض ثابت", "Solid white", "سپیی جێگیر")), L(t3("الجهاز يعمل", "The console is on", "ئامێرەکە کار دەکات"))],
        [L(t3("برتقالي ثابت", "Solid orange", "پرتەقاڵیی جێگیر")), L(t3("وضع الراحة", "Rest mode", "دۆخی پشوو"))],
        [L(t3("أزرق يومض", "Blinking blue", "شینی چرپەدار")), L(t3("الجهاز يبدأ التشغيل", "The console is starting", "ئامێرەکە دادەگیرسێت"))],
      ],
    },
    {
      type: "callout",
      tone: "danger",
      title: L(t3("توقف فوراً في هذه الحالات", "Stop at once in these cases", "لەم حاڵەتانەدا دەستبەجێ بوەستە")),
      text: L(
        t3(
          "رائحة احتراق، شرر، دخان، أو انطفاء متكرر مع صوت طقطقة: افصل الكهرباء ولا تعد التشغيل. لا تفتح الجهاز ولا مزوّد الطاقة إطلاقاً. احجز صيانة.",
          "A burning smell, sparks, smoke, or repeated shutdowns with a clicking sound: unplug the console and do not switch it on again. Never open the console or its power supply. Book a repair.",
          "بۆنی سووتان، پریشک، دووکەڵ، یان کوژانەوەی دووبارە لەگەڵ دەنگی تەقەتەق: کارەباکە بپچڕێنە و دووبارە دایمەگیرسێنە. هەرگیز ئامێرەکە یان دابینکەری کارەباکەی مەکەرەوە. چاککردنەوە تۆمار بکە.",
        ),
      ),
    },
    {
      type: "callout",
      tone: "warning",
      text: L(
        t3(
          "فتح الجهاز بنفسك قد يُسقط الضمان.",
          "Opening the console yourself can void the warranty.",
          "کردنەوەی ئامێرەکە بە خۆت لەوانەیە گەرەنتییەکە لەناو ببات.",
        ),
      ),
    },
    { type: "h2", text: L(t3("ما تذكره عند حجز الصيانة", "What to tell us when you book a repair", "ئەوەی لە کاتی تۆمارکردنی چاککردنەوە دەیڵێیت")) },
    {
      type: "ul",
      items: [
        L(t3("ما الذي حدث قبل أن يتوقف", "What happened before it stopped", "چی ڕوویدا پێش ئەوەی بوەستێت")),
        L(t3("لون المؤشر وما جرّبته من الخطوات", "The light colour and which steps you tried", "ڕەنگی گڵۆپەکە و کام هەنگاوت تاقی کردەوە")),
      ],
    },
  ];
}

function BlocksSample({ c }: { c: C }) {
  const locale = useLocale();
  const blocks = useMemo(() => sampleArticle(locale), [locale]);
  return (
    <DsBlock id="overlays-blocks" title={c.blocks} note={c.blocksNote}>
      <Specimen label='<Blocks blocks headingLevel={3} /> — h2 · p · ul · steps · callout info/warning/danger · table · art' wide>
        <div className="max-w-[44rem]">
          <Blocks blocks={blocks} headingLevel={3} artSizes="(min-width: 768px) 640px, 92vw" />
        </div>
      </Specimen>
    </DsBlock>
  );
}

/* ───────────────────────────── table ───────────────────────────── */

type Method = "cod" | "zaincash" | "bank" | "wallet";
type OrderState = "paid" | "pending" | "shipped" | "new" | "cancelled" | "refunded";
type OrderRow = { id: string; ref: string; governorate: string; method: Method; status: OrderState; placedAt: number; amountIqd: number };

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 11, 9, 30);
/** Twelve example orders: references, amounts and dates are made up for the specimen (the page says so). */
const ROWS: OrderRow[] = [
  { id: "o1", ref: "TT-7K4M2Q9X", governorate: "baghdad", method: "cod", status: "new", placedAt: T0, amountIqd: 754000 },
  { id: "o2", ref: "TT-3HD8P2LQ", governorate: "basra", method: "zaincash", status: "pending", placedAt: T0 - 0.2 * DAY, amountIqd: 1104000 },
  { id: "o3", ref: "TT-9QW4N7ZT", governorate: "erbil", method: "bank", status: "paid", placedAt: T0 - 0.6 * DAY, amountIqd: 450000 },
  { id: "o4", ref: "TT-2LM8C4RA", governorate: "najaf", method: "wallet", status: "shipped", placedAt: T0 - 1.1 * DAY, amountIqd: 89000 },
  { id: "o5", ref: "TT-6TR3V9KB", governorate: "nineveh", method: "cod", status: "shipped", placedAt: T0 - 1.4 * DAY, amountIqd: 694000 },
  { id: "o6", ref: "TT-4XN7D2PE", governorate: "karbala", method: "zaincash", status: "refunded", placedAt: T0 - 2 * DAY, amountIqd: -445000 },
  { id: "o7", ref: "TT-8BC5H1QW", governorate: "duhok", method: "cod", status: "cancelled", placedAt: T0 - 2.3 * DAY, amountIqd: 129000 },
  { id: "o8", ref: "TT-1PZ6K8MS", governorate: "sulaymaniyah", method: "bank", status: "paid", placedAt: T0 - 3 * DAY, amountIqd: 904000 },
  { id: "o9", ref: "TT-5GV2J7LN", governorate: "baghdad", method: "cod", status: "pending", placedAt: T0 - 3.5 * DAY, amountIqd: 64000 },
  { id: "o10", ref: "TT-3WE9T4YU", governorate: "basra", method: "wallet", status: "paid", placedAt: T0 - 4.2 * DAY, amountIqd: 1239000 },
  { id: "o11", ref: "TT-7QA1F5ZC", governorate: "erbil", method: "cod", status: "shipped", placedAt: T0 - 5 * DAY, amountIqd: 214000 },
  { id: "o12", ref: "TT-2NS8R3XD", governorate: "baghdad", method: "zaincash", status: "new", placedAt: T0 - 6.1 * DAY, amountIqd: 379000 },
];

const TONE: Record<OrderState, "ok" | "warn" | "info" | "bad" | "neutral"> = {
  paid: "ok",
  pending: "warn",
  shipped: "info",
  new: "neutral",
  cancelled: "neutral",
  refunded: "bad",
};

function Table({ c }: { c: C }) {
  const f = useFormat();
  const locale = useLocale();
  const [sort, setSort] = useState<DataSort>({ key: "placedAt", dir: "desc" });
  const [selected, setSelected] = useState<string[]>([]);
  const [status, setStatus] = useState<"ready" | "loading" | "empty" | "error">("ready");
  const [cancelMany, setCancelMany] = useState(false);

  const rows = useMemo(() => {
    const value = (row: OrderRow): number | string => (sort.key === "amountIqd" ? row.amountIqd : sort.key === "placedAt" ? row.placedAt : row.ref);
    const sorted = [...ROWS].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const order = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return sort.dir === "asc" ? order : -order;
    });
    return status === "empty" ? [] : sorted;
  }, [sort, status]);

  const methodLabel: Record<Method, string> = { cod: c.cod, zaincash: c.zaincash, bank: c.bank, wallet: c.wallet };
  const statusLabel: Record<OrderState, string> = {
    paid: c.stPaid,
    pending: c.stPending,
    shipped: c.stShipped,
    new: c.stNew,
    cancelled: c.stCancelled,
    refunded: c.stRefunded,
  };
  const columns: DataColumn<OrderRow>[] = [
    { key: "ref", header: c.colOrder, sortable: true, className: "whitespace-nowrap", cell: (row) => <bdi className="nums">{row.ref}</bdi> },
    {
      key: "governorate",
      header: c.colGov,
      className: "whitespace-nowrap",
      cell: (row) => GOVERNORATES.find((g) => g.id === row.governorate)?.name[locale] ?? row.governorate,
    },
    { key: "method", header: c.colMethod, className: "whitespace-nowrap", cell: (row) => methodLabel[row.method] },
    { key: "status", header: c.colStatus, className: "whitespace-nowrap", cell: (row) => <Status tone={TONE[row.status]}>{statusLabel[row.status]}</Status> },
    { key: "placedAt", header: c.colDate, sortable: true, firstDir: "desc", className: "whitespace-nowrap", cell: (row) => <span className="nums">{f.date(row.placedAt, "short")}</span> },
    {
      key: "amountIqd",
      header: c.colAmount,
      numeric: true,
      sortable: true,
      firstDir: "desc",
      negative: (row) => row.amountIqd < 0,
      cell: (row) => (row.amountIqd < 0 ? `−${f.number(-row.amountIqd)}` : f.number(row.amountIqd)),
    },
  ];

  return (
    <DsBlock id="overlays-table" title={c.table} note={c.tableNote}>
      <KeyBank
        kind="segment"
        aria-label={c.tableState}
        items={[
          { value: "ready", label: c.ready },
          { value: "loading", label: c.loading },
          { value: "empty", label: c.empty },
          { value: "error", label: c.failed },
        ]}
        value={status}
        onChange={(value) => setStatus(value as typeof status)}
      />
      <DataTable
        caption={c.orders}
        columns={columns}
        rows={rows}
        rowKey={(row) => row.id}
        rowLabel={(row) => row.ref}
        sort={sort}
        onSort={setSort}
        selected={selected}
        onSelectedChange={setSelected}
        status={status === "loading" ? "loading" : status === "error" ? "error" : "ready"}
        error={<ErrorState onRetry={() => setStatus("ready")} />}
        bulkActions={(ids) => (
          <>
            <Key size="sm" icon="printer" onClick={() => toast.success(c.labelsPrinted)}>
              {c.printLabels}
            </Key>
            <Key size="sm" className="enabled:[--on:var(--red-ink)]" onClick={() => setCancelMany(ids.length > 0)}>
              {c.cancelOrders}
            </Key>
          </>
        )}
      />
      <ConfirmDialog
        open={cancelMany}
        onClose={() => setCancelMany(false)}
        tone="destructive"
        title={fill(c.cancelManyQ, { count: f.number(selected.length) })}
        consequence={c.cancelManyWhat}
        confirmLabel={c.cancelOrders}
        reason={{
          codes: [
            { value: "customer_request", label: c.reasonCustomer },
            { value: "out_of_stock", label: c.reasonStock },
            { value: "fraud_suspected", label: c.reasonFraud },
          ],
        }}
        onConfirm={() => {
          setCancelMany(false);
          setSelected([]);
          toast.success(c.cancelled);
        }}
      />
    </DsBlock>
  );
}
