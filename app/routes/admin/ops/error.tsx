import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/error";
import { useFormat } from "~/i18n/react";
import { linkToIncident, listIncidents, unlinkFromIncident } from "~/server/services/admin/ops/incidents.server";
import { opsAccess } from "~/server/services/admin/ops/shared.server";
import { getErrorReport, setErrorStatus } from "~/server/services/admin/ops/telemetry.server";
import { ERROR_LEVEL_TONE, ERROR_STATUS_TONE, parseIncidentFilters } from "~/server/services/admin/ops/types";
import { invalid } from "~/server/errors";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Facts } from "./components/Facts";
import { History } from "./components/History";
import { ActionDialog, Ago, Code, PageHead, Pair, Section, StatusText, When, useOpsT } from "./components/ui";
import { opsMeta } from "./meta";
import { ok, ops, optional, text } from "./ops.server";

/**
 * /admin/ops/errors/:errorId — one kind of error: its scrubbed message and stack, where it happened (route pattern and
 * path, never a query), how often and since when, the context of its latest occurrence (request id to find it in
 * Workers Logs, device class), its incident, its history. Resolve / ignore / reopen with a reason (ops.error.resolve);
 * link it to an incident or take it off (ops.incident.manage).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ops.open(args, "ops.error.read");
  const access = opsAccess(req.actor);
  const [detail, open] = await ops.orRespond(req, () =>
    Promise.all([getErrorReport(req.db, req.actor, args.params.errorId), access.manageIncidents ? listIncidents(req.db, req.actor, parseIncidentFilters(new URLSearchParams("view=active&sort=started")), req.now) : Promise.resolve(null)]),
  );
  return { ...detail, access, openIncidents: open?.rows.map((row) => ({ id: row.id, ref: row.ref, title: row.title })) ?? [], now: req.now };
}

export async function action(args: Route.ActionArgs) {
  // the page's permission first; each change's own permission is checked by its service (error.resolve / incident.manage)
  const req = await ops.open(args, "ops.error.read");
  const id = args.params.errorId;
  let intent: string | null = null;
  try {
    const form = await ops.form(args.request);
    intent = text(form, "intent");
    if (intent === "status") return ok(intent, await setErrorStatus(req.db, req.actor, { ids: [id], status: text(form, "status"), reason: text(form, "reason") }, req.now));
    if (intent === "link") return ok(intent, await linkToIncident(req.db, req.actor, { incidentId: text(form, "incidentId"), kind: "error", id, reason: optional(form, "reason") }, req.now));
    if (intent === "unlink") return ok(intent, await unlinkFromIncident(req.db, req.actor, { incidentId: text(form, "incidentId"), kind: "error", id, reason: text(form, "reason") }, req.now));
    throw invalid({ intent: "invalid" });
  } catch (error) {
    return ops.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => opsMeta(args, "errorDetail.title");

type Dialog = "resolved" | "ignored" | "open" | "link" | "unlink" | null;

export default function ErrorPage({ loaderData }: Route.ComponentProps) {
  const t = useOpsT();
  const f = useFormat();
  const { error, history, access, openIncidents, now } = loaderData;
  const [dialog, setDialog] = useState<Dialog>(null);
  const [incidentId, setIncidentId] = useState(openIncidents[0]?.id ?? "");
  const close = () => setDialog(null);
  const statusDialog = dialog === "resolved" || dialog === "ignored" || dialog === "open" ? dialog : null;

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/ops/errors" className="adm-link">
            {t("errorDetail.back")}
          </Link>
        }
        title={t("errorDetail.heading", { source: t(`errorReport.source.${error.source}`) })}
        lead={
          <span className="flex flex-wrap items-center gap-3">
            <StatusText tone={ERROR_LEVEL_TONE[error.level]}>{t(`errorReport.level.${error.level}`)}</StatusText>
            <StatusText tone={ERROR_STATUS_TONE[error.status]}>{t(`errorReport.status.${error.status}`)}</StatusText>
          </span>
        }
        actions={
          access.resolveErrors ? (
            <div className="ops-actions">
              {error.status === "open" ? (
                <>
                  <Key variant="ink" icon="check" onClick={() => setDialog("resolved")}>
                    {t("errorList.bulk.resolve")}
                  </Key>
                  <Key variant="ghost" onClick={() => setDialog("ignored")}>
                    {t("errorList.bulk.ignore")}
                  </Key>
                </>
              ) : (
                <Key icon="arrow-counter-clockwise" onClick={() => setDialog("open")}>
                  {t("errorList.bulk.reopen")}
                </Key>
              )}
            </div>
          ) : null
        }
      />
      <div className="ops-split">
        <div className="grid min-w-0 gap-5">
          <Section id="ops-error-message" title={t("errorDetail.message")}>
            <pre dir="ltr" className="ops-pre type-data">
              {error.message}
            </pre>
          </Section>
          <Section id="ops-error-stack" title={t("errorDetail.stack")}>
            {error.stack ? (
              <pre dir="ltr" className="ops-pre type-data-sm">
                {error.stack}
              </pre>
            ) : (
              <p className="type-body text-ink-2">{t("errorDetail.noStack")}</p>
            )}
          </Section>
          <Section id="ops-error-sample" title={t("errorDetail.sample")}>
            {error.sample && Object.keys(error.sample).length ? <Facts value={error.sample} /> : <p className="type-body text-ink-2">—</p>}
            <p className="type-caption text-ink-2">{t("errorDetail.sampleHint")}</p>
          </Section>
          <Section id="ops-error-history" title={t("finding.history")}>
            <History events={history} empty={t("errorDetail.noHistory")} />
          </Section>
        </div>
        <aside className="grid min-w-0 gap-5" aria-label={t("finding.facts")}>
          <Section id="ops-error-facts" title={t("finding.facts")}>
            <div className="adm-card gap-2">
              <Pair label={t("errorList.col.count")}>{f.number(error.count)}</Pair>
              <Pair label={t("finding.firstSeen")}>
                <When at={error.firstSeenAt} />
              </Pair>
              <Pair label={t("finding.lastSeen")}>
                <Ago at={error.lastSeenAt} now={now} />
              </Pair>
              <Pair label={t("errorDetail.route")}>{error.route ? <Code>{error.route}</Code> : "—"}</Pair>
              <Pair label={t("errorDetail.path")}>{error.url ? <Code>{error.url}</Code> : "—"}</Pair>
              <Pair label={t("errorDetail.release")}>{error.release ? <Code>{error.release}</Code> : "—"}</Pair>
              {error.resolvedAt ? (
                <Pair label={t("finding.closedBy")}>
                  {error.resolvedBy ?? "—"} · <When at={error.resolvedAt} />
                </Pair>
              ) : null}
            </div>
          </Section>
          <Section id="ops-error-incident" title={t("errorDetail.incident")}>
            {error.incident ? (
              <div className="adm-card gap-2">
                {error.incident.href ? (
                  <Link to={error.incident.href} className="adm-link type-strong">
                    <Code>{error.incident.ref}</Code>
                  </Link>
                ) : (
                  <Code className="type-strong">{error.incident.ref}</Code>
                )}
                {access.manageIncidents ? (
                  <div>
                    <Key size="sm" variant="ghost" onClick={() => setDialog("unlink")}>
                      {t("incident.unlink")}
                    </Key>
                  </div>
                ) : null}
              </div>
            ) : (
              <>
                <p className="type-body text-ink-2">{t("errorDetail.noIncident")}</p>
                {access.manageIncidents ? (
                  <div className="ops-actions">
                    <Key as={Link} size="sm" icon="first-aid-kit" to={`/admin/ops/incidents/new?error=${encodeURIComponent(error.id)}`}>
                      {t("finding.newIncident")}
                    </Key>
                    {openIncidents.length ? (
                      <Key size="sm" variant="ghost" icon="link" onClick={() => setDialog("link")}>
                        {t("finding.linkIncident")}
                      </Key>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </Section>
        </aside>
      </div>

      <ActionDialog
        open={statusDialog !== null}
        onClose={close}
        title={t(`errorList.statusTitle.${statusDialog ?? "resolved"}`, { count: 1 })}
        consequence={t(`errorList.statusConsequence.${statusDialog ?? "resolved"}`)}
        confirmLabel={t(statusDialog === "ignored" ? "errorList.bulk.ignore" : statusDialog === "open" ? "errorList.bulk.reopen" : "errorList.bulk.resolve")}
        reason={{ label: t("common.reason") }}
        fields={{ intent: "status", status: statusDialog ?? "resolved" }}
        successMessage={t("errorDetail.changed")}
      />
      <ActionDialog
        open={dialog === "link"}
        onClose={close}
        title={t("finding.linkIncident")}
        consequence={t("errorDetail.linkConsequence")}
        confirmLabel={t("confirm.link")}
        reason={{ label: t("consistency.note"), noteRequired: false, minLength: 0 }}
        fields={{ intent: "link", incidentId }}
        successMessage={t("finding.linked")}
      >
        <Select label={t("finding.incident")} value={incidentId} onChange={(event) => setIncidentId(event.target.value)} options={openIncidents.map((incident) => ({ value: incident.id, label: `${incident.ref} · ${incident.title}` }))} />
      </ActionDialog>
      <ActionDialog
        open={dialog === "unlink"}
        onClose={close}
        title={t("incident.unlinkTitle")}
        consequence={t("incident.unlinkConsequence", { label: error.message.slice(0, 80) })}
        confirmLabel={t("incident.unlink")}
        tone="destructive"
        reason={{ label: t("common.reason") }}
        fields={{ intent: "unlink", incidentId: error.incident?.id ?? "" }}
        successMessage={t("incident.unlinkedToast")}
      />
    </>
  );
}
