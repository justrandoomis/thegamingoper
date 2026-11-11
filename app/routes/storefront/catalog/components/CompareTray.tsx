/**
 * The compare list's way back: once this device holds products to compare, a small key floats above the bottom
 * chrome of the catalog pages ("قارن (2)" → /compare?ids=…) with a key to empty the list. Client only (the list
 * lives in localStorage), fixed — so its arrival after hydration moves nothing.
 */
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { compareHref, useCompare } from "../compare-client";

export function CompareTray() {
  const t = useT("catalog");
  const f = useFormat();
  const compare = useCompare();
  if (compare.ids.length === 0) return null;
  return (
    <div className="catalog-tray" role="region" aria-label={t("compare.title")}>
      <Key as={LocaleLink} to={compareHref(compare.ids)} variant="ink" size="sm" icon="scales">
        {t("compare.tray", { count: compare.ids.length, n: f.number(compare.ids.length) })}
      </Key>
      <IconKey icon="x" size="sm" label={t("compare.clear")} onClick={compare.clear} />
    </div>
  );
}
