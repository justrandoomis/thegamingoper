import { useId } from "react";
import { useRouteLoaderData } from "react-router";

import { useFormat, useT } from "~/i18n/react";
import type { UsedUnitCardData } from "~/lib/dto";
import { MotionLink, SharedElement } from "~/motion";
import { BidiText } from "./BidiText";
import { cx } from "./cx";
import { DemoNote } from "./DemoNote";
import { GradeBadge } from "./GradeBadge";
import { IconKey } from "./IconKey";
import { Niche } from "./Niche";
import { SafePrice } from "./PriceTag";
import { ProductImage } from "./ProductCard";
import { Tag } from "./Tag";
import { TextLink } from "./TextLink";

/**
 * One used unit — Design System v2 §4.12 (G14): the card family for a unit that was inspected. NO add to cart from a
 * list: the unit's page shows the inspection first. Its action is «اعرض تقرير الفحص».
 *
 *   <UsedUnitCard unit={unit} />                  grid card: the grade badge, «صورة توضيحية» on an illustration (the
 *                                                 photo raised 10% so the tag never covers it), «البطارية 91% · ضمان
 *                                                 30 يوماً», the price and the report button
 *   <UsedUnitCard unit={unit} layout="row" />     the /used list row (two columns of rows from 1024): a 96px well, the
 *                                                 title, the grade, «البطارية 91% · ضمان 30 يوماً · 512GB», the price and
 *                                                 «اعرض تقرير الفحص» (44px)
 *
 * A real photo of the unit fills the well (cover) and says nothing extra; an illustration says so, in words, on the
 * photo. No serial numbers. The whole card is one link to /used/<slug> (the shared element `used-image:<id>`).
 */
export type UsedUnitCardProps = {
  unit: UsedUnitCardData;
  layout?: "grid" | "row";
  priority?: boolean;
  /** Shared-element name; default `used-image:${unit.id}` (the used unit page's Gallery is the target). */
  sharedName?: string;
  slot?: string;
  sizes?: string;
  /** The name's heading level. Default 3. */
  headingLevel?: 2 | 3 | 4;
  demoNote?: boolean;
  className?: string;
};

type RootStore = { storeMode?: string };

export function UsedUnitCard({
  unit,
  layout = "grid",
  priority = false,
  sharedName,
  slot,
  sizes = "(min-width: 1280px) 240px, (min-width: 768px) 30vw, 46vw",
  headingLevel = 3,
  demoNote,
  className,
}: UsedUnitCardProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const titleId = useId();
  const store = useRouteLoaderData("root") as RootStore | undefined;
  const showDemo = demoNote ?? (unit.isDemo && store?.storeMode !== "demo");
  const href = `/used/${unit.slug}`;
  const Name = `h${headingLevel}` as const;
  const row = layout === "row";
  const real = unit.hasRealPhotos && !unit.image.isIllustration;
  const facts = [
    unit.batteryHealthPct !== null && Number.isFinite(unit.batteryHealthPct) ? t("card.battery", { pct: f.percent(unit.batteryHealthPct / 100) }) : null,
    unit.warrantyDays > 0 ? t("card.warranty", { days: t("days", { count: unit.warrantyDays, n: f.number(unit.warrantyDays) }) }) : null,
    row ? unit.subtitle : null,
  ].filter((fact): fact is string => Boolean(fact));
  const price = <SafePrice amountIqd={unit.priceIqd} approx="off" />;

  return (
    <article className={cx("pcard", row && "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3", className)} data-state="used" data-layout={layout} data-used-unit={unit.id}>
      <MotionLink
        nav="zoom"
        to={href}
        className={cx("pcard__link min-w-0", row ? "grid grid-cols-[96px_minmax(0,1fr)] items-center gap-x-4" : "flex flex-1 flex-col")}
        aria-labelledby={titleId}
        data-press="soft"
      >
        <SharedElement name={sharedName ?? `used-image:${unit.id}`} slot={slot} as="span" className="block">
          <Niche
            as="span"
            kind={real ? "hardware" : "used"}
            fill={real && Boolean(unit.image.mediaKey)}
            size={row ? "sm" : "md"}
            tag={row ? undefined : <GradeBadge grade={unit.grade} />}
            note={real || row ? undefined : <Tag kind="photo" />}
          >
            <ProductImage image={unit.image} alt="" sizes={row ? "96px" : sizes} priority={priority} fit="cover" />
          </Niche>
        </SharedElement>
        <span className={cx("pcard__body", row && "py-0")}>
          <Name id={titleId} className="pcard__title [unicode-bidi:isolate]">
            <BidiText text={unit.name} />
          </Name>
          {row ? <GradeBadge grade={unit.grade} className="self-start" /> : null}
          {facts.length ? <span className="pcard__meta">{facts.join(" · ")}</span> : null}
          {row ? (
            <span className="mt-1 flex flex-wrap items-center gap-x-3">
              {price}
              {real ? null : <span className="type-xs text-ink-2">{t("card.illustrationShort")}</span>}
            </span>
          ) : null}
        </span>
      </MotionLink>
      <div className={cx("pcard__foot", row && "mt-0 pt-0")}>
        {row ? (
          <TextLink as={MotionLink} nav="zoom" to={href} className="relative z-2">
            {t("card.inspect")}
          </TextLink>
        ) : (
          <>
            {price}
            <IconKey as={MotionLink} nav="zoom" to={href} icon="clipboard-text" label={t("card.inspectNamed", { name: unit.name })} />
          </>
        )}
      </div>
      {showDemo ? <DemoNote variant="tag" what="data" className="relative z-2 mt-1 self-start" /> : null}
    </article>
  );
}
