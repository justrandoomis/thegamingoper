import { useId, type ReactNode } from "react";

import { useT } from "~/i18n/react";
import { cx } from "./cx";

/**
 * The delivery-time preference — Design System v2 §4.9 (G8): OPTIONAL. 48px cells (--r-sm, a 1px control boundary, a 2px
 * ink border when chosen, 600 labels), two columns on phones and four from 600, as native radio groups (they submit
 * with a <Form>; arrows are native). The period: «أي وقت · صباحاً · بعد الظهر · مساءً». Day cells appear ONLY when the
 * owner has configured dispatch days in the admin (`days`) — until then the preference is the period alone, and no
 * day or date is offered. Under it, always: «وقت مفضّل وليس موعداً مؤكداً.» — never a promise.
 *
 *   <PreferencePicker name="period" value={period} onChange={setPeriod} />
 *   <PreferencePicker name="period" days={dispatchDays} dayName="day" dayValue={day} onDayChange={setDay} … />
 */
export const PERIODS = ["any", "morning", "afternoon", "evening"] as const;
export type Period = (typeof PERIODS)[number];

export type PreferencePickerProps = {
  /** Default «الوقت المفضّل للتوصيل (اختياري)». */
  legend?: ReactNode;
  name: string;
  value?: Period | null;
  defaultValue?: Period;
  onChange?: (period: Period) => void;
  /** Dispatch days configured by the owner (none → no day cells). */
  days?: readonly { value: string; label: string }[] | null;
  dayName?: string;
  dayValue?: string | null;
  onDayChange?: (day: string) => void;
  className?: string;
};

export function PreferencePicker({ legend, name, value, defaultValue = "any", onChange, days, dayName, dayValue, onDayChange, className }: PreferencePickerProps) {
  const t = useT("ui-shop");
  const hintId = useId();
  const controlled = value !== undefined;
  return (
    <fieldset className={cx("field field--group grid gap-3", className)} aria-describedby={hintId}>
      <legend className="field__label">
        {legend ?? (
          <>
            {t("preference.legend")} <span className="field__mark">{t("preference.optional")}</span>
          </>
        )}
      </legend>
      {days && days.length > 0 ? (
        <div className="pref" role="radiogroup" aria-label={t("preference.day")}>
          {days.map((day) => (
            <label key={day.value} className="pref__cell">
              <input
                type="radio"
                name={dayName ?? `${name}-day`}
                value={day.value}
                {...(dayValue !== undefined ? { checked: dayValue === day.value } : {})}
                onChange={() => onDayChange?.(day.value)}
              />
              {day.label}
            </label>
          ))}
        </div>
      ) : null}
      <div className="pref" role="radiogroup" aria-label={t("preference.period")}>
        {PERIODS.map((period) => (
          <label key={period} className="pref__cell">
            <input
              type="radio"
              name={name}
              value={period}
              {...(controlled ? { checked: value === period } : { defaultChecked: defaultValue === period })}
              onChange={() => onChange?.(period)}
            />
            {t(`preference.periods.${period}`)}
          </label>
        ))}
      </div>
      <p className="pref__hint" id={hintId}>
        {t("preference.note")}
      </p>
    </fieldset>
  );
}
