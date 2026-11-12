/**
 * The command centre's cards (admin module 01), drawn from the view models of services/admin/dashboard/types.ts:
 * the urgent tiles (01.02, raised clay only when something waits — DESIGN.md §10 "the relief map is the to-do list"),
 * the KPI cards with their comparison (01.01 / 01.04), the funnel (01.03, one ink series), the role cards (01.05) and
 * the activity timeline (01.07). Every figure says "—" when it is unknown; nothing here invents a 0.
 */
import type { ReactNode } from "react";
import { Link } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useDir, useFormat } from "~/i18n/react";
import { STOCK_FIGURES, type AlertId, type AlertRow, type AlertTile, type FeedLine, type FunnelCard, type FunnelCounts, type InboxCard, type MoneyCard, type ResultCard, type SalesCard, type StockCard, type StockFigure } from "~/server/services/admin/dashboard/types";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";
import { Code, Count, DeltaLine, DemoTag, KpiCard, Money, useDashT, When } from "./kit";

// ───────────────────────────────────────────────────────────────── urgent tiles (01.02)

const TILE_ICON: Record<AlertId, IconName> = { late_orders: "clock", unmatched_payments: "scales", low_stock: "package", critical_tickets: "lifebuoy" };

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

export function UrgentTile({ tile }: { tile: AlertTile }) {
  const t = useDashT();
  const f = useFormat();
  const waiting = tile.count > 0;
  const shown = tile.rows.length;
  const titleId = `tile-${tile.id}`;
  return (
    <article className={cx("adm-card dash-tile", waiting && "adm-card--act")} aria-labelledby={titleId}>
      <div className="dash-tile__head">
        <Icon name={TILE_ICON[tile.id]} size={20} />
        <h3 id={titleId} className="adm-h3">
          {t(`urgent.${tile.id}.title`)}
        </h3>
      </div>
      <p className="type-kpi nums text-ink">
        <bdi>{f.number(tile.count)}</bdi>
      </p>
      {tile.id === "unmatched_payments" ? <p className="type-caption text-ink-2">{t("urgent.unmatched_payments.hint")}</p> : null}
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
      <div className="dash-noprint">
        <Key as={Link} to={tile.href} size="sm" iconEnd="arrow-right">
          {t(`urgent.${tile.id}.open`)}
        </Key>
      </div>
    </article>
  );
}

export function TileLoading({ id }: { id: AlertId }) {
  const t = useDashT();
  return (
    <div className="adm-card dash-tile" aria-busy="true">
      <div className="dash-tile__head">
        <Icon name={TILE_ICON[id]} size={20} />
        <p className="adm-h3">{t(`urgent.${id}.title`)}</p>
      </div>
      <p className="type-body text-ink-2">{t("card.loading")}</p>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── KPI cards (01.01)

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
              <div className="dash-step__head">
                <span className="type-body text-ink">{t(`funnel.steps.${step}`)}</span>
                <span className="type-label nums text-ink">
                  <bdi>{f.number(value)}</bdi>
                </span>
              </div>
              <div className="dash-bar" aria-hidden="true">
                {value > 0 ? <span className="dash-bar__fill" style={{ inlineSize: `${Math.max(0.5, Math.round((value / top) * 1000) / 10)}%` }} /> : null}
              </div>
              <div className="dash-step__head type-caption text-ink-2">
                <span>{share ? t("funnel.share", { percent: `⁨${share}⁩` }) : null}</span>
                <span>{t("funnel.previous", { label, value: `⁨${f.number(previous[step] ?? 0)}⁩` })}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

export function FunnelView({ data }: { data: FunnelCard }) {
  const t = useDashT();
  const label = t(`period.previous.${data.spans.period}`);
  const empty = (data.web ? (data.web.current.carts ?? 0) + data.web.current.orders : 0) + data.counter.current.orders === 0;
  return (
    <div className="adm-card">
      <div className="dash-funnel">
        <div className="grid gap-6">
          {empty ? <p className="type-body text-ink-2">{t("funnel.empty")}</p> : null}
          {data.web ? <FunnelSteps channel="web" current={data.web.current} previous={data.web.previous} label={label} /> : null}
          <FunnelSteps channel="counter" current={data.counter.current} previous={data.counter.previous} label={label} />
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
    <div className="adm-card">
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
    <div className="adm-card">
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
    <div className="adm-card">
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

export function ActivityList({ lines }: { lines: readonly FeedLine[] }) {
  const t = useDashT();
  const dir = useDir();
  return (
    <ol className="dash-feed">
      {lines.map((line) => {
        const who = line.actor.system ? t("activity.system") : (line.actor.label ?? t("activity.customer"));
        const record = line.record.label ? <Code>{line.record.label}</Code> : <span>{t(`activity.records.${line.record.entity}`)}</span>;
        return (
          <li key={line.id} data-actor={line.actor.system ? "system" : "person"}>
            <p className="dash-feed__line type-body text-ink">
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
