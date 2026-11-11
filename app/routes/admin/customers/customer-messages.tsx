import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/customer-messages";
import { Icon } from "~/art/Icon";
import { throwAsResponse } from "~/server/errors";
import { listCommunication, type CommunicationLog, type CommunicationRow } from "~/server/services/admin/customers/communication.server";
import { CONTACT_CHANNELS, CONTACT_DIRECTIONS, MESSAGE_TEMPLATES } from "~/server/services/admin/customers/types";
import { Select, TextArea } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { messagesAction } from "./actions.server";
import { openCustomers, respond } from "./customers.server";
import { customersMeta } from "./meta";
import { Failure, Notice, PhoneText, Ref, Section, useCustomersT, useIntent, When } from "./ui";

/**
 * /admin/customers/:customerId/messages — 07.07: the communication log, linked to the customer's orders (filter by
 * order in the URL), without sensitive financial data: messages the store wrote (held — no provider is connected, so
 * nothing says "delivered") with only the facts of the event, and contacts staff logged by hand (append-only).
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openCustomers(context, "customers.communication.read");
  const orderRef = new URL(request.url).searchParams.get("order");
  try {
    return { log: await listCommunication(db, actor, { customerId: params.customerId, orderRef: orderRef ? orderRef.slice(0, 40) : null }, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openCustomers(context);
  return respond(await messagesAction(req.ctx, req.db, req.session, params.customerId, await request.formData()));
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, "messages.title");

export default function CustomerMessagesPage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { log } = loaderData;
  return (
    <div className="cus-layout">
      <div className="cus-main">
        <Section id="messages-log" title={t("messages.title")}>
          <Notice icon="info">{t("messages.boundary")}</Notice>
          {log.orders.length ? (
            <Form method="get" className="flex flex-wrap items-end gap-2">
              <Select name="order" label={t("messages.order")} defaultValue={log.orderRef ?? ""} options={[{ value: "", label: t("messages.allOrders") }, ...log.orders.map((order) => ({ value: order.ref, label: order.ref }))]} />
              <Key type="submit" size="sm" icon="funnel">
                {t("messages.filter")}
              </Key>
            </Form>
          ) : null}
          {log.rows.length === 0 ? (
            <p className="type-body text-ink-2">{log.orderRef ? t("messages.noneForOrder") : t("messages.none")}</p>
          ) : (
            <ol className="cus-timeline">
              {log.rows.map((row) => (
                <LogRow key={`${row.kind}-${row.id}`} row={row} />
              ))}
            </ol>
          )}
          {log.truncated ? <p className="type-caption text-ink-2">{t("messages.truncated")}</p> : null}
        </Section>
      </div>
      <aside className="cus-side" aria-label={t("messages.side")}>
        {log.canLog ? <LogContact log={log} /> : null}
        <Section id="messages-rules" title={t("messages.rulesTitle")}>
          <p className="type-body text-ink-2">{t("messages.rules")}</p>
        </Section>
      </aside>
    </div>
  );
}

function templateLabel(t: (key: string) => string, template: string) {
  return (MESSAGE_TEMPLATES as readonly string[]).includes(template) ? t(`template.${template}`) : template;
}

function LogRow({ row }: { row: CommunicationRow }) {
  const t = useCustomersT();
  if (row.kind === "contact") {
    return (
      <li data-actor="employee">
        <span className="flex flex-wrap items-center gap-2 type-body">
          <Icon name={row.channel === "whatsapp" ? "whatsapp-logo" : row.channel === "phone" ? "phone" : row.channel === "email" ? "envelope-simple" : "chat-circle"} size={16} />
          {t(`contact.direction.${row.direction}`)} · {t(`contactChannel.${row.channel}`)}
          {row.orderRef ? (
            <>
              {" · "}
              <Link to={`/admin/orders/${row.orderRef}`} className="adm-link">
                <Ref value={row.orderRef} />
              </Link>
            </>
          ) : null}
        </span>
        <span className="cus-quote">{row.summary}</span>
        <span className="type-caption text-ink-2">
          {row.by ?? t("actor.employee")} · <When at={row.at} />
        </span>
      </li>
    );
  }
  const tone = row.status === "sent" ? "ok" : row.status === "failed" ? "bad" : row.status === "queued" ? "info" : "neutral";
  return (
    <li data-actor="system">
      <span className="flex flex-wrap items-center gap-2 type-body">
        <Icon name={row.channel === "whatsapp" ? "whatsapp-logo" : row.channel === "email" ? "envelope-simple" : "chat-circle"} size={16} />
        {templateLabel(t, row.template)}
        <Status tone={tone}>{t(`messageStatus.${row.status}`)}</Status>
        {row.orderRef ? (
          <Link to={`/admin/orders/${row.orderRef}`} className="adm-link">
            <Ref value={row.orderRef} />
          </Link>
        ) : null}
      </span>
      {row.facts.length ? (
        <span className="type-caption">
          {row.facts.map((fact) => (
            <span key={fact.field} className="me-3 inline-block">
              {t(`messageField.${fact.field}`)}: <bdi dir="ltr">{fact.field === "status" ? t(`orderStatus.${fact.value}`) : fact.value}</bdi>
            </span>
          ))}
        </span>
      ) : null}
      {row.hidden > 0 ? <span className="type-caption text-ink-2">{t("messages.hidden", { count: row.hidden })}</span> : null}
      <span className="type-caption text-ink-2">
        {t(`contactChannel.${row.channel === "sms" ? "sms" : row.channel}`)} · <PhoneText phone={row.recipient} /> · <When at={row.at} />
        {row.sentAt ? (
          <>
            {" · "}
            {t("messages.sentAt")} <When at={row.sentAt} />
          </>
        ) : null}
      </span>
    </li>
  );
}

function LogContact({ log }: { log: CommunicationLog }) {
  const t = useCustomersT();
  const [summary, setSummary] = useState("");
  const { fetcher, pending, message, fields } = useIntent("log", "done.logged", () => setSummary(""));
  return (
    <Section id="messages-log-contact" title={t("messages.logTitle")}>
      <fetcher.Form method="post" className="grid gap-3">
        <input type="hidden" name="intent" value="log" />
        <Select name="channel" label={t("messages.channel")} defaultValue="phone" options={CONTACT_CHANNELS.map((channel) => ({ value: channel, label: t(`contactChannel.${channel}`) }))} />
        <Select name="direction" label={t("messages.direction")} defaultValue="outbound" options={CONTACT_DIRECTIONS.map((direction) => ({ value: direction, label: t(`contact.direction.${direction}`) }))} />
        {log.orders.length ? (
          <Select name="orderRef" label={t("messages.aboutOrder")} defaultValue={log.orderRef ?? ""} options={[{ value: "", label: t("messages.noOrder") }, ...log.orders.map((order) => ({ value: order.ref, label: order.ref }))]} error={fields.orderRef} />
        ) : null}
        <TextArea name="summary" label={t("messages.summary")} hint={t("messages.summaryHint")} value={summary} onChange={(event) => setSummary(event.currentTarget.value)} rows={3} maxLength={500} error={fields.summary} required />
        <Failure message={Object.keys(fields).length ? null : message} />
        <div>
          <Key type="submit" size="sm" icon="pencil-simple" loading={pending}>
            {t("messages.log")}
          </Key>
        </div>
      </fetcher.Form>
    </Section>
  );
}
