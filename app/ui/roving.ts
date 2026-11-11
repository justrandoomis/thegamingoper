import { useCallback, useRef, useState, type KeyboardEvent } from "react";

/* Shared choice behaviour of the kit's radio rows (Segmented, KeyBank, ChipGroup, swatches, preference cells, gallery
 * thumbnails). Re-exported by ./KeyBank, where it first lived. */

export type RovingRadioOptions = {
  values: readonly string[];
  isDisabled?: (index: number) => boolean;
  value: string | null;
  onChange: (value: string) => void;
};

/**
 * Roving tabindex + radio semantics for a row of buttons. Spread `itemProps(i)` on each button.
 * Arrow keys follow the reading direction of the focused element (so a `dir="ltr"` island behaves like English),
 * skip disabled items, wrap around, and select as they move (the radio pattern).
 */
export function useRovingRadio({ values, isDisabled = () => false, value, onChange }: RovingRadioOptions) {
  const refs = useRef<(HTMLElement | null)[]>([]);
  const selected = value === null ? -1 : values.indexOf(value);
  const firstEnabled = values.findIndex((_, index) => !isDisabled(index));
  const tabStop = selected >= 0 && !isDisabled(selected) ? selected : firstEnabled;

  const step = (from: number, delta: 1 | -1) => {
    for (let i = 1; i <= values.length; i++) {
      const next = (from + delta * i + values.length * values.length) % values.length;
      if (!isDisabled(next)) return next;
    }
    return from;
  };

  const choose = (index: number) => {
    if (index < 0 || isDisabled(index)) return;
    refs.current[index]?.focus();
    if (values[index] !== value) onChange(values[index]);
  };

  const onKeyDown = (index: number) => (event: KeyboardEvent<HTMLElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    let target: number;
    switch (event.key) {
      case "ArrowRight":
        target = step(index, rtl ? -1 : 1);
        break;
      case "ArrowLeft":
        target = step(index, rtl ? 1 : -1);
        break;
      case "ArrowDown":
        target = step(index, 1);
        break;
      case "ArrowUp":
        target = step(index, -1);
        break;
      case "Home":
        target = firstEnabled;
        break;
      case "End": {
        let last = values.length - 1;
        while (last > 0 && isDisabled(last)) last--;
        target = last;
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    choose(target);
  };

  const itemProps = (index: number) => ({
    ref: (element: HTMLElement | null) => {
      refs.current[index] = element;
    },
    role: "radio" as const,
    "aria-checked": index === selected,
    tabIndex: index === tabStop ? 0 : -1,
    onKeyDown: onKeyDown(index),
    onClick: () => choose(index),
  });

  return { itemProps, selectedIndex: selected };
}

/** Controlled-or-uncontrolled value. */
export function useControllable<T>(value: T | undefined, defaultValue: T, onChange?: (value: Exclude<T, null | undefined>) => void) {
  const [inner, setInner] = useState<T>(defaultValue);
  const controlled = value !== undefined;
  const current = controlled ? value : inner;
  const set = useCallback(
    (next: Exclude<T, null | undefined>) => {
      if (!controlled) setInner(next);
      onChange?.(next);
    },
    [controlled, onChange],
  );
  return [current, set] as const;
}
