import { useEffect, useId, useRef, type ToggleEvent } from "react";

import { useT } from "~/i18n/react";
import type { UsedGrade } from "~/lib/dto";
import { cx } from "./cx";
import { IconKey } from "./IconKey";
import { Tag } from "./Tag";

/**
 * The condition grade of a used unit — Design System v2 §4.7, §4.12: an OUTLINED pill (1.5px ink) with the grade and its
 * word — «A+ · كالجديد» (the grade isolated left-to-right). Shape, not colour, separates it from «جديد».
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
    el.style.margin = "0";
    el.style.inset = "auto";
    el.style.maxBlockSize = "";
    el.style.overflowY = "";
    const { offsetWidth: width, offsetHeight: height } = el;
    // Start edge under the key's start edge, kept 8px inside the viewport. The free band is the viewport minus what the
    // shell fixes at the top (the header) and at the bottom (the tab bar or a page's buy bar — fix round 2026-11-13: the
    // legend ran over «أضف إلى السلة» at 390): below the key, or above it, or — when neither side holds it — the larger
    // side, scrolling inside.
    const fromStart = rtl ? viewW - anchor.right : anchor.left;
    const inlineStart = Math.max(8, Math.min(fromStart, viewW - width - 8));
    const band = popoverBand(window.innerHeight);
    el.style.insetBlockStart = `${Math.round(placeBlock(anchor, height, band, el))}px`;
    el.style.insetInlineStart = `${Math.round(inlineStart)}px`;
  };

  const tag = <GradeTag grade={grade} />;
  if (!legend) return <span className={cx("inline-flex", className)}>{tag}</span>;
  return (
    <span className={cx("inline-flex items-center gap-1", className)}>
      {tag}
      <IconKey ref={trigger} icon="info" label={t("grade.legend")} size="sm" variant="plain" popoverTarget={id} aria-haspopup="dialog" />
      <div
        id={id}
        ref={popover}
        popover="auto"
        role="dialog"
        aria-label={t("grade.legendTitle")}
        onToggle={place}
        className="max-w-[min(22rem,calc(100vw-1rem))] rounded-lg bg-paper p-4 text-ink shadow-overlay"
      >
        <p className="type-sm-strong">{t("grade.legendTitle")}</p>
        {/* G7: what each grade means is reading text — 16px on phones, 14px from 1024 (fix round 2026-11-13) */}
        <dl className="mt-3 grid gap-3">
          {GRADES.map((g) => (
            <div key={g} className="grid justify-items-start gap-1">
              <dt>
                <GradeTag grade={g} />
              </dt>
              <dd className="type-read text-ink-2 lg:type-sm">{t(`grade.hints.${gradeKey(g)}`)}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-3 border-t border-line pt-3 type-sm text-ink-2">{t("grade.legendNote")}</p>
      </div>
    </span>
  );
}

/** The viewport's free band for a floating panel: under the shell's fixed top (--shell-top) and above its fixed bottom
 *  (--shell-bottom: the tab bar or a page's buy bar), 8px inside each. Both read through a probe, so calc() and the
 *  safe areas resolve; a page without the shell gets the whole viewport. */
function popoverBand(viewH: number): { top: number; bottom: number } {
  const measure = (property: string) => {
    const probe = document.createElement("div");
    probe.style.cssText = `position:fixed;inset-inline:0;top:0;block-size:var(${property}, 0px);visibility:hidden;pointer-events:none`;
    document.body.appendChild(probe);
    const size = probe.getBoundingClientRect().height;
    probe.remove();
    return Number.isFinite(size) ? size : 0;
  };
  return { top: measure("--shell-top") + 8, bottom: viewH - measure("--shell-bottom") - 8 };
}

/** Where the panel's top goes (pure but for the overflow it may set): below the key, or above, or the roomier side. */
function placeBlock(anchor: DOMRect, height: number, band: { top: number; bottom: number }, el: HTMLElement): number {
  const below = anchor.bottom + 8;
  const roomBelow = band.bottom - below;
  const roomAbove = anchor.top - 8 - band.top;
  if (height <= roomBelow) return below;
  if (height <= roomAbove) return anchor.top - 8 - height;
  const room = Math.max(160, Math.max(roomBelow, roomAbove));
  el.style.maxBlockSize = `${Math.round(room)}px`;
  el.style.overflowY = "auto";
  return roomBelow >= roomAbove ? below : Math.max(band.top, anchor.top - 8 - room);
}

/** The outlined pill alone: «A+ · كالجديد» (the grade first, isolated left-to-right; its word after it). */
export function GradeTag({ grade, className }: { grade: UsedGrade; className?: string }) {
  const t = useT("ui-shop");
  return (
    <Tag kind="grade" className={className}>
      <bdi dir="ltr">{grade}</bdi> · {t(`grade.words.${gradeKey(grade)}`)}
    </Tag>
  );
}
