import { useId, type CSSProperties, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { ImageRef, UsedGrade } from "~/lib/dto";
import { cx } from "./cx";
import { DemoNote } from "./DemoNote";
import { GradeBadge } from "./GradeBadge";
import { fillNodes, iqdText, isIqd } from "./PriceTag";
import { ProductImage } from "./ProductCard";

/**
 * The inspection report of one used unit — Design System v2 §4.12: a paper card with a hairline (--r-lg) on the unit's
 * page. Nothing in it is animated, and serial numbers and private data never appear (pass none: there is no prop for
 * them). Checklist rows have a check or an alert icon AND words; battery health is an ink bar on --niche-2 with a
 * tabular % (or «غير قابل للقياس»); «سعره جديداً في المتجر 524,750 د.ع» when the store sells the model new.
 *
 *   Head        the outlined grade tag with its legend, the inspection date, and "صور الجهاز نفسه" above the real
 *               photographs (thumbnails with a 1px line border; never manufacturer images). The honesty line says
 *               either "هذه صور الجهاز نفسه الذي يصلك." or — when every picture is an illustration — that no real
 *               photo exists yet and the pictures shown are illustrations.
 *   Checklist   flat rows, each with a check or an alert icon AND words; battery health as a percentage with a meter
 *               when it can be measured, "غير قابلة للقياس" when it cannot; ownership and data-wipe checks.
 *   Defects     in words, each with its photo first.
 *   Included    what comes in the box; then the warranty and the return condition in plain sentences.
 *
 *   <InspectionCard grade="B" inspectedAt={unit.inspectedAt} batteryHealthPct={87} checklist={unit.checklist}
 *                   defects={unit.defects} included={unit.included} photos={unit.photos} warrantyDays={90} returnDays={7} />
 *
 * The used area (CONTRACTS.md §3, getUsedUnitDetail) maps `used_units` (checklist/defects/included json,
 * battery_health_pct, warranty_days, ownership_checked_at, data_wiped_at) and its photos onto these props.
 */
export type InspectionCheck = {
  /** Stable key ("screen", "sticks", "ports", "disc", "charging", "wifi" …). */
  key: string;
  /** What was checked, in the page's language. */
  label: string;
  ok: boolean;
  /** What was found when it is not fine (or a detail when it is). */
  note?: string | null;
};

export type InspectionDefect = {
  /** In words, in the page's language. */
  text: string;
  /** A real photo of the defect, when there is one. */
  photo?: ImageRef | null;
};

export type InspectionCardProps = {
  grade: UsedGrade;
  /** Epoch ms of the inspection; null when it was not recorded. */
  inspectedAt: number | null;
  /** 0–100, or null when this device's battery cannot be measured. */
  batteryHealthPct: number | null;
  checklist: readonly InspectionCheck[];
  defects?: readonly InspectionDefect[];
  /** What comes with the unit ("ذراع تحكم أصلية", "كابل HDMI"). */
  included?: readonly string[];
  /** Photos of this unit. Pictures marked `isIllustration` are not treated as evidence. */
  photos: readonly ImageRef[];
  /** Store warranty in days (0 = none). */
  warrantyDays: number;
  /** The return window (settings `returns.window_days`). Omit to say nothing about returns. */
  returnDays?: number | null;
  /** `ownership_checked_at` and `data_wiped_at` were recorded (a unit cannot be listed without them). */
  ownershipChecked?: boolean;
  dataWiped?: boolean;
  isDemo?: boolean;
  /** «سعره جديداً في المتجر 524,750 د.ع» — the store's price for the same model new, when it sells it. */
  newPriceIqd?: number | null;
  /**
   * Without a real photo the card says the pictures are illustrations. `false`: the page already says it once (the
   * gallery's line under the stage), so the card leaves its photos part out instead of saying it a second time.
   */
  illustrationNote?: boolean;
  headingLevel?: 2 | 3;
  className?: string;
};

/** Battery health as a whole percentage 0–100, or null when unknown/invalid. Pure. */
export function batteryPct(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) return null;
  return Math.round(value);
}

/** The real photos among `photos` (illustrations are never evidence). Pure. */
export function realPhotos(photos: readonly ImageRef[]): ImageRef[] {
  return photos.filter((photo) => !photo.isIllustration && (photo.mediaKey || photo.artKey));
}

export function InspectionCard({
  grade,
  inspectedAt,
  batteryHealthPct,
  checklist,
  defects = [],
  included = [],
  photos,
  warrantyDays,
  returnDays = null,
  ownershipChecked = false,
  dataWiped = false,
  isDemo = false,
  newPriceIqd = null,
  illustrationNote = true,
  headingLevel = 2,
  className,
}: InspectionCardProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  const Sub = `h${headingLevel + 1}` as "h3" | "h4";
  const real = realPhotos(photos);
  const battery = batteryPct(batteryHealthPct);
  const days = (n: number) => t("days", { count: n, n: f.number(n) });

  return (
    <section aria-labelledby={headingId} className={cx("inspect", className)} data-inspection="">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <Heading id={headingId} className="type-h3 text-ink">
            {t("inspection.title")}
          </Heading>
          <GradeBadge grade={grade} legend />
        </div>
        <p className="type-xs text-ink-2">
          {inspectedAt !== null && Number.isFinite(inspectedAt) ? (
            <time dateTime={new Date(inspectedAt).toISOString()}>{t("inspection.inspectedOn", { date: f.date(inspectedAt, "long") })}</time>
          ) : (
            t("inspection.notDated")
          )}
        </p>
        {isDemo ? <DemoNote variant="tag" what="data" className="justify-self-start" /> : null}
      </div>

      {real.length === 0 && !illustrationNote ? null : (
        <Part title={t("inspection.photos")} Sub={Sub}>
          {real.length > 0 ? (
            <>
              <p className="flex items-start gap-1.5 type-xs text-ink-2">
                <Icon name="camera" size={16} className="mt-0.5 shrink-0" />
                {t("inspection.photosNote")}
              </p>
              <ul className="flex flex-wrap gap-2">
                {real.map((photo, index) => (
                  <li key={photo.mediaKey ?? photo.artKey ?? index} className="relative size-20 overflow-hidden rounded-sm border border-line bg-niche">
                    <span className="render-slot size-full">
                      <ProductImage image={photo} sizes="80px" fit="cover" />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="flex items-start gap-1.5 type-xs-strong text-warn">
              <Icon name="image" size={16} className="mt-0.5 shrink-0" />
              {t("inspection.noPhotos")}
            </p>
          )}
        </Part>
      )}

      <Part title={t("inspection.checklist")} Sub={Sub}>
        <ul className="inspect__rows">
          {checklist.map((check) => (
            <CheckRow key={check.key} ok={check.ok} label={check.label} note={check.note} />
          ))}
          <li className="inspect__row">
            <Icon name="battery-high" size={20} className="text-ink-2" />
            <span className="grid gap-1.5">
              <span className="flex items-start justify-between gap-3">
                <span>{t("inspection.battery")}</span>
                {battery === null ? <span className="text-ink-2">{t("inspection.batteryNA")}</span> : null}
              </span>
              {battery === null ? null : (
                <span className="battery">
                  <span
                    role="meter"
                    aria-label={t("inspection.battery")}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={battery}
                    aria-valuetext={f.percent(battery / 100)}
                    className="battery__bar"
                  >
                    <span className="battery__fill" style={{ "--level": `${battery}%` } as CSSProperties} />
                  </span>
                  <bdi className="nums">{f.percent(battery / 100)}</bdi>
                </span>
              )}
            </span>
          </li>
          {ownershipChecked ? <CheckRow ok label={t("inspection.ownership")} /> : null}
          {dataWiped ? <CheckRow ok label={t("inspection.dataWiped")} /> : null}
        </ul>
      </Part>

      <Part title={t("inspection.defects")} Sub={Sub}>
        {defects.length === 0 ? (
          <p className="type-read text-ink-2 lg:type-sm">{t("inspection.noDefects")}</p>
        ) : (
          <ul className="grid gap-3">
            {defects.map((defect, index) => (
              <li key={index} className="flex items-start gap-3">
                {defect.photo && !defect.photo.isIllustration ? (
                  <span className="relative size-16 shrink-0 overflow-hidden rounded-sm border border-line bg-niche">
                    <span className="render-slot size-full">
                      <ProductImage image={defect.photo} alt={t("inspection.defectPhoto", { defect: defect.text })} sizes="64px" fit="cover" />
                    </span>
                  </span>
                ) : null}
                <span className="min-w-0 pt-0.5 type-read text-ink lg:type-sm">{defect.text}</span>
              </li>
            ))}
          </ul>
        )}
      </Part>

      <Part title={t("inspection.included")} Sub={Sub}>
        {included.length === 0 ? (
          <p className="type-read text-ink-2 lg:type-sm">{t("inspection.nothingIncluded")}</p>
        ) : (
          <ul className="grid list-inside list-disc gap-1 type-read text-ink marker:text-ink-2 lg:type-sm">
            {included.map((thing, index) => (
              <li key={index}>{thing}</li>
            ))}
          </ul>
        )}
        <div className="mt-2 grid gap-1 border-t border-line pt-3 type-read text-ink lg:type-sm">
          <p>{warrantyDays > 0 ? t("inspection.warranty", { days: days(warrantyDays) }) : t("inspection.noWarranty")}</p>
          {returnDays && returnDays > 0 ? <p>{t("inspection.returns", { days: days(returnDays) })}</p> : null}
          {isIqd(newPriceIqd) ? (
            <p className="text-ink-2">{fillNodes(t("buy.newPrice"), { price: <bdi className="nums">{iqdText(f, newPriceIqd)}</bdi> })}</p>
          ) : null}
        </div>
      </Part>
    </section>
  );
}

function Part({ title, Sub, children }: { title: string; Sub: "h3" | "h4"; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <Sub className="type-sm-strong text-ink">{title}</Sub>
      {children}
    </div>
  );
}

function CheckRow({ ok, label, note }: { ok: boolean; label: string; note?: string | null }) {
  const t = useT("ui-shop");
  return (
    <li className="inspect__row">
      <Icon name={ok ? "check-circle" : "warning"} size={20} filled={ok} className={ok ? "text-ok" : "text-warn"} />
      <span className="grid min-w-0 gap-0.5">
        <span className="text-ink">
          {label}
          <span className="sr-only"> — {t(ok ? "inspection.ok" : "inspection.issue")}</span>
        </span>
        {note ? <span className="type-sm text-ink-2 lg:type-xs">{note}</span> : null}
      </span>
    </li>
  );
}
