import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * ProgressSteps — the step rail of checkout (العنوان، الدفع، المراجعة) and the trade-in wizard (الجهاز، الحالة،
 * الصور، التقدير، الفحص), DESIGN.md §9.17. Numbered discs with text labels, joined by a line:
 *
 *   done      an ink disc with a check; with `href` it is a link back (every field keeps its value)
 *   current   an ink ring and a bold label — `aria-current="step"`
 *   upcoming  a line-strong ring and an ink-2 label
 *
 *   <ProgressSteps current={1} steps={[{ label: t("address"), href: "/checkout/address" }, { label: t("payment") }, { label: t("review") }]} />
 *
 * Fixed chrome: it does not move when the step changes (the content below pushes sideways). Equal columns, so five
 * steps fit a 360px phone; labels wrap between words, never inside one (a long word may run past its column).
 */
export type ProgressStep = {
  label: string;
  /** Where a done step links back to (locale-less path). */
  href?: string;
};

export type ProgressStepsProps = {
  steps: readonly ProgressStep[];
  /** 0-based index of the current step. */
  current: number;
  "aria-label"?: string;
  className?: string;
};

export function ProgressSteps({ steps, current, className, ...rest }: ProgressStepsProps) {
  const t = useT("ui-overlays");
  const f = useFormat();
  return (
    <nav aria-label={rest["aria-label"] ?? t("steps.label")} className={cx("min-w-0", className)}>
      <ol className="grid" style={{ gridTemplateColumns: `repeat(${Math.max(steps.length, 1)}, minmax(0, 1fr))` }}>
        {steps.map((step, index) => {
          const state = index < current ? "done" : index === current ? "current" : "upcoming";
          const body = (
            <>
              <span
                className={cx(
                  "grid size-8 shrink-0 place-items-center rounded-full text-[13px] font-semibold nums",
                  state === "done" && "bg-sel text-on-sel",
                  state === "current" && "border-2 border-ink text-ink",
                  state === "upcoming" && "border-[1.5px] border-line-strong text-ink-2",
                )}
                aria-hidden="true"
              >
                {state === "done" ? <Icon name="check" size={16} /> : f.number(index + 1)}
              </span>
              <span className={cx("text-center type-caption [overflow-wrap:normal]", state === "current" ? "font-semibold text-ink" : state === "done" ? "text-ink" : "text-ink-2")}>
                <bdi>{step.label}</bdi>
                {state === "done" ? <VisuallyHidden>{` (${t("steps.done")})`}</VisuallyHidden> : null}
              </span>
            </>
          );
          return (
            <li
              key={`${index}:${step.label}`}
              aria-current={state === "current" ? "step" : undefined}
              className={cx(
                "relative flex min-w-0 flex-col items-center",
                // the line back to the previous disc: from 20px outside this disc to 20px outside the other one
                index > 0 && "before:absolute before:end-[calc(50%+20px)] before:top-[22px] before:h-[1.5px] before:w-[calc(100%-40px)] before:rounded-full",
                index > 0 && (index <= current ? "before:bg-ink" : "before:bg-line-strong"),
              )}
            >
              {state === "done" && step.href ? (
                <LocaleLink to={step.href} className="flex min-h-11 max-w-full flex-col items-center gap-1.5 rounded-sm pt-1.5 hover:[&>span:last-child]:underline">
                  {body}
                </LocaleLink>
              ) : (
                <span className="flex max-w-full flex-col items-center gap-1.5 pt-1.5">{body}</span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
