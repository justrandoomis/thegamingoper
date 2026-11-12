/**
 * Filters of /used — Design System v2 §6.8 (and the listing behaviour of §6.3). One source of truth: the URL. The form
 * is a real GET form (it submits without script); with script every choice applies at once (navigate with `replace`,
 * scroll kept), the price fields apply on Enter, on blur or with «طبّق», and the inputs stay mounted so focus never
 * jumps. Offline (v2 §6.17 "filtering message") every control here is disabled — the list says why — instead of
 * navigating into the offline page.
 *
 *   <FilterForm layout="sidebar" … />     ≥1024: a sticky sidebar of checkbox rows with counts (never stacked chips)
 *   <FilterForm layout="sheet" … />       <1024, inside the filter sheet: chips for the short facets (≤6 values),
 *                                         checkbox rows for the long ones (models)
 *   <ActiveFilters … />                   the chosen values as removable chips above the list, + «امسح الكل»
 *   <PlatformRail … />                    «الكل · ● Nintendo 2 · ● PlayStation 2 …» as link chips (work without script)
 *   <SortSelect … /> · <SortList … />     the sort as a select (≥1024) and as 52px rows in the sort sheet (<1024)
 */
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Form, useLocation, useNavigate } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useLocalePath, useT } from "~/i18n/react";
import type { UsedGrade } from "~/lib/dto";
import type { UsedFacets, UsedFilters, UsedSort } from "~/server/services/used.server";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { gradeKey } from "~/ui/GradeBadge";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { HrefLink } from "~/ui/Pagination";
import { isPlatform, PlatformLed } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { useUsedT } from "../i18n";

/** The list's path (locale-less). */
export const USED_PATH = "/used";
export const SORTS: readonly UsedSort[] = ["newest", "price_asc", "price_desc"];

/** Left-to-right isolate (U+2066) and its end (U+2069): a grade letter reads left to right inside Arabic («A+»). */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);
/** First-strong isolate (U+2068): an amount keeps its figure first («5,000 د.ع») in every language. */
const FSI = String.fromCharCode(0x2068);
const amount = (text: string) => `${FSI}${text}${PDI}`;

type ListName = "platform" | "model" | "grade" | "storage" | "location";

type Draft = {
  platform: string[];
  model: string[];
  grade: string[];
  storage: string[];
  location: string[];
  warranty: string;
  min: string;
  max: string;
};

const draftOf = (filters: UsedFilters): Draft => ({
  platform: [...(filters.platform ?? [])],
  model: [...(filters.model ?? [])],
  grade: [...(filters.grade ?? [])],
  storage: [...(filters.storage ?? [])],
  location: [...(filters.location ?? [])],
  warranty: filters.warrantyMin !== undefined ? String(filters.warrantyMin) : "",
  min: filters.priceMin !== undefined ? String(filters.priceMin) : "",
  max: filters.priceMax !== undefined ? String(filters.priceMax) : "",
});

/** The query string of a draft (the page reset; the sort kept). */
function searchOf(draft: Draft, sort: string | undefined): string {
  const params = new URLSearchParams();
  for (const name of ["platform", "model", "grade", "storage", "location"] as const) for (const value of draft[name]) params.append(name, value);
  if (draft.warranty) params.set("warranty", draft.warranty);
  const digits = (value: string) => value.replace(/[^\d]/g, "");
  if (digits(draft.min)) params.set("min", digits(draft.min));
  if (digits(draft.max)) params.set("max", digits(draft.max));
  if (sort) params.set("sort", sort);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** `search` with `change` applied and the page count dropped (a new choice starts from the first page). */
export function searchWith(search: string, change: (params: URLSearchParams) => void): string {
  const params = new URLSearchParams(search);
  params.delete("page");
  change(params);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The list without any filter, keeping the sort. */
export const clearedHref = (filters: UsedFilters) => `${USED_PATH}${filters.sort ? `?sort=${filters.sort}` : ""}`;

/** The design system's name for the four known platforms (Latin brand names stay Latin), else the catalogue's. */
export function usePlatformName(): (slug: string, fallback: string) => string {
  const ui = useT("ui");
  return (slug, fallback) => (isPlatform(slug) ? ui(`platform.${slug}`) : fallback);
}

/** «A+ · كالجديد» — the grade first (isolated left to right), then its word: the grade badge's words, in plain text. */
export function useGradeLabel(): (grade: string) => string {
  const shop = useT("ui-shop");
  return (grade) => `${LRI}${grade}${PDI} · ${shop(`grade.words.${gradeKey(grade)}`)}`;
}

/** One group of a filter form: a legend and its options. */
function Group({ legend, children, rows = false }: { legend: string; children: ReactNode; rows?: boolean }) {
  return (
    <fieldset className="used-facet">
      <legend className="used-facet__title">{legend}</legend>
      <div className={rows ? "grid" : "flex flex-wrap gap-2"}>{children}</div>
    </fieldset>
  );
}

export type FilterFormProps = {
  facets: UsedFacets;
  filters: UsedFilters;
  /** sidebar (≥1024): checkbox rows · sheet (<1024): chips for short facets, rows for long ones. */
  layout: "sidebar" | "sheet";
  /** Makes ids unique when the form appears twice (sidebar and sheet). */
  idPrefix: string;
  className?: string;
};

export function FilterForm({ facets, filters, layout, idPrefix, className }: FilterFormProps) {
  const t = useUsedT();
  const f = useFormat();
  const navigate = useNavigate();
  const location = useLocation();
  const localePath = useLocalePath();
  const platformName = usePlatformName();
  const gradeLabel = useGradeLabel();
  const shop = useT("ui-shop");
  const [draft, setDraft] = useState<Draft>(() => draftOf(filters));
  const titleId = useId();
  const online = useOnline();

  // The URL is the truth: when it changes (a removed chip, Back), the form follows.
  const urlKey = location.search;
  const [syncedFor, setSyncedFor] = useState(urlKey);
  if (syncedFor !== urlKey) {
    setSyncedFor(urlKey);
    setDraft(draftOf(filters));
  }

  const apply = (next: Draft) => {
    const search = searchOf(next, filters.sort);
    if (search === location.search || !online) return;
    navigate(`${localePath(USED_PATH)}${search}`, { replace: true, preventScrollReset: true });
  };
  const toggle = (name: ListName, value: string) => {
    const list = draft[name].includes(value) ? draft[name].filter((entry) => entry !== value) : [...draft[name], value];
    const next = { ...draft, [name]: list };
    setDraft(next);
    apply(next);
  };
  const choose = (warranty: string) => {
    const next = { ...draft, warranty };
    setDraft(next);
    apply(next);
  };
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    apply(draft);
  };
  const days = (n: number) => shop("days", { count: n, n: f.number(n) });

  /** A facet's values: checkbox rows with the count at the end (sidebar, long lists), or chips (sheet, short lists). */
  const options = (name: ListName, values: { value: string; label: ReactNode; count: number }[], asRows: boolean) =>
    values.map((option) =>
      asRows ? (
        <Checkbox
          key={option.value}
          id={`${idPrefix}-${name}-${option.value}`}
          name={name}
          value={option.value}
          checked={draft[name].includes(option.value)}
          onChange={() => toggle(name, option.value)}
          className="used-facet__row"
          label={
            <>
              <span className="min-w-0">{option.label}</span>
              <span className="used-facet__count nums">{f.number(option.count)}</span>
            </>
          }
        />
      ) : (
        <Chip key={option.value} input="checkbox" name={name} value={option.value} checked={draft[name].includes(option.value)} onChange={() => toggle(name, option.value)} count={option.count}>
          {option.label}
        </Chip>
      ),
    );
  const rows = layout === "sidebar";
  const platformLabel = (value: string, label: string) => (
    <span className="inline-flex items-center gap-1.5">
      {isPlatform(value) ? <PlatformLed platform={value} /> : null}
      {platformName(value, label)}
    </span>
  );

  return (
    <Form method="get" action={localePath(USED_PATH)} onSubmit={onSubmit} aria-labelledby={titleId} className={cx("used-filters", className)}>
      <h2 id={titleId} className="sr-only">
        {t("filter.title")}
      </h2>
      {filters.sort ? <input type="hidden" name="sort" value={filters.sort} /> : null}
      {/* Offline: one disabled fieldset turns every control below off (display: contents keeps the form's layout). */}
      <fieldset disabled={!online} className="contents">

      {facets.platforms.length > 1 ? (
        <Group legend={t("filter.platform")} rows={rows}>
          {options(
            "platform",
            facets.platforms.map((option) => ({ value: option.value, label: platformLabel(option.value, option.label), count: option.count })),
            rows,
          )}
        </Group>
      ) : null}

      {facets.models.length > 1 ? (
        <Group legend={t("filter.model")} rows={rows || facets.models.length > 6}>
          {options(
            "model",
            facets.models.map((option) => ({ value: option.value, label: <bdi>{option.label}</bdi>, count: option.count })),
            rows || facets.models.length > 6,
          )}
        </Group>
      ) : null}

      {facets.grades.length > 0 ? (
        <Group legend={t("filter.grade")} rows={rows}>
          {options(
            "grade",
            facets.grades.map((option) => ({ value: option.value, label: gradeLabel(option.value), count: option.count })),
            rows,
          )}
        </Group>
      ) : null}

      {facets.storages.length > 1 ? (
        <Group legend={t("filter.storage")} rows={rows}>
          {options(
            "storage",
            facets.storages.map((option) => ({ value: option.value, label: <bdi>{option.label}</bdi>, count: option.count })),
            rows,
          )}
        </Group>
      ) : null}

      {facets.warranties.length > 0 ? (
        <Group legend={t("filter.warranty")} rows={false}>
          <Chip input="radio" name="warranty" value="" checked={draft.warranty === ""} onChange={() => choose("")}>
            {t("filter.warrantyAny")}
          </Chip>
          {facets.warranties.map((option) => (
            <Chip key={option.days} input="radio" name="warranty" value={String(option.days)} checked={draft.warranty === String(option.days)} onChange={() => choose(String(option.days))}>
              {t("filter.warrantyMin", { days: days(option.days) })}
            </Chip>
          ))}
        </Group>
      ) : null}

      {facets.locations.length > 0 ? (
        <Group legend={t("filter.location")} rows={rows}>
          {options(
            "location",
            facets.locations.map((option) => ({ value: option.value, label: option.label, count: option.count })),
            rows,
          )}
        </Group>
      ) : null}

      {facets.price && facets.price.max > facets.price.min ? (
        <fieldset className="used-facet">
          <legend className="used-facet__title">{t("filter.price")}</legend>
          <div className="grid grid-cols-2 gap-3">
            <TextField
              id={`${idPrefix}-min`}
              label={t("filter.priceMin")}
              name="min"
              inputMode="numeric"
              autoComplete="off"
              enterKeyHint="search"
              value={draft.min}
              onChange={(event) => setDraft({ ...draft, min: event.currentTarget.value })}
              onBlur={() => apply(draft)}
            />
            <TextField
              id={`${idPrefix}-max`}
              label={t("filter.priceMax")}
              name="max"
              inputMode="numeric"
              autoComplete="off"
              enterKeyHint="search"
              value={draft.max}
              onChange={(event) => setDraft({ ...draft, max: event.currentTarget.value })}
              onBlur={() => apply(draft)}
            />
          </div>
          <p className="type-xs text-ink-2">{t("filter.priceRange", { min: amount(iqdText(f, facets.price.min)), max: amount(iqdText(f, facets.price.max)) })}</p>
          <Key type="submit" size="sm" className="justify-self-start">
            {t("filter.apply")}
          </Key>
        </fieldset>
      ) : (
        // Without the price fields the form still submits its choices without script.
        <Key type="submit" size="sm" className="used-nojs justify-self-start">
          {t("filter.apply")}
        </Key>
      )}
      </fieldset>
    </Form>
  );
}

/**
 * The filter sheet's commit (v2 §4.17): «اعرض 3 أجهزة» — the live count of what the chosen filters leave (every choice
 * applies at once). It closes the sheet. The sheet is its own view, so this is its one primary.
 */
export function FilterSheetShow({ total, onShow }: { total: number; onShow: () => void }) {
  const t = useUsedT();
  const f = useFormat();
  return (
    <Key variant="primary" onClick={onShow} className="flex-1">
      {total > 0 ? t("filter.show", { count: total, n: f.number(total) }) : t("filter.showNone")}
    </Key>
  );
}

/** The chosen filters as removable chips above the results (each removes its own value), and «امسح الكل». */
export function ActiveFilters({ facets, filters }: { facets: UsedFacets | null; filters: UsedFilters }) {
  const t = useUsedT();
  const f = useFormat();
  const shop = useT("ui-shop");
  const navigate = useNavigate();
  const location = useLocation();
  const localePath = useLocalePath();
  const platformName = usePlatformName();
  const gradeLabel = useGradeLabel();
  const online = useOnline();
  const labelOf = (list: { value: string; label: string }[] | undefined, value: string) => list?.find((option) => option.value === value)?.label ?? value;

  const items: { key: string; label: string; remove: (params: URLSearchParams) => void }[] = [];
  const without = (name: string, value: string) => (params: URLSearchParams) => {
    const kept = params.getAll(name).filter((entry) => entry !== value);
    params.delete(name);
    for (const entry of kept) params.append(name, entry);
  };
  for (const value of filters.platform ?? []) items.push({ key: `platform:${value}`, label: platformName(value, labelOf(facets?.platforms, value)), remove: without("platform", value) });
  for (const value of filters.model ?? []) items.push({ key: `model:${value}`, label: labelOf(facets?.models, value), remove: without("model", value) });
  for (const value of filters.grade ?? []) items.push({ key: `grade:${value}`, label: gradeLabel(value as UsedGrade), remove: without("grade", value) });
  for (const value of filters.storage ?? []) items.push({ key: `storage:${value}`, label: value, remove: without("storage", value) });
  for (const value of filters.location ?? []) items.push({ key: `location:${value}`, label: labelOf(facets?.locations, value), remove: without("location", value) });
  if (filters.warrantyMin !== undefined) {
    items.push({
      key: "warranty",
      label: `${t("filter.warranty")}: ${t("filter.warrantyMin", { days: shop("days", { count: filters.warrantyMin, n: f.number(filters.warrantyMin) }) })}`,
      remove: (params) => params.delete("warranty"),
    });
  }
  if (filters.priceMin !== undefined) items.push({ key: "min", label: t("filter.priceFrom", { price: amount(iqdText(f, filters.priceMin)) }), remove: (params) => params.delete("min") });
  if (filters.priceMax !== undefined) items.push({ key: "max", label: t("filter.priceTo", { price: amount(iqdText(f, filters.priceMax)) }), remove: (params) => params.delete("max") });
  if (items.length === 0) return null;

  return (
    <div className="grid gap-2">
      <h3 className="sr-only">{t("filter.active")}</h3>
      <ul className="flex flex-wrap items-center gap-2">
        {items.map((item) => (
          <li key={item.key}>
            <Chip disabled={!online} onRemove={() => navigate(`${localePath(USED_PATH)}${searchWith(location.search, item.remove)}`, { replace: true, preventScrollReset: true })}>
              {item.label}
            </Chip>
          </li>
        ))}
        <li>
          <Key as={HrefLink} to={clearedHref(filters)} size="sm" variant="ghost" disabled={!online} preventScrollReset>
            {t("filter.clear")}
          </Key>
        </li>
      </ul>
    </div>
  );
}

/** «الكل · ● Nintendo 2 · ● PlayStation 2 …» as link chips: one tap, no sheet, and they work without script. */
export function PlatformRail({ facets, filters, className }: { facets: UsedFacets; filters: UsedFilters; className?: string }) {
  const t = useUsedT();
  const location = useLocation();
  const platformName = usePlatformName();
  const online = useOnline();
  if (facets.platforms.length < 2) return null;
  const only = (slug: string | null) =>
    `${USED_PATH}${searchWith(location.search, (params) => {
      params.delete("platform");
      params.delete("model");
      if (slug) params.set("platform", slug);
    })}`;
  const chosen = filters.platform ?? [];
  return (
    <nav aria-label={t("list.platforms")} className={className}>
      <ul className="chips chips--rail chips--bleed [&>*]:shrink-0">
        <li>
          <Chip as={HrefLink} to={only(null)} selected={chosen.length === 0} count={facets.total} disabled={!online} preventScrollReset>
            {t("list.allPlatforms")}
          </Chip>
        </li>
        {facets.platforms.map((option) => (
          <li key={option.value}>
            <Chip as={HrefLink} to={only(option.value)} selected={chosen.length === 1 && chosen[0] === option.value} count={option.count} disabled={!online} preventScrollReset>
              <span className="inline-flex items-center gap-1.5">
                {isPlatform(option.value) ? <PlatformLed platform={option.value} /> : null}
                {platformName(option.value, option.label)}
              </span>
            </Chip>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** The sort's href: the same filters, another order (the first page). */
function sortHref(search: string, sort: UsedSort): string {
  return `${USED_PATH}${searchWith(search, (params) => (sort === "newest" ? params.delete("sort") : params.set("sort", sort)))}`;
}

/**
 * The sort as a select (≥1024): applies at once with script; without script it sits in a small GET form with its own
 * key (the filters ride along as hidden fields).
 */
export function SortSelect({ filters, className }: { filters: UsedFilters; className?: string }) {
  const t = useUsedT();
  const location = useLocation();
  const navigate = useNavigate();
  const localePath = useLocalePath();
  const online = useOnline();
  const kept = [...new URLSearchParams(location.search)].filter(([name]) => name !== "sort" && name !== "page");
  return (
    <Form method="get" action={localePath(USED_PATH)} className={cx("flex items-end gap-2", className)}>
      {kept.map(([name, value], index) => (
        <input key={`${name}:${value}:${index}`} type="hidden" name={name} value={value} />
      ))}
      <Select
        label={t("list.sortLabel")}
        hideLabel
        name="sort"
        value={filters.sort ?? "newest"}
        disabled={!online}
        onChange={(event) => navigate(`${localePath(sortHref(location.search, event.currentTarget.value as UsedSort))}`, { replace: true, preventScrollReset: true })}
        options={SORTS.map((sort) => ({ value: sort, label: t("list.sortShown", { sort: t(`list.sort.${sort}`) }) }))}
        className="min-w-[14rem]"
      />
      <Key type="submit" size="sm" className="used-nojs">
        {t("filter.apply")}
      </Key>
    </Form>
  );
}

/** The sort as 52px choice rows (the sort sheet, <1024): each row is a link, so it works without script too. */
export function SortList({ filters, onPick }: { filters: UsedFilters; onPick?: () => void }) {
  const t = useUsedT();
  const location = useLocation();
  const online = useOnline();
  const current = filters.sort ?? "newest";
  return (
    <ul className="grid" aria-label={t("list.sortLabel")}>
      {SORTS.map((sort) => (
        <li key={sort}>
          <HrefLink
            to={sortHref(location.search, sort)}
            replace
            preventScrollReset
            onClick={(event) => {
              if (online) onPick?.();
              else event.preventDefault();
            }}
            className="listrow"
            aria-current={sort === current ? "true" : undefined}
            aria-disabled={online ? undefined : true}
            data-press="soft"
          >
            <span className={cx("min-w-0 flex-1", sort === current && "font-semibold")}>{t(`list.sort.${sort}`)}</span>
            {sort === current ? <Icon name="check" size={20} className="shrink-0" /> : null}
          </HrefLink>
        </li>
      ))}
    </ul>
  );
}
