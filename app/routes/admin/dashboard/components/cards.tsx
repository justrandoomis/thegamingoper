/**
 * The command centre's cards (admin module 01), drawn from the view models of services/admin/dashboard/types.ts:
 * the KPI row (01.01 / 01.04: the period's figures, each with its comparison chip, a link to the list it counts and —
 * on new orders — the daily trend), the urgent tiles (01.02, raised clay only when something waits — DESIGN.md §10
 * "the relief map is the to-do list" — with a severity stripe, its words and one action), the funnel (01.03, one ink
 * series), the role cards (01.05) and the activity timeline (01.07). Every figure says "—" when it is unknown;
 * nothing here invents a 0.
 */
import { useId, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { Link } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useDir, useFormat } from "~/i18n/react";
import { formatWeekday } from "~/lib/dates";
import {
  STOCK_FIGURES,
  type AlertId,
  type AlertRow,
  type AlertTile,
  type DashboardPeriod,
  type FeedLine,
  type FunnelCard,
  type FunnelCounts,
  type InboxCard,
  type MoneyCard,
  type ResultCard,
  type SalesCard,
  type StockCard,
  type StockFigure,
  type Streamed,
} from "~/server/services/admin/dashboard/types";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";
import { TREND_DAYS, type OrdersTrend, type TrendDay } from "../trend";
import { Code, Count, CountUp, DeltaChip, DeltaLine, DemoTag, KpiCard, Money, rise, Skeleton, StreamedCard, useDashT, When, type Severity } from "./kit";

// ───────────────────────────────────────────────────────────────── urgent tiles (01.02)

const TILE_ICON: Record<AlertId, IconName> = { late_orders: "clock", unmatched_payments: "scales", low_stock: "package", critical_tickets: "lifebuoy" };

/**
 * How pressing a non-empty tile is: customers wait on late orders and urgent tickets ("high"); a mismatched statement
 * line or a low SKU wants a look ("medium"). An empty tile is "clear" — a clean desk — unless its second figure is not
 * (no urgent ticket open, but tickets past their due time: "medium").
 */
const TILE_SEVERITY: Record<AlertId, Exclude<Severity, "clear">> = { late_orders: "high", unmatched_payments: "medium", low_stock: "medium", critical_tickets: "high" };

export function tileSeverity(tile: Pick<AlertTile, "id" | "count"> & { extra?: AlertTile["extra"] }): Severity {
  if (tile.count > 0) return TILE_SEVERITY[tile.id];
  return tile.extra && tile.extra.count > 0 ? "medium" : "clear";
}

/** The orders module's late rule → its words here (keys stay clear of the words a payload scan flags: "proof"). */
const LATE_RULE_WORD: Record<string, string> = {
  proof_waiting: "transfer_waiting",
  cod_unconfirmed: "cod_unconfirmed",
  not_shipped: "not_shipped",
  not_delivered: "not_delivered",
  preorder_overdue: "preorder_overdue",
};

function TileRow({ id, row }: { id: AlertId; row: AlertRow }) {
  const t = useDashT();
  const f = useFormat();
  const ref = row.href ? (
    <Link to={row.href} className="adm-link">
      <Code>{row.label || "—"}</Code>
    </Link>
  ) : (
    <Code>{row.label || "—"}</Code>
  );
  switch (id) {
    case "late_orders":
      return (
        <>
          <div className="dash-rows__line">
            {ref}
            <Money iqd={row.amountIqd} className="type-label" />
          </div>
          <div className="dash-rows__line type-caption text-ink-2">
            <span>{row.code && LATE_RULE_WORD[row.code] ? t(`urgent.lateRules.${LATE_RULE_WORD[row.code]}`) : null}</span>
            <span className="inline-flex items-center gap-2">
              {row.isDemo ? <DemoTag /> : null}
              <When at={row.at} kind="date" />
            </span>
          </div>
        </>
      );
    case "unmatched_payments":
      return (
        <>
          <div className="dash-rows__line">
            {ref}
            <Money iqd={row.amountIqd} className="type-label" />
          </div>
          <div className="dash-rows__line type-caption text-ink-2">
            <span>{row.code ? t(`urgent.sources.${row.code}`) : null}</span>
            <When at={row.at} kind="date" />
          </div>
        </>
      );
    case "low_stock":
      return (
        <>
          <div className="dash-rows__line">
            {ref}
            <span className="type-label">{t("urgent.available", { qty: `⁨${row.qty ?? 0}⁩` })}</span>
          </div>
          {row.text ? (
            <p className="dash-clip type-caption text-ink-2 [unicode-bidi:plaintext]">
              {row.text}
            </p>
          ) : null}
        </>
      );
    case "critical_tickets":
      return (
        <>
          <div className="dash-rows__line">
            {ref}
            <span className={cx("type-label", row.code === "late" && "text-red-ink")}>{row.code ? t(`urgent.priority.${row.code}`) : null}</span>
          </div>
          {row.text ? (
            <p className="dash-clip type-caption text-ink [unicode-bidi:plaintext]">
              {row.text}
            </p>
          ) : null}
          <div className="dash-rows__line type-caption text-ink-2">
            <span className="nums">{row.at ? t("urgent.due", { at: `⁨${f.dateTime(row.at)}⁩` }) : null}</span>
            {row.isDemo ? <DemoTag /> : null}
          </div>
        </>
      );
  }
}

/**
 * One part of the to-do list: its severity (a stripe on the start edge, the icon's disc and a word — never colour
 * alone), the count of its list, the first rows, and one action that opens the list. Raised clay only when something
 * waits; an empty tile lies flat and says so.
 */
export function UrgentTile({ tile, index = 0 }: { tile: AlertTile; index?: number }) {
  const t = useDashT();
  const f = useFormat();
  const waiting = tile.count > 0;
  const shown = tile.rows.length;
  const titleId = `tile-${tile.id}`;
  const severity = tileSeverity(tile);
  return (
    <article className={cx("adm-card dash-tile dash-rise", waiting && "adm-card--act")} data-severity={severity} aria-labelledby={titleId} style={rise(index)}>
      <div className="dash-tile__head">
        <span className="dash-disc" data-severity={severity} aria-hidden="true">
          <Icon name={severity === "clear" ? "check" : TILE_ICON[tile.id]} size={18} />
        </span>
        <h3 id={titleId} className="adm-h3 dash-tile__title">
          {t(`urgent.${tile.id}.title`)}
        </h3>
        {severity !== "clear" ? (
          <span className="dash-sev" data-severity={severity}>
            {t(`urgent.severity.${severity}`)}
          </span>
        ) : null}
      </div>
      <p className="dash-tile__count type-kpi">
        <CountUp value={tile.count} render={(value) => <bdi className="nums">{f.number(value)}</bdi>} />
      </p>
      {tile.id === "unmatched_payments" && waiting ? <p className="type-caption text-ink-2">{t("urgent.unmatched_payments.hint")}</p> : null}
      {waiting && shown > 0 ? (
        <ul className="dash-rows">
          {tile.rows.map((row) => (
            <li key={row.key}>
              <TileRow id={tile.id} row={row} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">{t(`urgent.${tile.id}.none`)}</p>
      )}
      {tile.count > shown && shown > 0 ? <p className="type-caption text-ink-2">{t("urgent.more", { count: tile.count - shown })}</p> : null}
      {tile.extra && tile.extra.count > 0 ? (
        <p className="type-caption">
          <TextLink as={Link} to={tile.extra.href}>
            {t("urgent.critical_tickets.late", { count: tile.extra.count })}
          </TextLink>
        </p>
      ) : null}
      <div className="dash-tile__foot dash-noprint">
        <Key as={Link} to={tile.href} size="sm" iconEnd="arrow-right" variant={waiting ? "secondary" : "ghost"}>
          {t(`urgent.${tile.id}.open`)}
        </Key>
      </div>
    </article>
  );
}

/**
 * A tile while its module's list is read: the tile's own frame, icon and title, and a shimmer in each line of an empty
 * tile — the count, its sentence and the key — at those lines' own heights, so the tile that replaces it is never
 * shorter (review of client note 12: CLS 0). It does not rise: the tile that replaces it does (`index` is kept for
 * callers that pass the slot).
 */
export function TileLoading({ id }: { id: AlertId; index?: number }) {
  const t = useDashT();
  return (
    <div className="adm-card dash-tile dash-loading" aria-busy="true">
      <div className="dash-tile__head">
        <span className="dash-disc" aria-hidden="true">
          <Icon name={TILE_ICON[id]} size={18} />
        </span>
        <p className="adm-h3 dash-tile__title">{t(`urgent.${id}.title`)}</p>
      </div>
      <p className="dash-tile__count type-kpi">
        <Skeleton width="3ch" size="figure" />
      </p>
      <p className="type-body">
        <Skeleton width="85%" />
      </p>
      <div className="dash-tile__foot dash-noprint">
        <Skeleton width="9rem" size="key" />
      </div>
      <span className="sr-only">{t("card.loading")}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── KPI row (01.01)

export type KpiId = "paidSales" | "ordersPlaced" | "openOrders" | "averageBasket" | "net";

const KPI_ICON: Record<KpiId, IconName> = { paidSales: "money", ordersPlaced: "receipt", openOrders: "hourglass", averageBasket: "shopping-bag", net: "scales" };

/** Where each figure's own list is, for this employee on this page (null: the figure is shown without a link). */
export type KpiLinks = {
  /** The sales report for the same days and demo choice: paid sales and the average basket are its own figures. */
  sales: string | null;
  /** The orders list for the same days — only where it lists exactly the orders counted (demo rows, no branch). */
  orders: string | null;
  /** The orders list of the open statuses — same rule. */
  open: string | null;
  /** Profit and loss for the same days and demo choice. */
  net: string | null;
};

/**
 * An amount for a KPI: the figure in the display face, its currency smaller after it (Design v2.1 G7). The isolate
 * takes the page's direction: a negative starts with a left-to-right mark ("‎−"), which would otherwise turn it left to
 * right and put the currency before the figure in Arabic.
 */
export function KpiMoney({ iqd }: { iqd: number | null }) {
  const f = useFormat();
  const dir = useDir();
  if (iqd === null || !Number.isFinite(iqd)) return <Money iqd={null} />;
  const text = f.iqd(Math.abs(iqd));
  // formatMoney writes "<figure><no-break space><currency>" in every language (lib/money.ts)
  const gap = text.search(/[\s  ]/u);
  const figure = gap >= 0 ? text.slice(0, gap) : text;
  const currency = gap >= 0 ? text.slice(gap + 1) : "";
  return (
    <bdi dir={dir} className={cx("nums dash-money", iqd < 0 && "text-red-ink")}>
      {iqd < 0 ? "‎−" : null}
      {figure}
      {currency ? (
        <>
          {" "}
          <span className="dash-money__cur">{currency}</span>
        </>
      ) : null}
    </bdi>
  );
}

function KpiHead({ id, label, demo }: { id: KpiId; label: ReactNode; demo: boolean }) {
  return (
    <div className="dash-kpi__head">
      <span className="dash-kpi__icon" aria-hidden="true">
        <Icon name={KPI_ICON[id]} size={18} />
      </span>
      <p className="dash-kpi__label">{label}</p>
      {demo ? <DemoTag /> : null}
    </div>
  );
}

/**
 * How wide a KPI figure line is, for the tile to fit it on ONE line (dashboard.css `.dash-kpi__value`): `--fig-em` ems
 * of the display face — Kufam's digits advance 0.62em, separators 0.3em, a minus 0.77em, the gap before the currency
 * 0.25em — plus `--fig-px` pixels that do not scale: the currency at its 12px floor (≈5px a letter in Arabic script, 7.3
 * in Latin) and, on a link, its 16px arrow and gap. A long amount ("312,450,000 د.ع") then takes a smaller size instead
 * of breaking inside its currency on a narrow tile.
 */
export function figureFit(text: string, linked: boolean): CSSProperties {
  const clean = text.replace(/[\u200e\u200f\u061c\u2066-\u2069]/gu, "");
  const gap = clean.search(/[\s\u00a0\u202f]/u);
  const figure = gap >= 0 ? clean.slice(0, gap) : clean;
  const currency = gap >= 0 ? clean.slice(gap + 1).trim() : "";
  let em = currency ? 0.25 : 0;
  for (const char of figure) em += /\p{Nd}/u.test(char) ? 0.62 : /[,.\u066b\u066c']/u.test(char) ? 0.3 : char === "−" || char === "-" ? 0.77 : 0.65;
  const px = (/[A-Za-z]/u.test(currency) ? 7.3 : 5) * currency.length + (linked ? 20 : 0);
  return { "--fig-em": Math.max(em, 0.62).toFixed(2), "--fig-px": `${Math.round(px)}px` } as CSSProperties;
}

/**
 * One KPI tile's content: the label, the figure (counting up once; a link to the list it counts when there is one —
 * always one line, sized to the tile by `figureFit`), the comparison chip, the definition, and anything the tile adds
 * (the trend).
 */
export function KpiBody({
  id,
  label,
  figure,
  figureText,
  href,
  openLabel,
  delta,
  hint,
  demo = false,
  extra,
  children,
}: {
  id: KpiId;
  label: string;
  figure: ReactNode;
  /** The figure as words, for the link's accessible name. */
  figureText: string;
  href?: string | null;
  openLabel?: string;
  delta?: ReactNode;
  hint?: ReactNode;
  demo?: boolean;
  extra?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <>
      <KpiHead id={id} label={label} demo={demo} />
      <p className="dash-kpi__value" style={figureFit(figureText, Boolean(href))}>
        {href ? (
          <Link to={href} prefetch="intent" className="dash-kpi__link" aria-label={`${label}: ${figureText} — ${openLabel ?? ""}`}>
            {figure}
            <Icon name="arrow-right" size={16} className="dash-kpi__go" />
          </Link>
        ) : (
          figure
        )}
      </p>
      {delta}
      {extra}
      {hint ? <p className="dash-kpi__hint">{hint}</p> : null}
      {children}
    </>
  );
}

/**
 * A KPI tile while its figure is computed: its label and definition, a shimmer for the figure and its comparison chip
 * — each at its line's own height — and, on new orders, the trend's place (`trend`), so the row that replaces it keeps
 * its height and nothing below moves (review of client note 12: CLS 0).
 */
export function KpiSkeleton({ id, label, hint, trend = false }: { id: KpiId; label: string; hint?: ReactNode; trend?: boolean }) {
  const t = useDashT();
  return (
    <div className="dash-kpi__body dash-loading" aria-busy="true">
      <KpiHead id={id} label={label} demo={false} />
      <p className="dash-kpi__value">
        <Skeleton width="62%" size="figure" />
      </p>
      <p className="dash-delta">
        <Skeleton width="48%" size="chip" />
      </p>
      {hint ? <p className="dash-kpi__hint">{hint}</p> : null}
      {trend ? <TrendSkeleton /> : null}
      <span className="sr-only">{t("card.loading")}</span>
    </div>
  );
}

/** A KPI tile whose figure could not be computed: said so, never a 0, with a way to load the page again. */
export function KpiFailed({ id, label }: { id: KpiId; label: string }) {
  const t = useDashT();
  return (
    <div className="dash-kpi__body" role="status">
      <KpiHead id={id} label={label} demo={false} />
      <p className="flex items-start gap-2 type-body text-ink">
        <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0 text-ink-2" />
        <span>{t("card.failed")}</span>
      </p>
    </div>
  );
}

/**
 * The period's figures as one row of tiles. Each tile's frame stays on screen across views and periods; what is
 * inside streams in (a skeleton, then the figure counting up). `here` is the page's search: a new one starts each
 * tile's loading state at once.
 */
export function KpiRow({
  sales,
  result,
  trend,
  links,
  period,
  here,
}: {
  sales?: Promise<Streamed<SalesCard>>;
  result?: Promise<Streamed<ResultCard>>;
  trend?: Promise<Streamed<OrdersTrend>>;
  links: KpiLinks;
  period: DashboardPeriod;
  here: string;
}) {
  const t = useDashT();
  const f = useFormat();
  const tiles: { id: KpiId; node: ReactNode }[] = [];
  const money = (value: number | null) => (value === null ? t("card.none") : f.iqd(value));
  const count = (value: number | null) => (value === null ? t("card.none") : f.number(value));

  if (sales) {
    // the demo choice is said once, beside the row's title (admin-home), not squeezed into every tile's head
    const tile = (id: Exclude<KpiId, "net">, hint: string, body: (data: SalesCard) => ReactNode) => ({
      id,
      node: (
        <StreamedCard
          key={`${id}${here}`}
          resolve={sales}
          fallback={<KpiSkeleton id={id} label={t(`sales.${id}`)} hint={hint} trend={id === "ordersPlaced" && Boolean(trend)} />}
          failed={<KpiFailed id={id} label={t(`sales.${id}`)} />}
        >
          {(data) => <div className="dash-kpi__body dash-arrive">{body(data)}</div>}
        </StreamedCard>
      ),
    });
    tiles.push(
      tile("paidSales", t("sales.paidSalesHint"), (data) => (
        <KpiBody
          id="paidSales"
          label={t("sales.paidSales")}
          figure={<CountUp value={data.paidSales.current ?? 0} render={(value) => <KpiMoney iqd={data.paidSales.current === null ? null : value} />} />}
          figureText={money(data.paidSales.current)}
          href={links.sales}
          openLabel={t("kpi.open.paidSales")}
          delta={<DeltaChip figure={data.paidSales} money period={data.spans.period} />}
          hint={t("sales.paidSalesHint")}
        />
      )),
      tile("ordersPlaced", t("sales.ordersPlacedHint"), (data) => (
        <KpiBody
          id="ordersPlaced"
          label={t("sales.ordersPlaced")}
          figure={<CountUp value={data.ordersPlaced.current ?? 0} render={(value) => (data.ordersPlaced.current === null ? <Count value={null} /> : <bdi className="nums">{f.number(value)}</bdi>)} />}
          figureText={count(data.ordersPlaced.current)}
          href={links.orders}
          openLabel={t("kpi.open.ordersPlaced")}
          delta={<DeltaChip figure={data.ordersPlaced} period={data.spans.period} />}
          hint={t("sales.ordersPlacedHint")}
        >
          {trend ? (
            <StreamedCard key={`trend${here}`} resolve={trend} fallback={<TrendSkeleton />} failed={<p className="dash-trend__failed">{t("trend.failed")}</p>}>
              {(days) => <TrendChart trend={days} />}
            </StreamedCard>
          ) : null}
        </KpiBody>
      )),
      tile("openOrders", t("sales.openOrdersHint"), (data) => (
        <KpiBody
          id="openOrders"
          label={t("sales.openOrders")}
          figure={<CountUp value={data.openOrders.current ?? 0} render={(value) => (data.openOrders.current === null ? <Count value={null} /> : <bdi className="nums">{f.number(value)}</bdi>)} />}
          figureText={count(data.openOrders.current)}
          href={links.open}
          openLabel={t("kpi.open.openOrders")}
          delta={<DeltaChip figure={data.openOrders} period={data.spans.period} good="neither" />}
          hint={t("sales.openOrdersHint")}
        />
      )),
      tile("averageBasket", t("sales.averageBasketHint"), (data) => (
        <KpiBody
          id="averageBasket"
          label={t("sales.averageBasket")}
          figure={data.averageBasket.current === null ? <span className="dash-kpi__none">{t("sales.none")}</span> : <CountUp value={data.averageBasket.current} render={(value) => <KpiMoney iqd={value} />} />}
          figureText={data.averageBasket.current === null ? t("sales.none") : money(data.averageBasket.current)}
          href={data.averageBasket.current === null ? null : links.sales}
          openLabel={t("kpi.open.averageBasket")}
          delta={<DeltaChip figure={data.averageBasket} money period={data.spans.period} />}
          hint={t("sales.averageBasketHint")}
        />
      )),
    );
  }
  if (result) {
    tiles.push({
      id: "net",
      node: (
        <StreamedCard key={`net${here}`} resolve={result} fallback={<KpiSkeleton id="net" label={t("sales.net")} hint={t("sales.netHint")} />} failed={<KpiFailed id="net" label={t("sales.net")} />}>
          {(data) => (
            <div className="dash-kpi__body dash-arrive">
              <NetBody data={data} href={links.net} />
            </div>
          )}
        </StreamedCard>
      ),
    });
  }
  if (tiles.length === 0) return null;
  return (
    <ul className="dash-kpis" data-count={tiles.length}>
      {tiles.map((tile, index) => (
        <li key={tile.id} className="adm-card dash-kpi dash-rise" data-kpi={tile.id} style={rise(index)}>
          {tile.node}
        </li>
      ))}
    </ul>
  );
}

function NetBody({ data, href }: { data: ResultCard; href: string | null }) {
  const t = useDashT();
  const f = useFormat();
  if (data.perBranch) {
    return <KpiBody id="net" label={t("sales.net")} figure={<span className="dash-kpi__none">{t("card.none")}</span>} figureText={t("card.none")} hint={t("sales.perBranch")} />;
  }
  const current = data.current;
  const figure = { current: current?.netIqd ?? null, previous: data.previous?.netIqd ?? null };
  return (
    <KpiBody
      id="net"
      label={t("sales.net")}
      figure={figure.current === null ? <Money iqd={null} /> : <CountUp value={figure.current} render={(value) => <KpiMoney iqd={value} />} />}
      figureText={figure.current === null ? t("card.none") : f.iqd(figure.current)}
      href={href}
      openLabel={t("kpi.open.net")}
      delta={<DeltaChip figure={figure} money period={data.spans.period} />}
      hint={t("sales.netHint")}
      extra={
        <>
          {current && current.netMarginBps !== null ? <p className="type-caption text-ink">{t("sales.netRate", { percent: `⁨${f.percent(current.netMarginBps / 10_000)}⁩` })}</p> : null}
          {current && current.uncostedUnits > 0 ? (
            <p className="flex items-start gap-1 type-caption text-ink">
              <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-warn" />
              <span>{t("sales.unknownUnits", { count: current.uncostedUnits })}</span>
            </p>
          ) : null}
        </>
      }
    />
  );
}

// The 1.0 KPI cards, kept for callers outside the row (each is one flat card of its own).

export function SalesKpis({ data }: { data: SalesCard }) {
  const t = useDashT();
  const period = data.spans.period;
  return (
    <>
      <KpiCard
        label={t("sales.paidSales")}
        value={<Money iqd={data.paidSales.current} wrap />}
        delta={<DeltaLine figure={data.paidSales} money period={period} />}
        hint={t("sales.paidSalesHint")}
      />
      <KpiCard label={t("sales.ordersPlaced")} value={<Count value={data.ordersPlaced.current} />} delta={<DeltaLine figure={data.ordersPlaced} period={period} />} hint={t("sales.ordersPlacedHint")} />
      <KpiCard label={t("sales.openOrders")} value={<Count value={data.openOrders.current} />} delta={<DeltaLine figure={data.openOrders} period={period} />} hint={t("sales.openOrdersHint")} />
      <KpiCard
        label={t("sales.averageBasket")}
        value={data.averageBasket.current === null ? <span className="text-ink-2">{t("sales.none")}</span> : <Money iqd={data.averageBasket.current} wrap />}
        delta={<DeltaLine figure={data.averageBasket} money period={period} />}
        hint={t("sales.averageBasketHint")}
      />
    </>
  );
}

export function ResultKpi({ data }: { data: ResultCard }) {
  const t = useDashT();
  const f = useFormat();
  if (data.perBranch) return <KpiCard label={t("sales.net")} value={<span className="text-ink-2">{t("card.none")}</span>} hint={t("sales.perBranch")} />;
  const current = data.current;
  const figure = { current: current?.netIqd ?? null, previous: data.previous?.netIqd ?? null };
  return (
    <KpiCard
      label={t("sales.net")}
      value={<Money iqd={figure.current} wrap />}
      delta={<DeltaLine figure={figure} money period={data.spans.period} />}
      hint={t("sales.netHint")}
    >
      {current && current.netMarginBps !== null ? <p className="type-caption text-ink">{t("sales.netRate", { percent: `⁨${f.percent(current.netMarginBps / 10_000)}⁩` })}</p> : null}
      {current && current.uncostedUnits > 0 ? (
        <p className="flex items-start gap-1 type-caption text-ink">
          <Icon name="warning" size={16} className="mt-0.5 shrink-0 text-warn" />
          <span>{t("sales.unknownUnits", { count: current.uncostedUnits })}</span>
        </p>
      ) : null}
    </KpiCard>
  );
}

// ───────────────────────────────────────────────────────────────── the daily trend (01.01)

/**
 * Orders placed per day — a sparkline of thin columns, oldest at the start, today (still running) in ink, the days
 * before in the de-emphasis grey; a zero day is a hairline tick, never a missing column. Pointing at the chart or
 * moving with the arrow keys reads one day on the line under it; a table holds every value for screen readers; the
 * link opens the daily report it comes from (DESIGN.md §10 "Charts": ink series on a hairline, no gradients).
 */
export function TrendChart({ trend }: { trend: OrdersTrend }) {
  const t = useDashT();
  const f = useFormat();
  const id = useId();
  const plot = useRef<HTMLOListElement | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const days = trend.days;
  const peak = Math.max(1, ...days.map((day) => day.placed));
  const first = days[0];
  const last = days.length - 1;
  const none = days.every((day) => day.placed === 0);

  const dayName = (day: TrendDay) => (day.today ? t("trend.today") : `${formatWeekday(day.at, f.locale)} ${f.date(day.at, "medium")}`);
  const read = (day: TrendDay) => `${dayName(day)}: ${t("trend.orders", { count: day.placed })}`;

  const nearest = (clientX: number) => {
    const columns = plot.current?.children;
    if (!columns) return;
    let best = 0;
    let distance = Number.POSITIVE_INFINITY;
    for (let index = 0; index < columns.length; index++) {
      const box = columns[index].getBoundingClientRect();
      const gap = Math.abs(box.left + box.width / 2 - clientX);
      if (gap < distance) {
        distance = gap;
        best = index;
      }
    }
    setActive(best);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
    const at = active ?? last;
    let next: number | null = null;
    if (event.key === "ArrowRight") next = at + (rtl ? -1 : 1);
    else if (event.key === "ArrowLeft") next = at + (rtl ? 1 : -1);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    if (next === null) return;
    event.preventDefault();
    setActive(Math.min(Math.max(next, 0), last));
  };

  if (days.length === 0) return null;
  const lastDays = t("trend.window", { count: f.number(days.length) });
  return (
    <figure className="dash-trend">
      <div
        className="dash-trend__plot"
        tabIndex={0}
        role="group"
        aria-label={`${t("trend.title")} — ${lastDays}`}
        aria-describedby={`${id}-hint`}
        onPointerMove={(event) => nearest(event.clientX)}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive((value) => value ?? last)}
        onBlur={() => setActive(null)}
        onKeyDown={onKeyDown}
      >
        <ol ref={plot} className="dash-trend__cols" aria-hidden="true">
          {days.map((day, index) => (
            <li key={day.day} className="dash-trend__col" data-today={day.today ? "" : undefined} data-active={active === index ? "" : undefined}>
              <span className="dash-trend__bar" data-zero={day.placed === 0 ? "" : undefined} style={{ "--v": day.placed / peak, "--i": index } as CSSProperties} />
            </li>
          ))}
        </ol>
        {none ? <span className="dash-trend__empty">{t("trend.none")}</span> : null}
      </div>
      {/* one line under the columns: the window (or the day being read) and the report it comes from */}
      <figcaption className="dash-trend__foot">
        <span className="dash-trend__read" aria-live="polite" title={first ? `${f.date(first.at, "medium")} – ${t("home.today")}` : undefined}>
          {active !== null && days[active] ? <span className="dash-trend__now">{read(days[active])}</span> : lastDays}
        </span>
        <TextLink as={Link} to={trend.href} className="dash-noprint">
          {t("trend.open")}
        </TextLink>
      </figcaption>
      <span id={`${id}-hint`} className="sr-only">
        {t("trend.hint")}
      </span>
      <table className="sr-only">
        <caption>{t("trend.table")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("trend.col.day")}</th>
            <th scope="col">{t("trend.col.orders")}</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.day}>
              <th scope="row">{day.today ? t("trend.today") : f.date(day.at, "medium")}</th>
              <td>{f.number(day.placed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/**
 * The trend's place while the daily report is read: the chart's height, then its foot line — the window it covers and
 * the report link's own box (kept invisible), which wrap exactly as the trend's own foot does — so the trend that
 * replaces it is the same height at every width and nothing below moves.
 */
export function TrendSkeleton() {
  const t = useDashT();
  const f = useFormat();
  return (
    <div className="dash-trend dash-loading" aria-hidden="true">
      <Skeleton size="chart" />
      <div className="dash-trend__foot">
        <span className="dash-trend__read">{t("trend.window", { count: f.number(TREND_DAYS) })}</span>
        <TextLink as="span" className="dash-trend__ghost">
          {t("trend.open")}
        </TextLink>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── funnel (01.03)

const STEPS = ["carts", "orders", "paid", "delivered"] as const;

function FunnelSteps({ channel, current, previous, label }: { channel: "web" | "counter"; current: FunnelCounts; previous: FunnelCounts; label: string }) {
  const t = useDashT();
  const f = useFormat();
  const steps = STEPS.filter((step) => step !== "carts" || current.carts !== null);
  const top = Math.max(1, ...steps.map((step) => current[step] ?? 0));
  return (
    <div className="grid gap-3">
      <h3 className="adm-h3">{t(`funnel.${channel}`)}</h3>
      <ol className="dash-steps" aria-label={t("funnel.chart", { channel: t(`funnel.${channel}`) })}>
        {steps.map((step, index) => {
          const value = current[step] ?? 0;
          const before = index > 0 ? (current[steps[index - 1]] ?? 0) : null;
          const share = before !== null && before > 0 ? f.percent(value / before) : null;
          return (
            <li key={step} className="dash-step">
              <span className="dash-step__label type-body text-ink">{t(`funnel.steps.${step}`)}</span>
              <span className="dash-bar" aria-hidden="true">
                {value > 0 ? <span className="dash-bar__fill" style={{ inlineSize: `${Math.max(0.5, Math.round((value / top) * 1000) / 10)}%`, "--i": index } as CSSProperties} /> : null}
              </span>
              <span className="dash-step__value type-label nums text-ink">
                <bdi>{f.number(value)}</bdi>
              </span>
              <span className="dash-step__note type-caption text-ink-2">
                {share ? <span>{t("funnel.share", { percent: `⁨${share}⁩` })}</span> : null}
                <span>{t("funnel.previous", { label, value: `⁨${f.number(previous[step] ?? 0)}⁩` })}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const nothingIn = (counts: FunnelCounts) => (counts.carts ?? 0) + counts.orders + counts.paid + counts.delivered === 0;

export function FunnelView({ data }: { data: FunnelCard }) {
  const t = useDashT();
  const label = t(`period.previous.${data.spans.period}`);
  const empty = (data.web ? (data.web.current.carts ?? 0) + data.web.current.orders : 0) + data.counter.current.orders === 0;
  // nothing now and nothing in the span before: the empty steps would only repeat zeros — the sentence says it
  const blank = empty && (!data.web || nothingIn(data.web.previous)) && nothingIn(data.counter.previous);
  return (
    <div className="adm-card dash-arrive">
      <div className="dash-funnel">
        <div className="grid gap-6">
          {empty ? (
            <p className="dash-empty">
              <Icon name="funnel" size={18} />
              <span>{t("funnel.empty")}</span>
            </p>
          ) : null}
          {!blank && data.web ? <FunnelSteps channel="web" current={data.web.current} previous={data.web.previous} label={label} /> : null}
          {!blank ? <FunnelSteps channel="counter" current={data.counter.current} previous={data.counter.previous} label={label} /> : null}
        </div>
        <ul className="dash-notes">
          <li>
            <Icon name="info" size={16} />
            <span>{t("funnel.visits")}</span>
          </li>
          <li>
            <Icon name="info" size={16} />
            <span>{t("funnel.device")}</span>
          </li>
          <li>
            <Icon name="info" size={16} />
            <span>{t("funnel.channel")}</span>
          </li>
          <li>
            <Icon name="info" size={16} />
            <span>{t("funnel.counterNote")}</span>
          </li>
          {!data.demo ? (
            <li>
              <Icon name="info" size={16} />
              <span>{t("funnel.demoCarts")}</span>
            </li>
          ) : null}
          {data.branch ? (
            <li>
              <Icon name="info" size={16} />
              <span>{t("funnel.branch")}</span>
            </li>
          ) : null}
        </ul>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── role cards (01.05)

function FigureRow({ label, hint, value, count, href }: { label: string; hint?: string; value: ReactNode; count?: number; href?: string | null }) {
  const t = useDashT();
  return (
    <div>
      <dt className="grid gap-0.5">
        {href ? (
          <Link to={href} className="adm-link">
            {label}
          </Link>
        ) : (
          <span>{label}</span>
        )}
        {hint ? <span className="type-caption text-ink-2">{hint}</span> : null}
      </dt>
      <dd className="grid justify-items-end gap-0.5 text-end">
        <span className="nums text-ink">{value}</span>
        {count !== undefined ? <span className="type-caption text-ink-2">{t("money.count", { count })}</span> : null}
      </dd>
    </div>
  );
}

export function MoneyFigures({ data }: { data: MoneyCard }) {
  const t = useDashT();
  return (
    <div className="adm-card dash-arrive">
      <dl className="dash-figures">
        <FigureRow label={t("money.cod")} hint={t("money.codHint")} value={<Money iqd={data.codOutstanding.iqd} />} count={data.codOutstanding.count} href={data.links.cod} />
        <FigureRow label={t("money.transfers")} hint={t("money.transfersHint")} value={<Money iqd={data.transfersAwaiting.iqd} />} count={data.transfersAwaiting.count} href={data.links.transfers} />
        <FigureRow label={t("money.refunds")} value={<Money iqd={data.refundsPending.iqd} />} count={data.refundsPending.count} href={data.links.refunds} />
        {data.walletLiability !== null ? <FigureRow label={t("money.wallet")} hint={t("money.walletHint")} value={<Money iqd={data.walletLiability} />} href={data.links.wallet} /> : null}
      </dl>
      <p className="type-caption text-ink-2">{t("money.storeWide")}</p>
    </div>
  );
}

/**
 * The inventory module's figures, each opening its list only where that list counts the same records (the service's
 * `links`). `withoutLow`: the page already shows the low-stock tile, whose number is the stock list's own — the
 * overview's count of active SKUs would be a second, different "low" on the same page.
 */
export function StockFigures({ data, withoutLow = false }: { data: StockCard; withoutLow?: boolean }) {
  const t = useDashT();
  const values: Record<StockFigure, number | null> = {
    skus: data.skusInStock,
    available: data.available,
    incoming: data.incoming,
    low: withoutLow ? null : data.low,
    out: data.out,
    oversold: data.oversold,
    belowReorder: data.belowReorder,
    counts: data.countsToApprove,
    transfers: data.transfersInTransit,
    expiring: data.reservationsExpiring,
    toPack: data.toPack,
  };
  return (
    <div className="adm-card dash-arrive">
      <dl className="dash-figures">
        {STOCK_FIGURES.filter((key) => values[key] !== null).map((key) => (
          <FigureRow key={key} label={t(`stock.${key}`)} value={<Count value={values[key]} />} href={data.links[key]} />
        ))}
      </dl>
    </div>
  );
}

export function InboxFigures({ data }: { data: InboxCard }) {
  const t = useDashT();
  const rows: { key: string; value: number | null; href: string }[] = [
    { key: "needsReply", value: data.needsReply, href: "/admin/support?view=needs_reply" },
    { key: "unassigned", value: data.unassigned, href: "/admin/support?view=unassigned" },
    { key: "late", value: data.late, href: "/admin/support?view=late" },
    { key: "escalated", value: data.escalatedToMe, href: "/admin/support?view=escalated_me" },
    { key: "handoffs", value: data.handoffs, href: "/admin/support?view=handoffs" },
    { key: "repairs", value: data.repairs, href: "/admin/support?view=repairs" },
  ];
  return (
    <div className="adm-card dash-arrive">
      <dl className="dash-figures">
        {rows
          .filter((row) => row.value !== null)
          .map((row) => (
            <FigureRow key={row.key} label={t(`inbox.${row.key}`)} value={<Count value={row.value} />} href={row.href} />
          ))}
      </dl>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── activity (01.07)

/** The kind of a line, as a small mark beside its dot (never the only cue: the sentence says what happened). */
const FEED_ICON: Record<FeedLine["kind"], IconName> = { price: "tag", return: "arrow-u-up-left", approval: "seal-check" };

export function ActivityList({ lines }: { lines: readonly FeedLine[] }) {
  const t = useDashT();
  const dir = useDir();
  return (
    <ol className="dash-feed">
      {lines.map((line, index) => {
        const who = line.actor.system ? t("activity.system") : (line.actor.label ?? t("activity.customer"));
        const record = line.record.label ? <Code>{line.record.label}</Code> : <span>{t(`activity.records.${line.record.entity}`)}</span>;
        return (
          <li key={line.id} data-actor={line.actor.system ? "system" : "person"} data-kind={line.kind} className="dash-rise" style={rise(index)}>
            <p className="dash-feed__line type-body text-ink">
              <Icon name={FEED_ICON[line.kind]} size={16} className="dash-feed__kind" />
              <span className="type-strong">
                <bdi>{who}</bdi>
              </span>
              <span>{t(`activity.actions.${line.action}`)}</span>
              {line.record.href ? (
                <Link to={line.record.href} className="adm-link">
                  {record}
                </Link>
              ) : (
                record
              )}
            </p>
            {line.price && (line.price.fromIqd !== null || line.price.toIqd !== null) ? (
              <p className="type-caption text-ink">
                {t("activity.price")}: <Money iqd={line.price.fromIqd} /> {dir === "rtl" ? "←" : "→"} <Money iqd={line.price.toIqd} />
              </p>
            ) : null}
            {line.reason ? (
              <p className="type-caption text-ink-2">
                <bdi>{t("activity.reason", { reason: line.reason })}</bdi>
              </p>
            ) : null}
            <p className="type-caption text-ink-2">
              <When at={line.at} />
            </p>
          </li>
        );
      })}
    </ol>
  );
}
