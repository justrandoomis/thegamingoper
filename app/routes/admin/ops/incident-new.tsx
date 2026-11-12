import { useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/incident-new";
import { createIncident, incidentFormOptions } from "~/server/services/admin/ops/incidents.server";
import { INCIDENT_SEVERITIES, toBaghdadInput, type IncidentSeverity, type LinkKind } from "~/server/services/admin/ops/types";
import { Checkbox, FieldGroup, Radio, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { FormError, Note, PageHead, Section, failureText, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { all, newKey, ops, optional, text } from "./ops.server";

/**
 * /admin/ops/incidents/new — 23.05: open an incident (ops.incident.manage): what is happening, how severe, since when,
 * who owns it (someone who may read incidents) and by when it should be resolved (the owner's task), and the records it
 * is about (findings, job runs, errors — prefilled from the page that opened this form, ?finding= / ?run= / ?error=).
 * A resubmitted form opens it once.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.incident.manage");
  const params = new URL(args.request.url).searchParams;
  const prefill = (["finding", "run", "error"] as const).flatMap((kind) => params.getAll(kind).map((id) => ({ kind: kind as LinkKind, id: id.trim().slice(0, 64) }))).filter((link) => link.id);
  const options = await ops.orRespond(req, () => incidentFormOptions(req.db, req.actor, req.now, prefill));
  return { options, me: req.actor.id, startedAt: toBaghdadInput(req.now), key: newKey() };
}

export async function action(args: Route.ActionArgs) {
  const req = await ops.open(args, "ops.incident.manage");
  try {
    const form = await ops.form(args.request);
    const links = all(form, "link")
      .map((value) => {
        const [kind, ...rest] = value.split(":");
        return { kind, id: rest.join(":") };
      })
      .filter((link) => link.id);
    const result = await createIncident(
      req.db,
      req.actor,
      {
        title: text(form, "title"),
        severity: text(form, "severity"),
        summary: text(form, "summary"),
        impact: optional(form, "impact"),
        ownerId: text(form, "ownerId"),
        startedAt: optional(form, "startedAt"),
        targetDay: text(form, "targetDay"),
        links,
        idempotencyKey: text(form, "key"),
      },
      req.now,
    );
    return redirect(`/admin/ops/incidents/${result.ref}?created=1`);
  } catch (error) {
    return ops.failed(error, req, "create");
  }
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "incidentNew.title");

export default function NewIncidentPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const { options, me, startedAt, key } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formMethod?.toLowerCase() === "post";
  const fields = (result && !result.ok ? result.fields : undefined) ?? {};
  const [severity, setSeverity] = useState<IncidentSeverity>("sev3");
  const [target, setTarget] = useState(options.targets.sev3);
  const [targetTouched, setTargetTouched] = useState(false);
  const defaultOwner = options.owners.some((person) => person.id === me) ? me : (options.owners[0]?.id ?? "");
  const failure = result && !result.ok ? (result.fields ? t("common.checkFields") : failureText(t, result)) : null;

  return (
    <div className="adm-narrow">
      <PageHead
        eyebrow={
          <Link to="/admin/ops/incidents" className="adm-link">
            {t("incidentNew.back")}
          </Link>
        }
        title={t("incidentNew.title")}
        lead={t("incidentNew.lead")}
      />
      <Form method="post" className="grid gap-5" noValidate>
        <input type="hidden" name="key" value={key} />
        <Section id="ops-inc-what" title={t("incidentNew.what")}>
          <TextField name="title" label={t("incidentNew.titleField")} hint={t("incidentNew.titleHint")} required maxLength={160} error={fields.title} />
          <TextArea name="summary" label={t("incidentNew.summary")} hint={t("incidentNew.summaryHint")} required rows={4} maxLength={4000} error={fields.summary} />
          <TextArea name="impact" label={t("incidentNew.impact")} hint={t("incidentNew.impactHint")} optional rows={3} maxLength={2000} error={fields.impact} />
        </Section>
        <Section id="ops-inc-severity" title={t("incidentNew.severity")}>
          <FieldGroup legend={t("incidentNew.severityLegend")} required error={fields.severity}>
            {INCIDENT_SEVERITIES.map((value) => (
              <Radio
                key={value}
                row
                name="severity"
                value={value}
                label={t(`incident.severity.${value}`)}
                hint={t(`incidentNew.severityHint.${value}`)}
                checked={severity === value}
                onChange={() => {
                  setSeverity(value);
                  if (!targetTouched) setTarget(options.targets[value]);
                }}
              />
            ))}
          </FieldGroup>
        </Section>
        <Section id="ops-inc-owner" title={t("incidentNew.ownership")}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Select name="ownerId" label={t("incidentNew.owner")} hint={t("incidentNew.ownerHint")} required defaultValue={defaultOwner} options={options.owners.map((person) => ({ value: person.id, label: person.name }))} error={fields.ownerId} />
            <TextField
              name="targetDay"
              type="date"
              label={t("incidentNew.target")}
              hint={t("incidentNew.targetHint")}
              required
              ltr
              min={options.today}
              value={target}
              onChange={(event) => {
                setTarget(event.target.value);
                setTargetTouched(true);
              }}
              error={fields.targetDay}
            />
            <TextField name="startedAt" type="datetime-local" label={t("incidentNew.started")} hint={t("incidentNew.startedHint")} ltr defaultValue={startedAt} max={startedAt} error={fields.startedAt} />
          </div>
        </Section>
        {options.links.length ? (
          <Section id="ops-inc-links" title={t("incidentNew.links")}>
            <FieldGroup legend={t("incidentNew.linksLegend")} hint={t("incidentNew.linksHint")} error={fields.links}>
              {options.links.map((link) => (
                <Checkbox key={`${link.kind}:${link.id}`} name="link" value={`${link.kind}:${link.id}`} defaultChecked label={`${t(`link.kind.${link.kind}`)} · ${link.label}`} />
              ))}
            </FieldGroup>
          </Section>
        ) : null}
        <Note>
          <p>{t("incidentNew.note")}</p>
        </Note>
        <FormError message={failure} />
        <div className="flex flex-wrap gap-2">
          <Key type="submit" variant="ink" icon="first-aid-kit" loading={busy}>
            {t("incidentNew.submit")}
          </Key>
          <Key as={Link} to="/admin/ops/incidents">
            {t("common.back")}
          </Key>
        </div>
      </Form>
    </div>
  );
}
