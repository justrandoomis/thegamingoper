/**
 * The related shelves of the product page (DESIGN.md §8 "shelf"): editorial relations from the catalogue
 * (product_relations) as "complete your setup", "accessories" and "alternatives". The reason line says what they are —
 * store suggestions — never "customers also bought" (brief §6: no such data exists). Compatibility-checked
 * recommendations ("يكمّل جهازك") come from the devices area through the integration pass (see ./Slots).
 */
import type { RelatedShelf } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { ShelfRail } from "~/ui/ShelfRail";
import { useProductT } from "../i18n";

export function RelatedShelves({ shelves, className }: { shelves: readonly RelatedShelf[]; className?: string }) {
  const t = useProductT();
  if (shelves.length === 0) return null;
  return (
    <div className={cx("grid gap-10", className)}>
      {shelves.map((shelf) => (
        <ShelfRail
          key={shelf.kind}
          shelf={{
            key: `related-${shelf.kind}`,
            title: t(`related.${shelf.kind}`),
            reason: t("related.reason"),
            items: shelf.items,
          }}
        />
      ))}
    </div>
  );
}
