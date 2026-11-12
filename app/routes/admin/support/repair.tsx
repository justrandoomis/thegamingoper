import { Link, redirect, useActionData, useNavigation, Form } from "react-router";

import type { Route } from "./+types/repair";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { getRepairRequest, openRepairTicket } from "~/server/services/admin/support/repairs.server";
import { STAFF_CHANNELS, type StaffChannel } from "~/server/services/admin/support/types";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { supportMeta } from "./meta";
import { failed, openSupport, text, urls } from "./support.server";
import { Boundary, DemoTag, Due, Facts, Failure, Money, PhoneText, plainText, Ref, RepairStatusBadge, Section, TicketStatusBadge, useSupportT, When } from "./ui";

/**
 * /admin/support/repairs/:ref — a repair request in the support inbox (14.01): the device, the problem in the
 * customer's words, their hand-over and day preferences, the private photos, where the repair stands (the status
 * events module 12 writes, which the storefront's status page reads too), its SLA, and the support tickets about it —
 * with a ticket for a call about it. The repair's work happens in Returns & warranty (module 12).
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openSupport(context, "support.ticket.read");
  try {
    return { repair: await getRepairRequest(db, actor, params.ref, locale, now, urls), key: crypto.randomUUID() };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, actor, locale, now, storeMode } = await openSupport(context, "support.ticket.reply");
  const form = await request.formData();
  try {
    const result = await openRepairTicket(db, actor, { repairRef: params.ref, channel: text(form, "channel") as StaffChannel, subject: text(form, "subject"), message: text(form, "message"), idempotencyKey: text(form, "idempotencyKey") }, now, storeMode);
    throw redirect(`/admin/support/tickets/${result.ref}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "ticket");
  }
}

export const meta: Route.MetaFunction = (args) => supportMeta(args, "repair.title", { ref: args.loaderData?.repair.ref ?? "" });

export default function RepairRequest({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const f = useFormat();
  const navigation = useNavigation();
  const result = useActionData<typeof action>();
  const failure = result && "ok" in result && !result.ok ? result : null;
  const { repair, key } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/support?view=repairs" className="adm-link">
            {t("repair.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-3">
          <Ref value={repair.ref} />
          <DemoTag show={repair.isDemo} />
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <RepairStatusBadge status={repair.status} />
          {repair.isWarranty ? <span className="sup-tag">{t("repair.warrantyTag")}</span> : null}
          {repair.slaDueAt ? <Due at={repair.slaDueAt} late={repair.late} target="repair" /> : <span className="type-caption text-ink-2">{t("repair.slaNone")}</span>}
        </div>
      </header>
      <Boundary icon="wrench">{t("repair.boundary")}</Boundary>
      {repair.workHref ? (
        <div className="sup-actions">
          <Key as={Link} to={repair.workHref} variant="ink" iconEnd="arrow-right">
            {t("repair.work")}
          </Key>
        </div>
      ) : (
        <p className="type-caption text-ink-2">{t("repair.noWorkAccess")}</p>
      )}
      <div className="sup-layout">
        <div className="grid min-w-0 gap-6">
          <Section id="repair-issue" title={t("repair.issue")}>
            <p className="sup-msg__body">{repair.issue}</p>
            {repair.photos.length ? (
              <ul className="sup-photos" aria-label={t("ticket.photos")}>
                {repair.photos.map((photo, index) => (
                  <li key={photo.id}>
                    <a href={photo.url} target="_blank" rel="noreferrer">
                      <img src={photo.url} alt={t("ticket.photoAlt", { n: index + 1 })} width={104} height={104} loading="lazy" decoding="async" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-caption text-ink-2">{t("repair.noPhotos")}</p>
            )}
          </Section>
          <Section id="repair-timeline" title={t("repair.timeline")}>
            <ol className="sup-timeline">
              {repair.timeline.map((step, index) => (
                <li key={`${step.status}-${index}`}>
                  <span className="type-body">{t(`repairStatus.${step.status}`)}</span>
                  <span className="type-caption text-ink-2">
                    <When at={step.at} />
                  </span>
                </li>
              ))}
            </ol>
            <p className="type-caption text-ink-2">{t("repair.timelineNote")}</p>
          </Section>
          <Section id="repair-tickets" title={t("repair.tickets")}>
            {repair.tickets.length ? (
              <ul className="grid gap-2">
                {repair.tickets.map((ticket) => (
                  <li key={ticket.ref} className="flex flex-wrap items-center gap-2">
                    <Link to={`/admin/support/tickets/${ticket.ref}`} className="adm-link">
                      <Ref value={ticket.ref} />
                    </Link>
                    <span className="sup-card__title">{ticket.subject}</span>
                    <TicketStatusBadge status={ticket.status} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-body text-ink-2">{t("repair.noTickets")}</p>
            )}
            {repair.can.openTicket ? (
              <Form method="post" className="grid gap-3 md:grid-cols-2" noValidate>
                <input type="hidden" name="idempotencyKey" value={key} />
                <Select name="channel" label={t("new.channel")} defaultValue="phone" options={STAFF_CHANNELS.map((channel) => ({ value: channel, label: t(`channel.${channel}`) }))} />
                <TextField name="subject" label={t("new.subject")} defaultValue={plainText(t("repair.ticketSubject", { ref: repair.ref }))} error={failure?.fields?.subject} />
                <TextArea name="message" label={t("repair.ticketMessage")} hint={t("new.messageHint")} rows={3} required className="md:col-span-2" error={failure?.fields?.message} />
                <div className="grid gap-2 md:col-span-2">
                  <Failure message={failure ? (failure.message ?? t(`errors.${failure.code}`)) : null} />
                  <div>
                    <Key type="submit" icon="plus" loading={navigation.state === "submitting"}>
                      {t("repair.openTicket")}
                    </Key>
                  </div>
                </div>
              </Form>
            ) : null}
          </Section>
        </div>
        <aside className="sup-side">
          <section className="sup-panel" aria-labelledby="repair-facts">
            <h2 id="repair-facts" className="adm-h3">
              {t("repair.facts")}
            </h2>
            <Facts
              single
              rows={[
                { label: t("repair.device"), value: repair.device ?? repair.deviceText ?? "—" },
                { label: t("repair.source"), value: t(`repairSource.${repair.source}`) },
                { label: t("ticket.name"), value: repair.contact.name ?? "—" },
                { label: t("ticket.phone"), value: <PhoneText phone={repair.contact.phone} call /> },
                { label: t("repair.handover"), value: repair.handover ? t(`handover.${repair.handover}`) : "—" },
                { label: t("repair.day"), value: repair.preferredDay ? <bdi className="nums">{repair.preferredDay}</bdi> : "—" },
                { label: t("repair.window"), value: repair.preferredWindow ? t(`window.${repair.preferredWindow}`) : "—" },
                { label: t("repair.serial"), value: repair.serial.given ? t(repair.serial.ours ? "repair.serialOurs" : "repair.serialGiven") : t("repair.serialNone") },
                { label: t("repair.warranty"), value: repair.warranty ? `${t(`warrantyState.${repair.warranty.state}`)} · ${f.date(repair.warranty.endsAt)}` : "—" },
                { label: t("repair.quote"), value: repair.quote.iqd === null ? t("repair.quoteNone") : <span className="inline-flex flex-wrap gap-1"><Money iqd={repair.quote.iqd} /> · {t(repair.quote.approved ? "repair.quoteApproved" : "repair.quoteWaiting")}</span> },
                { label: t("repair.technician"), value: repair.assigned?.name ?? "—" },
                { label: t("repair.created"), value: <When at={repair.createdAt} /> },
              ]}
            />
            <p className="type-caption text-ink-2">{t("repair.preferences")}</p>
          </section>
        </aside>
      </div>
    </>
  );
}
