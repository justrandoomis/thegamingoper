/**
 * GET /api/health — is the Worker up, and can it reach a migrated database?
 *
 *   200 { "ok": true,  "time": "2026-11-10T06:00:00.000Z", "db": true }
 *   503 { "ok": false, "time": "…",                          "db": false }
 *
 * For uptime monitors and deploy checks. It answers with booleans only: no version, no error text,
 * no table names — nothing a stranger could learn from.
 */
import type { Route } from "./+types/health";
import { getDb } from "~/server/db.server";

export async function loader(_: Route.LoaderArgs) {
  let db = false;
  try {
    // Reads one row of a table every migrated database has: proves the binding, the schema and a read.
    await getDb().$client.prepare("SELECT 1 FROM settings LIMIT 1").first();
    db = true;
  } catch {
    db = false;
  }
  return Response.json(
    { ok: db, time: new Date().toISOString(), db },
    { status: db ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
