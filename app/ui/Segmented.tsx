import { useId, useRef, type CSSProperties, type ReactNode } from "react";

import type { IconName } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import { keyIcon } from "./Key";
import { revealFocusedItem, useKeepInView } from "./reveal";
import { useControllable, useRovingRadio } from "./roving";

/**
 * The segmented control — Design System v2 §4.6: a 44px --niche track with pill segments; the chosen segment is paper
 * with a hairline and a 600 label. One choice from a few: language (each name in its own script), theme, motion, and
 * the support sub-navigation (four equal link segments).
 *
 *   <Segmented aria-label={t("theme")} value={theme} onChange={setTheme}
 *              options={[{ value: "system", label: t("system") }, { value: "light", label: t("light"), icon: "sun" }, …]} />
 *   <Segmented aria-label={t("language")} value={locale} onChange={switchTo}
 *              options={LOCALE_CODES.map((code) => ({ value: code, label: LOCALES[code].label, lang: LOCALES[code].bcp47 }))} />
 *   <Segmented aria-label={t("support")} value="help" options={[{ value: "help", label: …, href: "/support" }, …]} />
 *
 * Choice mode is a radiogroup: one tab stop, arrows follow the reading direction, Home/End, selection follows focus.
 * Link mode (every option has `href`) is a <nav> of links with `aria-current="page"` on the current one (`current="true"`
 * when the segment is the section the page belongs to, not the page itself). Its segments keep their words: when they
 * do not fit (Sorani or English on a narrow phone) the track scrolls sideways — the current one kept in view, a focused
 * one brought into view — instead of cutting a label.
 */
export type SegmentedOption = {
  value: string;
  label?: ReactNode;
  /** Accessible name when the segment shows only an icon. */
  ariaLabel?: string;
  icon?: IconName | ReactNode;
  /** The label's own language (a language name in its own script). */
  lang?: string;
  /** Link mode: a locale-less path. */
  href?: string;
  disabled?: boolean;
};

export type SegmentedProps = {
  options: readonly SegmentedOption[];
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (value: string) => void;
  /** Pointer-down on a segment that is not chosen yet: start fetching what it will show. */
  onIntent?: (value: string) => void;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  /** Submit the choice with a form. */
  name?: string;
  /** Shrink to the content instead of filling the row. */
  inline?: boolean;
  /** Link mode: `aria-current` of the current segment — "page" (default) or "true" (a section of the site). */
  current?: "page" | "true";
  className?: string;
  style?: CSSProperties;
};

export function Segmented({
  options,
  value,
  defaultValue = null,
  onChange,
  onIntent,
  "aria-label": ariaLabel,
  "aria-labelledby": labelledBy,
  name,
  inline = false,
  current: currentKind = "page",
  className,
  style,
}: SegmentedProps) {
  const id = useId();
  const nav = useRef<HTMLElement | null>(null);
  const [current, setCurrent] = useControllable(value, defaultValue, onChange);
  const { itemProps } = useRovingRadio({
    values: options.map((option) => option.value),
    isDisabled: (index) => Boolean(options[index]?.disabled),
    value: current,
    onChange: setCurrent,
  });
  const links = options.length > 0 && options.every((option) => option.href);
  // link mode scrolls when its words do not fit: the current segment in view on the first paint and on each change
  useKeepInView(nav, "[aria-current]", links ? current : null);
  const body = (option: SegmentedOption) => (
    <>
      {keyIcon(option.icon, 20)}
      {option.label !== undefined ? (
        option.lang ? (
          <span lang={option.lang}>{option.label}</span>
        ) : (
          <BidiLabel>{option.label}</BidiLabel>
        )
      ) : null}
    </>
  );

  if (links) {
    return (
      <nav
        ref={nav}
        aria-label={ariaLabel}
        aria-labelledby={labelledBy}
        // each segment at least its words' width, the spare room shared out; past the row's width the track scrolls
        className={cx(
          "seg [grid-auto-columns:minmax(max-content,1fr)] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden [&>a:focus-visible]:-outline-offset-2",
          inline && "seg--inline justify-self-start",
          className,
        )}
        style={style}
        onFocus={revealFocusedItem}
      >
        {options.map((option) => (
          <LocaleLink
            key={option.value}
            to={option.href as string}
            className="seg__opt"
            data-press="soft"
            aria-current={option.value === current ? currentKind : undefined}
            aria-label={option.ariaLabel}
          >
            {body(option)}
          </LocaleLink>
        ))}
      </nav>
    );
  }

  return (
    <>
      <div role="radiogroup" id={id} aria-label={ariaLabel} aria-labelledby={labelledBy} className={cx("seg", inline && "seg--inline justify-self-start", className)} style={style}>
        {options.map((option, index) => (
          <button
            key={option.value}
            type="button"
            className="seg__opt"
            data-press="soft"
            disabled={option.disabled}
            aria-label={option.ariaLabel}
            onPointerDown={option.value === current || !onIntent ? undefined : () => onIntent(option.value)}
            {...itemProps(index)}
          >
            {body(option)}
          </button>
        ))}
      </div>
      {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}
    </>
  );
}
