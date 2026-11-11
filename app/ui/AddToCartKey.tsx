import { useEffect, useRef, useState, type MouseEvent } from "react";

import { Icon } from "~/art/Icon";
import { useLocale, useT } from "~/i18n/react";
import type { CartView, ImageRef, StockState } from "~/lib/dto";
import { flyToCart, MotionLink, type FlyHandle } from "~/motion";
import { addToCart, announce, cartErrorKey, MAX_ADD_QTY, showShopToast, undoAdd, type AddItem, type AddOutcome } from "./cart-client";
import { cx } from "./cx";
import { Glass } from "./Glass";
import { IconKey } from "./IconKey";
import { Key, type KeySize } from "./Key";
import { useControllable } from "./KeyBank";
import { AddGlyph, Socket, useAddedFlash } from "./Socket";
import { Stepper, type StepperProps } from "./Stepper";
import { TextLink } from "./TextLink";

/**
 * The add-to-cart key (docs/DESIGN.md §6.1 commit key, §7.2 "Fly to cart", §9.5 socket). Optimistic and never
 * blocking: on press the badge count changes, the bead flies (flyToCart) and the request is queued — taps on the
 * same item within 250 ms travel as one POST /api/cart (cart-client). After the server confirms, the key shows a
 * check for 1.2 s, the live region says "أُضيف … إلى السلة" and the cart toast offers "تراجع". If it fails, the
 * count rolls back, the bead flies back, a sentence with "أعد المحاولة" appears right after the key, and an error
 * toast carries the same retry.
 *
 *   <AddToCartKey item={{ variantId: card.variantId }} name={card.name} source={() => imageEl} />     a card's socket
 *   <AddToCartKey variant="key" item={{ variantId }} name={name} qty={qty} block />                   a commit key
 *   <AddToCartKey item={{ usedUnitId: unit.id }} name={unit.name} />                                  one used unit
 *   <AddToCartKey item={…} name={…} chooseHref={`/p/${slug}`} />     needs an option first: opens the product page
 *   <AddToCartKey item={…} name={…} stock="out_of_stock" />          empty socket / a flat "غير متوفر" key
 *   <BuyBar item={{ variantId }} name={name} maxQty={line.maxQty} source={stageImage} />   product page (b.png)
 *
 * It renders a fragment — the key, then (on failure) the sentence — so in a wrapping flex row the sentence takes
 * its own line under the key. `message="none"` + `onMessage` lets a tight host (the stage band) place it itself.
 * A view has one commit key: on a card this socket key is the exception the design allows (one per card).
 *
 * Why the requests do not go through useFetcher: see ~/ui/cart-client (React Router 8 sends a fetcher's network
 * error, or a missing endpoint, to the route's ErrorBoundary — one failed add would replace the page).
 */
export type AddToCartKeyProps = {
  /** What to add: a variant, or one used unit. */
  item: AddItem;
  /** Product name: the key's accessible name and every message. */
  name: string;
  /** "socket" (default): the round red key seated in its well (cards). "key": the labelled commit key. */
  variant?: "socket" | "key";
  /** Units per press (the buy bar's stepper). Default 1. */
  qty?: number;
  /** out_of_stock → an empty socket (the card's status line says "نفد") or a flat "غير متوفر" key. */
  stock?: StockState;
  /** The product needs a choice first: the key is a link to this locale-less path and adds nothing. */
  chooseHref?: string | null;
  /** The element the bead leaves from (the product picture). Default: the key. */
  source?: Element | null | (() => Element | null | undefined);
  /** Thumbnail and variant line for the toast that follows an add. */
  image?: ImageRef | null;
  optionsLabel?: string | null;
  /** key variant only. */
  size?: KeySize;
  block?: boolean;
  /** Not addable for another reason (no option chosen yet): say why next to it and point aria-describedby at it. */
  disabled?: boolean;
  "aria-describedby"?: string;
  /** "after" (default): the failure sentence follows the key. "none": nothing is rendered; use `onMessage`. */
  message?: "after" | "none";
  onMessage?: (message: string | null) => void;
  /** Called once per server-confirmed add (once per coalesced request). */
  onAdded?: (cart: CartView, added: number) => void;
  className?: string;
};

type Notice = { tone: "error" | "warn"; text: string; retryQty: number | null };

export function AddToCartKey(props: AddToCartKeyProps) {
  const { item, name, variant = "socket", qty = 1, stock, chooseHref, source, image, optionsLabel, size, block, disabled = false, message = "after", onMessage, onAdded, className } = props;
  const t = useT("ui-shop");
  const ui = useT("ui");
  const locale = useLocale();
  const [added, flash] = useAddedFlash(1200);
  const [notice, setNotice] = useState<Notice | null>(null);
  const mounted = useRef(true);
  const handled = useRef(new WeakSet<AddOutcome>());
  const live = useRef({ name, optionsLabel, image, onAdded, onMessage, item, locale });
  live.current = { name, optionsLabel, image, onAdded, onMessage, item, locale };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const show = (next: Notice | null) => {
    if (mounted.current) setNotice(next);
    live.current.onMessage?.(next?.text ?? null);
  };

  /** Once per request outcome (the taps of one batch share it); the flight is undone per tap. */
  const settle = (outcome: AddOutcome, flight: FlyHandle) => {
    if (!outcome.ok) flight.revert();
    if (handled.current.has(outcome)) return;
    handled.current.add(outcome);
    const { name: label, image: picture, optionsLabel: line, onAdded: confirmed, item: what, locale: lang } = live.current;
    if (outcome.ok) {
      if (mounted.current) flash();
      const partial = outcome.added < outcome.requested;
      const sentence = partial ? t("add.announcePartial", { added: outcome.added, name: label }) : t("add.announceAdded", { name: label });
      announce(sentence);
      show(partial ? { tone: "warn", text: sentence, retryQty: null } : null);
      confirmed?.(outcome.cart, outcome.added);
      showShopToast({
        kind: "added",
        title: partial ? sentence : t("add.added"),
        name: label,
        variant: line,
        image: picture,
        undo: {
          label: t("add.undo"),
          onUndo: () => {
            void undoAdd(outcome, what, lang).then((answer) => {
              if (answer.ok) {
                announce(t("add.undone", { name: label }));
                return;
              }
              announce(t("add.undoFailed"));
              showShopToast({ kind: "error", title: t("add.undoFailed"), detail: label });
            });
          },
        },
      });
      return;
    }
    const reason = t(cartErrorKey(outcome.code));
    announce(t("add.announceFailed", { name: label, reason }));
    show({ tone: "error", text: reason, retryQty: outcome.requested });
    showShopToast({ kind: "error", title: reason, detail: label, retry: { label: t("add.retry"), onRetry: () => run(outcome.requested, null) } });
  };

  const run = (units: number, from: Element | null) => {
    show(null);
    const origin = from ?? resolveSource(source);
    const flight = origin ? flyToCart(origin) : { revert() {} };
    void addToCart({ ...live.current.item, qty: units, locale: live.current.locale }).then((outcome) => settle(outcome, flight));
  };

  const press = (event: MouseEvent<HTMLElement>) => {
    const units = Math.max(1, Math.trunc(qty));
    run(units, resolveSource(source) ?? event.currentTarget);
  };

  const retry = () => {
    if (notice?.retryQty) run(notice.retryQty, null);
  };

  const soldOut = stock === "out_of_stock";
  let control;
  if (variant === "socket") {
    if (soldOut) control = <Socket state="empty" className={className} />;
    else if (chooseHref) {
      control = (
        <Socket className={className}>
          <IconKey as={MotionLink} nav="zoom" to={chooseHref} variant="commit" icon={<AddGlyph />} label={t("add.chooseNamed", { name })} />
        </Socket>
      );
    } else {
      control = (
        <Socket className={className}>
          <IconKey
            variant="commit"
            icon={added ? <Icon name="check" size={20} /> : <AddGlyph />}
            label={ui(added ? "socket.added" : "socket.add", { name })}
            disabled={disabled}
            aria-describedby={props["aria-describedby"]}
            data-state={added ? "added" : "ready"}
            onClick={press}
          />
        </Socket>
      );
    }
  } else if (soldOut) {
    control = (
      <Key variant="commit" size={size} block={block} disabled icon={<AddGlyph />} aria-describedby={props["aria-describedby"]} className={className}>
        {t("add.soldOut")}
      </Key>
    );
  } else if (chooseHref) {
    control = (
      <Key as={MotionLink} nav="zoom" to={chooseHref} variant="commit" size={size} block={block} icon={<AddGlyph />} className={className}>
        {t("add.choose")}
      </Key>
    );
  } else {
    control = (
      <Key
        variant="commit"
        size={size}
        block={block}
        disabled={disabled}
        aria-describedby={props["aria-describedby"]}
        icon={added ? <Icon name="check" size={20} /> : <AddGlyph />}
        data-state={added ? "added" : "ready"}
        onClick={press}
        className={className}
      >
        {t(added ? "add.added" : "add.label")}
      </Key>
    );
  }

  return (
    <>
      {control}
      {message === "after" && notice ? (
        <p className={cx("relative flex w-full basis-full flex-wrap items-center gap-x-2 type-caption font-medium", notice.tone === "error" ? "text-red-ink" : "text-warn")}>
          <Icon name={notice.tone === "error" ? "warning-circle" : "info"} size={16} />
          <span className="min-w-0">{notice.text}</span>
          {notice.retryQty ? (
            <TextLink as="button" type="button" arrow={false} onClick={retry}>
              {t("add.retry")}
            </TextLink>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

function resolveSource(source: AddToCartKeyProps["source"]): Element | null {
  if (typeof source === "function") return source() ?? null;
  return source ?? null;
}

/* ───────────────────────────── the buy controls and the buy bar (b.png, DESIGN.md §8.4, §8.10) ───────────────────────────── */

export type BuyControlsProps = Omit<AddToCartKeyProps, "variant" | "qty" | "block" | "size"> & {
  /** Quantity (controlled) — or leave it to the controls, starting at 1. */
  qty?: number;
  defaultQty?: number;
  onQtyChange?: (qty: number) => void;
  /** The stepper's upper bound: what one cart line may hold right now (stock- and policy-limited). Default 10. */
  maxQty?: number;
  /** Why the bound exists — "stock" says "بقي {max} فقط" at the limit. Pass it only when the bound IS the stock. */
  maxReason?: StepperProps["maxReason"];
};

/**
 * The stepper and the commit key side by side: minus/plus at the start, the full-width red key at the end. A used
 * unit is one unit (no stepper); a product that needs a choice or is sold out shows the key's own state alone.
 * Desktop product pages put these in the info column as a flat panel (DESIGN.md §8.10 — no bottom bar there).
 */
export function BuyControls({ qty, defaultQty = 1, onQtyChange, maxQty = MAX_ADD_QTY, maxReason, className, ...key }: BuyControlsProps & { className?: string }) {
  const [current, setCurrent] = useControllable<number>(qty, defaultQty, onQtyChange);
  const single = Boolean(key.item.usedUnitId) || key.stock === "out_of_stock" || Boolean(key.chooseHref);
  const bound = Math.max(1, Math.min(MAX_ADD_QTY, Math.trunc(maxQty)));
  const units = Math.min(bound, Math.max(1, current));
  return (
    <div className={cx("flex items-start gap-3", className)}>
      {single ? null : <Stepper value={units} onChange={setCurrent} min={1} max={bound} maxReason={maxReason} className="shrink-0" />}
      <div className="flex min-w-0 flex-1 flex-wrap gap-y-1.5">
        {/* 52px like the mock's bar; 14px side padding so "أضف إلى السلة" fits beside the stepper on a 360px phone. */}
        <AddToCartKey {...key} variant="key" qty={units} block className="w-full [--h:52px] [--px:14px]" />
      </div>
    </div>
  );
}

/**
 * The glass buy bar pinned to the bottom edge of the product page on phones and tablets (DESIGN.md §8.4; the tab
 * bar gives way to it — one task bar per edge). Live glass, top corners r-xl, padded for the safe area.
 * `fixed={false}` makes it sticky inside a scrolling box (the /design-system specimen).
 */
export function BuyBar({ fixed = true, className, ...controls }: BuyControlsProps & { fixed?: boolean; className?: string }) {
  return (
    <Glass
      edge="bottom"
      className={cx(
        fixed ? "fixed inset-x-0 bottom-0" : "sticky bottom-0",
        "z-(--z-nav) rounded-t-xl px-(--gutter) pt-3.5 pb-[max(14px,var(--safe-bottom))]",
        className,
      )}
    >
      <BuyControls {...controls} className="mx-auto max-w-[40rem]" />
    </Glass>
  );
}
