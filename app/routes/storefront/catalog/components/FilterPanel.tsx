/**
 * The filter groups of a product list (DESIGN.md §9.7 filter drawer, §9.8 chips). Two renderings of the same groups:
 *
 *   mode="live"  inside the filter sheet (script running): chips are toggles; every change navigates AT ONCE (the
 *                results update behind the sheet; nothing waits for it to close). Price fields apply on Enter / blur
 *                after validation. Chip groups regroup with motion when their options change (useFlip).
 *   mode="form"  no script: the same groups as native inputs (checkbox / radio chips, number fields, the sort) in a
 *                plain GET form with a submit key — the list still filters, sorts and pages without JavaScript.
 *
 * Every option shows how many products choosing it gives (counted with the other filters applied); options that
 * give nothing are not offered.
 */
import { useRef, useState, type FormEvent, type ReactNode } from "react";

import { useFormat, useT } from "~/i18n/react";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { FieldGroup, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { parsePriceInput, type ListingFacets, type ListingQuery, type ListingSort } from "../listing-model";
import { ChipCount } from "./ChipCount";
import { ChipText, InPageDir } from "./InPageDir";
import { useFlip } from "./use-flip";

export type FilterPanelProps = {
  mode: "live" | "form";
  query: ListingQuery;
  facets: ListingFacets;
  /** On a platform hub the platform is the page: no platform group. */
  scope: "category" | "platform" | "search";
  /** live: apply a change. */
  onChange?: (change: Partial<ListingQuery>) => void;
  /** form: the sorts to offer, and the current one. */
  sorts?: readonly ListingSort[];
  sort?: ListingSort;
  /** form: hidden fields to keep (the search query). */
  hidden?: Record<string, string>;
  /** form: where the GET form goes (this page's path). */
  action?: string;
};

const Count = ChipCount;

/** A group of chips that regroup with motion when their options change. */
function ChipList({ children, signature, label }: { children: ReactNode; signature: string; label?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref, signature);
  return (
    <div ref={ref} className="chips" role={label ? "group" : undefined} aria-label={label}>
      {children}
    </div>
  );
}

export function FilterPanel({ mode, query, facets, scope, onChange, sorts = [], sort, hidden = {}, action }: FilterPanelProps) {
  const t = useT("catalog");
  const ui = useT("ui");
  const f = useFormat();
  const live = mode === "live";
  const change = (next: Partial<ListingQuery>) => onChange?.(next);
  const platformName = (slug: string, fallback: string) => (isPlatform(slug) ? ui(`platform.${slug}`) : fallback);

  const groups: ReactNode[] = [];

  if (!live && sorts.length > 1) {
    groups.push(
      <FieldGroup key="sort" legend={t("sort.label")} layout="row">
        <div className="chips">
          {sorts.map((value) => (
            <Chip key={value} input="radio" name="sort" value={value} defaultChecked={(sort ?? sorts[0]) === value}>
              {t(`sort.${value}`)}
            </Chip>
          ))}
        </div>
      </FieldGroup>,
    );
  }

  if (scope !== "platform" && facets.platforms.length > 0) {
    groups.push(
      <FieldGroup key="platforms" legend={t("filter.platform")} layout="row">
        <ChipList signature={facets.platforms.map((o) => o.value).join("|")}>
          {facets.platforms.map((option) => {
            const label = (
              <InPageDir>
                <span className="inline-flex items-center gap-1.5" data-gel={isPlatform(option.value) ? option.value : undefined}>
                  {isPlatform(option.value) ? <PlatformLed solid /> : null}
                  <ChipText label={platformName(option.value, option.label)} count={option.count} />
                </span>
              </InPageDir>
            );
            const on = query.platforms.includes(option.value);
            return live ? (
              <Chip key={option.value} data-flip={option.value} selected={on} onClick={() => change({ platforms: on ? query.platforms.filter((p) => p !== option.value) : [...query.platforms, option.value] })}>
                {label}
              </Chip>
            ) : (
              <Chip key={option.value} input="checkbox" name="platform" value={option.value} defaultChecked={on}>
                {label}
              </Chip>
            );
          })}
        </ChipList>
      </FieldGroup>,
    );
  }

  if (facets.categories.length > 0) {
    groups.push(
      <FieldGroup key="category" legend={t("filter.category")} layout="row">
        <ChipList signature={facets.categories.map((o) => o.value).join("|")}>
          {!live ? (
            <Chip input="radio" name="cat" value="" defaultChecked={query.category === null}>
              {t("filter.any")}
            </Chip>
          ) : null}
          {facets.categories.map((option) => {
            const on = query.category === option.value;
            return live ? (
              <Chip key={option.value} data-flip={option.value} selected={on} onClick={() => change({ category: on ? null : option.value })}>
                <ChipText label={option.label} count={option.count} />
              </Chip>
            ) : (
              <Chip key={option.value} input="radio" name="cat" value={option.value} defaultChecked={on}>
                <ChipText label={option.label} count={option.count} />
              </Chip>
            );
          })}
        </ChipList>
      </FieldGroup>,
    );
  }

  if (facets.devices.length > 0) {
    groups.push(
      <FieldGroup key="device" legend={t("filter.device")} hint={t("filter.deviceHint")} layout="row">
        <ChipList signature={facets.devices.map((o) => o.value).join("|")}>
          {!live ? (
            <Chip input="radio" name="device" value="" defaultChecked={query.device === null}>
              {t("filter.any")}
            </Chip>
          ) : null}
          {facets.devices.map((option) => {
            const on = query.device === option.value;
            return live ? (
              <Chip key={option.value} data-flip={option.value} selected={on} onClick={() => change({ device: on ? null : option.value })}>
                <ChipText label={option.label} count={option.count} />
              </Chip>
            ) : (
              <Chip key={option.value} input="radio" name="device" value={option.value} defaultChecked={on}>
                <ChipText label={option.label} count={option.count} />
              </Chip>
            );
          })}
        </ChipList>
      </FieldGroup>,
    );
  }

  groups.push(<PriceGroup key="price" live={live} query={query} facets={facets} onChange={change} />);

  if (facets.inStock > 0 || facets.deals > 0 || query.inStock || query.deals) {
    groups.push(
      <FieldGroup key="availability" legend={t("filter.availability")} layout="row">
        <div className="chips">
          {facets.inStock > 0 || query.inStock ? (
            live ? (
              <Chip selected={query.inStock} onClick={() => change({ inStock: !query.inStock })}>
                {t("filter.inStock")} <Count n={facets.inStock} />
              </Chip>
            ) : (
              <Chip input="checkbox" name="stock" value="1" defaultChecked={query.inStock}>
                {t("filter.inStock")} <Count n={facets.inStock} />
              </Chip>
            )
          ) : null}
          {facets.deals > 0 || query.deals ? (
            live ? (
              <Chip selected={query.deals} onClick={() => change({ deals: !query.deals })}>
                {t("filter.deals")} <Count n={facets.deals} />
              </Chip>
            ) : (
              <Chip input="checkbox" name="deals" value="1" defaultChecked={query.deals}>
                {t("filter.deals")} <Count n={facets.deals} />
              </Chip>
            )
          ) : null}
        </div>
      </FieldGroup>,
    );
  }

  if (facets.arabic.length > 0) {
    groups.push(
      <FieldGroup key="arabic" legend={t("filter.arabic")} hint={t("filter.arabicHint")} layout="row">
        <div className="chips">
          {!live ? (
            <Chip input="radio" name="arabic" value="" defaultChecked={query.arabic === null}>
              {t("filter.any")}
            </Chip>
          ) : null}
          {facets.arabic.map((option) => {
            const on = query.arabic === option.value;
            return live ? (
              <Chip key={option.value} selected={on} onClick={() => change({ arabic: on ? null : option.value })}>
                {t(`filter.arabicLevel.${option.value}`)} <Count n={option.count} />
              </Chip>
            ) : (
              <Chip key={option.value} input="radio" name="arabic" value={option.value} defaultChecked={on}>
                {t(`filter.arabicLevel.${option.value}`)} <Count n={option.count} />
              </Chip>
            );
          })}
        </div>
      </FieldGroup>,
    );
  }

  if (facets.formats.length > 0) {
    groups.push(
      <FieldGroup key="formats" legend={t("filter.format")} hint={t("filter.formatHint")} layout="row">
        <div className="chips">
          {facets.formats.map((option) => {
            const on = query.formats.includes(option.value);
            return live ? (
              <Chip key={option.value} selected={on} onClick={() => change({ formats: on ? query.formats.filter((v) => v !== option.value) : [...query.formats, option.value] })}>
                {t(`filter.formatValue.${option.value}`)} <Count n={option.count} />
              </Chip>
            ) : (
              <Chip key={option.value} input="checkbox" name="format" value={option.value} defaultChecked={on}>
                {t(`filter.formatValue.${option.value}`)} <Count n={option.count} />
              </Chip>
            );
          })}
        </div>
      </FieldGroup>,
    );
  }

  if (live) return <div className="grid grid-cols-[minmax(0,1fr)] gap-6">{groups}</div>;
  return (
    <form method="get" action={action} className="grid grid-cols-[minmax(0,1fr)] gap-6">
      {Object.entries(hidden).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      {groups}
      <div>
        <Key type="submit" variant="ink">
          {t("filter.submit")}
        </Key>
      </div>
      <p className="type-caption text-ink-2">{t("filter.priceNote", { example: iqdText(f, 250_000) })}</p>
    </form>
  );
}

function PriceGroup({ live, query, facets, onChange }: { live: boolean; query: ListingQuery; facets: ListingFacets; onChange: (change: Partial<ListingQuery>) => void }) {
  const t = useT("catalog");
  const f = useFormat();
  const [min, setMin] = useState(query.priceMin === null ? "" : String(query.priceMin));
  const [max, setMax] = useState(query.priceMax === null ? "" : String(query.priceMax));
  const [errors, setErrors] = useState<{ min?: string; max?: string }>({});
  // follow the URL (a band chip, "clear all", Back) unless the shopper is typing
  const [seen, setSeen] = useState(`${query.priceMin}|${query.priceMax}`);
  const urlKey = `${query.priceMin}|${query.priceMax}`;
  if (urlKey !== seen) {
    setSeen(urlKey);
    setMin(query.priceMin === null ? "" : String(query.priceMin));
    setMax(query.priceMax === null ? "" : String(query.priceMax));
    setErrors({});
  }

  const apply = () => {
    const low = parsePriceInput(min);
    const high = parsePriceInput(max);
    const invalid = t("filter.priceInvalid", { example: iqdText(f, 250_000) });
    if (low === "invalid" || high === "invalid") return setErrors({ min: low === "invalid" ? invalid : undefined, max: high === "invalid" ? invalid : undefined });
    if (low !== null && high !== null && low > high) return setErrors({ max: t("filter.priceOrder") });
    setErrors({});
    if (low !== query.priceMin || high !== query.priceMax) onChange({ priceMin: low, priceMax: high });
  };
  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    apply();
  };

  const bandLabel = (band: { min: number | null; max: number | null }) =>
    band.min === null ? t("filter.priceUpTo", { max: iqdText(f, band.max ?? 0) }) : band.max === null ? t("filter.priceFrom", { min: iqdText(f, band.min) }) : t("filter.priceBetween", { min: iqdText(f, band.min), max: iqdText(f, band.max) });

  if (!facets.price && query.priceMin === null && query.priceMax === null) return null;
  const hint = facets.price ? t("filter.priceSpan", { min: iqdText(f, facets.price.min), max: iqdText(f, facets.price.max) }) : undefined;
  const fields = (
    <div className="grid grid-cols-2 gap-3">
      <TextField
        label={t("filter.priceMin")}
        name="min"
        inputMode="numeric"
        autoComplete="off"
        value={live ? min : undefined}
        defaultValue={live ? undefined : min}
        onChange={live ? (event) => setMin(event.target.value) : undefined}
        onBlur={live ? apply : undefined}
        end={<span className="type-caption text-ink-2">{t("filter.currency")}</span>}
        error={errors.min}
      />
      <TextField
        label={t("filter.priceMax")}
        name="max"
        inputMode="numeric"
        autoComplete="off"
        value={live ? max : undefined}
        defaultValue={live ? undefined : max}
        onChange={live ? (event) => setMax(event.target.value) : undefined}
        onBlur={live ? apply : undefined}
        end={<span className="type-caption text-ink-2">{t("filter.currency")}</span>}
        error={errors.max}
      />
    </div>
  );

  return (
    <FieldGroup legend={t("filter.price")} hint={hint}>
      {live ? (
        <form onSubmit={onSubmit} noValidate className="grid grid-cols-[minmax(0,1fr)] gap-2">
          {fields}
          <button type="submit" className="sr-only">
            {t("filter.priceApply")}
          </button>
        </form>
      ) : (
        fields
      )}
      {live && facets.priceBands.length > 1 ? (
        <div className={cx("chips", "pt-1")} role="group" aria-label={t("filter.priceBands")}>
          {facets.priceBands.map((band) => {
            const on = query.priceMin === band.min && query.priceMax === band.max;
            return (
              <Chip key={`${band.min}-${band.max}`} selected={on} onClick={() => onChange(on ? { priceMin: null, priceMax: null } : { priceMin: band.min, priceMax: band.max })}>
                <bdi>{bandLabel(band)}</bdi> <Count n={band.count} />
              </Chip>
            );
          })}
        </div>
      ) : null}
    </FieldGroup>
  );
}
