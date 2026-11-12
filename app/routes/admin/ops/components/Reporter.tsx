/**
 * 23.01 / 23.02 in the browser — reports, at most a few times per page: a script error or an unhandled rejection
 * (message, stack, the page's route pattern and path — the server scrubs them again), a full page load that was slow
 * (navigation timing) and a client-side navigation that was slow. Fast loads send nothing. Mounted by the operations
 * module's layout (its own pages); the shell owner is asked to mount it in the admin shell for every page — a second
 * instance does nothing (one per window).
 *
 * Posts JSON to /admin/ops/report with `keepalive`, never waits for an answer, never retries, and stays silent when
 * the request fails (a report must never become a second error).
 */
import { useEffect, useRef } from "react";
import { useMatches, useNavigation, type UIMatch } from "react-router";
import { PERF_THRESHOLDS } from "~/server/services/admin/ops/types";

export const REPORT_PATH = "/admin/ops/report";
const MAX_ERRORS = 5;
const MAX_TIMINGS = 5;

type Report =
  | { kind: "error"; message: string; stack?: string; route: string; url: string; phase: "error" | "rejection" }
  | { kind: "timing"; phase: "load" | "nav"; ms: number; route: string };

/** The instance that reports (the first one mounted); any other instance stays silent. */
let owner: object | null = null;
let errors = 0;
let loadMeasured = false;
let timings = 0;
const seen = new Set<string>();
/** The dev server's hot-reload messages ("[vite] …", "[react-router:hmr] …") exist only in development: not app errors. */
const DEV_NOISE = /\[(vite|hmr|react-router:hmr)\]/;

function send(report: Report): void {
  try {
    void fetch(REPORT_PATH, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report), credentials: "same-origin", keepalive: true }).catch(() => undefined);
  } catch {
    // a report must never become a second error
  }
}

/** The route pattern of the deepest match: "/admin/ops/consistency/:findingId" (never the ids themselves). */
export function patternOf(matches: readonly Pick<UIMatch, "pathname" | "params">[], fallback: string): string {
  const last = matches[matches.length - 1];
  if (!last) return fallback;
  const params = Object.entries(last.params ?? {}).filter(([, value]) => typeof value === "string" && value !== "") as [string, string][];
  const segments = last.pathname.split("/").map((segment) => {
    let decoded = segment;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // keep it as it is
    }
    const hit = params.find(([, value]) => value === decoded || value === segment);
    return hit ? (hit[0] === "*" ? "*" : `:${hit[0]}`) : segment;
  });
  return segments.join("/") || "/";
}

export function OpsReporter() {
  const matches = useMatches();
  const navigation = useNavigation();
  const route = useRef("/");
  route.current = patternOf(matches, typeof window === "undefined" ? "/" : window.location.pathname);
  const started = useRef<number | null>(null);
  const self = useRef<object>({});

  useEffect(() => {
    const me = self.current;
    /** Only one instance reports; the first to need it claims the role, and gives it back when it unmounts. */
    const speaks = () => {
      if (owner === null) owner = me;
      return owner === me;
    };
    const onError = (event: ErrorEvent) => {
      if (!speaks()) return;
      const message = String(event.message || (event.error instanceof Error ? event.error.message : "") || "Script error").slice(0, 2000);
      if (errors >= MAX_ERRORS || seen.has(message) || DEV_NOISE.test(message)) return;
      seen.add(message);
      errors++;
      send({ kind: "error", phase: "error", message, stack: event.error instanceof Error ? event.error.stack?.slice(0, 8000) : undefined, route: route.current, url: window.location.pathname });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      if (!speaks()) return;
      const reason = event.reason;
      const message = String(reason instanceof Error ? `${reason.name}: ${reason.message}` : reason).slice(0, 2000);
      if (errors >= MAX_ERRORS || seen.has(message) || DEV_NOISE.test(message)) return;
      seen.add(message);
      errors++;
      send({ kind: "error", phase: "rejection", message, stack: reason instanceof Error ? reason.stack?.slice(0, 8000) : undefined, route: route.current, url: window.location.pathname });
    };
    const measureLoad = () => {
      if (!speaks() || loadMeasured) return;
      const [entry] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
      if (!entry || entry.loadEventEnd <= 0) return;
      loadMeasured = true;
      const ms = Math.round(entry.loadEventEnd - entry.startTime);
      if (ms >= PERF_THRESHOLDS.load.slowMs && timings < MAX_TIMINGS) {
        timings++;
        send({ kind: "timing", phase: "load", ms, route: route.current });
      }
    };
    const onLoad = () => window.setTimeout(measureLoad, 0);
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    if (document.readyState === "complete") onLoad();
    else window.addEventListener("load", onLoad, { once: true });
    return () => {
      if (owner === me) owner = null;
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("load", onLoad);
    };
  }, []);

  useEffect(() => {
    if (navigation.state === "loading" && started.current === null) started.current = performance.now();
    if (navigation.state === "idle" && started.current !== null) {
      const ms = Math.round(performance.now() - started.current);
      started.current = null;
      if (owner === null) owner = self.current;
      if (ms >= PERF_THRESHOLDS.nav.slowMs && timings < MAX_TIMINGS && owner === self.current) {
        timings++;
        send({ kind: "timing", phase: "nav", ms, route: route.current });
      }
    }
  }, [navigation.state]);

  return null;
}
