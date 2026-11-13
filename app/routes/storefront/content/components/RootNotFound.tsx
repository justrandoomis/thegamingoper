import { Icon } from "~/art/Icon";
import { LOCALES, localePath, type Locale } from "~/lib/locales";
import { TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import type { Platform } from "~/ui/PlatformLed";
import { NotFoundView, type NotFoundWords } from "./NotFoundView";

/**
 * The store's 404 drawn by the ROOT boundary (app/root.tsx) — when something above the storefront shell failed, so
 * there is no shell, no navigation data and maybe no strings. The same view as the shell's 404 (./NotFoundView, client
 * note 11), from what this boundary can rely on: the words copied below, a plain GET search (no suggestions — they
 * need the shell), the four platforms with their device glyphs and no counts (nothing is invented; the catalogue was
 * not read), and plain document links in the page's language. Rendered inside its own <main> (the shell's is not there).
 */
export function RootNotFound({ locale }: { locale: Locale }) {
  const words = ROOT_NOT_FOUND_WORDS[locale];
  return (
    <main className="cnf-root" lang={LOCALES[locale].bcp47} dir={LOCALES[locale].dir}>
      <NotFoundView
        words={words}
        documentLocale={locale}
        search={
          <form method="get" action={localePath("/search", locale)} role="search">
            <TextField
              type="search"
              name="q"
              label={words.searchLabel}
              hideLabel
              placeholder={words.searchPlaceholder}
              autoComplete="off"
              enterKeyHint="search"
              maxLength={120}
              end={<IconKey type="submit" icon="magnifying-glass" label={words.searchSubmit} variant="plain" />}
            />
          </form>
        }
        platforms={ROOT_PLATFORMS.map((platform) => ({
          platform,
          to: `/platform/${platform}`,
          name: words.platforms[platform],
          art: <Icon name={`device-${platform}`} size={40} className="cnf__glyph" />,
        }))}
      />
    </main>
  );
}

/** The four doors, in the navigation's order. */
const ROOT_PLATFORMS = ["nintendo", "playstation", "xbox", "handheld"] as const satisfies readonly Platform[];

export type RootNotFoundWords = NotFoundWords & { searchLabel: string; searchPlaceholder: string; searchSubmit: string; platforms: Record<Platform, string> };

/**
 * The words, copied (this boundary must render even when the strings never arrived) — word for word the shell's
 * `error.*` and `search.*` (app/i18n/messages/shell.ts) and the kit's `platform.*` (ui.ts); tests/content.test.ts
 * compares them, so a change there fails until it is made here too.
 */
export const ROOT_NOT_FOUND_WORDS: Record<Locale, RootNotFoundWords> = {
  ar: {
    title: "لم نجد هذه الصفحة",
    text: "ربما تغيّر الرابط أو أُزيلت الصفحة. ابحث عمّا تريد، أو ابدأ من منصّتك.",
    home: "العودة إلى الرئيسية",
    help: "مركز الدعم",
    browse: "أو ابدأ من منصّتك",
    searchLabel: "ابحث في المتجر",
    searchPlaceholder: "ابحث عن جهاز أو لعبة",
    searchSubmit: "ابحث",
    platforms: { nintendo: "Nintendo", playstation: "PlayStation", xbox: "Xbox", handheld: "الأجهزة المحمولة" },
  },
  en: {
    title: "We could not find this page",
    text: "The link may have changed or the page was removed. Search for what you need, or start from your platform.",
    home: "Back to the home page",
    help: "Support centre",
    browse: "Or start from your platform",
    searchLabel: "Search the store",
    searchPlaceholder: "Search devices and games",
    searchSubmit: "Search",
    platforms: { nintendo: "Nintendo", playstation: "PlayStation", xbox: "Xbox", handheld: "Handheld PCs" },
  },
  ckb: {
    title: "ئەم پەڕەیەمان نەدۆزییەوە",
    text: "لەوانەیە بەستەرەکە گۆڕابێت یان پەڕەکە لابرابێت. بۆ ئەوەی دەتەوێت بگەڕێ، یان لە پلاتفۆرمەکەتەوە دەست پێبکە.",
    home: "گەڕانەوە بۆ پەڕەی سەرەکی",
    help: "ناوەندی پشتگیری",
    browse: "یان لە پلاتفۆرمەکەتەوە دەست پێبکە",
    searchLabel: "لە فرۆشگاکە بگەڕێ",
    searchPlaceholder: "بۆ ئامێر یان یارییەک بگەڕێ",
    searchSubmit: "بگەڕێ",
    platforms: { nintendo: "Nintendo", playstation: "PlayStation", xbox: "Xbox", handheld: "ئامێرە دەستییەکان" },
  },
};
