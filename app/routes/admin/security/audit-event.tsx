import { Link } from "react-router";
import { useFormat } from "~/i18n/react";

import type { Route } from "./+types/audit-event";
import { getAuditEvent } from "~/server/services/admin/security/audit-log.server";
import { Status } from "~/ui/Tag";
import { Code, Note, PageHead, Pair, Section, When, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { sec } from "./security.server";

/**
 * /admin/security/audit/:eventId — one event of the trail: who (and from which address and request), what, which
 * record, why, and the state before and after as stored (secrets were redacted and phone numbers masked when it was
 * written; cost and margin are left out here for employees without cost.read / profit.read), whether it is sealed yet,
 * and the other events of the same request. Read-only by nature: the database refuses edits and deletions.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor } = await sec.open(context, "audit.read");
  return { event: await sec.orRespond(() => getAuditEvent(db, actor, params.eventId)) };
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "event.title");

function Snapshot({ value }: { value: unknown }) {
  const t = useModuleT();
  if (value === null || value === undefined) return <p className="type-caption text-ink-2">—</p>;
  if (typeof value !== "object" || Array.isArray(value)) return <pre className="sec-pre" dir="ltr">{JSON.stringify(value, null, 2)}</pre>;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return <p className="type-caption text-ink-2">{t("event.emptySnapshot")}</p>;
  return (
    <dl className="sec-kv type-data">
      {entries.map(([key, item]) => (
        <div key={key} className="contents">
          <dt>
            <Code>{key}</Code>
          </dt>
          <dd>{item !== null && typeof item === "object" ? <pre className="sec-pre" dir="ltr">{JSON.stringify(item, null, 2)}</pre> : <bdi dir="auto">{String(item)}</bdi>}</dd>
        </div>
      ))}
    </dl>
  );
}

export default function AuditEventPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { event } = loaderData;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/security/audit" className="adm-link">
            {t("audit.title")}
          </Link>
        }
        title={t("event.heading", { seq: f.number(event.seq) })}
        lead={
          <>
            <Code>{event.action}</Code>
            {event.summary ? <> · {event.summary}</> : null}
          </>
        }
      />
      <div className="sec-split mt-5">
        <div className="grid min-w-0 gap-5">
          {event.withheld ? (
            <Note icon="lock">
              <p>{t("event.withheld")}</p>
            </Note>
          ) : (
            <>
              <Section id="before" title={t("event.before")}>
                <Snapshot value={event.before} />
              </Section>
              <Section id="after" title={t("event.after")}>
                <Snapshot value={event.after} />
              </Section>
            </>
          )}
          {event.sameRequest.length ? (
            <Section id="same" title={t("event.sameRequest")}>
              <ul role="list" className="grid gap-1">
                {event.sameRequest.map((row) => (
                  <li key={row.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                    <Link to={`/admin/security/audit/${row.id}`} className="adm-link">
                      <Code>{row.action}</Code>
                    </Link>
                    <span className="type-caption text-ink-2">
                      <Code>{`${row.entityType ?? ""} ${row.entityId ?? ""}`}</Code>
                    </span>
                  </li>
                ))}
              </ul>
            </Section>
          ) : null}
        </div>
        <aside className="grid min-w-0 gap-3">
          <div className="adm-card gap-1.5">
            <Pair label={t("audit.col.at")}>
              <When at={event.at} />
            </Pair>
            <Pair label={t("audit.col.who")}>{event.actorKind === "system" ? t("audit.system", { job: event.actorLabel ?? "" }) : (event.actorLabel ?? "—")}</Pair>
            <Pair label={t("event.actorKind")}>{t(`event.kind.${event.actorKind}`)}</Pair>
            <Pair label={t("audit.col.record")}>
              <Code>{`${event.entityType ?? "—"} ${event.entityId ?? ""}`}</Code>
            </Pair>
            <Pair label={t("event.ip")}>{event.ip ? <Code>{event.ip}</Code> : "—"}</Pair>
            <Pair label={t("event.request")}>{event.requestId ? <Code>{event.requestId}</Code> : "—"}</Pair>
            <Pair label={t("event.seq")}>
              <Code>#{event.seq}</Code>
            </Pair>
            <Pair label={t("event.sealed")}>
              <Status tone={event.sealed ? "ok" : "neutral"}>{event.sealed ? t("event.isSealed") : t("event.notSealed")}</Status>
            </Pair>
          </div>
          {event.reason ? (
            <div className="adm-card gap-1">
              <span className="type-caption text-ink-2">{t("audit.col.reason")}</span>
              <p className="type-body">{event.reason}</p>
            </div>
          ) : null}
          {event.entityType && event.entityId ? (
            <Link to={`/admin/security/audit?type=${encodeURIComponent(event.entityType)}&entity=${encodeURIComponent(event.entityId)}`} className="adm-link type-label">
              {t("event.recordHistory")}
            </Link>
          ) : null}
        </aside>
      </div>
    </>
  );
}
