import { Link } from "react-router";

import type { Route } from "./+types/approvals";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { myRequests, staffDecisions, storeApprovals } from "~/server/services/admin/staff/approvals.server";
import { EmptyState } from "~/ui/EmptyState";
import { useAdminT } from "../shell/i18n";
import { loadWaiting } from "../shell/queues.server";
import { staffMeta } from "./meta";
import { openStaff } from "./staff.server";
import { ByName, Code, Note, PageHead, Section, When, tOr, useStaffT } from "./ui";

/**
 * /admin/staff/approvals — 15.06 one view of what waits for a decision, across modules. Decisions are never taken
 * here: each row opens the module's own screen (its permission, its two-person rule, its confirm dialog).
 *   waiting for you    the admin bell's own queues (shell/queues.server.ts — the same counts as the bell) and this
 *                      module's leave requests and payroll runs this employee may decide
 *   your requests      what this employee asked for that another person still has to decide
 *   across the store   (staff.approval.read) every pending request by kind — how many, the oldest, who asked, which
 *                      permission decides — never the request's amounts or prices
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, session, locale, now } = await openStaff(context);
  const [waiting, decisions, mine, store] = await Promise.all([loadWaiting(db, session, now), staffDecisions(db, actor), myRequests(db, actor), can(actor, "staff.approval.read") ? storeApprovals(db, actor, locale) : Promise.resolve(null)]);
  return { waiting, decisions, mine, store, now };
}

export const meta: Route.MetaFunction = (args) => staffMeta(args, "approvals.title");

const QUEUE_ICON: Record<string, IconName> = {
  proofs: "receipt",
  refunds: "arrow-u-up-left",
  failed_deliveries: "truck",
  cod_settlements: "coins",
  rmas: "arrow-u-up-left",
  inspections: "magnifying-glass",
  prices: "tag",
  counts: "package",
  transfers: "truck",
  po_approvals: "factory",
  stuck_receipts: "warning",
  invoice_mismatches: "scales",
  topups: "wallet",
  adjustments: "wallet",
  expenses: "receipt",
};

/** The bell's own words for a queue ("3 refunds awaiting your approval"); the queue's id and count for one it adds later. */
function queueLabel(text: string, id: string, count: number): string {
  return text === `notices.${id}` ? `${id} · ${count}` : text;
}

export default function ApprovalsPage({ loaderData }: Route.ComponentProps) {
  const t = useStaffT();
  const admin = useAdminT();
  const f = useFormat();
  const { waiting, decisions, mine, store, now } = loaderData;
  const moduleName = (module: string | null) => (module ? admin(`modules.${module}`) : t("approvals.otherModule"));
  const waitingCount = waiting.total + decisions.length;
  return (
    <>
      <PageHead title={t("approvals.title")} lead={t("approvals.lead")} />

      <Section id="waiting" title={t("approvals.waiting")} aside={<span className="type-caption text-ink-2">{t("common.countOf", { count: waitingCount })}</span>}>
        {waitingCount === 0 ? (
          <EmptyState title={t("approvals.nothing")} text={t("approvals.nothingHint")} icon="check-circle" />
        ) : (
          <ul role="list" className="adm-grid">
            {waiting.queues.map((queue) => (
              <li key={queue.id} className="adm-card adm-card--act">
                <div className="flex items-start gap-3">
                  <Icon name={QUEUE_ICON[queue.id] ?? "bell-ringing"} size={22} className="mt-1 shrink-0 text-ink-2" />
                  <div className="grid min-w-0 gap-1">
                    <p className="type-strong text-ink">{queueLabel(admin(`notices.${queue.id}`, { count: queue.count }), queue.id, queue.count)}</p>
                    <p className="type-caption text-ink-2">{moduleName(queue.module)}</p>
                    <Link to={queue.href} className="adm-link type-label">
                      {t("approvals.openDecide")}
                    </Link>
                  </div>
                </div>
              </li>
            ))}
            {decisions.map((item) => (
              <li key={`${item.kind}-${item.id}`} className="adm-card adm-card--act">
                <div className="flex items-start gap-3">
                  <Icon name={item.kind === "leave" ? "calendar-blank" : "money"} size={22} className="mt-1 shrink-0 text-ink-2" />
                  <div className="grid min-w-0 gap-1">
                    <p className="type-strong text-ink">{item.kind === "leave" ? t("approvals.leaveOf", { name: item.label }) : t("approvals.runOf", { ref: item.label })}</p>
                    <p className="type-caption text-ink-2">
                      {moduleName("staff")} · {f.relative(item.createdAt, now)}
                    </p>
                    <Link to={item.href} className="adm-link type-label">
                      {t("approvals.openDecide")}
                    </Link>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
        {waiting.notices.length ? (
          <Note icon="shield-check">
            {waiting.notices.map((notice) => (
              <p key={notice.id}>
                {notice.count !== undefined ? admin(`notices.${notice.id}`, { count: notice.count }) : admin(`notices.${notice.id}`)}{" "}
                <Link to={notice.href} className="adm-link">
                  {t("approvals.openNotice")}
                </Link>
              </p>
            ))}
          </Note>
        ) : null}
      </Section>

      <Section id="mine" title={t("approvals.mine")} aside={<span className="type-caption text-ink-2">{t("common.countOf", { count: mine.length })}</span>}>
        {mine.length ? (
          <ul role="list" className="grid gap-2">
            {mine.map((row) => (
              <li key={row.id} className="adm-card gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="type-label">{tOr(t, `approvalKind.${row.kind}`, row.kind.replace(/_/g, " "))}</span>
                  <span className="type-caption text-ink-2">
                    {moduleName(row.module)} · <When at={row.createdAt} />
                  </span>
                </div>
                {row.reason ? <p className="type-caption text-ink-2">{row.reason}</p> : null}
                {row.href ? (
                  <Link to={row.href} className="adm-link type-label">
                    {t("approvals.openRequest")}
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="type-body text-ink-2">{t("approvals.noRequests")}</p>
        )}
      </Section>

      {store ? (
        <Section id="store" title={t("approvals.store")}>
          {store.byKind.length === 0 && store.leavePending === 0 && store.runsAwaiting === 0 ? (
            <p className="type-body text-ink-2">{t("approvals.storeEmpty")}</p>
          ) : (
            <>
              <ul role="list" className="stf-kpis">
                {store.byKind.map((row) => (
                  <li key={row.kind} className="adm-card content-start gap-1">
                    <span className="type-caption text-ink-2">{moduleName(row.module)}</span>
                    <span className="type-label">{tOr(t, `approvalKind.${row.kind}`, row.kind.replace(/_/g, " "))}</span>
                    <span className="type-kpi nums">{f.number(row.count)}</span>
                    <span className="type-caption text-ink-2">{t("approvals.oldest", { age: f.relative(row.oldestAt, now) })}</span>
                    {row.href ? (
                      <Link to={row.href} className="adm-link type-label">
                        {t("approvals.openModule")}
                      </Link>
                    ) : null}
                  </li>
                ))}
                {store.leavePending ? (
                  <li className="adm-card content-start gap-1">
                    <span className="type-caption text-ink-2">{moduleName("staff")}</span>
                    <span className="type-label">{t("approvalKind.leave")}</span>
                    <span className="type-kpi nums">{f.number(store.leavePending)}</span>
                    <Link to="/admin/staff/leave" className="adm-link type-label">
                      {t("approvals.openModule")}
                    </Link>
                  </li>
                ) : null}
                {store.runsAwaiting ? (
                  <li className="adm-card content-start gap-1">
                    <span className="type-caption text-ink-2">{moduleName("staff")}</span>
                    <span className="type-label">{t("approvalKind.payroll_run")}</span>
                    <span className="type-kpi nums">{f.number(store.runsAwaiting)}</span>
                    <Link to="/admin/staff/payroll?status=draft" className="adm-link type-label">
                      {t("approvals.openModule")}
                    </Link>
                  </li>
                ) : null}
              </ul>
              {store.rows.length ? (
                <div className="adm-card">
                  <ul role="list" className="grid gap-2">
                    {store.rows.map((row) => (
                      <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line pb-2 last:border-b-0 last:pb-0">
                        <span className="inline-flex flex-wrap items-baseline gap-2">
                          <span className="type-label">{tOr(t, `approvalKind.${row.kind}`, row.kind.replace(/_/g, " "))}</span>
                          <span className="type-caption text-ink-2">
                            {t("approvals.askedBy")} <ByName by={row.requestedBy} />
                          </span>
                          {row.requiredPermission ? (
                            <span className="type-caption text-ink-2">
                              {t("approvals.decidedWith")} <Code>{row.requiredPermission}</Code>
                            </span>
                          ) : null}
                        </span>
                        <span className="inline-flex flex-wrap items-baseline gap-2 type-caption text-ink-2">
                          <When at={row.createdAt} />
                          {row.href ? (
                            <Link to={row.href} className="adm-link">
                              {t("approvals.openModule")}
                            </Link>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <p className="type-caption text-ink-2">{t("approvals.storeNote")}</p>
            </>
          )}
        </Section>
      ) : null}
      <Note>
        <p>{t("approvals.rules")}</p>
      </Note>
    </>
  );
}
