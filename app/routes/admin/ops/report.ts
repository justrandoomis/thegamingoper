import { z } from "zod";

import type { Route } from "./+types/report";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { limitKey, rateLimit } from "~/server/ratelimit.server";
import { deviceOf, recordError, recordPerfSample } from "~/server/services/admin/ops/telemetry.server";
import { TELEMETRY_RATE } from "~/server/services/admin/ops/types";

/**
 * POST /admin/ops/report — what an admin page's browser reports (components/Reporter.tsx): a script error, or a page
 * load / navigation that was slow. Any signed-in employee may report their own browser's problem (no permission: it
 * reads nothing and only writes a scrubbed, grouped row); until the shell's gate has a rule for this path, only
 * employees who can open the operations module reach it. A body above 16 KB is refused (413), more than
 * TELEMETRY_RATE per employee (429, nothing stored), anything malformed (400). Answers 204 with no body.
 */
const MAX_BODY = 16 * 1024;

const Body = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("error"), phase: z.enum(["error", "rejection"]).optional(), message: z.string().min(1).max(4000), stack: z.string().max(10_000).optional(), route: z.string().max(400), url: z.string().max(2000) }),
  z.object({ kind: z.literal("timing"), phase: z.enum(["load", "nav"]), ms: z.number().int().min(0).max(10 * 60 * 1000), route: z.string().max(400) }),
]);

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY) return new Response(null, { status: 413 });
  const text = await request.text();
  if (text.length > MAX_BODY) return new Response(null, { status: 413 });
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new Response(null, { status: 400 });
  }
  const parsed = Body.safeParse(raw);
  if (!parsed.success) return new Response(null, { status: 400 });
  const verdict = await rateLimit(db, await limitKey("ops_report", "employee", session.actor.id), TELEMETRY_RATE, ctx.now);
  if (!verdict.ok) return new Response(null, { status: 429, headers: { "Retry-After": String(verdict.retryAfterSec) } });
  const report = parsed.data;
  const device = deviceOf(ctx.userAgent);
  if (report.kind === "error") {
    await recordError(db, { source: "client", level: "error", message: report.message, stack: report.stack, route: report.route, url: report.url, sample: { requestId: ctx.requestId, device, actorKind: "employee", phase: report.phase } }, ctx.now);
  } else {
    await recordPerfSample(db, { area: "admin", route: report.route, kind: report.phase, ms: report.ms, device }, ctx.now);
  }
  return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
}
