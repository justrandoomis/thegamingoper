/**
 * «قارن» — the catalog area's compare toggle (Design System v2 §6.5) for the product page, and for console and
 * handheld cards once the kit's card has a slot for it. A 44px text button: held («في المقارنة», aria-pressed) while
 * the product is in the compare list; a text link «قارن الآن (2)» follows once the list holds two or more.
 *
 *   import { CompareToggle } from "~/routes/storefront/catalog/CompareToggle";
 *   <CompareToggle product={{ id: product.id, kind: product.kind, name: product.name, image: product.images[0] }} />
 *
 * STRINGS: it reads the "catalog" namespace, so the page that renders it adds "catalog" to its loader's
 * messagesFor(ctx.locale, …). Adding a product of another kind starts a new list and says so; a full list (four)
 * refuses and says so — both as an info toast with the way to /compare. `image` (optional) gives the compare tray its
 * thumbnail. Nothing here talks to the server.
 */
import type { ImageRef, ProductKind } from "~/lib/dto";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { compareAfterAdd, compareHref, useCompare } from "./compare-client";

export type CompareToggleProps = {
  product: { id: string; kind: ProductKind; name: string; image?: Pick<ImageRef, "artKey" | "mediaKey"> | null };
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
    const outcome = compare.add({ id: product.id, kind: product.kind, name: product.name, image: product.image ?? null });
    // `compare.ids` is the list before this add
    const href = compareAfterAdd(outcome, compare.ids, product.id);
    if (outcome === "replaced") toast.info(t("compare.newList"), { action: { label: t("compare.open"), href } });
    else if (outcome === "full") toast.info(t("compare.full"), { action: { label: t("compare.open"), href } });
  };

  return (
    <span className={cx("inline-flex flex-wrap items-center gap-x-3 gap-y-1", className)}>
      <Key variant="ghost" size={size} icon={inList ? "check" : "scales"} held={inList} onClick={toggle} aria-label={inList ? t("compare.removeNamed", { name: product.name }) : t("compare.addNamed", { name: product.name })}>
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
