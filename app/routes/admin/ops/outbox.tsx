import { Form, Link } from "react-router";

import type { Route } from "./+types/outbox";
import { useFormat } from "~/i18n/react";
import { listOutbox, outboxOverview } from "~/server/services/admin/ops/job-monitor.server";
import { OUTBOX_CHANNELS, OUTBOX_STATUSES, OUTBOX_STATUS_TONE, outboxSearch, parseOutboxFilters, type OutboxRow } from "~/server/services/admin/ops/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Ago, Code, Kpi, LinkChips, Note, PageHead, Pair, ResponsiveList, Section, StatusText, When, keyLabel, tOr, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { ops } from "./ops.server";

/**
 * /admin/ops/outbox — 23.03, the message queue: what waits in the outbox (held for lack of a provider, queued, sent,
 * failed), per channel, the oldest held message, and the messages themselves with filters in the URL — the recipient
 * masked, the message's content never shown (a one-time code, an order's details: the customer's page has the
 * communication log, module 07).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.job.read");
  const filters = parseOutboxFilters(new URL(args.request.url).searchParams);
  const [overview, page] = await ops.orRespond(req, () => Promise.all([outboxOverview(req.db, req.actor), listOutbox(req.db, req.actor, filters)]));
  return { overview, page, filters, now: req.now };
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "outbox.title");

export default function OutboxPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const f = useFormat();
  const { overview, page, filters, now } = loaderData;
  const noProvider = !overview.deliver || overview.deliver.reason === "no_message_provider_configured";
  const templateName = (key: string) => tOr(t, `template.${key}`, keyLabel(key));
  const refCell = (row: OutboxRow) =>
    row.ref ? (
      row.ref.href ? (
        <Link to={row.ref.href} className="adm-link">
          <Code>{row.ref.label}</Code>
        </Link>
      ) : (
        <Code>{row.ref.label}</Code>
      )
    ) : (
      <span className="text-ink-2">—</span>
    );
  const columns: DataColumn<OutboxRow>[] = [
    { key: "created", header: t("outbox.col.created"), cell: (row) => <When at={row.createdAt} /> },
    { key: "channel", header: t("outbox.col.channel"), cell: (row) => t(`channel.${row.channel}`) },
    { key: "recipient", header: t("outbox.col.recipient"), cell: (row) => <Code>{row.recipient}</Code> },
    { key: "template", header: t("outbox.col.template"), cell: (row) => templateName(row.template) },
    { key: "status", header: t("outbox.col.status"), cell: (row) => <StatusText tone={OUTBOX_STATUS_TONE[row.status]}>{t(`outbox.status.${row.status}`)}</StatusText> },
    { key: "attempts", header: t("outbox.col.attempts"), numeric: true, cell: (row) => f.number(row.attempts) },
    { key: "ref", header: t("outbox.col.ref"), cell: refCell },
    { key: "error", header: t("outbox.col.error"), cell: (row) => (row.lastError ? <span className="line-clamp-2 type-caption text-red-ink">{row.lastError}</span> : <span className="text-ink-2">—</span>) },
  ];
  const chipHref = (status: string | null) => `/admin/ops/outbox${outboxSearch({ ...filters, status: status as never, page: 1 })}`;

  return (
    <>
      <PageHead title={t("outbox.title")} lead={t("outbox.lead")} />

      {noProvider ? (
        <Note tone="warn" icon="warning">
          <p>{t("outbox.noProvider")}</p>
          {overview.deliver ? (
            <p className="type-caption text-ink-2">
              {t("outbox.deliverLast", { status: t(`run.status.${overview.deliver.status}`) })} <Ago at={overview.deliver.at} now={now} />
            </p>
          ) : null}
        </Note>
      ) : null}

      <Section id="ops-outbox-figures" title={t("outbox.figures")}>
        <div className="ops-kpis">
          <Kpi label={t("outbox.status.held")} value={f.number(overview.held)} hint={overview.oldestHeldAt ? t("outbox.oldest", { at: f.relative(overview.oldestHeldAt, now) }) : undefined} to={chipHref("held")} />
          <Kpi label={t("outbox.status.queued")} value={f.number(overview.queued)} to={chipHref("queued")} />
          <Kpi label={t("outbox.status.failed")} value={f.number(overview.failed)} to={chipHref("failed")} />
        </div>
        {overview.counts.length ? (
          <div className="adm-card gap-2">
            <p className="type-label text-ink">{t("outbox.byChannel")}</p>
            <ul role="list" className="grid max-w-[28rem] gap-1">
              {overview.counts.map((row) => (
                <li key={`${row.status}:${row.channel}`} className="flex items-center justify-between gap-2 type-data">
                  <span>
                    {t(`channel.${row.channel}`)} · {t(`outbox.status.${row.status}`)}
                  </span>
                  <bdi className="nums">{f.number(row.count)}</bdi>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </Section>

      <Section id="ops-outbox-list" title={t("outbox.list")} aside={<span className="type-caption text-ink-2">{t("outbox.count", { count: page.total })}</span>}>
        <LinkChips
          label={t("outbox.filter.status")}
          items={[{ value: "all", label: t("common.all"), href: chipHref(null), selected: filters.status === null }, ...OUTBOX_STATUSES.map((status) => ({ value: status, label: t(`outbox.status.${status}`), href: chipHref(status), selected: filters.status === status }))]}
        />
        <Form method="get" className="ops-filters" preventScrollReset>
          {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
          <Select name="channel" label={t("outbox.filter.channel")} defaultValue={filters.channel ?? ""} options={[{ value: "", label: t("common.all") }, ...OUTBOX_CHANNELS.map((channel) => ({ value: channel, label: t(`channel.${channel}`) }))]} />
          <Select name="template" label={t("outbox.filter.template")} defaultValue={filters.template ?? ""} options={[{ value: "", label: t("common.all") }, ...page.templates.map((template) => ({ value: template, label: templateName(template) }))]} />
          <div className="flex gap-2">
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            {filters.channel || filters.template || filters.status ? (
              <Key as={Link} to="/admin/ops/outbox" variant="ghost">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
        <ResponsiveList
          caption={t("outbox.list")}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("outbox.empty")} text={t("outbox.emptyHint")} icon="envelope-simple" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/ops/outbox${outboxSearch({ ...filters, page: n })}`} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="type-strong">{templateName(row.template)}</span>
                <StatusText tone={OUTBOX_STATUS_TONE[row.status]}>{t(`outbox.status.${row.status}`)}</StatusText>
              </div>
              <Pair label={t("outbox.col.channel")}>{t(`channel.${row.channel}`)}</Pair>
              <Pair label={t("outbox.col.recipient")}>
                <Code>{row.recipient}</Code>
              </Pair>
              <Pair label={t("outbox.col.created")}>
                <When at={row.createdAt} />
              </Pair>
              <Pair label={t("outbox.col.ref")}>{refCell(row)}</Pair>
              {row.lastError ? <p className="line-clamp-3 type-caption text-red-ink">{row.lastError}</p> : null}
            </>
          )}
        />
        <p className="type-caption text-ink-2">{t("outbox.privacy")}</p>
      </Section>
    </>
  );
}
