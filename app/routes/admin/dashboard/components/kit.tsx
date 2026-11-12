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
 *
 * Motion (Design v2.1 "Clay & Glass" G6, all of it off under reduced motion and the store's reduce-motion setting —
 * html[data-motion] — and nothing that moves layout):
 *   <CountUp value={n} render={(v) => <Money iqd={v} />} />   a figure counts up from 0 once, when it arrives
 *   <Skeleton width="60%" />                                  the shimmer bar a figure waits behind
 *   className="dash-rise" style={rise(i)}                     a card fades up with the i-th stagger slot
 *   usePendingFilters()                                        the view / period the page is switching to (optimistic)
 */
import { Suspense, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Await, Link, useLocation, useNavigation } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useDir, useFormat, useT } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import type { Dir } from "~/lib/locales";
import { getMotionTier, useHydrating } from "~/motion";
import { compare, parseDashboardFilters, type DashboardFilters, type DashboardPeriod, type Figure, type Streamed } from "~/server/services/admin/dashboard/types";
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

/**
 * A value set inside a sentence, isolated in the page's own direction (U+2067 right-to-left, U+2066 left-to-right). An
 * amount is never wrapped in a first-strong isolate (U+2068, or <bdi> without `dir`): Arabic negatives start with a
 * left-to-right mark (ICU's "‎-17,917", the kit's "‎−"), which turns such an isolate left to right and puts the currency
 * before the figure in an Arabic line.
 */
export function isolate(text: string, dir: Dir): string {
  return `${dir === "rtl" ? "\u2067" : "\u2066"}${text}\u2069`;
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
  const dir = useDir();
  if (iqd === null || iqd === undefined || !Number.isFinite(iqd)) {
    return (
      <span className={cx("text-ink-2", className)}>
        — <span className="sr-only">{t("card.none")}</span>
      </span>
    );
  }
  // a left-to-right mark before the minus keeps it on the digits' left in Arabic too ("‎−17,917 د.ع"), as ICU writes it;
  // the isolate takes the page's direction, so that mark never turns the amount around (the figure stays first)
  const text = bare ? f.number(Math.abs(iqd)) : f.iqd(Math.abs(iqd));
  return (
    <bdi dir={dir} className={cx("nums", !wrap && "whitespace-nowrap", iqd < 0 && "text-red-ink", className)}>
      {iqd < 0 ? `‎−${text}` : text}
    </bdi>
  );
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
  const dir = useDir();
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
      <span>{t("sales.before", { label, value: isolate(value, dir) })}</span>
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

/** A card while its figures stream in: the card's own frame and title, a shimmer where the figure will be. */
export function CardLoading({ title, className }: { title: ReactNode; className?: string }) {
  const t = useDashT();
  return (
    <div className={cx("adm-card dash-loading", className)} aria-busy="true">
      <p className="type-caption text-ink-2">{title}</p>
      <Skeleton width="45%" size="figure" />
      <Skeleton width="70%" />
      <span className="sr-only">{t("card.loading")}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── motion and loading

/** The stagger slot of a card that fades up as it arrives (`className="dash-rise"`; slots after the sixth share it). */
export function rise(index: number): CSSProperties {
  return { "--i": Math.min(Math.max(Math.trunc(index), 0), 5) } as CSSProperties;
}

/**
 * A shimmer bar standing in for text that is on its way (decorative: the card says `aria-busy` and "loading"). Inside a
 * line of text it keeps that line's height; `figure` takes the figure's own line inside `.dash-kpi__value` or
 * `.dash-tile__count`; `chip` a comparison chip's, `key` a small key's, `chart` the trend's.
 */
export function Skeleton({ width = "100%", size = "line", className }: { width?: string; size?: "line" | "figure" | "chart" | "chip" | "key"; className?: string }) {
  return <span className={cx("dash-skel", `dash-skel--${size}`, className)} style={{ "--w": width } as CSSProperties} aria-hidden="true" />;
}

const COUNT_MS = 720;

/** Whether a figure may count: a finite, non-zero value on the full motion tier (never under reduced motion or lite). */
function mayCount(value: number): boolean {
  return Number.isFinite(value) && value !== 0 && getMotionTier() === "full";
}

/**
 * A figure that counts up from 0 to its value once, when it first appears (720ms, ease-out), in its final width from
 * the first frame (the final text reserves the cell, so nothing around it moves). Assistive technology gets the final
 * value at once. Server HTML hides the face behind a shimmer until the page is live (dashboard.css; a fallback shows
 * the plain figure after 2.4s if scripts never run), then counts; a figure that arrives later (a streamed card, a new
 * period) counts as it mounts. Reduced motion, the lite tier and print: the figure, still.
 *
 *   <CountUp value={sales.paidSales.current} render={(v) => <Money iqd={v} wrap />} />
 */
export function CountUp({ value, render }: { value: number; render: (value: number) => ReactNode }) {
  const hydrating = useHydrating();
  const box = useRef<HTMLSpanElement>(null);
  // decided once, at mount: a client render starts from 0; server HTML keeps its figure until the effect below
  const [mountedOnClient] = useState(() => !hydrating && typeof window !== "undefined");
  const [shown, setShown] = useState(() => (mountedOnClient && mayCount(value) ? 0 : value));
  const showing = useRef(shown);
  showing.current = shown;
  // where the count of this value starts — decided once per value, so StrictMode's second effect run (development)
  // replays the same count instead of finding the face already shown
  const plan = useRef<{ value: number; from: number } | null>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    let from: number;
    if (plan.current && plan.current.value === value) from = plan.current.from;
    else {
      // the server's figure counts only while its face is still hidden (the fallback has not shown it yet)
      const face = element.querySelector<HTMLElement>(".dash-count__face");
      const hiddenFace = face ? Number.parseFloat(getComputedStyle(face).opacity) < 0.5 : false;
      from = plan.current === null ? (mountedOnClient ? showing.current : hiddenFace ? 0 : value) : showing.current;
      plan.current = { value, from };
    }
    element.setAttribute("data-counted", "");
    if (!mayCount(value) || from === value) {
      setShown(value);
      return;
    }
    setShown(from);
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      // a frame's timestamp can precede the moment the effect ran: never a negative progress (a figure below 0)
      const progress = Math.min(1, Math.max(0, (now - start) / COUNT_MS));
      const eased = 1 - (1 - progress) ** 3;
      setShown(progress >= 1 ? value : Math.round(from + (value - from) * eased));
      if (progress < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [value, mountedOnClient]);

  const counting = shown !== value;
  return (
    <span ref={box} className="dash-count">
      <span className="dash-count__reserve" aria-hidden="true">
        {render(value)}
      </span>
      <span className="dash-count__face" aria-hidden={counting || undefined}>
        {render(shown)}
      </span>
      {counting ? <span className="sr-only">{render(value)}</span> : null}
    </span>
  );
}

/**
 * The view, period, demo choice and branch the page is switching to while that navigation's loader runs (a tab or a
 * period key was followed), else null — so the tabs and keys answer the click at once and the figures show their
 * loading state instead of the old period's numbers.
 */
export function usePendingFilters(): DashboardFilters | null {
  const navigation = useNavigation();
  const location = useLocation();
  const next = navigation.location;
  if (navigation.state === "idle" || !next || next.pathname !== location.pathname || next.search === location.search) return null;
  return parseDashboardFilters(new URLSearchParams(next.search));
}

/** How a part of the to-do list reads: something urgent, something to look at, or nothing waiting. Never colour alone. */
export type Severity = "high" | "medium" | "clear";

/**
 * The change from the span before as a chip (an arrow and the percentage, or words when there is no ratio) and the
 * earlier figure: green when the change is good for the store, red-ink when it is bad, neutral for figures where
 * neither direction is good (open orders). The chip's words are read in full by screen readers.
 */
export function DeltaChip({ figure, money = false, period, good = "up" }: { figure: Figure; money?: boolean; period: DashboardPeriod; good?: "up" | "neither" }) {
  const t = useDashT();
  const f = useFormat();
  const dir = useDir();
  const label = t(`period.previous.${period}`);
  const previous = figure.previous === null ? t("card.none") : money ? f.iqd(figure.previous) : f.number(figure.previous);
  const change = compare(figure.current, figure.previous);
  let chip: string | null = null;
  let said: string | null = null;
  let icon: IconName | null = null;
  let tone: "good" | "bad" | "flat" = "flat";
  if (change) {
    if (change.delta === 0) {
      chip = t("sales.same");
      said = t("kpi.change.same", { label });
    } else if (change.ratioBps === null) {
      chip = t("kpi.noRatio");
      said = t("kpi.change.none", { label });
      icon = change.delta > 0 ? "trend-up" : "trend-down";
    } else {
      const percent = f.percent(Math.abs(change.ratioBps) / 10_000);
      chip = percent;
      said = t(change.delta > 0 ? "kpi.change.up" : "kpi.change.down", { value: `⁨${percent}⁩`, label });
      icon = change.delta > 0 ? "trend-up" : "trend-down";
      if (good === "up") tone = change.delta > 0 ? "good" : "bad";
    }
  }
  return (
    <p className="dash-delta">
      {chip ? (
        <span className="dash-delta__chip" data-tone={tone}>
          {icon ? <Icon name={icon} size={14} /> : null}
          <bdi aria-hidden="true">{chip}</bdi>
          <span className="sr-only">{said}</span>
        </span>
      ) : null}
      <span className="dash-delta__vs">{t("sales.before", { label, value: isolate(previous, dir) })}</span>
    </p>
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
