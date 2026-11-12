import { useState } from "react";
import { Form, Link, useNavigation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/index";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { can } from "~/server/actor";
import { throwAsResponse } from "~/server/errors";
import { listInbox } from "~/server/services/admin/support/inbox.server";
import { SUPPORT_PERMISSIONS, type SupportAccess } from "~/server/services/admin/support/shared.server";
import {
  INBOX_CHIP_VIEWS,
  INBOX_SORTS,
  INBOX_VIEWS,
  TICKET_CATEGORIES,
  TICKET_CHANNELS,
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  inboxSearch,
  isFiltered,
  parseInboxFilters,
  QUEUE_LINKS,
  type InboxRow,
  type InboxView,
  type SupportQueueCounts,
} from "~/server/services/admin/support/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "../shell/blueprint-catalog";
import { useAdminT } from "../shell/i18n";
import { adminMeta } from "../shell/meta";
import { inboxIntent } from "./actions.server";
import { SUPPORT_LAYOUT_ID } from "./meta";
import { failed, openSupport } from "./support.server";
import { Boundary, ChannelLabel, DemoTag, Due, Failure, PhoneText, PriorityTag, Ref, RowStatus, useIntent, useSupportT, When } from "./ui";

/**
 * /admin/support — the module's front page (14.01): what waits for this employee (raised clay only where a person
 * decides), the unified inbox of tickets, assistant hand-offs and repair requests with saved views, filters, sort and
 * page in the URL (they work without JavaScript), a dense table on desktop with bulk assign / route, cards on phones,
 * and the module's blueprint status. An employee who may not read tickets (a writer of articles) sees the sections
 * they may use instead.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openSupport(context, SUPPORT_PERMISSIONS);
  const filters = parseInboxFilters(new URL(request.url).searchParams);
  try {
    return { page: can(actor, "support.ticket.read") ? await listInbox(db, actor, filters, now) : null, filters, now };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openSupport(context, "support.ticket.assign");
  const form = await request.formData();
  const intent = typeof form.get("intent") === "string" ? String(form.get("intent")) : null;
  try {
    return await inboxIntent(db, actor, form, now);
  } catch (error) {
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.support"));

type LayoutData = { access: SupportAccess; counts: SupportQueueCounts; waiting: number | null };

export default function SupportIndex({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const adminT = useAdminT();
  const locale = useLocale();
  const layout = useRouteLoaderData(SUPPORT_LAYOUT_ID) as LayoutData | undefined;
  const blueprint = blueprintModule("14");
  const { page } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{adminT("module.eyebrow", { id: "14", priority: adminT(`priority.${blueprint?.priority ?? "P1"}`) })}</p>
        <h1 className="adm-title">{blueprint ? blueprint[locale === "en" ? "en" : "ar"] : adminT("modules.support")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{page ? t("inbox.lead") : t("home.lead")}</p>
      </header>
      {page ? <Inbox page={page} layout={layout ?? null} /> : <Home access={layout?.access ?? null} />}
      <ModuleFunctions moduleId="14" />
    </>
  );
}

// ───────────────────────────────────────────────────────────────── for employees who do not read tickets

function Home({ access }: { access: SupportAccess | null }) {
  const t = useSupportT();
  if (!access) return null;
  const all: { id: string; to: string; icon: IconName; show: boolean }[] = [
    { id: "knowledge", to: "/admin/support/knowledge", icon: "book-open", show: access.knowledge || access.approve },
    { id: "replies", to: "/admin/support/replies", icon: "chat-circle", show: access.canned },
    { id: "routing", to: "/admin/support/routing", icon: "swap", show: access.routing || access.assign },
    { id: "metrics", to: "/admin/support/metrics", icon: "chart-bar", show: access.metrics },
  ];
  const cards = all.filter((card) => card.show);
  return (
    <section className="adm-section" aria-labelledby="sup-home">
      <h2 id="sup-home" className="adm-h2">
        {t("home.title")}
      </h2>
      <div className="adm-grid">
        {cards.map((card) => (
          <article key={card.id} className="adm-card">
            <p className="flex items-center gap-2 type-strong">
              <Icon name={card.icon} size={18} className="text-ink-2" />
              {t(`nav.${card.id}`)}
            </p>
            <p className="type-caption text-ink-2">{t(`home.${card.id}`)}</p>
            <div>
              <Key as={Link} to={card.to} size="sm" iconEnd="arrow-right">
                {t("home.open")}
              </Key>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

// ───────────────────────────────────────────────────────────────── the inbox

type Page = NonNullable<Route.ComponentProps["loaderData"]["page"]>;

const QUEUES: { id: keyof SupportQueueCounts; icon: IconName; decide: boolean }[] = [
  { id: "escalatedToMe", icon: "flag", decide: true },
  { id: "unassigned", icon: "users", decide: true },
  { id: "mineLate", icon: "clock", decide: true },
];

function QueueCards({ counts }: { counts: SupportQueueCounts | null }) {
  const t = useSupportT();
  const f = useFormat();
  if (!counts) return null;
  const cards = QUEUES.filter((queue) => counts[queue.id] !== null);
  if (cards.length === 0) return null;
  return (
    <section className="adm-section" aria-labelledby="sup-waiting">
      <h2 id="sup-waiting" className="adm-h2">
        {t("queues.title")}
      </h2>
      <div className="adm-grid">
        {cards.map((card) => {
          const count = counts[card.id] ?? 0;
          return (
            <article key={card.id} className={card.decide && count > 0 ? "adm-card adm-card--act" : "adm-card"}>
              <p className="flex items-center gap-2 type-caption text-ink-2">
                <Icon name={card.icon} size={16} />
                {t(`queues.${card.id}.label`)}
              </p>
              <p className="type-kpi nums">
                <bdi>{f.number(count)}</bdi>
              </p>
              <p className="type-caption text-ink-2">{count > 0 ? t(`queues.${card.id}.some`, { count }) : t(`queues.${card.id}.none`)}</p>
              <div>
                <Key as={Link} to={QUEUE_LINKS[card.id]} size="sm" iconEnd="arrow-right">
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

function rowHref(row: InboxRow): string {
  return row.kind === "repair" ? `/admin/support/repairs/${row.ref}` : `/admin/support/tickets/${row.ref}`;
}

function Inbox({ page, layout }: { page: Page; layout: LayoutData | null }) {
  const t = useSupportT();
  const f = useFormat();
  const navigation = useNavigation();
  const [selected, setSelected] = useState<string[]>([]);
  const filters = page.filters;
  const filtered = isFiltered(filters);
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/support";
  const route = useIntent("route_waiting", (result) => (Number(result.routed ?? 0) > 0 ? "inbox.routed" : "inbox.routedNone"));
  const waiting = layout?.waiting ?? 0;

  const columns: DataColumn<InboxRow>[] = [
    {
      key: "ref",
      header: t("inbox.col.ref"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <Link to={rowHref(row)} className="adm-link">
            <Ref value={row.ref} />
          </Link>
          <span className="type-caption text-ink-2">{row.kind === "repair" ? t("inbox.kind.repair") : row.handoff ? t("inbox.kind.handoff") : t("inbox.kind.ticket")}</span>
        </span>
      ),
    },
    {
      key: "title",
      header: t("inbox.col.subject"),
      cell: (row) => (
        <span className="grid min-w-0 max-w-[28rem] py-1">
          <span className="sup-card__title line-clamp-2">{row.title}</span>
          <span className="type-caption text-ink-2">
            {row.contact ?? t("inbox.noName")} · <span className="whitespace-nowrap"><PhoneText phone={row.phone} /></span>
          </span>
        </span>
      ),
    },
    {
      key: "status",
      header: t("inbox.col.status"),
      cell: (row) => (
        <span className="inline-flex flex-wrap items-center gap-1 py-1">
          <RowStatus kind={row.kind} status={row.status} />
          {row.kind === "ticket" ? <PriorityTag priority={row.priority} quiet /> : null}
          {row.escalatedTo ? (
            <span className="sup-tag">
              <Icon name="flag" size={13} className="text-red-ink" />
              {t("inbox.escalatedTo", { name: row.escalatedTo.name })}
            </span>
          ) : null}
          <DemoTag show={row.isDemo} />
        </span>
      ),
    },
    { key: "channel", header: t("inbox.col.channel"), cell: (row) => <ChannelLabel channel={row.channel} kind={row.kind} /> },
    {
      key: "assigned",
      header: t("inbox.col.assigned"),
      cell: (row) => (
        <span className="grid whitespace-nowrap py-1">
          <span>{row.assigned?.name ?? t("inbox.nobody")}</span>
          {row.team ? <span className="type-caption text-ink-2">{t("inbox.team", { team: row.team })}</span> : null}
        </span>
      ),
    },
    { key: "due", header: t("inbox.col.due"), cell: (row) => (row.due ? <Due at={row.due.at} late={row.due.late} target={row.due.target} /> : <span className="text-ink-2">{t("inbox.noDue")}</span>) },
    {
      key: "activity",
      header: t("inbox.col.activity"),
      cell: (row) => (
        <span className="whitespace-nowrap text-ink-2">
          <When at={row.activityAt} />
        </span>
      ),
    },
  ];

  const ticketIds = new Set(page.rows.filter((row) => row.kind === "ticket").map((row) => row.id));
  // who the list shows holding each ticket: bulk assign leaves alone a ticket someone took after the list was shown
  const holders = new Map(page.rows.filter((row) => row.kind === "ticket").map((row) => [row.id, row.assigned?.id ?? ""]));
  return (
    <>
      <Boundary>{t("inbox.boundary")}</Boundary>
      <QueueCards counts={layout?.counts ?? null} />

      <section className="adm-section" aria-labelledby="sup-inbox">
        <div className="adm-section__head">
          <h2 id="sup-inbox" className="adm-h2">
            {t("inbox.title")}
          </h2>
          <div className="sup-actions">
            {page.can.reply ? (
              <Key as={Link} to="/admin/support/new" size="sm" icon="plus">
                {t("nav.new")}
              </Key>
            ) : null}
            {page.can.route && waiting > 0 ? (
              <route.fetcher.Form method="post">
                <input type="hidden" name="intent" value="route_waiting" />
                <Key type="submit" size="sm" icon="swap" loading={route.pending}>
                  {t("inbox.routeWaiting", { count: waiting })}
                </Key>
              </route.fetcher.Form>
            ) : null}
          </div>
        </div>
        <Failure message={route.message} />

        <nav aria-label={t("inbox.viewsLabel")} className="flex flex-wrap gap-2">
          {INBOX_VIEWS.map((view) => {
            const active = filters.view === view && !filtered;
            const count = (INBOX_CHIP_VIEWS as readonly InboxView[]).includes(view) ? page.counts[view as (typeof INBOX_CHIP_VIEWS)[number]] : null;
            return (
              <Key key={view} as={Link} to={`/admin/support${inboxSearch({ view })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`inbox.views.${view}`)}
                {count ? (
                  <span className="ms-1.5" aria-label={t("inbox.viewCount", { count })}>
                    <bdi className="nums">{f.number(count)}</bdi>
                  </span>
                ) : null}
              </Key>
            );
          })}
        </nav>

        <Disclosure summary={t("inbox.filters")} variant="panel" defaultOpen={filtered}>
          <Form method="get" action="/admin/support" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {filters.view !== "open" ? <input type="hidden" name="view" value={filters.view} /> : null}
            <TextField name="q" type="search" label={t("inbox.search")} hint={t("inbox.searchHint")} defaultValue={filters.q} />
            <Select name="kind" label={t("inbox.kindLabel")} defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("inbox.any") }, { value: "ticket", label: t("inbox.kind.ticket") }, { value: "repair", label: t("inbox.kind.repair") }]} />
            <Select name="status" label={t("inbox.status")} defaultValue={filters.status ?? ""} options={[{ value: "", label: t("inbox.any") }, ...TICKET_STATUSES.map((status) => ({ value: status, label: t(`ticketStatus.${status}`) }))]} />
            <Select name="priority" label={t("inbox.priority")} defaultValue={filters.priority ?? ""} options={[{ value: "", label: t("inbox.any") }, ...TICKET_PRIORITIES.map((priority) => ({ value: priority, label: t(`priority.${priority}`) }))]} />
            <Select name="category" label={t("inbox.category")} defaultValue={filters.category ?? ""} options={[{ value: "", label: t("inbox.any") }, ...TICKET_CATEGORIES.map((category) => ({ value: category, label: t(`category.${category}`) }))]} />
            <Select name="channel" label={t("inbox.channel")} defaultValue={filters.channel ?? ""} options={[{ value: "", label: t("inbox.any") }, ...TICKET_CHANNELS.map((channel) => ({ value: channel, label: t(`channel.${channel}`) }))]} />
            <Select
              name="assignee"
              label={t("inbox.assignee")}
              defaultValue={filters.assignee ?? ""}
              options={[{ value: "", label: t("inbox.any") }, { value: "me", label: t("inbox.me") }, { value: "none", label: t("inbox.nobody") }, ...page.agents.map((agent) => ({ value: agent.id, label: agent.name }))]}
            />
            {page.teams.length ? <Select name="team" label={t("inbox.teamLabel")} defaultValue={filters.team ?? ""} options={[{ value: "", label: t("inbox.any") }, ...page.teams.map((team) => ({ value: team, label: team }))]} /> : null}
            <Select name="sort" label={t("inbox.sort")} defaultValue={filters.sort} options={INBOX_SORTS.map((sort) => ({ value: sort, label: t(`inbox.sorts.${sort}`) }))} />
            <div className="flex items-end gap-2">
              <Key type="submit" variant="ink" icon="funnel">
                {t("inbox.apply")}
              </Key>
              <Key as={Link} to={`/admin/support${inboxSearch({ view: filters.view })}`}>
                {t("inbox.clear")}
              </Key>
            </div>
          </Form>
        </Disclosure>

        <p className="type-caption text-ink-2" aria-live="polite">
          {t("inbox.count", { count: page.total })}
        </p>

        {page.rows.length === 0 ? (
          <EmptyState
            title={filtered || filters.view !== "open" ? t("inbox.emptyFiltered") : t("inbox.empty")}
            text={filtered || filters.view !== "open" ? t("inbox.emptyFilteredHint") : t("inbox.emptyHint")}
            icon="lifebuoy"
            action={
              filtered || filters.view !== "open" ? (
                <Key as={Link} to="/admin/support">
                  {t("inbox.clear")}
                </Key>
              ) : page.can.reply ? (
                <Key as={Link} to="/admin/support/new" icon="plus">
                  {t("nav.new")}
                </Key>
              ) : undefined
            }
          />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("inbox.title")}
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
                rowLabel={(row) => row.ref}
                busy={busy}
                maxHeight={null}
                selected={page.can.assign ? selected : undefined}
                onSelectedChange={page.can.assign ? setSelected : undefined}
                bulkActions={page.can.assign ? (ids) => <BulkActions ids={ids.filter((id) => ticketIds.has(id))} holders={holders} skipped={ids.filter((id) => !ticketIds.has(id)).length} agents={page.agents} onDone={() => setSelected([])} /> : undefined}
                footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => inboxSearch({ ...filters, page: n }) || "?"} />}
              />
            </div>
            <div className="md:hidden">
              <ul className="sup-cards" aria-label={t("inbox.title")}>
                {page.rows.map((row) => (
                  <li key={row.id}>
                    <InboxCard row={row} />
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => inboxSearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
      </section>
    </>
  );
}

function InboxCard({ row }: { row: InboxRow }) {
  const t = useSupportT();
  return (
    <Link to={rowHref(row)} className="sup-card">
      <span className="sup-card__top">
        <span className="type-strong">
          <Ref value={row.ref} />
        </span>
        <RowStatus kind={row.kind} status={row.status} />
      </span>
      <span className="sup-card__title type-body">{row.title}</span>
      <span className="sup-card__top type-caption text-ink-2">
        <span>{row.contact ?? t("inbox.noName")}</span>
        <ChannelLabel channel={row.channel} kind={row.kind} />
      </span>
      {row.due ? (
        <span className="type-caption">
          <Due at={row.due.at} late={row.due.late} target={row.due.target} />
        </span>
      ) : null}
      <span className="inline-flex flex-wrap items-center gap-1">
        <span className="type-caption text-ink-2">{row.assigned ? row.assigned.name : t("inbox.nobody")}</span>
        {row.kind === "ticket" ? <PriorityTag priority={row.priority} quiet /> : null}
        {row.escalatedTo ? <span className="sup-tag">{t("inbox.escalatedTo", { name: row.escalatedTo.name })}</span> : null}
        <DemoTag show={row.isDemo} />
      </span>
    </Link>
  );
}

function BulkActions({ ids, holders, skipped, agents, onDone }: { ids: string[]; holders: Map<string, string>; skipped: number; agents: { id: string; name: string }[]; onDone: () => void }) {
  const t = useSupportT();
  // the toast says how many were left as they were (closed, changed or taken since the list was shown)
  const assign = useIntent("bulk_assign", (result) => (Number(result.skipped ?? 0) > 0 ? { key: "inbox.bulkAssignedSome", vars: { assigned: Number(result.assigned ?? 0), skipped: Number(result.skipped) } } : "inbox.bulkAssigned"), onDone);
  const [confirming, setConfirming] = useState(false);
  const route = useIntent("bulk_route", (result) => (Number(result.skipped ?? 0) > 0 ? { key: "inbox.bulkRoutedSome", vars: { routed: Number(result.routed ?? 0), skipped: Number(result.skipped) } } : "inbox.bulkRouted"), () => {
    setConfirming(false);
    onDone();
  });
  if (ids.length === 0) return <span className="type-caption">{t("inbox.bulkOnlyTickets")}</span>;
  return (
    <div className="flex flex-wrap items-end gap-2">
      <assign.fetcher.Form method="post" className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="intent" value="bulk_assign" />
        {ids.map((id) => (
          <input key={id} type="hidden" name="ticketId" value={id} />
        ))}
        {ids.map((id) => (
          <input key={`expected-${id}`} type="hidden" name="expected" value={`${id}:${holders.get(id) ?? ""}`} />
        ))}
        <Select name="employeeId" label={t("inbox.bulkAssignTo")} defaultValue="" options={[{ value: "", label: t("inbox.nobody") }, ...agents.map((agent) => ({ value: agent.id, label: agent.name }))]} />
        <Key type="submit" size="sm" icon="users" loading={assign.pending}>
          {t("inbox.bulkAssign", { count: ids.length })}
        </Key>
      </assign.fetcher.Form>
      <Key size="sm" icon="swap" loading={route.pending} onClick={() => setConfirming(true)}>
        {t("inbox.bulkRoute", { count: ids.length })}
      </Key>
      {confirming ? (
        <ConfirmDialog
          open
          onClose={() => setConfirming(false)}
          title={t("inbox.bulkRouteQ", { count: ids.length })}
          consequence={t("inbox.bulkRouteWhat")}
          confirmLabel={t("inbox.bulkRoute", { count: ids.length })}
          pending={route.pending}
          error={route.message}
          onConfirm={() => {
            const data = new FormData();
            data.set("intent", "bulk_route");
            for (const id of ids) data.append("ticketId", id);
            route.fetcher.submit(data, { method: "post" });
          }}
        />
      ) : null}
      {skipped ? <span className="type-caption">{t("inbox.bulkSkipped", { count: skipped })}</span> : null}
      <Failure message={assign.message ?? route.message} />
    </div>
  );
}
