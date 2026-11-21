/**
 * Step 3 — the games (docs/switch-builder.md §6.4): the open list of Switch 1 games with TamTam's sizes and prices,
 * searched (titles in every language, aliases, series, publishers — Arabic folded; ~/lib/switch-builder/search), filtered
 * (./FiltersSheet) and sorted (a menu of radio rows). Games TamTam has a size for come first in every sort: only they
 * can join the space bar.
 *
 * At most 48 cards are added at a time («اعرض 48 لعبة أخرى»); each card below the first screen skips its rendering
 * work until it scrolls near (content-visibility in builder.css). Cards that stay slide to their new places when the
 * list changes (the catalogue's FLIP), new ones grow in; off under reduced motion.
 *
 * States: the list not built yet (LIBRARY_LIST_FILE is null) · loading (reserved geometry, no skeleton) · error with
 * retry · offline (it retries by itself when the connection comes back) · no game matches the search («امسح البحث»
 * gives the field its focus back) · no game matches the filters («امسح الفلاتر»).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { useFormat, useT } from "~/i18n/react";
import type { PlanUsage } from "~/lib/switch-builder/plan";
import type { GameFormat, LibraryGameId } from "~/lib/switch-builder/types";
import { useFlip } from "~/routes/storefront/catalog/components/use-flip";
import { isolate } from "~/ui/BidiText";
import { Chip } from "~/ui/Chip";
import { EmptyState } from "~/ui/EmptyState";
import { ErrorState } from "~/ui/ErrorState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Menu } from "~/ui/Menu";
import { ShowMore } from "~/ui/Pagination";
import { fillNodes } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { Icon } from "~/art/Icon";
import { gbText, useBuilderT } from "../lib/format";
import { activeFilterGroups, countsFor, NO_FILTERS, sortsFor, viewLibrary, type LibraryEntry, type LibraryFilters, type LibrarySort } from "../lib/library";
import type { LibraryState } from "../lib/use-library";
import { FiltersSheet, useBandLabel } from "./FiltersSheet";
import { GameCard } from "./GameCard";
import { SpaceMeter } from "./SpaceMeter";

/** Cards added at a time. */
export const GAMES_PAGE = 48;
/** The search waits this long after the last key (the list filters in place, no request). */
export const SEARCH_DEBOUNCE_MS = 150;

export type GamesView = {
  query: string;
  filters: LibraryFilters;
  sort: LibrarySort;
  shown: number;
};

export const INITIAL_VIEW: GamesView = { query: "", filters: NO_FILTERS, sort: "popular", shown: GAMES_PAGE };

function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

export type GamesStepProps = {
  library: LibraryState;
  entries: readonly LibraryEntry[];
  usage: PlanUsage;
  chosen: ReadonlyMap<LibraryGameId, GameFormat>;
  view: GamesView;
  onView: (view: GamesView) => void;
  onToggle: (entry: LibraryEntry) => void;
  onOpen: (entry: LibraryEntry) => void;
  /** The meter's guide target is on this copy (below 1024; from 1024 the aside's meter has it). */
  meterTour: boolean;
  /** Under an over-full meter: the way to a bigger card. */
  meterAction?: ReactNode;
  /** ISO date of the list's Wikidata snapshot. */
  asOf: string | null;
};

export function GamesStep({ library, entries, usage, chosen, view, onView, onToggle, onOpen, meterTour, meterAction, asOf }: GamesStepProps) {
  const t = useBuilderT();
  const f = useFormat();
  const field = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLUListElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const query = useDebounced(view.query, SEARCH_DEBOUNCE_MS);
  const remainingBytes = usage.usage.remainingBytes;
  const sorts = useMemo(() => sortsFor(entries), [entries]);
  const sort = sorts.includes(view.sort) ? view.sort : "popular";
  const listView = useMemo(() => ({ query, filters: view.filters, sort, remainingBytes, chosen }), [query, view.filters, sort, remainingBytes, chosen]);
  const results = useMemo(() => viewLibrary(entries, listView), [entries, listView]);
  const visible = results.slice(0, view.shown);
  useFlip(grid, visible.map((entry) => entry.game.id).join("|"));
  const counts = useMemo(
    () => (sheetOpen ? { genres: countsFor(entries, listView, "genres"), modes: countsFor(entries, listView, "modes") } : { genres: new Map<string, number>(), modes: new Map<string, number>() }),
    [sheetOpen, entries, listView],
  );
  const offer = useMemo(
    () => ({
      price: entries.some((entry) => (entry.extras?.priceUsdCents ?? 0) > 0),
      cartridge: entries.some((entry) => entry.cartridge),
      sized: entries.some((entry) => (entry.extras?.sizeBytes ?? 0) > 0 || (entry.extras?.cartridgeBytes ?? 0) > 0),
    }),
    [entries],
  );
  const active = activeFilterGroups(view.filters).length;
  const set = (change: Partial<GamesView>) => onView({ ...view, shown: GAMES_PAGE, ...change });
  const clearSearch = () => {
    set({ query: "" });
    field.current?.focus();
  };

  const meter = <SpaceMeter usage={usage} tour={meterTour ? "meter" : undefined} action={meterAction} className="lg:hidden" />;

  let body: ReactNode;
  if (library.status === "unbuilt" || (library.status === "ready" && entries.length === 0)) {
    body = <EmptyState layout="stack" icon="game-controller" headingLevel={2} title={t("games.unbuiltTitle")} text={t("games.unbuiltText")} />;
  } else if (library.status === "error") {
    body = <ErrorState title={t("games.errorTitle")} text={library.offline ? t("games.offlineText") : t("games.errorText")} onRetry={library.retry} offline={library.offline} alert />;
  } else if (library.status !== "ready") {
    body = (
      <div className="sb-loading" aria-busy="true">
        <p className="sb-loading__text" role="status">
          {t("games.loading")}
        </p>
        <ul className="sb-grid" aria-hidden="true">
          {Array.from({ length: 6 }, (_, index) => (
            <li key={index} className="sb-game sb-game--placeholder surface" />
          ))}
        </ul>
      </div>
    );
  } else {
    const empty = results.length === 0;
    body = (
      <>
        <div className="sb-toolbar">
          <form role="search" className="sb-toolbar__search" data-tour="search" onSubmit={(event) => event.preventDefault()}>
            <TextField
              ref={field}
              label={t("games.searchLabel")}
              hideLabel
              type="search"
              name="q"
              value={view.query}
              onChange={(event) => set({ query: event.currentTarget.value })}
              placeholder={t("games.searchHint")}
              autoComplete="off"
              enterKeyHint="search"
              end={<Icon name="magnifying-glass" size={20} />}
            />
          </form>
          <div className="sb-toolbar__keys">
            <Key size="sm" icon="sliders-horizontal" aria-haspopup="dialog" onClick={() => setSheetOpen(true)} data-tour="filters">
              {active > 0 ? t("games.filtersCount", { n: f.number(active) }) : t("games.filters")}
            </Key>
            {sorts.length > 1 ? (
              <Menu
                label={t("games.sort.label")}
                title={t("games.sort.label")}
                align="end"
                trigger={(props) => (
                  <Key {...props} size="sm" icon="sort-ascending" iconEnd="caret-down">
                    <span className="sm:hidden">{t("games.sort.label")}</span>
                    <span className="max-sm:hidden">
                      <span className="font-normal text-ink-2">{t("games.sort.trigger")}</span> {t(`games.sort.${sort}`)}
                    </span>
                  </Key>
                )}
                items={sorts.map((value) => ({
                  id: value,
                  kind: "radio" as const,
                  label: t(`games.sort.${value}`),
                  hint: value === "popular" ? t("games.sort.popularHint") : undefined,
                  checked: value === sort,
                  onSelect: () => set({ sort: value }),
                }))}
              />
            ) : null}
          </div>
        </div>

        <ActiveFilters filters={view.filters} onChange={(filters) => set({ filters })} />

        <p className="sb-count" aria-live="polite">
          <span className="nums">{t("games.found", { count: results.length, n: f.number(results.length) })}</span>
          {!empty && results.some((entry) => entry.extras?.sizeBytes || entry.extras?.cartridgeBytes) ? <span className="sb-count__why"> · {t("games.sort.sizedFirst")}</span> : null}
        </p>

        {empty ? (
          // the words follow the search the results come from (the settled one): right after «امسح البحث» the field is
          // empty while the list still answers the old search for a moment — never «لا ألعاب بهذه الفلاتر» in between
          query.trim() !== "" ? (
            <EmptyState
              icon="magnifying-glass"
              title={t("games.noMatch", { query: isolate(query.trim()) })}
              text={t("games.noMatchText")}
              action={
                <Key size="sm" onClick={clearSearch}>
                  {t("games.clearSearch")}
                </Key>
              }
            />
          ) : (
            <EmptyState
              icon="funnel"
              title={t("games.noFilterMatch")}
              text={t("games.noFilterMatchText")}
              action={
                <Key size="sm" onClick={() => set({ filters: NO_FILTERS })}>
                  {t("games.clearFilters")}
                </Key>
              }
            />
          )
        ) : (
          <>
            <VisuallyHidden as="h2">{t("games.listLabel")}</VisuallyHidden>
            <ul ref={grid} className="sb-grid" aria-label={t("games.listLabel")}>
              {visible.map((entry, index) => (
                <GameCard
                  key={entry.game.id}
                  entry={entry}
                  chosen={chosen.get(entry.game.id) ?? null}
                  remainingBytes={remainingBytes}
                  first={index === 0}
                  onToggle={onToggle}
                  onOpen={onOpen}
                />
              ))}
            </ul>
            <ShowMore
              shown={visible.length}
              total={results.length}
              step={GAMES_PAGE}
              onMore={() => onView({ ...view, shown: view.shown + GAMES_PAGE })}
              label={t("games.more", { count: Math.min(GAMES_PAGE, results.length - visible.length), n: f.number(Math.min(GAMES_PAGE, results.length - visible.length)) })}
            />
          </>
        )}

        <FiltersSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          filters={view.filters}
          onChange={(filters) => set({ filters })}
          counts={counts}
          total={results.length}
          remainingBytes={remainingBytes}
          offer={offer}
        />
      </>
    );
  }

  return (
    <div className="sb-step sb-step--wide">
      {meter}
      {body}
      <Credits asOf={asOf} />
    </div>
  );
}

/** The removable chips of the filters in use, in the sheet's order. */
function ActiveFilters({ filters, onChange }: { filters: LibraryFilters; onChange: (filters: LibraryFilters) => void }) {
  const t = useBuilderT();
  const bandLabel = useBandLabel();
  const chips: Array<{ key: string; label: string; remove: () => void }> = [];
  for (const genre of filters.genres) chips.push({ key: `genre:${genre}`, label: t(`genre.${genre}`), remove: () => onChange({ ...filters, genres: filters.genres.filter((value) => value !== genre) }) });
  for (const mode of filters.modes) chips.push({ key: `mode:${mode}`, label: t(`mode.${mode}`), remove: () => onChange({ ...filters, modes: filters.modes.filter((value) => value !== mode) }) });
  if (filters.size) chips.push({ key: "size", label: bandLabel("size", filters.size), remove: () => onChange({ ...filters, size: null }) });
  if (filters.price) chips.push({ key: "price", label: bandLabel("price", filters.price), remove: () => onChange({ ...filters, price: null }) });
  if (filters.fits) chips.push({ key: "fits", label: t("filters.fits"), remove: () => onChange({ ...filters, fits: false }) });
  if (filters.cartridge) chips.push({ key: "cartridge", label: t("filters.cartridge"), remove: () => onChange({ ...filters, cartridge: false }) });
  if (filters.sized) chips.push({ key: "sized", label: t("filters.sized"), remove: () => onChange({ ...filters, sized: false }) });
  if (chips.length === 0) return null;
  return (
    <div className="sb-active">
      <div className="chips" role="group" aria-label={t("filters.active")}>
        {chips.map((chip) => (
          <Chip key={chip.key} onRemove={chip.remove}>
            {chip.label}
          </Chip>
        ))}
      </div>
      {chips.length > 1 ? (
        <TextLink as="button" type="button" arrow={false} onClick={() => onChange(NO_FILTERS)}>
          {t("filters.clearAll")}
        </TextLink>
      ) : null}
    </div>
  );
}

/** The sources line under the list (docs/switch-builder.md §1.3, §6.1): Wikidata (CC0) and Wikipedia (CC BY-SA 4.0). */
export function Credits({ asOf }: { asOf: string | null }) {
  const t = useBuilderT();
  const ui = useT("ui");
  const f = useFormat();
  // plain inline links (opening in a new tab, said to screen readers): the kit's external link draws its icon as a
  // block, which broke the sentence into lines on a phone; each source and its licence is one left-to-right isolate,
  // so «Wikidata (CC0)» keeps its brackets in Arabic and Sorani
  const link = (href: string, label: string) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="sb-credits__link">
      {label}
      <VisuallyHidden> ({ui("link.external")})</VisuallyHidden>
    </a>
  );
  const source = (name: ReactNode, licence: ReactNode) => (
    <bdi dir="ltr" className="sb-credits__source">
      {name} ({licence})
    </bdi>
  );
  const date = asOf ? Date.parse(`${asOf}T12:00:00Z`) : NaN;
  return (
    <footer className="sb-credits">
      <p>
        {fillNodes(t("credits.text"), {
          wikidata: source(link("https://www.wikidata.org/", t("credits.wikidata")), link("https://creativecommons.org/publicdomain/zero/1.0/", t("credits.cc0"))),
          wikipedia: source(link("https://www.wikipedia.org/", t("credits.wikipedia")), link("https://creativecommons.org/licenses/by-sa/4.0/", t("credits.ccbysa"))),
        })}
        {Number.isFinite(date) ? <span className="nums"> {t("credits.asOf", { date: f.date(date) })}</span> : null}
      </p>
      <p>
        {t("credits.sizes")} {t("credits.eshop")}
      </p>
    </footer>
  );
}
