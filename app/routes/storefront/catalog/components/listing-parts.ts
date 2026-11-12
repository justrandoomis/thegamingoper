/**
 * What the list view and its zero-result state share: the list's data shape, the words for an active filter, and the
 * filters «امسح الكل» keeps (a choice made in the page's chip row stays).
 */
import type { ProductCardData } from "~/lib/dto";
import { useFormat, useT } from "~/i18n/react";
import { isPlatform } from "~/ui/PlatformLed";
import { iqdText } from "~/ui/PriceTag";
import type { FilterGroup, ListingFacets, ListingFilters, ListingQuery, ListingSort } from "../listing-model";

/** What a page's loader hands the list (a ListingResult without the hub). */
export type ListingData = {
  items: ProductCardData[];
  total: number;
  nextCursor: string | null;
  offset: number;
  sort: ListingSort;
  filters: ListingFilters;
  scopeTotal: number;
  facets: ListingFacets;
  relax: { group: FilterGroup; count: number }[];
};

/** Words for one active filter value. */
export function useFilterLabel(facets: ListingFacets) {
  const t = useT("catalog");
  const ui = useT("ui");
  const f = useFormat();
  return (group: FilterGroup, filters: ListingFilters, value?: string): string => {
    switch (group) {
      case "platforms": {
        const slug = value ?? "";
        return isPlatform(slug) ? ui(`platform.${slug}`) : (facets.platforms.find((option) => option.value === slug)?.label ?? slug);
      }
      case "category":
        return facets.categories.find((option) => option.value === filters.category)?.label ?? t("filter.categoryOther");
      case "device":
        return facets.devices.find((option) => option.value === filters.device)?.label ?? t("filter.deviceOther");
      case "price":
        return filters.priceMin === null
          ? t("filter.priceUpTo", { max: iqdText(f, filters.priceMax ?? 0) })
          : filters.priceMax === null
            ? t("filter.priceFrom", { min: iqdText(f, filters.priceMin) })
            : t("filter.priceBetween", { min: iqdText(f, filters.priceMin), max: iqdText(f, filters.priceMax) });
      case "inStock":
        return t("filter.inStock");
      case "deals":
        return t("filter.deals");
      case "arabic":
        return filters.arabic ? t(`filter.arabicLevel.${filters.arabic}`) : "";
      case "formats":
        return value ? t(`filter.formatValue.${value}`) : "";
    }
  };
}

/** «امسح الكل» clears the filter groups; a choice made in the page's chip row stays. */
export function keepElsewhere(query: ListingQuery, elsewhere: readonly FilterGroup[]): Partial<ListingFilters> {
  const kept: Partial<ListingFilters> = {};
  if (elsewhere.includes("platforms")) kept.platforms = query.platforms;
  if (elsewhere.includes("category")) kept.category = query.category;
  if (elsewhere.includes("device")) kept.device = query.device;
  return kept;
}
