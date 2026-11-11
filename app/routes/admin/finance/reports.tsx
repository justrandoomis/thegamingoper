import { useRef } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/reports";
import { useFormat } from "~/i18n/react";
import { pick } from "~/lib/locales";
import { can } from "~/server/actor";
import { cashFlow, inventoryAsset, profitAndLoss, type CashFlow, type InventoryAsset, type ProfitAndLoss } from "~/server/services/accounting/reports.server";
import { parseRange, rangeSearch } from "~/server/services/admin/finance/types";
import { Key } from "~/ui/Key";
import { openFinance, orRespond } from "./finance.server";
import { financeMeta } from "./meta";
import { Bps, Code, Ledger, Money, Note, PageHead, PeriodName, PrintKey, RangeBar, Section, useFinT, usePrintInLight } from "./ui";

const VIEWS = ["pl", "cash", "inventory"] as const;
type View = (typeof VIEWS)[number];

/**
 * /admin/finance/reports — 10.06: profit and loss (docs/metrics.md §4: net revenue, cost of goods, commissions,
 * shipping subsidy, net profit, then the other operating costs to the operating result), cash flow (money in and out
 * of cash and bank accounts by cause), and inventory as an asset (the account against the stock it stands for).
 * finance.report.read; cost lines need cost.read and profit lines cost.read + profit.read — absent otherwise, never
 * zero; the cash flow and the inventory view need cost.read. Printable; the P&L and cash flow export as CSV.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openFinance(context, "finance.report.read");
  const params = new URL(request.url).searchParams;
  const range = parseRange(params, now);
  const view: View = (VIEWS as readonly string[]).includes(params.get("view") ?? "") ? (params.get("view") as View) : "pl";
  const withCost = can(actor, "cost.read");
  const scope = { from: range.fromMs, to: range.toMs, includeDemo: range.demo };
  const [pl, cash, inventory] = await orRespond(() =>
    Promise.all([
      view === "pl" ? profitAndLoss(db, actor, scope) : Promise.resolve(null),
      view === "cash" && withCost ? cashFlow(db, actor, scope) : Promise.resolve(null),
      view === "inventory" && withCost ? inventoryAsset(db, actor) : Promise.resolve(null),
    ]),
  );
  return { view, range, now, locale, pl, cash, inventory, withCost };
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "reports.title");

export default function ReportsPage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const { view, range, now, pl, cash, inventory, withCost } = loaderData;
  const sheet = useRef<HTMLDivElement>(null);
  usePrintInLight(sheet);
  const search = (v: View) => rangeSearch(range, { view: v === "pl" ? null : v });
  return (
    <div ref={sheet} className="fin-print">
      <PageHead
        title={t("reports.title")}
        lead={t("reports.lead")}
        actions={
          <>
            <PrintKey label={t("common.print")} />
            {view !== "inventory" && (view === "pl" || withCost) ? (
              <Key as="a" href={`/admin/finance/reports/export${rangeSearch(range, { view })}`} size="sm" icon="download-simple" download>
                {t("common.exportCsv")}
              </Key>
            ) : null}
          </>
        }
      />
      <nav aria-label={t("reports.views")} className="fin-noprint mb-4 flex flex-wrap gap-2">
        {VIEWS.map((v) => (
          <Key key={v} as={Link} to={`/admin/finance/reports${search(v)}`} size="sm" held={view === v} aria-current={view === v ? "page" : undefined}>
            {t(`reports.view.${v}`)}
          </Key>
        ))}
      </nav>
      <p className="fin-print-only type-body">
        {t(`reports.view.${view}`)} · {range.period ? <PeriodName period={range.period} /> : `${range.from} — ${range.to}`}
      </p>
      {view !== "inventory" ? <RangeBar range={range} action="/admin/finance/reports" keep={{ view: view === "pl" ? null : view }} now={now} /> : null}
      <div className="mt-5">
        {view === "pl" && pl ? <ProfitLoss pl={pl} /> : null}
        {view === "cash" ? cash ? <CashFlowView cash={cash} /> : <NeedsCost /> : null}
        {view === "inventory" ? inventory ? <InventoryView inventory={inventory} /> : <NeedsCost /> : null}
      </div>
    </div>
  );
}

function NeedsCost() {
  const t = useFinT();
  return (
    <Note icon="lock">
      <p>{t("common.needsCost")}</p>
    </Note>
  );
}

function ProfitLoss({ pl }: { pl: ProfitAndLoss }) {
  const t = useFinT();
  const f = useFormat();
  const r = pl.revenue;
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Section id="pl-revenue" title={t("pl.revenueSection")}>
        <Ledger
          className="adm-card content-start"
          rows={[
            { label: t("pl.revenue"), value: <Money iqd={r.grossIqd} />, hint: t("pl.revenueHint", { count: r.ordersRecognised }) },
            { label: t("pl.discounts"), value: <Money iqd={-r.discountsIqd} /> },
            { label: t("pl.refunds"), value: <Money iqd={-r.refundsIqd} />, hint: t("pl.refundsHint") },
            { label: t("pl.netRevenue"), value: <Money iqd={r.netIqd} />, strong: true },
            ...r.otherIncome.map((line) => ({ label: <span><Code>{line.code}</Code> {pick(line.name, f.locale)}</span>, value: <Money iqd={line.amountIqd} />, indent: true })),
          ]}
        />
      </Section>
      <Section id="pl-cost" title={t("pl.costSection")}>
        {pl.cost ? (
          <Ledger
            className="adm-card content-start"
            rows={[
              { label: t("pl.cogs"), value: <Money iqd={-pl.cost.cogsIqd} />, hint: t("pl.cogsHint") },
              ...(pl.profit ? [{ label: t("pl.grossProfit"), value: <Money iqd={pl.profit.grossIqd} />, strong: true }, { label: t("pl.grossMargin"), value: <Bps value={pl.profit.grossMarginBps} />, indent: true }] : []),
            ]}
          />
        ) : (
          <NeedsCost />
        )}
        {pl.cost && pl.cost.uncostedUnits > 0 ? (
          <Note tone="warn" icon="warning">
            <p>{t("pl.uncosted", { count: pl.cost.uncostedUnits })}</p>
          </Note>
        ) : null}
      </Section>
      <Section id="pl-expenses" title={t("pl.expensesSection")}>
        <Ledger
          className="adm-card content-start"
          rows={[
            { label: t("pl.commissions"), value: <Money iqd={-pl.expenses.commissionsIqd} /> },
            { label: t("pl.shippingCosts"), value: <Money iqd={-pl.expenses.shippingCostsIqd} /> },
            { label: t("pl.shippingIncome"), value: <Money iqd={r.shippingIncomeIqd} />, hint: t("pl.shippingIncomeHint") },
            { label: t("pl.shippingSubsidy"), value: <Money iqd={-pl.expenses.shippingSubsidyIqd} />, strong: true, hint: t("pl.shippingSubsidyHint") },
            ...(pl.profit ? [{ label: t("pl.netProfit"), value: <Money iqd={pl.profit.netIqd} />, strong: true }, { label: t("pl.netMargin"), value: <Bps value={pl.profit.netMarginBps} />, indent: true }] : []),
          ]}
        />
        {pl.expenses.shippingCostsIqd === 0 ? <p className="type-caption text-ink-2">{t("pl.noCarrierCosts")}</p> : null}
      </Section>
      <Section id="pl-operating" title={t("pl.operatingSection")}>
        <Ledger
          className="adm-card content-start"
          rows={[
            ...(pl.cost ? [{ label: t("pl.inventoryAdjustments"), value: <Money iqd={-pl.cost.inventoryAdjustmentsIqd} /> }] : []),
            { label: t("pl.cashOverShort"), value: <Money iqd={-pl.expenses.cashOverShortIqd} /> },
            ...pl.expenses.operating.map((line) => ({ label: <span><Code>{line.code}</Code> {pick(line.name, f.locale)}</span>, value: <Money iqd={-line.amountIqd} />, indent: true })),
            { label: t("pl.operatingTotal"), value: <Money iqd={-pl.expenses.operatingTotalIqd} /> },
            ...(pl.profit ? [{ label: t("pl.operatingResult"), value: <Money iqd={pl.profit.operatingIqd} />, strong: true }] : []),
          ]}
        />
        {!pl.profit ? <p className="type-caption text-ink-2">{t("common.needsProfit")}</p> : null}
      </Section>
      <div className="lg:col-span-2">
        <Note>
          <p>{t("pl.definitions")}</p>
        </Note>
      </div>
    </div>
  );
}

function CashFlowView({ cash }: { cash: CashFlow }) {
  const t = useFinT();
  const f = useFormat();
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Section id="cash-flow" title={t("cash.flows")}>
        <Ledger
          className="adm-card content-start"
          rows={[
            { label: t("cash.opening"), value: <Money iqd={cash.openingIqd} />, strong: true },
            ...cash.rows.flatMap((row) => [
              ...(row.inflowIqd ? [{ label: t(`cash.category.${row.category}`), value: <Money iqd={row.inflowIqd} signed />, indent: true, hint: t("cash.entries", { count: row.entries }) }] : []),
              ...(row.outflowIqd ? [{ label: t(`cash.category.${row.category}`), value: <Money iqd={-row.outflowIqd} />, indent: true, hint: row.inflowIqd ? undefined : t("cash.entries", { count: row.entries }) }] : []),
            ]),
            { label: t("cash.in"), value: <Money iqd={cash.inflowIqd} signed /> },
            { label: t("cash.out"), value: <Money iqd={-cash.outflowIqd} /> },
            { label: t("cash.closing"), value: <Money iqd={cash.closingIqd} />, strong: true },
          ]}
        />
        {cash.rows.length === 0 ? <p className="type-body text-ink-2">{t("cash.none")}</p> : null}
      </Section>
      <Section id="cash-accounts" title={t("cash.accounts")}>
        <Ledger
          className="adm-card content-start"
          rows={cash.accounts.map((account) => ({
            label: (
              <Link to={`/admin/finance/accounts/${account.id}`} className="adm-link">
                <Code>{account.code}</Code> {pick(account.name, f.locale)}
              </Link>
            ),
            value: <Money iqd={account.closingIqd} />,
            hint: t("cash.openedAt", { amount: f.iqd(account.openingIqd) }),
          }))}
        />
        <Note>
          <p>{t("cash.note")}</p>
        </Note>
      </Section>
    </div>
  );
}

function InventoryView({ inventory }: { inventory: InventoryAsset }) {
  const t = useFinT();
  const f = useFormat();
  return (
    <div className="grid items-start gap-5 lg:grid-cols-2">
      <Section id="inv-asset" title={t("inventory.title")}>
        <Ledger
          className="adm-card content-start"
          rows={[
            { label: t("inventory.account"), value: <Money iqd={inventory.accountIqd} />, strong: true, hint: t("inventory.accountHint") },
            { label: t("inventory.layers"), value: <Money iqd={inventory.layersIqd} />, hint: t("inventory.layersHint", { units: f.number(inventory.layerUnits) }) },
            { label: t("inventory.used"), value: <Money iqd={inventory.usedIqd} />, hint: t("inventory.usedHint", { units: f.number(inventory.usedUnits), uncosted: f.number(inventory.usedUncosted) }) },
            { label: t("inventory.shipped"), value: <Money iqd={inventory.shippedNotDeliveredIqd} />, hint: t("inventory.shippedHint") },
            { label: t("inventory.transit"), value: <Money iqd={inventory.inTransitIqd} />, hint: t("inventory.transitHint") },
            { label: t("inventory.unexplained"), value: <Money iqd={inventory.unexplainedIqd} />, strong: true, hint: t("inventory.unexplainedHint") },
          ]}
        />
        {inventory.shippedNotDeliveredUncosted > 0 ? (
          <Note tone="warn" icon="warning">
            <p>{t("pl.uncosted", { count: inventory.shippedNotDeliveredUncosted })}</p>
          </Note>
        ) : null}
      </Section>
      <Section id="inv-why" title={t("inventory.why")}>
        <Note>
          <p>{t("inventory.explain")}</p>
        </Note>
        <p className="type-body">
          <Link to="/admin/inventory/costing" className="adm-link">
            {t("inventory.toCosting")}
          </Link>
        </p>
      </Section>
    </div>
  );
}
