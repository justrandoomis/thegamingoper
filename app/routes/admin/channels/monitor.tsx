import { Form, Link } from "react-router";

import type { Route } from "./+types/monitor";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { integrationMonitor } from "~/server/services/admin/channels/overview.server";
import { DELIVERY_STATUS_LIST, DELIVERY_TONE, deliverySearch, parseDeliveryFilters } from "~/server/services/admin/channels/types";
import { listDeliveries, listWebhooks, retryDelivery, type DeliveryRow } from "~/server/services/admin/channels/webhooks.server";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { ActionDialog, Ago, Code, DialogKey, Kpi, LinkChips, Note, PageHead, Pair, ResponsiveList, Section, StatusText, When, useChT } from "./components/ui";
import { ch, ok, text } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/monitor — 21.04: integration failures and retries (channels.integration.read, or the webhook and
 * provider managers). Webhook deliveries by status with filters in the URL (status, webhook, page), each with its
 * attempts, answer and error; a failed or given-up delivery made due again with a reason (the same delivery — the
 * receiver can drop a repeat by its id; a succeeded one is never sent again). Incoming provider events (none until a
 * provider is connected; a repeat never acts twice), the outbox's held and failed messages (listed by module 23), and
 * the boundaries said plainly: no delivery transport, no provider connected.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args);
  const filters = parseDeliveryFilters(new URL(args.request.url).searchParams);
  const [monitor, page, hooks] = await ch.orRespond(() =>
    Promise.all([integrationMonitor(req.db, req.actor, req.now), listDeliveries(req.db, req.actor, filters), can(req.actor, "channels.webhook.manage") ? listWebhooks(req.db, req.actor) : Promise.resolve(null)]),
  );
  return { monitor, page, filters, webhooks: hooks?.map((row) => ({ id: row.id, name: row.name })) ?? null, now: req.now };
}

export async function action(args: Route.ActionArgs) {
  const req = await ch.open(args, "channels.webhook.manage");
  const form = await ch.form(args.request).catch(() => new FormData());
  try {
    const result = await retryDelivery(req.db, req.actor, { deliveryId: text(form, "deliveryId"), reason: text(form, "reason") }, req.now);
    return ok("retry", { changed: result.changed });
  } catch (error) {
    return ch.failed(error, req, "retry");
  }
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "monitor.title");

export default function MonitorPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const f = useFormat();
  const { monitor, page, filters, webhooks, now } = loaderData;
  const chipHref = (status: string | null) => `/admin/channels/monitor${deliverySearch({ ...filters, status: status as never, page: 1 })}#ch-deliveries`;
  // the figures count every webhook's deliveries: each opens the list of every webhook (never the filtered one)
  const kpiHref = (status: string) => `/admin/channels/monitor${deliverySearch({ status: status as never })}#ch-deliveries`;
  const retry = (row: DeliveryRow) =>
    monitor.canRetry && (row.status === "failed" || row.status === "gave_up") ? (
      <DialogKey label={t("deliveries.retry")} icon="arrows-clockwise" variant="ghost">
        {(close) => (
          <ActionDialog
            open
            onClose={close}
            title={t("deliveries.retryTitle")}
            consequence={t("deliveries.retryText")}
            confirmLabel={t("deliveries.retry")}
            impact={[
              { label: t("deliveries.col.event"), value: row.event },
              { label: t("deliveries.col.attempts"), value: String(row.attempts) },
            ]}
            reason
            fields={{ deliveryId: row.id }}
            successMessage={t("deliveries.retried")}
          />
        )}
      </DialogKey>
    ) : null;
  const columns: DataColumn<DeliveryRow>[] = [
    { key: "created", header: t("deliveries.col.created"), cell: (row) => <When at={row.createdAt} /> },
    { key: "webhook", header: t("deliveries.col.webhook"), cell: (row) => (webhooks ? <Link to={`/admin/channels/webhooks/${row.webhookId}`} className="adm-link">{row.webhookName}</Link> : row.webhookName) },
    { key: "event", header: t("deliveries.col.event"), cell: (row) => <Code>{row.event}</Code> },
    { key: "ref", header: t("deliveries.col.ref"), cell: (row) => (row.ref ? <Code>{row.ref}</Code> : <span className="text-ink-2">—</span>) },
    { key: "status", header: t("deliveries.col.status"), cell: (row) => <StatusText tone={DELIVERY_TONE[row.status]}>{t(`deliveries.status.${row.status}`)}</StatusText> },
    { key: "attempts", header: t("deliveries.col.attempts"), numeric: true, cell: (row) => f.number(row.attempts) },
    { key: "answer", header: t("deliveries.col.answer"), cell: (row) => (row.responseStatus ? <Code>{String(row.responseStatus)}</Code> : <span className="text-ink-2">—</span>) },
    { key: "error", header: t("deliveries.col.error"), cell: (row) => (row.lastError ? <span className="line-clamp-2 type-caption text-red-ink">{row.lastError}</span> : <span className="text-ink-2">—</span>) },
    { key: "actions", header: t("deliveries.col.actions"), cell: retry },
  ];

  return (
    <>
      <PageHead title={t("monitor.title")} lead={t("monitor.lead")} />
      <Note tone="warn" icon="warning">
        <p>{t("monitor.transport")}</p>
        <p>{t("monitor.providersNone")}</p>
      </Note>

      <Section id="ch-monitor-figures" title={t("monitor.figures")}>
        <div className="ch-kpis">
          <Kpi label={t("monitor.kpi.waiting")} value={f.number(monitor.deliveries.counts.pending)} hint={monitor.deliveries.oldestPendingAt ? t("monitor.kpi.oldest", { at: f.relative(monitor.deliveries.oldestPendingAt, now) }) : t("monitor.kpi.noneWaiting")} to={kpiHref("pending")} />
          <Kpi label={t("monitor.kpi.failed")} value={f.number(monitor.deliveries.counts.failed)} hint={t("monitor.kpi.failed24h", { count: monitor.deliveries.failed24h })} to={kpiHref("failed")} />
          <Kpi label={t("monitor.kpi.gaveUp")} value={f.number(monitor.deliveries.counts.gave_up)} to={kpiHref("gave_up")} />
          <Kpi label={t("monitor.kpi.sent")} value={f.number(monitor.deliveries.counts.succeeded)} to={kpiHref("succeeded")} />
          <Kpi label={t("monitor.kpi.webhooks")} value={f.number(monitor.webhooks.active)} hint={t("monitor.kpi.webhooksHint", { paused: f.number(monitor.webhooks.paused), failing: f.number(monitor.webhooks.failing) })} />
        </div>
      </Section>

      <Section id="ch-deliveries" title={t("monitor.deliveries")} aside={<span className="type-caption text-ink-2">{t("monitor.count", { count: page.total })}</span>}>
        <LinkChips
          label={t("monitor.filterStatus")}
          items={[{ value: "all", label: t("common.all"), href: chipHref(null), selected: filters.status === null }, ...DELIVERY_STATUS_LIST.map((status) => ({ value: status, label: t(`deliveries.status.${status}`), href: chipHref(status), selected: filters.status === status, count: page.counts[status] }))]}
        />
        {webhooks && webhooks.length ? (
          <Form method="get" className="ch-filters" preventScrollReset>
            {filters.status ? <input type="hidden" name="status" value={filters.status} /> : null}
            <Select name="webhook" label={t("monitor.filterWebhook")} defaultValue={filters.webhook ?? ""} options={[{ value: "", label: t("common.all") }, ...webhooks.map((hook) => ({ value: hook.id, label: hook.name }))]} />
            <div>
              <Key type="submit" icon="funnel">
                {t("common.apply")}
              </Key>
              {filters.webhook || filters.status ? (
                <Key as={Link} to="/admin/channels/monitor" variant="ghost">
                  {t("common.clear")}
                </Key>
              ) : null}
            </div>
          </Form>
        ) : null}
        <ResponsiveList
          caption={t("monitor.deliveries")}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState icon="check-circle" title={filters.status || filters.webhook ? t("monitor.emptyFiltered") : t("monitor.empty")} text={filters.status || filters.webhook ? undefined : t("monitor.emptyHint")} />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/channels/monitor${deliverySearch({ ...filters, page: n })}`} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="type-strong">{row.webhookName}</span>
                <StatusText tone={DELIVERY_TONE[row.status]}>{t(`deliveries.status.${row.status}`)}</StatusText>
              </div>
              <Pair label={t("deliveries.col.event")}>
                <Code>{row.event}</Code>
              </Pair>
              {row.ref ? (
                <Pair label={t("deliveries.col.ref")}>
                  <Code>{row.ref}</Code>
                </Pair>
              ) : null}
              <Pair label={t("deliveries.col.created")}>
                <When at={row.createdAt} />
              </Pair>
              <Pair label={t("deliveries.col.attempts")}>{f.number(row.attempts)}</Pair>
              {row.lastError ? <p className="line-clamp-3 type-caption text-red-ink">{row.lastError}</p> : null}
              <div className="ch-actions">{retry(row)}</div>
            </>
          )}
        />
        <p className="type-caption text-ink-2">{t("monitor.noDuplicates")}</p>
      </Section>

      <div className="ch-split">
        <Section id="ch-monitor-inbound" title={t("monitor.inbound")}>
          <ul role="list" className="ch-list adm-card">
            {(["received", "processed", "ignored", "failed"] as const).map((status) => (
              <li key={status}>
                <span className="type-data">{t(`monitor.inboundStatus.${status}`)}</span>
                <bdi className="nums type-data">{f.number(monitor.inbound.counts[status] ?? 0)}</bdi>
              </li>
            ))}
          </ul>
          {monitor.inbound.failures.length ? (
            <ul role="list" className="grid gap-2">
              {monitor.inbound.failures.map((row) => (
                <li key={row.id} className="adm-card gap-1">
                  <Code>{row.id}</Code>
                  <span className="type-caption text-red-ink">{row.error ?? "—"}</span>
                  <Ago at={row.receivedAt} now={now} />
                </li>
              ))}
            </ul>
          ) : null}
          <p className="type-caption text-ink-2">{t("monitor.inboundNote")}</p>
        </Section>

        <Section id="ch-monitor-outbox" title={t("monitor.outbox")}>
          <ul role="list" className="ch-list adm-card">
            {(["held", "queued", "failed"] as const).map((status) => (
              <li key={status}>
                <span className="type-data">{t(`monitor.outboxStatus.${status}`)}</span>
                <bdi className="nums type-data">{f.number(monitor.outbox[status])}</bdi>
              </li>
            ))}
          </ul>
          <p className="type-caption text-ink-2">{t("monitor.outboxNote")}</p>
          {monitor.outbox.list ? (
            <Link to={monitor.outbox.list} className="adm-link type-label">
              {t("monitor.outboxOpen")}
            </Link>
          ) : null}
          {monitor.providers.errors.length ? (
            <ul role="list" className="grid gap-2">
              {monitor.providers.errors.map((row) => (
                <li key={`${row.kind}:${row.provider}`} className="adm-card gap-1">
                  <Code>{row.provider}</Code>
                  <span className="type-caption text-red-ink">{row.error}</span>
                  <When at={row.at} />
                </li>
              ))}
            </ul>
          ) : null}
        </Section>
      </div>
    </>
  );
}
