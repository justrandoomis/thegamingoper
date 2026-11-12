import type { ReactNode } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/search";
import { Icon } from "~/art/Icon";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { useFormat } from "~/i18n/react";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { globalSearch } from "~/server/services/admin/dashboard/search.server";
import { SEARCH_GROUPS, type CustomerHit, type OrderHit, type QuickAction, type SearchGroup, type SearchResults, type SerialHit, type SkuHit, type TicketHit } from "~/server/services/admin/dashboard/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { useAdminT } from "../shell/i18n";
import { adminMeta } from "../shell/meta";
import { Code, DemoTag, Money, Section, useDashT, When } from "./components/kit";
import { SearchBox } from "./components/tools";
import "./dashboard.css";

/**
 * /admin/dashboard/search?q= — admin 01.06, the global search: orders, customers, SKUs, serial numbers and tickets,
 * each group only for holders of its module's read permission and with that module's field rules (search.server.ts);
 * quick actions are links to the screen where the action happens. A GET form: works without JavaScript, the query
 * stays in the URL. `?limit=` (1–10 a group) serves a quicker answer, e.g. a palette loading it with a fetcher.
 * dashboard.search.use (every built-in role holds it).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "dashboard.search.use");
  const params = new URL(request.url).searchParams;
  const limit = Number(params.get("limit"));
  const results = await globalSearch(db, actor, { q: params.get("q") ?? "", limit: Number.isSafeInteger(limit) && limit > 0 ? limit : undefined }, ctx.locale, ctx.now);
  return { results, title: serverT(ctx.locale, "admin-dashboard")("search.title"), i18n: messagesFor(ctx.locale, "admin-dashboard") };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, args.loaderData?.title ?? ((t) => t("modules.dashboard")));

function Actions({ actions }: { actions: readonly QuickAction[] }) {
  const t = useDashT();
  return (
    <div className="dash-actions">
      {actions.map((action) => (
        <Key key={action.key} as={Link} to={action.href} size="sm" variant={action.key === "open" || action.key === "profile" || action.key === "repair" ? "secondary" : "ghost"}>
          {t(`search.actions.${action.key}`)}
        </Key>
      ))}
    </div>
  );
}

/** A dense table from 768px, one card per row below it (phones). */
function Rows<Row>({ caption, columns, rows, rowKey, card }: { caption: string; columns: DataColumn<Row>[]; rows: readonly Row[]; rowKey: (row: Row) => string; card: (row: Row) => ReactNode }) {
  return (
    <>
      <div className="hidden md:block">
        <DataTable caption={caption} columns={columns} rows={rows} rowKey={rowKey} maxHeight={null} />
      </div>
      <ul role="list" aria-label={caption} className="grid gap-2 md:hidden">
        {rows.map((row) => (
          <li key={rowKey(row)} className="adm-card gap-1.5">
            {card(row)}
          </li>
        ))}
      </ul>
    </>
  );
}

function Pair({ label, children }: { label: string; children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-baseline justify-between gap-x-3 type-caption">
      <span className="text-ink-2">{label}</span>
      <span className="text-ink">{children}</span>
    </p>
  );
}

function OrderRows({ rows }: { rows: OrderHit[] }) {
  const t = useDashT();
  const columns: DataColumn<OrderHit>[] = [
    {
      key: "ref",
      header: t("search.col.order"),
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          <Link to={`/admin/orders/${encodeURIComponent(row.ref)}`} className="adm-link">
            <Code>{row.ref}</Code>
          </Link>
          {row.isDemo ? <DemoTag /> : null}
        </span>
      ),
    },
    { key: "status", header: t("search.col.status"), cell: (row) => <Status tone="neutral">{t(`statuses.order.${row.status}`)}</Status> },
    { key: "payment", header: t("search.col.payment"), cell: (row) => t(`statuses.payment.${row.paymentStatus}`) },
    { key: "contact", header: t("search.col.contact"), cell: (row) => <bdi>{row.contactName ?? "—"}</bdi> },
    { key: "phone", header: t("search.col.phone"), cell: (row) => <Phone value={row.phone} /> },
    { key: "placed", header: t("search.col.placed"), cell: (row) => <When at={row.placedAt} kind="date" /> },
    { key: "total", header: t("search.col.total"), numeric: true, cell: (row) => <Money iqd={row.totalIqd} bare /> },
    { key: "actions", header: t("search.col.actions"), cell: (row) => <Actions actions={row.actions} /> },
  ];
  return (
    <Rows
      caption={t("search.groups.orders")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.ref}
      card={(row) => (
        <>
          <p className="flex flex-wrap items-center justify-between gap-2">
            <Link to={`/admin/orders/${encodeURIComponent(row.ref)}`} className="adm-link">
              <Code>{row.ref}</Code>
            </Link>
            <Status tone="neutral">{t(`statuses.order.${row.status}`)}</Status>
          </p>
          <Pair label={t("search.card.total")}>
            <Money iqd={row.totalIqd} />
          </Pair>
          <Pair label={t("search.col.contact")}>
            <bdi>{row.contactName ?? "—"}</bdi>
          </Pair>
          <Pair label={t("search.col.phone")}>
            <Phone value={row.phone} />
          </Pair>
          <Pair label={t("search.col.placed")}>
            <When at={row.placedAt} kind="date" />
          </Pair>
          {row.isDemo ? (
            <div>
              <DemoTag />
            </div>
          ) : null}
          <Actions actions={row.actions} />
        </>
      )}
    />
  );
}

function Phone({ value }: { value: { display: string; full: boolean } | null }) {
  const t = useDashT();
  if (!value) return <span>—</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <bdi dir="ltr" className="nums whitespace-nowrap">
        {value.display}
      </bdi>
      {value.full ? null : <span className="sr-only">{t("search.masked")}</span>}
    </span>
  );
}

function CustomerRows({ rows }: { rows: CustomerHit[] }) {
  const t = useDashT();
  const columns: DataColumn<CustomerHit>[] = [
    {
      key: "name",
      header: t("search.col.name"),
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          <Link to={`/admin/customers/${encodeURIComponent(row.id)}`} className="adm-link">
            <bdi>{row.name ?? "—"}</bdi>
          </Link>
          {row.isDemo ? <DemoTag /> : null}
        </span>
      ),
    },
    { key: "phone", header: t("search.col.phone"), cell: (row) => <Phone value={row.phone} /> },
    { key: "status", header: t("search.col.status"), cell: (row) => <Status tone={row.status === "blocked" ? "bad" : "neutral"}>{t(`statuses.customer.${row.status}`)}</Status> },
    { key: "actions", header: t("search.col.actions"), cell: (row) => <Actions actions={row.actions} /> },
  ];
  return (
    <Rows
      caption={t("search.groups.customers")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      card={(row) => (
        <>
          <p className="flex flex-wrap items-center justify-between gap-2">
            <Link to={`/admin/customers/${encodeURIComponent(row.id)}`} className="adm-link">
              <bdi>{row.name ?? "—"}</bdi>
            </Link>
            <Status tone={row.status === "blocked" ? "bad" : "neutral"}>{t(`statuses.customer.${row.status}`)}</Status>
          </p>
          <Pair label={t("search.col.phone")}>
            <Phone value={row.phone} />
          </Pair>
          {row.isDemo ? (
            <div>
              <DemoTag />
            </div>
          ) : null}
          <Actions actions={row.actions} />
        </>
      )}
    />
  );
}

function SkuRows({ rows }: { rows: SkuHit[] }) {
  const t = useDashT();
  const f = useFormat();
  const showStock = rows.some((row) => row.available !== null);
  const columns: DataColumn<SkuHit>[] = [
    { key: "sku", header: t("search.col.sku"), cell: (row) => <Code>{row.sku}</Code> },
    {
      key: "product",
      header: t("search.col.product"),
      cell: (row) => (
        <span className="grid">
          <bdi>{row.name}</bdi>
          {row.title ? <span className="type-caption text-ink-2">{row.title}</span> : null}
        </span>
      ),
    },
    { key: "status", header: t("search.col.status"), cell: (row) => (row.isActive ? t(`statuses.product.${row.productStatus}`) : `${t(`statuses.product.${row.productStatus}`)} · ${t("search.inactive")}`) },
    { key: "price", header: t("search.col.price"), numeric: true, cell: (row) => <Money iqd={row.priceIqd} bare /> },
    ...(showStock ? [{ key: "available", header: t("search.col.available"), numeric: true, cell: (row: SkuHit) => <bdi className="nums">{row.available === null ? "—" : f.number(row.available)}</bdi> }] : []),
    { key: "actions", header: t("search.col.actions"), cell: (row) => <Actions actions={row.actions} /> },
  ];
  return (
    <Rows
      caption={t("search.groups.skus")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.variantId}
      card={(row) => (
        <>
          <p className="flex flex-wrap items-center justify-between gap-2">
            <Code>{row.sku}</Code>
            <span className="type-caption text-ink-2">{t(`statuses.product.${row.productStatus}`)}</span>
          </p>
          <p className="type-body text-ink">
            <bdi>{row.name}</bdi>
          </p>
          <Pair label={t("search.card.price")}>
            <Money iqd={row.priceIqd} />
          </Pair>
          {row.available !== null ? <Pair label={t("search.col.available")}>{f.number(row.available)}</Pair> : null}
          <Actions actions={row.actions} />
        </>
      )}
    />
  );
}

function SerialRows({ rows }: { rows: SerialHit[] }) {
  const t = useDashT();
  const columns: DataColumn<SerialHit>[] = [
    { key: "serial", header: t("search.col.serial"), cell: (row) => <Code>{row.serial}</Code> },
    { key: "status", header: t("search.col.status"), cell: (row) => <Status tone="neutral">{t(`statuses.serial.${row.status}`)}</Status> },
    { key: "sku", header: t("search.col.sku"), cell: (row) => <Code>{row.sku}</Code> },
    { key: "product", header: t("search.col.product"), cell: (row) => <bdi>{row.name}</bdi> },
    { key: "actions", header: t("search.col.actions"), cell: (row) => <Actions actions={row.actions} /> },
  ];
  return (
    <Rows
      caption={t("search.groups.serials")}
      columns={columns}
      rows={rows}
      rowKey={(row) => row.id}
      card={(row) => (
        <>
          <p className="flex flex-wrap items-center justify-between gap-2">
            <Code>{row.serial}</Code>
            <Status tone="neutral">{t(`statuses.serial.${row.status}`)}</Status>
          </p>
          <Pair label={t("search.col.sku")}>
            <Code>{row.sku}</Code>
          </Pair>
          <p className="type-caption text-ink-2">
            <bdi>{row.name}</bdi>
          </p>
          <Actions actions={row.actions} />
        </>
      )}
    />
  );
}

function TicketRows({ rows }: { rows: TicketHit[] }) {
  const t = useDashT();
  const status = (row: TicketHit) => (row.kind === "repair" ? t(`statuses.repair.${row.status}`) : t(`statuses.ticket.${row.status}`));
  const columns: DataColumn<TicketHit>[] = [
    {
      key: "ref",
      header: t("search.col.ref"),
      cell: (row) => (
        <span className="inline-flex items-center gap-2">
          <Code>{row.ref}</Code>
          {row.isDemo ? <DemoTag /> : null}
        </span>
      ),
    },
    { key: "kind", header: t("search.col.kind"), cell: (row) => t(`search.ticketKind.${row.kind}`) },
    { key: "subject", header: t("search.col.subject"), cell: (row) => <bdi className="line-clamp-2">{row.title}</bdi> },
    { key: "status", header: t("search.col.status"), cell: (row) => <Status tone="neutral">{status(row)}</Status> },
    { key: "priority", header: t("search.col.priority"), cell: (row) => (row.priority ? t(`urgent.priority.${row.priority}`) : "—") },
    { key: "actions", header: t("search.col.actions"), cell: (row) => <Actions actions={row.actions} /> },
  ];
  return (
    <Rows
      caption={t("search.groups.tickets")}
      columns={columns}
      rows={rows}
      rowKey={(row) => `${row.kind}:${row.ref}`}
      card={(row) => (
        <>
          <p className="flex flex-wrap items-center justify-between gap-2">
            <Code>{row.ref}</Code>
            <Status tone="neutral">{status(row)}</Status>
          </p>
          <p className="type-body text-ink">
            <bdi>{row.title}</bdi>
          </p>
          <Pair label={t("search.col.kind")}>{t(`search.ticketKind.${row.kind}`)}</Pair>
          {row.priority ? <Pair label={t("search.col.priority")}>{t(`urgent.priority.${row.priority}`)}</Pair> : null}
          <Actions actions={row.actions} />
        </>
      )}
    />
  );
}

function Group({ group, results }: { group: SearchGroup; results: SearchResults }) {
  const t = useDashT();
  const rows = results.groups[group];
  if (rows === null) return null;
  const failed = results.failed.includes(group);
  const link = results.links[group];
  const id = `search-${group}`;
  return (
    <Section
      id={id}
      title={
        <span className="inline-flex flex-wrap items-baseline gap-2">
          <span>{t(`search.groups.${group}`)}</span>
          {failed ? null : <span className="type-caption text-ink-2">{rows.length >= results.limit ? t("search.first", { count: rows.length }) : t("search.count", { count: rows.length })}</span>}
        </span>
      }
      aside={
        link && rows.length > 0 ? (
          <TextLink as={Link} to={link}>
            {t("search.seeAll")}
          </TextLink>
        ) : undefined
      }
    >
      {failed ? (
        // the module did not answer this time: said as such, never as "no results"
        <p className="flex items-start gap-2 type-body text-ink" role="status">
          <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0 text-ink-2" />
          <span>{t("search.groupFailed")}</span>
        </p>
      ) : null}
      {rows.length === 0 && !failed ? <p className="type-body text-ink-2">{t("search.groupEmpty")}</p> : null}
      {rows.length > 0 && group === "orders" ? <OrderRows rows={rows as OrderHit[]} /> : null}
      {rows.length > 0 && group === "customers" ? <CustomerRows rows={rows as CustomerHit[]} /> : null}
      {rows.length > 0 && group === "skus" ? <SkuRows rows={rows as SkuHit[]} /> : null}
      {rows.length > 0 && group === "serials" ? <SerialRows rows={rows as SerialHit[]} /> : null}
      {rows.length > 0 && group === "tickets" ? <TicketRows rows={rows as TicketHit[]} /> : null}
    </Section>
  );
}

export default function GlobalSearch({ loaderData }: Route.ComponentProps) {
  const t = useDashT();
  const at = useAdminT();
  const { results } = loaderData;
  const searched = SEARCH_GROUPS.filter((group) => results.groups[group] !== null);
  const left = SEARCH_GROUPS.filter((group) => results.groups[group] === null);
  const total = searched.reduce((sum, group) => sum + (results.groups[group]?.length ?? 0), 0);
  const typed = results.q.length > 0 && !results.tooShort;
  const names = (groups: readonly SearchGroup[]) => groups.map((group) => t(`search.groups.${group}`)).join(t("search.listSep"));

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin" className="adm-link">
            {at("modules.dashboard")}
          </Link>
        </p>
        <h1 className="adm-title">{t("search.title")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{t("search.lead")}</p>
      </header>

      <div className="dash-tools">
        <SearchBox defaultValue={results.q} />
        <div aria-live="polite" className="grid gap-1">
          {searched.length === 0 ? (
            <p className="type-body text-ink">{t("search.noAccess")}</p>
          ) : results.tooShort ? (
            <p className="type-body text-ink">{t("search.tooShort")}</p>
          ) : !typed ? (
            <p className="type-body text-ink-2">{t("search.empty")}</p>
          ) : (
            <p className="type-strong text-ink">{t("search.shown", { count: total })}</p>
          )}
          {searched.length > 0 ? <p className="type-caption text-ink-2">{t("search.scope", { groups: names(searched) })}</p> : null}
          {left.length > 0 && searched.length > 0 ? <p className="type-caption text-ink-2">{t("search.notIncluded", { groups: names(left) })}</p> : null}
        </div>
      </div>

      {typed && total === 0 && searched.length > 0 && results.failed.length === 0 ? <EmptyState icon="magnifying-glass" title={t("search.nothing", { q: `⁨${results.q}⁩` })} text={t("search.nothingHint")} /> : null}

      {typed && (total > 0 || results.failed.length > 0) ? (
        <div className="dash-groups">
          {SEARCH_GROUPS.map((group) => (
            <Group key={group} group={group} results={results} />
          ))}
        </div>
      ) : null}
    </>
  );
}
