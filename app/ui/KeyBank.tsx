import { useCallback, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";

import type { IconName } from "~/art/Icon";
import { cx } from "./cx";
import { keyIcon } from "./Key";
import { isPlatform, PlatformGlyph, PlatformLed, type Gel } from "./PlatformLed";

/**
 * A bank of keys in a well (docs/DESIGN.md §2, §8.1): choose one and it goes down and STAYS down; the previous
 * one springs up. Radio semantics: one tab stop, arrow keys move the choice and follow the reading direction
 * (← is "next" in Arabic and Kurdish), Home/End jump, Space/Enter choose.
 *
 *   <KeyBank
 *     label={<><b>{t("turn")}</b> {t("pick")}</>}
 *     items={platforms.map((p) => ({ value: p.slug, label: p.name, gel: p.slug }))}   // LED + pictogram + name
 *     value={platform} onChange={setPlatform}
 *     onIntent={(slug) => prefetchHero(slug)}                                         // pointerdown, before the click
 *   />
 *   <KeyBank kind="thumb" aria-label={t("gallery")} items={views.map((v, i) => ({ value: v, ariaLabel: …, media: <Render name={`${key}@${v}`} alt="" /> }))} … />
 *   <KeyBank kind="segment" aria-label={t("density")} items={[{ value: "store", label: … }, { value: "admin", label: … }]} … />
 *
 * `name` adds a hidden input so the choice submits with a <Form>. Controlled (`value`) or not (`defaultValue`).
 */
export type KeyBankItem = {
  value: string;
  /** Visible text. Latin product or platform names are isolated automatically. */
  label?: ReactNode;
  /** Accessible name when the key shows no text (thumbnails). */
  ariaLabel?: string;
  /** Sprite icon or node. Platform keys default to the platform's pictogram. */
  icon?: IconName | ReactNode;
  /** Platform light for the LED (and the subtree). */
  gel?: Gel;
  /** Picture for thumbnail keys (a <Render>). */
  media?: ReactNode;
  disabled?: boolean;
};

export type KeyBankProps = {
  items: readonly KeyBankItem[];
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  /** Pointer-down on a key that is not chosen yet: start fetching what it will show. */
  onIntent?: (value: string) => void;
  /** platform (tall keys with LED, pictogram, name) · thumb (gallery) · segment (short text keys). */
  kind?: "platform" | "thumb" | "segment";
  /** Visible label above the well (it names the group). */
  label?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Submit the choice with a form. */
  name?: string;
  className?: string;
  style?: CSSProperties;
};

const KIND_CLASS = { platform: "key--plat", thumb: "key--thumb", segment: "key--sm" } as const;

export function KeyBank({
  items,
  value,
  defaultValue = null,
  onChange,
  onIntent,
  kind = "platform",
  label,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  name,
  className,
  style,
}: KeyBankProps) {
  const labelId = useId();
  const [current, setCurrent] = useControllable(value, defaultValue, onChange);
  const values = items.map((item) => item.value);
  const { itemProps } = useRovingRadio({ values, isDisabled: (index) => Boolean(items[index]?.disabled), value: current, onChange: setCurrent });

  return (
    <>
      {label ? (
        <p className="bank__label" id={labelId}>
          {label}
        </p>
      ) : null}
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        aria-labelledby={labelledBy ?? (label ? labelId : undefined)}
        className={cx("bank well", kind === "thumb" && "bank--thumb", kind === "segment" && "bank--segment", className)}
        style={{ "--bank-n": items.length, ...style } as CSSProperties}
      >
        {items.map((item, index) => {
          const chosen = item.value === current;
          const icon = item.icon ?? (kind === "platform" && isPlatform(item.gel) ? <PlatformGlyph platform={item.gel} /> : null);
          return (
            <button
              key={item.value}
              type="button"
              className={cx("key", KIND_CLASS[kind])}
              data-gel={item.gel}
              data-press="clay"
              disabled={item.disabled}
              aria-label={item.ariaLabel}
              onPointerDown={chosen || !onIntent ? undefined : () => onIntent(item.value)}
              {...itemProps(index)}
            >
              <span className="key__cap">
                {kind === "thumb" ? (
                  <span className="render-slot">{item.media}</span>
                ) : (
                  <>
                    {item.gel ? <PlatformLed /> : null}
                    {keyIcon(icon, kind === "platform" ? 22 : 18)}
                    {item.label !== undefined ? <bdi className="key__label">{item.label}</bdi> : null}
                  </>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}
    </>
  );
}

/* ───────────────────────────── shared radio behaviour (also used by <ChipGroup>) ───────────────────────────── */

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
