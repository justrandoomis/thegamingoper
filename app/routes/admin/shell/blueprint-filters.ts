/**
 * The /admin/blueprint filters, read from the URL (status, priority, module, q). Unknown values are dropped, so a
 * hand-edited URL can only narrow the list, never break the page. Pure; shared by the route and its tests.
 */
import { BLUEPRINT_STATUSES, type BlueprintStatus } from "../blueprint-status";
import { BLUEPRINT_MODULES, BLUEPRINT_PRIORITIES, type BlueprintPriority } from "./blueprint-catalog";

export type BlueprintFilters = { status: BlueprintStatus | null; priority: BlueprintPriority | null; module: string | null; q: string };

export function parseBlueprintFilters(search: URLSearchParams): BlueprintFilters {
  const status = search.get("status");
  const priority = search.get("priority");
  const module = search.get("module");
  return {
    status: (BLUEPRINT_STATUSES as readonly string[]).includes(status ?? "") ? (status as BlueprintStatus) : null,
    priority: (BLUEPRINT_PRIORITIES as readonly string[]).includes(priority ?? "") ? (priority as BlueprintPriority) : null,
    module: BLUEPRINT_MODULES.some((entry) => entry.id === module) ? module : null,
    q: (search.get("q") ?? "").slice(0, 80),
  };
}
