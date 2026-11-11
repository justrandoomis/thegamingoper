import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { RatingSummary } from "~/lib/dto";
import { cx } from "./cx";

/**
 * A rating, display only (brief §3.7, DESIGN.md §3: "no invented ratings"). It renders NOTHING unless there is a real
 * summary — `ProductCardData.rating` is null until approved, verified-purchase reviews exist — so a component can
 * always be given the field as it comes. Ink stars (never gold, never red), the average and the count as words.
 *
 *   <RatingStars rating={card.rating} />              ★★★★☆ 4.6 (12 تقييماً)
 *   <RatingStars rating={summary} size="md" verified />   on the product page, "من مشترين موثّقين"
 */
export type RatingStarsProps = {
  rating: RatingSummary | null | undefined;
  size?: "sm" | "md";
  /** Add "من مشترين موثّقين" (only when the summary counts verified purchases, which is the policy). */
  verified?: boolean;
  className?: string;
};

/** Share of each of the five stars that is filled (0–1), for an average 0–5. Pure. */
export function starFills(average: number): number[] {
  const clamped = Number.isFinite(average) ? Math.min(5, Math.max(0, average)) : 0;
  return [0, 1, 2, 3, 4].map((i) => Math.min(1, Math.max(0, clamped - i)));
}

export function isRealRating(rating: RatingSummary | null | undefined): rating is RatingSummary {
  return !!rating && Number.isFinite(rating.average) && rating.average >= 0 && rating.average <= 5 && Number.isSafeInteger(rating.count) && rating.count > 0;
}

export function RatingStars({ rating, size = "sm", verified = false, className }: RatingStarsProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  if (!isRealRating(rating)) return null;
  const star = size === "md" ? 18 : 14;
  const average = f.number(Math.round(rating.average * 10) / 10, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const count = t("rating.count", { count: rating.count, n: f.number(rating.count) });
  const comma = f.locale === "en" ? ", " : "، ";
  const label = `${t("rating.label", { avg: average })}${comma}${count}${verified ? ` ${t("rating.verified")}` : ""}`;
  return (
    <span className={cx("inline-flex flex-wrap items-center gap-x-1.5", size === "md" ? "type-label" : "type-caption", "text-ink-2", className)}>
      <span role="img" aria-label={label} className="inline-flex text-ink">
        {starFills(rating.average).map((fill, index) => (
          <span key={index} className="relative inline-grid" style={{ inlineSize: star, blockSize: star }}>
            <Icon name="star" size={star} className="text-ink-3" />
            {fill > 0 ? (
              // The filled part grows from the reading start, so a half star reads the right way in RTL and LTR.
              <span className="absolute inset-y-0 start-0 overflow-hidden" style={{ inlineSize: `${fill * 100}%` }}>
                <Icon name="star" filled size={star} />
              </span>
            ) : null}
          </span>
        ))}
      </span>
      <span aria-hidden="true" className="nums">
        <bdi className="font-semibold text-ink">{average}</bdi> ({count})
      </span>
      {verified ? (
        <span aria-hidden="true" className="text-ink-2">
          {t("rating.verified")}
        </span>
      ) : null}
    </span>
  );
}
