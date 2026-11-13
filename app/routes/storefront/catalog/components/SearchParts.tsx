/**
 * Parts of the search page (Design System v2 §6.4; v2.1 «Clay & Glass»): the start (the field and the suggestion chips
 * in the page's glass head, then the recent searches kept on this device with the shopper's consent and the small
 * «إعدادات البحث» row, then every platform and department to browse), the category-aware jumps ("go straight to …",
 * small clay keys with their icons), and «هل تقصد» — the shorter queries offered when two words never meet in one
 * product, as chips with what each finds.
 */
import { useEffect, useId, useRef } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useT } from "~/i18n/react";
import { SearchForm } from "~/routes/storefront/shell/SearchForm";
import type { NavPlatform } from "~/routes/storefront/shell/types";
import { CategoryTile } from "~/ui/CategoryTile";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { Switch } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { isPlatform, type Platform } from "~/ui/PlatformLed";
import { PlatformTile } from "~/ui/PlatformTile";
import { revealProps } from "~/ui/reveal";
import { searchPath, type StoreBrowse } from "../listing-model";
import { ChipLabel, TitleRow, deviceGlyph, keepInView, useKindIcon, useShellNav } from "./Hub";
import { useRecentSearches } from "./recent-searches";

type Suggestion = { name: string; platform: Platform | null };

/** Suggestion chips: the platforms' device models, two per platform — names, never "most searched" (no such data). */
function suggestionsOf(platforms: readonly NavPlatform[]): Suggestion[] {
  const out: Suggestion[] = [];
  const seen = new Set<string>();
  for (const round of [0, 1]) {
    for (const platform of platforms) {
      const device = platform.devices[round];
      if (!device || seen.has(device.label)) continue;
      seen.add(device.label);
      out.push({ name: device.label, platform: isPlatform(platform.accent) ? platform.accent : isPlatform(platform.slug) ? platform.slug : null });
    }
  }
  return out.slice(0, 8);
}

/**
 * A titled chip row: one row that scrolls sideways on phones and wraps from 768 — bleeding to the page's gutter
 * ("rail") or to the zero-result card's edges, centred ("panel").
 */
type ChipLayout = "rail" | "panel";
const chipRow = (layout: ChipLayout) => cx("chips chips--rail catalog-chips", layout === "rail" ? "chips--bleed" : "catalog-chips--panel");

/**
 * A row of suggestion chips — each a search for a device model, with its platform's device glyph in the platform's
 * colour. `title` names the row («اقتراحات», «جرّب أحد هذه:»); `limit` how many (at most 8).
 */
export function SuggestionChips({ title, layout = "rail", limit = 8, className }: { title: string; layout?: ChipLayout; limit?: number; className?: string }) {
  const nav = useShellNav();
  const id = useId();
  const suggestions = suggestionsOf(nav?.platforms ?? []).slice(0, limit);
  if (suggestions.length === 0) return null;
  return (
    <section aria-labelledby={id} className={cx("catalog-suggest", layout === "panel" && "catalog-suggest--panel", className)}>
      <h2 id={id} className="catalog-suggest__title">
        {title}
      </h2>
      <div className={chipRow(layout)} onFocus={keepInView}>
        {suggestions.map(({ name, platform }) => (
          <Chip key={name} as={LocaleLink} to={searchPath(name)}>
            <ChipLabel icon={platform ? deviceGlyph(platform) : "magnifying-glass"} gel={platform}>
              {name}
            </ChipLabel>
          </Chip>
        ))}
      </div>
    </section>
  );
}

/** The recent searches (only when the shopper keeps them) and the small row that switches keeping them on or off. */
export function RecentSearches() {
  const t = useT("catalog");
  const recent = useRecentSearches();
  const id = useId();
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-4">
      {recent.enabled && recent.items.length > 0 ? (
        <section aria-labelledby={id} className="grid grid-cols-[minmax(0,1fr)] gap-2">
          <div className="flex items-center justify-between gap-3">
            <h2 id={id} className="type-h3 text-ink">
              {t("search.recent")}
            </h2>
            <Key size="sm" variant="ghost" onClick={recent.clear} aria-label={t("search.recentClearLabel")}>
              {t("search.recentClear")}
            </Key>
          </div>
          <ul role="list" className="catalog-recent">
            {recent.items.map((entry) => (
              <li key={entry.q} className="catalog-recent__row">
                <LocaleLink to={searchPath(entry.q)} className="catalog-recent__link">
                  <Icon name="clock" size={20} className="shrink-0 text-ink-2" />
                  <bdi className="truncate">{entry.q}</bdi>
                </LocaleLink>
                <IconKey icon="x" variant="plain" label={t("search.recentRemove", { q: entry.q })} onClick={() => recent.remove(entry.q)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <div className="catalog-settings">
        <p className="type-xs-strong text-ink-2">{t("search.settings")}</p>
        <Switch label={t("search.recentToggle")} hint={recent.enabled ? t("search.recentNote") : t("search.recentOff")} checked={recent.enabled} onChange={(event) => recent.setEnabled(event.target.checked)} />
      </div>
    </div>
  );
}

/**
 * «تسوّق حسب المنصّة» and «تسوّق حسب القسم»: the four vivid platform tiles and the departments as the reference's icon
 * tiles (a clay square with the red line kind icon — v2.1 G4), with the hubs' counts. Each section fades up as it first
 * arrives (below the fold only).
 */
export function BrowseStore({ browse, headingLevel = 2, className }: { browse: StoreBrowse | null; headingLevel?: 2 | 3; className?: string }) {
  const t = useT("catalog");
  const ui = useT("ui");
  const nav = useShellNav();
  const kindIcon = useKindIcon();
  const platformsId = useId();
  const categoriesId = useId();
  const Heading = `h${headingLevel}` as const;
  const counts = new Map((browse?.platforms ?? []).map((entry) => [entry.slug, entry.count]));
  const platforms = (nav?.platforms ?? []).filter((platform) => isPlatform(platform.accent));
  const facts = new Map((browse?.categories ?? []).map((entry) => [entry.slug, entry]));
  // the navigation's departments in menu order (the used devices have their own marketplace), with the hubs' counts
  const categories = (nav?.categories ?? [])
    .filter((category) => category.kind !== "used" && (facts.get(category.slug)?.count ?? category.count) > 0)
    .map((category) => ({ ...category, count: facts.get(category.slug)?.count ?? category.count }));

  return (
    <div className={cx("catalog-browse", className)}>
      {platforms.length > 0 ? (
        <section aria-labelledby={platformsId} className="grid grid-cols-[minmax(0,1fr)] gap-4" {...revealProps()}>
          <Heading id={platformsId} className={headingLevel === 2 ? "type-h2 text-ink" : "type-h3 text-ink"}>
            {t("search.byPlatform")}
          </Heading>
          <ul role="list" className="catalog-ptiles glow glow--wide">
            {platforms.map((platform) =>
              isPlatform(platform.accent) ? (
                <li key={platform.slug} className="grid">
                  <PlatformTile
                    compact
                    platform={platform.accent}
                    to={platform.href}
                    name={isPlatform(platform.slug) ? ui(`platform.${platform.slug}`) : platform.name}
                    count={counts.get(platform.slug) ?? null}
                    art={platform.artKey ?? undefined}
                  />
                </li>
              ) : null,
            )}
          </ul>
        </section>
      ) : null}
      {categories.length > 0 ? (
        <section aria-labelledby={categoriesId} className="grid grid-cols-[minmax(0,1fr)] gap-4" {...revealProps()}>
          <Heading id={categoriesId} className={headingLevel === 2 ? "type-h2 text-ink" : "type-h3 text-ink"}>
            {t("search.byCategory")}
          </Heading>
          <ul role="list" className="cats catalog-cats">
            {categories.map((category) => (
              <li key={category.slug} className="grid">
                <CategoryTile to={category.href} label={category.label} count={category.count} icon={kindIcon(category.slug)} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/**
 * The start of the search page: the glass head (h1, the field — focused on wide screens only — and the suggestion
 * chips), the recent searches, then everything to browse.
 */
export function SearchStart({ browse }: { browse: StoreBrowse | null }) {
  const t = useT("catalog");
  const field = useRef<HTMLInputElement | null>(null);
  // the keyboard is not opened on a phone by itself: focus the field on wide screens only
  useEffect(() => {
    if (window.matchMedia("(min-width: 64rem)").matches) field.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      <TitleRow title={t("search.title")} icon="magnifying-glass">
        <div className="catalog-search-head">
          <SearchForm variant="panel" inputRef={field} className="catalog-search-field" />
          <SuggestionChips title={t("search.suggestions")} />
        </div>
      </TitleRow>
      <RecentSearches />
      <BrowseStore browse={browse} />
    </div>
  );
}

export type Jump = { kind: "platform" | "category" | "device"; slug: string; label: string; href: string };

/** "Go straight to": the platform, department or device hub the query names (category-aware search) — small clay keys. */
export function SearchJumps({ jumps }: { jumps: Jump[] }) {
  const t = useT("catalog");
  const ui = useT("ui");
  const kindIcon = useKindIcon();
  if (jumps.length === 0) return null;
  const iconOf = (jump: Jump): IconName => (jump.kind === "platform" ? (isPlatform(jump.slug) ? deviceGlyph(jump.slug) : "squares-four") : jump.kind === "category" ? kindIcon(jump.slug) : "book-open");
  return (
    <nav aria-label={t("search.jumps")} className="catalog-jumps">
      <span className="catalog-jumps__label">{t("search.jumps")}</span>
      <ul role="list" className="catalog-jumps__list">
        {jumps.map((jump) => (
          <li key={`${jump.kind}:${jump.slug}`}>
            <Key as={LocaleLink} to={jump.href} size="sm" icon={iconOf(jump)} iconEnd="arrow-right" className="catalog-jump" data-gel={jump.kind === "platform" && isPlatform(jump.slug) ? jump.slug : undefined}>
              <bdi>{jump.kind === "platform" && isPlatform(jump.slug) ? ui(`platform.${jump.slug}`) : jump.label}</bdi>
              <span className="catalog-jump__kind"> · {t(`search.jump.${jump.kind}`)}</span>
            </Key>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** «هل تقصد:» — two words that never meet in one product: each shorter query as a chip, with what it finds. */
export function DidYouMean({ partial, layout = "rail", className }: { partial: { q: string; count: number }[]; layout?: ChipLayout; className?: string }) {
  const t = useT("catalog");
  const id = useId();
  if (partial.length === 0) return null;
  return (
    <section aria-labelledby={id} className={cx("catalog-suggest", layout === "panel" && "catalog-suggest--panel", className)}>
      <h2 id={id} className="catalog-suggest__title">
        {t("search.didYouMean")}
      </h2>
      <div className={chipRow(layout)} onFocus={keepInView}>
        {partial.map((entry) => (
          <Chip key={entry.q} as={LocaleLink} to={searchPath(entry.q)} count={entry.count}>
            <ChipLabel icon="magnifying-glass">{entry.q}</ChipLabel>
          </Chip>
        ))}
      </div>
    </section>
  );
}
