import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { BidiLabel } from "./BidiText";
import { cx } from "./cx";
import { VisuallyHidden } from "./VisuallyHidden";

/**
 * ProgressSteps — the step rail of checkout (التوصيل · الدفع · المراجعة) and the trade-in wizard, Design System v2
 * §4.22. Numbered discs with their labels, joined by a hairline:
 *
 *   done      an ink disc with a check; with `href` it is a link back (every field keeps its value)
 *   current   a RED disc with a white number and the label in ink 600 — `aria-current="step"`
 *   upcoming  a control-line ring and an ink-2 label
 *
 *   <ProgressSteps current={1} steps={[{ label: t("delivery"), href: "/checkout?step=delivery" }, { label: t("payment") }, { label: t("review") }]} />
 *   <ProgressSteps variant="compact" … />      inside the checkout bar: numbers, and the current step's label
 *
 * Fixed chrome: it does not move when the step changes (the content below pushes sideways).
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
  /** full (labels beside the numbers) · compact (the checkout bar). */
  variant?: "full" | "compact";
  "aria-label"?: string;
  className?: string;
};

export function ProgressSteps({ steps, current, variant = "full", className, ...rest }: ProgressStepsProps) {
  const t = useT("ui-overlays");
  const f = useFormat();
  // a step that is only its disc (phones, more than three steps) is still a 44px target
  const wide = variant === "full" ? "min-w-11 justify-center" : undefined;
  return (
    <nav aria-label={rest["aria-label"] ?? t("steps.label")} className={cx("min-w-0", className)}>
      <ol className={cx("steps", variant === "compact" && "steps--compact")}>
        {steps.map((step, index) => {
          const state = index < current ? "done" : index === current ? "current" : "upcoming";
          const body = (
            <>
              <span className="step__n" aria-hidden="true">
                {state === "done" ? <Icon name="check" size={16} /> : f.number(index + 1)}
              </span>
              {/* more than three steps do not fit a phone: there only the current step keeps its words on screen */}
              <span className={cx("step__label", steps.length > 3 && state !== "current" && "max-md:sr-only")}>
                <BidiLabel>{step.label}</BidiLabel>
                {state === "done" ? <VisuallyHidden>{` (${t("steps.done")})`}</VisuallyHidden> : null}
              </span>
              {variant === "compact" && state !== "current" ? <VisuallyHidden>{step.label}</VisuallyHidden> : null}
            </>
          );
          return (
            <li key={`${index}:${step.label}`} className={cx("flex min-w-0 items-center gap-2", index > 0 && "flex-1")}>
              {index > 0 ? <span className="step__sep" aria-hidden="true" /> : null}
              {state === "done" && step.href ? (
                <LocaleLink to={step.href} className={cx("step", wide)} data-state="done" data-press="soft">
                  {body}
                </LocaleLink>
              ) : (
                <span className={cx("step", wide)} data-state={state} aria-current={state === "current" ? "step" : undefined}>
                  {body}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
