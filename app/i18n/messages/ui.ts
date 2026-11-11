import { defineMessages } from "../translate";

/**
 * "ui" — strings used inside design-system components (labels for controls that have no visible text,
 * generic states). Loaded on every page by the root loader together with every other namespace whose
 * name starts with "ui-". Read with `useT("ui")`.
 *
 * Same keys in all three locales. The Sorani column must be reviewed by a native reader before launch
 * (docs/DESIGN.md §11).
 */
export default defineMessages({
  ar: {
    close: "إغلاق",
    back: "رجوع",
    next: "التالي",
    previous: "السابق",
    retry: "أعد المحاولة",
    loading: "جارٍ التحميل",
    required: "مطلوب",
    optional: "اختياري",
    field: {
      optional: "(اختياري)",
      choose: "اختر",
      summary: { one: "تحقّق من حقل واحد:", two: "تحقّق من حقلين:", few: "تحقّق من {count} حقول:", many: "تحقّق من {count} حقلاً:", other: "تحقّق من {count} حقل:" },
    },
    stepper: {
      label: "الكمية",
      decrease: "أنقص الكمية",
      increase: "زد الكمية",
      limit: "بقي {count} فقط",
    },
    price: {
      approx: "≈ {amount} · الدفع بالدينار العراقي",
      rateTitle: "سعر الصرف",
      noRate: "لا يتوفر سعر صرف الآن. الأسعار بالدينار العراقي.",
      was: "السعر قبل التخفيض",
      now: "السعر الآن",
      demoRate: "سعر تجريبي للعرض",
      aria: "{amount} دينار عراقي",
    },
    tag: {
      new: "جديد",
      used: "مستعمل",
      preorder: "قريباً",
      refurbished: "مجدَّد",
      soon: "قريباً",
      sale: "تخفيض",
      out: "نفد",
      photo: "صورة توضيحية",
    },
    stock: {
      in: "متوفر",
      low: "بقي {count}",
      out: "نفد",
      outNow: "نفد حالياً",
    },
    chip: {
      remove: "أزل {label}",
    },
    socket: {
      add: "أضف {name} إلى السلة",
      added: "أُضيف {name} إلى السلة",
      addedMore: "{name} في السلة. أضف قطعة أخرى",
    },
    link: {
      external: "يفتح في نافذة جديدة",
    },
    platform: {
      nintendo: "Nintendo",
      playstation: "PlayStation",
      xbox: "Xbox",
      handheld: "الأجهزة المحمولة",
    },
  },
  en: {
    close: "Close",
    back: "Back",
    next: "Next",
    previous: "Previous",
    retry: "Try again",
    loading: "Loading",
    required: "Required",
    optional: "Optional",
    field: {
      optional: "(optional)",
      choose: "Choose",
      summary: { one: "Check 1 field:", other: "Check {count} fields:" },
    },
    stepper: {
      label: "Quantity",
      decrease: "Decrease quantity",
      increase: "Increase quantity",
      limit: "Only {count} left",
    },
    price: {
      approx: "≈ {amount} · You pay in Iraqi dinars",
      rateTitle: "Exchange rate",
      noRate: "No exchange rate right now. Prices are in Iraqi dinars.",
      was: "Was",
      now: "Now",
      demoRate: "demo rate",
      aria: "{amount} Iraqi dinars",
    },
    tag: {
      new: "New",
      used: "Used",
      preorder: "Coming soon",
      refurbished: "Refurbished",
      soon: "Coming soon",
      sale: "Sale",
      out: "Sold out",
      photo: "Illustration",
    },
    stock: {
      in: "In stock",
      low: "Only {count} left",
      out: "Sold out",
      outNow: "Sold out",
    },
    chip: {
      remove: "Remove {label}",
    },
    socket: {
      add: "Add {name} to cart",
      added: "{name} added to cart",
      addedMore: "{name} is in your cart. Add another",
    },
    link: {
      external: "opens in a new tab",
    },
    platform: {
      nintendo: "Nintendo",
      playstation: "PlayStation",
      xbox: "Xbox",
      handheld: "Handheld PCs",
    },
  },
  ckb: {
    close: "داخستن",
    back: "گەڕانەوە",
    next: "دواتر",
    previous: "پێشوو",
    retry: "دووبارە هەوڵ بدەوە",
    loading: "بار دەکرێت",
    required: "پێویستە",
    optional: "ئارەزوومەندانە",
    field: {
      optional: "(ئارەزوومەندانە)",
      choose: "هەڵبژێرە",
      summary: { one: "{count} خانە بپشکنە:", other: "{count} خانە بپشکنە:" },
    },
    stepper: {
      label: "ژمارە",
      decrease: "کەمی بکەرەوە",
      increase: "زیادی بکە",
      limit: "تەنها {count} ماوە",
    },
    price: {
      approx: "≈ {amount} · پارەدان بە دیناری عێراقی",
      rateTitle: "نرخی ئاڵوگۆڕ",
      noRate: "ئێستا نرخی ئاڵوگۆڕ بەردەست نییە. نرخەکان بە دیناری عێراقین.",
      was: "نرخی پێشوو",
      now: "نرخی ئێستا",
      demoRate: "نرخی تاقیکاری",
      aria: "{amount} دیناری عێراقی",
    },
    tag: {
      new: "نوێ",
      used: "بەکارهاتوو",
      preorder: "بەم زووانە",
      refurbished: "نۆژەنکراوە",
      soon: "بەم زووانە",
      sale: "داشکاندن",
      out: "نەماوە",
      photo: "وێنەی ڕوونکردنەوە",
    },
    stock: {
      in: "بەردەستە",
      low: "تەنها {count} ماوە",
      out: "نەماوە",
      outNow: "ئێستا نەماوە",
    },
    chip: {
      remove: "{label} لابە",
    },
    socket: {
      add: "{name} بخە ناو سەبەتە",
      added: "{name} خرایە ناو سەبەتە",
      addedMore: "{name} لە سەبەتەدایە. دانەیەکی تر زیاد بکە",
    },
    link: {
      external: "لە پەنجەرەیەکی نوێدا دەکرێتەوە",
    },
    platform: {
      nintendo: "Nintendo",
      playstation: "PlayStation",
      xbox: "Xbox",
      handheld: "ئامێرە دەستییەکان",
    },
  },
});
