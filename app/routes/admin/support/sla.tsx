import { useState } from "react";
import { data } from "react-router";

import type { Route } from "./+types/sla";
import { can } from "~/server/actor";
import { forbidden, invalid, throwAsResponse } from "~/server/errors";
import { adoptSuggestedSla, applySlaToOpenTickets, listSlaPolicies, saveSlaPolicy, type SlaPolicyRow } from "~/server/services/admin/support/sla.server";
import { SUGGESTED_SLA, TICKET_CATEGORIES, TICKET_PRIORITIES } from "~/server/services/admin/support/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { supportMeta } from "./meta";
import { checked, failure, openSupport, text, whole } from "./support.server";
import { Boundary, Duration, Failure, Section, useIntent, useSupportT } from "./ui";

/**
 * /admin/support/sla — service targets (14.05): per priority (and optionally category) the time a ticket may wait for
 * its first response and for its resolution. New tickets get their due times from them (the storefront applies the
 * same rule when a shopper opens one); open tickets that have none can be given theirs here. The suggested targets are
 * a starting point the owner adopts in one step — never applied by themselves. Calendar time, no pause. Reading:
 * support.ticket.read; changing: support.routing.manage.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await openSupport(context, "support.ticket.read");
  try {
    return await listSlaPolicies(db, actor);
  } catch (error) {
    throwAsResponse(error);
  }
}

/** Minutes from "hours" and "minutes" fields (Arabic-Indic digits accepted); NaN when a part is not a whole number. */
function minutesOf(form: FormData, prefix: string): number {
  const hours = whole(form, `${prefix}Hours`) ?? 0;
  const mins = whole(form, `${prefix}Minutes`) ?? 0;
  return Number.isFinite(hours) && Number.isFinite(mins) ? hours * 60 + mins : Number.NaN;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openSupport(context, "support.ticket.read");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (!can(actor, "support.routing.manage")) throw forbidden("support.routing.manage");
    switch (intent) {
      case "save": {
        const first = minutesOf(form, "first");
        const resolve = minutesOf(form, "resolve");
        const result = await saveSlaPolicy(
          db,
          actor,
          {
            id: text(form, "policyId") || undefined,
            version: text(form, "version") || undefined,
            name: text(form, "name"),
            priority: text(form, "priority") as never,
            category: (text(form, "category") || null) as never,
            firstResponseMinutes: first,
            resolutionMinutes: resolve,
            isActive: checked(form, "isActive"),
            reason: text(form, "reason"),
          },
          now,
        );
        return { ok: true as const, intent, created: result.created };
      }
      case "adopt":
        return { ok: true as const, intent, ...(await adoptSuggestedSla(db, actor, { reason: text(form, "reason") }, now)) };
      case "apply":
        return { ok: true as const, intent, ...(await applySlaToOpenTickets(db, actor, { reason: text(form, "reason") }, now)) };
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    const result = failure(error, locale, intent || null);
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => supportMeta(args, "sla.title");

export default function SlaPage({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const { policies, missing, canManage } = loaderData;
  const [confirm, setConfirm] = useState<"adopt" | "apply" | null>(null);
  const adopt = useIntent("adopt", "done.slaAdopted", () => setConfirm(null));
  const apply = useIntent("apply", "done.slaApplied", () => setConfirm(null));
  const active = policies.filter((policy) => policy.isActive);
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("sla.title")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{t("sla.lead")}</p>
      </header>
      <Boundary icon="clock">{t("sla.calendar")}</Boundary>

      {canManage && active.length === 0 ? (
        <section className="adm-card adm-card--act" aria-labelledby="sla-suggest">
          <h2 id="sla-suggest" className="adm-h3">
            {t("sla.suggestTitle")}
          </h2>
          <p className="type-body">{t("sla.suggestLead")}</p>
          <ul className="grid gap-1 type-body">
            {SUGGESTED_SLA.map((entry) => (
              <li key={entry.priority}>
                {t(`priority.${entry.priority}`)}: {t("sla.firstResponse")} <Duration minutes={entry.firstResponseMinutes} /> · {t("sla.resolution")} <Duration minutes={entry.resolutionMinutes} />
              </li>
            ))}
          </ul>
          <div>
            <Key variant="ink" icon="check" onClick={() => setConfirm("adopt")}>
              {t("sla.adopt")}
            </Key>
          </div>
        </section>
      ) : null}

      <Section id="sla-policies" title={t("sla.policies")}>
        {policies.length === 0 ? (
          <p className="type-body text-ink-2">{t("sla.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
          <table className="table" data-density="admin">
            <caption className="sr-only">{t("sla.policies")}</caption>
            <thead>
              <tr>
                <th scope="col">{t("sla.col.name")}</th>
                <th scope="col">{t("inbox.priority")}</th>
                <th scope="col">{t("inbox.category")}</th>
                <th scope="col">{t("sla.firstResponse")}</th>
                <th scope="col">{t("sla.resolution")}</th>
                <th scope="col">{t("sla.col.state")}</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((policy) => (
                <tr key={policy.id}>
                  <td>{SUGGESTED_SLA.some((entry) => entry.priority === policy.name) ? t(`sla.suggestedName.${policy.name}`) : policy.name}</td>
                  <td>{t(`priority.${policy.priority}`)}</td>
                  <td>{policy.category ? t(`category.${policy.category}`) : t("sla.anyCategory")}</td>
                  <td>
                    <Duration minutes={policy.firstResponseMinutes} />
                  </td>
                  <td>
                    <Duration minutes={policy.resolutionMinutes} />
                  </td>
                  <td>
                    <Status tone={policy.isActive ? "ok" : "neutral"}>{t(policy.isActive ? "routing.active" : "routing.off")}</Status>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
        <p className="type-caption text-ink-2">{t("sla.rule")}</p>
        {canManage ? (
          <>
            {policies.map((policy) => (
              <Disclosure key={policy.id} summary={t("sla.edit", { name: SUGGESTED_SLA.some((entry) => entry.priority === policy.name) ? t(`sla.suggestedName.${policy.name}`) : policy.name })} variant="row">
                <PolicyForm policy={policy} />
              </Disclosure>
            ))}
            <Disclosure summary={t("sla.new")} variant="panel">
              <PolicyForm policy={null} />
            </Disclosure>
          </>
        ) : (
          <p className="type-caption text-ink-2">{t("sla.readOnly")}</p>
        )}
      </Section>

      <Section id="sla-missing" title={t("sla.missingTitle")}>
        <p className="type-body">{t("sla.missing", { count: missing.withoutDue, open: missing.open })}</p>
        {missing.withoutDue > missing.fillable ? <p className="type-caption text-ink-2">{t("sla.noPolicy", { count: missing.withoutDue - missing.fillable })}</p> : null}
        {canManage && missing.fillable > 0 ? (
          <div>
            <Key icon="clock" onClick={() => setConfirm("apply")}>
              {t("sla.apply", { count: missing.fillable })}
            </Key>
          </div>
        ) : null}
      </Section>

      {confirm ? (
        <ConfirmDialog
          open
          onClose={() => setConfirm(null)}
          title={t(confirm === "adopt" ? "sla.adoptQ" : "sla.applyQ", { count: missing.fillable })}
          consequence={t(confirm === "adopt" ? "sla.adoptWhat" : "sla.applyWhat")}
          confirmLabel={t(confirm === "adopt" ? "sla.adopt" : "sla.apply", { count: missing.fillable })}
          reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
          pending={adopt.pending || apply.pending}
          error={(confirm === "adopt" ? adopt.message : apply.message) ?? null}
          onConfirm={({ reason }) => (confirm === "adopt" ? adopt : apply).fetcher.submit({ intent: confirm, reason }, { method: "post" })}
        />
      ) : null}
    </>
  );
}

function PolicyForm({ policy }: { policy: SlaPolicyRow | null }) {
  const t = useSupportT();
  const save = useIntent("save", (result) => (result.created ? "done.slaCreated" : "done.slaSaved"));
  const fields = save.fields;
  const split = (minutes: number | undefined) => ({ hours: minutes ? String(Math.floor(minutes / 60)) : "", minutes: minutes ? String(minutes % 60) : "" });
  const first = split(policy?.firstResponseMinutes);
  const resolve = split(policy?.resolutionMinutes);
  return (
    <save.fetcher.Form method="post" className="grid gap-3 pt-2 md:grid-cols-2" key={policy ? `${policy.id}-${policy.version}` : "new"}>
      <input type="hidden" name="intent" value="save" />
      {policy ? <input type="hidden" name="policyId" value={policy.id} /> : null}
      {policy ? <input type="hidden" name="version" value={policy.version} /> : null}
      <TextField name="name" label={t("sla.col.name")} defaultValue={policy?.name ?? ""} required error={fields.name} />
      <Select name="priority" label={t("inbox.priority")} defaultValue={policy?.priority ?? "normal"} options={TICKET_PRIORITIES.map((priority) => ({ value: priority, label: t(`priority.${priority}`) }))} error={fields.priority} />
      <Select name="category" label={t("inbox.category")} defaultValue={policy?.category ?? ""} options={[{ value: "", label: t("sla.anyCategory") }, ...TICKET_CATEGORIES.map((category) => ({ value: category, label: t(`category.${category}`) }))]} error={fields.category} />
      <Checkbox name="isActive" label={t("routing.form.active")} defaultChecked={policy ? policy.isActive : true} />
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="type-caption text-ink-2">{t("sla.firstResponse")}</legend>
        <TextField name="firstHours" label={t("sla.hours")} inputMode="numeric" defaultValue={first.hours} ltr error={fields.firstResponseMinutes} />
        <TextField name="firstMinutes" label={t("sla.minutes")} inputMode="numeric" defaultValue={first.minutes} ltr />
      </fieldset>
      <fieldset className="grid grid-cols-2 gap-2">
        <legend className="type-caption text-ink-2">{t("sla.resolution")}</legend>
        <TextField name="resolveHours" label={t("sla.hours")} inputMode="numeric" defaultValue={resolve.hours} ltr error={fields.resolutionMinutes} />
        <TextField name="resolveMinutes" label={t("sla.minutes")} inputMode="numeric" defaultValue={resolve.minutes} ltr />
      </fieldset>
      <TextField name="reason" label={t("dialog.reason")} hint={t("sla.reasonHint")} required className="md:col-span-2" error={fields.reason} />
      <div className="grid gap-2 md:col-span-2">
        <Failure message={save.message} />
        <div>
          <Key type="submit" variant="ink" icon="floppy-disk" loading={save.pending}>
            {t("sla.save")}
          </Key>
        </div>
      </div>
    </save.fetcher.Form>
  );
}
