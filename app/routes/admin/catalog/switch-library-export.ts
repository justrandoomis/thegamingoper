import type { Route } from "./+types/switch-library-export";
import { exportLibraryCsv, SWITCH_LIBRARY_MANAGE } from "~/server/services/admin/switch-library.server";
import { catalogRequest } from "./catalog.server";
import { baghdadDay } from "./switch-library-input";

/**
 * GET /admin/catalog/switch-library/export — the CSV download of TamTam's library data (catalog.switch_library.manage):
 * every game TamTam has data for, in the import's columns, so export → edit → import changes only what was edited
 * (plus the read-only picture path and last change). Audited by the service. Never cached.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await catalogRequest(context, SWITCH_LIBRARY_MANAGE);
  const { csv } = await exportLibraryCsv(db, actor, now);
  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="tamtam-switch-library-${baghdadDay(now)}.csv"`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
