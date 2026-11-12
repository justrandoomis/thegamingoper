/**
 * GET /api/v1/:resource — the read-only API of module 21 (21.03), a resource route OUTSIDE the admin layout: it signs
 * nobody in and answers only to a scoped key (Authorization: Bearer ttk_…). Everything it does is in
 * app/server/services/admin/channels/api.server.ts (handleApiRequest); the reference is /admin/channels/api/docs.
 *
 * NOT REGISTERED YET: resource routes are registered in app/routes/api/_routes.ts, which the server core owns. The line
 * asked of its owner (docs/areas/admin-channels.md, "Requests"):
 *
 *   route("api/v1/:resource", "routes/admin/channels/api-v1.ts"),
 *
 * The file therefore types its arguments itself (no ./+types file exists for a route that is not registered).
 */
import type { RouterContextProvider } from "react-router";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { handleApiRequest } from "~/server/services/admin/channels/api.server";

type ApiArgs = { request: Request; context: Readonly<RouterContextProvider>; params: { resource?: string } };

export async function loader({ request, context, params }: ApiArgs): Promise<Response> {
  const ctx = getCtx(context);
  return handleApiRequest(getDb(), request, { ip: ctx.ip, requestId: ctx.requestId, now: ctx.now }, params.resource ?? "");
}

/** Writes are not part of the API: every other method is 405. */
export async function action({ request, context, params }: ApiArgs): Promise<Response> {
  const ctx = getCtx(context);
  return handleApiRequest(getDb(), request, { ip: ctx.ip, requestId: ctx.requestId, now: ctx.now }, params.resource ?? "");
}
