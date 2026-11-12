import * as workers from "cloudflare:workers";
import type { EntryContext, HandleErrorFunction, Params, RouterContextProvider } from "react-router";
import { isRouteErrorResponse, ServerRouter } from "react-router";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import { NonceContext } from "~/lib/nonce";
import { pagePathname, peekCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { recordError } from "~/server/services/admin/ops/telemetry.server";

export const streamTimeout = 5_000;

// ───────────────────────────────────────────────────────────────── server errors → operations (23.01)

/** A thrown Response or `data()` is the app answering on purpose (a 403, a 404, a redirect): not an error to record. */
function isAnswer(error: unknown): boolean {
  if (error instanceof Response || isRouteErrorResponse(error)) return true;
  return typeof error === "object" && error !== null && (error as { type?: unknown }).type === "DataWithResponseInit";
}

const decodeSegment = (segment: string): string => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/**
 * "/admin/ops/consistency/cfd_123" + { findingId: "cfd_123" } → "/admin/ops/consistency/:findingId" (never the ids). A
 * splat route's rest of the address is "*" ("/admin/no/such/page" + { "*": "no/such/page" } → "/admin/*"): the error
 * log groups by route pattern, so one broken catch-all is one row — not one row per address a crawler tried.
 */
export function routePatternOf(pathname: string, params: Params): string {
  const named = Object.entries(params).filter((entry): entry is [string, string] => entry[0] !== "*" && typeof entry[1] === "string" && entry[1] !== "");
  const segments = pathname.split("/");
  // a trailing slash is no segment of its own
  while (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
  // The splat is always the end of the address: as many segments as, decoded, spell its value (an encoded "/" inside
  // a segment included), else as many as it has parts.
  const splat = typeof params["*"] === "string" ? params["*"].replace(/\/+$/, "") : "";
  let cut = 0;
  if (splat) {
    for (let take = 1; take < segments.length && !cut; take++) if (segments.slice(-take).map(decodeSegment).join("/") === splat) cut = take;
    if (!cut) cut = Math.min(splat.split("/").filter(Boolean).length, segments.length - 1);
  }
  const head = (cut ? segments.slice(0, segments.length - cut) : segments).map((segment) => {
    const decoded = decodeSegment(segment);
    const hit = named.find(([, value]) => value === decoded || value === segment);
    return hit ? `:${hit[0]}` : segment;
  });
  return [...head, ...(cut ? ["*"] : [])].join("/") || "/";
}

/** The bound values of a failed query, as Drizzle writes them after its SQL (up to the stack's first frame). */
const QUERY_PARAMS = /\nparams: [\s\S]*?(?=\n\s+at |$)/;

/**
 * What of an error is kept: its message and stack — never a failed query's bound values. Drizzle's DrizzleQueryError
 * reads "Failed query: <sql>\nparams: <values>", and the stack's first lines repeat it: the values are the rows being
 * written or looked for (names, addresses, notes, hashes), so the record keeps the SQL (placeholders only) and the
 * database's own reason (the error's cause) instead; any other error's "params:" part is withheld too. The stack is
 * rebuilt from that message and its frames (review 2026-11-12).
 */
export function describeServerError(error: unknown): { message: string; stack?: string } {
  if (!(error instanceof Error)) return { message: String(error) };
  const { query, params } = error as { query?: unknown; params?: unknown };
  const cause = error.cause instanceof Error ? `${error.cause.name}: ${error.cause.message}`.replace(QUERY_PARAMS, "\nparams: [withheld]") : null;
  // the database's reason first: the recorder keeps the first 500 characters, and an INSERT's SQL alone can be longer
  const message =
    typeof query === "string" && Array.isArray(params)
      ? `DrizzleQueryError: ${cause ?? "the query failed"}\nFailed query: ${query}`
      : `${error.name}: ${error.message}`.replace(QUERY_PARAMS, "\nparams: [withheld]");
  const frames = error.stack ? error.stack.split("\n").filter((line) => /^\s+at /.test(line)) : [];
  return { message, stack: error.stack ? [message, ...frames].join("\n") : undefined };
}

/**
 * One server error, recorded by the operations module's recorder (scrubbed, grouped by fingerprint, one upsert, within
 * the isolate's write budget — telemetry.server.ts recordError): the message and stack (describeServerError: never a
 * failed query's values), the route pattern, the page path (no query), the request id and whether a loader or an
 * action failed. Never throws for a report it cannot write.
 */
export function recordServerError(error: unknown, args: { request: Request; params: Params; context: Readonly<RouterContextProvider> }, now = Date.now()): Promise<unknown> {
  const notRecorded = (failure: unknown) => console.error("[ops] a server error was not recorded", failure);
  try {
    const url = new URL(args.request.url);
    const path = pagePathname(url.pathname);
    const { message, stack } = describeServerError(error);
    const method = args.request.method.toUpperCase();
    return recordError(
      getDb(),
      {
        source: "server",
        level: "error",
        message: message.slice(0, 20_000) || "(no message)",
        stack: stack ? stack.slice(0, 50_000) : undefined,
        route: routePatternOf(path, args.params),
        url: path,
        sample: { requestId: peekCtx(args.context)?.requestId ?? undefined, status: 500, phase: method === "GET" || method === "HEAD" ? "loader" : "action" },
      },
      now,
    ).catch(notRecorded);
  } catch (failure) {
    // even a report that cannot be started (no database binding) never turns into a second error
    notRecorded(failure);
    return Promise.resolve();
  }
}

/**
 * React Router calls this for every error it catches on the server (a loader, an action or a middleware that threw).
 * Logged as before, and recorded for the operations module (23.01) AFTER the response, inside the Worker's
 * `waitUntil` (`cloudflare:workers`): the answer never waits for the report, and a report that fails is only logged.
 * Skipped: requests the browser aborted (navigations it gave up) and thrown Responses / `data()` (the app's own 4xx).
 */
export const handleError: HandleErrorFunction = (error, { request, params, context }) => {
  if (request.signal.aborted || isAnswer(error)) return;
  console.error(error);
  const report = recordServerError(error, { request, params, context });
  const waitUntil = (workers as { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil;
  if (typeof waitUntil === "function") waitUntil(report);
};

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext: RouterContextProvider,
) {
  // https://httpwg.org/specs/rfc9110.html#HEAD
  if (request.method.toUpperCase() === "HEAD") {
    return new Response(null, { status: responseStatusCode, headers: responseHeaders });
  }

  // The CSP nonce is created by the root middleware; every inline script React Router emits carries it.
  const nonce = peekCtx(loadContext)?.nonce;
  let shellRendered = false;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    // NonceContext: the root Layout needs the nonce even when no loader ran (a refusal thrown in middleware).
    <NonceContext.Provider value={nonce}>
      <ServerRouter context={routerContext} url={request.url} nonce={nonce} />
    </NonceContext.Provider>,
    {
      nonce,
      signal: AbortSignal.timeout(streamTimeout + 1000),
      onError(error: unknown) {
        responseStatusCode = 500;
        // Errors during the initial shell reject the promise and are logged by React Router;
        // only streaming errors need logging here.
        if (shellRendered) console.error(error);
      },
    },
  );
  shellRendered = true;

  // Crawlers get the complete document rather than a streamed shell.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html; charset=utf-8");
  return new Response(body, { headers: responseHeaders, status: responseStatusCode });
}
