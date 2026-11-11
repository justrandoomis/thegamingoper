/**
 * "Add to compare" — the catalog area's control for the product page and product cards (wired by the integration
 * pass; see docs/areas/catalog.md). A toggle key: held while the product is in the compare list; a small text link
 * to /compare follows once the list has two or more products.
 *
 *   import { CompareToggle } from "~/routes/storefront/catalog/CompareToggle";
 *   <CompareToggle product={{ id: product.id, kind: product.kind, name: product.name }} />
 *
 * STRINGS: it reads the "catalog" namespace, so the page that renders it adds "catalog" to its loader's
 * messagesFor(ctx.locale, …). Adding a product of another kind starts a new list and says so; a full list (four)
 * refuses and says so — both as an info toast with the way to /compare. Nothing here talks to the server.
 */
import type { ProductKind } from "~/lib/dto";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { compareHref, useCompare } from "./compare-client";

export type CompareToggleProps = {
  product: { id: string; kind: ProductKind; name: string };
  size?: "sm" | "md";
  /** Show the "compare N" link next to the key once the list holds two or more products (default true). */
  showLink?: boolean;
  className?: string;
};

export function CompareToggle({ product, size = "sm", showLink = true, className }: CompareToggleProps) {
  const t = useT("catalog");
  const f = useFormat();
  const compare = useCompare();
  const inList = compare.has(product.id);

  const toggle = () => {
    if (inList) {
      compare.remove(product.id);
      return;
    }
    const outcome = compare.add({ id: product.id, kind: product.kind });
    const href = compareHref(outcome === "full" ? compare.ids : [...compare.ids, product.id]);
    if (outcome === "replaced") toast.info(t("compare.newList"), { action: { label: t("compare.open"), href } });
    else if (outcome === "full") toast.info(t("compare.full"), { action: { label: t("compare.open"), href } });
  };

  return (
    <span className={cx("inline-flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <Key size={size} icon="scales" held={inList} onClick={toggle} aria-label={inList ? t("compare.removeNamed", { name: product.name }) : t("compare.addNamed", { name: product.name })}>
        {inList ? t("compare.inList") : t("compare.add")}
      </Key>
      {showLink && inList && compare.ids.length >= 2 ? (
        <TextLink as={LocaleLink} to={compareHref(compare.ids)} className="type-label">
          {t("compare.openCount", { n: f.number(compare.ids.length) })}
        </TextLink>
      ) : null}
    </span>
  );
}
