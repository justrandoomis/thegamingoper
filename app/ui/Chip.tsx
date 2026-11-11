import { useId, type ChangeEvent, type ComponentPropsWithRef, type CSSProperties, type ElementType, type MouseEvent, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "./cx";
import { useControllable, useRovingRadio } from "./KeyBank";

/**
 * Chips (docs/DESIGN.md §9.8): short choices on 44px clay keys. Unchosen = white clay with a hollow ring; chosen =
 * held down, ink, with a check. The ring and the check occupy the same 16px, so choosing never reflows the row.
 * Chips are for choices — a non-interactive fact is plain text or a <Tag>.
 *
 *   Toggle (multi-choice, aria-pressed)   <Chip selected={on} onClick={toggle}>1 TB</Chip>
 *   Link (a filter that is a URL)         <Chip as={LocaleLink} to="?storage=1tb" selected={active}>1 TB</Chip>
 *   Native checkbox / radio (no script)   <Chip input="checkbox" name="storage" value="1tb" defaultChecked>1 TB</Chip>
 *   Removable active filter               <Chip onRemove={() => drop("1tb")}>1 TB</Chip>          held, ×, "Remove 1 TB"
 *   Single choice with arrow keys         <ChipGroup aria-label={t("storage")} options={…} value={v} onChange={setV} />
 */
type ChipCommon = {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
};

export type ChipInputProps = ChipCommon & {
  /** Render a real <input> inside the chip: submits with a plain <Form>, keyboard behaviour is native. */
  input: "checkbox" | "radio";
  name: string;
  value: string;
  checked?: boolean;
  defaultChecked?: boolean;
  onChange?: (event: ChangeEvent<HTMLInputElement>) => void;
  /** Visible text is the label; pass this only when it is not descriptive on its own. */
  "aria-label"?: string;
};

export type ChipButtonProps<C extends ElementType = "button"> = ChipCommon & {
  input?: undefined;
  as?: C;
  /** Chosen. On a button this is `aria-pressed`; on a link `aria-current`. */
  selected?: boolean;
  /** Turns the chip into a held-down "remove this filter" key with a ×. */
  onRemove?: () => void;
} & Omit<ComponentPropsWithRef<C>, keyof ChipCommon | "as" | "input" | "selected" | "onRemove">;

export type ChipProps<C extends ElementType = "button"> = ChipInputProps | ChipButtonProps<C>;

export function Chip<C extends ElementType = "button">(props: ChipProps<C>) {
  const t = useT("ui");
  if (props.input) {
    const { input, name, value, checked, defaultChecked, onChange, disabled, children, className, style, "aria-label": ariaLabel } = props;
    return (
      <label className={cx("key key--chip", className)} style={style} data-press="clay">
        <input
          className="key__native"
          type={input}
          name={name}
          value={value}
          checked={checked}
          defaultChecked={defaultChecked}
          onChange={onChange}
          disabled={disabled}
          aria-label={ariaLabel}
        />
        <span className="key__cap">
          <ChipMark />
          <bdi className="key__label">{children}</bdi>
        </span>
      </label>
    );
  }

  const { as, selected, onRemove, disabled = false, children, className, ...rest } = props as ChipButtonProps<ElementType>;
  const Tag: ElementType = as ?? "button";
  const isButton = Tag === "button";
  const removable = typeof onRemove === "function";
  const own = rest as Record<string, unknown> & { onClick?: (event: MouseEvent<HTMLElement>) => void };
  const state: Record<string, unknown> = isButton
    ? { type: "button", disabled: disabled || undefined, "aria-pressed": removable ? undefined : selected }
    : { "aria-current": selected ? "true" : undefined, "aria-disabled": disabled || undefined, "data-held": selected ? "" : undefined };

  return (
    <Tag
      {...rest}
      {...state}
      className={cx("key key--chip", className)}
      data-press="clay"
      data-held={removable ? "" : (state["data-held"] as string | undefined)}
      aria-label={removable ? t("chip.remove", { label: textOf(children) }) : (own["aria-label"] as string | undefined)}
      onClick={(event: MouseEvent<HTMLElement>) => {
        if (disabled) {
          event.preventDefault();
          return;
        }
        own.onClick?.(event);
        if (removable && !event.defaultPrevented) onRemove();
      }}
    >
      <span className="key__cap">
        {removable ? <Icon name="x" size={16} /> : <ChipMark />}
        <bdi className="key__label">{children}</bdi>
      </span>
    </Tag>
  );
}

/** The reserved 16px: a hollow ring until chosen, then a check (CSS swaps them; nothing moves). */
function ChipMark() {
  return (
    <span className="key__mark" aria-hidden="true">
      <Icon name="check" size={16} />
    </span>
  );
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: ReactNode } }).props.children);
  return "";
}

/* ───────────────────────────── ChipGroup: one choice, roving focus ───────────────────────────── */

export type ChipOption = { value: string; label: ReactNode; disabled?: boolean };

export type ChipGroupProps = {
  options: readonly ChipOption[];
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Submit the choice with a form. */
  name?: string;
  /** One scrolling row instead of wrapping lines (hub filter rails). */
  rail?: boolean;
  className?: string;
};

export function ChipGroup({ options, value, defaultValue = null, onChange, "aria-label": ariaLabel, "aria-labelledby": labelledBy, name, rail = false, className }: ChipGroupProps) {
  const id = useId();
  const [current, setCurrent] = useControllable(value, defaultValue, onChange);
  const { itemProps } = useRovingRadio({
    values: options.map((option) => option.value),
    isDisabled: (index) => Boolean(options[index]?.disabled),
    value: current,
    onChange: setCurrent,
  });
  return (
    <div role="radiogroup" id={id} aria-label={ariaLabel} aria-labelledby={labelledBy} className={cx("chips", rail && "chips--rail", className)}>
      {options.map((option, index) => (
        <button key={option.value} type="button" className="key key--chip" data-press="clay" disabled={option.disabled} {...itemProps(index)}>
          <span className="key__cap">
            <ChipMark />
            <bdi className="key__label">{option.label}</bdi>
          </span>
        </button>
      ))}
      {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}
    </div>
  );
}
