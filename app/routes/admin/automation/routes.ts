import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 19 — Automation and AI (docs/areas/admin-automation.md).
 * Paths are relative to "/admin" (inside the authenticated admin layout); route files live in routes/admin/automation/.
 * Static segments outrank dynamic ones, so /admin/automation/rules/new never reaches the rule page.
 *
 *   /admin/automation                          what waits, notices, figures, safeguards, limits, blueprint status (all)
 *   /admin/automation/rules                    rules: status, event, versions, runs; run the active rules now       19.01
 *   /admin/automation/rules/new                the builder: event + conditions + actions (a draft, v1)              19.01
 *   /admin/automation/rules/:ruleId            one rule: in words, dry run, switch on / pause, versions, runs        19.01 19.07 19.08
 *   /admin/automation/rules/:ruleId/edit       a new version (back to draft)                                         19.01
 *   /admin/automation/runs[/:runId]            the execution log and one run                                         19.01
 *   /admin/automation/suggestions              stock-out alerts with a suggested quantity; dismiss                  19.02
 *   /admin/automation/suggestions/order        suggestions → one draft purchase order of module 09                  19.02
 *   /admin/automation/forecast                 demand forecast by month, season and launches                        19.05
 *   /admin/automation/anomalies                unusual transactions and cost variances                              19.04
 *   /admin/automation/tickets                  ticket topics and canned replies by keyword rules                    19.03
 *   /admin/automation/assistant                the admin assistant's boundary                                        19.06
 */
export const automationAdminRoutes: RouteConfigEntry[] = [
  route("automation", "routes/admin/automation/layout.tsx", [
    index("routes/admin/automation/home.tsx"),
    route("rules", "routes/admin/automation/rules.tsx"),
    route("rules/new", "routes/admin/automation/rule-new.tsx"),
    route("rules/:ruleId", "routes/admin/automation/rule.tsx"),
    route("rules/:ruleId/edit", "routes/admin/automation/rule-edit.tsx"),
    route("runs", "routes/admin/automation/runs.tsx"),
    route("runs/:runId", "routes/admin/automation/run.tsx"),
    route("suggestions", "routes/admin/automation/suggestions.tsx"),
    route("suggestions/order", "routes/admin/automation/suggestion-order.tsx"),
    route("forecast", "routes/admin/automation/forecast.tsx"),
    route("anomalies", "routes/admin/automation/anomalies.tsx"),
    route("tickets", "routes/admin/automation/tickets.tsx"),
    route("assistant", "routes/admin/automation/assistant.tsx"),
  ]),
];
