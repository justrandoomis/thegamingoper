import { useId, useMemo, useRef, useState, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";
import { useControllable } from "./roving";
import { iqdText, isIqd } from "./PriceTag";
import { Sheet } from "./Sheet";

/**
 * The governorate picker — Design System v2 §4.9: looks like a select (52px, a caret at the end); it opens a picker
 * (a bottom sheet on phones, a centred dialog from 768) with 52px radio rows from the admin's governorate list and, at
 * the top, «التوصيل 5,000 د.ع لكل المحافظات» (the fee from settings). A filter field appears when the list is longer
 * than 12. Choosing closes it and returns focus to the field. `name` submits the id with a <Form>.
 *
 *   <GovernoratePicker label={t("governorate")} required name="governorateId" feeIqd={settings.deliveryFeeIqd}
 *                      governorates={govs} value={gov} onChange={setGov} error={errors.governorateId} />
 *
 * A governorate the store does not deliver to stays in the list with its reason («لا نوصل إليها الآن») and cannot be
 * chosen. The fee line says what is configured — no number is assumed.
 */
export type Governorate = { id: string; name: string; unserved?: boolean };

export type GovernoratePickerProps = {
  label: ReactNode;
  governorates: readonly Governorate[];
  value?: string | null;
  defaultValue?: string | null;
  onChange?: (id: string) => void;
  /** The delivery fee from settings, for the line at the top of the list. */
  feeIqd?: number | null;
  name?: string;
  required?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  /** Default «اختر المحافظة». */
  placeholder?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
};

export function GovernoratePicker({
  label,
  governorates,
  value,
  defaultValue = null,
  onChange,
  feeIqd = null,
  name,
  required = false,
  hint,
  error,
  placeholder,
  disabled = false,
  id,
  className,
}: GovernoratePickerProps) {
  const t = useT("ui-shop");
  const ui = useT("ui");
  const f = useFormat();
  const auto = useId();
  const base = id ?? auto;
  const [current, setCurrent] = useControllable(value, defaultValue, onChange);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const chosen = governorates.find((g) => g.id === current) ?? null;
  const hintId = hint && !error ? `${base}-hint` : undefined;
  const errorId = `${base}-error`;
  const shown = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase();
    return needle ? governorates.filter((g) => g.name.toLocaleLowerCase().includes(needle)) : governorates;
  }, [filter, governorates]);

  const choose = (next: Governorate) => {
    if (next.unserved) return;
    setCurrent(next.id);
    setOpen(false);
  };

  return (
    <div className={cx("field", className)} data-invalid={error ? "" : undefined}>
      <span className="field__label" id={`${base}-label`}>
        {label}
        {required ? (
          <>
            <span className="field__mark" aria-hidden="true">
              {" *"}
            </span>
            <span className="sr-only"> ({ui("required")})</span>
          </>
        ) : null}
      </span>
      <div className="field__control">
        <button
          ref={trigger}
          id={base}
          type="button"
          className={cx("field__input text-start", !chosen && "text-ink-2")}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-labelledby={`${base}-label ${base}`}
          aria-describedby={(error ? errorId : hintId) || undefined}
          aria-invalid={error ? true : undefined}
          aria-required={required || undefined}
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          {chosen ? chosen.name : (placeholder ?? t("governorate.choose"))}
        </button>
        <Icon name="caret-down" size={20} className="field__caret" />
      </div>
      {hint && !error ? (
        <p className="field__hint" id={hintId}>
          {hint}
        </p>
      ) : null}
      <p className="field__error" id={errorId} aria-live="polite">
        {error ? (
          <>
            <Icon name="warning-circle" size={16} />
            <span>{error}</span>
          </>
        ) : null}
      </p>
      {name ? <input type="hidden" name={name} value={current ?? ""} /> : null}
      <Sheet
        open={open}
        onClose={() => {
          setOpen(false);
          setFilter("");
        }}
        title={typeof label === "string" ? label : t("governorate.title")}
        presentation="picker"
        flush
      >
        {isIqd(feeIqd) ? (
          <p className="listrow__fee">{t("price.delivery", { price: "⁦" + iqdText(f, feeIqd) + "⁩" })}</p>
        ) : null}
        {governorates.length > 12 ? (
          <div className="px-4 py-3">
            <input
              type="search"
              className="field__input"
              placeholder={t("governorate.filter")}
              aria-label={t("governorate.filter")}
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              autoComplete="off"
            />
          </div>
        ) : null}
        <div role="radiogroup" aria-label={typeof label === "string" ? label : t("governorate.title")}>
          {shown.map((g) => (
            <label key={g.id} className={cx("listrow choice--radio", g.unserved && "text-ink-3")}>
              <input
                type="radio"
                className="choice__input"
                name={`${base}-choice`}
                value={g.id}
                checked={g.id === current}
                disabled={g.unserved}
                onChange={() => choose(g)}
                onClick={() => (g.id === current ? setOpen(false) : undefined)}
              />
              <span className="choice__box" aria-hidden="true" />
              <span className="min-w-0 flex-1">{g.name}</span>
              {g.unserved ? <span className="type-xs text-ink-2">{t("governorate.unserved")}</span> : null}
            </label>
          ))}
          {shown.length === 0 ? <p className="px-4 py-4 type-sm text-ink-2">{t("governorate.none")}</p> : null}
        </div>
      </Sheet>
    </div>
  );
}
