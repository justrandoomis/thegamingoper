import { defineMessages } from "../translate";

/**
 * "ui" — strings used inside design-system components (labels for controls that have no visible text,
 * generic states). Loaded on every page by the root loader together with every other namespace whose
 * name starts with "ui-". Read with `useT("ui")`.
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
  },
});
