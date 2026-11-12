/**
 * Parts of the search page (Design System v2 §6.4): the start (a field in the page, suggestion chips, the recent
 * searches kept on this device with the shopper's consent and the small «إعدادات البحث» row, then every platform and
 * department to browse), the category-aware jumps ("go straight to …"), and «هل تقصد» — the shorter queries offered
 * when two words never meet in one product.
 */
import { useEffect, useId, useRef } from "react";
import { useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { SearchForm } from "~/routes/storefront/shell/SearchForm";
import { LAYOUT_ROUTE_ID } from "~/routes/storefront/shell/meta";
import type { NavPlatform, ShellData } from "~/routes/storefront/shell/types";
import { CategoryTile } from "~/ui/CategoryTile";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { Switch } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { isPlatform } from "~/ui/PlatformLed";
import { PlatformTile } from "~/ui/PlatformTile";
import { TextLink } from "~/ui/TextLink";
import { searchPath, type StoreBrowse } from "../listing-model";
import { PlatformName, keepInView } from "./Hub";
import { useRecentSearches } from "./recent-searches";

/** The layout's navigation data (platforms with their lead device, departments). */
function useNav() {
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData | null } | undefined;
  return layout?.shell?.nav ?? null;
}

/** Suggestion chips: the platforms' device models, two per platform — names, never "most searched" (no such data). */
function suggestionsOf(platforms: readonly NavPlatform[]): string[] {
  const names: string[] = [];
  for (const round of [0, 1]) for (const platform of platforms) if (platform.devices[round]) names.push(platform.devices[round].label);
  return [...new Set(names)].slice(0, 8);
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

/** The glyph that stands in for a department without a photo. */
const CATEGORY_GLYPH: Record<string, IconName> = {
  controllers: "game-controller",
  headsets: "headphones",
  storage: "hard-drives",
  vr: "eye",
  digital: "gift",
  accessories: "plug",
  games: "disc",
  consoles: "desktop",
  parts: "wrench",
};

/** «تسوّق حسب المنصّة» and «تسوّق حسب القسم»: the four platform tiles and the department tiles, with the hubs' counts. */
export function BrowseStore({ browse, headingLevel = 2, className }: { browse: StoreBrowse | null; headingLevel?: 2 | 3; className?: string }) {
  const t = useT("catalog");
  const ui = useT("ui");
  const nav = useNav();
  const platformsId = useId();
  const categoriesId = useId();
  const Heading = `h${headingLevel}` as const;
  const counts = new Map((browse?.platforms ?? []).map((entry) => [entry.slug, entry.count]));
  const platforms = (nav?.platforms ?? []).filter((platform) => isPlatform(platform.accent));
  const facts = new Map((browse?.categories ?? []).map((entry) => [entry.slug, entry]));
  // the navigation's departments in menu order (the used devices have their own marketplace), with the hubs' counts
  const categories = (nav?.categories ?? [])
    .filter((category) => category.kind !== "used" && (facts.get(category.slug)?.count ?? category.count) > 0)
    .map((category) => ({ ...category, count: facts.get(category.slug)?.count ?? category.count, artKey: facts.get(category.slug)?.artKey ?? null }));

  return (
    <div className={cx("catalog-browse", className)}>
      {platforms.length > 0 ? (
        <section aria-labelledby={platformsId} className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <Heading id={platformsId} className={headingLevel === 2 ? "type-h2 text-ink" : "type-h3 text-ink"}>
            {t("search.byPlatform")}
          </Heading>
          <ul role="list" className="catalog-ptiles">
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
        <section aria-labelledby={categoriesId} className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <Heading id={categoriesId} className={headingLevel === 2 ? "type-h2 text-ink" : "type-h3 text-ink"}>
            {t("search.byCategory")}
          </Heading>
          <ul role="list" className="cats">
            {categories.map((category) => (
              <li key={category.slug} className="grid">
                <CategoryTile
                  to={category.href}
                  label={category.label}
                  count={category.count}
                  art={
                    category.artKey ?? (
                      <span className="absolute inset-0 grid place-items-center text-ink-2">
                        <Icon name={CATEGORY_GLYPH[category.kind] ?? "squares-four"} size={32} />
                      </span>
                    )
                  }
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** The start of the search page: the field (focused on wide screens only), suggestions, recent searches, browse. */
export function SearchStart({ browse }: { browse: StoreBrowse | null }) {
  const t = useT("catalog");
  const nav = useNav();
  const field = useRef<HTMLInputElement | null>(null);
  const suggestionsId = useId();
  const suggestions = suggestionsOf(nav?.platforms ?? []);
  // the keyboard is not opened on a phone by itself: focus the field on wide screens only
  useEffect(() => {
    if (window.matchMedia("(min-width: 64rem)").matches) field.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-8">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-5">
        <SearchForm variant="panel" inputRef={field} className="catalog-search-field" />
        {suggestions.length > 0 ? (
          <section aria-labelledby={suggestionsId} className="grid grid-cols-[minmax(0,1fr)] gap-2">
            <h2 id={suggestionsId} className="type-sm-strong text-ink-2">
              {t("search.suggestions")}
            </h2>
            <div className="chips chips--rail chips--bleed catalog-chips" onFocus={keepInView}>
              {suggestions.map((name) => (
                <Chip key={name} as={LocaleLink} to={searchPath(name)}>
                  {name}
                </Chip>
              ))}
            </div>
          </section>
        ) : null}
        <RecentSearches />
      </div>
      <BrowseStore browse={browse} />
    </div>
  );
}

export type Jump = { kind: "platform" | "category" | "device"; slug: string; label: string; href: string };

/** "Go straight to": the platform, department or device hub the query names (category-aware search). */
export function SearchJumps({ jumps }: { jumps: Jump[] }) {
  const t = useT("catalog");
  if (jumps.length === 0) return null;
  return (
    <nav aria-label={t("search.jumps")} className="catalog-jumps">
      <span className="type-sm text-ink-2">{t("search.jumps")}</span>
      {jumps.map((jump) => (
        <TextLink key={`${jump.kind}:${jump.slug}`} as={LocaleLink} to={jump.href}>
          {jump.kind === "platform" ? <PlatformName slug={jump.slug} fallback={jump.label} /> : <bdi>{jump.label}</bdi>}
          <span className="font-normal text-ink-2"> · {t(`search.jump.${jump.kind}`)}</span>
        </TextLink>
      ))}
    </nav>
  );
}

/** «هل تقصد:» — two words that never meet in one product: each shorter query, with what it finds. */
export function DidYouMean({ partial }: { partial: { q: string; count: number }[] }) {
  const t = useT("catalog");
  const f = useFormat();
  if (partial.length === 0) return null;
  return (
    <div className="catalog-didyoumean">
      <p className="type-sm-strong text-ink">{t("search.didYouMean")}</p>
      <ul role="list" className="flex flex-wrap gap-x-6">
        {partial.map((entry) => (
          <li key={entry.q}>
            <TextLink as={LocaleLink} to={searchPath(entry.q)}>
              <bdi>{t("search.partial", { q: entry.q, count: entry.count, n: f.number(entry.count) })}</bdi>
            </TextLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
