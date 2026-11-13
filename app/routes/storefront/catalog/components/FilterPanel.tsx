/**
 * The filter groups of a product list (Design System v2 §6.3): ONE native GET form, used three ways —
 *
 *   the sticky sidebar from 1024 · the filter sheet below 1024 · the no-script panel (a <details> on phones)
 *
 * Every control is a real input (switch, checkbox and radio rows, chips holding a native checkbox or radio, two price
 * fields), so without script the form submits and the list filters, sorts and pages all the same (the submit key and
 * the sort group show only then). A group of six or fewer short values is a row of chips; a longer list is 44px rows
 * (v2 §6.3).
 * With script every change navigates AT ONCE through `onChange` (the results update behind the sheet; nothing waits
 * for it to close); the price fields apply on Enter / blur after validation, the ready ranges at once.
 *
 * Every value says how many products choosing it gives (counted with the other filters applied); a group that offers
 * nothing (one option and nothing chosen) is not shown, and groups the page shows elsewhere (the chip row) are left
 * out — their values ride along as hidden fields, so a submitted form keeps them.
 *
 * ORDER: the page's own (availability, platform, category, device, price, Arabic, format) until staff arrange the
 * listing's filters in the content module (admin 17.03, getListingFilterOrder): then `order` names the groups to offer,
 * in their order — the availability group stands where its first part (in stock, deals) is, with only the parts
 * named. A group left out is not offered; a value of it that a link brought along still filters (its chip above the
 * results removes it) and rides along as a hidden field.
 *
 * v2.1 (client note 4, "better icons"): each group's title carries its icon on a small clay disc; a department carries
 * its kind icon, a platform its device glyph in its colour, a device its own picture on a warm well; every count is a
 * quiet pill at the row's end.
 */
import { useState, type FormEvent, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { Checkbox, FieldGroup, Radio, Switch, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { isPlatform } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import { Render } from "~/ui/Stage";
import { parsePriceInput, type FilterGroup, type ListingFacets, type ListingQuery, type ListingSort } from "../listing-model";
import { ChipLabel, deviceGlyph, useKindIcon } from "./Hub";

export type FilterPanelProps = {
  query: ListingQuery;
  facets: ListingFacets;
  /** On a platform hub the platform is the page: no platform group. */
  scope: "category" | "platform" | "search";
  /** Groups the page offers elsewhere (its chip row): not repeated here; their values become hidden fields. */
  elsewhere?: readonly FilterGroup[];
  /** Script: apply a change at once. */
  onChange?: (change: Partial<ListingQuery>) => void;
  /** The sorts the list offers and the current one (the no-script sort group). */
  sorts: readonly ListingSort[];
  sort: ListingSort;
  /** Keys outside the list's query to keep (the search page's `q`). */
  hidden?: Record<string, string>;
  /** Where the GET form goes (this page's path, with the locale). */
  action: string;
  /** No connection: the controls rest, with the reason beside the list's count. */
  disabled?: boolean;
  /**
   * Short groups as chips (the sheet and the no-script panel, as in prototype A's sheet). The 264px sidebar keeps rows:
   * two chips with a dot and a count do not fit its width, and stacked chips read worse than aligned rows.
   */
  chips?: boolean;
  /** The staff's arrangement (content module): the groups to offer, in order. Null or omitted: the page's own order. */
  order?: readonly FilterGroup[] | null;
  className?: string;
};

/** The panel's own order of its groups ("availability" holds the in-stock switch and the deals box). */
const OWN_ORDER = ["availability", "platforms", "category", "device", "price", "arabic", "formats"] as const;
type PanelGroup = (typeof OWN_ORDER)[number];

/**
 * The panel's groups in the order to draw them, and which availability parts to offer: the page's own order without
 * an arrangement; with one, the named groups in its order — availability where its first named part is. Pure.
 */
export function panelOrder(order: readonly FilterGroup[] | null | undefined): { groups: PanelGroup[]; inStock: boolean; deals: boolean } {
  if (!order) return { groups: [...OWN_ORDER], inStock: true, deals: true };
  const groups: PanelGroup[] = [];
  for (const group of order) {
    const part: PanelGroup = group === "inStock" || group === "deals" ? "availability" : group;
    if (!groups.includes(part)) groups.push(part);
  }
  return { groups, inStock: order.includes("inStock"), deals: order.includes("deals") };
}

/** Six or fewer short values read best as chips (v2 §6.3: "chips for ≤6 short values"); longer lists as rows. */
const SHORT_LIST = 6;
const SHORT_LABEL = 20;
const shortList = (labels: readonly string[]) => labels.length <= SHORT_LIST && labels.every((label) => [...label].length <= SHORT_LABEL);

/** A value and how many products it gives, the count a quiet pill at the row's end. */
function Opt({ label, count }: { label: ReactNode; count: number }) {
  const f = useFormat();
  return (
    <span className="catalog-opt">
      <span className="catalog-opt__label">{label}</span>
      <span className="catalog-opt__count nums">{f.number(count)}</span>
    </span>
  );
}

/** A group's title with its icon on a small clay disc (the icon is decoration: the words are the legend). */
function Legend({ icon, children }: { icon: IconName; children: ReactNode }) {
  return (
    <span className="catalog-legend">
      <span className="clay-disc catalog-legend__disc" aria-hidden="true">
        <Icon name={icon} size={16} />
      </span>
      <span>{children}</span>
    </span>
  );
}

/** A row's words after its icon (a department's kind icon, a platform's glyph in its colour). */
function IconText({ icon, gel, children }: { icon: IconName; gel?: string; children: ReactNode }) {
  return (
    <span className="catalog-opt__with">
      <Icon name={icon} size={18} className={cx("catalog-opt__icon", gel && "catalog-chip__icon--plat")} data-gel={gel} />
      <span className="min-w-0">{children}</span>
    </span>
  );
}

/** A device row's words after its picture on a small warm well. */
function DeviceText({ artKey, children }: { artKey: string | null; children: ReactNode }) {
  return (
    <span className="catalog-opt__with">
      <span className="catalog-opt__thumb" aria-hidden="true">
        {artKey ? (
          <span className="render-slot absolute inset-[8%]">
            <Render name={artKey} alt="" sizes="32px" />
          </span>
        ) : null}
      </span>
      <span className="min-w-0">{children}</span>
    </span>
  );
}

export function FilterPanel({ query, facets, scope, elsewhere = [], onChange, sorts, sort, hidden = {}, action, disabled = false, chips = false, order = null, className }: FilterPanelProps) {
  const t = useT("catalog");
  const f = useFormat();
  const change = (next: Partial<ListingQuery>) => onChange?.(next);
  const chipsFit = (labels: readonly string[]) => chips && shortList(labels);
  const away = (group: FilterGroup) => elsewhere.includes(group);
  const arranged = panelOrder(order);
  // a group staff left out of this listing is not offered here (its value, if a link brought one, still applies)
  const offered = (group: PanelGroup) => arranged.groups.includes(group);
  const ui = useT("ui");
  const kindIcon = useKindIcon();
  // the device glyph in the platform's colour and the name in the row's own weight (the bold label belongs to running text)
  const platformLabel = (slug: string, fallback: string) =>
    isPlatform(slug) ? (
      <IconText icon={deviceGlyph(slug)} gel={slug}>
        {ui(`platform.${slug}`)}
      </IconText>
    ) : (
      fallback
    );

  // values of the groups shown elsewhere — or not offered in this listing — travel with a submitted form
  const kept: [string, string][] = [];
  if (away("platforms") || !offered("platforms")) for (const platform of query.platforms) kept.push(["platform", platform]);
  if ((away("category") || !offered("category")) && query.category) kept.push(["cat", query.category]);
  if ((away("device") || !offered("device")) && query.device) kept.push(["device", query.device]);
  if (!offered("price")) {
    if (query.priceMin !== null) kept.push(["min", String(query.priceMin)]);
    if (query.priceMax !== null) kept.push(["max", String(query.priceMax)]);
  }
  if ((!offered("availability") || !arranged.inStock) && query.inStock) kept.push(["stock", "1"]);
  if ((!offered("availability") || !arranged.deals) && query.deals) kept.push(["deals", "1"]);
  if (!offered("arabic") && query.arabic) kept.push(["arabic", query.arabic]);
  if (!offered("formats")) for (const format of query.formats) kept.push(["format", format]);

  // each group by its name; drawn below in the listing's order
  const parts: Partial<Record<PanelGroup, ReactNode>> = {};
  const set = (group: PanelGroup, node: ReactNode) => {
    parts[group] = node;
  };

  // availability: the in-stock switch and genuine reductions (only the parts this listing offers)
  const stockShown = arranged.inStock && (facets.inStock > 0 || query.inStock);
  const dealsShown = arranged.deals && (facets.deals > 0 || query.deals);
  if (stockShown || dealsShown) {
    set(
      "availability",
      <FieldGroup key="availability" legend={<Legend icon="package">{t("filter.availability")}</Legend>} className="catalog-facet">
        {stockShown ? (
          <Switch name="stock" value="1" checked={query.inStock} disabled={disabled} onChange={(event) => change({ inStock: event.target.checked })} label={<Opt label={t("filter.inStock")} count={facets.inStock} />} />
        ) : null}
        {dealsShown ? (
          <Checkbox name="deals" value="1" checked={query.deals} disabled={disabled} onChange={(event) => change({ deals: event.target.checked })} label={<Opt label={t("filter.deals")} count={facets.deals} />} />
        ) : null}
      </FieldGroup>,
    );
  }

  if (scope !== "platform" && !away("platforms") && (facets.platforms.length >= 2 || query.platforms.length > 0)) {
    const nameOf = (option: { value: string; label: string }) => (isPlatform(option.value) ? ui(`platform.${option.value}`) : option.label);
    const toggle = (value: string, on: boolean) => change({ platforms: on ? query.platforms.filter((p) => p !== value) : [...query.platforms, value] });
    set(
      "platforms",
      <FieldGroup key="platforms" legend={<Legend icon="game-controller">{t("filter.platform")}</Legend>} className="catalog-facet">
        {chipsFit(facets.platforms.map(nameOf)) ? (
          <div className="chips">
            {facets.platforms.map((option) => {
              const on = query.platforms.includes(option.value);
              const known = isPlatform(option.value) ? option.value : null;
              return (
                <Chip key={option.value} input="checkbox" name="platform" value={option.value} checked={on} disabled={disabled} onChange={() => toggle(option.value, on)} count={option.count}>
                  <ChipLabel icon={known ? deviceGlyph(known) : null} gel={known}>
                    {nameOf(option)}
                  </ChipLabel>
                </Chip>
              );
            })}
          </div>
        ) : (
          facets.platforms.map((option) => {
            const on = query.platforms.includes(option.value);
            return (
              <Checkbox
                key={option.value}
                name="platform"
                value={option.value}
                checked={on}
                disabled={disabled}
                onChange={() => toggle(option.value, on)}
                label={<Opt label={platformLabel(option.value, option.label)} count={option.count} />}
              />
            );
          })
        )}
      </FieldGroup>,
    );
  }

  if (!away("category") && (facets.categories.length >= 2 || query.category !== null)) {
    set(
      "category",
      <FieldGroup key="category" legend={<Legend icon="squares-four">{t("filter.category")}</Legend>} className="catalog-facet">
        {chipsFit(facets.categories.map((option) => option.label)) ? (
          <div className="chips">
            <Chip input="radio" name="cat" value="" checked={query.category === null} disabled={disabled} onChange={() => change({ category: null })} count={facets.without.category}>
              <ChipLabel icon="squares-four">{t("filter.any")}</ChipLabel>
            </Chip>
            {facets.categories.map((option) => (
              <Chip key={option.value} input="radio" name="cat" value={option.value} checked={query.category === option.value} disabled={disabled} onChange={() => change({ category: option.value })} count={option.count}>
                <ChipLabel icon={kindIcon(option.value)}>{option.label}</ChipLabel>
              </Chip>
            ))}
          </div>
        ) : (
          <>
            <Radio name="cat" value="" checked={query.category === null} disabled={disabled} onChange={() => change({ category: null })} label={t("filter.any")} />
            {facets.categories.map((option) => (
              <Radio
                key={option.value}
                name="cat"
                value={option.value}
                checked={query.category === option.value}
                disabled={disabled}
                onChange={() => change({ category: option.value })}
                label={<Opt label={<IconText icon={kindIcon(option.value)}>{option.label}</IconText>} count={option.count} />}
              />
            ))}
          </>
        )}
      </FieldGroup>,
    );
  }

  if (!away("device") && (facets.devices.length >= 2 || query.device !== null)) {
    set(
      "device",
      <FieldGroup key="device" legend={<Legend icon="plugs-connected">{t("filter.device")}</Legend>} hint={t("filter.deviceHint")} className="catalog-facet">
        <Radio name="device" value="" checked={query.device === null} disabled={disabled} onChange={() => change({ device: null })} label={t("filter.any")} />
        {facets.devices.map((option) => (
          <Radio
            key={option.value}
            name="device"
            value={option.value}
            checked={query.device === option.value}
            disabled={disabled}
            onChange={() => change({ device: option.value })}
            // the device's own picture on a warm well; the name in the page's direction: "PlayStation 5 (الطراز الأصلي
            // 2020)" keeps its brackets right
            label={<Opt label={<DeviceText artKey={option.artKey}>{option.label}</DeviceText>} count={option.count} />}
          />
        ))}
      </FieldGroup>,
    );
  }

  const price = <PriceGroup key="price" query={query} facets={facets} onChange={change} live={Boolean(onChange)} disabled={disabled} />;
  if ((facets.price && facets.price.min < facets.price.max) || query.priceMin !== null || query.priceMax !== null) set("price", price);

  if (facets.arabic.length > 0 || query.arabic !== null) {
    const levelName = (value: string) => t(`filter.arabicLevel.${value}`);
    set(
      "arabic",
      <FieldGroup key="arabic" legend={<Legend icon="translate">{t("filter.arabic")}</Legend>} hint={t("filter.arabicHint")} className="catalog-facet">
        {chipsFit(facets.arabic.map((option) => levelName(option.value))) ? (
          <div className="chips">
            <Chip input="radio" name="arabic" value="" checked={query.arabic === null} disabled={disabled} onChange={() => change({ arabic: null })} count={facets.without.arabic}>
              {t("filter.any")}
            </Chip>
            {facets.arabic.map((option) => (
              <Chip key={option.value} input="radio" name="arabic" value={option.value} checked={query.arabic === option.value} disabled={disabled} onChange={() => change({ arabic: option.value })} count={option.count}>
                {levelName(option.value)}
              </Chip>
            ))}
          </div>
        ) : (
          <>
            <Radio name="arabic" value="" checked={query.arabic === null} disabled={disabled} onChange={() => change({ arabic: null })} label={t("filter.any")} />
            {facets.arabic.map((option) => (
              <Radio
                key={option.value}
                name="arabic"
                value={option.value}
                checked={query.arabic === option.value}
                disabled={disabled}
                onChange={() => change({ arabic: option.value })}
                label={<Opt label={levelName(option.value)} count={option.count} />}
              />
            ))}
          </>
        )}
      </FieldGroup>,
    );
  }

  if (facets.formats.length >= 2 || query.formats.length > 0) {
    const formatName = (value: string) => t(`filter.formatValue.${value}`);
    const toggle = (value: (typeof query.formats)[number], on: boolean) => change({ formats: on ? query.formats.filter((v) => v !== value) : [...query.formats, value] });
    set(
      "formats",
      <FieldGroup key="formats" legend={<Legend icon="disc">{t("filter.format")}</Legend>} hint={t("filter.formatHint")} className="catalog-facet">
        {chipsFit(facets.formats.map((option) => formatName(option.value))) ? (
          <div className="chips">
            {facets.formats.map((option) => {
              const on = query.formats.includes(option.value);
              return (
                <Chip key={option.value} input="checkbox" name="format" value={option.value} checked={on} disabled={disabled} onChange={() => toggle(option.value, on)} count={option.count}>
                  {formatName(option.value)}
                </Chip>
              );
            })}
          </div>
        ) : (
          facets.formats.map((option) => {
            const on = query.formats.includes(option.value);
            return (
              <Checkbox
                key={option.value}
                name="format"
                value={option.value}
                checked={on}
                disabled={disabled}
                onChange={() => toggle(option.value, on)}
                label={<Opt label={formatName(option.value)} count={option.count} />}
              />
            );
          })
        )}
      </FieldGroup>,
    );
  }

  // no script: the sort as radio rows, then the submit key (the script path sorts from the toolbar)
  const sortGroup =
    sorts.length > 1 ? (
      <FieldGroup key="sort" legend={<Legend icon="sort-ascending">{t("sort.label")}</Legend>} className="catalog-facet catalog-nojs">
        {sorts.map((value) => (
          <Radio key={value} name="sort" value={value} defaultChecked={sort === value} label={t(`sort.${value}`)} />
        ))}
      </FieldGroup>
    ) : null;
  // the listing's order (staff's, or the page's own); only the groups that offer something here
  const groups = arranged.groups.flatMap((group) => (offered(group) && parts[group] ? [parts[group]] : []));

  const onSubmit = (event: FormEvent) => {
    // with script every control applies itself; Enter in a price field is handled by its group
    if (onChange) event.preventDefault();
  };

  return (
    <form method="get" action={action} onSubmit={onSubmit} className={cx("catalog-filters", className)} aria-label={t("filter.title")} noValidate>
      {Object.entries(hidden).map(([name, value]) => (
        <input key={`h:${name}`} type="hidden" name={name} value={value} />
      ))}
      {kept.map(([name, value], index) => (
        <input key={`k:${name}:${index}`} type="hidden" name={name} value={value} />
      ))}
      {groups}
      {sortGroup}
      <div className="catalog-nojs grid gap-3">
        <Key type="submit" variant="secondary" block>
          {t("filter.submit")}
        </Key>
        <p className="type-xs text-ink-2">{t("filter.priceNote", { example: iqdText(f, 250_000) })}</p>
      </div>
    </form>
  );
}

function PriceGroup({ query, facets, onChange, live, disabled }: { query: ListingQuery; facets: ListingFacets; onChange: (change: Partial<ListingQuery>) => void; live: boolean; disabled: boolean }) {
  const t = useT("catalog");
  const f = useFormat();
  const [min, setMin] = useState(query.priceMin === null ? "" : String(query.priceMin));
  const [max, setMax] = useState(query.priceMax === null ? "" : String(query.priceMax));
  const [errors, setErrors] = useState<{ min?: string; max?: string }>({});
  // follow the URL (a ready range, "clear all", Back) unless the shopper is typing
  const urlKey = `${query.priceMin}|${query.priceMax}`;
  const [seen, setSeen] = useState(urlKey);
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

  const bandLabel = (band: { min: number | null; max: number | null }) =>
    band.min === null ? t("filter.priceUpTo", { max: iqdText(f, band.max ?? 0) }) : band.max === null ? t("filter.priceFrom", { min: iqdText(f, band.min) }) : t("filter.priceBetween", { min: iqdText(f, band.min), max: iqdText(f, band.max) });
  const hint = facets.price ? t("filter.priceSpan", { min: iqdText(f, facets.price.min), max: iqdText(f, facets.price.max) }) : undefined;
  const onBand = facets.priceBands.some((band) => band.min === query.priceMin && band.max === query.priceMax);

  return (
    <FieldGroup legend={<Legend icon="tag">{t("filter.price")}</Legend>} hint={hint} className="catalog-facet">
      <div className="grid grid-cols-2 gap-3">
        <TextField
          label={t("filter.priceMin")}
          name="min"
          inputMode="numeric"
          autoComplete="off"
          value={min}
          disabled={disabled}
          onChange={(event) => setMin(event.target.value)}
          onBlur={live ? apply : undefined}
          onKeyDown={(event) => {
            if (live && event.key === "Enter") {
              event.preventDefault();
              apply();
            }
          }}
          end={<span className="type-xs text-ink-2">{t("filter.currency")}</span>}
          error={errors.min}
        />
        <TextField
          label={t("filter.priceMax")}
          name="max"
          inputMode="numeric"
          autoComplete="off"
          value={max}
          disabled={disabled}
          onChange={(event) => setMax(event.target.value)}
          onBlur={live ? apply : undefined}
          onKeyDown={(event) => {
            if (live && event.key === "Enter") {
              event.preventDefault();
              apply();
            }
          }}
          end={<span className="type-xs text-ink-2">{t("filter.currency")}</span>}
          error={errors.max}
        />
      </div>
      {live && facets.priceBands.length > 1 ? (
        <div className="catalog-js-only grid" role="radiogroup" aria-label={t("filter.priceBands")}>
          <Radio name="band" value="" checked={!onBand && query.priceMin === null && query.priceMax === null} disabled={disabled} onChange={() => onChange({ priceMin: null, priceMax: null })} label={t("filter.any")} />
          {facets.priceBands.map((band) => (
            <Radio
              key={`${band.min}-${band.max}`}
              name="band"
              value={`${band.min ?? ""}-${band.max ?? ""}`}
              checked={query.priceMin === band.min && query.priceMax === band.max}
              disabled={disabled}
              onChange={() => onChange({ priceMin: band.min, priceMax: band.max })}
              label={<Opt label={<bdi>{bandLabel(band)}</bdi>} count={band.count} />}
            />
          ))}
        </div>
      ) : null}
    </FieldGroup>
  );
}
