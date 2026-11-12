import { useId, type ChangeEvent, type ComponentPropsWithRef, type CSSProperties, type ElementType, type MouseEvent, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { BidiLabel, textOf } from "./BidiText";
import { cx } from "./cx";
import { PlatformLed, type Gel } from "./PlatformLed";
import { revealFocusedItem } from "./reveal";
import { useControllable, useRovingRadio } from "./roving";

/**
 * Chips — Design System v2 §4.6; v2.1 (DESIGN.md §15.2): a 40px CLAY PILL (44 hit) — raised on its 2px wall like the
 * before's chips — 14/600 ink words, an optional count in ink-2 («الألعاب 18») and an optional 8px platform dot. Chosen =
 * ink, HELD DOWN on its wall, paper words and a 16px check at the start (the count at 72%). Chips are STATE, never action — an action is a <Key> (12px corners, not a pill).
 *
 *   Toggle (multi-choice, aria-pressed)   <Chip selected={on} onClick={toggle} count={18}>الألعاب</Chip>
 *   With a platform dot                   <Chip platform="playstation">PlayStation</Chip>
 *   Link (a filter that is a URL)         <Chip as={LocaleLink} to="?storage=1tb" selected={active}>1 TB</Chip>
 *   Native checkbox / radio (no script)   <Chip input="checkbox" name="storage" value="1tb" defaultChecked>1 TB</Chip>
 *   Removable active filter               <Chip onRemove={() => drop("1tb")}>1 TB</Chip>          ×, "أزل 1 TB"
 *   Single choice with arrow keys         <ChipGroup aria-label={t("storage")} options={…} value={v} onChange={setV} />
 *
 * Rows: <div className="chips chips--rail chips--bleed"> scrolls sideways on phones (gutter kept) and wraps from 768.
 */
type ChipCommon = {
  children: ReactNode;
  /** A count after the label, in ink-2 ("الألعاب 18"). Numbers are formatted for the page's language. */
  count?: number | string;
  /** An 8px platform dot after the label. */
  platform?: Gel;
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
  /** A removable active filter: ends with a 44px ×; its name is "أزل {label}". */
  onRemove?: () => void;
} & Omit<ComponentPropsWithRef<C>, keyof ChipCommon | "as" | "input" | "selected" | "onRemove">;

export type ChipProps<C extends ElementType = "button"> = ChipInputProps | ChipButtonProps<C>;

function ChipBody({ children, count, platform, lead }: { children: ReactNode; count?: number | string; platform?: Gel; lead: ReactNode }) {
  const f = useFormat();
  return (
    <span className="key__cap">
      {lead}
      <BidiLabel className="key__label">{children}</BidiLabel>
      {count !== undefined && count !== null && count !== "" ? <span className="key__count nums">{typeof count === "number" ? f.number(count) : count}</span> : null}
      {platform ? <PlatformLed platform={platform} /> : null}
    </span>
  );
}

export function Chip<C extends ElementType = "button">(props: ChipProps<C>) {
  const t = useT("ui");
  if (props.input) {
    const { input, name, value, checked, defaultChecked, onChange, disabled, children, count, platform, className, style, "aria-label": ariaLabel } = props;
    return (
      <label className={cx("key key--chip", className)} style={style} data-press="soft">
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
        <ChipBody count={count} platform={platform} lead={<ChipMark />}>
          {children}
        </ChipBody>
      </label>
    );
  }

  const { as, selected, onRemove, disabled = false, children, count, platform, className, ...rest } = props as ChipButtonProps<ElementType>;
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
      data-press="soft"
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
      <ChipBody count={count} platform={platform} lead={removable ? <Icon name="x" size={16} /> : <ChipMark />}>
        {children}
      </ChipBody>
    </Tag>
  );
}

/** The 16px check at the start of a chosen chip (CSS shows it on aria-checked / aria-pressed / data-held / :checked). */
function ChipMark() {
  return (
    <span className="key__mark" aria-hidden="true">
      <Icon name="check" size={16} />
    </span>
  );
}

/* ───────────────────────────── ChipGroup: one choice, roving focus ───────────────────────────── */

export type ChipOption = { value: string; label: ReactNode; disabled?: boolean; count?: number | string; platform?: Gel };

export type ChipGroupProps = {
  options: readonly ChipOption[];
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Submit the choice with a form. */
  name?: string;
  /** One scrolling row on phones (wraps from 768) instead of wrapping lines. */
  rail?: boolean;
  /** With `rail`: bleed into the page gutter on phones (the row starts at the gutter, scrolls edge to edge). */
  bleed?: boolean;
  className?: string;
};

export function ChipGroup({ options, value, defaultValue = null, onChange, "aria-label": ariaLabel, "aria-labelledby": labelledBy, name, rail = false, bleed = false, className }: ChipGroupProps) {
  const id = useId();
  const [current, setCurrent] = useControllable(value, defaultValue, onChange);
  const { itemProps } = useRovingRadio({
    values: options.map((option) => option.value),
    isDisabled: (index) => Boolean(options[index]?.disabled),
    value: current,
    onChange: setCurrent,
  });
  return (
    <div
      role="radiogroup"
      id={id}
      aria-label={ariaLabel}
      aria-labelledby={labelledBy}
      className={cx("chips", rail && "chips--rail [&>*]:shrink-0", rail && bleed && "chips--bleed", className)}
      // a rail scrolls sideways on phones: the chip that takes the keyboard focus (Tab, the arrows) comes fully into view
      onFocus={rail ? revealFocusedItem : undefined}
    >
      {options.map((option, index) => (
        <button key={option.value} type="button" className="key key--chip" data-press="soft" disabled={option.disabled} {...itemProps(index)}>
          <ChipBody count={option.count} platform={option.platform} lead={<ChipMark />}>
            {option.label}
          </ChipBody>
        </button>
      ))}
      {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}
    </div>
  );
}
