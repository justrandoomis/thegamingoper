import { defineMessages } from "../translate";

/**
 * "ui-card" — the product card's own words (app/ui/ProductCard.tsx; Design System v2 §4.11). Loaded on every page by
 * the root loader, like every "ui-*" namespace. Read with `useT("ui-card")`.
 *
 *   soon        a product announced but not in stock yet ("preorder" in the data). The cart refuses it (no pre-order
 *               flow), so the card says «قريباً» and offers no add button — never "pre-order".
 *   soonOn      the action slot of a coming-soon card: «يصدر 19 تشرين الثاني» (the day comes from the data)
 *   soonNote    under it: when it can be ordered — «الطلب يفتح عند وصوله» (v2 §9, never a promise)
 *   outNow      the action slot of a sold-out card (no notify-me: there is no back-in-stock service)
 *   imageFailed the empty well's line when the picture did not load, with a retry button (imageRetry)
 *
 * Same keys in all three locales (tests/i18n.test.ts). The Sorani column needs a native reader (docs/DESIGN.md §11).
 */
export default defineMessages({
  ar: {
    soon: "قريباً",
    soonOn: "يصدر {date}",
    soonNote: "الطلب يفتح عند وصوله",
    outNow: "نفد حالياً",
    imageFailed: "تعذّر تحميل الصورة",
    imageRetry: "أعد تحميل الصورة",
  },
  en: {
    soon: "Coming soon",
    soonOn: "Out {date}",
    soonNote: "Orders open when it arrives",
    outNow: "Sold out",
    imageFailed: "The picture did not load",
    imageRetry: "Load the picture again",
  },
  ckb: {
    soon: "بەم زووانە",
    soonOn: "لە {date} دەردەچێت",
    soonNote: "داواکردن کاتێک دەکرێتەوە کە دەگات",
    outNow: "ئێستا نەماوە",
    imageFailed: "وێنەکە بار نەبوو",
    imageRetry: "وێنەکە دووبارە بار بکەرەوە",
  },
});
