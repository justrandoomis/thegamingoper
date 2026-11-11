import { useEffect, useRef, type PointerEvent } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";
import { IconKey } from "./IconKey";
import { useControllable } from "./KeyBank";
import { Status } from "./Tag";

/**
 * Quantity stepper (docs/DESIGN.md §9.10): two round keys in a well with a tabular numeral between them. The minus
 * is at the START and the plus at the END in every language. At the minimum the minus goes flat (and stays
 * focusable, so focus is never lost); at a stock limit the plus goes flat and "بقي 2 فقط" appears beside it.
 * Press and hold repeats (after 420ms, accelerating). The numeral is a polite live region.
 *
 *   <Stepper value={qty} onChange={setQty} max={stock} maxReason="stock" />
 *   <Stepper size="sm" defaultValue={line.qty} min={1} max={9} name="qty" />    in a cart line, submits with a form
 */
export type StepperProps = {
  value?: number;
  defaultValue?: number;
  onChange?: (value: number) => void;
  /** Default 1. */
  min?: number;
  max?: number;
  /** Why the maximum exists: "stock" shows "بقي {max} فقط" at the limit; any other string is shown as is. */
  maxReason?: "stock" | (string & {});
  /** md: 44px keys (buy bar) · sm: 36px keys with a 44px hit area (cart lines). */
  size?: "md" | "sm";
  /** Accessible name of the group. Default "الكمية". */
  label?: string;
  /** Submit the value with a form. */
  name?: string;
  disabled?: boolean;
  className?: string;
};

const HOLD_DELAY = 420;
const FIRST_REPEAT = 140;
const FASTEST_REPEAT = 50;

export function Stepper({ value, defaultValue, onChange, min = 1, max, maxReason, size = "md", label, name, disabled = false, className }: StepperProps) {
  const t = useT("ui");
  const f = useFormat();
  const [current, set] = useControllable<number>(value, defaultValue ?? min, onChange);
  const clamp = (n: number) => Math.min(max ?? Number.POSITIVE_INFINITY, Math.max(min, n));

  const latest = useRef(current);
  latest.current = current;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const repeated = useRef(false);
  useEffect(() => () => clearTimeout(timer.current), []);

  const canDecrease = !disabled && current > min;
  const canIncrease = !disabled && (max === undefined || current < max);

  const step = (delta: 1 | -1) => {
    const next = clamp(latest.current + delta);
    if (next === latest.current) return false;
    latest.current = next;
    set(next);
    return true;
  };

  const stop = () => clearTimeout(timer.current);
  const hold = (delta: 1 | -1) => (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    repeated.current = false;
    stop();
    let interval = FIRST_REPEAT;
    const tick = () => {
      if (!step(delta)) return;
      repeated.current = true;
      interval = Math.max(FASTEST_REPEAT, interval * 0.82);
      timer.current = setTimeout(tick, interval);
    };
    timer.current = setTimeout(tick, HOLD_DELAY);
  };
  const click = (delta: 1 | -1, allowed: boolean) => () => {
    stop();
    // A hold already stepped; the click that ends it must not add one more.
    if (repeated.current) {
      repeated.current = false;
      return;
    }
    if (allowed) step(delta);
  };
  const keyProps = (delta: 1 | -1, allowed: boolean) => ({
    size,
    "aria-disabled": allowed ? undefined : true,
    onPointerDown: allowed ? hold(delta) : undefined,
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
    onContextMenu: (event: { preventDefault: () => void }) => event.preventDefault(),
    onClick: click(delta, allowed),
  });

  const atStockLimit = max !== undefined && current >= max && maxReason !== undefined;

  return (
    <span className={cx("stepper-wrap", className)}>
      <span className={cx("stepper well", size === "sm" && "stepper--sm")} role="group" aria-label={label ?? t("stepper.label")}>
        <IconKey icon={<Icon name="minus" size={size === "sm" ? 18 : 20} />} label={t("stepper.decrease")} {...keyProps(-1, canDecrease)} />
        <output className="stepper__value" aria-live="polite" aria-atomic="true">
          {f.number(current)}
        </output>
        <IconKey icon={<Icon name="plus" size={size === "sm" ? 18 : 20} />} label={t("stepper.increase")} {...keyProps(1, canIncrease)} />
      </span>
      {atStockLimit ? (
        <Status tone="warn">{maxReason === "stock" ? t("stepper.limit", { count: f.number(max) }) : maxReason}</Status>
      ) : null}
      {name ? <input type="hidden" name={name} value={current} /> : null}
    </span>
  );
}
