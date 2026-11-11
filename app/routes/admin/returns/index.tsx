import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/index";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { canAny } from "~/server/actor";
import { throwAsResponse } from "~/server/errors";
import { listReturns } from "~/server/services/admin/returns/rma.server";
import { parseRmaFilters, REASON_LIST, RMA_STATUS_LIST, RMA_VIEWS, rmaSearch, SLA, type QueueCounts, type RmaListRow } from "~/server/services/admin/returns/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "../shell/blueprint-catalog";
import { adminMeta } from "../shell/meta";
import { RETURNS_LAYOUT_ID } from "./meta";
import { openReturns } from "./returns.server";
import { DemoNote, Due, FlagTags, Money, Num, PhoneText, Ref, RmaStatusBadge, useReturnsT, When } from "./ui";

/**
 * /admin/returns — the module's front page: what waits for this employee (raised clay only where a person decides),
 * the RMA list (12.01) with saved views and filters in the URL (work without JavaScript), a dense table on desktop
 * and cards on phones, and the module's blueprint status. An employee who may only open RMAs sees the ones they opened.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReturns(context);
  const url = new URL(request.url);
  const filters = parseRmaFilters(url.searchParams);
  const canList = canAny(actor, ["returns.rma.read", "returns.rma.create"]);
  try {
    return { page: canList ? await listReturns(db, actor, filters, locale, now) : null, filters, now };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.returns"));

type LayoutData = { counts: QueueCounts };

export default function ReturnsIndex({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const locale = useLocale();
  const navigation = useNavigation();
  const layout = useRouteLoaderData(RETURNS_LAYOUT_ID) as LayoutData | undefined;
  const { page, filters } = loaderData;
  const blueprint = blueprintModule("12");
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/returns";
  const filtered = Boolean(filters.q || filters.status || filters.reason || filters.from || filters.to);

  const columns: DataColumn<RmaListRow>[] = [
    {
      key: "rma",
      header: t("list.col.rma"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <Link to={`/admin/returns/${row.rma}`} className="adm-link">
            <Ref value={row.rma} />
          </Link>
          <span className="type-caption text-ink-2">
            <When at={row.createdAt} />
          </span>
        </span>
      ),
    },
    { key: "order", header: t("list.col.order"), cell: (row) => <Ref value={row.orderRef} className="whitespace-nowrap" /> },
    {
      key: "customer",
      header: t("list.col.customer"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <span>{row.customerName ?? t("list.noName")}</span>
          <span className="type-caption text-ink-2">
            <PhoneText phone={row.phone} />
          </span>
        </span>
      ),
    },
    { key: "units", header: t("list.col.units"), numeric: true, cell: (row) => <Num value={row.units} /> },
    { key: "value", header: t("list.col.value"), numeric: true, cell: (row) => <Num value={row.valueIqd} /> },
    { key: "reason", header: t("list.col.reason"), cell: (row) => (row.reasonCode ? t(`reason.${row.reasonCode}`) : "—") },
    {
      key: "status",
      header: t("list.col.status"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <RmaStatusBadge status={row.status} />
          {row.refund !== "none" ? (
            <span className="type-caption text-ink-2">
              {t("list.col.refund")}: {t(`list.refund.${row.refund}`)}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      key: "flags",
      header: t("list.col.flags"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1">
          <FlagTags flags={row.flags} />
          <DemoNote show={row.isDemo} />
        </span>
      ),
    },
    { key: "due", header: t("list.col.due"), cell: (row) => <span className="whitespace-nowrap"><Due dueAt={row.dueAt} late={row.late} /></span> },
  ];

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrow", { id: "12", priority: blueprint?.priority ?? "P0" })}</p>
        {/* the blueprint names the module in ar and en only: Sorani uses the module's own title */}
        <h1 className="adm-title">{blueprint && locale !== "ckb" ? blueprint[locale === "en" ? "en" : "ar"] : t("title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("lead")}</p>
      </header>

      <QueueCards counts={layout?.counts ?? null} />

      {page ? (
        <section className="adm-section" aria-labelledby="returns-list">
          <div className="adm-section__head">
            <h2 id="returns-list" className="adm-h2">
              {t("list.title")}
            </h2>
          </div>

          <nav aria-label={t("list.viewsLabel")} className="flex flex-wrap gap-2">
            {RMA_VIEWS.map((view) => {
              const active = filters.view === view && !filtered;
              return (
                <Key key={view} as={Link} to={`/admin/returns${rmaSearch({ view })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                  {t(`list.views.${view}`)}
                </Key>
              );
            })}
          </nav>

          <Disclosure summary={t("list.filters")} variant="panel" defaultOpen={filtered}>
            <Form method="get" action="/admin/returns" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
              <TextField name="q" label={t("list.search")} hint={t("list.searchHint")} defaultValue={filters.q} type="search" />
              <Select name="status" label={t("list.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("list.any") }, ...RMA_STATUS_LIST.map((status) => ({ value: status, label: t(`status.${status}`) }))]} />
              <Select name="reason" label={t("list.reason")} defaultValue={filters.reason ?? ""} options={[{ value: "", label: t("list.any") }, ...REASON_LIST.map((reason) => ({ value: reason, label: t(`reason.${reason}`) }))]} />
              <TextField name="from" type="date" label={t("list.from")} defaultValue={filters.from ?? ""} ltr />
              <TextField name="to" type="date" label={t("list.to")} defaultValue={filters.to ?? ""} ltr />
              <div className="flex items-end gap-2">
                <Key type="submit" variant="ink" icon="funnel">
                  {t("list.apply")}
                </Key>
                <Key as={Link} to="/admin/returns">
                  {t("list.clear")}
                </Key>
              </div>
            </Form>
          </Disclosure>

          <p className="type-caption text-ink-2" aria-live="polite">
            {t("list.count", { count: page.total })}
          </p>

          {page.rows.length === 0 ? (
            <EmptyState title={filtered || filters.view !== "all" ? t("list.emptyFiltered") : t("list.empty")} text={filtered || filters.view !== "all" ? t("list.emptyFilteredHint") : t("list.emptyHint")} icon="arrow-u-up-left" action={!filtered && filters.view === "all" ? <Key as={Link} to="/admin/returns/new" icon="plus">{t("nav.new")}</Key> : undefined} />
          ) : (
            <>
              <div className="hidden md:block">
                <DataTable
                  caption={t("list.title")}
                  columns={columns}
                  rows={page.rows}
                  rowKey={(row) => row.id}
                  rowLabel={(row) => row.rma}
                  busy={busy}
                  maxHeight={null}
                  footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => rmaSearch({ ...filters, page: n }) || "?"} />}
                />
              </div>
              <div className="md:hidden">
                <ul className="ret-cards" aria-label={t("list.title")}>
                  {page.rows.map((row) => (
                    <li key={row.id}>
                      <RmaCard row={row} />
                    </li>
                  ))}
                </ul>
                <div className="mt-4">
                  <Pagination page={page.page} pageCount={page.pageCount} href={(n) => rmaSearch({ ...filters, page: n }) || "?"} />
                </div>
              </div>
            </>
          )}
        </section>
      ) : null}

      <ModuleFunctions moduleId="12" />
    </>
  );
}

function RmaCard({ row }: { row: RmaListRow }) {
  const t = useReturnsT();
  return (
    <Link to={`/admin/returns/${row.rma}`} className="ret-card">
      <span className="ret-card__top">
        <span className="type-strong">
          <Ref value={row.rma} />
        </span>
        <RmaStatusBadge status={row.status} />
      </span>
      <span className="ret-card__top type-body">
        <span>{row.customerName ?? t("list.noName")}</span>
        <Money iqd={row.valueIqd} className="type-strong" />
      </span>
      <span className="ret-card__top type-caption text-ink-2">
        <When at={row.createdAt} />
        <span>
          <Ref value={row.orderRef} /> · {t("list.units", { count: row.units })}
        </span>
      </span>
      <span className="type-caption">{row.reasonCode ? t(`reason.${row.reasonCode}`) : "—"}</span>
      {row.dueAt ? <Due dueAt={row.dueAt} late={row.late} /> : null}
      {row.flags.length || row.isDemo || row.refund !== "none" ? (
        <span className="inline-flex flex-wrap items-center gap-1">
          {row.refund !== "none" ? <span className="ret-tag">{t(`list.refund.${row.refund}`)}</span> : null}
          <FlagTags flags={row.flags} />
          <DemoNote show={row.isDemo} />
        </span>
      ) : null}
    </Link>
  );
}

const QUEUES: { id: keyof QueueCounts; to: string; icon: IconName; decide: boolean }[] = [
  { id: "decide", to: "/admin/returns?view=decide", icon: "scales", decide: true },
  { id: "refundApproval", to: "/admin/returns?view=refund", icon: "hand-coins", decide: true },
  { id: "receive", to: "/admin/returns?view=receive", icon: "truck", decide: false },
  { id: "inspect", to: "/admin/returns?view=inspect", icon: "magnifying-glass", decide: true },
  { id: "refund", to: "/admin/returns?view=refund", icon: "receipt", decide: false },
  { id: "quarantine", to: "/admin/returns/quarantine", icon: "package", decide: true },
  { id: "repairsLate", to: "/admin/returns/repairs?view=late", icon: "wrench", decide: true },
  { id: "warrantiesEnding", to: "/admin/returns/warranties?view=ending", icon: "certificate", decide: false },
];

/** What waits for this employee — raised clay only where a person must decide (DESIGN.md §10). */
function QueueCards({ counts }: { counts: QueueCounts | null }) {
  const t = useReturnsT();
  const f = useFormat();
  if (!counts) return null;
  const cards = QUEUES.filter((queue) => counts[queue.id] !== null);
  if (cards.length === 0) return null;
  return (
    <section className="adm-section" aria-labelledby="returns-waiting">
      <h2 id="returns-waiting" className="adm-h2">
        {t("queues.title")}
      </h2>
      <div className="adm-grid">
        {cards.map((card) => {
          const count = counts[card.id] ?? 0;
          const vars = { count, days: SLA.warrantyEndingDays };
          return (
            <article key={card.id} className={card.decide && count > 0 ? "adm-card adm-card--act" : "adm-card"}>
              <p className="flex items-center gap-2 type-caption text-ink-2">
                <Icon name={card.icon} size={16} />
                {t(`queues.${card.id}.label`)}
              </p>
              <p className="type-kpi nums">
                <bdi>{f.number(count)}</bdi>
              </p>
              <p className="type-caption text-ink-2">{count > 0 ? t(`queues.${card.id}.some`, vars) : t(`queues.${card.id}.none`, vars)}</p>
              <div>
                <Key as={Link} to={card.to} size="sm" iconEnd="arrow-right">
                  {t(`queues.${card.id}.open`)}
                </Key>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
