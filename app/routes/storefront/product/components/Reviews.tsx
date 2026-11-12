/**
 * Reviews — honest by construction (design v2 spec §6.7 item 14: "No reviews section until verified reviews exist").
 * The summary counts approved reviews from verified purchases only (getReviewSummary). While there are none the page
 * shows nothing at all — no empty panel, no stars, no placeholder count. Once real ones exist: the average, the count
 * in words, the spread by stars, and the rule.
 */
import { useId } from "react";

import { useFormat } from "~/i18n/react";
import type { ReviewSummary } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { RatingStars } from "~/ui/RatingStars";
import { useProductT } from "../i18n";

export function Reviews({ summary, className }: { summary: ReviewSummary; className?: string }) {
  const t = useProductT();
  const f = useFormat();
  const id = useId();
  if (summary.count === 0 || summary.average === null) return null;
  return (
    <section aria-labelledby={id} className={cx("grid gap-4", className)}>
      <h2 id={id} className="type-h2 text-ink">
        {t("reviews.title")}
      </h2>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <RatingStars rating={{ average: summary.average, count: summary.count }} />
        <p className="type-sm text-ink-2">{t("reviews.count", { count: summary.count, n: f.number(summary.count) })}</p>
      </div>
      <dl className="grid max-w-sm gap-1">
        {[5, 4, 3, 2, 1].map((stars) => {
          const n = summary.distribution[stars - 1];
          return (
            <div key={stars} className="grid grid-cols-[5rem_1fr_3rem] items-center gap-3 type-xs">
              <dt className="text-ink-2">
                <bdi>{t("reviews.stars", { n: f.number(stars) })}</bdi>
              </dt>
              <dd className="h-1.5 overflow-hidden rounded-full bg-niche-2" aria-hidden="true">
                <span className="block h-full rounded-full bg-ink" style={{ inlineSize: `${Math.round((n / summary.count) * 100)}%` }} />
              </dd>
              <dd className="text-end nums text-ink">{f.number(n)}</dd>
            </div>
          );
        })}
      </dl>
      <p className="type-xs text-ink-2">{t("reviews.rule")}</p>
    </section>
  );
}
