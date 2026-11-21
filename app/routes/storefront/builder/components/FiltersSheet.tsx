/**
 * The games step's filters (docs/switch-builder.md §6.4), in the kit's sheet: a bottom sheet on phones, a side sheet
 * from 768 — the catalogue's pattern (its foot: «امسح الكل» + «اعرض 24 لعبة», which closes the sheet; every change
 * applies at once and the description says how many games match).
 *
 *   genre and play mode  checkbox chips with their counts (the other filters as they are); only values that occur
 *   space it needs       one band (radio chips): up to 2 GB · 2–8 · 8–16 · over 16 — games TamTam has a size for
 *   eShop price          one band, priced games only (shown when TamTam has entered a price for some game)
 *   switches             «تتّسع في المساحة المتبقية» (with what is left now), «يبيعها طمطم شريطاً» (when TamTam
 *                        sells any cartridge), «أضفنا حجمها»
 *
 * The new count is said inside the sheet (WCAG 4.1.3): the page's own count is under the inert page while the sheet is
 * open, and the sheet's description is not a live region. A polite region, there from the moment the sheet opens, says
 * «1,384 لعبة» once a run of taps has settled (SAY_AFTER_MS) — again when a change leaves the count as it was. Clearing
 * everything moves focus to «اعرض N لعبة» (the «امسح الكل» key goes away with the filters).
 */
import { useEffect, useId, useRef, useState } from "react";

import { useFormat } from "~/i18n/react";
import { GENRE_KEYS, PLAY_MODES, type GenreKey, type PlayMode } from "~/lib/switch-builder/types";
import { Chip, ChipGroup } from "~/ui/Chip";
import { FieldGroup, Switch } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Sheet } from "~/ui/Sheet";
import { isolate } from "~/ui/BidiText";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { gbText, useBuilderT } from "../lib/format";
import { activeFilterGroups, NO_FILTERS, PRICE_BANDS, SIZE_BANDS, type LibraryFilters, type PriceBand, type SizeBand } from "../lib/library";

/** The count is said this long after the last change in the sheet: a run of taps is said once. */
export const SAY_AFTER_MS = 600;

export type FiltersSheetProps = {
  open: boolean;
  onClose: () => void;
  filters: LibraryFilters;
  onChange: (filters: LibraryFilters) => void;
  /** Games matching each genre / play mode with the other filters as they are. */
  counts: { genres: ReadonlyMap<string, number>; modes: ReadonlyMap<string, number> };
  /** Games matching all the filters now. */
  total: number;
  remainingBytes: number;
  /** Which groups make sense with today's data. */
  offer: { price: boolean; cartridge: boolean; sized: boolean };
};

const toggle = <T,>(values: readonly T[], value: T, on: boolean): T[] => (on ? [...values.filter((item) => item !== value), value] : values.filter((item) => item !== value));

const NBSP = " ";

/**
 * The play modes offered as filters. "online" is left out: Wikidata records it for a handful of games only (5 of
 * ~4,850 in the 2026-11-21 build), so «عبر الإنترنت» would hide nearly every online game — a filter that misleads.
 * The details sheet still names it where the data has it.
 */
export const FILTER_MODES: readonly PlayMode[] = PLAY_MODES.filter((mode) => mode !== "online");

/**
 * A band's words: «حتى 2 GB», «2–8 GB», «أكثر من 16 GB», «حتى $10», «$10–30» — the figures with their unit are one
 * isolated left-to-right run, so they keep their order in an Arabic or Sorani label (the page's numbering applies).
 */
export function useBandLabel(): (kind: "size" | "price", id: SizeBand | PriceBand) => string {
  const t = useBuilderT();
  const f = useFormat();
  return (kind, id) => {
    const bands: ReadonlyArray<{ id: string; low: number; high: number | null }> =
      kind === "size"
        ? SIZE_BANDS.map((band) => ({ id: band.id, low: band.minGiB, high: band.maxGiB }))
        : PRICE_BANDS.map((band) => ({ id: band.id, low: band.min / 100, high: band.max === null ? null : band.max / 100 }));
    const band = bands.find((entry) => entry.id === id);
    if (!band) return "";
    const figure = (value: number) => (kind === "size" ? `${f.number(value)}${NBSP}GB` : `$${f.number(value)}`);
    if (band.high === null) return t("filters.over", { value: isolate(figure(band.low)) });
    if (band.low === 0) return t("filters.upTo", { value: isolate(figure(band.high)) });
    return isolate(kind === "size" ? `${f.number(band.low)}–${figure(band.high)}` : `$${f.number(band.low)}–${f.number(band.high)}`);
  };
}

export function FiltersSheet({ open, onClose, filters, onChange, counts, total, remainingBytes, offer }: FiltersSheetProps) {
  const t = useBuilderT();
  const f = useFormat();
  const id = useId();
  const bandLabel = useBandLabel();
  const set = (change: Partial<LibraryFilters>) => onChange({ ...filters, ...change });
  const active = activeFilterGroups(filters).length;
  const genres = GENRE_KEYS.filter((genre) => (counts.genres.get(genre) ?? 0) > 0 || filters.genres.includes(genre));
  const modes = FILTER_MODES.filter((mode) => (counts.modes.get(mode) ?? 0) > 0 || filters.modes.includes(mode));
  const show = useRef<HTMLButtonElement>(null);

  // what the live region says: empty when the sheet opens (its description has the count then), the count after a change
  const [said, setSaid] = useState("");
  const openedWith = useRef<LibraryFilters | null>(null);
  const found = t("games.found", { count: total, n: f.number(total) });
  useEffect(() => {
    if (!open) {
      openedWith.current = null;
      setSaid("");
      return;
    }
    if (openedWith.current === null) {
      openedWith.current = filters;
      return;
    }
    if (filters === openedWith.current) return;
    // the same words again would not be said: a no-break space at the end changes them
    const timer = setTimeout(() => setSaid((previous) => (previous === found ? `${found} ` : found)), SAY_AFTER_MS);
    return () => clearTimeout(timer);
  }, [open, filters, found]);

  const clearAll = () => {
    onChange(NO_FILTERS);
    show.current?.focus();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t("filters.title")}
      description={<span className="nums">{found}</span>}
      presentation="side"
      footer={
        <>
          {active > 0 ? (
            <Key variant="ghost" onClick={clearAll} className="flex-none!">
              {t("filters.clearAll")}
            </Key>
          ) : null}
          <Key ref={show} variant="primary" onClick={onClose}>
            {t("filters.show", { count: total, n: f.number(total) })}
          </Key>
        </>
      }
    >
      <VisuallyHidden role="status" aria-atomic="true">
        {said}
      </VisuallyHidden>
      <div className="sb-filters">
        {genres.length > 0 ? (
          <FieldGroup legend={t("filters.genre")} layout="row">
            {genres.map((genre: GenreKey) => (
              <Chip
                key={genre}
                input="checkbox"
                name="genre"
                value={genre}
                checked={filters.genres.includes(genre)}
                count={counts.genres.get(genre) ?? 0}
                onChange={(event) => set({ genres: toggle(filters.genres, genre, event.currentTarget.checked) })}
              >
                {t(`genre.${genre}`)}
              </Chip>
            ))}
          </FieldGroup>
        ) : null}
        {modes.length > 0 ? (
          <FieldGroup legend={t("filters.modes")} layout="row">
            {modes.map((mode: PlayMode) => (
              <Chip
                key={mode}
                input="checkbox"
                name="mode"
                value={mode}
                checked={filters.modes.includes(mode)}
                count={counts.modes.get(mode) ?? 0}
                onChange={(event) => set({ modes: toggle(filters.modes, mode, event.currentTarget.checked) })}
              >
                {t(`mode.${mode}`)}
              </Chip>
            ))}
          </FieldGroup>
        ) : null}
        {offer.sized ? (
          <div className="sb-filters__group">
            <p className="sb-filters__legend" id={`${id}-size`}>
              {t("filters.size")}
            </p>
            <ChipGroup
              aria-labelledby={`${id}-size`}
              value={filters.size ?? ""}
              onChange={(value) => set({ size: value === "" ? null : (value as SizeBand) })}
              options={[{ value: "", label: t("filters.any") }, ...SIZE_BANDS.map((band) => ({ value: band.id, label: bandLabel("size", band.id) }))]}
            />
          </div>
        ) : null}
        {offer.price ? (
          <div className="sb-filters__group">
            <p className="sb-filters__legend" id={`${id}-price`}>
              {t("filters.price")}
            </p>
            <ChipGroup
              aria-labelledby={`${id}-price`}
              value={filters.price ?? ""}
              onChange={(value) => set({ price: value === "" ? null : (value as PriceBand) })}
              options={[{ value: "", label: t("filters.any") }, ...PRICE_BANDS.map((band) => ({ value: band.id, label: bandLabel("price", band.id) }))]}
            />
          </div>
        ) : null}
        <div className="sb-filters__switches">
          {offer.sized ? (
            <Switch
              label={t("filters.fits")}
              hint={<span className="nums">{t("filters.fitsHint", { left: gbText(f, remainingBytes) })}</span>}
              checked={filters.fits}
              onChange={(event) => set({ fits: event.currentTarget.checked })}
            />
          ) : null}
          {offer.cartridge ? <Switch label={t("filters.cartridge")} checked={filters.cartridge} onChange={(event) => set({ cartridge: event.currentTarget.checked })} /> : null}
          {offer.sized ? <Switch label={t("filters.sized")} checked={filters.sized} onChange={(event) => set({ sized: event.currentTarget.checked })} /> : null}
        </div>
      </div>
    </Sheet>
  );
}
