import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 23 — Technical operations (docs/areas/admin-ops.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/ops/.
 * Static segments outrank dynamic ones, so /admin/ops/incidents/new never reaches the incident page.
 *
 *   /admin/ops                          what waits for a person, figures, honest limits, blueprint status        (all)
 *   /admin/ops/jobs                     every scheduled job: cron, next run, health, last run; the run history   23.03
 *   /admin/ops/jobs/:job                one job: what a run now would touch, its runs, run now                   23.03
 *   /admin/ops/jobs/runs/:runId         one run: counters, error, incidents                                      23.03
 *   /admin/ops/outbox                   the message queue: held, queued, sent, failed                           23.03
 *   /admin/ops/consistency              the daily consistency findings: give to a person, close with a reason   23.06
 *   /admin/ops/consistency/:findingId   one finding: explanation, record, numbers, history                       23.06
 *   /admin/ops/incidents                the incident centre                                                      23.05
 *   /admin/ops/incidents/new            open an incident (owner, target date, links)                            23.05
 *   /admin/ops/incidents/:ref           one incident: timeline, links, resolve with the post-mortem, print       23.05
 *   /admin/ops/errors[/:errorId]        errors the app recorded; where Cloudflare keeps the rest                 23.01
 *   /admin/ops/performance              slow and failed requests and page loads; Cloudflare for the totals       23.02
 *   /admin/ops/backups                  restore-test evidence (module 20), the audit seal, what Cloudflare keeps 23.04
 *   /admin/ops/report                   POST: a browser's error or slow load (resource route)                    23.01 23.02
 */
export const opsAdminRoutes: RouteConfigEntry[] = [
  route("ops", "routes/admin/ops/layout.tsx", [
    index("routes/admin/ops/home.tsx"),
    route("jobs", "routes/admin/ops/jobs.tsx"),
    route("jobs/runs/:runId", "routes/admin/ops/job-run.tsx"),
    route("jobs/:job", "routes/admin/ops/job.tsx"),
    route("outbox", "routes/admin/ops/outbox.tsx"),
    route("consistency", "routes/admin/ops/consistency.tsx"),
    route("consistency/:findingId", "routes/admin/ops/finding.tsx"),
    route("incidents", "routes/admin/ops/incidents.tsx"),
    route("incidents/new", "routes/admin/ops/incident-new.tsx"),
    route("incidents/:ref", "routes/admin/ops/incident.tsx"),
    route("errors", "routes/admin/ops/errors.tsx"),
    route("errors/:errorId", "routes/admin/ops/error.tsx"),
    route("performance", "routes/admin/ops/performance.tsx"),
    route("backups", "routes/admin/ops/backups.tsx"),
    route("report", "routes/admin/ops/report.ts"),
  ]),
];
