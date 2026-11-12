import { defineMessages } from "../translate";

/**
 * "common" — strings used by the shell on every page (brand, navigation, generic actions and states).
 * Loaded by the root loader. Keep it small: page-specific copy belongs in its own namespace file.
 * Every key must exist in all three locales (tests/i18n.test.ts enforces this).
 */
export default defineMessages({
  ar: {
    brand: {
      name: "طمطم",
      title: "طمطم للألعاب — TamTam Games",
      tagline: "متجرك الشامل لعالم الألعاب",
    },
  },
  en: {
    brand: {
      name: "TamTam",
      title: "TamTam Games",
      tagline: "Your complete store for the world of gaming",
    },
  },
  ckb: {
    // The brand is «طمطم» in Sorani too, as the logo writes it (Design System v2 §9; the owner decides between «طمطم»
    // and «تەمتەم», §13 #12 — swap the wordmark with these strings if the answer is «تەمتەم»).
    brand: {
      name: "طمطم",
      title: "طمطم گەیمز — TamTam Games",
      tagline: "فرۆشگای تەواوی تۆ بۆ جیهانی یاری",
    },
  },
});
