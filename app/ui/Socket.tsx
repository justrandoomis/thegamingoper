import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";
import { IconKey } from "./IconKey";

/**
 * 1.0's socket — RETIRED (Design System v2 §4.1, §4.2, §11.4; stage 4 deletes it). The red socket on every card is gone:
 * the card add button is ./AddToCartKey's `CardAddButton` — a neutral 40px circle that fills red under the pointer and
 * shows an ok check after an add. Until the last importer migrates, `<Socket>` renders that button (or its child, or
 * nothing for "empty" — a sold-out or coming-soon card says so in words, never with an empty socket).
 * `AddGlyph` is the sprite's `bag-plus` now.
 */
export type SocketState = "ready" | "added" | "empty";

export type SocketProps = {
  /** Product name for the button's accessible name. */
  name?: string;
  state?: SocketState;
  onAdd?: (event: MouseEvent<HTMLButtonElement>) => void;
  /** The add request is in flight. */
  loading?: boolean;
  disabled?: boolean;
  /** 1.0 — ignored. */
  inset?: boolean;
  /** Any button instead of the default add button. */
  children?: ReactNode;
  className?: string;
};

export function Socket({ name = "", state = "ready", onAdd, loading, disabled, children, className }: SocketProps) {
  const t = useT("ui");
  if (children) return <span className={cx("inline-flex", className)}>{children}</span>;
  if (state === "empty") return null;
  return (
    <IconKey
      icon={state === "added" ? <Icon name="check" size={20} /> : "bag-plus"}
      label={t(state === "added" ? "socket.addedMore" : "socket.add", { name })}
      loading={loading}
      disabled={disabled}
      onClick={onAdd}
      data-state={state}
      className={cx("cadd", className)}
    />
  );
}

/** 1.0's inline cart-plus glyph → the sprite's `bag-plus` (v2 §8). Decorative: the button around it carries the name. */
export function AddGlyph({ size = 20 }: { size?: number }) {
  return <Icon name="bag-plus" size={size} />;
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
