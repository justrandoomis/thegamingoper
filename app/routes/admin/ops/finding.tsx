import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/finding";
import { useFormat } from "~/i18n/react";
import { assignFindings, closeFindings, getFinding, reopenFinding } from "~/server/services/admin/ops/consistency.server";
import { linkToIncident, listIncidents } from "~/server/services/admin/ops/incidents.server";
import { opsAccess } from "~/server/services/admin/ops/shared.server";
import { FINDING_SEVERITY_TONE, FINDING_STATUS_TONE, INCIDENT_STATUS_TONE, baghdadDay, isWalletCheck, parseIncidentFilters, type IncidentStatus } from "~/server/services/admin/ops/types";
import { invalid } from "~/server/errors";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { AssignFields } from "./components/AssignFields";
import { Facts } from "./components/Facts";
import { History } from "./components/History";
import { checkText, checkTitle } from "./components/labels";
import { ActionDialog, ActorName, Ago, Code, Note, PageHead, Pair, Section, StatusText, When, keyLabel, tOr, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { ok, ops, optional, text } from "./ops.server";

/**
 * /admin/ops/consistency/:findingId — one finding of the daily checks: what the check compares, why it matters and how
 * to look into it; the record it is about (a link into the module that owns it — corrections happen there, never
 * here); the numbers the check saw (withheld for a cost check without cost.read); when it was first and last seen;
 * who has it; its history and the incidents it belongs to. Actions (ops.consistency.resolve): give it to a person,
 * close it as resolved or as a false positive with a reason, open it again; link it to an incident
 * (ops.incident.manage).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.consistency.read");
  const access = opsAccess(req.actor);
  const [detail, open] = await ops.orRespond(req, () =>
    Promise.all([getFinding(req.db, req.actor, args.params.findingId), access.manageIncidents ? listIncidents(req.db, req.actor, parseIncidentFilters(new URLSearchParams("view=active&sort=started")), req.now) : Promise.resolve(null)]),
  );
  return { ...detail, access, openIncidents: open?.rows.map((row) => ({ id: row.id, ref: row.ref, title: row.title })) ?? [], now: req.now, today: baghdadDay(req.now) };
}

export async function action(args: Route.ActionArgs) {
  // the page's permission first; each change's own permission is checked by its service (resolve / incident.manage)
  const req = await ops.open(args, "ops.consistency.read");
  const id = args.params.findingId;
  let intent: string | null = null;
  try {
    const form = await ops.form(args.request);
    intent = text(form, "intent");
    if (intent === "assign") return ok(intent, await assignFindings(req.db, req.actor, { ids: [id], assigneeId: text(form, "assigneeId"), dueDay: optional(form, "dueDay"), note: optional(form, "reason") }, req.now));
    if (intent === "close") return ok(intent, await closeFindings(req.db, req.actor, { ids: [id], outcome: text(form, "outcome"), reason: text(form, "reason") }, req.now));
    if (intent === "reopen") return ok(intent, await reopenFinding(req.db, req.actor, { id, reason: text(form, "reason") }, req.now));
    if (intent === "link") return ok(intent, await linkToIncident(req.db, req.actor, { incidentId: text(form, "incidentId"), kind: "finding", id, reason: optional(form, "reason") }, req.now));
    throw invalid({ intent: "invalid" });
  } catch (error) {
    return ops.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "finding.title");

type Dialog = "assign" | "resolved" | "false_positive" | "reopen" | "link" | null;

export default function FindingPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const f = useFormat();
  const { finding, history, incidents, run, assignees, access, openIncidents, now, today } = loaderData;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [assignee, setAssignee] = useState(finding.assignee?.id ?? "");
  const [dueDay, setDueDay] = useState(finding.assignee?.dueAt ? baghdadDay(finding.assignee.dueAt) : "");
  const [incidentId, setIncidentId] = useState(openIncidents[0]?.id ?? "");
  const active = finding.status === "open" || finding.status === "acknowledged";
  const close = () => setDialog(null);

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/ops/consistency" className="adm-link">
            {t("finding.back")}
          </Link>
        }
        title={checkTitle(t, finding.checkKey)}
        lead={
          <span className="flex flex-wrap items-center gap-3">
            <StatusText tone={FINDING_SEVERITY_TONE[finding.severity]}>{t(`severity.${finding.severity}`)}</StatusText>
            <StatusText tone={FINDING_STATUS_TONE[finding.status]}>{t(`finding.status.${finding.status}`)}</StatusText>
            <Code>{finding.checkKey}</Code>
          </span>
        }
        actions={
          <div className="ops-actions">
            {access.resolveFindings && active ? (
              <>
                <Key onClick={() => setDialog("assign")} icon="user">
                  {finding.assignee ? t("finding.reassign") : t("finding.assign")}
                </Key>
                <Key variant="ink" onClick={() => setDialog("resolved")} icon="check">
                  {t("finding.resolve")}
                </Key>
                <Key variant="ghost" onClick={() => setDialog("false_positive")}>
                  {t("finding.dismiss")}
                </Key>
              </>
            ) : null}
            {access.resolveFindings && !active ? (
              <Key onClick={() => setDialog("reopen")} icon="arrow-counter-clockwise">
                {t("finding.reopen")}
              </Key>
            ) : null}
          </div>
        }
      />

      <div className="ops-split">
        <div className="grid min-w-0 gap-5">
          <Section id="ops-finding-about" title={t("finding.about")}>
            <div className="adm-card gap-3">
              <div className="grid gap-1">
                <p className="type-label text-ink">{t("finding.what")}</p>
                <p className="type-body text-ink">{checkText(t, finding.checkKey, "what")}</p>
              </div>
              <div className="grid gap-1">
                <p className="type-label text-ink">{t("finding.why")}</p>
                <p className="type-body text-ink">{checkText(t, finding.checkKey, "why")}</p>
              </div>
              <div className="grid gap-1">
                <p className="type-label text-ink">{t("finding.how")}</p>
                <p className="type-body text-ink">{checkText(t, finding.checkKey, "how")}</p>
              </div>
            </div>
            <Note icon="info">
              <p>{t("finding.neverEdits")}</p>
            </Note>
          </Section>

          <Section id="ops-finding-record" title={t("finding.record")}>
            <div className="adm-card gap-2">
              <Pair label={t("finding.recordType")}>{tOr(t, `entity.${finding.entity.type ?? "none"}`, keyLabel(finding.entity.type ?? "—"))}</Pair>
              <Pair label={t("finding.recordId")}>
                {finding.entity.href ? (
                  <Link to={finding.entity.href} className="adm-link">
                    <Code>{finding.entity.label ?? finding.entity.id ?? "—"}</Code>
                  </Link>
                ) : (
                  <Code>{finding.entity.label ?? finding.entity.id ?? "—"}</Code>
                )}
              </Pair>
              {finding.entity.href ? <p className="type-caption text-ink-2">{t("finding.fixThere")}</p> : null}
            </div>
          </Section>

          <Section id="ops-finding-numbers" title={t("finding.numbers")}>
            {finding.withheld && !finding.details ? (
              <Note icon="lock">
                <p>{t(isWalletCheck(finding.checkKey) && !access.wallet ? "finding.withheldWallet" : "finding.withheld")}</p>
              </Note>
            ) : (
              <>
                {finding.details ? <Facts value={finding.details} /> : <p className="type-body text-ink-2">—</p>}
                {finding.withheld ? (
                  <Note icon="lock">
                    <p>{t("finding.partlyWithheld")}</p>
                  </Note>
                ) : null}
                {finding.message ? (
                  <p className="type-caption text-ink-2">
                    {t("finding.asWritten")} <bdi dir="ltr">{finding.message}</bdi>
                  </p>
                ) : null}
              </>
            )}
          </Section>

          <Section id="ops-finding-history" title={t("finding.history")}>
            <History events={history} empty={t("finding.noHistory")} />
          </Section>
        </div>

        <aside className="grid min-w-0 gap-5" aria-label={t("finding.facts")}>
          <Section id="ops-finding-facts" title={t("finding.facts")}>
            <div className="adm-card gap-2">
              <Pair label={t("finding.firstSeen")}>
                <When at={finding.detectedAt} />
              </Pair>
              <Pair label={t("finding.lastSeen")}>
                <Ago at={finding.lastSeenAt} now={now} />
              </Pair>
              <Pair label={t("finding.occurrences")}>{f.number(finding.occurrences)}</Pair>
              <Pair label={t("finding.run")}>
                {run ? (
                  run.href ? (
                    <Link to={run.href} className="adm-link">
                      <When at={run.startedAt} />
                    </Link>
                  ) : (
                    <When at={run.startedAt} />
                  )
                ) : (
                  "—"
                )}
              </Pair>
              <Pair label={t("consistency.col.who")}>{finding.assignee ? finding.assignee.name : t("consistency.nobody")}</Pair>
              {finding.assignee?.dueAt ? (
                <Pair label={t("consistency.due")}>
                  <span className={finding.assignee.dueAt < now ? "text-red-ink" : undefined}>
                    <When at={finding.assignee.dueAt} kind="date" />
                  </span>
                </Pair>
              ) : null}
              {finding.resolvedAt ? (
                <>
                  <Pair label={t("finding.closedBy")}>
                    <ActorName by={finding.resolvedBy} />
                  </Pair>
                  <Pair label={t("finding.closedAt")}>
                    <When at={finding.resolvedAt} />
                  </Pair>
                </>
              ) : null}
            </div>
            {finding.resolutionNote ? (
              <div className="adm-card gap-1">
                <p className="type-label text-ink">{t("finding.closeNote")}</p>
                <p className="ops-note type-body text-ink">{finding.resolutionNote}</p>
              </div>
            ) : null}
          </Section>

          {access.incidents ? (
            <Section id="ops-finding-incidents" title={t("finding.incidents")}>
              {incidents.length ? (
                <ul role="list" className="grid gap-2">
                  {incidents.map((incident) => (
                    <li key={incident.id} className="adm-card gap-1">
                      <Link to={`/admin/ops/incidents/${incident.ref}`} className="adm-link type-strong">
                        <Code>{incident.ref}</Code> · {incident.title}
                      </Link>
                      <StatusText tone={INCIDENT_STATUS_TONE[incident.status as IncidentStatus] ?? "neutral"}>{t(`incident.status.${incident.status}`)}</StatusText>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="type-body text-ink-2">{t("finding.noIncidents")}</p>
              )}
              {access.manageIncidents ? (
                <div className="ops-actions ops-noprint">
                  <Key as={Link} to={`/admin/ops/incidents/new?finding=${encodeURIComponent(finding.id)}`} icon="first-aid-kit" size="sm">
                    {t("finding.newIncident")}
                  </Key>
                  {openIncidents.length ? (
                    <Key size="sm" variant="ghost" onClick={() => setDialog("link")} icon="link">
                      {t("finding.linkIncident")}
                    </Key>
                  ) : null}
                </div>
              ) : null}
            </Section>
          ) : null}
        </aside>
      </div>

      <ActionDialog
        open={dialog === "assign"}
        onClose={close}
        title={finding.assignee ? t("finding.reassign") : t("finding.assign")}
        consequence={t("consistency.assignConsequence")}
        confirmLabel={t("confirm.give")}
        reason={{ label: t("consistency.note"), noteRequired: false, minLength: 0, hint: t("consistency.noteHint") }}
        fields={{ intent: "assign", assigneeId: assignee, dueDay }}
        successMessage={(result) => (Number(result.assigned ?? 0) > 0 ? t("finding.assigned") : t("finding.unchanged"))}
      >
        <AssignFields people={assignees} assignee={assignee} onAssignee={setAssignee} dueDay={dueDay} onDueDay={setDueDay} today={today} />
      </ActionDialog>
      <ActionDialog
        open={dialog === "resolved" || dialog === "false_positive"}
        onClose={close}
        title={dialog === "false_positive" ? t("finding.dismissTitle") : t("finding.resolveTitle")}
        consequence={dialog === "false_positive" ? t("consistency.dismissConsequence") : t("consistency.resolveConsequence")}
        confirmLabel={dialog === "false_positive" ? t("confirm.dismiss") : t("confirm.resolve")}
        impact={[
          { label: t("finding.recordId"), value: finding.entity.label ?? finding.entity.id ?? "—" },
          { label: t("consistency.dataChanged"), value: t("consistency.nothing") },
        ]}
        reason={{ label: t("common.reason"), hint: t("consistency.reasonHint") }}
        fields={{ intent: "close", outcome: dialog === "false_positive" ? "false_positive" : "resolved" }}
        successMessage={t("finding.closed")}
      />
      <ActionDialog
        open={dialog === "reopen"}
        onClose={close}
        title={t("finding.reopenTitle")}
        consequence={t("finding.reopenConsequence")}
        confirmLabel={t("confirm.reopen")}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "reopen" }}
        successMessage={t("finding.reopened")}
      />
      <ActionDialog
        open={dialog === "link"}
        onClose={close}
        title={t("finding.linkIncident")}
        consequence={t("finding.linkConsequence")}
        confirmLabel={t("confirm.link")}
        reason={{ label: t("consistency.note"), noteRequired: false, minLength: 0 }}
        fields={{ intent: "link", incidentId }}
        successMessage={t("finding.linked")}
      >
        <Select label={t("finding.incident")} value={incidentId} onChange={(event) => setIncidentId(event.target.value)} options={openIncidents.map((incident) => ({ value: incident.id, label: `${incident.ref} · ${incident.title}` }))} />
      </ActionDialog>
    </>
  );
}
