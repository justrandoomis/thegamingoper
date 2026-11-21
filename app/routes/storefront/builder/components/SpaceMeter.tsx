/**
 * The space bar (docs/switch-builder.md §3, §6.4): the console's memory and the card together, as the console shows
 * them — what the chosen games use, what is kept free (saves, screenshots and system updates in the console's memory;
 * future game updates on the card) and what is left. `role="meter"` with the figures in words for screen readers.
 *
 * The fill grows from the reading start by `scale` (transform only, the `settle` spring; never its width) and its
 * colour changes at once: ink while there is room, --warn from 90 % used, --danger when the plan is over its space
 * (after a smaller card was chosen) — never brand red, and always with words. Nothing moves at rest.
 *
 * While the plan's games are known but not their sizes (TamTam's data is still on its way, or did not come), the
 * figures that depend on them are not drawn — no fill, «نحمّل الأحجام…» in place of what is left, a dash for what is
 * used — never a false «0 GB used». What is kept free depends only on the console and the card: it stays.
 *
 * The over-full sentence is plain content, not a live region: a region inserted with its words is not read, and where
 * the memory step's note says it too it would be said twice. The page says a change that makes the plan over-full
 * once, through the shared live region (BuilderPage).
 *
 *   <SpaceMeter usage={…} />                       the full meter (the games step, the aside)
 *   <SpaceMeter usage={…} figures="loading" />      the games' sizes are on their way
 *   <SpaceMeter usage={…} compact decorative />     one line for the task bar: the bar and «يبقى 182.4 GB» (over the
 *                                                  space: «أكبر من المساحة بـ 63.6 GB», short enough for a 320 bar) —
 *                                                  a second copy on screen, so hidden from screen readers
 */
import type { CSSProperties, ReactNode } from "react";

import { useFormat } from "~/i18n/react";
import type { PlanUsage } from "~/lib/switch-builder/plan";
import { toGiB } from "~/lib/switch-builder/storage";
import { NumberMorph } from "~/motion";
import { cx } from "~/ui/cx";
import { gbText, shortfallText, useBuilderT } from "../lib/format";

export type MeterTone = "ok" | "warn" | "over";

/** Whether the figures can be drawn: "loading" — the games' sizes are on their way; "unknown" — they did not load. */
export type MeterFigures = "known" | "loading" | "unknown";

/** The bar's colour: room left · nearly full (90 % or more of the space used) · over the space. Pure. */
export function meterTone({ usage }: PlanUsage): MeterTone {
  if (usage.overBytes > 0) return "over";
  if (usage.plannableBytes <= 0) return usage.usedBytes > 0 ? "over" : "warn";
  return usage.usedBytes / usage.plannableBytes >= 0.9 ? "warn" : "ok";
}

/** The bar's parts as shares of what the console shows as usable (memory + card): used, and kept free at the end. */
export function meterShares({ capacity, usage }: PlanUsage): { used: number; kept: number } {
  const total = capacity.internalBytes + capacity.cardBytes;
  if (total <= 0) return { used: 0, kept: 0 };
  const kept = Math.min(1, (capacity.internalReserveBytes + capacity.cardHeadroomBytes) / total);
  return { used: Math.min(1, usage.usedBytes / total), kept };
}

export type SpaceMeterProps = {
  usage: PlanUsage;
  compact?: boolean;
  /** "known" (default) · "loading" · "unknown": the figures that depend on the games' sizes are drawn only when known. */
  figures?: MeterFigures;
  /** A second copy on screen (the task bar's, under the games step's own meter): hidden from screen readers. */
  decorative?: boolean;
  /** The guide's target name on this copy (`data-tour`), when it is the one the shopper sees. */
  tour?: string;
  /** Under an over-full bar: the way to a bigger card. */
  action?: ReactNode;
  className?: string;
};

export function SpaceMeter({ usage, compact = false, figures = "known", decorative = false, tour, action, className }: SpaceMeterProps) {
  const t = useBuilderT();
  const f = useFormat();
  const known = figures === "known";
  const tone = known ? meterTone(usage) : "ok";
  const shares = meterShares(usage);
  const { capacity, usage: use } = usage;
  const kept = capacity.internalReserveBytes + capacity.cardHeadroomBytes;
  const gb = (bytes: number) => gbText(f, bytes);
  const over = shortfallText(f, use.usedBytes, use.plannableBytes);
  const overText = t("meter.over", { over });
  // short, so the head keeps its one line in the 320px aside (no jump when the figures arrive)
  const waiting = t(figures === "loading" ? "meter.loading" : "meter.unknown");
  const leftWords = known ? (
    <NumberMorph
      value={toGiB(use.remainingBytes)}
      format={(value) => t("meter.left", { left: gbText(f, value * 1024 ** 3) })}
      className="nums"
    />
  ) : (
    waiting
  );
  // a meter only when its figures are known and this is the copy that is read; otherwise a drawing of the bar
  const role = known && !decorative ? { role: "meter", "aria-label": t("meter.label"), "aria-valuemin": 0, "aria-valuemax": toGiB(use.plannableBytes), "aria-valuenow": Math.min(toGiB(use.usedBytes), toGiB(use.plannableBytes)), "aria-valuetext": t("meter.valueText", { used: gb(use.usedBytes), plannable: gb(use.plannableBytes), left: gb(use.remainingBytes) }) } : { "aria-hidden": true };
  const bar = (
    <div {...role} className="sb-meter__bar" style={{ "--sb-used": known ? shares.used : 0, "--sb-kept": shares.kept } as CSSProperties}>
      <span className="sb-meter__kept" />
      <span className="sb-meter__fill" />
    </div>
  );
  const state = known ? undefined : figures;
  if (compact) {
    return (
      <div className={cx("sb-meter sb-meter--compact", className)} data-tone={tone} data-state={state} aria-hidden={decorative || undefined} {...(tour ? { "data-tour": tour } : {})}>
        {bar}
        <span className="sb-meter__left">{known && tone === "over" ? t("meter.overShort", { over }) : leftWords}</span>
      </div>
    );
  }
  return (
    <div className={cx("sb-meter", className)} data-tone={tone} data-state={state} aria-hidden={decorative || undefined} aria-busy={figures === "loading" || undefined} {...(tour ? { "data-tour": tour } : {})}>
      <div className="sb-meter__head">
        <span className="sb-meter__label">{t("meter.label")}</span>
        <span className="sb-meter__left">{leftWords}</span>
      </div>
      {bar}
      {/* the bar's legend: each part's swatch beside its words (they wrap as whole items, never a stray separator) */}
      <p className="sb-meter__legend">
        <span className="sb-meter__key nums">
          <span className="sb-meter__swatch" aria-hidden="true" />
          {known ? (
            t("meter.used", { used: gb(use.usedBytes) })
          ) : (
            // what the games use is not known yet: a dash, not a false «0 GB» (the words above say why)
            <span aria-hidden="true">{t("meter.used", { used: "—" })}</span>
          )}
        </span>
        <span className="sb-meter__key nums">
          <span className="sb-meter__swatch sb-meter__swatch--kept" aria-hidden="true" />
          {t("meter.kept", { kept: gb(kept) })}
        </span>
      </p>
      {!known ? null : tone === "over" ? (
        <div className="sb-meter__over">
          <p>
            <b>{overText}</b> {t("meter.overHint")}
          </p>
          {action}
        </div>
      ) : use.remainingBytes === 0 && use.usedBytes > 0 ? (
        <p className="sb-meter__full">{t("meter.full")}</p>
      ) : null}
    </div>
  );
}
