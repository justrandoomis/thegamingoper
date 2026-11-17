/**
 * Reviews — honest by construction (design v2 spec §6.7 item 14: "No reviews section until verified reviews exist").
 * The summary counts approved reviews from verified purchases only (getReviewSummary). While there are none the page
 * shows nothing at all — no empty panel, no stars, no placeholder count. Once real ones exist: the average, the count
 * in words, the spread by stars, the rule — and (polish 2026-11-17) the newest of those reviews themselves
 * (listVerifiedReviews): each with its stars in words, the verified-buyer mark and its date, its words in the language
 * and direction they were written in. Never who wrote it (the service returns no author).
 */
import { useId } from "react";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import type { ReviewSummary, VerifiedReview } from "~/server/services/catalog/product-types";
import { cx } from "~/ui/cx";
import { RatingStars } from "~/ui/RatingStars";
import { useProductT } from "../i18n";

/** Iraq time (UTC+3, no daylight saving): the calendar day a review was written, for <time datetime>. Pure. */
export const reviewDay = (epochMs: number) => new Date(epochMs + 3 * 3_600_000).toISOString().slice(0, 10);

/** A review's own language and direction (null: the browser decides from its words). Pure. */
function reviewLang(locale: string | null): { lang?: string; dir: "ltr" | "rtl" | "auto" } {
  if (locale === "en") return { lang: "en", dir: "ltr" };
  if (locale === "ar" || locale === "ckb") return { lang: locale, dir: "rtl" };
  return { dir: "auto" };
}

export function Reviews({ summary, items = [], className }: { summary: ReviewSummary; items?: readonly VerifiedReview[]; className?: string }) {
  const t = useProductT();
  const f = useFormat();
  const id = useId();
  const listId = useId();
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
      {items.length > 0 ? (
        <>
          <h3 id={listId} className="type-h3 text-ink">
            {t("reviews.latest")}
          </h3>
          <ul role="list" aria-labelledby={listId} className="pp-reviews__list grid max-w-[40rem] border-t border-line">
            {items.map((review) => {
              const words = reviewLang(review.locale);
              return (
                <li key={review.id} className="grid gap-1.5 border-b border-line py-4">
                  <p className="flex flex-wrap items-center gap-x-3 gap-y-1 type-sm text-ink-2">
                    <span className="inline-flex items-center gap-1 type-sm-strong text-ink">
                      <Icon name="star" size={16} />
                      <bdi>{t("reviews.stars", { n: f.number(review.rating) })}</bdi>
                    </span>
                    <span className="inline-flex items-center gap-1 text-ok">
                      <Icon name="check-circle" size={16} />
                      {t("reviews.verified")}
                    </span>
                    <time dateTime={reviewDay(review.createdAt)}>{f.date(review.createdAt)}</time>
                  </p>
                  {review.title ? (
                    <p className="type-strong text-ink" {...words}>
                      {review.title}
                    </p>
                  ) : null}
                  {review.body ? (
                    <p className="max-w-[39em] type-read text-ink" {...words}>
                      {review.body}
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
