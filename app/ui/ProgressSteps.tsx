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
 *   <ProgressSteps variant="status" … />       where a thing IS, not a task to do (an order: استلمنا · تأكيد · تجهيز ·
 *                                              في الطريق · تم التسليم) — labels under the discs, the current step in INK
 *                                              (an ink disc with a paper core; red is an action's colour), no links;
 *                                              `current` past the last step: everything done
 *
 * Every step is a 44px target (a done step's link included, in the compact rail too). More than three steps on a phone:
 * only the current step keeps its words on screen (the others stay readable for assistive technology), the joins and
 * gaps shrink, an item is never narrower than what it holds and the current label may take a second line — five steps
 * fit 320–390px in every language; under 360px the other discs are drawn 32px wide (a done link keeps a 44px hit area).
 *
 * Fixed chrome: it does not move when the step changes (the content below pushes sideways).
 */
export type ProgressStep = {
  label: string;
  /** Where a done step links back to (locale-less path). Not in the status rail. */
  href?: string;
};

export type ProgressStepsProps = {
  steps: readonly ProgressStep[];
  /** 0-based index of the current step (the status rail: `steps.length` = all done). */
  current: number;
  /** full (labels beside the numbers) · compact (the checkout bar) · status (where an order is; labels under). */
  variant?: "full" | "compact" | "status";
  "aria-label"?: string;
  className?: string;
};

export function ProgressSteps({ steps, current, variant = "full", className, ...rest }: ProgressStepsProps) {
  const t = useT("ui-overlays");
  const f = useFormat();
  if (variant === "status") return <StatusRail steps={steps} current={current} label={rest["aria-label"] ?? t("steps.label")} className={className} />;
  const many = steps.length > 3;
  return (
    <nav aria-label={rest["aria-label"] ?? t("steps.label")} className={cx("min-w-0", className)}>
      <ol className={cx("steps", variant === "compact" && "steps--compact", many && "max-md:gap-1")}>
        {steps.map((step, index) => {
          const state = index < current ? "done" : index === current ? "current" : "upcoming";
          // a 44px target whatever the step shows (a disc alone on phones and in the compact bar); under 360px the
          // discs of a long rail are 32px wide and a done link's ::after keeps its 44px hit area
          // (the current step is no target: it may shrink, its words wrapping, rather than push the rail off the screen)
          const box = cx(
            "relative",
            state !== "current" && "min-w-11 justify-center",
            many && state !== "current" && "max-[22.49rem]:min-w-8 max-[22.49rem]:after:absolute max-[22.49rem]:after:inset-y-0 max-[22.49rem]:after:-inset-x-1.5 max-[22.49rem]:after:content-['']",
          );
          const body = (
            <>
              <span className="step__n" aria-hidden="true">
                {state === "done" ? <Icon name="check" size={16} /> : f.number(index + 1)}
              </span>
              {/* more than three steps do not fit a phone: there only the current step keeps its words on screen, and
                  they may take a second line rather than be cut */}
              <span
                className={cx(
                  "step__label",
                  many && state !== "current" && "max-md:sr-only",
                  // between words only, never inside one (a list item's overflow-wrap would cut «التقدير» in two)
                  state === "current" && "min-w-0 whitespace-normal [overflow-wrap:normal]",
                )}
              >
                <BidiLabel>{step.label}</BidiLabel>
                {state === "done" ? <VisuallyHidden>{` (${t("steps.done")})`}</VisuallyHidden> : null}
              </span>
              {variant === "compact" && state !== "current" ? <VisuallyHidden>{step.label}</VisuallyHidden> : null}
            </>
          );
          return (
            <li
              key={`${index}:${step.label}`}
              className={cx("flex items-center gap-2", index > 0 && "flex-1", state === "current" ? "min-w-min" : many ? "min-w-0 max-md:min-w-min" : "min-w-0", many && "max-md:gap-1")}
            >
              {index > 0 ? <span className={cx("step__sep", many && "max-md:min-w-1")} aria-hidden="true" /> : null}
              {state === "done" && step.href ? (
                <LocaleLink to={step.href} className={cx("step", box, many && "max-md:gap-1")} data-state="done" data-press="soft">
                  {body}
                </LocaleLink>
              ) : (
                <span
                  className={cx("step", box, many && "max-md:gap-1", state === "current" && "min-w-0")}
                  data-state={state}
                  aria-current={state === "current" ? "step" : undefined}
                >
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

/**
 * The status rail: discs on one line joined by a 2px rule (ink between done steps), each label centred under its disc.
 * Done = an ink disc with a check; current = an ink disc with a paper core (never colour alone: the core and the 600
 * label); upcoming = a control-line ring. An ordered list (`aria-current="step"` on the current one), no links.
 */
function StatusRail({ steps, current, label, className }: { steps: readonly ProgressStep[]; current: number; label: string; className?: string }) {
  const t = useT("ui-overlays");
  return (
    <ol aria-label={label} className={cx("grid", className)} style={{ gridTemplateColumns: `repeat(${Math.max(1, steps.length)}, minmax(0, 1fr))` }}>
      {steps.map((step, index) => {
        const state = index < current ? "done" : index === current ? "current" : "upcoming";
        const reached = state !== "upcoming";
        return (
          <li
            key={`${index}:${step.label}`}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
            className={cx(
              "relative grid min-w-0 content-start justify-items-center gap-2 text-center",
              // the rule from the previous disc's centre to this one's (ink when both are reached)
              index > 0 &&
                "before:absolute before:top-[11px] before:end-[calc(50%+14px)] before:h-0.5 before:w-[calc(100%-28px)] before:rounded-full before:bg-line-strong before:content-['']",
              index > 0 && reached && "before:bg-ink",
            )}
          >
            <span
              aria-hidden="true"
              className={cx(
                "grid size-6 place-items-center rounded-full border-2 text-paper",
                reached ? "border-ink bg-ink" : "border-line-strong bg-paper",
              )}
            >
              {state === "done" ? <Icon name="check" size={14} /> : state === "current" ? <span className="size-2 rounded-full bg-paper" /> : null}
            </span>
            <span className={cx("min-w-0 [overflow-wrap:anywhere]", state === "current" ? "type-xs-strong text-ink" : state === "done" ? "type-xs text-ink" : "type-xs text-ink-2")}>
              <BidiLabel>{step.label}</BidiLabel>
              {state === "done" ? <VisuallyHidden>{` (${t("steps.done")})`}</VisuallyHidden> : null}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
