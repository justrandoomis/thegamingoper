import { useState } from "react";
import { data, Link } from "react-router";

import type { Route } from "./+types/warranty";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { extendWarranty, getWarranty, voidWarranty } from "~/server/services/admin/returns/warranty.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { returnsMeta } from "./meta";
import { failure, openReturns, text } from "./returns.server";
import { Facts, PhoneText, Ref, RepairStatusBadge, RmaStatusBadge, Section, useIntent, useReturnsT, When, WarrantyBadge } from "./ui";

/**
 * /admin/returns/warranties/:id — one warranty (12.06): the store's dates and terms, the maker's warranty from the
 * product's specs shown apart (the maker honours it, not the store), the service history (repair tickets of the
 * warranty or the unit's serial), the replaced parts, the unit's returns and the change history. Extending or voiding
 * needs returns.warranty.manage and a reason, and is audited with before and after.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReturns(context, ["returns.warranty.read", "returns.warranty.manage"]);
  try {
    return { warranty: await getWarranty(db, actor, params.id, locale, now) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openReturns(context, "returns.warranty.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent === "extend") {
      await extendWarranty(db, actor, { warrantyId: params.id, endsOn: text(form, "endsOn"), reason: text(form, "reason") }, now);
      return { ok: true as const, intent };
    }
    if (intent === "void") {
      const result = await voidWarranty(db, actor, { warrantyId: params.id, reason: text(form, "reason") }, now);
      return { ok: true as const, intent, replayed: result.replayed };
    }
    return data({ ok: false as const, intent: null, code: "invalid", status: 400 }, { status: 400 });
  } catch (error) {
    const result = failure(error, locale, intent || null);
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => returnsMeta(args, "warranty.title", { name: args.loaderData?.warranty.itemName ?? "" });

export default function WarrantyPage({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const f = useFormat();
  const { warranty } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/returns/warranties" className="adm-link">
            {t("warranty.back")}
          </Link>
        </p>
        <h1 className="adm-title">{t("warranty.title", { name: warranty.itemName })}</h1>
        <div className="flex flex-wrap items-center gap-3">
          <WarrantyBadge state={warranty.state} />
          {warranty.isUsed ? <span className="ret-tag">{t("warranties.used")}</span> : null}
        </div>
      </header>

      {warranty.can.manage && warranty.state !== "void" ? (
        <div className="ret-actions">
          <ExtendButton name={warranty.itemName} endsAt={warranty.endsAt} />
          <VoidButton name={warranty.itemName} />
        </div>
      ) : null}

      <div className="ret-layout">
        <div className="grid min-w-0 gap-6">
          <Section id="warranty-store" title={t("warranty.store")}>
            <p className="type-caption text-ink-2">{t("warranty.storeHint")}</p>
            <Facts
              rows={[
                { label: t("warranty.starts"), value: <When at={warranty.startsAt} style="date" /> },
                { label: t("warranty.ends"), value: <When at={warranty.endsAt} style="date" /> },
                { label: t("warranty.order"), value: <Ref value={warranty.orderRef} /> },
                { label: t("warranty.serial"), value: warranty.serial ? <Ref value={warranty.serial} /> : "—" },
                { label: t("warranty.customer"), value: <span><bdi>{warranty.customerName ?? "—"}</bdi> · <PhoneText phone={warranty.phone} /></span> },
                { label: t("warranty.terms"), value: warranty.terms ?? t("warranty.termsNone") },
                { label: t("warranty.voidReason"), value: warranty.voidReason, hidden: !warranty.voidReason },
              ]}
            />
          </Section>

          <Section id="warranty-service" title={t("warranty.service")}>
            {warranty.service.length === 0 ? (
              <p className="type-body text-ink-2">{t("warranty.serviceEmpty")}</p>
            ) : (
              <ul className="ret-items">
                {warranty.service.map((ticket) => (
                  <li key={ticket.id} className="ret-item">
                    <div className="ret-item__head">
                      <Link to={`/admin/returns/repairs/${ticket.ref}`} className="adm-link">
                        <Ref value={ticket.ref} />
                      </Link>
                      <RepairStatusBadge status={ticket.status} />
                    </div>
                    <p className="type-body">{ticket.issue}</p>
                    {ticket.diagnosis ? <p className="type-caption text-ink-2">{ticket.diagnosis}</p> : null}
                    <p className="type-caption text-ink-2">
                      <When at={ticket.createdAt} />
                      {ticket.deliveredAt ? ` · ${t("warranty.repairedOn", { date: f.dateTime(ticket.deliveredAt) })}` : ""}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="warranty-parts" title={t("warranty.parts")}>
            {warranty.replacedParts.length === 0 ? (
              <p className="type-body text-ink-2">{t("warranty.partsEmpty")}</p>
            ) : (
              <ul className="grid gap-1">
                {warranty.replacedParts.map((part, index) => (
                  <li key={`${part.ticketRef}-${index}`} className="type-body">
                    {part.name} × <bdi className="nums">{f.number(part.qty)}</bdi> · <Ref value={part.ticketRef} /> · <When at={part.at} style="date" />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="warranty-returns" title={t("warranty.returns")}>
            {warranty.returns.length === 0 ? (
              <p className="type-body text-ink-2">{t("warranty.returnsEmpty")}</p>
            ) : (
              <ul className="grid gap-2">
                {warranty.returns.map((entry) => (
                  <li key={entry.rma} className="flex flex-wrap items-center gap-2">
                    <Link to={`/admin/returns/${entry.rma}`} className="adm-link">
                      <Ref value={entry.rma} />
                    </Link>
                    <RmaStatusBadge status={entry.status} />
                    <When at={entry.createdAt} style="date" />
                  </li>
                ))}
              </ul>
            )}
          </Section>

          <Section id="warranty-history" title={t("warranty.history")}>
            {warranty.history.length === 0 ? (
              <p className="type-body text-ink-2">{t("warranty.historyEmpty")}</p>
            ) : (
              <ol className="ret-timeline">
                {warranty.history.map((entry) => (
                  <li key={entry.id} data-actor={entry.actor.kind}>
                    <p className="type-body">
                      <span className="type-strong">{entry.actor.name ?? "—"}</span> {t(`timeline.${entry.action.replace(/^returns\./, "").replace(/\./g, "_")}`)}
                    </p>
                    <p className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
                      <When at={entry.at} />
                      {entry.reason ? <span className="ret-reason">{entry.reason}</span> : null}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
        <aside className="ret-side">
          <section className="adm-card" aria-labelledby="warranty-maker">
            <h2 id="warranty-maker" className="adm-h3">
              {t("warranty.maker")}
            </h2>
            <p className="type-body">{warranty.makerWarranty ?? t("warranty.makerNone")}</p>
            <p className="type-caption text-ink-2">{t("warranty.makerHint")}</p>
          </section>
        </aside>
      </div>
    </>
  );
}

function ExtendButton({ name, endsAt }: { name: string; endsAt: number }) {
  const t = useReturnsT();
  const [open, setOpen] = useState(false);
  const [day, setDay] = useState("");
  const { fetcher, pending, message, fields } = useIntent("extend", "done.extend", () => setOpen(false));
  return (
    <>
      <Key
        size="sm"
        icon="calendar-blank"
        onClick={() => {
          setDay(new Date(endsAt + 3 * 60 * 60 * 1000).toISOString().slice(0, 10));
          setOpen(true);
        }}
      >
        {t("warranty.extend")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("warranty.extendQ", { name })}
        consequence={t("warranty.extendWhat")}
        confirmLabel={t("warranty.extend")}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "extend", endsOn: day, reason }, { method: "post" })}
      >
        <TextField type="date" label={t("warranty.endsOn")} value={day} onChange={(event) => setDay(event.target.value)} required ltr error={fields.endsOn} />
      </ConfirmDialog>
    </>
  );
}

function VoidButton({ name }: { name: string }) {
  const t = useReturnsT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("void", "done.void", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="x-circle" className="enabled:[--on:var(--red-ink)]" onClick={() => setOpen(true)}>
        {t("warranty.void")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("warranty.voidQ", { name })}
        consequence={t("warranty.voidWhat")}
        confirmLabel={t("warranty.void")}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "void", reason }, { method: "post" })}
      />
    </>
  );
}
