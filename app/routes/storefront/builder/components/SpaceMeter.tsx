/**
 * The space bar (docs/switch-builder.md §3, §6.4): the console's memory and the card together, as the console shows
 * them — what the chosen games use, what is kept free (saves, screenshots and system updates in the console's memory;
 * future game updates on the card) and what is left. `role="meter"` with the figures in words for screen readers.
 *
 * The fill grows from the reading start by `scale` (transform only, the `settle` spring; never its width) and its
 * colour changes at once: ink while there is room, --warn from 90 % used, --danger when the plan is over its space
 * (after a smaller card was chosen) — never brand red, and always with words. Nothing moves at rest.
 *
 *   <SpaceMeter usage={…} />                       the full meter (the games step, the aside)
 *   <SpaceMeter usage={…} compact />               one line for the task bar: the bar and «يبقى 182.4 GB»
 */
import type { CSSProperties, ReactNode } from "react";

import { useFormat } from "~/i18n/react";
import type { PlanUsage } from "~/lib/switch-builder/plan";
import { toGiB } from "~/lib/switch-builder/storage";
import { NumberMorph } from "~/motion";
import { cx } from "~/ui/cx";
import { gbText, useBuilderT } from "../lib/format";

export type MeterTone = "ok" | "warn" | "over";

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
  /** The guide's target name on this copy (`data-tour`), when it is the one the shopper sees. */
  tour?: string;
  /** Under an over-full bar: the way to a bigger card. */
  action?: ReactNode;
  className?: string;
};

export function SpaceMeter({ usage, compact = false, tour, action, className }: SpaceMeterProps) {
  const t = useBuilderT();
  const f = useFormat();
  const tone = meterTone(usage);
  const shares = meterShares(usage);
  const { capacity, usage: use } = usage;
  const kept = capacity.internalReserveBytes + capacity.cardHeadroomBytes;
  const gb = (bytes: number) => gbText(f, bytes);
  const valueText = t("meter.valueText", { used: gb(use.usedBytes), plannable: gb(use.plannableBytes), left: gb(use.remainingBytes) });
  const leftWords = (
    <NumberMorph
      value={toGiB(use.remainingBytes)}
      format={(value) => t("meter.left", { left: gbText(f, value * 1024 ** 3) })}
      className="nums"
    />
  );
  const bar = (
    <div
      role="meter"
      aria-label={t("meter.label")}
      aria-valuemin={0}
      aria-valuemax={toGiB(use.plannableBytes)}
      aria-valuenow={Math.min(toGiB(use.usedBytes), toGiB(use.plannableBytes))}
      aria-valuetext={valueText}
      className="sb-meter__bar"
      style={{ "--sb-used": shares.used, "--sb-kept": shares.kept } as CSSProperties}
    >
      <span className="sb-meter__kept" />
      <span className="sb-meter__fill" />
    </div>
  );
  if (compact) {
    return (
      <div className={cx("sb-meter sb-meter--compact", className)} data-tone={tone} {...(tour ? { "data-tour": tour } : {})}>
        {bar}
        <span className="sb-meter__left">{tone === "over" ? t("meter.over", { over: gb(use.overBytes) }) : leftWords}</span>
      </div>
    );
  }
  return (
    <div className={cx("sb-meter", className)} data-tone={tone} {...(tour ? { "data-tour": tour } : {})}>
      <div className="sb-meter__head">
        <span className="sb-meter__label">{t("meter.label")}</span>
        <span className="sb-meter__left">{leftWords}</span>
      </div>
      {bar}
      {/* the bar's legend: each part's swatch beside its words (they wrap as whole items, never a stray separator) */}
      <p className="sb-meter__legend">
        <span className="sb-meter__key nums">
          <span className="sb-meter__swatch" aria-hidden="true" />
          {t("meter.used", { used: gb(use.usedBytes) })}
        </span>
        <span className="sb-meter__key nums">
          <span className="sb-meter__swatch sb-meter__swatch--kept" aria-hidden="true" />
          {t("meter.kept", { kept: gb(kept) })}
        </span>
      </p>
      {tone === "over" ? (
        <div className="sb-meter__over" role="status">
          <p>
            <b>{t("meter.over", { over: gb(use.overBytes) })}</b> {t("meter.overHint")}
          </p>
          {action}
        </div>
      ) : use.remainingBytes === 0 && use.usedBytes > 0 ? (
        <p className="sb-meter__full" role="status">
          {t("meter.full")}
        </p>
      ) : null}
    </div>
  );
}
