/**
 * Filters of /used (DESIGN.md §9.7 filter drawer, §9.8 chips, §8.3 list). One source of truth: the URL. The form is a
 * real GET form (it submits without script); with script every chip applies at once (navigate with `replace`, scroll
 * kept), price fields apply on Enter or when they lose focus, and the inputs stay mounted so focus never jumps.
 *
 *   <FilterForm facets={facets} filters={filters} />          sidebar (≥ 1024) and the filter sheet (< 1024)
 *   <ActiveFilters facets={facets} filters={filters} />       the chosen values as removable chips above the list
 *   <PlatformRail facets={facets} filters={filters} />        platform chips as links (work without script)
 */
import { useId, useState, type FormEvent, type ReactNode } from "react";
import { Form, useLocation, useNavigate } from "react-router";

import { useFormat, useLocalePath, useT } from "~/i18n/react";
import type { UsedGrade } from "~/lib/dto";
import type { UsedFacets, UsedFilters } from "~/server/services/used.server";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { HrefLink } from "~/ui/Pagination";
import { isPlatform, PlatformLed } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { gradeKey } from "~/ui/GradeBadge";
import { useUsedT } from "../i18n";

/** The list's path (locale-less). */
export const USED_PATH = "/used";

/** Left-to-right isolate (U+2066) and its end (U+2069): an amount reads left to right inside Arabic text. */
const LRI = String.fromCharCode(0x2066);
const PDI = String.fromCharCode(0x2069);

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

/** The query string of a draft (page reset; the sort kept). */
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

/** `search` with `change` applied and the page number dropped. */
export function searchWith(search: string, change: (params: URLSearchParams) => void): string {
  const params = new URLSearchParams(search);
  params.delete("page");
  change(params);
  const text = params.toString();
  return text ? `?${text}` : "";
}

/** The design system's name for the four known platforms (Latin brand names stay Latin), else the catalogue's. */
export function usePlatformName(): (slug: string, fallback: string) => string {
  const ui = useT("ui");
  return (slug, fallback) => (isPlatform(slug) ? ui(`platform.${slug}`) : fallback);
}

/** "كالجديد (A+)" — the grade in words and its letter. */
export function useGradeLabel(): (grade: string) => string {
  const shop = useT("ui-shop");
  // The letters are isolated (as the kit's GradeTag does), so "A+" never reads "+A" inside Arabic or Sorani.
  return (grade) => `${shop(`grade.words.${gradeKey(grade)}`)} ${LRI}(${grade})${PDI}`;
}

function Group({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="grid gap-2">
      <legend className="mb-2 type-label font-semibold text-ink">{legend}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
    </fieldset>
  );
}

export type FilterFormProps = {
  facets: UsedFacets;
  filters: UsedFilters;
  /** Makes ids unique when the form appears twice (sidebar and sheet). */
  idPrefix: string;
  className?: string;
};

export function FilterForm({ facets, filters, idPrefix, className }: FilterFormProps) {
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

  // The URL is the truth: when it changes (a removed chip, Back), the form follows.
  const urlKey = location.search;
  const [syncedFor, setSyncedFor] = useState(urlKey);
  if (syncedFor !== urlKey) {
    setSyncedFor(urlKey);
    setDraft(draftOf(filters));
  }

  const apply = (next: Draft) => {
    const search = searchOf(next, filters.sort);
    if (search === location.search) return;
    navigate(`${localePath(USED_PATH)}${search}`, { replace: true, preventScrollReset: true });
  };
  const toggle = (name: "platform" | "model" | "grade" | "storage" | "location", value: string) => {
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

  const chips = (name: "platform" | "model" | "grade" | "storage" | "location", options: { value: string; label: ReactNode }[]) =>
    options.map((option) => (
      <Chip key={option.value} input="checkbox" name={name} value={option.value} checked={draft[name].includes(option.value)} onChange={() => toggle(name, option.value)}>
        {option.label}
      </Chip>
    ));

  return (
    <Form method="get" action={localePath(USED_PATH)} onSubmit={onSubmit} aria-labelledby={titleId} className={cx("grid gap-6", className)}>
      <h2 id={titleId} className="sr-only">
        {t("filter.title")}
      </h2>
      {filters.sort ? <input type="hidden" name="sort" value={filters.sort} /> : null}

      {facets.platforms.length > 1 ? (
        <Group legend={t("filter.platform")}>
          {chips(
            "platform",
            facets.platforms.map((option) => ({
              value: option.value,
              label: (
                <span className="inline-flex items-center gap-1.5">
                  {isPlatform(option.value) ? <PlatformLed platform={option.value} /> : null}
                  {platformName(option.value, option.label)}
                </span>
              ),
            })),
          )}
        </Group>
      ) : null}

      {facets.models.length > 1 ? <Group legend={t("filter.model")}>{chips("model", facets.models.map((option) => ({ value: option.value, label: option.label })))}</Group> : null}

      {facets.grades.length > 0 ? <Group legend={t("filter.grade")}>{chips("grade", facets.grades.map((option) => ({ value: option.value, label: gradeLabel(option.value) })))}</Group> : null}

      {facets.storages.length > 1 ? <Group legend={t("filter.storage")}>{chips("storage", facets.storages.map((option) => ({ value: option.value, label: option.label })))}</Group> : null}

      {facets.warranties.length > 0 ? (
        <Group legend={t("filter.warranty")}>
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

      {facets.locations.length > 0 ? <Group legend={t("filter.location")}>{chips("location", facets.locations.map((option) => ({ value: option.value, label: option.label })))}</Group> : null}

      {facets.price && facets.price.max > facets.price.min ? (
        <fieldset className="grid gap-2">
          <legend className="mb-2 type-label font-semibold text-ink">{t("filter.price")}</legend>
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
          <p className="type-caption text-ink-2">
            {t("filter.priceRange", { min: `${LRI}${iqdText(f, facets.price.min)}${PDI}`, max: `${LRI}${iqdText(f, facets.price.max)}${PDI}` })}
          </p>
        </fieldset>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Key type="submit" variant="ink" size="sm">
          {t("filter.apply")}
        </Key>
        <Key as={HrefLink} to={`${USED_PATH}${filters.sort ? `?sort=${filters.sort}` : ""}`} size="sm" variant="quiet" preventScrollReset>
          {t("filter.clear")}
        </Key>
      </div>
    </Form>
  );
}

/** The chosen filters as held chips with a ×, above the results (each removes its own value). */
export function ActiveFilters({ facets, filters }: { facets: UsedFacets | null; filters: UsedFilters }) {
  const t = useUsedT();
  const f = useFormat();
  const shop = useT("ui-shop");
  const navigate = useNavigate();
  const location = useLocation();
  const localePath = useLocalePath();
  const platformName = usePlatformName();
  const gradeLabel = useGradeLabel();
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
  if (filters.priceMin !== undefined) items.push({ key: "min", label: t("filter.priceFrom", { price: `${LRI}${iqdText(f, filters.priceMin)}${PDI}` }), remove: (params) => params.delete("min") });
  if (filters.priceMax !== undefined) items.push({ key: "max", label: t("filter.priceTo", { price: `${LRI}${iqdText(f, filters.priceMax)}${PDI}` }), remove: (params) => params.delete("max") });
  if (items.length === 0) return null;

  return (
    <div className="grid gap-2">
      <h3 className="sr-only">{t("filter.active")}</h3>
      <ul className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.key}>
            <Chip onRemove={() => navigate(`${localePath(USED_PATH)}${searchWith(location.search, item.remove)}`, { replace: true, preventScrollReset: true })}>{item.label}</Chip>
          </li>
        ))}
        <li>
          <Key as={HrefLink} to={`${USED_PATH}${filters.sort ? `?sort=${filters.sort}` : ""}`} size="sm" variant="quiet" preventScrollReset>
            {t("filter.clear")}
          </Key>
        </li>
      </ul>
    </div>
  );
}

/** "All · Nintendo · PlayStation · …" as link chips: one tap, no sheet, and they work without script. */
export function PlatformRail({ facets, filters }: { facets: UsedFacets; filters: UsedFilters }) {
  const t = useUsedT();
  const location = useLocation();
  const platformName = usePlatformName();
  if (facets.platforms.length < 2) return null;
  const only = (slug: string | null) =>
    `${USED_PATH}${searchWith(location.search, (params) => {
      params.delete("platform");
      params.delete("model");
      if (slug) params.set("platform", slug);
    })}`;
  const chosen = filters.platform ?? [];
  return (
    <nav aria-label={t("list.platforms")}>
      <ul className="chips chips--rail">
        <li>
          <Chip as={HrefLink} to={only(null)} selected={chosen.length === 0} preventScrollReset>
            {t("list.allPlatforms")}
          </Chip>
        </li>
        {facets.platforms.map((option) => (
          <li key={option.value}>
            <Chip as={HrefLink} to={only(option.value)} selected={chosen.length === 1 && chosen[0] === option.value} preventScrollReset>
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
