/**
 * The chosen variant of the product page lives in the URL: `?v=<sku>` (none = the default variant), so a link, a
 * reload, Back/Forward and the language switch (which keeps the query) all show the same version.
 *
 * Choosing is instant: the choice is held in state at once and the URL follows with a `replace` navigation (Back
 * leaves the product instead of walking through colours; the scroll stays). The route's shouldRevalidate skips the
 * loader for a change of `v` only — the page already has every variant — so nothing waits for the network.
 */
import { useState } from "react";
import { useLocation, useNavigate } from "react-router";

import { selectVariant, type VariantDetail } from "~/server/services/catalog/product-types";

type Selectable = { variants: VariantDetail[]; defaultVariantId: string };

/** The search string for a variant: the default needs none, any other is `?v=<sku>` (other parameters are kept). */
export function searchFor(search: string, product: Selectable, variant: VariantDetail): string {
  const params = new URLSearchParams(search);
  if (variant.id === product.defaultVariantId) params.delete("v");
  else params.set("v", variant.sku);
  const next = params.toString();
  return next ? `?${next}` : "";
}

/** True when two query strings differ in `v` and in nothing else. */
export function onlyVariantChanged(current: URLSearchParams, next: URLSearchParams): boolean {
  const rest = (params: URLSearchParams) => {
    const copy = new URLSearchParams(params);
    copy.delete("v");
    copy.sort();
    return copy.toString();
  };
  return (current.get("v") ?? "") !== (next.get("v") ?? "") && rest(current) === rest(next);
}

export function useVariantInUrl(product: Selectable): {
  variant: VariantDetail;
  choose: (variantId: string) => void;
} {
  const location = useLocation();
  const navigate = useNavigate();
  const fromUrl = selectVariant(product, new URLSearchParams(location.search).get("v"));

  // The URL wins whenever it changes (a link, Back/Forward, the language switch); a choice wins until the URL catches up.
  const [chosen, setChosen] = useState(fromUrl.id);
  const [seen, setSeen] = useState(fromUrl.id);
  if (fromUrl.id !== seen) {
    setSeen(fromUrl.id);
    setChosen(fromUrl.id);
  }
  const variant = product.variants.find((entry) => entry.id === chosen) ?? fromUrl;

  const choose = (variantId: string) => {
    const next = product.variants.find((entry) => entry.id === variantId);
    if (!next || next.id === chosen) return;
    setChosen(next.id);
    void navigate(
      {
        pathname: location.pathname,
        search: searchFor(location.search, product, next),
        hash: location.hash,
      },
      { replace: true, preventScrollReset: true },
    );
  };
  return { variant, choose };
}
