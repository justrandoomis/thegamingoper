/**
 * 23.02 — server time of admin requests, recorded only when a request was SLOW or FAILED (one upsert in perf_rollups;
 * a fast request writes nothing). The operations module's layout runs it for its own pages; the shell owner is asked to
 * put it in the admin layout's middleware (after the gate) so every admin page is measured — a request is timed once
 * however many layouts carry it (the context flag below).
 *
 * The Worker's clock advances with I/O (database calls, fetches), not during pure computation, so the time measured is
 * the request's waiting time — what makes an admin page slow on D1 — not its CPU time (Cloudflare's metrics have that).
 */
import { createContext, type MiddlewareFunction } from "react-router";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { deviceOf, recordPerfSample } from "~/server/services/admin/ops/telemetry.server";
import { PERF_THRESHOLDS } from "~/server/services/admin/ops/types";

const timed = createContext<boolean>(false);

/** The browser's own report endpoint is not a page: timing it would only measure the recording itself. */
const NOT_A_PAGE = /\/ops\/report\/?$/;

export const opsTimingMiddleware: MiddlewareFunction<Response> = async ({ request, context, pattern }, next) => {
  if (context.get(timed) || NOT_A_PAGE.test(pattern)) return next();
  context.set(timed, true);
  const started = Date.now();
  const response = await next();
  const ms = Math.max(0, Date.now() - started);
  if (response.status >= 500 || ms >= PERF_THRESHOLDS.server.slowMs) {
    try {
      const ctx = getCtx(context);
      await recordPerfSample(getDb(), { area: "admin", route: pattern, kind: "server", ms, status: response.status, device: deviceOf(ctx.userAgent ?? request.headers.get("user-agent")) }, Date.now());
    } catch (error) {
      console.error("[ops] a slow request was not recorded", error);
    }
  }
  return response;
};
