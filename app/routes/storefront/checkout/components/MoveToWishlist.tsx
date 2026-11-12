import { useState } from "react";

import { useT } from "~/i18n/react";
import { isolate } from "~/ui/BidiText";
import { useOnline } from "~/ui/OfflineBanner";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";

/**
 * «نقل إلى المفضلة» under a cart line's name (Design System v2 §4.13), beside the kit's «إزالة»: the product goes to the
 * favourites (POST /api/wishlist intent=add — the account area's endpoint; guests keep theirs on this device), then the
 * line leaves the cart through the cart editor, so its undo row «أزلنا … من السلة.» + «تراجع» shows as for any removal
 * (the favourite stays). A refusal says so in a toast and the line stays. Variant lines only: a used unit is one
 * device, not a product to wish for.
 */
export function MoveToWishlist({ productId, name, onMoved }: { productId: string; name: string; onMoved: () => void }) {
  const t = useT("checkout");
  const online = useOnline();
  const [busy, setBusy] = useState(false);
  const move = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.set("intent", "add");
      body.set("productId", productId);
      const response = await fetch("/api/wishlist", { method: "POST", body, headers: { Accept: "application/json" }, credentials: "same-origin" });
      const json = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (!response.ok || !json?.ok) throw new Error(`wishlist ${response.status}`);
      onMoved();
      toast.success(t("wishlist.moved", { name: isolate(name) }));
    } catch {
      toast.error(t("wishlist.failed"));
    } finally {
      setBusy(false);
    }
  };
  return (
    <TextLink as="button" type="button" icon="heart" arrow={false} onClick={() => void move()} disabled={busy || !online} aria-label={t("wishlist.moveNamed", { name })}>
      {t("wishlist.move")}
    </TextLink>
  );
}
