import { useId, type CSSProperties, type ReactNode } from "react";

import type { IconName } from "~/art/Icon";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import { keyIcon } from "./Key";
import { PlatformLed, type Gel } from "./PlatformLed";
import { useControllable, useRovingRadio } from "./roving";
import { Segmented } from "./Segmented";

export { useControllable, useRovingRadio, type RovingRadioOptions } from "./roving";

/**
 * 1.0's key bank — retired from the storefront (Design System v2 §4.1, §4.2): it now RENDERS AS A SEGMENTED CONTROL,
 * so today's call sites (MotionChoice, the shell's preferences) keep working. New code uses ./Segmented (choices),
 * ./Chip (filters), ./PlatformTile (platform doors) and ./Gallery (thumbnails).
 *
 *   <KeyBank kind="segment" aria-label={t("density")} items={[{ value: "store", label: … }, …]} value={v} onChange={set} />
 *   <KeyBank items={platforms.map((p) => ({ value: p, gel: p, label: name(p) }))} value={p} onChange={set} />   dot + name
 *   <KeyBank kind="thumb" aria-label={…} items={views.map((v, i) => ({ value: v, ariaLabel: …, media: <Render …/> }))} />
 *
 * Radio semantics: one tab stop, arrow keys follow the reading direction, Home/End, Space/Enter choose. `name` adds a
 * hidden input so the choice submits with a <Form>. Controlled (`value`) or not (`defaultValue`).
 */
export type KeyBankItem = {
  value: string;
  /** Visible text. Latin product or platform names are isolated automatically. */
  label?: ReactNode;
  /** Accessible name when the key shows no text (thumbnails). */
  ariaLabel?: string;
  /** Sprite icon or node. */
  icon?: IconName | ReactNode;
  /** A platform: its 8px dot beside the label. */
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
  /** platform (segments with a dot, wrapping 2×2 on phones) · thumb (gallery) · segment (the segmented control). */
  kind?: "platform" | "thumb" | "segment";
  /** Visible label above the control (it names the group). */
  label?: ReactNode;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Submit the choice with a form. */
  name?: string;
  className?: string;
  style?: CSSProperties;
};

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
  const heading = label ? (
    <p className="bank__label" id={labelId}>
      {label}
    </p>
  ) : null;
  const named = labelledBy ?? (label ? labelId : undefined);

  if (kind === "segment") {
    return (
      <>
        {heading}
        <Segmented
          inline
          aria-label={ariaLabel}
          aria-labelledby={named}
          options={items.map((item) => ({ value: item.value, label: item.label, ariaLabel: item.ariaLabel, icon: item.icon, disabled: item.disabled }))}
          value={current}
          onChange={setCurrent}
          onIntent={onIntent}
          name={name}
          className={className}
          style={style}
        />
      </>
    );
  }

  return (
    <>
      {heading}
      <div role="radiogroup" aria-label={ariaLabel} aria-labelledby={named} className={cx("bank", kind === "thumb" && "bank--thumb", className)} style={style}>
        {items.map((item, index) => {
          const chosen = item.value === current;
          return (
            <button
              key={item.value}
              type="button"
              className={cx("key", kind === "thumb" ? "key--thumb" : "key--plat")}
              data-gel={item.gel}
              data-press="soft"
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
                    {keyIcon(item.icon, 20)}
                    {item.label !== undefined ? <BidiLabel className="key__label">{item.label}</BidiLabel> : null}
                    {item.gel ? <PlatformLed /> : null}
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
