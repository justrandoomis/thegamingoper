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
    brand: {
      name: "تەمتەم",
      title: "تەمتەم گەیمز — TamTam Games",
      tagline: "فرۆشگای تەواوی تۆ بۆ جیهانی یاری",
    },
  },
});
