/**
 * «أضف الكل إلى السلة» — the review step's one primary (docs/switch-builder.md §6.8; data-tour="add-all"). Every
 * orderable line of the quote goes into the cart in ONE request (cart-client addManyToCart: all of them, or — when any
 * one cannot — none, with each refused line's reason). The kit's add sequence for a bundle: the drawn moments' core is
 * fetched on press, one bead flies to the cart, the request leaves; on the server's yes the drawn moment plays round the
 * key, the key becomes «عرض السلة» (focus follows it), and the cart toast — whose live region says it — comes once the
 * bead has landed. On a refusal the bead flies back, nothing changes in the cart, and the page shows each line's reason
 * (its alert says it). One voice per event (QA 2026-11-21: the add and the refusal were each said twice).
 *
 * Offline, or when nothing of the plan can be bought now, the key looks flat but stays focusable (`aria-disabled`) and
 * names its reason (`aria-describedby`): the hidden offline line, or the review's «لا شيء من هذه الخطة يدخل السلة…»
 * (NOTHING_ID). Nothing is queued that cannot be sent.
 */
import { useId, useRef, useState } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import { flyToCart } from "~/motion";
import type { QuoteLine } from "~/lib/switch-builder/types";
import { addManyToCart, cartErrorKey, type AddManyProblem } from "~/ui/cart-client";
import { cx } from "~/ui/cx";
import { useFocusHandoff } from "~/ui/focus-handoff";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { sakuga } from "~/ui/sakuga/fx";
import { toast } from "~/ui/toast-store";
import { useBuilderT } from "../lib/format";

/** The cart items of a quote: its orderable lines, one item per variant (quantities of a repeated variant added up). */
export function cartItemsOf(lines: readonly QuoteLine[]): Array<{ variantId: string; qty: number }> {
  const items = new Map<string, number>();
  for (const line of lines) if (line.orderable && line.qty > 0) items.set(line.variantId, (items.get(line.variantId) ?? 0) + line.qty);
  return [...items].map(([variantId, qty]) => ({ variantId, qty }));
}

/** The bead's landing, or a short wait when nothing flies — the toast never covers the flight. */
function landing(): { promise: Promise<void>; arrive: () => void } {
  let arrive = () => {};
  const promise = new Promise<void>((resolve) => {
    arrive = resolve;
    setTimeout(resolve, 900);
  });
  return { promise, arrive };
}

export type AddAllRefusal = { code: string; problems: AddManyProblem[] };

/** The id of the review's sentence that says nothing of the plan goes in the cart (the disabled key's reason). */
export const NOTHING_ID = "sb-review-nothing";

export type AddAllKeyProps = {
  lines: readonly QuoteLine[];
  /** The quote is being worked out (the key waits). */
  pending?: boolean;
  /** The task bar's compact key (below 1024). */
  compact?: boolean;
  /** This copy carries the guide's `data-tour="add-all"` (the copy the shopper can see). */
  tour?: boolean;
  /** The console's catalogue picture for the cart toast. */
  art?: string;
  /**
   * These lines are in the cart: the key is «عرض السلة». The page keeps it for BOTH copies of the key (the task bar's
   * below 1024, the aside's from 1024), so the copy that comes into view after a resize or a turned tablet never
   * offers the same add again.
   */
  added: boolean;
  /** The server took every line. */
  onAdded: () => void;
  /** A refusal (nothing was added): the page shows each line's reason. Null clears it. */
  onRefused: (refusal: AddAllRefusal | null) => void;
  className?: string;
};

export function AddAllKey({ lines, pending = false, compact = false, tour = false, art, added, onAdded, onRefused, className }: AddAllKeyProps) {
  const t = useBuilderT();
  const shop = useT("ui-shop");
  const f = useFormat();
  const locale = useLocale();
  const online = useOnline();
  const reasonId = useId();
  const key = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const handoff = useFocusHandoff(added);
  const items = cartItemsOf(lines);
  const count = items.reduce((sum, item) => sum + item.qty, 0);
  const fit = compact ? "compact" : undefined;
  // the aside's copy says the full words: a second line before an ellipsis (a primary key's words are never cut)
  const wrap = !compact;
  const tourProps = tour ? { "data-tour": "add-all" } : {};

  const add = async () => {
    if (adding || added || items.length === 0) return;
    if (!online || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      toast.error(t("review.offline"));
      return;
    }
    onRefused(null);
    setAdding(true);
    const source = key.current;
    if (source) sakuga.warm(source);
    const land = landing();
    const flight = source ? flyToCart(source, { onArrive: land.arrive }) : (land.arrive(), { revert() {} });
    const outcome = await addManyToCart({ items, locale });
    if (!outcome.ok) {
      flight.revert();
      setAdding(false);
      // said once: by the review's alert when lines are named, else by the error toast (its retry is the way on)
      onRefused({ code: outcome.code, problems: outcome.problems });
      if (outcome.problems.length === 0) toast.error(t("review.refusedGeneric", { reason: shop(cartErrorKey(outcome.code)) }), { action: { label: t("review.retry"), onAction: () => void add() } });
      return;
    }
    if (source?.isConnected) sakuga.added(source);
    // said once, by the cart toast once the bead has landed
    const name = t("review.pieces", { count, n: f.number(count) });
    handoff.arm();
    setAdding(false);
    onAdded();
    void land.promise.then(() => toast.cart({ title: t("review.added"), name, art, action: { label: t("review.viewCart"), href: "/cart" } }));
  };

  if (added) {
    return (
      <div ref={handoff.area} className={cx("sb-addall", className)}>
        <Key as={LocaleLink} to="/cart" icon="shopping-cart-simple" fit={fit} wrap={wrap} className="min-w-0 flex-1" data-focus-target="" {...tourProps}>
          {t("review.viewCart")}
        </Key>
      </div>
    );
  }
  // flat but focusable, with its reason: offline (the hidden line below), or nothing to add (the review's sentence —
  // not while the quote is still being worked out)
  const nothing = !pending && items.length === 0;
  const flat = !online || nothing;
  return (
    <div ref={handoff.area} className={cx("sb-addall", className)}>
      <Key
        ref={key}
        variant="primary"
        icon="bag-plus"
        loading={adding || pending}
        fit={fit}
        wrap={wrap}
        data-haptic="tap"
        aria-disabled={flat || undefined}
        aria-describedby={!online ? reasonId : nothing ? NOTHING_ID : undefined}
        // the task bar's compact key says it short («أضف الكل»: the full words did not fit a 320 phone in Sorani); its
        // name still says where the games go, and holds the words on screen (WCAG 2.5.3)
        aria-label={compact ? t("review.addAllName") : undefined}
        className="min-w-0 flex-1"
        onClick={() => void add()}
        {...tourProps}
      >
        {compact ? t("review.addAllShort") : t("review.addAll")}
      </Key>
      {online ? null : (
        <span id={reasonId} className="sr-only">
          <Icon name="wifi-slash" size={16} />
          {t("review.offline")}
        </span>
      )}
    </div>
  );
}
