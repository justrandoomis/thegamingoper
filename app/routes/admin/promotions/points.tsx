import { Form, Link, redirect, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/points";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { findCustomerId, listLedger, loyaltyOverview, postExpiry, syncOrderPoints } from "~/server/services/admin/promotions/loyalty.server";
import { SECTION_READ, type PromotionsAccess } from "~/server/services/admin/promotions/shared.server";
import { LOYALTY_KINDS, LOYALTY_KIND_TONE, ledgerSearch, parseLedgerFilters, type LedgerRow } from "~/server/services/admin/promotions/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { PROMOTIONS_LAYOUT_ID, promotionsMeta } from "./meta";
import { openPromotions, respond, runIntent } from "./promotions.server";
import { Boundary, ConfirmAction, Facts, Kpis, Money, Num, PhoneText, Section, ToneStatus, usePromotionsT, When, useProgram } from "./ui";

/**
 * /admin/promotions/points — 08.04: the programme's rules, the points outstanding and what they are worth, what is due
 * (orders past their return window that have not earned, refunds that came after, points past their date), posting it
 * (idempotent), finding a customer by phone, and the append-only ledger (kind and customer in the URL).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPromotions(context, SECTION_READ.points);
  const url = new URL(request.url);
  const phone = url.searchParams.get("phone");
  try {
    if (phone !== null) {
      const customerId = await findCustomerId(db, actor, { phone });
      if (customerId) throw redirect(`/admin/promotions/points/${customerId}`);
      return { overview: await loyaltyOverview(db, actor, now), page: await listLedger(db, actor, parseLedgerFilters(url.searchParams)), filters: parseLedgerFilters(url.searchParams), notFound: phone };
    }
    const filters = parseLedgerFilters(url.searchParams);
    const [overview, page] = await Promise.all([loyaltyOverview(db, actor, now), listLedger(db, actor, filters)]);
    return { overview, page, filters, notFound: null as string | null };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, "promotions.loyalty.manage");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { sync: ["promotions.loyalty.manage"], expire: ["promotions.loyalty.manage"] }, async (intent) => {
      if (intent === "sync") return { ok: true, intent, ...(await syncOrderPoints(db, session.actor, ctx.now)) };
      return { ok: true, intent, ...(await postExpiry(db, session.actor, ctx.now)) };
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "points.title");

export default function PointsPage({ loaderData }: Route.ComponentProps) {
  const program = useProgram();
  const t = usePromotionsT();
  const f = useFormat();
  const layout = useRouteLoaderData(PROMOTIONS_LAYOUT_ID) as { access: PromotionsAccess } | undefined;
  const manage = layout?.access.points_manage ?? false;
  const { overview, page, filters, notFound } = loaderData;
  const columns: DataColumn<LedgerRow>[] = [
    { key: "at", header: t("points.col.at"), cell: (row) => <When at={row.at} /> },
    {
      key: "customer",
      header: t("points.col.customer"),
      cell: (row) => (
        <Link to={`/admin/promotions/points/${row.customerId}`} className="adm-link grid">
          <span>{row.customer ?? t("common.noName")}</span>
          <span className="type-caption text-ink-2">
            <PhoneText phone={row.phone} />
          </span>
        </Link>
      ),
    },
    { key: "kind", header: t("points.col.kind"), cell: (row) => <ToneStatus tone={LOYALTY_KIND_TONE[row.kind]}>{t(`points.kind.${row.kind}`)}</ToneStatus> },
    { key: "points", header: t("points.col.points"), numeric: true, negative: (row) => row.points < 0, cell: (row) => <Num value={row.points} /> },
    { key: "ref", header: t("points.col.ref"), cell: (row) => <span className="grid">{row.refLabel ? <bdi dir="ltr" className="nums">{row.refLabel}</bdi> : t(`points.ref.${row.refType ?? "none"}`)}{row.reason ? <span className="type-caption text-ink-2 line-clamp-1">{row.reason}</span> : null}</span> },
    { key: "expires", header: t("points.col.expires"), cell: (row) => (row.expiresAt ? <When at={row.expiresAt} style="date" /> : "—") },
    { key: "actor", header: t("points.col.actor"), cell: (row) => row.actor === "system" ? t("common.system") : (row.actor ?? "—") },
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "08.04" })}</p>
        <h1 className="adm-title">{t("points.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("points.lead")}</p>
      </header>
      <Boundary>{t("points.boundary", { value: f.iqd(program.loyalty.pointValueIqd) })}</Boundary>
      <div className="prm-block">
      <Kpis
        items={[
          { label: t("points.k.outstanding"), value: <Num value={overview.outstandingPoints} />, note: t("points.k.worth", { amount: f.iqd(overview.outstandingValueIqd) }) },
          { label: t("points.k.members"), value: <Num value={overview.members} /> },
          { label: t("points.k.earned"), value: <Num value={overview.earned30d} /> },
          { label: t("points.k.expiring"), value: <Num value={overview.expiringPoints30d} /> },
        ]}
      />
      </div>
      <div className="prm-layout">
        <div className="prm-main">
          <Section id="prm-ledger" title={t("points.ledger")}>
            <Form method="get" className="grid gap-3 sm:grid-cols-[minmax(0,14rem)_auto] sm:items-end">
              {filters.customer ? <input type="hidden" name="customer" value={filters.customer} /> : null}
              <Select name="kind" label={t("points.col.kind")} defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("common.all") }, ...LOYALTY_KINDS.map((kind) => ({ value: kind, label: t(`points.kind.${kind}`) }))]} />
              <div className="flex flex-wrap gap-2">
                <Key type="submit" icon="funnel">
                  {t("common.apply")}
                </Key>
                <Key as={Link} to="/admin/promotions/points">
                  {t("common.clear")}
                </Key>
              </div>
            </Form>
            <p className="type-caption text-ink-2" aria-live="polite">
              {t("common.count", { count: page.total })}
            </p>
            {page.rows.length === 0 ? (
              <EmptyState title={t("points.empty")} text={manage ? t("points.emptyHint") : t("points.emptyHintRead")} icon="coins" />
            ) : (
              <>
                <div className="hidden md:block">
                  <DataTable caption={t("points.ledger")} columns={columns} rows={page.rows} rowKey={(row) => row.id} maxHeight={null} footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => ledgerSearch({ ...filters, page: n }) || "?"} />} />
                </div>
                <ul className="prm-cards md:hidden">
                  {page.rows.map((row) => (
                    <li key={row.id}>
                      <Link to={`/admin/promotions/points/${row.customerId}`} className="prm-card">
                        <span className="prm-card__top">
                          <span className="type-strong">{row.customer ?? t("common.noName")}</span>
                          <Num value={row.points} className="type-strong" />
                        </span>
                        <span className="prm-card__top type-caption text-ink-2">
                          <span>{t(`points.kind.${row.kind}`)}</span>
                          <When at={row.at} />
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Section>
        </div>
        <aside className="prm-side" aria-label={t("common.side")}>
          <Section id="prm-find" title={t("points.find.title")}>
            <Form method="get" className="prm-form">
              <TextField name="phone" type="tel" label={t("points.find.phone")} hint={t("points.find.hint")} defaultValue={notFound ?? ""} error={notFound ? t("points.find.none") : undefined} />
              <div>
                <Key type="submit" icon="magnifying-glass">
                  {t("points.find.go")}
                </Key>
              </div>
            </Form>
          </Section>
          <div className={overview.ordersWaiting + overview.reversalsWaiting > 0 && manage ? "prm-panel prm-panel--decide" : "prm-panel"}>
            <p className="adm-h3">{t("points.due.title")}</p>
            {/* the return window is a setting (returns.window_days): its noun agrees with the number (daySpan) */}
            <p className="type-body">{t("points.due.orders", { count: overview.ordersWaiting, span: t("daySpan", { count: overview.returnWindowDays }) })}</p>
            <p className="type-body">{t("points.due.reversals", { count: overview.reversalsWaiting })}</p>
            {manage ? (
              <ConfirmAction
                intent="sync"
                label={t("points.due.post")}
                title={t("points.due.postQ")}
                consequence={t("points.due.postWhat")}
                confirmLabel={t("points.due.post")}
                impact={[
                  { label: t("points.due.ordersLabel"), value: String(overview.ordersWaiting) },
                  { label: t("points.due.reversalsLabel"), value: String(overview.reversalsWaiting), negative: overview.reversalsWaiting > 0 },
                ]}
                reason={false}
                icon="coins"
                disabled={overview.ordersWaiting + overview.reversalsWaiting === 0}
                doneKey={(result) => (Number(result.earnedOrders) + Number(result.reversed) > 0 ? "done.posted" : "done.nothing")}
              />
            ) : null}
            <p className="type-body">{t("points.due.expiry", { count: overview.expiryWaiting })}</p>
            {manage ? (
              <ConfirmAction intent="expire" label={t("points.due.expire")} title={t("points.due.expireQ")} consequence={t("points.due.expireWhat", { span: t("daySpan", { count: program.loyalty.expiryDays }) })} confirmLabel={t("points.due.expire")} reason={false} icon="hourglass" disabled={overview.expiryWaiting === 0} doneKey={(result) => (Number(result.customers) > 0 ? "done.expired" : "done.nothing")} />
            ) : null}
          </div>
          <Section id="prm-program" title={t("points.program.title")}>
            <Facts
              rows={[
                { label: t("points.program.earn"), value: t("points.program.earnValue", { n: program.loyalty.pointsPerThousandIqd }) },
                { label: t("points.program.value"), value: <Money iqd={program.loyalty.pointValueIqd} /> },
                { label: t("points.program.expiry"), value: t("points.program.expiryValue", { span: t("daySpan", { count: program.loyalty.expiryDays }) }) },
                { label: t("points.program.when"), value: t("points.program.whenValue", { span: t("daySpan", { count: overview.returnWindowDays }) }) },
                { label: t("points.program.second"), value: t("points.program.secondValue", { n: f.number(program.loyalty.adjustSecondPersonPoints), day: f.number(program.loyalty.adjustSoloDayPoints) }) },
              ]}
            />
          </Section>
        </aside>
      </div>
    </>
  );
}
