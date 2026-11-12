/**
 * Small building blocks of the command centre (admin module 01): the module's `t()`, sections, money and counts in
 * tabular type, times in Iraq time, the KPI card with its comparison line, and the streamed card — each card's data
 * arrives on its own (the loader returns promises that never reject), so one slow card never holds the page:
 *
 *   <StreamedCard resolve={loaderData.cards.sales} fallback={<KpiPlaceholders … />} failed={<CardFailed … />}>
 *     {(sales) => <SalesKpis data={sales} />}
 *   </StreamedCard>
 *
 * Give the <StreamedCard> a `key` that changes with the URL: a new navigation then shows the placeholder at once
 * instead of holding the old figures until the new ones arrive.
 */
import { Suspense, useEffect, type ReactNode, type RefObject } from "react";
import { Await, Link, useLocation } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import { compare, type DashboardPeriod, type Figure, type Streamed } from "~/server/services/admin/dashboard/types";
import { cx } from "~/ui/cx";
import { Tag } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";

export function useDashT(): TFunction {
  return useT("admin-dashboard");
}

export function Section({ id, title, aside, lead, children, className }: { id: string; title: ReactNode; aside?: ReactNode; lead?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("adm-section", className)} aria-labelledby={id}>
      <div className="adm-section__head">
        <h2 id={id} className="adm-h2">
          {title}
        </h2>
        {aside}
      </div>
      {lead ? <p className="max-w-[72ch] type-caption text-ink-2">{lead}</p> : null}
      {children}
    </section>
  );
}

/** Integer IQD; a negative amount with a minus sign in red ink; null is "—" with the reason for screen readers. */
export function Money({
  iqd,
  className,
  wrap = false,
  bare = false,
}: {
  iqd: number | null | undefined;
  className?: string;
  /** May break before the currency (a KPI figure on a phone). */
  wrap?: boolean;
  /** The number alone — in a table column whose head carries the currency ("الإجمالي (د.ع)"). */
  bare?: boolean;
}) {
  const f = useFormat();
  const t = useDashT();
  if (iqd === null || iqd === undefined || !Number.isFinite(iqd)) {
    return (
      <span className={cx("text-ink-2", className)}>
        — <span className="sr-only">{t("card.none")}</span>
      </span>
    );
  }
  // a left-to-right mark before the minus keeps it on the digits' left in Arabic too ("‎−17,917 د.ع"), as ICU writes it
  const text = bare ? f.number(Math.abs(iqd)) : f.iqd(Math.abs(iqd));
  return <bdi className={cx("nums", !wrap && "whitespace-nowrap", iqd < 0 && "text-red-ink", className)}>{iqd < 0 ? `‎−${text}` : text}</bdi>;
}

export function Count({ value, className }: { value: number | null | undefined; className?: string }) {
  const f = useFormat();
  const t = useDashT();
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return (
      <span className={cx("text-ink-2", className)}>
        — <span className="sr-only">{t("card.none")}</span>
      </span>
    );
  }
  return <bdi className={cx("nums", value < 0 && "text-red-ink", className)}>{value < 0 ? `‎−${f.number(-value)}` : f.number(value)}</bdi>;
}

export function When({ at, kind = "dateTime" }: { at: number | null | undefined; kind?: "dateTime" | "date" }) {
  const f = useFormat();
  if (at === null || at === undefined) return <span>—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} className="nums whitespace-nowrap">
      {kind === "date" ? f.date(at, "medium") : f.dateTime(at)}
    </time>
  );
}

/** A reference, SKU or serial: left to right, tabular. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", className)}>
      {children}
    </bdi>
  );
}

/** The figure of the span before and the change, in words with an icon (never by colour alone). */
export function DeltaLine({ figure, money = false, period }: { figure: Figure; money?: boolean; period: DashboardPeriod }) {
  const t = useDashT();
  const f = useFormat();
  const label = t(`period.previous.${period}`);
  const value = figure.previous === null ? t("card.none") : money ? f.iqd(figure.previous) : f.number(figure.previous);
  const change = compare(figure.current, figure.previous);
  let word: string | null = null;
  let icon: IconName | null = null;
  if (change) {
    if (change.delta === 0) word = t("sales.same");
    else if (change.ratioBps === null) word = t("sales.noRatio");
    else {
      const percent = f.percent(Math.abs(change.ratioBps) / 10_000);
      word = change.delta > 0 ? t("sales.up", { value: percent }) : t("sales.down", { value: percent });
      icon = change.delta > 0 ? "trend-up" : "trend-down";
    }
  }
  return (
    <p className="dash-kpi__delta">
      <span>{t("sales.before", { label, value: `⁨${value}⁩` })}</span>
      {word ? (
        <span className="inline-flex items-center gap-1 text-ink">
          {icon ? <Icon name={icon} size={16} /> : null}
          <bdi>{word}</bdi>
        </span>
      ) : null}
    </p>
  );
}

/** A flat KPI card (DESIGN.md §10 "Summary cards"): caption, the figure in KPI type, the comparison, a hint. */
export function KpiCard({ label, value, delta, hint, busy = false, children }: { label: ReactNode; value: ReactNode; delta?: ReactNode; hint?: ReactNode; busy?: boolean; children?: ReactNode }) {
  return (
    <div className="adm-card dash-kpi" aria-busy={busy || undefined}>
      <p className="type-caption text-ink-2">{label}</p>
      <p className="type-kpi nums text-ink">
        <bdi>{value}</bdi>
      </p>
      {delta}
      {hint ? <p className="type-caption text-ink-2">{hint}</p> : null}
      {children}
    </div>
  );
}

/** A card that streams in: its placeholder while it comes, the card when it is here, the honest failure otherwise. */
export function StreamedCard<T>({ resolve, fallback, failed, children }: { resolve: Promise<Streamed<T>>; fallback: ReactNode; failed: ReactNode; children: (data: T) => ReactNode }) {
  return (
    <Suspense fallback={fallback}>
      <Await resolve={resolve} errorElement={failed}>
        {(value: Streamed<T>) => (value.ok ? children(value.data) : failed)}
      </Await>
    </Suspense>
  );
}

/** What a card says when its figures could not be computed: never a 0 in their place; reload this page. */
export function CardFailed({ title, className }: { title: ReactNode; className?: string }) {
  const t = useDashT();
  const location = useLocation();
  return (
    <div className={cx("adm-card", className)} role="status">
      <p className="type-caption text-ink-2">{title}</p>
      <p className="flex items-start gap-2 type-body text-ink">
        <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0 text-ink-2" />
        <span>{t("card.failed")}</span>
      </p>
      <div>
        <TextLink as={Link} to={`${location.pathname}${location.search}`}>
          {t("card.retry")}
        </TextLink>
      </div>
    </div>
  );
}

/** The quiet line a card shows while its figures stream in (no grey skeleton: the card's own frame and words). */
export function CardLoading({ title, className }: { title: ReactNode; className?: string }) {
  const t = useDashT();
  return (
    <div className={cx("adm-card", className)} aria-busy="true">
      <p className="type-caption text-ink-2">{title}</p>
      <p className="type-body text-ink-2">{t("card.loading")}</p>
    </div>
  );
}

/**
 * Ink on paper whatever the screen's theme: while the browser prints (its own command or window.print), the block
 * carries data-theme="light", so a dark screen never prints light text on white paper.
 */
export function usePrintInLight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    // `beforeprint` can arrive twice for one print (window.print and the dialog): remember the screen's value once
    let printing = false;
    let previous: string | null = null;
    const before = () => {
      if (!printing) previous = ref.current?.getAttribute("data-theme") ?? null;
      printing = true;
      ref.current?.setAttribute("data-theme", "light");
    };
    const after = () => {
      printing = false;
      if (previous === null) ref.current?.removeAttribute("data-theme");
      else ref.current?.setAttribute("data-theme", previous);
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, [ref]);
}

export function DemoTag() {
  const t = useDashT();
  return <Tag kind="demo">{t("card.demo")}</Tag>;
}
