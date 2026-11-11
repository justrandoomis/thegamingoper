import { useEffect, useRef, useState } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { announce, cartErrorKey, postForm, readFailure, showShopToast } from "./cart-client";
import { cx } from "./cx";
import { IconKey } from "./IconKey";
import { TextLink } from "./TextLink";

/**
 * The favourite key (docs/DESIGN.md §6.1: "a filled icon on the favourite"; §8.4: a round key at the end of the
 * title). Optimistic: the heart fills and the key stays down at once, then POST /api/wishlist (intent=toggle,
 * productId) — owned by the account area (docs/CONTRACTS.md §3). If the server says no, or the endpoint is not live,
 * the heart goes back and a sentence says so beside the key. Never on a product card (one walled key per card).
 *
 *   <WishlistKey productId={product.id} name={product.name} initial={isWished} />
 *
 * Expected answer: `{ ok: true, wished: boolean }` (when `wished` is missing the optimistic state is kept) or an
 * ActionFail `{ ok: false, code }`. Presses while a request is out are folded: the key always ends on the shopper's
 * last choice, with one toggle sent per real change.
 */
export type WishlistKeyProps = {
  productId: string;
  name: string;
  /** In the wishlist when the page loaded (from getWishlistIds). */
  initial?: boolean;
  /** Called with the confirmed state. */
  onChange?: (wished: boolean) => void;
  size?: "md" | "sm";
  /** "after" (default): a failure sentence follows the key. "none": render it yourself from `onMessage`. */
  message?: "after" | "none";
  onMessage?: (message: string | null) => void;
  className?: string;
};

export function WishlistKey({ productId, name, initial = false, onChange, size = "md", message = "after", onMessage, className }: WishlistKeyProps) {
  const t = useT("ui-shop");
  const [wished, setWished] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const confirmed = useRef(initial);
  const desired = useRef(initial);
  const busy = useRef(false);
  const mounted = useRef(true);
  const latest = useRef({ productId, name, onChange, onMessage });
  latest.current = { productId, name, onChange, onMessage };

  // A new page load (or a parent that knows better) wins while nothing is in flight.
  useEffect(() => {
    if (busy.current) return;
    confirmed.current = initial;
    desired.current = initial;
    setWished(initial);
  }, [initial]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const report = (text: string | null) => {
    if (mounted.current) setError(text);
    latest.current.onMessage?.(text);
  };

  const sync = async () => {
    if (busy.current) return;
    busy.current = true;
    while (desired.current !== confirmed.current) {
      const target = desired.current;
      const outcome = await postForm("/api/wishlist", { intent: "toggle", productId: latest.current.productId });
      const json = outcome.kind === "answer" && outcome.json && typeof outcome.json === "object" ? (outcome.json as Record<string, unknown>) : null;
      if (outcome.kind === "answer" && json?.ok === true) {
        confirmed.current = typeof json.wished === "boolean" ? json.wished : target;
        latest.current.onChange?.(confirmed.current);
        continue;
      }
      // Failure: the server state is what we last confirmed; the shopper's choice is undone and explained — beside
      // the key, in the live region and in an error toast with a retry. (Until the account area ships the endpoint,
      // every toggle ends here, honestly: "this service is not available right now".)
      const code = outcome.kind === "network" ? "network" : outcome.kind === "timeout" ? "timeout" : readFailure(outcome.status, json).code;
      const reason = t(cartErrorKey(code));
      desired.current = confirmed.current;
      if (mounted.current) setWished(confirmed.current);
      announce(t("wishlist.failed", { reason }));
      report(t("wishlist.failed", { reason }));
      showShopToast({ kind: "error", title: t("wishlist.notSaved"), detail: reason, retry: { label: t("add.retry"), onRetry: () => toggle() } });
      break;
    }
    if (mounted.current) setWished(desired.current);
    busy.current = false;
  };

  const toggle = () => {
    const next = !desired.current;
    desired.current = next;
    setWished(next);
    report(null);
    announce(t(next ? "wishlist.added" : "wishlist.removed", { name: latest.current.name }));
    void sync();
  };

  return (
    <>
      <IconKey
        icon="heart"
        held={wished}
        size={size}
        label={t(wished ? "wishlist.remove" : "wishlist.add", { name })}
        onClick={toggle}
        className={className}
      />
      {message === "after" && error ? (
        <p className={cx("relative flex w-full basis-full items-start gap-1.5 type-caption font-medium text-red-ink")}>
          <Icon name="warning-circle" size={16} className="mt-0.5" />
          <span className="min-w-0">{error}</span>
          <TextLink as="button" type="button" arrow={false} onClick={toggle}>
            {t("add.retry")}
          </TextLink>
        </p>
      ) : null}
    </>
  );
}
