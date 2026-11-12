import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import type { CartView, ImageRef, StockState } from "~/lib/dto";
import { flyToCart, MotionLink, type FlyHandle } from "~/motion";
import { addToCart, announce, cartErrorKey, itemKey, MAX_ADD_QTY, showShopToast, undoAdd, useCartCount, type AddItem, type AddOutcome } from "./cart-client";
import { cx } from "./cx";
import { Glass } from "./Glass";
import { IconKey } from "./IconKey";
import { Key, type KeySize } from "./Key";
import { useOnline } from "./OfflineBanner";
import { useControllable } from "./roving";
import { SafePrice } from "./PriceTag";
import { Stepper, type StepperProps } from "./Stepper";
import { TextLink } from "./TextLink";

/**
 * Adding to the cart — Design System v2 §4.11 (the card add button), §4.15 (buy controls, buy bar), §2.11 (fly to cart).
 * Optimistic and never blocking: on press the bead's count changes, the bead flies from the picture (flyToCart) and the
 * request is queued — taps on the same item within 250 ms travel as one POST /api/cart (cart-client). Once the server
 * has confirmed AND the bead has landed, the cart toast follows («أُضيف إلى السلة» · «عرض السلة» · «تراجع»). If it
 * fails, the count rolls back, the bead flies back, a sentence with «أعد المحاولة» follows the key and an error toast
 * carries the same retry.
 *
 *   <CardAddButton item={{ variantId }} name={name} source={() => wellEl} image={card.image} />   the neutral card button
 *   <AddToCartKey variant="key" item={{ variantId }} name={name} qty={qty} block />            the primary «أضف إلى السلة»
 *   <AddToCartKey variant="key" look="onBand" chooseHref={…} label={t("buy", { name })} … />   the white key on a band
 *   <BuyControls item={{ variantId }} name={name} aside={<WishlistKey … />} links={…} />        ≥1024, the PDP column
 *   <BuyBar item={{ variantId }} name={name} priceIqd={price} optionsLabel={variantName} />    phones and tablets
 *   <TaskBar aria-label={…}><BuyBar bare … /></TaskBar>                                        inside the shell's task bar
 *
 * Offline (`navigator.onLine` false): the labelled key goes flat with its reason «لا يوجد اتصال. أضف إلى السلة عند
 * عودة الاتصال.» beside it (pointed at by aria-describedby); the card button keeps its place and a tap says the same in
 * an error toast instead of flying — nothing is queued that cannot be sent.
 *
 * The card add button (G14): a NEUTRAL 40px circle (paper, a --line-2 hairline, the ink bag-plus) that fills red under
 * the pointer; after an add it shows a check in --ok for the rest of the session, named «{name} في السلة. أضف قطعة
 * أخرى» — a second tap adds one more. A product with required options opens the quick look instead («اختر نسخة
 * {name}»). There is no red socket and no empty socket (sold-out and coming-soon cards say so in words).
 *
 * Why the requests do not go through useFetcher: see ~/ui/cart-client (React Router 8 sends a fetcher's network
 * error, or a missing endpoint, to the route's ErrorBoundary — one failed add would replace the page).
 */
export type AddToCartKeyProps = {
  /** What to add: a variant, or one used unit. */
  item: AddItem;
  /** Product name: the accessible name and every message. */
  name: string;
  /** "socket" (default, the 1.0 name): the card add button. "key": the labelled primary key. */
  variant?: "socket" | "key";
  /** key variant: "primary" (default) · "onBand" — the white clay key on the crimson hero or wallet band. */
  look?: "primary" | "onBand";
  /** key variant: the key's words instead of «أضف إلى السلة» / «اختر نسخة» (the hero's «اشترِ {name}»). */
  label?: ReactNode;
  /** Units per press. Default 1. */
  qty?: number;
  /** out_of_stock → nothing on a card (the card says «نفد حالياً»), a flat «نفد حالياً» key with its reason. */
  stock?: StockState;
  /** The product needs a choice first: the button opens this locale-less path and adds nothing. */
  chooseHref?: string | null;
  /** The element the bead leaves from (the product picture). Default: the button. */
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
  /** The failure (or partial-add) sentence, and its tone; null when it is cleared. */
  onMessage?: (message: string | null, tone?: "error" | "warn") => void;
  /** Called once per server-confirmed add (once per coalesced request). */
  onAdded?: (cart: CartView, added: number) => void;
  /** Previews (/design-system): draw the offline state whatever the connection. */
  offline?: boolean;
  className?: string;
};

type Notice = { tone: "error" | "warn"; text: string; retryQty: number | null };

/* Items added in this session (the card shows its check "for the rest of the session", v2 §4.11). */
const SESSION_KEY = "tt:added";
const addedItems = new Set<string>();
let restored = false;
function restoreAdded() {
  if (restored || typeof window === "undefined") return;
  restored = true;
  try {
    for (const key of JSON.parse(window.sessionStorage.getItem(SESSION_KEY) ?? "[]") as unknown[]) if (typeof key === "string") addedItems.add(key);
  } catch {
    /* storage may be blocked: the check then lasts for this page */
  }
}
function rememberAdded(key: string) {
  addedItems.add(key);
  try {
    window.sessionStorage.setItem(SESSION_KEY, JSON.stringify([...addedItems].slice(-200)));
  } catch {
    /* storage may be blocked */
  }
}

/** Whether this item was added in this session — false on the server and in the first render (hydration-safe). */
function useAddedInSession(key: string): [boolean, () => void] {
  const [added, setAdded] = useState(false);
  useEffect(() => {
    restoreAdded();
    setAdded(addedItems.has(key));
  }, [key]);
  return [added, () => setAdded(true)];
}

/** The landing of the bead, or a short wait when nothing flies — the toast never covers the flight. */
function landing(): { promise: Promise<void>; arrive: () => void } {
  let arrive = () => {};
  const promise = new Promise<void>((resolve) => {
    arrive = resolve;
    setTimeout(resolve, 900);
  });
  return { promise, arrive };
}

export function AddToCartKey(props: AddToCartKeyProps) {
  const { item, name, variant = "socket", look = "primary", label, qty = 1, stock, chooseHref, source, image, optionsLabel, size, block, disabled = false, message = "after", onMessage, onAdded, className } = props;
  const t = useT("ui-shop");
  const ui = useT("ui");
  const locale = useLocale();
  const online = useOnline() && !props.offline;
  const reasonId = useId();
  const key = itemKey(item);
  const [added, markAdded] = useAddedInSession(key);
  const [notice, setNotice] = useState<Notice | null>(null);
  const mounted = useRef(true);
  const handled = useRef(new WeakSet<AddOutcome>());
  const live = useRef({ name, optionsLabel, image, onAdded, onMessage, item, locale, key });
  live.current = { name, optionsLabel, image, onAdded, onMessage, item, locale, key };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const show = (next: Notice | null) => {
    if (mounted.current) setNotice(next);
    live.current.onMessage?.(next?.text ?? null, next?.tone);
  };

  /** Once per request outcome (the taps of one batch share it); the flight is undone per tap. */
  const settle = (outcome: AddOutcome, flight: FlyHandle, landed: Promise<void>) => {
    if (!outcome.ok) flight.revert();
    if (handled.current.has(outcome)) return;
    handled.current.add(outcome);
    const { name: label, image: picture, optionsLabel: line, onAdded: confirmed, item: what, locale: lang, key: itemId } = live.current;
    if (outcome.ok) {
      rememberAdded(itemId);
      if (mounted.current) markAdded();
      const partial = outcome.added < outcome.requested;
      const sentence = partial ? t("add.announcePartial", { added: outcome.added, name: label }) : t("add.announceAdded", { name: label });
      announce(sentence);
      show(partial ? { tone: "warn", text: sentence, retryQty: null } : null);
      confirmed?.(outcome.cart, outcome.added);
      // the toast follows the landing (v2 §2.11): it never shows mid-flight
      void landed.then(() =>
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
        }),
      );
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
    const land = landing();
    const flight = origin ? flyToCart(origin, { onArrive: land.arrive }) : (land.arrive(), { revert() {} });
    void addToCart({ ...live.current.item, qty: units, locale: live.current.locale }).then((outcome) => settle(outcome, flight, land.promise));
  };

  const press = (event: MouseEvent<HTMLElement>) => {
    // offline: nothing flies and nothing is queued that cannot be sent — say so where the shopper looked
    if (!online || (typeof navigator !== "undefined" && navigator.onLine === false)) {
      showShopToast({ kind: "error", title: t("add.offline"), detail: name });
      return;
    }
    const units = Math.max(1, Math.trunc(qty));
    run(units, resolveSource(source) ?? event.currentTarget);
  };

  const retry = () => {
    if (notice?.retryQty) run(notice.retryQty, null);
  };

  const soldOut = stock === "out_of_stock";
  const keyLook = look === "onBand" ? "onBand" : "primary";
  // the labelled key goes flat while offline, its reason beside it (a sold-out key already says why it is flat)
  const offline = variant === "key" && !online && !soldOut && !chooseHref;
  const describedBy = cx(props["aria-describedby"], offline && message === "after" && reasonId) || undefined;
  let control: ReactNode;
  if (variant === "socket") {
    if (soldOut) control = null;
    else if (chooseHref) {
      control = <IconKey as={MotionLink} nav="zoom" to={chooseHref} icon="bag-plus" label={t("add.chooseNamed", { name })} className={cx("cadd", className)} />;
    } else {
      control = (
        <IconKey
          icon={added ? <Icon name="check" size={20} /> : "bag-plus"}
          label={ui(added ? "socket.addedMore" : "socket.add", { name })}
          disabled={disabled}
          aria-describedby={props["aria-describedby"]}
          data-state={added ? "added" : "ready"}
          onClick={press}
          className={cx("cadd", className)}
        />
      );
    }
  } else if (soldOut) {
    control = (
      <Key variant={keyLook} size={size} block={block} disabled icon="bag-plus" aria-describedby={props["aria-describedby"]} className={className}>
        {t("add.soldOut")}
      </Key>
    );
  } else if (chooseHref) {
    control = (
      <Key as={MotionLink} nav="zoom" to={chooseHref} variant={keyLook} size={size} block={block} icon="bag-plus" className={className}>
        {label ?? t("add.choose")}
      </Key>
    );
  } else {
    control = (
      <Key
        variant={keyLook}
        size={size}
        block={block}
        disabled={disabled || offline}
        aria-describedby={describedBy}
        icon="bag-plus"
        data-state={added ? "added" : "ready"}
        onClick={press}
        className={className}
      >
        {label ?? t("add.label")}
      </Key>
    );
  }

  return (
    <>
      {control}
      {message === "after" && offline ? (
        <p id={reasonId} className="relative flex w-full basis-full items-center gap-x-2 type-xs-strong text-ink-2">
          <Icon name="wifi-slash" size={16} />
          <span className="min-w-0">{t("add.offline")}</span>
        </p>
      ) : null}
      {message === "after" && notice ? (
        <p className={cx("relative flex w-full basis-full flex-wrap items-center gap-x-2 type-xs-strong", notice.tone === "error" ? "text-danger" : "text-warn")}>
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

/** The card add button (v2 §4.11): `<AddToCartKey variant="socket">` under its v2 name. */
export function CardAddButton(props: Omit<AddToCartKeyProps, "variant" | "size" | "block">) {
  return <AddToCartKey {...props} variant="socket" />;
}

function resolveSource(source: AddToCartKeyProps["source"]): Element | null {
  if (typeof source === "function") return source() ?? null;
  return source ?? null;
}

/* ───────────────────────────── buy controls (≥1024) and the buy bar (phones, tablets) ───────────────────────────── */

export type BuyControlsProps = Omit<AddToCartKeyProps, "variant" | "qty" | "block" | "size"> & {
  /** Quantity (controlled) — or leave it to the controls, starting at 1. */
  qty?: number;
  defaultQty?: number;
  onQtyChange?: (qty: number) => void;
  /** The stepper's upper bound: what one cart line may hold right now (stock- and policy-limited). Default 10. */
  maxQty?: number;
  /** Why the bound exists — "stock" says «بقي {max} فقط» at the limit (real stock only). */
  maxReason?: StepperProps["maxReason"];
  /** Beside the key: the outline wishlist icon button (<WishlistKey>). */
  aside?: ReactNode;
  /** Under the row: 44px text buttons «المفضلة · قارن · مشاركة». */
  links?: ReactNode;
};

/**
 * The PDP's buy controls from 1024 (v2 §4.15): the 48px stepper, the primary «أضف إلى السلة» (48, it grows) and an
 * outline wishlist icon button; under them a row of 44px text buttons. A used unit is one unit (no stepper); a product
 * that needs a choice or is sold out shows the key's own state alone.
 */
export function BuyControls({ qty, defaultQty = 1, onQtyChange, maxQty = MAX_ADD_QTY, maxReason, aside, links, className, ...key }: BuyControlsProps & { className?: string }) {
  const [current, setCurrent] = useControllable<number>(qty, defaultQty, onQtyChange);
  const single = Boolean(key.item.usedUnitId) || key.stock === "out_of_stock" || Boolean(key.chooseHref);
  const bound = Math.max(1, Math.min(MAX_ADD_QTY, Math.trunc(maxQty)));
  const units = Math.min(bound, Math.max(1, current));
  return (
    <div className={cx("grid gap-2", className)}>
      <div className="flex flex-wrap items-start gap-3">
        {single ? null : <Stepper value={units} onChange={setCurrent} min={1} max={bound} maxReason={maxReason} className="shrink-0" />}
        <div className="flex min-w-0 flex-1 flex-wrap gap-y-1.5">
          <AddToCartKey {...key} variant="key" qty={units} block className="w-full" />
        </div>
        {aside}
      </div>
      {links ? <div className="flex flex-wrap items-center gap-x-5">{links}</div> : null}
    </div>
  );
}

export type BuyBarProps = BuyControlsProps & {
  /** The chosen variant's price (lg, at the start). */
  priceIqd?: number | null;
  /** coming soon: the release day (epoch ms) — the bar says when and offers no button. */
  releaseAt?: number | null;
  /** sold out: «شاهد بدائل» scrolls here ("#alternatives"). */
  alternativesHref?: string;
  /** false: sticky inside a scrolling box (the /design-system specimen). */
  fixed?: boolean;
  /**
   * Content only — no glass, no fixed position, no padding of its own: for a page that puts the bar inside the shell's
   * <TaskBar>, which owns the glass, the named region, the persisted name and the height it publishes.
   */
  bare?: boolean;
  /** The bar's accessible name: it becomes a named region (not with `bare` — name the <TaskBar>). */
  "aria-label"?: string;
  /** Kept in place through page transitions (`data-motion-persist`, e.g. "bar"). Not with `bare`. */
  "data-motion-persist"?: string;
};

/**
 * The phone and tablet buy bar (v2 §4.15): glass, 72px + the safe area, --e-float; it replaces the tab bar on the
 * product page. At the start the price (lg) and the chosen variant (13 ink-2, one line); at the end the primary
 * «أضف إلى السلة» (48, min 168px). After an add of this variant the start says «✓ في السلة» over the price and the key
 * becomes «عرض السلة (2)» (to the cart); another variant restores «أضف إلى السلة». Sold out: «نفد حالياً» + «شاهد بدائل».
 * Coming soon: «يصدر 19 تشرين الثاني 2026 · الطلب يفتح عند وصوله», no button. No stepper (quantity lives in the cart).
 * A failed add says why on the variant's line (red-ink; the error toast carries the retry), so the bar never grows;
 * offline the key goes flat and that line says «لا يوجد اتصال».
 */
export function BuyBar({
  fixed = true,
  bare = false,
  className,
  priceIqd = null,
  releaseAt = null,
  alternativesHref,
  onAdded,
  "aria-label": label,
  "data-motion-persist": persist,
  ...controls
}: BuyBarProps & { className?: string }) {
  const t = useT("ui-shop");
  const f = useFormat();
  const online = useOnline() && !controls.offline;
  const { count } = useCartCount();
  const key = itemKey(controls.item);
  const [addedKey, setAddedKey] = useState<string | null>(null);
  const [said, setSaid] = useState<{ text: string; tone: "error" | "warn" } | null>(null);
  const added = addedKey === key;
  const soldOut = controls.stock === "out_of_stock";
  const soon = controls.stock === "preorder";
  // the caller who asked for no message renders its own (P3's page did); otherwise the bar's line says it
  const own = controls.message !== "none";
  const line = !soon && !soldOut && !added && !online ? { text: t("add.offlineShort"), tone: "warn" as const } : own ? said : null;
  const lineId = useId();

  let end: ReactNode;
  if (soon) end = null;
  else if (soldOut) {
    end = alternativesHref ? (
      <Key as="a" href={alternativesHref}>
        {t("add.alternatives")}
      </Key>
    ) : null;
  } else if (added) {
    end = (
      <Key as={LocaleLink} to="/cart" variant="primary" iconEnd="arrow-right">
        {t("add.viewCartCount", { n: f.number(count) })}
      </Key>
    );
  } else {
    end = (
      <AddToCartKey
        {...controls}
        variant="key"
        qty={1}
        message="none"
        aria-describedby={cx(controls["aria-describedby"], line && lineId) || undefined}
        onMessage={(text, tone) => {
          setSaid(text ? { text, tone: tone ?? "error" } : null);
          controls.onMessage?.(text, tone);
        }}
        onAdded={(cart, units) => {
          setAddedKey(key);
          onAdded?.(cart, units);
        }}
      />
    );
  }

  const content = (
    <div className={cx("buybar mx-auto max-w-[40rem]", bare && "min-h-0 p-0", bare && className)}>
      <div className="buybar__info">
        {added ? (
          <span className="buybar__added flex items-center gap-1">
            <Icon name="check" size={16} />
            {t("add.inCart")}
          </span>
        ) : null}
        {soon ? (
          <span className="type-xs-strong text-ink">
            {releaseAt ? t("add.soonOn", { date: f.date(releaseAt, "long") }) : t("stock.soon")}
            <span className="font-normal text-ink-2"> · {t("add.soonNote")}</span>
          </span>
        ) : soldOut ? (
          <span className="type-sm-strong text-ink-2">{t("add.soldOut")}</span>
        ) : priceIqd !== null ? (
          <SafePrice amountIqd={priceIqd} size="lg" approx="off" as="span" />
        ) : null}
        {line ? (
          <span id={lineId} className={cx("buybar__var font-semibold", line.tone === "error" ? "text-danger" : "text-warn")}>
            {line.text}
          </span>
        ) : controls.optionsLabel && !soon ? (
          <span className="buybar__var">{controls.optionsLabel}</span>
        ) : null}
      </div>
      {end ? <div className="flex flex-wrap justify-end [&_.key]:min-w-[168px]">{end}</div> : null}
    </div>
  );
  if (bare) return content;
  return (
    <Glass
      edge="bottom"
      role={label ? "region" : undefined}
      aria-label={label}
      data-motion-persist={persist}
      className={cx(fixed ? "fixed inset-x-0 bottom-0" : "sticky bottom-0", "z-(--z-nav)", className)}
    >
      {content}
    </Glass>
  );
}
