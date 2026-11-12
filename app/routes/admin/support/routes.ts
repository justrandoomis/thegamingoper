import { index, route, type RouteConfigEntry } from "@react-router/dev/routes";

/**
 * Admin module 14 — Customer service (docs/areas/admin-support.md). Paths are relative to "/admin" (inside the
 * authenticated admin layout); route files live in routes/admin/support/. Static segments outrank the parameters.
 *
 *   /admin/support                     the unified inbox (tickets, assistant hand-offs, repair requests), queues   14.01 14.07
 *   /admin/support/new                 a ticket for a call, a message or a visit                                 14.01 14.02
 *   /admin/support/tickets/:ref        one ticket: conversation, replies, links, holder, SLA, escalation         14.02 14.03 14.04 14.07
 *   /admin/support/repairs/:ref        a repair request as support sees it (the work is module 12's)             14.01
 *   /admin/support/routing             routing rules by topic, priority and capacity; agents' load              14.03
 *   /admin/support/sla                 SLA policies and the due times they give                                  14.05
 *   /admin/support/replies             canned replies with safe variables                                         14.04
 *   /admin/support/knowledge           the knowledge base: internal articles and the help centre's guides        14.06
 *   /admin/support/knowledge/:id       one article (or "new"): preview, editor, review workflow                  14.06
 *   /admin/support/metrics             first response, resolution, backlog, satisfaction (when collected)        14.05
 *   /admin/support/files/:fileId       a private photo of a ticket or a repair request                           (SECURITY §9)
 */
export const supportAdminRoutes: RouteConfigEntry[] = [
  route("support", "routes/admin/support/layout.tsx", [
    index("routes/admin/support/index.tsx"),
    route("new", "routes/admin/support/new.tsx"),
    route("tickets/:ref", "routes/admin/support/ticket.tsx"),
    route("repairs/:ref", "routes/admin/support/repair.tsx"),
    route("routing", "routes/admin/support/routing.tsx"),
    route("sla", "routes/admin/support/sla.tsx"),
    route("replies", "routes/admin/support/replies.tsx"),
    route("knowledge", "routes/admin/support/knowledge.tsx"),
    route("knowledge/:id", "routes/admin/support/article.tsx"),
    route("metrics", "routes/admin/support/metrics.tsx"),
    route("files/:fileId", "routes/admin/support/file.ts"),
  ]),
];
