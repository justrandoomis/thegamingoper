import { defineMessages } from "../translate";

/**
 * "ui-overlays" — strings inside the overlay, navigation and state primitives of app/ui (Sheet, Dialog, Toast, Menu,
 * Tabs, Rail, Breadcrumbs, Pagination, ProgressSteps, EmptyState, ErrorState, OfflineBanner, Blocks, DataTable).
 * Loaded on every page by the root loader (every "ui-*" namespace is). Read with `useT("ui-overlays")`.
 *
 * Copy voice: docs/DESIGN.md §11 — plain, specific, active; a key says what it does; no exclamation marks.
 * The Sorani column must be reviewed by a native reader before launch.
 */
export default defineMessages({
  ar: {
    sheet: {
      expand: "كبّر اللوحة",
      collapse: "صغّر اللوحة",
    },
    dialog: {
      cancel: "ارجع",
      reason: "السبب",
      reasonShort: "اكتب السبب في {min} أحرف على الأقل.",
      code: "سبب الإجراء",
      codePick: "اختر السبب",
      codeMissing: "اختر سبباً من القائمة.",
      note: "ملاحظة",
      impact: "ما الذي سيتغيّر",
    },
    toast: {
      region: "الإشعارات",
      added: "أُضيف إلى السلة",
      undo: "تراجع",
      dismiss: "أغلق الإشعار",
      viewCart: "عرض السلة",
    },
    menu: {
      more: "إجراءات أخرى",
    },
    rail: {
      previous: "اعرض العناصر السابقة",
      next: "اعرض العناصر التالية",
    },
    breadcrumbs: {
      label: "مسار التنقل",
      expand: "اعرض المسار كاملاً",
    },
    pagination: {
      label: "الصفحات",
      previous: "الصفحة السابقة",
      next: "الصفحة التالية",
      page: "الصفحة {page}",
      status: "الصفحة {page} من {count}",
      more: "اعرض المزيد",
      shown: "عرضنا {shown} من {total}",
      all: "عرضنا كل النتائج ({total}).",
      shownProducts: { one: "عرضنا {shown} من منتج واحد", two: "عرضنا {shown} من منتجين", few: "عرضنا {shown} من {total} منتجات", many: "عرضنا {shown} من {total} منتجاً", other: "عرضنا {shown} من {total} منتج" },
      moreProducts: { one: "اعرض منتجاً آخر", two: "اعرض منتجين آخرين", few: "اعرض {n} منتجات أخرى", many: "اعرض {n} منتجاً آخر", other: "اعرض {n} منتج آخر" },
      end: "لا يوجد المزيد لعرضه",
    },
    steps: {
      label: "الخطوات",
      done: "مكتملة",
      position: "الخطوة {n} من {total}",
    },
    error: {
      title: "تعذّر تحميل هذا الجزء.",
      text: "تحقّق من الاتصال، ثم أعد المحاولة.",
      code: "رمز الخطأ: {code}",
      offlineTitle: "لا يوجد اتصال بالإنترنت",
      offlineText: "لا يوجد اتصال بالإنترنت. أعد المحاولة عند عودة الاتصال.",
    },
    offline: {
      store: "لا يوجد اتصال. سلتك محفوظة على هذا الجهاز.",
      form: "لا يوجد اتصال. ما كتبته باقٍ في الصفحة؛ أرسله عند عودة الاتصال.",
      generic: "لا يوجد اتصال. تحقّق من الشبكة، ثم أعد المحاولة.",
      back: "عاد الاتصال.",
    },
    blocks: {
      info: "معلومة",
      warning: "تنبيه",
      danger: "خطر",
    },
    table: {
      selectAll: "اختر كل الصفوف في هذه الصفحة",
      selectRow: "اختر {label}",
      selected: {
        zero: "لم تختر أي صف",
        one: "اخترت صفاً واحداً",
        two: "اخترت صفين",
        few: "اخترت {count} صفوف",
        many: "اخترت {count} صفاً",
        other: "اخترت {count} صف",
      },
      clear: "ألغِ التحديد",
      bulk: "إجراءات على الصفوف المختارة",
      sortAsc: "رتّب تصاعدياً",
      sortDesc: "رتّب تنازلياً",
      loading: "جارٍ تحميل الصفوف",
      empty: "لا توجد صفوف في هذا العرض.",
    },
  },
  en: {
    sheet: {
      expand: "Expand the panel",
      collapse: "Shrink the panel",
    },
    dialog: {
      cancel: "Go back",
      reason: "Reason",
      reasonShort: "Write the reason in at least {min} characters.",
      code: "Reason code",
      codePick: "Choose a reason",
      codeMissing: "Choose a reason from the list.",
      note: "Note",
      impact: "What changes",
    },
    toast: {
      region: "Notifications",
      added: "Added to cart",
      undo: "Undo",
      dismiss: "Dismiss the notification",
      viewCart: "View cart",
    },
    menu: {
      more: "More actions",
    },
    rail: {
      previous: "Show the previous items",
      next: "Show the next items",
    },
    breadcrumbs: {
      label: "Breadcrumb",
      expand: "Show the whole path",
    },
    pagination: {
      label: "Pages",
      previous: "Previous page",
      next: "Next page",
      page: "Page {page}",
      status: "Page {page} of {count}",
      more: "Show more",
      shown: "Showing {shown} of {total}",
      all: "Showing all results ({total}).",
      shownProducts: { one: "Showing {shown} of {total} product", other: "Showing {shown} of {total} products" },
      moreProducts: { one: "Show {n} more product", other: "Show {n} more products" },
      end: "Nothing more to show",
    },
    steps: {
      label: "Steps",
      done: "done",
      position: "Step {n} of {total}",
    },
    error: {
      title: "This part did not load.",
      text: "Check your connection, then try again.",
      code: "Error code: {code}",
      offlineTitle: "No internet connection",
      offlineText: "No internet connection. Try again when you are back online.",
    },
    offline: {
      store: "No connection. Your cart is saved on this device.",
      form: "No connection. What you typed stays on the page; send it when you are back online.",
      generic: "No connection. Check your network, then try again.",
      back: "You are back online.",
    },
    blocks: {
      info: "Note",
      warning: "Warning",
      danger: "Danger",
    },
    table: {
      selectAll: "Select every row on this page",
      selectRow: "Select {label}",
      selected: {
        one: "{count} row selected",
        other: "{count} rows selected",
      },
      clear: "Clear the selection",
      bulk: "Actions for the selected rows",
      sortAsc: "Sort ascending",
      sortDesc: "Sort descending",
      loading: "Loading rows",
      empty: "There are no rows in this view.",
    },
  },
  ckb: {
    sheet: {
      expand: "پانێڵەکە گەورە بکە",
      collapse: "پانێڵەکە بچووک بکەرەوە",
    },
    dialog: {
      cancel: "بگەڕێوە",
      reason: "هۆکار",
      reasonShort: "هۆکارەکە لانیکەم بە {min} پیت بنووسە.",
      code: "کۆدی هۆکار",
      codePick: "هۆکارێک هەڵبژێرە",
      codeMissing: "هۆکارێک لە لیستەکە هەڵبژێرە.",
      note: "تێبینی",
      impact: "چی دەگۆڕێت",
    },
    toast: {
      region: "ئاگادارکردنەوەکان",
      added: "خرایە ناو سەبەتە",
      undo: "پاشگەزبوونەوە",
      dismiss: "ئاگادارکردنەوەکە دابخە",
      viewCart: "سەبەتە ببینە",
    },
    menu: {
      more: "کرداری زیاتر",
    },
    rail: {
      previous: "بابەتەکانی پێشوو پیشان بدە",
      next: "بابەتەکانی دواتر پیشان بدە",
    },
    breadcrumbs: {
      label: "ڕێڕەوی گەڕان",
      expand: "هەموو ڕێڕەوەکە پیشان بدە",
    },
    pagination: {
      label: "پەڕەکان",
      previous: "پەڕەی پێشوو",
      next: "پەڕەی دواتر",
      page: "پەڕەی {page}",
      status: "پەڕەی {page} لە {count}",
      more: "زیاتر پیشان بدە",
      shown: "{shown} لە {total} پیشان دراوە",
      all: "هەموو ئەنجامەکان پیشان دران ({total}).",
      shownProducts: { one: "{shown} لە {total} بەرهەم پیشان دراوە", other: "{shown} لە {total} بەرهەم پیشان دراوە" },
      moreProducts: { one: "{n} بەرهەمی تر پیشان بدە", other: "{n} بەرهەمی تر پیشان بدە" },
      end: "هیچی تر نییە بۆ پیشاندان",
    },
    steps: {
      label: "هەنگاوەکان",
      done: "تەواوبوو",
      position: "هەنگاوی {n} لە {total}",
    },
    error: {
      title: "ئەم بەشە بار نەبوو.",
      text: "پەیوەندییەکەت بپشکنە، پاشان دووبارە هەوڵ بدەوە.",
      code: "کۆدی هەڵە: {code}",
      offlineTitle: "هێڵی ئینتەرنێت نییە",
      offlineText: "هێڵی ئینتەرنێت نییە. کاتێک هێڵ گەڕایەوە دووبارە هەوڵ بدەوە.",
    },
    offline: {
      store: "هێڵی ئینتەرنێت نییە. سەبەتەکەت لەسەر ئەم ئامێرە پاشەکەوت کراوە.",
      form: "هێڵی ئینتەرنێت نییە. ئەوەی نووسیوتە لە پەڕەکەدا ماوە؛ کاتێک هێڵ گەڕایەوە بینێرە.",
      generic: "هێڵی ئینتەرنێت نییە. تۆڕەکەت بپشکنە، پاشان دووبارە هەوڵ بدەوە.",
      back: "هێڵی ئینتەرنێت گەڕایەوە.",
    },
    blocks: {
      info: "زانیاری",
      warning: "ئاگاداری",
      danger: "مەترسی",
    },
    table: {
      selectAll: "هەموو ڕیزەکانی ئەم پەڕەیە هەڵبژێرە",
      selectRow: "{label} هەڵبژێرە",
      selected: {
        one: "{count} ڕیز هەڵبژێردرا",
        other: "{count} ڕیز هەڵبژێردران",
      },
      clear: "هەڵبژاردنەکە لابە",
      bulk: "کردار بۆ ڕیزە هەڵبژێردراوەکان",
      sortAsc: "بە سەرەوە ڕیز بکە",
      sortDesc: "بە خوارەوە ڕیز بکە",
      loading: "ڕیزەکان بار دەکرێن",
      empty: "هیچ ڕیزێک لەم پیشاندانەدا نییە.",
    },
  },
});
