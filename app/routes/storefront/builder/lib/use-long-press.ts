/**
 * Press-and-hold on a game card opens its details (docs/switch-builder.md §6.5). STUB written by the lead; the
 * sheet-and-tour owner replaces the body and keeps the signature.
 */
import type { MouseEvent, PointerEvent } from "react";

export interface LongPressOptions {
  onLongPress: () => void;
  /** Hold time before it fires (default 450 ms). */
  delayMs?: number;
  /** Movement that cancels the hold, in CSS px (default 6). */
  moveTolerancePx?: number;
  disabled?: boolean;
}

/** Spread these on the card's button. After a long press fires, the click that follows is swallowed. */
export interface LongPressHandlers {
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
  onPointerLeave: (event: PointerEvent<HTMLElement>) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>) => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
}

const noop = () => undefined;

export function useLongPress(_options: LongPressOptions): LongPressHandlers {
  return { onPointerDown: noop, onPointerMove: noop, onPointerUp: noop, onPointerCancel: noop, onPointerLeave: noop, onContextMenu: noop, onClickCapture: noop };
}
