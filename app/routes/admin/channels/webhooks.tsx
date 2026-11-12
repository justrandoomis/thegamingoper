import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/webhooks";
import { useFormat } from "~/i18n/react";
import { canPointWebhooks, createWebhook, listWebhooks, queueNow, type WebhookRow } from "~/server/services/admin/channels/webhooks.server";
import { WEBHOOK_EVENTS } from "~/server/services/admin/channels/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, FieldGroup, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Code, FormError, Note, OnceSecret, PageHead, Pair, ResponsiveList, Section, StatusText, When, failureText, useChT } from "./components/ui";
import { all, ch, dataKey, newKey, ok, text } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/webhooks — 21.03: outgoing webhooks (channels.webhook.manage, the owner by default). Register an
 * https address on a public host for chosen order events — the signing secret is shown ONCE and stored encrypted with
 * DATA_KEY; check for new order events now (each is queued once, whatever is pressed twice). Nothing is sent to an
 * outside address yet: no delivery transport is configured (the boundary is explained on the page and in the monitor).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args, "channels.webhook.manage");
  const rows = await ch.orRespond(() => listWebhooks(req.db, req.actor));
  // a webhook sends order references and totals out: offered to who may read orders, without a branch limit
  return { rows, key: newKey(), canEncrypt: Boolean(dataKey()), canPoint: canPointWebhooks(req.actor) };
}

export async function action(args: Route.ActionArgs) {
  const req = await ch.open(args, "channels.webhook.manage");
  const form = await ch.form(args.request).catch(() => new FormData());
  const intent = text(form, "intent");
  try {
    if (intent === "create") {
      const result = await createWebhook(req.db, req.actor, dataKey(), { name: text(form, "name"), url: text(form, "url"), events: all(form, "event"), reason: text(form, "reason"), idempotencyKey: text(form, "formKey") }, req.now);
      return ok("create", { webhookId: result.webhookId, secret: result.secret, replayed: result.replayed });
    }
    if (intent === "queue") {
      const result = await queueNow(req.db, req.actor, req.now);
      return ok("queue", result);
    }
    throw new Response(null, { status: 400 });
  } catch (error) {
    return ch.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "webhooks.title");

export default function WebhooksPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const f = useFormat();
  const { rows } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const creating = navigation.state !== "idle" && navigation.formData?.get("intent") === "create";
  const queuing = navigation.state !== "idle" && navigation.formData?.get("intent") === "queue";
  const created = result?.intent === "create" && result.ok ? result : null;
  const createFailure = result?.intent === "create" && !result.ok ? result : null;
  const queued = result?.intent === "queue" && result.ok ? result : null;
  const fields = createFailure?.fields ?? {};
  const columns: DataColumn<WebhookRow>[] = [
    {
      key: "name",
      header: t("webhooks.col.name"),
      cell: (row) => (
        <Link to={`/admin/channels/webhooks/${row.id}`} className="adm-link">
          {row.name}
        </Link>
      ),
    },
    { key: "host", header: t("webhooks.col.host"), cell: (row) => <Code>{row.host}</Code> },
    { key: "events", header: t("webhooks.col.events"), cell: (row) => row.events.map((event) => t(`event.${event}`)).join(t("common.listSep")) },
    { key: "pending", header: t("webhooks.col.pending"), numeric: true, cell: (row) => f.number(row.counts.pending + row.counts.failed) },
    { key: "gaveUp", header: t("webhooks.col.gaveUp"), numeric: true, cell: (row) => f.number(row.counts.gave_up) },
    { key: "last", header: t("webhooks.col.lastSuccess"), cell: (row) => <When at={row.lastSuccessAt} /> },
    { key: "state", header: t("webhooks.col.state"), cell: (row) => <StatusText tone={row.isActive ? "ok" : "out"}>{t(row.isActive ? "webhooks.active" : "webhooks.paused")}</StatusText> },
  ];
  return (
    <>
      <PageHead title={t("webhooks.title")} lead={t("webhooks.lead")} />
      <Note tone="warn" icon="warning">
        <p>{t("webhooks.boundary")}</p>
      </Note>

      {created ? (
        created.secret ? (
          <OnceSecret title={t("webhooks.createdTitle")} value={created.secret} note={t("webhooks.createdNote")} />
        ) : (
          <Note tone="warn" icon="warning">
            <p>{t("webhooks.replayedNote")}</p>
          </Note>
        )
      ) : null}

      <Section
        id="ch-webhooks"
        title={t("webhooks.list")}
        aside={
          rows.length ? (
            <Form method="post" className="ch-noprint">
              <input type="hidden" name="intent" value="queue" />
              <Key type="submit" size="sm" icon="arrows-clockwise" loading={queuing}>
                {t("webhooks.queueNow")}
              </Key>
            </Form>
          ) : null
        }
      >
        {queued ? (
          <Note tone="ok" icon="check-circle">
            <p>{t("webhooks.queued", { queued: f.number(queued.queued), scanned: f.number(queued.scanned) })}</p>
          </Note>
        ) : null}
        {result?.intent === "queue" && !result.ok ? <FormError message={failureText(t, result)} /> : null}
        <ResponsiveList
          caption={t("webhooks.list")}
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          empty={<EmptyState icon="plugs-connected" title={t("webhooks.empty")} text={t("webhooks.emptyHint")} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/channels/webhooks/${row.id}`} className="adm-link type-strong">
                  {row.name}
                </Link>
                <StatusText tone={row.isActive ? "ok" : "out"}>{t(row.isActive ? "webhooks.active" : "webhooks.paused")}</StatusText>
              </div>
              <Pair label={t("webhooks.col.host")}>
                <Code>{row.host}</Code>
              </Pair>
              <Pair label={t("webhooks.col.pending")}>{f.number(row.counts.pending + row.counts.failed)}</Pair>
              <Pair label={t("webhooks.col.gaveUp")}>{f.number(row.counts.gave_up)}</Pair>
            </>
          )}
        />
        <p className="type-caption text-ink-2">{t("webhooks.queueNote")}</p>
      </Section>

      <Section id="ch-webhook-new" title={t("webhooks.new")}>
        {!loaderData.canEncrypt ? (
          <Note tone="bad" icon="warning-circle">
            <p>{t("errors.data_key_missing")}</p>
          </Note>
        ) : null}
        {!loaderData.canPoint ? (
          <Note tone="warn" icon="lock">
            <p>{t("webhooks.cannotPoint")}</p>
          </Note>
        ) : (
          <Form method="post" className="grid max-w-[44rem] gap-4" noValidate>
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="formKey" value={loaderData.key} />
            <TextField name="name" label={t("webhooks.field.name")} required maxLength={80} error={fields.name} />
            <TextField name="url" type="url" label={t("webhooks.field.url")} hint={t("webhooks.field.urlHint")} required ltr maxLength={500} placeholder="https://" error={fields.url} />
            <FieldGroup legend={t("webhooks.field.events")} required error={fields.events}>
              {WEBHOOK_EVENTS.map((event) => (
                <Checkbox key={event} name="event" value={event} label={t(`event.${event}`)} hint={<Code>{event}</Code>} />
              ))}
            </FieldGroup>
            <TextField name="reason" label={t("common.reason")} required maxLength={500} error={fields.reason} />
            <FormError message={createFailure ? (createFailure.fields ? t("common.checkFields") : failureText(t, createFailure)) : null} />
            <div className="ch-actions">
              <Key type="submit" variant="ink" icon="plus" loading={creating}>
                {t("webhooks.create")}
              </Key>
            </div>
          </Form>
        )}
      </Section>
    </>
  );
}
