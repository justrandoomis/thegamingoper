/**
 * Parts of the search page: the start state (recent searches on this device, then the platforms and departments to
 * browse), the category-aware jumps ("go straight to …"), and the shorter queries offered when two words never meet.
 */
import { useId } from "react";
import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { LAYOUT_ROUTE_ID } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { Switch } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";
import { ChipCount } from "./ChipCount";
import { PlatformName } from "./Hub";
import { useRecentSearches } from "./recent-searches";
import { searchPath } from "../listing-model";

const searchHref = searchPath;

export function RecentSearchList() {
  const t = useT("catalog");
  const recent = useRecentSearches();
  const id = useId();
  return (
    <section aria-labelledby={id} className="panel grid gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="type-sub text-ink">
          {t("search.recent")}
        </h2>
        {recent.items.length > 0 ? (
          <Key size="sm" variant="quiet" icon="trash" onClick={recent.clear}>
            {t("search.recentClear")}
          </Key>
        ) : null}
      </div>
      {recent.items.length > 0 ? (
        <ul role="list" className="grid">
          {recent.items.map((entry) => (
            <li key={entry.q} className="flex items-center justify-between gap-2 border-b border-line last:border-b-0">
              <LocaleLink to={searchHref(entry.q)} className="flex min-h-11 min-w-0 flex-1 items-center gap-2 type-body text-ink">
                <Icon name="clock" size={18} className="shrink-0 text-ink-2" />
                <bdi className="truncate">{entry.q}</bdi>
              </LocaleLink>
              <IconKey icon="x" size="sm" variant="quiet" label={t("search.recentRemove", { q: entry.q })} onClick={() => recent.remove(entry.q)} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-caption text-ink-2">{recent.enabled ? t("search.recentEmpty") : t("search.recentOff")}</p>
      )}
      <Switch label={t("search.recentToggle")} hint={t("search.recentNote")} checked={recent.enabled} onChange={(event) => recent.setEnabled(event.target.checked)} />
    </section>
  );
}

/** The start of the search page: recent searches, then everything to browse (from the shell's navigation data). */
export function SearchStart() {
  const t = useT("catalog");
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData } | undefined;
  const nav = layout?.shell?.nav;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-6">
      <p className="type-body text-ink-2">{t("search.startHint")}</p>
      <RecentSearchList />
      {nav && (nav.platforms.length > 0 || nav.categories.length > 0) ? (
        <section aria-labelledby="catalog-browse" className="grid grid-cols-[minmax(0,1fr)] gap-4">
          <h2 id="catalog-browse" className="type-section text-ink">
            {t("search.browse")}
          </h2>
          {/* navigation, not choices: text links (DESIGN.md §9.1), the platforms with their LED */}
          {nav.platforms.length > 0 ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
              <h3 className="type-label text-ink-2">{t("search.platforms")}</h3>
              <ul role="list" className="flex flex-wrap gap-x-6">
                {nav.platforms.map((platform) => (
                  <li key={platform.slug}>
                    {/* no count: the shell's per-platform count leaves out multi-platform products (the hub counts them) */}
                    <TextLink as={LocaleLink} to={platform.href}>
                      <PlatformName slug={platform.slug} fallback={platform.name} />
                    </TextLink>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {nav.categories.length > 0 ? (
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1">
              <h3 className="type-label text-ink-2">{t("search.categories")}</h3>
              <ul role="list" className="flex flex-wrap gap-x-6">
                {nav.categories.map((category) => (
                  <li key={category.slug}>
                    <TextLink as={LocaleLink} to={category.href}>
                      {category.label}
                      <ChipCount n={category.count} />
                    </TextLink>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

export type Jump = { kind: "platform" | "category" | "device"; slug: string; label: string; href: string };

/** "Go straight to": the platform, department or device hub the query names (category-aware search). */
export function SearchJumps({ jumps }: { jumps: Jump[] }) {
  const t = useT("catalog");
  if (jumps.length === 0) return null;
  return (
    <nav aria-label={t("search.jumps")} className="flex flex-wrap items-center gap-x-4 gap-y-1">
      <span className="type-label text-ink-2">{t("search.jumps")}</span>
      {jumps.map((jump) => (
        <TextLink key={`${jump.kind}:${jump.slug}`} as={LocaleLink} to={jump.href} className="type-label">
          {jump.kind === "platform" ? <PlatformName slug={jump.slug} fallback={jump.label} /> : <bdi>{jump.label}</bdi>}
          <span className="type-caption text-ink-2"> · {t(`search.jump.${jump.kind}`)}</span>
        </TextLink>
      ))}
    </nav>
  );
}

/** Two words that never meet in one product: each shorter query, with what it finds. */
export function PartialQueries({ partial }: { partial: { q: string; count: number }[] }) {
  const t = useT("catalog");
  const f = useFormat();
  if (partial.length === 0) return null;
  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-2">
      <p className="type-label text-ink">{t("search.partialTitle")}</p>
      <ul role="list" className="grid grid-cols-[minmax(0,1fr)] gap-1">
        {partial.map((entry) => (
          <li key={entry.q}>
            <TextLink as={LocaleLink} to={searchHref(entry.q)}>
              {t("search.partial", { q: entry.q, count: entry.count, n: f.number(entry.count) })}
            </TextLink>
          </li>
        ))}
      </ul>
    </div>
  );
}
