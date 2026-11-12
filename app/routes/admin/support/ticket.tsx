import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/ticket";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { escalationTargets } from "~/server/services/admin/support/escalation.server";
import { getTicket, type TicketDetail, type TicketEventView, type TicketMessageView } from "~/server/services/admin/support/tickets.server";
import { ESCALATION_KINDS, INBOUND_VIA, REPLY_VIA, STATUS_WITH_REASON, TICKET_CATEGORIES, TICKET_PRIORITIES, type EscalationKind, type RouteDecision, type TicketStatus } from "~/server/services/admin/support/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { FieldGroup, Radio, Select, TextArea, TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Tabs } from "~/ui/Tabs";
import { ticketIntent } from "./actions.server";
import { supportMeta } from "./meta";
import { failed, openSupport, urls } from "./support.server";
import { Boundary, ChannelLabel, DemoTag, Facts, Failure, listOf, PhoneText, PriorityTag, Ref, RepairStatusBadge, Section, SlaLine, TicketStatusBadge, useIntent, useSupportT, When } from "./ui";

/**
 * /admin/support/tickets/:ref — one ticket (14.02): the conversation (the customer's messages, staff replies — held in
 * the outbox, no provider — internal notes, and every change from the audit trail), the reply composer with canned
 * replies filled from the ticket and reviewed before they are recorded (14.04), status, SLA targets, who holds it and
 * why (routing, 14.03), priority / category / team, the records it is about (customer, order, product, warranty,
 * repair, return — kept by their ids), escalation of a financial or warranty complaint to an authorized person
 * (14.07), the assistant's conversation and the private photos. Prints as the ticket's record.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openSupport(context, "support.ticket.read");
  try {
    const ticket = await getTicket(db, actor, params.ref, locale, now, urls);
    const targets = ticket.can.escalate ? await escalationTargets(db, actor) : null;
    return { ticket, targets, me: actor.id, now, keys: { reply: newKeyServer(), note: newKeyServer(), inbound: newKeyServer() } };
  } catch (error) {
    throwAsResponse(error);
  }
}

function newKeyServer() {
  return crypto.randomUUID();
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openSupport(context, "support.ticket.read");
  const form = await request.formData();
  const intent = typeof form.get("intent") === "string" ? String(form.get("intent")) : null;
  try {
    return await ticketIntent(db, actor, params.ref, form, now);
  } catch (error) {
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => supportMeta(args, null, undefined, args.loaderData ? `${args.loaderData.ticket.ref} · ${args.loaderData.ticket.subject}` : null);

type Data = Route.ComponentProps["loaderData"];

export default function TicketPage({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const { ticket } = loaderData;
  const escalatedAway = ticket.escalation && !ticket.escalation.handedBack;
  return (
    <div className="sup-print grid min-w-0 gap-6">
      <header className="adm-page-head">
        <p className="adm-eyebrow sup-noprint">
          <Link to="/admin/support" className="adm-link">
            {t("ticket.back")}
          </Link>
        </p>
        <p className="type-caption text-ink-2">
          <Ref value={ticket.ref} /> · {t(`category.${ticket.category}`)} · <When at={ticket.createdAt} />
        </p>
        <h1 className="adm-title sup-card__title">{ticket.subject}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <TicketStatusBadge status={ticket.status} />
          <PriorityTag priority={ticket.priority} />
          <ChannelLabel channel={ticket.channel} />
          {ticket.team ? <span className="sup-tag">{t("inbox.team", { team: ticket.team })}</span> : null}
          <DemoTag show={ticket.isDemo} />
          <span className="sup-noprint ms-auto">
            <Key size="sm" icon="printer" onClick={() => window.print()}>
              {t("ticket.print")}
            </Key>
          </span>
        </div>
      </header>

      {escalatedAway ? <EscalationBanner data={loaderData} /> : null}

      <div className="sup-layout">
        <div className="grid min-w-0 gap-6">
          <Section id="ticket-thread" title={t("ticket.conversation")}>
            <Thread ticket={ticket} />
          </Section>
          {ticket.can.reply && ticket.status !== "closed" ? <Composer data={loaderData} /> : ticket.status === "closed" ? <p className="type-body text-ink-2">{t("ticket.closedNote")}</p> : null}
        </div>
        <aside className="sup-side" aria-label={t("ticket.side")}>
          <StatusPanel ticket={ticket} />
          <SlaPanel ticket={ticket} />
          <HolderPanel ticket={ticket} />
          {ticket.can.assign ? <TriagePanel ticket={ticket} /> : null}
          <ContactPanel ticket={ticket} />
          <LinksPanel ticket={ticket} />
          {ticket.can.escalate && !escalatedAway ? <EscalatePanel data={loaderData} /> : null}
          {ticket.assistant ? <AssistantPanel ticket={ticket} /> : null}
          {ticket.photos.length ? <PhotosPanel ticket={ticket} /> : null}
        </aside>
      </div>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── the conversation

function Thread({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  if (ticket.timeline.length === 0) return <p className="type-body text-ink-2">{t("ticket.noMessages")}</p>;
  return (
    <ol className="sup-thread">
      {ticket.timeline.map((item) => (
        <li key={item.id}>{item.kind === "message" ? <Message message={item} ticket={ticket} /> : <EventLine event={item} />}</li>
      ))}
    </ol>
  );
}

function Message({ message, ticket }: { message: TicketMessageView; ticket: TicketDetail }) {
  const t = useSupportT();
  const author =
    message.author === "customer"
      ? (ticket.contact.name ?? t("ticket.customer"))
      : message.author === "employee"
        ? (message.authorName ?? t("ticket.staff"))
        : message.author === "assistant"
          ? t("ticket.assistantAuthor")
          : t("ticket.system");
  return (
    <article className="sup-msg" data-author={message.author} data-internal={message.internal ? "true" : "false"}>
      <div className="sup-msg__head">
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="type-strong">{author}</span>
          {message.internal ? (
            <span className="sup-tag">
              <Icon name="eye-slash" size={13} />
              {t("ticket.internal")}
            </span>
          ) : null}
          {message.fromCanned ? <span className="sup-tag">{t(message.fromCanned.edited ? "ticket.fromCannedEdited" : "ticket.fromCanned")}</span> : null}
        </span>
        <span className="type-caption text-ink-2">
          <When at={message.at} />
        </span>
      </div>
      <p className="sup-msg__body">{message.body || t("ticket.photoOnly")}</p>
      {message.photos.length ? (
        <ul className="sup-photos" aria-label={t("ticket.photos")}>
          {message.photos.map((photo, index) => (
            <li key={photo.id}>
              <a href={photo.url} target="_blank" rel="noreferrer">
                <img src={photo.url} alt={t("ticket.photoAlt", { n: index + 1 })} width={104} height={104} loading="lazy" decoding="async" />
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      <Delivery message={message} />
    </article>
  );
}

function Delivery({ message }: { message: TicketMessageView }) {
  const t = useSupportT();
  if (message.author === "customer" && message.via) return <p className="type-caption text-ink-2">{t("ticket.recordedFrom", { name: message.recordedBy ?? t("ticket.staff"), via: t(`inboundVia.${message.via}`) })}</p>;
  if (message.author !== "employee" || message.internal) return null;
  if (message.outbox)
    return (
      <p className="inline-flex flex-wrap items-center gap-1 type-caption text-ink-2">
        <Icon name="cloud-slash" size={14} />
        {t(message.outbox.status === "held" ? "ticket.heldVia" : "ticket.outboxVia", { via: t(`replyVia.${message.outbox.channel}`), status: t(`outboxStatus.${message.outbox.status}`) })}
      </p>
    );
  if (message.via === "call" || message.via === "in_person") return <p className="type-caption text-ink-2">{t(`ticket.toldBy.${message.via}`)}</p>;
  return null;
}

/** One change from the audit trail as one sentence (who did what), its reason as an outlined tag. */
function EventLine({ event }: { event: TicketEventView }) {
  const t = useSupportT();
  const f = useFormat();
  const who = event.actor.name ?? t(`actor.${event.actor.kind}`);
  const d = event.data;
  const str = (key: string) => (typeof d[key] === "string" ? (d[key] as string) : "");
  let sentence: string;
  switch (event.action) {
    case "create":
      sentence = t("event.create", { channel: t(`channel.${str("channel") || "web"}`) });
      break;
    case "open":
      sentence = t("event.open", { who, channel: t(`channel.${str("channel") || "phone"}`) });
      break;
    case "status":
      sentence = t("event.status", { who, from: t(`ticketStatus.${str("before.status") || "open"}`), to: t(`ticketStatus.${str("status") || "open"}`) });
      break;
    case "assign":
      sentence = d.taken ? t("event.took", { who }) : str("assignedTo") ? t("event.assign", { who, name: str("assignedToName") || "—" }) : t("event.unassign", { who });
      break;
    case "route":
      sentence = t("event.route", { who: event.actor.kind === "system" ? t("actor.system") : who, why: routeWhy(t, { ruleName: str("ruleName") || null, fallback: (str("fallback") || null) as RouteDecision["fallback"], agentName: str("agent.name") || null, open: typeof d["agent.open"] === "number" ? (d["agent.open"] as number) : null, capacity: typeof d["agent.capacity"] === "number" ? (d["agent.capacity"] as number) : null, team: str("team") || null, keyword: str("matched.keyword") || null, category: str("matched.category") || null }, f.number) });
      break;
    case "triage":
      sentence = t("event.triage", { who, priority: t(`priority.${str("priority") || "normal"}`), category: t(`category.${str("category") || "other"}`) });
      break;
    case "link":
      sentence = t("event.link", { who, field: t(`links.${str("field") || "order"}`) });
      break;
    case "escalate":
      sentence = t("event.escalate", { who, name: str("escalatedToName") || "—", kind: t(`escalation.kind.${str("kind") || "financial"}`) });
      break;
    case "escalation_return":
      sentence = t("event.escalationReturn", { who });
      break;
    default:
      sentence = t("event.other", { who, action: event.action });
  }
  return (
    <p className="sup-event" data-actor={event.actor.kind}>
      <span className="sup-event__text">
        <span>{sentence}</span> <span className="nums whitespace-nowrap"><When at={event.at} /></span> {event.reason ? <span className="sup-reason">{event.reason}</span> : null}
      </span>
    </p>
  );
}

type Why = { ruleName: string | null; fallback: RouteDecision["fallback"]; agentName: string | null; open: number | null; capacity: number | null; team: string | null; keyword: string | null; category: string | null };

/** Why a ticket went where it went, in words. */
function routeWhy(t: (key: string, vars?: Record<string, string | number>) => string, why: Why, number: (n: number) => string): string {
  if (!why.ruleName || why.fallback === "no_rule") return t("routing.why.noRule");
  const parts = [t("routing.why.rule", { rule: why.ruleName })];
  if (why.category) parts.push(t("routing.why.category", { category: t(`category.${why.category}`) }));
  if (why.keyword) parts.push(t("routing.why.keyword", { keyword: why.keyword }));
  if (why.agentName) parts.push(t("routing.why.agent", { name: why.agentName, open: number(why.open ?? 0), capacity: number(why.capacity ?? 0) }));
  else if (why.fallback === "capacity_full") parts.push(t("routing.why.capacityFull", { team: why.team ?? "—" }));
  else if (why.fallback === "pool_empty") parts.push(t("routing.why.poolEmpty", { team: why.team ?? "—" }));
  else if (why.team) parts.push(t("routing.why.team", { team: why.team }));
  return parts.join(" · ");
}

function decisionWhy(decision: RouteDecision): Why {
  return {
    ruleName: decision.ruleName,
    fallback: decision.fallback,
    agentName: decision.agent?.name ?? null,
    open: decision.agent?.open ?? null,
    capacity: decision.agent?.capacity ?? null,
    team: decision.team,
    keyword: decision.matched?.keyword ?? null,
    category: decision.matched?.category ?? null,
  };
}

// ───────────────────────────────────────────────────────────────── composer (reply · note · customer message)

function Composer({ data }: { data: Data }) {
  const t = useSupportT();
  const [tab, setTab] = useState("reply");
  return (
    <section className="adm-section sup-noprint" aria-labelledby="ticket-compose">
      <h2 id="ticket-compose" className="adm-h2">
        {t("compose.title")}
      </h2>
      <Tabs
        aria-label={t("compose.title")}
        value={tab}
        onChange={setTab}
        items={[
          { value: "reply", label: t("compose.reply"), content: <ReplyForm data={data} /> },
          { value: "note", label: t("compose.note"), content: <NoteForm data={data} /> },
          { value: "inbound", label: t("compose.inbound"), content: <InboundForm data={data} /> },
        ]}
      />
    </section>
  );
}

type Preview = { text: string; missing: string[]; fallback: boolean; replyId: string; title: string; locale: string };

function ReplyForm({ data }: { data: Data }) {
  const t = useSupportT();
  const { ticket, keys } = data;
  const [body, setBody] = useState("");
  const [canned, setCanned] = useState<{ id: string; original: string; missing: string[]; fallback: boolean } | null>(null);
  const [pick, setPick] = useState("");
  const [via, setVia] = useState<string>(ticket.replyVia.includes("whatsapp") ? "whatsapp" : (ticket.replyVia[0] ?? "call"));
  const send = useIntent("reply", (result) => (result.held ? "done.replyHeld" : "done.reply"), () => {
    setBody("");
    setCanned(null);
    setPick("");
  });
  const preview = useIntent("preview", null, (result) => {
    const value = result.preview as Preview;
    setBody(value.text);
    setCanned({ id: value.replyId, original: value.text, missing: value.missing, fallback: value.fallback });
  });
  const written = via === "whatsapp" || via === "sms" || via === "email";
  const left = [...body.matchAll(/\{([a-z_]{1,40})\}/g)].map((match) => match[1]);
  return (
    <div className="grid gap-4 pt-3">
      {ticket.canned.length ? (
        <div className="flex flex-wrap items-end gap-2">
          <Select name="replyId" label={t("compose.canned")} hint={t("compose.cannedHint")} value={pick} onChange={(event) => setPick(event.currentTarget.value)} options={[{ value: "", label: t("compose.cannedChoose") }, ...ticket.canned.map((reply) => ({ value: reply.id, label: reply.title }))]} />
          <Key size="sm" icon="arrow-down" disabled={!pick} loading={preview.pending} onClick={() => preview.fetcher.submit({ intent: "preview", replyId: pick }, { method: "post" })}>
            {t("compose.cannedInsert")}
          </Key>
        </div>
      ) : (
        <p className="type-caption text-ink-2">
          {t("compose.noCanned")}{" "}
          <Link to="/admin/support/replies" className="adm-link">
            {t("nav.replies")}
          </Link>
        </p>
      )}
      <Failure message={preview.message} />
      {canned && canned.fallback ? <p className="type-caption text-ink-2">{t("compose.cannedFallback")}</p> : null}
      <send.fetcher.Form method="post" className="grid gap-3">
        <input type="hidden" name="intent" value="reply" />
        <input type="hidden" name="idempotencyKey" value={keys.reply} />
        {canned ? <input type="hidden" name="cannedReplyId" value={canned.id} /> : null}
        {canned && body !== canned.original ? <input type="hidden" name="edited" value="1" /> : null}
        <TextArea name="body" label={t("compose.replyLabel")} hint={t("compose.replyHint")} value={body} onChange={(event) => setBody(event.currentTarget.value)} rows={6} required error={send.fields.body} />
        {left.length ? (
          <p role="status" className="flex items-start gap-1 type-caption text-red-ink">
            <Icon name="warning-circle" size={16} className="mt-0.5 flex-none" />
            {t("compose.fillIn", { names: listOf([...new Set(left)].map((name) => `{${name}}`), t("listSep")) })}
          </p>
        ) : null}
        <FieldGroup legend={t("compose.via")} error={send.fields.via} layout="row">
          {REPLY_VIA.map((option) => {
            const available = ticket.replyVia.includes(option);
            return <Radio key={option} name="via" value={option} label={t(`replyVia.${option}`)} hint={available ? undefined : t(option === "email" ? "compose.noEmail" : "compose.noPhone")} disabled={!available} checked={via === option} onChange={() => setVia(option)} />;
          })}
        </FieldGroup>
        <Select name="then" label={t("compose.then")} defaultValue="pending_customer" options={(ticket.can.resolve ? ["pending_customer", "keep", "resolved"] : ["pending_customer", "keep"]).map((value) => ({ value, label: t(`compose.thenOption.${value}`) }))} />
        <Boundary>{written ? t("compose.heldNote") : t("compose.recordedNote")}</Boundary>
        <Failure message={send.message} />
        <div className="sup-actions">
          <Key type="submit" variant="ink" icon="paper-plane-tilt" loading={send.pending} disabled={body.trim().length < 2}>
            {written ? t("compose.recordWritten") : t("compose.recordSpoken")}
          </Key>
        </div>
      </send.fetcher.Form>
    </div>
  );
}

function NoteForm({ data }: { data: Data }) {
  const t = useSupportT();
  const [body, setBody] = useState("");
  const note = useIntent("note", "done.note", () => setBody(""));
  return (
    <note.fetcher.Form method="post" className="grid gap-3 pt-3">
      <input type="hidden" name="intent" value="note" />
      <input type="hidden" name="idempotencyKey" value={data.keys.note} />
      <TextArea name="body" label={t("compose.noteLabel")} hint={t("compose.noteHint")} value={body} onChange={(event) => setBody(event.currentTarget.value)} rows={4} required error={note.fields.body} />
      <Failure message={note.message} />
      <div>
        <Key type="submit" icon="eye-slash" loading={note.pending} disabled={body.trim().length < 2}>
          {t("compose.addNote")}
        </Key>
      </div>
    </note.fetcher.Form>
  );
}

function InboundForm({ data }: { data: Data }) {
  const t = useSupportT();
  const [body, setBody] = useState("");
  const inbound = useIntent("inbound", "done.inbound", () => setBody(""));
  return (
    <inbound.fetcher.Form method="post" className="grid gap-3 pt-3">
      <input type="hidden" name="intent" value="inbound" />
      <input type="hidden" name="idempotencyKey" value={data.keys.inbound} />
      <Select name="via" label={t("compose.inboundVia")} defaultValue="whatsapp" options={INBOUND_VIA.map((via) => ({ value: via, label: t(`inboundVia.${via}`) }))} error={inbound.fields.via} />
      <TextArea name="body" label={t("compose.inboundLabel")} hint={t("compose.inboundHint")} value={body} onChange={(event) => setBody(event.currentTarget.value)} rows={4} required error={inbound.fields.body} />
      <Failure message={inbound.message} />
      <div>
        <Key type="submit" icon="chat-circle" loading={inbound.pending} disabled={body.trim().length < 2}>
          {t("compose.recordInbound")}
        </Key>
      </div>
    </inbound.fetcher.Form>
  );
}

// ───────────────────────────────────────────────────────────────── side panels

function StatusPanel({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  const [to, setTo] = useState<TicketStatus | null>(null);
  const { fetcher, pending, message } = useIntent("status", "done.status", () => setTo(null));
  if (ticket.transitions.length === 0) return null;
  const destructive = to === "closed";
  return (
    <section className="sup-panel sup-noprint" aria-labelledby="ticket-status">
      <h2 id="ticket-status" className="adm-h3">
        {t("ticket.statusTitle")}
      </h2>
      <div className="sup-actions">
        {ticket.transitions.map((status) => (
          <Key key={status} size="sm" variant={status === "resolved" ? "ink" : "clay"} onClick={() => setTo(status)}>
            {t(`statusAction.${status}`)}
          </Key>
        ))}
      </div>
      {to ? (
        <ConfirmDialog
          open
          onClose={() => setTo(null)}
          tone={destructive ? "destructive" : "neutral"}
          title={t("ticket.statusQ", { ref: ticket.ref, status: t(`ticketStatus.${to}`) })}
          consequence={t(`statusWhat.${to}`)}
          confirmLabel={t(`statusAction.${to}`)}
          reason={STATUS_WITH_REASON.includes(to) ? { label: t(to === "resolved" ? "ticket.resolution" : "dialog.reason"), hint: t(to === "resolved" ? "ticket.resolutionHint" : "dialog.reasonHint") } : { noteRequired: false, label: t("dialog.noteOptional") }}
          pending={pending}
          error={message}
          onConfirm={({ reason }) => fetcher.submit({ intent: "status", from: ticket.status, to, reason }, { method: "post" })}
        />
      ) : null}
    </section>
  );
}

function SlaPanel({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  const none = !ticket.sla.firstResponse.dueAt && !ticket.sla.resolution.dueAt;
  return (
    <section className="sup-panel" aria-labelledby="ticket-sla">
      <h2 id="ticket-sla" className="adm-h3">
        {t("ticket.slaTitle")}
      </h2>
      <SlaLine label={t("sla.firstResponse")} dueAt={ticket.sla.firstResponse.dueAt} doneAt={ticket.sla.firstResponse.doneAt} clock={ticket.sla.firstResponse.clock} />
      <SlaLine label={t("sla.resolution")} dueAt={ticket.sla.resolution.dueAt} doneAt={ticket.sla.resolution.doneAt} clock={ticket.sla.resolution.clock} />
      {none ? (
        <p className="type-caption text-ink-2">
          {t("ticket.slaNone")}{" "}
          <Link to="/admin/support/sla" className="adm-link sup-noprint">
            {t("nav.sla")}
          </Link>
        </p>
      ) : null}
    </section>
  );
}

function HolderPanel({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  const f = useFormat();
  const take = useIntent("take", "done.take");
  const assign = useIntent("assign", "done.assign");
  const route = useIntent("route", "done.route");
  const [confirmRoute, setConfirmRoute] = useState(false);
  return (
    <section className="sup-panel" aria-labelledby="ticket-holder">
      <h2 id="ticket-holder" className="adm-h3">
        {t("ticket.holderTitle")}
      </h2>
      <p className="type-body">{ticket.assigned ? ticket.assigned.name : t("inbox.nobody")}</p>
      {ticket.routing ? (
        <p className="type-caption text-ink-2">
          <Icon name="swap" size={14} className="me-1 inline" />
          {routeWhy(t, decisionWhy(ticket.routing.decision), f.number)}
        </p>
      ) : null}
      <div className="sup-actions sup-noprint">
        {ticket.can.take ? (
          <take.fetcher.Form method="post">
            <input type="hidden" name="intent" value="take" />
            <Key type="submit" size="sm" variant="ink" icon="user" loading={take.pending}>
              {t("ticket.take")}
            </Key>
          </take.fetcher.Form>
        ) : null}
        {ticket.can.route ? (
          <Key size="sm" icon="swap" loading={route.pending} onClick={() => (ticket.assigned ? setConfirmRoute(true) : route.fetcher.submit({ intent: "route" }, { method: "post" }))}>
            {t("ticket.routeAgain")}
          </Key>
        ) : null}
      </div>
      <Failure message={take.message ?? route.message} />
      {ticket.can.assign && ticket.agents.length ? (
        <assign.fetcher.Form method="post" className="grid gap-2 sup-noprint">
          <input type="hidden" name="intent" value="assign" />
          <input type="hidden" name="expected" value={ticket.assigned?.id ?? ""} />
          <Select
            name="employeeId"
            label={t("ticket.assignTo")}
            defaultValue={ticket.assigned?.id ?? ""}
            options={[{ value: "", label: t("inbox.nobody") }, ...ticket.agents.map((agent) => ({ value: agent.id, label: t("ticket.agentLoad", { name: agent.name, count: agent.open }) }))]}
            error={assign.fields.employeeId}
          />
          <div>
            <Key type="submit" size="sm" icon="users" loading={assign.pending}>
              {t("ticket.assign")}
            </Key>
          </div>
          <Failure message={assign.message} />
        </assign.fetcher.Form>
      ) : null}
      {confirmRoute ? (
        <ConfirmDialog
          open
          onClose={() => setConfirmRoute(false)}
          title={t("ticket.routeQ")}
          consequence={t("ticket.routeWhat", { name: ticket.assigned?.name ?? "" })}
          confirmLabel={t("ticket.routeAgain")}
          pending={route.pending}
          error={route.message}
          onConfirm={() => {
            route.fetcher.submit({ intent: "route" }, { method: "post" });
            setConfirmRoute(false);
          }}
        />
      ) : null}
    </section>
  );
}

function TriagePanel({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  const { fetcher, pending, message, fields } = useIntent("triage", "done.triage");
  return (
    <section className="sup-panel sup-noprint" aria-labelledby="ticket-triage">
      <h2 id="ticket-triage" className="adm-h3">
        {t("ticket.triageTitle")}
      </h2>
      <fetcher.Form method="post" className="grid gap-2" key={ticket.updatedAt}>
        <input type="hidden" name="intent" value="triage" />
        <input type="hidden" name="expectedUpdatedAt" value={ticket.updatedAt} />
        <Select name="priority" label={t("inbox.priority")} defaultValue={ticket.priority} options={TICKET_PRIORITIES.map((priority) => ({ value: priority, label: t(`priority.${priority}`) }))} error={fields.priority} />
        <Select name="category" label={t("inbox.category")} defaultValue={ticket.category} options={TICKET_CATEGORIES.map((category) => ({ value: category, label: t(`category.${category}`) }))} error={fields.category} />
        <TextField name="team" label={t("inbox.teamLabel")} hint={t("ticket.teamHint")} defaultValue={ticket.team ?? ""} optional error={fields.team} />
        <p className="type-caption text-ink-2">{t("ticket.triageSla")}</p>
        <Failure message={message} />
        <div>
          <Key type="submit" size="sm" icon="floppy-disk" loading={pending}>
            {t("ticket.triageSave")}
          </Key>
        </div>
      </fetcher.Form>
    </section>
  );
}

function ContactPanel({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  return (
    <section className="sup-panel" aria-labelledby="ticket-contact">
      <h2 id="ticket-contact" className="adm-h3">
        {t("ticket.contactTitle")}
      </h2>
      <Facts
        single
        rows={[
          { label: t("ticket.name"), value: ticket.contact.name ?? "—" },
          { label: t("ticket.phone"), value: <PhoneText phone={ticket.contact.phone} call />, hidden: !ticket.contact.phone },
          { label: t("ticket.email"), value: <bdi dir="ltr">{ticket.contact.email}</bdi>, hidden: !ticket.contact.email },
          { label: t("ticket.language"), value: t(`language.${ticket.locale}`) },
        ]}
      />
    </section>
  );
}

const LINKS = ["customer", "order", "product", "warranty", "repair", "return"] as const;

function LinksPanel({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  const f = useFormat();
  const value = (field: (typeof LINKS)[number]) => {
    switch (field) {
      case "customer":
        return ticket.customer ? (ticket.customer.href ? <Link to={ticket.customer.href} className="adm-link">{ticket.customer.name ?? t("links.account")}</Link> : t("links.accountLinked")) : null;
      case "order":
        return ticket.order ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            {ticket.order.href ? (
              <Link to={ticket.order.href} className="adm-link">
                <Ref value={ticket.order.ref} />
              </Link>
            ) : (
              <Ref value={ticket.order.ref} />
            )}
            {ticket.order.status ? <span className="type-caption text-ink-2">· {t(`vars.orderStatus.${ticket.order.status}`)}</span> : null}
          </span>
        ) : null;
      case "product":
        return ticket.product ? (ticket.product.href ? <Link to={ticket.product.href} className="adm-link">{ticket.product.name}</Link> : ticket.product.name) : null;
      case "warranty":
        return ticket.warranty ? (
          <span>
            {ticket.warranty.href ? (
              <Link to={ticket.warranty.href} className="adm-link">
                {t(`warrantyState.${ticket.warranty.state}`)}
              </Link>
            ) : (
              t(`warrantyState.${ticket.warranty.state}`)
            )}{" "}
            <span className="type-caption text-ink-2">· {t("links.warrantyEnds", { date: f.date(ticket.warranty.endsAt) })}</span>
          </span>
        ) : null;
      case "repair":
        return ticket.repair ? (
          <span className="inline-flex flex-wrap items-center gap-1">
            <Link to={ticket.repair.href} className="adm-link">
              <Ref value={ticket.repair.ref} />
            </Link>
            <RepairStatusBadge status={ticket.repair.status} />
          </span>
        ) : null;
      case "return":
        return ticket.rma ? (ticket.rma.href ? <Link to={ticket.rma.href} className="adm-link"><Ref value={ticket.rma.rma} /></Link> : <Ref value={ticket.rma.rma} />) : null;
    }
  };
  const linked = LINKS.filter((field) => value(field) !== null);
  return (
    <section className="sup-panel" aria-labelledby="ticket-links">
      <h2 id="ticket-links" className="adm-h3">
        {t("links.title")}
      </h2>
      <p className="type-caption text-ink-2 sup-noprint">{t("links.lead")}</p>
      {linked.length ? (
        <ul className="grid gap-3">
          {linked.map((field) => (
            <li key={field} className="flex items-start justify-between gap-2">
              <span className="grid min-w-0 gap-0.5">
                <span className="type-caption text-ink-2">{t(`links.${field}`)}</span>
                <span className="type-body">{value(field)}</span>
              </span>
              {ticket.can.reply ? <Unlink field={field} /> : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-body text-ink-2">{t("links.nothing")}</p>
      )}
      {ticket.can.reply && ticket.linkable.length ? <LinkEditor ticket={ticket} /> : null}
      {ticket.order && ticket.can.rmaCreate ? (
        <div className="sup-actions sup-noprint">
          <Key as={Link} to={`/admin/returns/new?order=${encodeURIComponent(ticket.order.ref)}`} size="sm" icon="arrow-u-up-left">
            {t("links.openRma")}
          </Key>
        </div>
      ) : null}
      {ticket.customerSuggestion && !ticket.customer && ticket.can.reply ? <SuggestCustomer ticket={ticket} /> : null}
    </section>
  );
}

function SuggestCustomer({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  const { fetcher, pending, message } = useIntent("link", "done.link");
  const suggestion = ticket.customerSuggestion;
  if (!suggestion) return null;
  return (
    <fetcher.Form method="post" className="grid gap-2 sup-noprint">
      <input type="hidden" name="intent" value="link" />
      <input type="hidden" name="field" value="customer" />
      <input type="hidden" name="value" value={suggestion.id} />
      <p className="type-caption">{t("links.suggestion", { name: suggestion.name ?? t("links.account") })}</p>
      <div>
        <Key type="submit" size="sm" icon="link" loading={pending}>
          {t("links.linkAccount")}
        </Key>
      </div>
      <Failure message={message} />
    </fetcher.Form>
  );
}

/** Removes one link (the record itself is untouched; the ticket keeps the event in its history). */
function Unlink({ field }: { field: (typeof LINKS)[number] }) {
  const t = useSupportT();
  const { fetcher, pending } = useIntent("link", "done.link");
  return (
    <fetcher.Form method="post" className="sup-noprint">
      <input type="hidden" name="intent" value="link" />
      <input type="hidden" name="field" value={field} />
      <input type="hidden" name="value" value="" />
      <IconKey type="submit" size="sm" icon="x" label={t("links.unlinkField", { field: t(`links.${field}`) })} loading={pending} />
    </fetcher.Form>
  );
}

/** One form for every kind of link: what it is, then its reference (a warranty is picked from the ticket's own). */
function LinkEditor({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  const first = ticket.order && ticket.warrantyOptions.length && ticket.linkable.includes("warranty") ? "warranty" : ticket.linkable.includes("order") && !ticket.order ? "order" : ticket.linkable[0];
  const [field, setField] = useState<(typeof LINKS)[number]>(first ?? "repair");
  const { fetcher, pending, message, fields } = useIntent("link", "done.link");
  return (
    <div className="sup-noprint">
      <Disclosure summary={t("links.add")} variant="row">
        <fetcher.Form method="post" className="grid gap-2 pt-2">
          <input type="hidden" name="intent" value="link" />
          <Select name="field" label={t("links.what")} value={field} onChange={(event) => setField(event.currentTarget.value as (typeof LINKS)[number])} options={ticket.linkable.map((option) => ({ value: option, label: t(`links.${option}`) }))} />
          {field === "warranty" && ticket.warrantyOptions.length ? (
            <Select key="warranty" name="value" label={t("links.warranty")} defaultValue={ticket.warranty?.id ?? ""} options={ticket.warrantyOptions.map((option) => ({ value: option.id, label: option.label }))} error={fields.value} />
          ) : (
            <TextField key={field} name="value" label={t(`links.input.${field}`)} hint={t(`links.hint.${field}`)} defaultValue="" ltr={field !== "customer"} required error={fields.value} />
          )}
          <Failure message={message} />
          <div>
            <Key type="submit" size="sm" icon="link" loading={pending}>
              {t("links.save")}
            </Key>
          </div>
        </fetcher.Form>
      </Disclosure>
    </div>
  );
}

function EscalationBanner({ data }: { data: Data }) {
  const t = useSupportT();
  const { ticket, me } = data;
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("return_escalation", "done.escalationReturn", () => setOpen(false));
  const escalation = ticket.escalation;
  if (!escalation) return null;
  const mine = escalation.to?.id === me;
  return (
    <section className={mine ? "adm-card adm-card--act" : "adm-card"} aria-labelledby="ticket-escalation">
      <h2 id="ticket-escalation" className="flex items-center gap-2 adm-h3">
        <Icon name="flag" size={18} className="text-red-ink" />
        {t("escalation.bannerTitle", { name: escalation.to?.name ?? "—", kind: t(`escalation.kind.${escalation.kind ?? "financial"}`) })}
      </h2>
      {escalation.reason ? <p className="type-body sup-msg__body">{escalation.reason}</p> : null}
      <p className="type-caption text-ink-2">{t(mine ? "escalation.bannerMine" : "escalation.bannerOthers")}</p>
      {mine || ticket.can.escalate || ticket.can.handBack ? (
        <div className="sup-actions sup-noprint">
          {ticket.order?.href ? (
            <Key as={Link} to={ticket.order.href} size="sm" icon="receipt">
              {t("escalation.openOrder")}
            </Key>
          ) : null}
          {/* its holder, or a colleague who may decide it and did not escalate it (covering while they are away) */}
          {ticket.can.handBack ? (
            <Key size="sm" variant="ink" icon="arrow-u-up-left" onClick={() => setOpen(true)}>
              {t("escalation.handBack")}
            </Key>
          ) : null}
        </div>
      ) : null}
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title={t("escalation.handBackQ", { ref: ticket.ref })}
          consequence={t("escalation.handBackWhat")}
          confirmLabel={t("escalation.handBack")}
          reason={{ label: t("escalation.outcome"), hint: t("escalation.outcomeHint"), minLength: 10, maxLength: 1000 }}
          pending={pending}
          error={message}
          onConfirm={({ reason }) => fetcher.submit({ intent: "return_escalation", outcome: reason }, { method: "post" })}
        />
      ) : null}
    </section>
  );
}

function EscalatePanel({ data }: { data: Data }) {
  const t = useSupportT();
  const { ticket, targets } = data;
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<EscalationKind>(ticket.category === "warranty" || ticket.category === "repair" ? "warranty" : "financial");
  const [to, setTo] = useState("");
  const [tried, setTried] = useState(false);
  const { fetcher, pending, message, fields } = useIntent("escalate", "done.escalate", () => setOpen(false));
  const people = targets?.[kind] ?? [];
  return (
    <section className="sup-panel sup-noprint" aria-labelledby="ticket-escalate">
      <h2 id="ticket-escalate" className="adm-h3">
        {t("escalation.title")}
      </h2>
      <p className="type-caption text-ink-2">{t("escalation.lead")}</p>
      <div>
        <Key size="sm" icon="flag" onClick={() => setOpen(true)}>
          {t("escalation.open")}
        </Key>
      </div>
      {open ? (
        <ConfirmDialog
          open
          onClose={() => setOpen(false)}
          title={t("escalation.q", { ref: ticket.ref })}
          consequence={t("escalation.what")}
          confirmLabel={t("escalation.confirm")}
          impact={[
            { label: t("escalation.impact.priority"), value: t(`priority.${ticket.priority === "urgent" ? "urgent" : "high"}`) },
            { label: t("escalation.impact.status"), value: t("ticketStatus.pending_staff") },
            { label: t("escalation.impact.money"), value: t("escalation.impact.moneyValue") },
          ]}
          reason={{ label: t("escalation.reason"), hint: t("escalation.reasonHint"), minLength: 10, maxLength: 1000 }}
          pending={pending}
          error={message ?? fields.toEmployeeId ?? null}
          onConfirm={({ reason }) => {
            if (!to) {
              setTried(true);
              return;
            }
            fetcher.submit({ intent: "escalate", kind, toEmployeeId: to, reason, expected: ticket.escalation?.to?.id ?? "" }, { method: "post" });
          }}
        >
          <div className="grid gap-3">
            <FieldGroup legend={t("escalation.kindLabel")} layout="row">
              {ESCALATION_KINDS.map((option) => (
                <Radio
                  key={option}
                  name="kind"
                  value={option}
                  label={t(`escalation.kind.${option}`)}
                  checked={kind === option}
                  onChange={() => {
                    setKind(option);
                    setTo("");
                  }}
                />
              ))}
            </FieldGroup>
            <p className="type-caption text-ink-2">{t(`escalation.who.${kind}`)}</p>
            {people.length ? (
              <Select name="toEmployeeId" label={t("escalation.to")} value={to} onChange={(event) => setTo(event.currentTarget.value)} options={[{ value: "", label: t("escalation.choose") }, ...people.map((person) => ({ value: person.id, label: person.name }))]} required error={!to && tried ? t("escalation.chooseError") : undefined} />
            ) : (
              <p role="alert" className="type-body text-red-ink">
                {t("escalation.nobody")}
              </p>
            )}
          </div>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}

function AssistantPanel({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  const assistant = ticket.assistant;
  if (!assistant) return null;
  return (
    <section className="sup-panel" aria-labelledby="ticket-assistant">
      <h2 id="ticket-assistant" className="flex items-center gap-2 adm-h3">
        <Icon name="robot" size={18} className="text-ink-2" />
        {t("assistant.title")}
      </h2>
      <p className="type-caption text-ink-2">{t("assistant.lead")}</p>
      {!assistant.stored ? <p className="type-caption text-ink-2">{t("assistant.purged")}</p> : null}
      {assistant.messages === null && assistant.stored ? <p className="type-caption text-ink-2">{t("assistant.needsPermission")}</p> : null}
      {assistant.messages && assistant.messages.length ? (
        <Disclosure summary={t("assistant.transcript", { count: assistant.messages.length })} variant="row">
          <ol className="sup-timeline pt-2">
            {assistant.messages.map((row, index) => (
              <li key={index}>
                <span className="type-caption text-ink-2">
                  {t(`assistant.role.${row.role}`)}
                  {row.confidence ? ` · ${t(`assistant.confidence.${row.confidence}`)}` : ""}
                  {row.sources ? ` · ${t("assistant.sources", { count: row.sources })}` : ""}
                </span>
                <span className="type-body sup-msg__body">{row.content}</span>
                {row.flags.length ? (
                  <span className="sup-chips">
                    {row.flags.map((flag) => (
                      <span key={flag} className="sup-tag">
                        <Icon name="warning" size={13} className="text-warn" />
                        {flag}
                      </span>
                    ))}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        </Disclosure>
      ) : null}
    </section>
  );
}

function PhotosPanel({ ticket }: { ticket: TicketDetail }) {
  const t = useSupportT();
  return (
    <section className="sup-panel" aria-labelledby="ticket-photos">
      <h2 id="ticket-photos" className="adm-h3">
        {t("ticket.photos")}
      </h2>
      <p className="type-caption text-ink-2">{t("ticket.photosPrivate")}</p>
      <ul className="sup-photos">
        {ticket.photos.map((photo, index) => (
          <li key={photo.id}>
            <a href={photo.url} target="_blank" rel="noreferrer">
              <img src={photo.url} alt={t("ticket.photoAlt", { n: index + 1 })} width={104} height={104} loading="lazy" decoding="async" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

