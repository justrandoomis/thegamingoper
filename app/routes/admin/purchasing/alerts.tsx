import { Link, useLocation } from "react-router";

import type { Route } from "./+types/alerts";
import { useDir, useFormat } from "~/i18n/react";
import { listAlerts, parseAlertFilters, type Alert } from "~/server/services/admin/purchasing/alerts.server";
import { ALERT_KINDS } from "~/server/services/admin/purchasing/rules";
import { purchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, LinkChips, Minor, PageHead, Section, StateTag, When, usePurT, withSearch } from "./components/kit";
import { purchasingMeta } from "./meta";
import { openPurchasing } from "./purchasing.server";

/**
 * /admin/purchasing/alerts — variance alerts (09.07): invoices billing more than was received or at another price
 * (cost.read), units refused at inspection, lines received beyond the order, orders closed short, late orders. Read from
 * the records — an alert goes away when its cause is dealt with. Mobile-first cards, each with what to do next.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, ["purchasing.po.read", "purchasing.invoice.manage", "purchasing.claim.manage"]);
  const filters = parseAlertFilters(new URL(request.url).searchParams);
  return { page: await listAlerts(db, actor, filters, locale, now), filters, access: purchasingAccess(actor) };
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "alerts.title");

export default function Alerts({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const arrow = useDir() === "rtl" ? "←" : "→";
  const { search } = useLocation();
  const { page, filters, access } = loaderData;
  const kinds = (["all", ...ALERT_KINDS] as const).filter((kind) => kind !== "invoice_price" || access.cost);

  const sentence = (alert: Alert) => {
    const sku = alert.variant?.sku ?? "";
    switch (alert.kind) {
      case "invoice_qty":
        return alert.ordered === null ? t("alerts.text.invoice_not_ordered", { sku, invoiced: f.number(alert.invoiced ?? 0) }) : t("alerts.text.invoice_qty", { sku, invoiced: f.number(alert.invoiced ?? 0), received: f.number(alert.received ?? 0) });
      case "invoice_price":
        return alert.charges ? t("alerts.text.invoice_charges") : t("alerts.text.invoice_price", { sku });
      case "rejected":
        return t("alerts.text.rejected", { sku, rejected: f.number(alert.rejected ?? 0), received: f.number(alert.received ?? 0), reason: alert.reason ?? "—" });
      case "over_received":
        return t("alerts.text.over_received", { sku, received: f.number(alert.received ?? 0), ordered: f.number(alert.ordered ?? 0) });
      case "short_closed":
        return t("alerts.text.short_closed", { sku, missing: f.number(alert.missing ?? 0), ordered: f.number(alert.ordered ?? 0) });
      default:
        return t("alerts.text.late", { missing: f.number(alert.missing ?? 0) });
    }
  };

  return (
    <>
      <PageHead title={t("alerts.title")} lead={t("alerts.lead")} />
      <Section id="alerts-list" title={t("alerts.caption")}>
        <LinkChips label={t("alerts.kinds")} items={kinds.map((kind) => ({ value: kind, label: kind === "all" ? t("common.all") : t(`alerts.kind.${kind}`), href: withSearch(search, { kind: kind === "all" ? null : kind }), selected: filters.kind === kind, count: page.counts[kind] }))} />
        {page.rows.length === 0 ? (
          <EmptyState icon="check-circle" title={filters.kind === "all" ? t("alerts.empty") : t("alerts.emptyKind")} />
        ) : (
          <ul role="list" className="grid gap-3 md:grid-cols-2">
            {page.rows.map((alert) => (
              <li key={alert.id} className="adm-card gap-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <StateTag group="claim" value={alert.kind === "late" || alert.kind === "rejected" ? "open" : "rejected"} label={t(`alerts.kind.${alert.kind}`)} />
                  <span className="type-caption text-ink-2">
                    <When at={alert.at} kind="date" />
                  </span>
                </div>
                <p className="type-body text-ink">{sentence(alert)}</p>
                {alert.kind === "invoice_price" && alert.poUnitCostMinor !== undefined && alert.invoiceUnitCostMinor !== undefined && alert.currency ? (
                  <p className="type-caption">
                    {alert.charges ? t("alerts.chargesFromTo") : t("alerts.priceFromTo")} <Minor minor={alert.poUnitCostMinor} currency={alert.currency} /> {arrow} <Minor minor={alert.invoiceUnitCostMinor} currency={alert.currency} />
                  </p>
                ) : null}
                {alert.variant ? <p className="type-caption text-ink-2">{alert.variant.name}</p> : null}
                <p className="type-caption text-ink-2">
                  <bdi>{alert.supplier.name}</bdi>
                  {alert.po ? (
                    <>
                      {" · "}
                      <Code>{alert.po.ref}</Code>
                    </>
                  ) : null}
                  {alert.receipt ? (
                    <>
                      {" · "}
                      <Code>{alert.receipt.ref}</Code>
                    </>
                  ) : null}
                  {alert.invoice ? (
                    <>
                      {" · "}
                      <Code>{alert.invoice.invoiceNo}</Code>
                    </>
                  ) : null}
                  {alert.expectedAt ? (
                    <>
                      {" · "}
                      {t("alerts.expected")} <When at={alert.expectedAt} kind="date" />
                    </>
                  ) : null}
                </p>
                {alert.claim ? (
                  <p className="type-caption">
                    {t("alerts.claimed")} {access.claim ? <Link to={`/admin/purchasing/claims/${alert.claim.id}`} className="adm-link"><Code>{alert.claim.ref}</Code></Link> : <Code>{alert.claim.ref}</Code>} · {t(`claimStatus.${alert.claim.status}`)}
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  {alert.invoice && alert.invoice.open ? (
                    <Key as={Link} to={`/admin/purchasing/invoices/${alert.invoice.id}`} size="sm" iconEnd="arrow-right">
                      {t("alerts.openInvoice")}
                    </Key>
                  ) : null}
                  {alert.receipt ? (
                    <Key as={Link} to={`/admin/purchasing/receipts/${alert.receipt.id}`} size="sm" iconEnd="arrow-right">
                      {t("alerts.openReceipt")}
                    </Key>
                  ) : alert.po && access.poRead ? (
                    <Key as={Link} to={`/admin/purchasing/orders/${alert.po.id}`} size="sm" iconEnd="arrow-right">
                      {t("alerts.openOrder")}
                    </Key>
                  ) : null}
                  {access.claim && !alert.claim && (alert.kind === "rejected" || alert.kind === "short_closed" || alert.kind === "invoice_qty") ? (
                    <Key as={Link} to={alert.receipt ? `/admin/purchasing/claims?receipt=${alert.receipt.id}#new` : `/admin/purchasing/claims?po=${alert.po?.id ?? ""}#new`} size="sm" icon="warning">
                      {t("alerts.openClaim")}
                    </Key>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
        <Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />
      </Section>
    </>
  );
}
