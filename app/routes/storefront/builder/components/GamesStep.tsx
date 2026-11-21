/**
 * Step 3 — the games (docs/switch-builder.md §6.4): the open list of Switch 1 games with TamTam's sizes and prices,
 * searched (titles in every language, aliases, series, publishers — Arabic folded; ~/lib/switch-builder/search), filtered
 * (./FiltersSheet) and sorted (a menu of radio rows). Games TamTam has a size for come first in every sort: only they
 * can join the space bar.
 *
 * At most 48 cards are added at a time («اعرض 48 لعبة أخرى»), and every card is rendered — no content-visibility: it
 * took the cards off screen out of the accessibility tree, so a screen reader moving by heading or list item found only
 * the ones near the viewport (QA 2026-11-21). Cards that stay slide to their new places when the list changes (the
 * catalogue's FLIP), new ones grow in; off under reduced motion.
 *
 * The keyboard: «تخطَّ قائمة الألعاب» (out of sight until Tab reaches it, after the sort key) goes to the step's
 * «تابع» — the grid is two stops a card. «اعرض 48 لعبة أخرى» hands focus to the first new card (it stayed on the key,
 * after them). Clearing a chip moves focus to the next chip, else to «الفلاتر»; so does «امسح الفلاتر» in the no-match
 * state — never to <body> (WCAG 2.4.3). The live count says the number only; «الألعاب التي أضفنا حجمها تأتي أولاً» is
 * beside it, said once with the page, not after every search.
 *
 * States: the list not built yet (LIBRARY_LIST_FILE is null) · loading (reserved geometry, no skeleton) · error with
 * retry · offline (it retries by itself when the connection comes back, and says so in the builder's words) · the list
 * was updated (a deploy deleted the files this page was loaded with: «حدّثنا قائمة الألعاب» and «حدّث الصفحة»,
 * ./LibraryUpdated — also above the list when a game's details file is gone) · no game matches the search («امسح
 * البحث» gives the field its focus back) · no game matches the filters («امسح الفلاتر»). The space bar draws no figure
 * that depends on sizes not loaded yet.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
import { LibraryUpdated } from "./LibraryUpdated";
import { SpaceMeter, type MeterFigures } from "./SpaceMeter";
import { STEP_NEXT } from "./StepKeys";

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
  /** Whether the space bar's figures can be drawn yet (the chosen games' sizes have loaded). */
  figures?: MeterFigures;
  chosen: ReadonlyMap<LibraryGameId, GameFormat>;
  view: GamesView;
  onView: (view: GamesView) => void;
  onToggle: (entry: LibraryEntry) => void;
  onOpen: (entry: LibraryEntry) => void;
  /** The meter's guide target is on this copy (below 1024; from 1024 the aside's meter has it). */
  meterTour: boolean;
  /** Under an over-full meter: the way to a bigger card. */
  meterAction?: ReactNode;
  /** A game's details file was gone (a newer list was published): the notice above the list. */
  detailsUpdated?: boolean;
  /** ISO date of the list's Wikidata snapshot. */
  asOf: string | null;
  /** The filters sheet's open state, when the page keeps it (it hides the task bar's keys under open sheets). */
  filtersOpen?: boolean;
  onFiltersOpen?: (open: boolean) => void;
};

/** The step's primary on screen (the task bar's below 1024, the aside's from 1024): where the skip key sends focus. */
function focusStepPrimary(): void {
  const keys = [...document.querySelectorAll<HTMLElement>(`[${STEP_NEXT}]`)];
  keys.find((key) => key.getClientRects().length > 0)?.focus();
}

export function GamesStep({ library, entries, usage, figures = "known", chosen, view, onView, onToggle, onOpen, meterTour, meterAction, detailsUpdated = false, asOf, filtersOpen, onFiltersOpen }: GamesStepProps) {
  const t = useBuilderT();
  const f = useFormat();
  const field = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLUListElement>(null);
  const filtersKey = useRef<HTMLButtonElement>(null);
  const [ownSheetOpen, setOwnSheetOpen] = useState(false);
  const sheetOpen = filtersOpen ?? ownSheetOpen;
  const setSheetOpen = onFiltersOpen ?? setOwnSheetOpen;
  const query = useDebounced(view.query, SEARCH_DEBOUNCE_MS);
  const remainingBytes = usage.usage.remainingBytes;
  const sorts = useMemo(() => sortsFor(entries), [entries]);
  const sort = sorts.includes(view.sort) ? view.sort : "popular";
  const listView = useMemo(() => ({ query, filters: view.filters, sort, remainingBytes, chosen }), [query, view.filters, sort, remainingBytes, chosen]);
  const results = useMemo(() => viewLibrary(entries, listView), [entries, listView]);
  const visible = results.slice(0, view.shown);
  useFlip(grid, visible.map((entry) => entry.game.id).join("|"));
  // «اعرض 48 لعبة أخرى» pressed with focus on it: the first new card takes focus once it is there (the key stays after
  // the new cards — or goes, after the last page)
  const firstNew = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = firstNew.current;
    if (index === null || visible.length <= index) return;
    firstNew.current = null;
    grid.current?.querySelectorAll<HTMLElement>(".sb-game__toggle")[index]?.focus();
  }, [visible.length]);
  const more = () => {
    const active = typeof document === "undefined" ? null : document.activeElement;
    firstNew.current = active instanceof HTMLElement && active.closest(".showmore") ? visible.length : null;
    onView({ ...view, shown: view.shown + GAMES_PAGE });
  };
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
  // «امسح الفلاتر» goes away with the empty state: focus goes to «الفلاتر», which is always there
  const clearFilters = () => {
    set({ filters: NO_FILTERS });
    filtersKey.current?.focus();
  };
  const sortName = `${t("games.sort.trigger")} ${t(`games.sort.${sort}`)}`;

  const meter = <SpaceMeter usage={usage} figures={figures} tour={meterTour ? "meter" : undefined} action={meterAction} className="lg:hidden" />;

  let body: ReactNode;
  if (library.status === "unbuilt" || (library.status === "ready" && entries.length === 0)) {
    body = <EmptyState layout="stack" icon="game-controller" headingLevel={2} title={t("games.unbuiltTitle")} text={t("games.unbuiltText")} />;
  } else if (library.status === "stale") {
    // the list this page was loaded with is gone (a deploy): a reload reads the new one — announced like the failure
    // state it replaces, never the generic error with a retry that would ask for the same missing file again
    body = (
      <div role="alert">
        <LibraryUpdated />
      </div>
    );
  } else if (library.status === "error") {
    // the builder's own words when the connection is gone: the list loads by itself when it is back (the kit's offline
    // sentence would ask the shopper to retry). `offline={false}` keeps the kit from replacing them.
    body = <ErrorState title={t("games.errorTitle")} text={library.offline ? t("games.offlineText") : t("games.errorText")} onRetry={library.retry} offline={false} alert />;
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
        {detailsUpdated ? <LibraryUpdated /> : null}
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
          {/* the guide's «التصفية والترتيب» lights both keys */}
          <div className="sb-toolbar__keys" data-tour="filters">
            <Key ref={filtersKey} size="sm" icon="sliders-horizontal" aria-haspopup="dialog" onClick={() => setSheetOpen(true)}>
              {active > 0 ? t("games.filtersCount", { n: f.number(active) }) : t("games.filters")}
            </Key>
            {sorts.length > 1 ? (
              <Menu
                label={t("games.sort.label")}
                title={t("games.sort.label")}
                align="end"
                trigger={(props) => (
                  // its name says the sort in use at every width: below sm the words on the key are only «الترتيب»
                  <Key {...props} size="sm" icon="sort-ascending" iconEnd="caret-down" aria-label={sortName}>
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
            {/* a skip link for the grid (two stops a card): out of sight until the keyboard reaches it */}
            {!empty ? (
              <Key size="sm" iconEnd="arrow-right" className="sb-skip" onClick={focusStepPrimary}>
                {t("games.skip")}
              </Key>
            ) : null}
          </div>
        </div>

        <ActiveFilters filters={view.filters} onChange={(filters) => set({ filters })} onEmpty={() => filtersKey.current?.focus()} />

        <p className="sb-count">
          {/* only the number is live: the sentence beside it is said with the page, never again after each search */}
          <span className="nums" aria-live="polite">
            {t("games.found", { count: results.length, n: f.number(results.length) })}
          </span>
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
                <Key size="sm" onClick={clearFilters}>
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
              onMore={more}
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

/**
 * The removable chips of the filters in use, in the sheet's order. A chip removed from the keyboard hands focus to the
 * chip that takes its place (else the one before); the last chip, or «امسح الكل», to `onEmpty` («الفلاتر»).
 */
function ActiveFilters({ filters, onChange, onEmpty }: { filters: LibraryFilters; onChange: (filters: LibraryFilters) => void; onEmpty: () => void }) {
  const t = useBuilderT();
  const bandLabel = useBandLabel();
  const box = useRef<HTMLDivElement>(null);
  const removedAt = useRef<number | null>(null);
  useLayoutEffect(() => {
    const index = removedAt.current;
    if (index === null) return;
    removedAt.current = null;
    const chips = box.current ? [...box.current.querySelectorAll<HTMLElement>(".key--chip")] : [];
    if (chips.length > 0) chips[Math.min(index, chips.length - 1)].focus();
    else onEmpty();
  });
  // only a removal made with focus in the chips moves focus (a pointer elsewhere is never pulled here)
  const removing = (index: number, change: () => void) => () => {
    if (box.current?.contains(document.activeElement)) removedAt.current = index;
    change();
  };
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
    <div ref={box} className="sb-active">
      <div className="chips" role="group" aria-label={t("filters.active")}>
        {chips.map((chip, index) => (
          <Chip key={chip.key} onRemove={removing(index, chip.remove)}>
            {chip.label}
          </Chip>
        ))}
      </div>
      {chips.length > 1 ? (
        <TextLink as="button" type="button" arrow={false} onClick={removing(0, () => onChange(NO_FILTERS))}>
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
        {Number.isFinite(date) ? <span className="nums"> {t("credits.asOf", { date: f.date(date, "long") })}</span> : null}
      </p>
      <p>
        {t("credits.sizes")} {t("credits.eshop")}
      </p>
    </footer>
  );
}
