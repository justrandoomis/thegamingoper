import { Link } from "react-router";

import type { Route } from "./+types/home";
import { useFormat } from "~/i18n/react";
import { purchasingOverview } from "~/server/services/admin/purchasing/alerts.server";
import { purchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { SPLIT_WINDOW_DAYS } from "~/server/services/admin/purchasing/rules";
import { getSetting } from "~/server/settings.server";
import { Key } from "~/ui/Key";
import { ModuleFunctions } from "../blueprint-status";
import { adminMeta } from "../shell/meta";
import { Code, Kpi, Money, Note, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, usePurT } from "./components/kit";
import { openPurchasing } from "./purchasing.server";

/**
 * /admin/purchasing — the module's home: what waits for a decision (raised cards only when there is something to do),
 * the figures now, quick actions, the latest receipts and the blueprint status of functions 09.01–09.08.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPurchasing(context);
  const overview = await purchasingOverview(db, actor, now);
  return { overview, access: purchasingAccess(actor), limitIqd: purchasingAccess(actor).cost ? await getSetting(db, "purchasing.po_approval_limit_iqd") : null };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.purchasing"));

export default function PurchasingHome({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const { overview, access, limitIqd } = loaderData;
  const { waiting, figures } = overview;
  const cards = [
    { id: "approvals", count: waiting.approvals, href: "/admin/purchasing/orders?view=pending_approval" },
    { id: "stuck", count: waiting.receiptsStuck, href: "/admin/purchasing/receipts?state=posting" },
    { id: "drafts", count: waiting.receiptsDraft, href: "/admin/purchasing/receipts?state=draft" },
    { id: "mismatch", count: waiting.invoicesMismatch, href: "/admin/purchasing/invoices?status=mismatch" },
    { id: "late", count: waiting.late, href: "/admin/purchasing/orders?view=late" },
    { id: "claims", count: waiting.claimsOpen, href: "/admin/purchasing/claims?status=active" },
    { id: "alerts", count: waiting.alerts, href: "/admin/purchasing/alerts" },
  ].filter((card): card is { id: string; count: number; href: string } => typeof card.count === "number" && card.count > 0);

  return (
    <>
      <PageHead eyebrow="09 · P0" title={t("home.title")} lead={t("home.lead")} />

      <Section id="pur-waiting" title={t("home.waiting")}>
        {cards.length > 0 ? (
          <div className="adm-grid">
            {cards.map((card) => (
              <article key={card.id} className="adm-card adm-card--act">
                <p className="type-kpi nums">
                  <bdi>{f.number(card.count)}</bdi>
                </p>
                <p className="type-body text-ink">{t(`home.cards.${card.id}`, { count: card.count })}</p>
                <div>
                  <Key as={Link} to={card.href} size="sm" iconEnd="arrow-right">
                    {t("home.openThem")}
                  </Key>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="adm-card">
            <p className="type-strong text-ink">{t("home.nothingWaiting")}</p>
          </div>
        )}
      </Section>

      <Section id="pur-figures" title={t("home.figures")}>
        <div className="pur-kpis">
          <Kpi label={t("home.openOrders")} value={f.number(figures.openOrders)} />
          <Kpi label={t("home.unitsIncoming")} value={f.number(figures.unitsIncoming)} />
          <Kpi label={t("home.receiptsThisMonth")} value={f.number(figures.receiptsThisMonth)} />
          {access.supplierRead ? <Kpi label={t("home.suppliersActive")} value={f.number(figures.suppliersActive)} /> : null}
          {"openValueIqd" in figures ? <Kpi wide label={t("home.openValue")} value={<Money iqd={figures.openValueIqd} unknownLabel={t("home.openValueUnknown")} />} /> : null}
        </div>
        {limitIqd !== null ? (
          <Note icon="scales">
            <p className="type-body">{t("home.limitNote", { limit: f.iqd(limitIqd), days: SPLIT_WINDOW_DAYS })}</p>
          </Note>
        ) : null}
      </Section>

      <Section id="pur-quick" title={t("home.quick")}>
        <div className="flex flex-wrap gap-2">
          {access.poCreate && access.cost ? (
            <Key as={Link} to="/admin/purchasing/orders/new" icon="plus">
              {t("home.newOrder")}
            </Key>
          ) : null}
          {access.rfq ? (
            <Key as={Link} to="/admin/purchasing/rfqs#new" icon="scales">
              {t("home.newRfq")}
            </Key>
          ) : null}
          {access.supplierManage ? (
            <Key as={Link} to="/admin/purchasing/suppliers#new" icon="factory">
              {t("home.newSupplier")}
            </Key>
          ) : null}
          {access.receive ? (
            <Key as={Link} to="/admin/purchasing/orders?view=open" icon="package">
              {t("home.receiveGoods")}
            </Key>
          ) : null}
          {access.claim ? (
            <Key as={Link} to="/admin/purchasing/claims#new" icon="warning">
              {t("home.newClaim")}
            </Key>
          ) : null}
        </div>
      </Section>

      {overview.recent.length > 0 ? (
        <Section
          id="pur-recent"
          title={t("home.recent")}
          aside={
            <Link to="/admin/purchasing/receipts" className="adm-link type-label">
              {t("home.seeAll")}
            </Link>
          }
        >
          <ResponsiveList
            caption={t("home.recent")}
            rows={overview.recent}
            rowKey={(row) => row.id}
            columns={[
              { key: "ref", header: t("common.reference"), cell: (row) => <RowLink to={`/admin/purchasing/receipts/${row.id}`}><Code>{row.ref}</Code></RowLink> },
              { key: "po", header: t("common.order"), cell: (row) => (row.label ? <Code>{row.label}</Code> : "—") },
              { key: "state", header: t("common.status"), cell: (row) => <StateTag group="receipt" value={row.state} label={t(`receiptState.${row.state}`)} /> },
              { key: "at", header: t("common.when"), cell: (row) => <When at={row.at} /> },
            ]}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/admin/purchasing/receipts/${row.id}`} className="adm-link type-strong">
                    <Code>{row.ref}</Code>
                  </Link>
                  <StateTag group="receipt" value={row.state} label={t(`receiptState.${row.state}`)} />
                </div>
                <Pair label={t("common.order")}>{row.label ? <Code>{row.label}</Code> : "—"}</Pair>
                <Pair label={t("common.when")}>
                  <When at={row.at} />
                </Pair>
              </>
            )}
          />
        </Section>
      ) : null}

      <ModuleFunctions moduleId="09" />
    </>
  );
}
