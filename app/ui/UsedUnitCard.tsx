import { useRef } from "react";
import { useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { UsedUnitCardData } from "~/lib/dto";
import { MotionLink, SharedElement } from "~/motion";
import { AddToCartKey } from "./AddToCartKey";
import { cx } from "./cx";
import { DemoNote } from "./DemoNote";
import { GradeBadge } from "./GradeBadge";
import { Niche } from "./Niche";
import { PriceTag } from "./PriceTag";
import { BidiText, ProductImage } from "./ProductCard";

/**
 * One used unit (docs/DESIGN.md §9.5 "Used devices", §12, brief §5): the same card, but the niche holds a REAL photo
 * of this unit (object-fit cover, never lit) and says so — "صورة الجهاز نفسه". When the listing only has an
 * illustration (demo data, or a unit still waiting for photos) the card says that instead, in words, under the
 * picture: "صورة توضيحية — ليست صورة الجهاز نفسه". The tag is the outlined grade; the fact line carries battery
 * health (when measurable) and the store warranty. One unit = one add (usedUnitId).
 *
 *   <UsedUnitCard unit={unit} />          UsedUnitCardData from listUsedUnits (used area)
 */
export type UsedUnitCardProps = {
  unit: UsedUnitCardData;
  priority?: boolean;
  /** Shared-element name; default `used-image:${unit.id}` (the used unit page's Gallery is the target). */
  sharedName?: string;
  slot?: string;
  sizes?: string;
  headingLevel?: 2 | 3 | 4;
  demoNote?: boolean;
  className?: string;
};

type RootStore = { storeMode?: string };

export function UsedUnitCard({ unit, priority = false, sharedName, slot, sizes = "(min-width: 1200px) 210px, (min-width: 768px) 30vw, 46vw", headingLevel, demoNote, className }: UsedUnitCardProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const root = useRef<HTMLElement>(null);
  const store = useRouteLoaderData("root") as RootStore | undefined;
  const showDemo = demoNote ?? (unit.isDemo && store?.storeMode !== "demo");
  const href = `/used/${unit.slug}`;
  const Name = headingLevel ? (`h${headingLevel}` as const) : "span";
  const real = unit.hasRealPhotos && !unit.image.isIllustration;
  const facts = [
    unit.subtitle,
    unit.batteryHealthPct !== null && Number.isFinite(unit.batteryHealthPct) ? t("card.battery", { pct: f.percent(unit.batteryHealthPct / 100) }) : null,
    unit.warrantyDays > 0 ? t("card.warranty", { days: t("days", { count: unit.warrantyDays, n: f.number(unit.warrantyDays) }) }) : null,
  ].filter(Boolean);

  return (
    <article ref={root} className={cx("relative flex min-w-0 flex-col", className)} data-used-unit={unit.id}>
      <MotionLink nav="zoom" to={href} className="flex flex-col gap-2 rounded-lg after:absolute after:inset-0 after:content-['']">
        <SharedElement name={sharedName ?? `used-image:${unit.id}`} slot={slot} as="span" className="block">
          <Niche as="span" fill={real && !!unit.image.mediaKey} tag={<GradeBadge grade={unit.grade} />}>
            <ProductImage image={unit.image} alt="" sizes={sizes} priority={priority} fit="cover" />
          </Niche>
        </SharedElement>
        <Name className="line-clamp-2 min-h-[2lh] type-strong text-ink">
          <BidiText text={unit.name} />
        </Name>
      </MotionLink>
      <p className="min-h-[1lh] type-caption text-ink-2">{facts.join(" · ")}</p>
      <p className={cx("mt-0.5 flex items-start gap-1 type-caption", real ? "text-ink-2" : "font-medium text-warn")}>
        <Icon name={real ? "camera" : "image"} size={14} className="mt-[3px]" />
        <span>{t(real ? "card.realPhoto" : "card.illustration")}</span>
      </p>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-x-2 gap-y-1 pt-1.5">
        <PriceTag priceIqd={unit.priceIqd} />
        <AddToCartKey item={{ usedUnitId: unit.id }} name={unit.name} image={unit.image} source={() => root.current?.querySelector(".niche") ?? null} />
      </div>
      {showDemo ? <DemoNote compact className="relative mt-1 self-start" /> : null}
    </article>
  );
}
