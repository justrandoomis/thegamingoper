/**
 * The product page's secondary actions — design v2 spec §6.7 item 10, §4.15: المفضلة · قارن · مشاركة, one row under the
 * versions (phones) and under the buy controls (from 1024). Drawn once for every width, so there is one wishlist
 * state on the page.
 *
 *   · المفضلة   the kit's WishlistKey, text variant (a 44px ghost key: the heart and «المفضلة» / «في المفضلة»; held =
 *              the filled heart, aria-pressed). Its start state comes from the account area's wishedAmong (loader).
 *   · قارن      the catalog area's CompareToggle (this device's compare list; the link to /compare follows from two) —
 *              with the product's first picture, which the compare tray shows.
 *   · مشاركة    the system share sheet where the browser has one (phones), else the product link is copied and a toast
 *              says so; if neither works, the toast says to copy it from the address bar. Nothing is sent anywhere.
 */
import type { ImageRef, ProductKind } from "~/lib/dto";
import { CompareToggle } from "~/routes/storefront/catalog/CompareToggle";
import { cx } from "~/ui/cx";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { WishlistKey } from "~/ui/WishlistKey";
import { useProductT } from "../i18n";

export type SecondaryActionsProps = {
  /** `image`: the picture the compare tray shows for it (the gallery's first). */
  product: { id: string; kind: ProductKind; name: string; image?: Pick<ImageRef, "artKey" | "mediaKey"> | null };
  /** In the shopper's wishlist when the page loaded. */
  wished: boolean;
  className?: string;
};

export function SecondaryActions({ product, wished, className }: SecondaryActionsProps) {
  return (
    <div className={cx("flex flex-wrap items-center gap-x-5 gap-y-2", className)} data-pdp-actions="">
      <WishlistKey key={product.id} variant="text" productId={product.id} name={product.name} initial={wished} />
      <CompareToggle product={{ id: product.id, kind: product.kind, name: product.name, image: product.image ?? null }} />
      <ShareKey name={product.name} />
    </div>
  );
}

/** «مشاركة»: a 44px text button (spec §4.15). */
export function ShareKey({ name, className }: { name: string; className?: string }) {
  const t = useProductT();
  const share = async () => {
    const url = window.location.href;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ title: name, url });
        return;
      } catch (error) {
        // the shopper closed the sheet: nothing to say
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t("share.copied"));
    } catch {
      toast.error(t("share.failed"));
    }
  };
  return (
    <TextLink as="button" type="button" icon="share-network" arrow={false} onClick={() => void share()} className={className}>
      {t("share.label")}
    </TextLink>
  );
}
