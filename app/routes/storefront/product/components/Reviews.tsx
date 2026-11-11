/**
 * Reviews — honest by construction (brief §3.7 "verified reviews", DESIGN.md §8.4 "verified reviews only when real
 * ones exist"). The summary counts approved reviews from verified purchases only (getReviewSummary). None exist yet,
 * so the page says that in one sentence and explains the rule; no stars, no placeholder count.
 */
import { useId } from "react";

import { useFormat } from "~/i18n/react";
import type { ReviewSummary } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { EmptyState } from "~/ui/EmptyState";
import { RatingStars } from "~/ui/RatingStars";
import { useProductT } from "../i18n";

export function Reviews({ summary, className }: { summary: ReviewSummary; className?: string }) {
  const t = useProductT();
  const f = useFormat();
  const id = useId();
  return (
    <section aria-labelledby={id} className={cx("grid gap-3", className)}>
      <h2 id={id} className="type-section text-ink">
        {t("reviews.title")}
      </h2>
      {summary.count === 0 || summary.average === null ? (
        <EmptyState icon="chat-circle" title={t("reviews.none")} text={t("reviews.rule")} />
      ) : (
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
            <RatingStars rating={{ average: summary.average, count: summary.count }} />
            <p className="type-caption text-ink-2">
              {t("reviews.count", {
                count: summary.count,
                n: f.number(summary.count),
              })}
            </p>
          </div>
          <dl className="grid max-w-sm gap-1">
            {[5, 4, 3, 2, 1].map((stars) => {
              const n = summary.distribution[stars - 1];
              return (
                <div key={stars} className="grid grid-cols-[5rem_1fr_3rem] items-center gap-3 type-caption">
                  <dt className="text-ink-2">
                    <bdi>{t("reviews.stars", { n: f.number(stars) })}</bdi>
                  </dt>
                  <dd className="h-1.5 overflow-hidden rounded-full bg-well" aria-hidden="true">
                    <span
                      className="block h-full rounded-full bg-ink"
                      style={{
                        inlineSize: `${Math.round((n / summary.count) * 100)}%`,
                      }}
                    />
                  </dd>
                  <dd className="text-end nums text-ink">{f.number(n)}</dd>
                </div>
              );
            })}
          </dl>
          <p className="type-caption text-ink-2">{t("reviews.rule")}</p>
        </div>
      )}
    </section>
  );
}
