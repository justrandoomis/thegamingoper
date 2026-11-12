import { useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/webhook";
import { useFormat } from "~/i18n/react";
import { canPointWebhooks, getWebhook, retryDelivery, rotateWebhookSecret, sendPing, setWebhookActive, updateWebhook, type DeliveryRow } from "~/server/services/admin/channels/webhooks.server";
import { DELIVERY_TONE, WEBHOOK_EVENTS } from "~/server/services/admin/channels/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, FieldGroup, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog, Code, DialogKey, FormError, Kpi, Note, OnceSecret, PageHead, Pair, ResponsiveList, Section, StatusText, When, failureText, useChT } from "./components/ui";
import { all, ch, dataKey, ok, text } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/webhooks/:webhookId — 21.03 / 21.04: one webhook. Its address and events (a save is refused when the
 * webhook changed since the page was built), pause / resume, a new signing secret (shown once; the old one stops at
 * once), a "ping" to queue, and its latest deliveries with their attempts, answers and errors — a failed or given-up one
 * can be made due again (the same delivery, never a second one). Everything with a reason and an audit event.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args, "channels.webhook.manage");
  const webhook = await ch.orRespond(() => getWebhook(req.db, req.actor, args.params.webhookId));
  return { webhook, now: req.now, canPoint: canPointWebhooks(req.actor) };
}

export async function action(args: Route.ActionArgs) {
  const req = await ch.open(args, "channels.webhook.manage");
  const form = await ch.form(args.request).catch(() => new FormData());
  const intent = text(form, "intent");
  const webhookId = args.params.webhookId;
  try {
    if (intent === "save") {
      const result = await updateWebhook(req.db, req.actor, { webhookId, name: text(form, "name"), url: text(form, "url"), events: all(form, "event"), fingerprint: text(form, "fingerprint"), reason: text(form, "reason") }, req.now);
      return ok("save", { changed: result.changed });
    }
    if (intent === "active") {
      const result = await setWebhookActive(req.db, req.actor, { webhookId, active: text(form, "active") === "1", reason: text(form, "reason") }, req.now);
      return ok("active", { changed: result.changed });
    }
    if (intent === "rotate") {
      const result = await rotateWebhookSecret(req.db, req.actor, dataKey(), { webhookId, reason: text(form, "reason") }, req.now);
      return ok("rotate", { secret: result.secret });
    }
    if (intent === "ping") {
      const result = await sendPing(req.db, req.actor, { webhookId }, req.now);
      return ok("ping", { deliveryId: result.deliveryId });
    }
    if (intent === "retry") {
      const result = await retryDelivery(req.db, req.actor, { deliveryId: text(form, "deliveryId"), reason: text(form, "reason") }, req.now);
      return ok("retry", { changed: result.changed });
    }
    throw new Response(null, { status: 400 });
  } catch (error) {
    return ch.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "webhook.title", { name: args.loaderData?.webhook.name ?? "" });

export default function WebhookPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const f = useFormat();
  const { webhook, now, canPoint } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formData?.get("intent") === "save";
  const saveResult = result?.intent === "save" ? result : null;
  const fields = (saveResult && !saveResult.ok ? saveResult.fields : undefined) ?? {};
  // the new secret arrives through the dialog's request, once; it lives only in this page's memory
  const [rotated, setRotated] = useState<string | null>(null);
  const columns: DataColumn<DeliveryRow>[] = [
    { key: "created", header: t("deliveries.col.created"), cell: (row) => <When at={row.createdAt} /> },
    { key: "event", header: t("deliveries.col.event"), cell: (row) => <Code>{row.event}</Code> },
    { key: "ref", header: t("deliveries.col.ref"), cell: (row) => (row.ref ? <Code>{row.ref}</Code> : <span className="text-ink-2">—</span>) },
    { key: "status", header: t("deliveries.col.status"), cell: (row) => <StatusText tone={DELIVERY_TONE[row.status]}>{t(`deliveries.status.${row.status}`)}</StatusText> },
    { key: "attempts", header: t("deliveries.col.attempts"), numeric: true, cell: (row) => f.number(row.attempts) },
    { key: "next", header: t("deliveries.col.next"), cell: (row) => (row.status === "pending" || row.status === "failed" ? <When at={row.nextAttemptAt ?? row.createdAt} /> : <span className="text-ink-2">—</span>) },
    { key: "error", header: t("deliveries.col.error"), cell: (row) => (row.lastError ? <span className="line-clamp-2 type-caption text-red-ink">{row.lastError}</span> : <span className="text-ink-2">—</span>) },
    { key: "actions", header: t("deliveries.col.actions"), cell: (row) => <RetryKey row={row} /> },
  ];
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/channels/webhooks" className="adm-link">
            {t("webhook.back")}
          </Link>
        }
        title={webhook.name}
        lead={
          <>
            <StatusText tone={webhook.isActive ? "ok" : "out"}>{t(webhook.isActive ? "webhooks.active" : "webhooks.paused")}</StatusText> · <Code>{webhook.url}</Code>
          </>
        }
        actions={
          <>
            {webhook.isActive ? (
              <Form method="post">
                <input type="hidden" name="intent" value="ping" />
                <Key type="submit" size="sm" icon="paper-plane-tilt" loading={navigation.state !== "idle" && navigation.formData?.get("intent") === "ping"}>
                  {t("webhook.ping")}
                </Key>
              </Form>
            ) : null}
            {webhook.isActive || canPoint ? (
              <DialogKey label={t(webhook.isActive ? "webhook.pause" : "webhook.resume")} icon={webhook.isActive ? "hourglass" : "check-circle"}>
                {(close) => (
                  <ActionDialog
                    open
                    onClose={close}
                    title={t(webhook.isActive ? "webhook.pauseTitle" : "webhook.resumeTitle", { name: webhook.name })}
                    consequence={t(webhook.isActive ? "webhook.pauseText" : "webhook.resumeText")}
                    confirmLabel={t(webhook.isActive ? "webhook.pause" : "webhook.resume")}
                    impact={[{ label: t("webhooks.col.pending"), value: f.number(webhook.counts.pending + webhook.counts.failed) }]}
                    reason
                    fields={{ intent: "active", active: webhook.isActive ? "0" : "1" }}
                    successMessage={t(webhook.isActive ? "webhook.paused" : "webhook.resumed")}
                  />
                )}
              </DialogKey>
            ) : null}
            <DialogKey label={t("webhook.rotate")} icon="key">
              {(close) => (
                <ActionDialog
                  open
                  onClose={close}
                  title={t("webhook.rotateTitle", { name: webhook.name })}
                  consequence={t("webhook.rotateText")}
                  confirmLabel={t("webhook.rotate")}
                  tone="destructive"
                  reason
                  fields={{ intent: "rotate" }}
                  successMessage={t("webhook.rotated")}
                  onDone={(data) => setRotated(typeof data.secret === "string" ? data.secret : null)}
                />
              )}
            </DialogKey>
          </>
        }
      />
      {result?.intent === "ping" && result.ok ? (
        <Note tone="ok" icon="check-circle">
          <p>{t("webhook.pinged")}</p>
        </Note>
      ) : null}
      {result && !result.ok && result.intent !== "save" ? <FormError message={failureText(t, result)} /> : null}
      {rotated ? <OnceSecret title={t("webhook.rotatedTitle")} value={rotated} note={t("webhooks.createdNote")} /> : null}

      <Section id="ch-webhook-figures" title={t("webhook.figures")}>
        <div className="ch-kpis">
          <Kpi label={t("deliveries.status.pending")} value={f.number(webhook.counts.pending)} hint={t("webhook.pendingHint")} to={`/admin/channels/monitor?webhook=${webhook.id}&status=pending`} />
          <Kpi label={t("deliveries.status.failed")} value={f.number(webhook.counts.failed)} to={`/admin/channels/monitor?webhook=${webhook.id}&status=failed`} />
          <Kpi label={t("deliveries.status.gave_up")} value={f.number(webhook.counts.gave_up)} to={`/admin/channels/monitor?webhook=${webhook.id}&status=gave_up`} />
          <Kpi label={t("deliveries.status.succeeded")} value={f.number(webhook.counts.succeeded)} hint={webhook.lastSuccessAt ? f.relative(webhook.lastSuccessAt, now) : t("webhook.neverSent")} />
        </div>
      </Section>

      <div className="ch-split">
        <Section id="ch-webhook-deliveries" title={t("webhook.deliveries")} aside={<Link to={`/admin/channels/monitor?webhook=${webhook.id}`} className="adm-link type-label">{t("webhook.allDeliveries")}</Link>}>
          <ResponsiveList
            caption={t("webhook.deliveries")}
            columns={columns}
            rows={webhook.deliveries}
            rowKey={(row) => row.id}
            empty={<EmptyState icon="paper-plane-tilt" title={t("webhook.noDeliveries")} text={t("webhook.noDeliveriesHint")} />}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <Code>{row.event}</Code>
                  <StatusText tone={DELIVERY_TONE[row.status]}>{t(`deliveries.status.${row.status}`)}</StatusText>
                </div>
                <Pair label={t("deliveries.col.created")}>
                  <When at={row.createdAt} />
                </Pair>
                {row.ref ? (
                  <Pair label={t("deliveries.col.ref")}>
                    <Code>{row.ref}</Code>
                  </Pair>
                ) : null}
                <Pair label={t("deliveries.col.attempts")}>{f.number(row.attempts)}</Pair>
                {row.lastError ? <p className="line-clamp-3 type-caption text-red-ink">{row.lastError}</p> : null}
                <div className="ch-actions">
                  <RetryKey row={row} />
                </div>
              </>
            )}
          />
        </Section>

        <Section id="ch-webhook-edit" title={t("webhook.edit")}>
          {canPoint ? (
            <Form method="post" className="grid gap-4" noValidate>
              <input type="hidden" name="intent" value="save" />
              <input type="hidden" name="fingerprint" value={webhook.fingerprint} />
              <TextField name="name" label={t("webhooks.field.name")} required maxLength={80} defaultValue={webhook.name} error={fields.name} />
              <TextField name="url" type="url" label={t("webhooks.field.url")} hint={t("webhooks.field.urlHint")} required ltr maxLength={500} defaultValue={webhook.url} error={fields.url} />
              <FieldGroup legend={t("webhooks.field.events")} required error={fields.events}>
                {WEBHOOK_EVENTS.map((event) => (
                  <Checkbox key={event} name="event" value={event} label={t(`event.${event}`)} defaultChecked={webhook.events.includes(event)} />
                ))}
              </FieldGroup>
              <TextField name="reason" label={t("common.reason")} required maxLength={500} error={fields.reason} />
              <FormError message={saveResult && !saveResult.ok ? (saveResult.fields ? t("common.checkFields") : failureText(t, saveResult)) : null} />
              {saveResult?.ok ? <p className="type-caption text-ink-2">{t(saveResult.changed ? "webhook.saved" : "branch.unchanged")}</p> : null}
              <div className="ch-actions">
                <Key type="submit" variant="ink" icon="floppy-disk" loading={saving}>
                  {t("webhook.save")}
                </Key>
              </div>
            </Form>
          ) : (
            <Note tone="warn" icon="lock">
              <p>{t("webhooks.cannotPoint")}</p>
            </Note>
          )}
        </Section>
      </div>
    </>
  );
}

function RetryKey({ row }: { row: DeliveryRow }) {
  const t = useChT();
  if (row.status !== "failed" && row.status !== "gave_up") return null;
  return (
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
          fields={{ intent: "retry", deliveryId: row.id }}
          successMessage={t("deliveries.retried")}
        />
      )}
    </DialogKey>
  );
}
