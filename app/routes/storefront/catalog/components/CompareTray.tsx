/**
 * The catalog pages' floating dock (Design System v2 §6.3, §6.5), fixed above the bottom chrome:
 *
 *   the compare tray   once this device holds two or more products to compare: their thumbnails, «قارن (2)», «قارن الآن»
 *                      (→ /compare?ids=…) and a key that empties the list. Phones: above the tab bar; desktop: the
 *                      bottom end.
 *   the filter pill    below 1024, once the list's toolbar has scrolled away: «الفلاتر | الترتيب» (ListingView
 *                      passes it in).
 *
 * The dock is solid paper with the float shadow, not glass: the header and the tab bar are the two live panes a
 * viewport may have. While it shows, the page's bottom scroll padding grows by its measured height (`--catalog-dock`
 * on the root, catalog.css) — the tray takes a second line where its words do not fit one (English and Sorani on a
 * phone) — so a focused card never hides under it. Client only (the compare list lives in localStorage), fixed — its
 * arrival moves nothing.
 */
import { useEffect, useRef, type ReactNode, type RefObject } from "react";

import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { ProductImage } from "~/ui/ProductCard";
import { compareHref, useCompare, useCompareThumbs } from "../compare-client";

/** A comparison needs two products: the tray shows from two. */
const TRAY_FROM = 2;

function TrayBar() {
  const t = useT("catalog");
  const f = useFormat();
  const compare = useCompare();
  const thumbs = useCompareThumbs();
  const n = compare.ids.length;
  return (
    <div className="catalog-tray" role="region" aria-label={t("compare.title")}>
      <ul role="list" className="catalog-tray__thumbs" aria-hidden="true">
        {compare.ids.map((id) => {
          const thumb = thumbs[id];
          return (
            <li key={id}>
              <Niche as="span" size="sm" className="catalog-tray__well">
                {thumb ? <ProductImage image={{ artKey: thumb.artKey, mediaKey: thumb.mediaKey, alt: "", isIllustration: false }} alt="" sizes="32px" /> : null}
              </Niche>
            </li>
          );
        })}
      </ul>
      <span className="catalog-tray__count nums">{t("compare.tray", { n: f.number(n) })}</span>
      {/* the key and the × stay together: on a second line when the words need it */}
      <span className="catalog-tray__actions">
        <Key as={LocaleLink} to={compareHref(compare.ids)} size="sm" icon="scales">
          {t("compare.openNow")}
        </Key>
        <IconKey icon="x" variant="plain" label={t("compare.clear")} onClick={compare.clear} />
      </span>
    </div>
  );
}

/** Publishes the dock's height as `--catalog-dock` on the root while it is on screen (the bottom scroll padding). */
function useDockHeight(dock: RefObject<HTMLDivElement | null>, shown: boolean) {
  useEffect(() => {
    const element = dock.current;
    const root = document.documentElement;
    if (!shown || !element) return;
    const publish = () => root.style.setProperty("--catalog-dock", `${Math.ceil(element.getBoundingClientRect().height)}px`);
    publish();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(publish);
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      root.style.removeProperty("--catalog-dock");
    };
  }, [dock, shown]);
}

export function CatalogDock({ pill }: { pill?: ReactNode }) {
  const compare = useCompare();
  const dock = useRef<HTMLDivElement>(null);
  const tray = compare.ids.length >= TRAY_FROM;
  const shown = tray || Boolean(pill);
  useDockHeight(dock, shown);
  if (!shown) return null;
  return (
    <div ref={dock} className="catalog-dock" data-tray={tray ? "" : undefined} data-pill={pill ? "" : undefined}>
      {tray ? <TrayBar /> : null}
      {pill}
    </div>
  );
}

/** The dock with the compare tray only: pages without a product list (the search start). */
export function CompareTray() {
  return <CatalogDock />;
}
