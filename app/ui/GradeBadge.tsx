import { useEffect, useId, useRef, type ToggleEvent } from "react";

import { useT } from "~/i18n/react";
import type { UsedGrade } from "~/lib/dto";
import { cx } from "./cx";
import { IconKey } from "./IconKey";
import { Tag } from "./Tag";

/**
 * The condition grade of a used unit (docs/DESIGN.md §9.12, §9.20): an OUTLINED tag (used is never solid) with the
 * grade in words and its letter — "مستعمل · ممتاز (A)". Shape, not colour, separates it from "new".
 *
 *   <GradeBadge grade="A" />            in a card's tag zone (no legend: a card is one link)
 *   <GradeBadge grade="B" legend />     product page / inspection card: an info key opens the legend of all grades
 *
 * The legend is a native popover (light dismiss, Escape, no script needed to open it). It is placed under its key
 * when it opens; without script it shows centred. The grade wording is the store's policy text — keep it in step
 * with the inspection templates (admin).
 */
export const GRADES: readonly UsedGrade[] = ["A+", "A", "B", "C"];

export type GradeKey = "aplus" | "a" | "b" | "c";

/** Message key for a grade ("A+" → "aplus"). Unknown values read as the lowest grade, never as a better one. */
export function gradeKey(grade: string): GradeKey {
  switch (grade) {
    case "A+":
      return "aplus";
    case "A":
      return "a";
    case "B":
      return "b";
    default:
      return "c";
  }
}

export type GradeBadgeProps = {
  grade: UsedGrade;
  /** Show the info key that opens the legend of all grades. Never inside a card link. */
  legend?: boolean;
  className?: string;
};

export function GradeBadge({ grade, legend = false, className }: GradeBadgeProps) {
  const t = useT("ui-shop");
  const id = `grade-legend-${useId().replace(/[^\w-]/g, "")}`;
  const trigger = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);

  // A fixed popover does not follow its key when the page moves: close it instead of letting it float away.
  useEffect(() => {
    if (!legend) return;
    const close = () => {
      const el = popover.current;
      if (el?.matches(":popover-open")) el.hidePopover();
    };
    window.addEventListener("scroll", close, { passive: true });
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close);
      window.removeEventListener("resize", close);
    };
  }, [legend]);

  const place = (event: ToggleEvent<HTMLDivElement>) => {
    if (event.newState !== "open" || !trigger.current) return;
    const el = event.currentTarget;
    const anchor = trigger.current.getBoundingClientRect();
    const rtl = getComputedStyle(trigger.current).direction === "rtl";
    const viewW = document.documentElement.clientWidth;
    const viewH = window.innerHeight;
    el.style.margin = "0";
    el.style.inset = "auto";
    const { offsetWidth: width, offsetHeight: height } = el;
    // Start edge under the key's start edge, kept 8px inside the viewport; below it, or above when there is no room.
    const fromStart = rtl ? viewW - anchor.right : anchor.left;
    const inlineStart = Math.max(8, Math.min(fromStart, viewW - width - 8));
    const below = anchor.bottom + 8;
    const top = below + height > viewH - 8 ? Math.max(8, anchor.top - 8 - height) : below;
    el.style.insetBlockStart = `${Math.round(top)}px`;
    el.style.insetInlineStart = `${Math.round(inlineStart)}px`;
  };

  const tag = <GradeTag grade={grade} />;
  if (!legend) return <span className={cx("inline-flex", className)}>{tag}</span>;
  return (
    <span className={cx("inline-flex items-center gap-1", className)}>
      {tag}
      <IconKey ref={trigger} icon="info" label={t("grade.legend")} size="sm" variant="quiet" popoverTarget={id} aria-haspopup="dialog" />
      <div
        id={id}
        ref={popover}
        popover="auto"
        role="dialog"
        aria-label={t("grade.legendTitle")}
        onToggle={place}
        className="max-w-[min(22rem,calc(100vw-1rem))] rounded-md bg-paper p-4 text-ink shadow-e4"
      >
        <p className="type-label font-semibold">{t("grade.legendTitle")}</p>
        <dl className="mt-3 grid gap-3">
          {GRADES.map((g) => (
            <div key={g} className="grid justify-items-start gap-1">
              <dt>
                <GradeTag grade={g} />
              </dt>
              <dd className="type-caption text-ink-2">{t(`grade.hints.${gradeKey(g)}`)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 border-t border-line pt-3 type-caption text-ink-2">{t("grade.legendNote")}</p>
      </div>
    </span>
  );
}

/** The outlined tag alone: "مستعمل · ممتاز (A)". */
export function GradeTag({ grade, className }: { grade: UsedGrade; className?: string }) {
  const t = useT("ui-shop");
  return (
    <Tag
      kind="used"
      className={className}
      detail={
        <>
          {t(`grade.words.${gradeKey(grade)}`)} <bdi>({grade})</bdi>
        </>
      }
    />
  );
}
