/**
 * The audit trail of one record (a finding, an error report) as a flat timeline: who did what and when, the status it
 * moved to, who it was given to, and the reason they wrote (DESIGN.md §10 audit timeline: no edit or delete affordance —
 * the trail is immutable). Solid dots for people, hollow ones for the system.
 */
import type { HistoryEvent } from "~/server/services/admin/ops/types";
import { ActorName, When, tOr, useOpsT } from "./ui";

const str = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);

export function History({ events, empty }: { events: readonly HistoryEvent[]; empty: string }) {
  const t = useOpsT();
  if (events.length === 0) return <p className="type-body text-ink-2">{empty}</p>;
  return (
    <ol className="ops-timeline">
      {events.map((event) => {
        const after = (event.after ?? {}) as Record<string, unknown>;
        const status = str(after.status);
        const assignee = str(after.assignee);
        const due = str(after.dueDay);
        return (
          <li key={event.id} data-system={event.by?.kind === "system" ? "" : undefined}>
            <p className="type-label text-ink">
              {tOr(t, `history.${event.action}`, event.action)} · <ActorName by={event.by} />
            </p>
            <p className="type-caption text-ink-2">
              <When at={event.at} />
              {status ? ` · ${t("history.toStatus", { status: tOr(t, `finding.status.${status}`, tOr(t, `errorReport.status.${status}`, status)) })}` : ""}
              {assignee ? ` · ${t("history.toPerson", { name: assignee })}` : ""}
              {due ? ` · ${t("history.by", { day: due })}` : ""}
            </p>
            {event.reason ? <p className="ops-note type-body text-ink">{event.reason}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}
