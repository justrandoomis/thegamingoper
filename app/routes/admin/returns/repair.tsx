import { useState } from "react";
import { data, Link } from "react-router";

import type { Route } from "./+types/repair";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { addPart, addRepairNote, assignRepair, changeRepairStatus, getRepair, recordQuoteDecision, setDiagnosis, setRepairSla } from "~/server/services/admin/returns/repair.server";
import { parseWhole, REPAIR_REASON_REQUIRED, type RepairDetail, type RepairStatusKey } from "~/server/services/admin/returns/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { returnsMeta } from "./meta";
import { failure, openReturns, text, urls } from "./returns.server";
import { DemoNote, Due, Facts, Failure, Money, PhoneText, Ref, RepairStatusBadge, Section, useIntent, useReturnsT, When, WarrantyBadge } from "./ui";

/**
 * /admin/returns/repairs/:ref — one repair ticket (12.07, and the service history of 12.06): the device, the customer's
 * words and photos, the diagnosis and the quote with the customer's answer, parts, the technician, the SLA due time
 * (changeable with a reason), the status workflow (types.ts REPAIR_TRANSITIONS) and every event. Changes need
 * returns.repair.manage; the storefront's status page shows the customer the status changes and the quote only.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReturns(context, ["returns.repair.manage", "returns.rma.read", "returns.warranty.read"]);
  try {
    return { repair: await getRepair(db, actor, params.ref, locale, now, { file: urls.file }), now };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openReturns(context, "returns.repair.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    const repair = await getRepair(db, actor, params.ref, locale, now, { file: urls.file });
    const ticketId = repair.id;
    switch (intent) {
      case "status": {
        const result = await changeRepairStatus(db, actor, { ticketId, from: text(form, "from") as never, to: text(form, "to") as never, note: text(form, "note") || undefined }, now);
        return { ok: true as const, intent, replayed: result.replayed, status: result.status };
      }
      case "diagnosis": {
        const quote = parseWhole(text(form, "quoteIqd"));
        await setDiagnosis(db, actor, { ticketId, diagnosis: text(form, "diagnosis"), quoteIqd: quote === undefined ? null : quote }, now);
        return { ok: true as const, intent };
      }
      case "quote": {
        await recordQuoteDecision(db, actor, { ticketId, approved: text(form, "approved") === "1", note: text(form, "note") }, now);
        return { ok: true as const, intent };
      }
      case "part": {
        await addPart(db, actor, { ticketId, name: text(form, "name"), qty: parseWhole(text(form, "qty")) ?? 1, priceIqd: parseWhole(text(form, "priceIqd")) ?? 0 }, now);
        return { ok: true as const, intent };
      }
      case "assign": {
        await assignRepair(db, actor, { ticketId, employeeId: text(form, "employeeId") || undefined }, now);
        return { ok: true as const, intent };
      }
      case "sla": {
        await setRepairSla(db, actor, { ticketId, dueOn: text(form, "dueOn"), reason: text(form, "reason") }, now);
        return { ok: true as const, intent };
      }
      case "note": {
        await addRepairNote(db, actor, { ticketId, text: text(form, "text") }, now);
        return { ok: true as const, intent };
      }
      default:
        return data({ ok: false as const, intent: null, code: "invalid", status: 400 }, { status: 400 });
    }
  } catch (error) {
    const result = failure(error, locale, intent || null);
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => returnsMeta(args, "repair.title", { ref: args.loaderData?.repair.ref ?? "" });

export default function RepairPage({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const { repair } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/returns/repairs" className="adm-link">
            {t("repair.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-3">
          <Ref value={repair.ref} />
          <DemoNote show={repair.isDemo} />
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <RepairStatusBadge status={repair.status} />
          {repair.isWarranty ? <span className="ret-tag">{t("repairs.warrantyTag")}</span> : null}
          {repair.slaDueAt ? <Due dueAt={repair.slaDueAt} late={repair.late} dueKey="repair.slaDue" lateKey="repair.slaLate" /> : <span className="type-caption text-ink-2">{t("repair.slaNone")}</span>}
        </div>
      </header>

      {repair.can.manage && repair.transitions.length ? <StatusSection repair={repair} /> : null}

      <div className="ret-layout">
        <div className="grid min-w-0 gap-6">
          <Section id="repair-issue" title={t("repair.issue")}>
            <p className="type-body whitespace-pre-line">{repair.issue}</p>
            {repair.photos.length ? (
              <ul className="ret-photos" aria-label={t("repair.photos")}>
                {repair.photos.map((photo, index) => (
                  <li key={photo.id}>
                    <a href={photo.url} target="_blank" rel="noreferrer">
                      <img src={photo.url} alt={`${repair.ref} · ${index + 1}`} width={240} height={240} loading="lazy" decoding="async" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </Section>
          <DiagnosisSection repair={repair} />
          <PartsSection repair={repair} />
          <EventsSection repair={repair} />
        </div>
        <aside className="ret-side">
          <FactsCard repair={repair} />
          {repair.can.manage ? <AssignCard repair={repair} /> : null}
          {repair.can.manage ? <NoteCard /> : null}
        </aside>
      </div>
    </>
  );
}

function StatusSection({ repair }: { repair: RepairDetail }) {
  const t = useReturnsT();
  const [to, setTo] = useState<RepairStatusKey | null>(null);
  const { fetcher, pending, message } = useIntent("status", "done.repairStatus", () => setTo(null));
  return (
    <section className="adm-section" aria-labelledby="repair-next">
      <h2 id="repair-next" className="adm-h2">
        {t("repair.next")}
      </h2>
      <div className="ret-actions">
        {repair.transitions.map((status) => (
          <Key key={status} size="sm" variant={status === repair.transitions[0] ? "ink" : "clay"} className={status === "cancelled" || status === "unrepairable" ? "enabled:[--on:var(--red-ink)]" : undefined} onClick={() => setTo(status)}>
            {t(`repairStatus.${status}`)}
          </Key>
        ))}
      </div>
      {to ? (
        <ConfirmDialog
          open
          onClose={() => setTo(null)}
          tone={to === "cancelled" || to === "unrepairable" ? "destructive" : "neutral"}
          title={t("repair.statusQ", { ref: repair.ref, status: t(`repairStatus.${to}`) })}
          consequence={t("repair.statusWhat")}
          confirmLabel={t(`repairStatus.${to}`)}
          reason={REPAIR_REASON_REQUIRED.includes(to) ? { label: t("dialog.reason"), hint: t("repair.reasonRequired") } : { noteRequired: false, label: t("dialog.noteOptional") }}
          pending={pending}
          error={message}
          onConfirm={({ reason }) => fetcher.submit({ intent: "status", from: repair.status, to, note: reason }, { method: "post" })}
        />
      ) : null}
    </section>
  );
}

function DiagnosisSection({ repair }: { repair: RepairDetail }) {
  const t = useReturnsT();
  const f = useFormat();
  const open = !["delivered", "unrepairable", "cancelled"].includes(repair.status);
  const { fetcher, pending, message, fields } = useIntent("diagnosis", "done.diagnosis");
  return (
    <Section id="repair-diagnosis" title={t("repair.diagnosisTitle")}>
      <Facts
        rows={[
          { label: t("repair.diagnosis"), value: repair.diagnosis ?? t("repair.diagnosisNone") },
          { label: t("repair.quote"), value: repair.quoteIqd === null ? t("repair.quoteNone") : <Money iqd={repair.quoteIqd} /> },
          { label: t("repair.quoteAnswer"), value: repair.quoteApprovedAt ? t("repair.quoteApproved", { date: f.dateTime(repair.quoteApprovedAt) }) : repair.quoteIqd ? t("repair.quoteWaiting") : "—", hidden: repair.isWarranty || !repair.quoteIqd },
          { label: t("repair.warranty"), value: t("repair.warrantyFree"), hidden: !repair.isWarranty },
          { label: t("repair.cost"), value: repair.costIqd === null ? "—" : <Money iqd={repair.costIqd} />, hidden: repair.costIqd === null },
        ]}
      />
      {repair.costIqd !== null && repair.costIqd > 0 ? <p className="type-caption text-ink-2">{t("repair.costHint")}</p> : null}
      {repair.can.manage && open ? (
        <fetcher.Form method="post" className="grid gap-3 md:grid-cols-2">
          <input type="hidden" name="intent" value="diagnosis" />
          <TextArea name="diagnosis" label={t("repair.diagnosis")} defaultValue={repair.diagnosis ?? ""} required className="md:col-span-2" error={fields.diagnosis} />
          {!repair.isWarranty ? <TextField name="quoteIqd" label={t("repair.quoteLabel")} hint={t("repair.quoteHint")} inputMode="numeric" defaultValue={repair.quoteIqd === null ? "" : String(repair.quoteIqd)} ltr error={fields.quoteIqd} /> : null}
          <div className="flex items-end">
            <Key type="submit" size="sm" icon="floppy-disk" loading={pending}>
              {t("repair.diagnosisSave")}
            </Key>
          </div>
          <Failure message={message} />
        </fetcher.Form>
      ) : null}
      {repair.can.manage && open && !repair.isWarranty && repair.quoteIqd !== null && repair.quoteIqd > 0 && !repair.quoteApprovedAt ? <QuoteDecision repair={repair} /> : null}
    </Section>
  );
}

function QuoteDecision({ repair }: { repair: RepairDetail }) {
  const t = useReturnsT();
  const f = useFormat();
  const [mode, setMode] = useState<"approve" | "decline" | null>(null);
  const { fetcher, pending, message } = useIntent("quote", "done.quote", () => setMode(null));
  const amount = f.iqd(repair.quoteIqd ?? 0);
  return (
    <div className="ret-actions">
      <Key size="sm" variant="ink" icon="check" onClick={() => setMode("approve")}>
        {t("repair.quoteDecision.approve")}
      </Key>
      <Key size="sm" icon="x" onClick={() => setMode("decline")}>
        {t("repair.quoteDecision.decline")}
      </Key>
      {mode ? (
        <ConfirmDialog
          open
          onClose={() => setMode(null)}
          title={t(mode === "approve" ? "repair.quoteDecision.approveQ" : "repair.quoteDecision.declineQ", { amount })}
          consequence={t("repair.quoteDecision.what")}
          confirmLabel={t(mode === "approve" ? "repair.quoteDecision.approve" : "repair.quoteDecision.decline")}
          reason={{ label: t("dialog.reason"), hint: t("repair.quoteDecision.what") }}
          pending={pending}
          error={message}
          onConfirm={({ reason }) => fetcher.submit({ intent: "quote", approved: mode === "approve" ? "1" : "0", note: reason }, { method: "post" })}
        />
      ) : null}
    </div>
  );
}

function PartsSection({ repair }: { repair: RepairDetail }) {
  const t = useReturnsT();
  const f = useFormat();
  const open = !["delivered", "unrepairable", "cancelled"].includes(repair.status);
  const { fetcher, pending, message, fields } = useIntent("part", "done.part");
  return (
    <Section id="repair-parts" title={t("repair.parts")}>
      {repair.parts.length === 0 ? (
        <p className="type-body text-ink-2">{t("repair.partsEmpty")}</p>
      ) : (
        <>
          <ul className="grid gap-1">
            {repair.parts.map((part, index) => (
              <li key={`${part.name}-${index}`} className="flex flex-wrap justify-between gap-2 type-body">
                <span>
                  {part.name} × <bdi className="nums">{f.number(part.qty)}</bdi>
                </span>
                <Money iqd={part.priceIqd * part.qty} />
              </li>
            ))}
          </ul>
          <p className="type-caption text-ink-2">{t("repair.partsTotal", { amount: f.iqd(repair.partsTotalIqd) })}</p>
        </>
      )}
      {repair.can.manage && open ? (
        <>
          <fetcher.Form method="post" className="grid gap-3 sm:grid-cols-[1fr_6rem_10rem_auto] sm:items-end">
            <input type="hidden" name="intent" value="part" />
            <TextField name="name" label={t("repair.partName")} required error={fields.name} />
            <TextField name="qty" label={t("repair.partQty")} inputMode="numeric" defaultValue="1" ltr error={fields.qty} />
            <TextField name="priceIqd" label={t("repair.partPrice")} inputMode="numeric" defaultValue={repair.isWarranty ? "0" : ""} ltr error={fields.priceIqd} />
            <Key type="submit" size="sm" icon="plus" loading={pending}>
              {t("repair.addPart")}
            </Key>
          </fetcher.Form>
          <Failure message={message && !Object.keys(fields).length ? message : null} />
          <p className="flex items-start gap-1 type-caption text-ink-2">
            <Icon name="info" size={14} className="mt-0.5 flex-none" />
            {t("repair.stockNote")}
          </p>
        </>
      ) : null}
    </Section>
  );
}

function EventsSection({ repair }: { repair: RepairDetail }) {
  const t = useReturnsT();
  const f = useFormat();
  const sentence = (event: RepairDetail["events"][number]) => {
    const d = event.data;
    switch (event.kind) {
      case "status":
        return t("repair.event.status", { from: typeof d.from === "string" ? t(`repairStatus.${d.from}`) : "—", to: typeof d.to === "string" ? t(`repairStatus.${d.to}`) : "—" });
      case "quote":
        return t("repair.event.quote", { amount: typeof d.quoteIqd === "number" ? f.iqd(d.quoteIqd) : "—" });
      case "part":
        return t("repair.event.part", { name: String(d.name ?? ""), qty: typeof d.qty === "number" ? f.number(d.qty) : "1" });
      case "submitted":
      case "note":
      case "diagnosis":
      case "quote_approved":
      case "quote_declined":
      case "assigned":
      case "sla":
        return t(`repair.event.${event.kind}`);
      default:
        return event.kind;
    }
  };
  return (
    <Section id="repair-events" title={t("repair.events")}>
      {repair.events.length === 0 ? (
        <p className="type-body text-ink-2">{t("repair.eventsEmpty")}</p>
      ) : (
        <ol className="ret-timeline">
          {repair.events.map((event) => (
            <li key={event.id} data-actor={event.actor.kind}>
              <p className="type-body">
                {event.actor.name ? <span className="type-strong">{event.actor.name} </span> : null}
                {sentence(event)}
              </p>
              <p className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
                <When at={event.at} />
                {event.note ? <span className="ret-reason">{event.note}</span> : null}
              </p>
            </li>
          ))}
        </ol>
      )}
    </Section>
  );
}

function FactsCard({ repair }: { repair: RepairDetail }) {
  const t = useReturnsT();
  return (
    <section className="adm-card" aria-labelledby="repair-facts">
      <h2 id="repair-facts" className="adm-h3">
        {t("repair.title", { ref: repair.ref })}
      </h2>
      <Facts
        className="ret-facts--single"
        rows={[
          { label: t("repair.device"), value: repair.device ?? repair.deviceText ?? "—" },
          { label: t("repair.serial"), value: repair.serial?.text ? <Ref value={repair.serial.text} /> : repair.serial?.id ? t("repair.serialOurs") : "—" },
          { label: t("repair.customer"), value: <span><bdi>{repair.customer.name ?? "—"}</bdi> · <PhoneText phone={repair.customer.phone} /></span> },
          { label: t("repair.source"), value: t(`repairSource.${repair.source}`) },
          {
            label: t("repair.warranty"),
            value: repair.warranty ? (
              <span className="inline-flex items-center gap-2">
                <WarrantyBadge state={repair.warranty.state} />
                <Link to={`/admin/returns/warranties/${repair.warranty.id}`} className="adm-link">
                  <When at={repair.warranty.endsAt} style="date" />
                </Link>
              </span>
            ) : (
              "—"
            ),
          },
          {
            label: t("repair.rma"),
            value: repair.rma ? (
              <Link to={`/admin/returns/${repair.rma.rma}`} className="adm-link">
                <Ref value={repair.rma.rma} />
              </Link>
            ) : (
              "—"
            ),
            hidden: !repair.rma,
          },
          { label: t("repair.created"), value: <When at={repair.createdAt} /> },
          { label: t("repair.received"), value: <When at={repair.receivedAt} />, hidden: !repair.receivedAt },
          { label: t("repair.completed"), value: <When at={repair.completedAt} />, hidden: !repair.completedAt },
          { label: t("repair.delivered"), value: <When at={repair.deliveredAt} />, hidden: !repair.deliveredAt },
          { label: t("repair.assigned"), value: repair.assignedTo?.name ?? t("repair.unassigned") },
        ]}
      />
      {repair.can.manage && !["delivered", "unrepairable", "cancelled"].includes(repair.status) ? <SlaButton repair={repair} /> : null}
    </section>
  );
}

function SlaButton({ repair }: { repair: RepairDetail }) {
  const t = useReturnsT();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState("");
  const { fetcher, pending, message, fields } = useIntent("sla", "done.sla", () => setOpen(false));
  return (
    <div>
      <Key
        size="sm"
        icon="calendar-blank"
        onClick={() => {
          setDay(repair.slaDueAt ? new Date(repair.slaDueAt + 3 * 60 * 60 * 1000).toISOString().slice(0, 10) : "");
          setOpen(true);
        }}
      >
        {t("repair.slaChange")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("repair.slaQ", { ref: repair.ref })}
        consequence={t("repair.slaWhat")}
        confirmLabel={t("repair.slaChange")}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "sla", dueOn: day, reason }, { method: "post" })}
      >
        <TextField type="date" label={t("repair.dueOn")} value={day} onChange={(event) => setDay(event.target.value)} required ltr error={fields.dueOn} />
      </ConfirmDialog>
    </div>
  );
}

function AssignCard({ repair }: { repair: RepairDetail }) {
  const t = useReturnsT();
  const { fetcher, pending, message, fields } = useIntent("assign", "done.assign");
  return (
    <section className="adm-card" aria-labelledby="repair-assign">
      <h2 id="repair-assign" className="adm-h3">
        {t("repair.assign")}
      </h2>
      <fetcher.Form method="post" className="grid gap-2">
        <input type="hidden" name="intent" value="assign" />
        <Select name="employeeId" label={t("repair.assigned")} defaultValue={repair.assignedTo?.id ?? ""} options={[{ value: "", label: t("repair.unassigned") }, ...repair.technicians.map((tech) => ({ value: tech.id, label: tech.name }))]} error={fields.employeeId} />
        <div>
          <Key type="submit" size="sm" icon="user-gear" loading={pending}>
            {t("repair.assignSave")}
          </Key>
        </div>
        <Failure message={message && !fields.employeeId ? message : null} />
      </fetcher.Form>
    </section>
  );
}

function NoteCard() {
  const t = useReturnsT();
  const [value, setValue] = useState("");
  const { fetcher, pending, message, fields } = useIntent("note", "done.note", () => setValue(""));
  return (
    <section className="adm-card" aria-labelledby="repair-note">
      <h2 id="repair-note" className="adm-h3">
        {t("repair.note")}
      </h2>
      <fetcher.Form method="post" className="grid gap-2">
        <input type="hidden" name="intent" value="note" />
        <TextArea name="text" label={t("repair.note")} hideLabel rows={3} value={value} onChange={(event) => setValue(event.target.value)} error={fields.text} />
        <div>
          <Key type="submit" size="sm" icon="paper-plane-tilt" loading={pending}>
            {t("repair.addNote")}
          </Key>
        </div>
        <Failure message={message && !fields.text ? message : null} />
      </fetcher.Form>
    </section>
  );
}
