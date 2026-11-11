import { useId, type ReactNode } from "react";

import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import type { ImageRef } from "~/lib/dto";
import { CKB_MONTHS } from "~/lib/dates";
import { LOCALES, type Locale } from "~/lib/locales";
import { BidiText } from "./BidiText";
import { cx } from "./cx";
import { PlatformLabel, type Gel } from "./PlatformLed";
import { Price } from "./Price";
import { isIqd } from "./PriceTag";
import { ProductImage } from "./ProductCard";

/**
 * The release band — Design System v2 §4.21: the page's one dark band (graphite --band, --r-xl; in the dark theme a
 * raised panel with a rim). «قريباً» and the honest line «مواعيد الإصدار كما أعلنتها الشركات. الطلب المسبق غير متاح في
 * المتجر بعد.», then the releases: the day in large Kufi numerals beside the month and year, a relative chip «بعد 8
 * أيام» only within 30 days (computed), the art on a 4:3 well, the name, the platform, the price when set and «الطلب
 * يفتح عند وصوله». Each item links to its product page. No countdowns, no pre-order buttons.
 *
 *   <ReleaseBand items={soon.map((p) => ({ id: p.id, to: `/p/${p.slug}`, name: p.name, releaseAt: p.releaseAt,
 *                                          platform: p.platform, priceIqd: p.priceIqd, image: p.image }))} now={loaderNow} />
 *
 * A snap rail of 74%-wide items on phones, four columns from 768. Nothing renders without items. Dates are Iraq time;
 * pass the loader's `now` so the server and the browser count the same days.
 */
export type ReleaseItem = {
  id: string;
  /** The product page (a locale-less path). */
  to: string;
  name: string;
  /** The announced release day (epoch ms). */
  releaseAt: number;
  platform?: Gel | null;
  /** The platform's words when they are not the platform's own name ("Nintendo Switch 2"). */
  platformLabel?: string;
  /** Only when the store has set a price. */
  priceIqd?: number | null;
  image?: ImageRef | null;
};

export type ReleaseBandProps = {
  items: readonly ReleaseItem[];
  /** "Now" for the relative chip (the loader's clock). Default: the browser's. */
  now?: number;
  /** Default «قريباً». */
  title?: ReactNode;
  headingLevel?: 2 | 3;
  className?: string;
};

const DAY_MS = 86_400_000;
const BAGHDAD = 3 * 3_600_000;

/** The calendar day of an instant in Iraq time: { day, month (1–12), year }. Pure. */
export function iraqDay(ms: number): { day: number; month: number; year: number } {
  const date = new Date(ms + BAGHDAD);
  return { day: date.getUTCDate(), month: date.getUTCMonth() + 1, year: date.getUTCFullYear() };
}

/** Whole calendar days from `now` to `at` in Iraq time (0 = today, negative = past). Pure. */
export function daysUntil(at: number, now: number): number {
  const day = (ms: number) => Math.floor((ms + BAGHDAD) / DAY_MS);
  return day(at) - day(now);
}

/** "تشرين الثاني 2026" · "November 2026" · "تشرینی دووەم 2026" (Western digits). */
function monthYear(ms: number, locale: Locale): string {
  const { month, year } = iraqDay(ms);
  if (locale === "ckb") return `${CKB_MONTHS[month - 1]} ${year}`;
  return new Intl.DateTimeFormat(`${LOCALES[locale].bcp47}-u-nu-latn`, { month: "long", year: "numeric", timeZone: "Asia/Baghdad" }).format(ms);
}

export function ReleaseBand({ items, now, title, headingLevel = 2, className }: ReleaseBandProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const locale = useLocale();
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  if (items.length === 0) return null;
  const clock = now ?? Date.now();
  return (
    <section className={cx("release min-w-0", className)} aria-labelledby={headingId}>
      <div className="grid gap-1">
        <Heading id={headingId} className="type-h2">
          {title ?? t("release.title")}
        </Heading>
        <p className="release__lead">{t("release.lead")}</p>
      </div>
      <ul className="release__list mt-6">
        {items.map((item) => {
          const days = daysUntil(item.releaseAt, clock);
          const soon = days >= 0 && days <= 30;
          return (
            <li key={item.id} className="grid">
              <LocaleLink to={item.to} className="release__item" data-press="soft">
                <span className="release__date flex-wrap">
                  <span className="release__day">{f.number(iraqDay(item.releaseAt).day, { useGrouping: false })}</span>
                  <span className="release__month">{monthYear(item.releaseAt, locale)}</span>
                  {soon ? <span className="release__rel self-center">{days === 0 ? t("release.today") : t("release.inDays", { count: days, n: f.number(days) })}</span> : null}
                </span>
                <span className="release__art">
                  {item.image ? (
                    <span className="render-slot absolute inset-[8%]">
                      <ProductImage image={item.image} alt="" sizes="(min-width: 768px) 240px, 70vw" />
                    </span>
                  ) : null}
                </span>
                <span className="release__name [unicode-bidi:isolate]">
                  <BidiText text={item.name} />
                </span>
                {item.platform ? <PlatformLabel platform={item.platform} label={item.platformLabel} className="text-on-band-2" /> : null}
                {isIqd(item.priceIqd) ? <Price amountIqd={item.priceIqd} size="md" tone="onColor" approx="off" as="span" /> : null}
                <span className="release__note">{t("release.note")}</span>
              </LocaleLink>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
