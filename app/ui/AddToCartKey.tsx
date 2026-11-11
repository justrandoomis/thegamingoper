import { useEffect, useRef, useState, type MouseEvent } from "react";

import { Icon } from "~/art/Icon";
import { useLocale, useT } from "~/i18n/react";
import type { CartView, ImageRef, StockState } from "~/lib/dto";
import { flyToCart, MotionLink, type FlyHandle } from "~/motion";
import { addToCart, announce, cartErrorKey, showShopToast, undoAdd, type AddItem, type AddOutcome } from "./cart-client";
import { cx } from "./cx";
import { IconKey } from "./IconKey";
import { Key, type KeySize } from "./Key";
import { AddGlyph, Socket, useAddedFlash } from "./Socket";
import { TextLink } from "./TextLink";

/**
 * The add-to-cart key (docs/DESIGN.md §6.1 commit key, §7.2 "Fly to cart", §9.5 socket). Optimistic and never
 * blocking: on press the badge count changes, the bead flies (flyToCart) and the request is queued — taps on the
 * same item within 250 ms travel as one POST /api/cart (cart-client). After the server confirms, the key shows a
 * check for 1.2 s and the live region says "أُضيف … إلى السلة". If it fails, the count rolls back, the bead flies
 * back, a sentence with "أعد المحاولة" appears right after the key, and a toast is offered to the toast store.
 *
 *   <AddToCartKey item={{ variantId: card.variantId }} name={card.name} source={() => imageEl} />     a card's socket
 *   <AddToCartKey variant="key" item={{ variantId }} name={name} qty={qty} block />                   the buy bar
 *   <AddToCartKey item={{ usedUnitId: unit.id }} name={unit.name} />                                  one used unit
 *   <AddToCartKey item={…} name={…} chooseHref={`/p/${slug}`} />     needs an option first: opens the product page
 *   <AddToCartKey item={…} name={…} stock="out_of_stock" />          empty socket / a flat "غير متوفر" key
 *
 * It renders a fragment — the key, then (on failure) the sentence — so in a wrapping flex row the sentence takes
 * its own line under the key. `message="none"` + `onMessage` lets a tight host (the stage band) place it itself.
 * A view has one commit key: on a card this socket key is the exception the design allows (one per card).
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
  /** out_of_stock → an empty socket (the fact line says "نفد") or a flat "غير متوفر" key. */
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
    const { name: label, image: picture, optionsLabel: line, onAdded: added$, item: what, locale: lang } = live.current;
    if (outcome.ok) {
      if (mounted.current) flash();
      const partial = outcome.added < outcome.requested;
      const sentence = partial ? t("add.announcePartial", { added: outcome.added, name: label }) : t("add.announceAdded", { name: label });
      announce(sentence);
      show(partial ? { tone: "warn", text: sentence, retryQty: null } : null);
      added$?.(outcome.cart, outcome.added);
      showShopToast({
        tone: "success",
        title: t("add.added"),
        detail: [label, line].filter(Boolean).join(" · "),
        image: picture ?? null,
        action: {
          label: t("add.undo"),
          onAction: () => {
            void undoAdd(outcome, what, lang).then((answer) => announce(answer.ok ? t("add.undone", { name: label }) : t("add.undoFailed")));
          },
        },
      });
      return;
    }
    const reason = t(cartErrorKey(outcome.code));
    announce(t("add.announceFailed", { name: label, reason }));
    show({ tone: "error", text: reason, retryQty: outcome.requested });
    showShopToast({ tone: "error", title: reason, detail: label, image: picture ?? null, action: { label: t("add.retry"), onAction: () => run(outcome.requested, null) } });
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
        {t("add.label")}
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
