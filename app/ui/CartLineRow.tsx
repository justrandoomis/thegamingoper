import { useLayoutEffect, useRef, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { CartLine, CartLineProblem } from "~/lib/dto";
import { BidiText, isolate } from "./BidiText";
import { cartErrorKey, MAX_ADD_QTY } from "./cart-client";
import { cx } from "./cx";
import { IconKey } from "./IconKey";
import { Key } from "./Key";
import { Niche } from "./Niche";
import { ProductImage } from "./ProductCard";
import { iqdText, PriceTag } from "./PriceTag";
import { Stepper } from "./Stepper";
import { Status } from "./Tag";
import { TextLink } from "./TextLink";

/**
 * One line of the cart — Design System v2 §4.13: a 96px well (120 from 1024, --r-sm) on the product ground; the name
 * (a link, two lines), the OPTION VALUE ONLY («النسخة الدولية · قطعة واحدة»), the availability («متوفر» or the problem
 * sentence), the 40px stepper, the line total (Kufam 16, tabular; a fixed 140px end column from 1024) and, under the
 * name, «إزالة» (a trash icon, 44px) plus your own actions («نقل إلى المفضلة»). Rows are separated by hairlines. Feed it
 * the rows of `useCartEditor` (~/ui/cart-client), which owns the requests:
 *
 *   const editor = useCartEditor(loaderData.cart, { locale });
 *   <ul className="grid gap-3">
 *     {editor.rows.map((row) => (
 *       <CartLineRow key={row.line.id} {...row}
 *         onQtyChange={(qty) => editor.setQty(row.line.id, qty)} onRemove={() => editor.remove(row.line.id)}
 *         onRestore={() => editor.restore(row.line.id)} onDismiss={() => editor.dismiss(row.line.id)} />
 *     ))}
 *   </ul>
 *
 * States: `line.problem` (out_of_stock / unavailable block checkout: the row says so in red-ink words, the total is
 * replaced by "لا يُحتسب في المجموع" and the stepper goes; qty_reduced and price_changed are notices), `busy` (a change
 * is waiting for the server — numbers never animate, the row is aria-busy), `error` (the last change failed and was
 * rolled back: the reason in words), `removed` (the undo row "أزلنا … من السلة." with "تراجع", kept in place until
 * restored or hidden). Focus never falls to the page: removing moves it to "تراجع", hiding moves it to the next row,
 * and a restored line takes it back.
 */
export type CartLineRowProps = {
  line: CartLine;
  /** Removed: show the undo row. */
  removed?: boolean;
  /** A change is waiting for the server. */
  busy?: boolean;
  /** Failure code of the last change (cart-client's `cartErrorKey` turns it into a sentence). */
  error?: string | null;
  onQtyChange?: (qty: number) => void;
  onRemove?: () => void;
  onRestore?: () => void;
  onDismiss?: () => void;
  /** More text actions after "أزل" (e.g. "انقل إلى المفضلة" once the wishlist exists). */
  actions?: ReactNode;
  /** "li" (default) inside a <ul>/<ol>, or "div". */
  as?: "li" | "div";
  className?: string;
};

const BLOCKING: ReadonlySet<CartLineProblem> = new Set(["out_of_stock", "unavailable"]);

/** How a cart-line problem is shown. Pure. */
export function lineProblemLook(problem: CartLineProblem | null): { blocking: boolean; tone: "bad" | "warn" | "info"; icon: IconName } | null {
  if (!problem) return null;
  if (BLOCKING.has(problem)) return { blocking: true, tone: "bad", icon: "warning-circle" };
  if (problem === "qty_reduced") return { blocking: false, tone: "warn", icon: "warning" };
  return { blocking: false, tone: "info", icon: "info" };
}

/** Identifies the item behind a line across removal and restore (the restored line gets a new id). */
const itemOf = (line: CartLine) => (line.usedUnitId ? `u:${line.usedUnitId}` : `v:${line.variantId ?? line.id}`);

/** A restored line whose row should take focus as it mounts (set by the undo row as it leaves). */
let focusHandoff: string | null = null;

const TONE_CLASS = { bad: "text-danger", warn: "text-warn", info: "text-info" } as const;

export function CartLineRow({ line, removed = false, busy = false, error = null, onQtyChange, onRemove, onRestore, onDismiss, actions, as = "li", className }: CartLineRowProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const Row = as;
  const row = useRef<HTMLElement | null>(null);
  const restoreKey = useRef<HTMLButtonElement | null>(null);
  const wasRemoved = useRef(removed);
  const item = itemOf(line);

  // Removing moves focus to "تراجع": the "أزل" key that had it is gone.
  useLayoutEffect(() => {
    if (removed && !wasRemoved.current) {
      const active = document.activeElement;
      if (!active || active === document.body || row.current?.contains(active)) restoreKey.current?.focus();
    }
    wasRemoved.current = removed;
  }, [removed]);
  useLayoutEffect(() => {
    if (!removed) {
      if (focusHandoff === item) {
        focusHandoff = null;
        row.current?.querySelector<HTMLElement>("[data-line-name]")?.focus();
      }
      return;
    }
    const element = row.current;
    return () => {
      // The undo row leaves: if it held focus, the restored line (same item, new id) takes it.
      if (element?.contains(document.activeElement)) {
        focusHandoff = item;
        setTimeout(() => {
          if (focusHandoff === item) focusHandoff = null;
        }, 0);
      }
    };
  }, [removed, item]);

  const setRow = (element: HTMLElement | null) => {
    row.current = element;
  };

  if (removed) {
    const dismiss = () => {
      // Hiding the undo row: focus goes to the next line (or the previous one), never to the page.
      const next = row.current?.nextElementSibling ?? row.current?.previousElementSibling;
      onDismiss?.();
      requestAnimationFrame(() => next?.querySelector<HTMLElement>("a[href], button:not([disabled])")?.focus());
    };
    return (
      <Row ref={setRow} data-cart-line={line.id} data-removed="" aria-busy={busy || undefined} className={cx("cline cline--undo border-b border-line", className)}>
        <p className="min-w-0 flex-1">{t("line.removed", { name: isolate(line.name) })}</p>
        <span className="flex shrink-0 items-center gap-1">
          <Key ref={restoreKey} variant="ghost" size="sm" loading={busy} onClick={onRestore} aria-label={t("line.restoreNamed", { name: line.name })}>
            {t("line.restore")}
          </Key>
          <IconKey icon="x" size="sm" variant="plain" label={t("line.dismiss")} onClick={dismiss} disabled={busy} />
        </span>
        {error ? <LineMessage tone="bad" icon="warning-circle" text={t(cartErrorKey(error))} /> : null}
      </Row>
    );
  }

  const look = lineProblemLook(line.problem);
  const single = line.kind === "used_unit";
  const max = Math.max(1, Math.min(MAX_ADD_QTY, line.maxQty));
  const problemText = line.problem
    ? t(`line.problems.${line.problem}`, {
        max: f.number(line.maxQty),
        qty: f.number(line.qty),
        price: isolate(iqdText(f, line.unitPriceIqd)),
      })
    : null;
  const unitPrice = !single && line.qty > 1 ? t("line.unitPrice", { price: isolate(iqdText(f, line.unitPriceIqd)) }) : null;
  // the option value only (v2 §4.13): «النسخة الدولية · قطعة واحدة»
  const facts = [line.optionsLabel, single ? t("line.single") : null, unitPrice].filter(Boolean).join(" · ");
  const total = look?.blocking ? (
    <span className="type-xs-strong text-ink-2">{t("line.excluded")}</span>
  ) : (
    <PriceTag size="line" priceIqd={line.lineTotalIqd} approx="off" />
  );

  return (
    <Row ref={setRow} data-cart-line={line.id} data-problem={line.problem ?? undefined} aria-busy={busy || undefined} className={cx("cline", className)}>
      <Niche as="span" size="sm" fill={Boolean(line.image.mediaKey) && !line.image.isIllustration} className="self-start">
        <ProductImage image={line.image} alt="" sizes="120px" fit="cover" />
      </Niche>
      <div className="cline__body">
        {/* the link is a 44px band (negative margins keep the layout); the name inside wraps to two lines at most */}
        <p className="cline__name [unicode-bidi:isolate]">
          <LocaleLink to={line.href} data-line-name="" className="-my-3 block py-3 underline-offset-4 hover:underline">
            <span className="line-clamp-2">
              <BidiText text={line.name} />
            </span>
          </LocaleLink>
        </p>
        {facts ? <p className="cline__opt">{facts}</p> : null}
        {problemText && look ? (
          <LineMessage tone={look.tone} icon={look.icon} text={problemText} />
        ) : (
          <p className="cline__avail">
            <Status tone="ok">{t("stock.in")}</Status>
          </p>
        )}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-1">
          {look?.blocking || single ? null : (
            <Stepper
              size="sm"
              value={line.qty}
              min={1}
              max={max}
              maxReason={max < MAX_ADD_QTY ? "stock" : undefined}
              label={t("line.qty", { name: line.name })}
              onChange={onQtyChange}
            />
          )}
          <span className="lg:hidden">{total}</span>
        </div>
        <div className="cline__actions">
          <TextLink as="button" type="button" icon="trash" arrow={false} onClick={onRemove} aria-label={t("line.removeNamed", { name: line.name })}>
            {t("buy.removeShort")}
          </TextLink>
          {actions}
        </div>
        {error || busy ? (
          <div className="grid gap-1" aria-live="polite">
            {error ? <LineMessage tone="bad" icon="warning-circle" text={t(cartErrorKey(error))} /> : null}
            {busy ? <span className="sr-only">{t("line.updating")}</span> : null}
          </div>
        ) : null}
      </div>
      <div className="cline__total max-lg:hidden">{total}</div>
    </Row>
  );
}

function LineMessage({ tone, icon, text }: { tone: "bad" | "warn" | "info"; icon: IconName; text: string }) {
  return (
    <p className={cx("flex items-start gap-1.5 type-xs-strong", TONE_CLASS[tone])}>
      <Icon name={icon} size={16} className="mt-0.5 shrink-0" />
      <span className="min-w-0">{text}</span>
    </p>
  );
}
