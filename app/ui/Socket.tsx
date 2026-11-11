import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";
import { IconKey } from "./IconKey";

/**
 * The socket (docs/DESIGN.md §4 "Gallery", §9.5): a product card's red key seated in a flat well, so the well can
 * tell a story — a cart-plus glyph ("add"), a check for 1.2s after an add ("added"), or nothing at all ("empty":
 * it left — sold out, or the bead is in flight).
 *
 *   const [added, flash] = useAddedFlash();
 *   <Socket name={product.name} state={added ? "added" : "ready"} onAdd={(e) => { addToCart(); flash(); flyToCart(img) }} />
 *   <Socket name={product.name} state="empty" />            fact line says "نفد"; nothing to press
 *   <Socket inset>…any key…</Socket>                       an empty-state socket (pressed-in well)
 *
 * The add key's accessible name is "أضف {name} إلى السلة" (ui:socket.add); after an add it reads
 * "أُضيف {name} إلى السلة". A card has exactly one walled key: this one.
 */
export type SocketState = "ready" | "added" | "empty";

export type SocketProps = {
  /** Product name for the key's accessible name. */
  name?: string;
  state?: SocketState;
  onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** The add request is in flight (the key stays seated, shows a spinner). */
  loading?: boolean;
  disabled?: boolean;
  /** Pressed-in well (empty states) instead of the flat card well. */
  inset?: boolean;
  /** Seat any key instead of the default add key. */
  children?: ReactNode;
  className?: string;
};

export function Socket({ name = "", state = "ready", onAdd, loading, disabled, inset = false, children, className }: SocketProps) {
  const t = useT("ui");
  const seated =
    children ??
    (state === "empty" ? null : (
      <IconKey
        variant="commit"
        icon={state === "added" ? <Icon name="check" size={20} /> : <AddGlyph />}
        label={t(state === "added" ? "socket.added" : "socket.add", { name })}
        loading={loading}
        disabled={disabled}
        onClick={onAdd}
        data-state={state}
      />
    ));
  return (
    <span className={cx("socket", inset && "socket--inset", className)} aria-hidden={seated ? undefined : true}>
      {seated}
    </span>
  );
}

/**
 * The cart-plus glyph (DESIGN.md §4: "a cart-plus glyph instead of a bare plus") — a bag with a plus seated in it.
 * Drawn here because the icon sprite has no combined bag-plus symbol; it uses the same 24-grid stroke geometry as
 * the reference mock. Decorative: the key around it carries the name.
 */
export function AddGlyph({ size = 20 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className="shrink-0"
    >
      <path d="M5.6 8.2h12.8l-.9 10.4a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8z" />
      <path d="M9 8.2V7a3 3 0 0 1 6 0v1.2" />
      <path d="M12 11.5v5.4M9.3 14.2h5.4" />
    </svg>
  );
}

/** `[added, flash]`: `added` is true for `ms` after each `flash()` (rapid adds restart the timer). */
export function useAddedFlash(ms = 1200) {
  const [added, setAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback(() => {
    setAdded(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setAdded(false), ms);
  }, [ms]);
  return [added, flash] as const;
}
