import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";

import type { Route } from "./+types/incident";
import {
  addIncidentUpdate,
  changeIncidentOwner,
  changeIncidentSeverity,
  editIncident,
  getIncident,
  incidentIdForPage,
  linkToIncident,
  linkableKinds,
  reopenIncident,
  resolveIncident,
  unlinkFromIncident,
} from "~/server/services/admin/ops/incidents.server";
import { opsAccess } from "~/server/services/admin/ops/shared.server";
import {
  INCIDENT_SEVERITIES,
  INCIDENT_SEVERITY_TONE,
  INCIDENT_STATUS_TONE,
  addDays,
  baghdadDay,
  toBaghdadInput,
  type IncidentSeverity,
  type LinkKind,
  type LinkView,
  type TimelineItem,
} from "~/server/services/admin/ops/types";
import { invalid } from "~/server/errors";
import { FieldGroup, Radio, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { toast } from "~/ui/toast-store";
import { ActionDialog, Code, Duration, FormError, Note, PageHead, Pair, Section, StatusText, When, failureText, tOr, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { ok, ops, optional, text } from "./ops.server";

/**
 * /admin/ops/incidents/:ref — one incident: severity, status, owner and target date (late in red-ink words), when it
 * started, was recorded, mitigated and resolved, what happened and its impact, the post-mortem, the timeline (people's
 * updates and the audited changes), and the records it is linked to (findings, job runs, errors — each with its state
 * now). With ops.incident.manage: an update (a note, optionally moving the status), resolve (the resolution time and
 * the post-mortem), reopen, owner and target, severity, details, links. Prints as its post-mortem report.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.incident.read");
  const detail = await ops.orRespond(req, () => getIncident(req.db, req.actor, args.params.ref, req.now));
  return { ...detail, access: opsAccess(req.actor), linkKinds: linkableKinds(req.actor), now: req.now, nowInput: toBaghdadInput(req.now), today: baghdadDay(req.now) };
}

export async function action(args: Route.ActionArgs) {
  const req = await ops.open(args, "ops.incident.manage");
  let intent: string | null = null;
  try {
    const form = await ops.form(args.request);
    intent = text(form, "intent");
    // the page's own incident, never another one a (stale or edited) form names
    const incidentId = await incidentIdForPage(req.db, req.actor, args.params.ref, text(form, "incidentId"));
    switch (intent) {
      case "update":
        return ok(intent, await addIncidentUpdate(req.db, req.actor, { incidentId, note: text(form, "note"), status: optional(form, "status"), expectedStatus: text(form, "expectedStatus") }, req.now));
      case "resolve":
        return ok(intent, await resolveIncident(req.db, req.actor, { incidentId, resolvedAt: optional(form, "resolvedAt"), rootCause: text(form, "reason"), note: optional(form, "note"), expectedStatus: text(form, "expectedStatus") }, req.now));
      case "reopen":
        return ok(intent, await reopenIncident(req.db, req.actor, { incidentId, reason: text(form, "reason"), targetDay: text(form, "targetDay") }, req.now));
      case "owner":
        return ok(intent, await changeIncidentOwner(req.db, req.actor, { incidentId, ownerId: text(form, "ownerId"), targetDay: text(form, "targetDay"), reason: text(form, "reason") }, req.now));
      case "severity":
        return ok(intent, await changeIncidentSeverity(req.db, req.actor, { incidentId, severity: text(form, "severity"), reason: text(form, "reason") }, req.now));
      case "edit":
        return ok(intent, await editIncident(req.db, req.actor, { incidentId, title: text(form, "title"), summary: text(form, "summary"), impact: optional(form, "impact"), rootCause: optional(form, "rootCause"), expectedUpdatedAt: text(form, "expectedUpdatedAt"), reason: text(form, "reason") }, req.now));
      case "link":
        return ok(intent, await linkToIncident(req.db, req.actor, { incidentId, kind: text(form, "kind"), id: text(form, "id"), reason: optional(form, "reason") }, req.now));
      case "unlink":
        return ok(intent, await unlinkFromIncident(req.db, req.actor, { incidentId, kind: text(form, "kind"), id: text(form, "id"), reason: text(form, "reason") }, req.now));
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return ops.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "incident.title", { ref: args.params.ref ?? "" });

type Dialog = "resolve" | "reopen" | "owner" | "severity" | "edit" | "link" | { unlink: LinkView } | null;

const str = (value: unknown) => (typeof value === "string" ? value : value === null || value === undefined ? "—" : String(value));

export default function IncidentPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const { incident, timeline, links, owners, moves, access, linkKinds, now, nowInput, today } = loaderData;
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = () => setDialog(null);
  const resolved = incident.status === "resolved";

  // dialog state
  // empty = now (the exact time of the decision); a person picks an earlier time only when it really ended earlier
  const [resolvedAt, setResolvedAt] = useState("");
  const [closingNote, setClosingNote] = useState("");
  const defaultTarget = () => (incident.targetAt && incident.targetAt > now ? baghdadDay(incident.targetAt) : addDays(today, 1));
  const [ownerId, setOwnerId] = useState(incident.owner?.id ?? owners[0]?.id ?? "");
  const [targetDay, setTargetDay] = useState(defaultTarget);
  const [severity, setSeverity] = useState<IncidentSeverity>(incident.severity);
  const [title, setTitle] = useState(incident.title);
  const [summary, setSummary] = useState(incident.summary ?? "");
  const [impact, setImpact] = useState(incident.impact ?? "");
  const [rootCause, setRootCause] = useState(incident.rootCause ?? "");
  // the version the edit dialog was opened on: the service refuses the save if someone changed it since
  const [editVersion, setEditVersion] = useState(incident.updatedAt);
  const [linkKind, setLinkKind] = useState<LinkKind>(linkKinds[0] ?? "finding");
  const [linkId, setLinkId] = useState("");

  /**
   * A dialog opens on the incident as the page shows it NOW (after any revalidation), never on values typed or loaded
   * earlier: saving stale details over someone's newer edit is what the version check exists to stop.
   */
  const open = (next: Exclude<Dialog, null>) => {
    if (next === "edit") {
      setTitle(incident.title);
      setSummary(incident.summary ?? "");
      setImpact(incident.impact ?? "");
      setRootCause(incident.rootCause ?? "");
      setEditVersion(incident.updatedAt);
    } else if (next === "owner" || next === "reopen") {
      setOwnerId(incident.owner?.id ?? owners[0]?.id ?? "");
      setTargetDay(defaultTarget());
    } else if (next === "severity") {
      setSeverity(incident.severity);
    }
    setDialog(next);
  };

  // "opened" toast after the redirect from the new-incident form, once
  const shown = useRef(false);
  useEffect(() => {
    if (params.get("created") !== "1" || shown.current) return;
    shown.current = true;
    toast.success(t("incident.created", { ref: incident.ref }));
    const next = new URLSearchParams(params);
    next.delete("created");
    setParams(next, { replace: true, preventScrollReset: true });
  }, [params, setParams, t, incident.ref]);

  // a printed report is always on paper colours, whatever theme the screen uses
  useEffect(() => {
    const root = document.documentElement;
    let previous: string | undefined;
    const before = () => {
      previous = root.dataset.theme;
      root.dataset.theme = "light";
    };
    const after = () => {
      if (previous === undefined) delete root.dataset.theme;
      else root.dataset.theme = previous;
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);

  // the update form (a note, optionally a status move)
  const update = useFetcher<{ ok: boolean; message?: string; code?: string; fields?: Record<string, string> }>();
  const noteRef = useRef<HTMLFormElement>(null);
  // once per answer: `t` changes with every revalidation, which must not toast again nor wipe a note being typed
  const handledUpdate = useRef<unknown>(undefined);
  useEffect(() => {
    if (update.state !== "idle" || !update.data?.ok || handledUpdate.current === update.data) return;
    handledUpdate.current = update.data;
    noteRef.current?.reset();
    toast.success(t("incident.updated"));
  }, [update.state, update.data, t]);

  const timelineItem = (item: TimelineItem) => {
    if (item.kind === "update") {
      return (
        <li key={item.id}>
          <p className="type-label text-ink">
            {item.status ? t("incident.timeline.status", { status: t(`incident.status.${item.status}`) }) : t("incident.timeline.note")} · {item.by ?? "—"}
          </p>
          <p className="type-caption text-ink-2">
            <When at={item.at} />
          </p>
          <p className="ops-note type-body text-ink">{item.note}</p>
        </li>
      );
    }
    const before = item.before ?? {};
    const after = item.after ?? {};
    let line = "";
    if (item.action === "ops.incident.owner") line = t("incident.timeline.owner", { from: str(before.owner), to: str(after.owner), day: str(after.targetDay) });
    else if (item.action === "ops.incident.severity") line = t("incident.timeline.severity", { from: t(`incident.severity.${str(before.severity)}`), to: t(`incident.severity.${str(after.severity)}`) });
    else if (item.action === "ops.incident.edit") line = t("incident.timeline.edit", { fields: Object.keys(after).map((key) => t(`incident.field.${key}`)).join(t("common.listSep")) });
    else if (item.action === "ops.incident.link") line = t("incident.timeline.link", { kind: t(`link.kind.${str(after.kind)}`), label: str(after.label) });
    else if (item.action === "ops.incident.unlink") line = t("incident.timeline.unlink", { kind: t(`link.kind.${str(after.kind)}`), label: str(after.label) });
    else line = item.action;
    return (
      <li key={item.id}>
        <p className="type-label text-ink">
          {line} · {item.by ?? "—"}
        </p>
        <p className="type-caption text-ink-2">
          <When at={item.at} />
        </p>
        {item.reason ? <p className="ops-note type-body text-ink-2">{item.reason}</p> : null}
      </li>
    );
  };

  const linkState = (link: LinkView) => {
    if (link.state === null) return <span className="type-caption text-ink-2">{t("incident.linkGone")}</span>;
    const words = link.kind === "finding" ? tOr(t, `finding.status.${link.state}`, link.state) : link.kind === "run" ? tOr(t, `run.status.${link.state}`, link.state) : tOr(t, `errorReport.status.${link.state}`, link.state);
    return <span className="type-caption text-ink-2">{words}</span>;
  };
  const failure = failureText(t, update.data);

  return (
    <div className="ops-print">
      <PageHead
        eyebrow={
          <Link to="/admin/ops/incidents" className="adm-link ops-noprint">
            {t("incident.back")}
          </Link>
        }
        title={
          <>
            <Code>{incident.ref}</Code> · {incident.title}
          </>
        }
        lead={
          <span className="flex flex-wrap items-center gap-3">
            <StatusText tone={INCIDENT_SEVERITY_TONE[incident.severity]}>{t(`incident.severity.${incident.severity}`)}</StatusText>
            <StatusText tone={INCIDENT_STATUS_TONE[incident.status]}>{t(`incident.status.${incident.status}`)}</StatusText>
            {incident.overdue ? <StatusText tone="bad">{t("incidents.late")}</StatusText> : null}
          </span>
        }
        actions={
          <>
            {access.manageIncidents ? (
              resolved ? (
                <Key onClick={() => open("reopen")} icon="arrow-counter-clockwise">
                  {t("incident.reopen")}
                </Key>
              ) : (
                <Key variant="ink" onClick={() => setDialog("resolve")} icon="check">
                  {t("incident.resolve")}
                </Key>
              )
            ) : null}
            <Key onClick={() => window.print()} icon="printer">
              {t("incident.print")}
            </Key>
          </>
        }
      />

      <div className="ops-split">
        <div className="grid min-w-0 gap-5">
          <Section id="ops-inc-summary" title={t("incident.summary")}>
            <div className="adm-card ops-print-block gap-3">
              <p className="ops-note type-body text-ink">{incident.summary ?? "—"}</p>
              {incident.impact ? (
                <div className="grid gap-1">
                  <p className="type-label text-ink">{t("incident.impact")}</p>
                  <p className="ops-note type-body text-ink">{incident.impact}</p>
                </div>
              ) : null}
            </div>
          </Section>

          <Section id="ops-inc-postmortem" title={t("incident.postmortem")}>
            {incident.rootCause ? (
              <div className="adm-card ops-print-block">
                <p className="ops-note type-body text-ink">{incident.rootCause}</p>
              </div>
            ) : (
              <p className="type-body text-ink-2">{resolved ? "—" : t("incident.postmortemLater")}</p>
            )}
          </Section>

          <Section id="ops-inc-timeline" title={t("incident.timeline.title")}>
            {access.manageIncidents ? (
              <update.Form method="post" ref={noteRef} className="adm-card ops-noprint gap-3" noValidate>
                <input type="hidden" name="intent" value="update" />
                <input type="hidden" name="incidentId" value={incident.id} />
                <input type="hidden" name="expectedStatus" value={incident.status} />
                <TextArea name="note" label={t("incident.updateNote")} hint={t("incident.updateHint")} required rows={3} maxLength={4000} error={update.data && !update.data.ok ? update.data.fields?.note : undefined} />
                {moves.length ? (
                  <Select
                    name="status"
                    label={t("incident.updateStatus")}
                    defaultValue=""
                    options={[{ value: "", label: t("incident.keepStatus", { status: t(`incident.status.${incident.status}`) }) }, ...moves.map((move) => ({ value: move, label: t(`incident.status.${move}`) }))]}
                  />
                ) : null}
                <FormError message={failure && !update.data?.fields?.note ? failure : null} />
                <div>
                  <Key type="submit" icon="plus" loading={update.state !== "idle"}>
                    {t("incident.addUpdate")}
                  </Key>
                </div>
              </update.Form>
            ) : null}
            <ol className="ops-timeline">{timeline.map(timelineItem)}</ol>
          </Section>
        </div>

        <aside className="grid min-w-0 gap-5" aria-label={t("incident.facts")}>
          <Section id="ops-inc-facts" title={t("incident.facts")}>
            <div className="adm-card ops-print-block gap-2">
              <Pair label={t("incidents.col.owner")}>{incident.owner?.name ?? "—"}</Pair>
              <Pair label={t("incident.targetLabel")}>
                <span className={incident.overdue ? "text-red-ink" : undefined}>
                  <When at={incident.targetAt} kind="date" />
                </span>
              </Pair>
              <Pair label={t("incidents.col.started")}>
                <When at={incident.startedAt} />
              </Pair>
              <Pair label={t("incident.recorded")}>
                <When at={incident.detectedAt ?? incident.createdAt} />
              </Pair>
              <Pair label={t("incident.mitigated")}>
                <When at={incident.mitigatedAt} />
              </Pair>
              <Pair label={t("incident.resolved")}>
                <When at={incident.resolvedAt} />
              </Pair>
              {incident.resolvedAt ? (
                <Pair label={t("incident.took")}>
                  <Duration ms={incident.resolvedAt - incident.startedAt} />
                </Pair>
              ) : null}
              <Pair label={t("incident.createdBy")}>{incident.createdBy ?? "—"}</Pair>
            </div>
          </Section>

          {access.manageIncidents ? (
            <Section id="ops-inc-actions" title={t("incident.actions")} className="ops-noprint">
              <div className="ops-actions">
                {resolved ? null : (
                  <Key onClick={() => open("owner")} icon="user">
                    {t("incident.changeOwner")}
                  </Key>
                )}
                <Key onClick={() => open("severity")} icon="warning">
                  {t("incident.changeSeverity")}
                </Key>
                <Key variant="ghost" onClick={() => open("edit")} icon="pencil-simple">
                  {t("incident.edit")}
                </Key>
              </div>
            </Section>
          ) : null}

          <Section id="ops-inc-links" title={t("incident.links")}>
            {links.length ? (
              <ul role="list" className="grid gap-2">
                {links.map((link) => (
                  <li key={`${link.kind}:${link.id}`} className="adm-card ops-print-block gap-1">
                    <p className="type-caption text-ink-2">{t(`link.kind.${link.kind}`)}</p>
                    {link.href ? (
                      <Link to={link.href} className="adm-link type-data">
                        {link.label}
                      </Link>
                    ) : (
                      <span className="type-data">{link.label}</span>
                    )}
                    {linkState(link)}
                    {access.manageIncidents ? (
                      <div className="ops-noprint">
                        <Key size="sm" variant="ghost" onClick={() => setDialog({ unlink: link })}>
                          {t("incident.unlink")}
                        </Key>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-body text-ink-2">{t("incident.noLinks")}</p>
            )}
            {access.manageIncidents && linkKinds.length ? (
              <div className="ops-noprint">
                <Key size="sm" icon="link" onClick={() => setDialog("link")}>
                  {t("incident.link")}
                </Key>
              </div>
            ) : null}
          </Section>
        </aside>
      </div>

      <ActionDialog
        open={dialog === "resolve"}
        onClose={close}
        title={t("incident.resolveTitle", { ref: incident.ref })}
        consequence={t("incident.resolveConsequence")}
        confirmLabel={t("confirm.close")}
        reason={{ label: t("incident.postmortemField"), hint: t("incident.postmortemHint"), minLength: 20, maxLength: 8000 }}
        fields={{ intent: "resolve", incidentId: incident.id, expectedStatus: incident.status, resolvedAt, note: closingNote }}
        successMessage={t("incident.resolvedToast")}
      >
        <TextField type="datetime-local" label={t("incident.resolvedAt")} hint={t("incident.resolvedAtHint")} ltr value={resolvedAt} max={nowInput} onChange={(event) => setResolvedAt(event.target.value)} />
        <TextArea label={t("incident.closingNote")} optional rows={2} maxLength={2000} value={closingNote} onChange={(event) => setClosingNote(event.target.value)} />
      </ActionDialog>
      <ActionDialog
        open={dialog === "reopen"}
        onClose={close}
        title={t("incident.reopenTitle", { ref: incident.ref })}
        consequence={t("incident.reopenConsequence")}
        confirmLabel={t("confirm.reopen")}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "reopen", incidentId: incident.id, targetDay }}
        successMessage={t("incident.reopenedToast")}
      >
        <TextField type="date" label={t("incident.targetLabel")} hint={t("incidentNew.targetHint")} required ltr min={today} value={targetDay} onChange={(event) => setTargetDay(event.target.value)} />
      </ActionDialog>
      <ActionDialog
        open={dialog === "owner"}
        onClose={close}
        title={t("incident.changeOwner")}
        consequence={t("incident.ownerConsequence")}
        confirmLabel={t("confirm.save")}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "owner", incidentId: incident.id, ownerId, targetDay }}
        successMessage={(result) => (result.changed ? t("incident.ownerToast") : t("incident.unchanged"))}
      >
        <Select label={t("incidentNew.owner")} hint={t("incidentNew.ownerHint")} required value={ownerId} onChange={(event) => setOwnerId(event.target.value)} options={owners.map((person) => ({ value: person.id, label: person.name }))} />
        <TextField type="date" label={t("incident.targetLabel")} required ltr min={today} value={targetDay} onChange={(event) => setTargetDay(event.target.value)} />
      </ActionDialog>
      <ActionDialog
        open={dialog === "severity"}
        onClose={close}
        title={t("incident.changeSeverity")}
        consequence={t("incident.severityConsequence")}
        confirmLabel={t("confirm.change")}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "severity", incidentId: incident.id, severity }}
        successMessage={(result) => (result.changed ? t("incident.severityToast") : t("incident.unchanged"))}
      >
        <FieldGroup legend={t("incidentNew.severityLegend")}>
          {INCIDENT_SEVERITIES.map((value) => (
            <Radio key={value} row name="incident-severity" value={value} label={t(`incident.severity.${value}`)} hint={t(`incidentNew.severityHint.${value}`)} checked={severity === value} onChange={() => setSeverity(value)} />
          ))}
        </FieldGroup>
      </ActionDialog>
      <ActionDialog
        open={dialog === "edit"}
        onClose={close}
        title={t("incident.edit")}
        consequence={t("incident.editConsequence")}
        confirmLabel={t("confirm.save")}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "edit", incidentId: incident.id, title, summary, impact, rootCause, expectedUpdatedAt: String(editVersion) }}
        successMessage={t("incident.editedToast")}
      >
        <TextField label={t("incidentNew.titleField")} required maxLength={160} value={title} onChange={(event) => setTitle(event.target.value)} />
        <TextArea label={t("incidentNew.summary")} required rows={3} maxLength={4000} value={summary} onChange={(event) => setSummary(event.target.value)} />
        <TextArea label={t("incidentNew.impact")} optional rows={2} maxLength={2000} value={impact} onChange={(event) => setImpact(event.target.value)} />
        {resolved ? <TextArea label={t("incident.postmortemField")} rows={4} maxLength={8000} value={rootCause} onChange={(event) => setRootCause(event.target.value)} /> : null}
      </ActionDialog>
      <ActionDialog
        open={dialog === "link"}
        onClose={close}
        title={t("incident.link")}
        consequence={t("incident.linkConsequence")}
        confirmLabel={t("confirm.link")}
        reason={{ label: t("consistency.note"), noteRequired: false, minLength: 0 }}
        fields={{ intent: "link", incidentId: incident.id, kind: linkKind, id: linkId.trim() }}
        successMessage={(result) => (result.replayed ? t("incident.alreadyLinked") : t("incident.linkedToast"))}
      >
        <Select label={t("incident.linkKind")} value={linkKind} onChange={(event) => setLinkKind(event.target.value as LinkKind)} options={linkKinds.map((kind) => ({ value: kind, label: t(`link.kind.${kind}`) }))} />
        <TextField label={t("incident.linkId")} hint={t("incident.linkIdHint")} required ltr maxLength={64} value={linkId} onChange={(event) => setLinkId(event.target.value)} />
      </ActionDialog>
      <ActionDialog
        open={typeof dialog === "object" && dialog !== null}
        onClose={close}
        title={t("incident.unlinkTitle")}
        consequence={typeof dialog === "object" && dialog !== null ? t("incident.unlinkConsequence", { label: dialog.unlink.label }) : ""}
        confirmLabel={t("incident.unlink")}
        tone="destructive"
        reason={{ label: t("common.reason") }}
        fields={typeof dialog === "object" && dialog !== null ? { intent: "unlink", incidentId: incident.id, kind: dialog.unlink.kind, id: dialog.unlink.id } : { intent: "unlink" }}
        successMessage={t("incident.unlinkedToast")}
      />

      <Note className="ops-noprint">
        <p>{t("incident.printNote")}</p>
      </Note>
    </div>
  );
}
