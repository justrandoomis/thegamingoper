import { createRequestHandler } from "react-router";
import { edgeCacheable, withEdgeCache } from "./edge-cache";

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

let buildVersion: Promise<string> | null = null;
/** The build's asset version: part of the edge-cache key, so a deploy never serves the previous build's pages. */
function version(): Promise<string> {
  buildVersion ??= import("virtual:react-router/server-build").then((build) => build.assets.version);
  return buildVersion;
}

export default {
  async fetch(request, env, ctx) {
    // Anonymous browsing pages come from the colo's cache when they can (workers/edge-cache.ts).
    if (import.meta.env.PROD && (env as { EDGE_CACHE?: string }).EDGE_CACHE !== "off" && edgeCacheable(request)) {
      return withEdgeCache(request, ctx, await version(), (req) => requestHandler(req));
    }
    return requestHandler(request);
  },

  /**
   * Cron triggers (wrangler.jsonc "triggers.crons") run the jobs in app/server/jobs.server.ts:
   * "*\/5 * * * *" expires unpaid transfer orders and stale reservations and delivers the outbox;
   * "30 0 * * *" seals the audit chain, cleans rate limits, applies retention and runs the daily
   * consistency checks. Every run is recorded in `job_runs`.
   *
   * The audit seal's head hash is written to the Workers logs here, outside the database: that copy
   * is what lets a later check prove the audit chain was not rewritten.
   *
   * Local test: curl "http://localhost:5173/cdn-cgi/handler/scheduled?cron=*%2F5+*+*+*+*"
   */
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const [{ getDb }, { runScheduledJobs }] = await Promise.all([import("~/server/db.server"), import("~/server/jobs.server")]);
        const run = await runScheduledJobs(getDb(), controller.cron, controller.scheduledTime, env);
        if (run.audit?.headHash) {
          console.log(JSON.stringify({ event: "audit_seal", headHash: run.audit.headHash, lastSealedSeq: run.audit.lastSealedSeq, seals: run.audit.seals, events: run.audit.events }));
        }
        const failed = run.jobs.filter((job) => job.status === "failed");
        if (!run.ok) {
          console.error(JSON.stringify({ event: "scheduled_jobs_failed", cron: run.cron, jobs: failed.length ? failed : run.jobs }));
        } else {
          console.log(JSON.stringify({ event: "scheduled_jobs", cron: run.cron, jobs: run.jobs.map((job) => ({ job: job.job, status: job.status, ms: job.durationMs })) }));
        }
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
