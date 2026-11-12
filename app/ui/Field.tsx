import {
  useEffect,
  useId,
  useRef,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * Form fields — Design System v2 §4.9: paper with a real border — 52px, --r-sm, a 1px --line-strong boundary (3.83:1),
 * 16px text (no zoom on iOS), the label above in 14/600, a 13px hint below. Validation is the caller's: pass `error` (a
 * sentence that says what is wrong and what to type, e.g. «ينقص الرقم 4 أرقام.») — the field then gets a 2px --danger
 * border, a 16px alert icon, and the sentence REPLACES the hint (aria-invalid, aria-describedby, announced politely).
 * Never colour alone, never brand red. Required fields show «*» plus the word for screen readers and `aria-required`;
 * optional ones say «(اختياري)». Native browser validation is not used: the server and `error` carry validation. On
 * submit, put <FormErrorSummary> above the form and move focus to the first invalid field. Option cards (version,
 * payment, an answer) are <OptionCard>; governorates <GovernoratePicker>; delivery-time cells <PreferencePicker>.
 *
 *   <TextField label={t("phone")} type="tel" autoComplete="tel-national" required hint={t("weCall")} error={errors.phone} name="phone" />
 *   <TextField label={t("amount")} inputMode="numeric" name="amount" end={<span className="type-caption">د.ع</span>} />
 *   <TextArea label={t("address")} required name="address" />
 *   <Select label={t("governorate")} required name="gov" options={govs} placeholder={t("choose")} />
 *   <Checkbox label={t("offers")} name="marketing" />                   never pre-checked
 *   <FieldGroup legend={t("payment")} error={…}><Radio row name="pay" value="cod" label={…} hint={…} /></FieldGroup>
 *   <Switch label={t("notify")} name="notify" />
 *
 * Phone, numeric, email and URL inputs are left-to-right but hug the start edge of a right-to-left form (`ltr`
 * overrides). Every other input attribute (inputMode, autoComplete, enterKeyHint, pattern, …) passes through.
 */
type FieldCommon = {
  /** Visible label (required for every field). */
  label: ReactNode;
  /** Help text under the field (caption, ink-2). */
  hint?: ReactNode;
  /** The error sentence. Present = invalid. */
  error?: ReactNode;
  /** Marks the label with "*" and the word for screen readers. */
  required?: boolean;
  /** Marks the label "(اختياري)". */
  optional?: boolean;
  /** Visually hide the label (it still names the field) — search boxes with a visible icon only. */
  hideLabel?: boolean;
  /** Classes for the outer wrapper. */
  className?: string;
};

function useFieldIds(id: string | undefined, hint: ReactNode, error: ReactNode) {
  const auto = useId();
  const base = id ?? auto;
  const hintId = hint ? `${base}-hint` : undefined;
  const errorId = `${base}-error`;
  // the error REPLACES the hint (v2 §4.9)
  const describedBy = (error ? errorId : hintId) || undefined;
  return { id: base, hintId, errorId, describedBy };
}

function FieldLabel({ htmlFor, label, required, optional, hideLabel, as = "label", id }: { htmlFor?: string; label: ReactNode; required?: boolean; optional?: boolean; hideLabel?: boolean; as?: "label" | "legend" | "span"; id?: string }) {
  const t = useT("ui");
  const Tag = as;
  const content = (
    <>
      {label}
      {required ? (
        <>
          <span className="field__mark" aria-hidden="true">
            {" *"}
          </span>
          <VisuallyHidden> ({t("required")})</VisuallyHidden>
        </>
      ) : null}
      {optional && !required ? <span className="field__mark"> {t("field.optional")}</span> : null}
    </>
  );
  if (hideLabel) {
    return (
      <Tag className="sr-only" htmlFor={Tag === "label" ? htmlFor : undefined} id={id}>
        {content}
      </Tag>
    );
  }
  return (
    <Tag className="field__label" htmlFor={Tag === "label" ? htmlFor : undefined} id={id}>
      {content}
    </Tag>
  );
}

function FieldMessages({ hintId, hint, errorId, error }: { hintId?: string; hint?: ReactNode; errorId: string; error?: ReactNode }) {
  return (
    <>
      {hint && !error ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      {/* always present, so the first error is announced (a live region must exist before it changes) */}
      <p className="field__error" id={errorId} aria-live="polite">
        {error ? (
          <>
            <Icon name="warning-circle" size={16} />
            <span>{error}</span>
          </>
        ) : null}
      </p>
    </>
  );
}

const LTR_TYPES = new Set(["tel", "email", "url", "number"]);
const LTR_MODES = new Set(["tel", "numeric", "decimal", "email", "url"]);

/* ───────────────────────────── TextField ───────────────────────────── */
export type TextFieldProps = FieldCommon &
  Omit<ComponentPropsWithRef<"input">, "className" | "required"> & {
    /** Force left-to-right (codes, references). Default: on for tel, email, url, number and numeric input modes. */
    ltr?: boolean;
    /** Something at the inline end inside the field (a unit, a small key). Reserve space with `inputClassName`. */
    end?: ReactNode;
    inputClassName?: string;
  };

export function TextField({ label, hint, error, required, optional, hideLabel, className, id, ltr, end, inputClassName, type = "text", inputMode, ...input }: TextFieldProps) {
  const ids = useFieldIds(id, hint, error);
  const isLtr = ltr ?? (LTR_TYPES.has(type) || (inputMode !== undefined && LTR_MODES.has(inputMode)));
  return (
    <div className={cx("field", className)} data-invalid={error ? "" : undefined}>
      <FieldLabel htmlFor={ids.id} label={label} required={required} optional={optional} hideLabel={hideLabel} />
      <div className="field__control">
        <input
          {...input}
          id={ids.id}
          type={type}
          inputMode={inputMode}
          dir={isLtr ? "ltr" : undefined}
          className={cx("field__input", inputClassName)}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={cx(ids.describedBy, input["aria-describedby"]) || undefined}
          data-end={end ? "" : undefined}
        />
        {end ? <span className="field__end">{end}</span> : null}
      </div>
      <FieldMessages hintId={ids.hintId} hint={hint} errorId={ids.errorId} error={error} />
    </div>
  );
}

/* ───────────────────────────── TextArea ───────────────────────────── */
export type TextAreaProps = FieldCommon & Omit<ComponentPropsWithRef<"textarea">, "className" | "required"> & { inputClassName?: string };

export function TextArea({ label, hint, error, required, optional, hideLabel, className, id, inputClassName, ...area }: TextAreaProps) {
  const ids = useFieldIds(id, hint, error);
  return (
    <div className={cx("field", className)} data-invalid={error ? "" : undefined}>
      <FieldLabel htmlFor={ids.id} label={label} required={required} optional={optional} hideLabel={hideLabel} />
      <textarea
        rows={3}
        {...area}
        id={ids.id}
        className={cx("field__input", inputClassName)}
        aria-invalid={error ? true : undefined}
        aria-required={required || undefined}
        aria-describedby={cx(ids.describedBy, area["aria-describedby"]) || undefined}
      />
      <FieldMessages hintId={ids.hintId} hint={hint} errorId={ids.errorId} error={error} />
    </div>
  );
}

/* ───────────────────────────── Select ───────────────────────────── */
export type SelectOption = { value: string; label: string; disabled?: boolean };
export type SelectProps = FieldCommon &
  Omit<ComponentPropsWithRef<"select">, "className" | "required"> & {
    options?: readonly SelectOption[];
    /** A first, unselectable option ("اختر"). */
    placeholder?: string;
    inputClassName?: string;
  };

export function Select({ label, hint, error, required, optional, hideLabel, className, id, options, placeholder, inputClassName, children, ...select }: SelectProps) {
  const ids = useFieldIds(id, hint, error);
  const hasValue = select.value !== undefined || select.defaultValue !== undefined;
  return (
    <div className={cx("field", className)} data-invalid={error ? "" : undefined}>
      <FieldLabel htmlFor={ids.id} label={label} required={required} optional={optional} hideLabel={hideLabel} />
      <div className="field__control">
        <select
          {...select}
          defaultValue={hasValue ? select.defaultValue : placeholder !== undefined ? "" : undefined}
          id={ids.id}
          className={cx("field__input", inputClassName)}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          aria-describedby={cx(ids.describedBy, select["aria-describedby"]) || undefined}
        >
          {placeholder !== undefined ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options?.map((option) => (
            <option key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </option>
          ))}
          {children}
        </select>
        <Icon name="caret-down" size={20} className="field__caret" />
      </div>
      <FieldMessages hintId={ids.hintId} hint={hint} errorId={ids.errorId} error={error} />
    </div>
  );
}

/* ───────────────────────────── Checkbox / Radio / Switch ───────────────────────────── */
type ChoiceProps = Omit<ComponentPropsWithRef<"input">, "type" | "className"> & {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  className?: string;
};

/*
 * A disabled choice that is checked keeps its mark (a reviewer reads what a role grants without being able to change
 * it): the stylesheet's disabled box (a --niche fill, a --line border) outweighs the checked one and hid the paper
 * check — restated here, after it: an --ink-3 fill (checkbox) or ring (radio), the mark in paper.
 */
const CHECKED_DISABLED_BOX =
  "peer-checked:peer-disabled:border-ink-3 peer-checked:peer-disabled:bg-ink-3 peer-indeterminate:peer-disabled:border-ink-3 peer-indeterminate:peer-disabled:bg-ink-3";
const CHECKED_DISABLED_RING = "peer-checked:peer-disabled:border-ink-3";

export type CheckboxProps = ChoiceProps & {
  indeterminate?: boolean;
  /** A count at the row's end (a filter value: «Nintendo  18»), in ink-2 tabular figures. */
  count?: number;
  /** Anything else at the row's end. */
  end?: ReactNode;
};

/** A paper box with a real border; checked = ink with a check. The whole row (≥ 44px) is the target. */
export function Checkbox({ label, hint, error, className, id, indeterminate = false, count, end, ...input }: CheckboxProps) {
  const ids = useFieldIds(id, hint, error);
  const f = useFormat();
  const ref = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <div className={cx("field", className)} data-invalid={error ? "" : undefined}>
      <label className="choice" data-invalid={error ? "" : undefined}>
        <input
          {...input}
          ref={(element) => {
            ref.current = element;
            const forwarded = input.ref;
            if (typeof forwarded === "function") forwarded(element);
            else if (forwarded) forwarded.current = element;
          }}
          id={ids.id}
          type="checkbox"
          className="choice__input peer"
          aria-invalid={error ? true : undefined}
          aria-describedby={cx(ids.describedBy, input["aria-describedby"]) || undefined}
        />
        <span className={cx("choice__box", CHECKED_DISABLED_BOX)} aria-hidden="true">
          <Icon name={indeterminate ? "minus" : "check"} size={16} />
        </span>
        <span className="choice__text">{label}</span>
        {typeof count === "number" && Number.isFinite(count) ? (
          <span className="choice__end type-xs text-ink-2 nums">
            <bdi>{f.number(count)}</bdi>
          </span>
        ) : end ? (
          <span className="choice__end">{end}</span>
        ) : null}
      </label>
      <FieldMessages hintId={ids.hintId} hint={hint} errorId={ids.errorId} error={error} />
    </div>
  );
}

export type RadioProps = ChoiceProps & {
  /** An option row (§9.8): a paper row with a border, a title and a line of explanation (`hint`). */
  row?: boolean;
  /** Something at the inline end of an option row (a fee, a balance). */
  end?: ReactNode;
};

/** One radio. Group them in a <FieldGroup> with the same `name`; arrow keys are native. */
export function Radio({ label, hint, error, className, id, row = false, end, ...input }: RadioProps) {
  const ids = useFieldIds(id, hint, error);
  return (
    <label className={cx("choice choice--radio", row && "choice--row", className)} data-invalid={error ? "" : undefined}>
      <input
        {...input}
        id={ids.id}
        type="radio"
        className="choice__input peer"
        aria-describedby={cx(ids.describedBy, input["aria-describedby"]) || undefined}
      />
      <span className={cx("choice__box", CHECKED_DISABLED_RING)} aria-hidden="true" />
      <span className="choice__text">
        <span>{label}</span>
        {hint ? (
          <span className="choice__hint" id={ids.hintId}>
            {hint}
          </span>
        ) : null}
      </span>
      {/* the option's own price keeps «667,500 د.ع» on one line (a price wraps its currency by default) */}
      {end ? <span className="choice__end [&_.price]:flex-nowrap">{end}</span> : null}
    </label>
  );
}

export type SwitchProps = ChoiceProps;

/** An on/off setting that applies at once (not a form choice — use a Checkbox for that). role="switch". */
export function Switch({ label, hint, error, className, id, ...input }: SwitchProps) {
  const ids = useFieldIds(id, hint, error);
  return (
    <div className={cx("field", className)} data-invalid={error ? "" : undefined}>
      <label className="choice choice--switch">
        <span className="choice__text">{label}</span>
        <input
          {...input}
          id={ids.id}
          type="checkbox"
          role="switch"
          className="choice__input"
          aria-describedby={cx(ids.describedBy, input["aria-describedby"]) || undefined}
        />
        <span className="switch__track" aria-hidden="true">
          <span className="switch__knob" />
        </span>
      </label>
      <FieldMessages hintId={ids.hintId} hint={hint} errorId={ids.errorId} error={error} />
    </div>
  );
}

/* ───────────────────────────── OptionCard ───────────────────────────── */
export type OptionCardProps = Omit<RadioProps, "row"> & {
  /** A payment option: 72px, a 22px radio, a 16/600 title. */
  pay?: boolean;
  /** Words in the 40×28 mark area at the end (a payment method's name — no unlicensed logos). */
  mark?: string;
};

/**
 * An option card — v2 §4.9: min 64 (payment 72), --r-sm, a 1px control boundary; a radio at the start; a title and one
 * hint line; at the end the option's own price (`end={<Price … size="sm" as="span" />}`) or a word mark. Chosen: a 2px
 * ink border and the filled radio. Group them in a <FieldGroup> whose legend repeats the choice («النسخة · الدولية»).
 *
 *   <OptionCard name="version" value="intl" label={t("intl")} hint={t("intlHint")} end={<Price amountIqd={667750} size="sm" as="span" approx="off" />} />
 *   <OptionCard pay name="pay" value="cod" label={t("cod")} hint={t("codHint")} mark={t("cash")} />
 */
export function OptionCard({ pay = false, mark, end, className, ...radio }: OptionCardProps) {
  return <Radio {...radio} row className={cx(pay && "choice--pay", className)} end={end ?? (mark ? <span className="choice__mark">{mark}</span> : undefined)} />;
}

/* ───────────────────────────── FormErrorSummary ───────────────────────────── */
export type FormError = { id: string; label: ReactNode };

/**
 * The error summary above a form on submit — v2 §4.9: one `role="alert"` block («تحقّق من حقلين: رقم الموبايل، العنوان.»)
 * whose items link to the fields. Move focus to the first invalid field yourself (the summary is announced). Nothing
 * when there is no error.
 */
export function FormErrorSummary({ errors, className }: { errors: readonly FormError[]; className?: string }) {
  const t = useT("ui");
  if (errors.length === 0) return null;
  return (
    <div role="alert" className={cx("form-alert", className)}>
      <p className="flex items-start gap-1.5">
        <Icon name="warning-circle" size={20} />
        <span>{t("field.summary", { count: errors.length })}</span>
      </p>
      <ul className="grid ps-7">
        {errors.map((error) => (
          <li key={error.id}>
            {/* 44px rows: each link is a target of its own, not a word inside a sentence */}
            <a href={`#${error.id}`} className="inline-flex min-h-11 items-center">
              {error.label}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────────────────────── FieldGroup ───────────────────────────── */
export type FieldGroupProps = {
  legend: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  optional?: boolean;
  /** Lay the children out as a column of option rows (default) or a wrapping row. */
  layout?: "column" | "row";
  /** The fieldset's id — what an error summary item links to (`<FormErrorSummary errors={[{ id, label }]} />`). */
  id?: string;
  className?: string;
  children: ReactNode;
};

/** A <fieldset> with a legend, help and an error for a set of radios, checkboxes or chips. */
export function FieldGroup({ legend, hint, error, required, optional, layout = "column", id, className, children }: FieldGroupProps) {
  const ids = useFieldIds(id, hint, error);
  return (
    <fieldset id={id} className={cx("field field--group", className)} data-invalid={error ? "" : undefined} aria-describedby={ids.describedBy}>
      <FieldLabel as="legend" label={legend} required={required} optional={optional} />
      <div className={cx("field__options", layout === "row" && "field__options--row")}>{children}</div>
      <FieldMessages hintId={ids.hintId} hint={hint} errorId={ids.errorId} error={error} />
    </fieldset>
  );
}
