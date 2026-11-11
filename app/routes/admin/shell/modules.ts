/**
 * The 23 admin modules as the shell knows them: URL slug (= folder under app/routes/admin = permission group in
 * ~/server/permissions), blueprint id, icon and navigation group. Client-safe and small — the permission catalogue
 * itself stays on the server (shell/access.server.ts decides which modules an employee may see).
 *
 *   /admin/<slug>          the module's home (its own route once built, the shell's landing page until then)
 *   /admin                 module 01 (the command center) is the admin home, not /admin/dashboard
 *
 * Navigation (docs/DESIGN.md §10, blueprint UX rule "at most 8 top-level groups"): the command center on top, then
 * six caption-headed groups ordered by priority (P0 first), modules inside a group P0 first, then by number.
 */
import type { IconName } from "~/art/Icon";
import { BLUEPRINT_MODULES, type BlueprintPriority } from "./blueprint-catalog";

export const ADMIN_MODULE_SLUGS = [
  "dashboard",
  "catalog",
  "pricing",
  "inventory",
  "orders",
  "pos",
  "customers",
  "promotions",
  "purchasing",
  "finance",
  "shipping",
  "returns",
  "devices",
  "support",
  "staff",
  "marketing",
  "cms",
  "reports",
  "automation",
  "security",
  "channels",
  "settings",
  "ops",
] as const;

export type AdminModuleSlug = (typeof ADMIN_MODULE_SLUGS)[number];

export const NAV_GROUPS = ["sales", "stock", "money", "team", "system", "growth"] as const;
export type NavGroupKey = (typeof NAV_GROUPS)[number];

export type AdminModule = {
  slug: AdminModuleSlug;
  /** Blueprint module id, "01" … "23". */
  id: string;
  priority: BlueprintPriority;
  icon: IconName;
  /** Null for the command center, which sits above the groups. */
  group: NavGroupKey | null;
  /** The module's home in the admin. */
  href: string;
};

const ICONS: Record<AdminModuleSlug, IconName> = {
  dashboard: "squares-four",
  catalog: "game-controller",
  pricing: "tag",
  inventory: "package",
  orders: "receipt",
  pos: "storefront",
  customers: "users",
  promotions: "percent",
  purchasing: "factory",
  finance: "bank",
  shipping: "truck",
  returns: "arrow-u-up-left",
  devices: "recycle",
  support: "lifebuoy",
  staff: "user-gear",
  marketing: "trend-up",
  cms: "file-text",
  reports: "chart-bar",
  automation: "robot",
  security: "shield-check",
  channels: "plugs-connected",
  settings: "gear",
  ops: "pulse",
};

const GROUP_OF: Record<AdminModuleSlug, NavGroupKey | null> = {
  dashboard: null,
  orders: "sales",
  shipping: "sales",
  returns: "sales",
  customers: "sales",
  pos: "sales",
  support: "sales",
  catalog: "stock",
  pricing: "stock",
  inventory: "stock",
  devices: "stock",
  purchasing: "stock",
  finance: "money",
  reports: "money",
  security: "team",
  staff: "team",
  settings: "system",
  channels: "system",
  ops: "system",
  automation: "system",
  promotions: "growth",
  marketing: "growth",
  cms: "growth",
};

const PRIORITY_RANK: Record<BlueprintPriority, number> = { P0: 0, P1: 1, P2: 2 };

/** Every module in blueprint order (01 … 23). */
export const ADMIN_MODULES: readonly AdminModule[] = ADMIN_MODULE_SLUGS.map((slug, index) => {
  const blueprint = BLUEPRINT_MODULES[index];
  return {
    slug,
    id: blueprint.id,
    priority: blueprint.priority,
    icon: ICONS[slug],
    group: GROUP_OF[slug],
    href: slug === "dashboard" ? "/admin" : `/admin/${slug}`,
  };
});

const BY_SLUG = new Map(ADMIN_MODULES.map((module) => [module.slug as string, module]));
const BY_ID = new Map(ADMIN_MODULES.map((module) => [module.id, module]));

export function isAdminModuleSlug(value: unknown): value is AdminModuleSlug {
  return typeof value === "string" && BY_SLUG.has(value);
}

export function moduleBySlug(slug: string): AdminModule | undefined {
  return BY_SLUG.get(slug);
}

export function moduleById(id: string): AdminModule | undefined {
  return BY_ID.get(id);
}

/** Sort key inside a group: P0 first, then blueprint number. */
export function compareModules(a: AdminModule, b: AdminModule): number {
  return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id.localeCompare(b.id);
}

export type NavGroup = { key: NavGroupKey; modules: AdminModule[] };

/**
 * The navigation for a set of visible modules: the groups in NAV_GROUPS order (empty groups dropped), modules inside
 * each group P0 first. The command center is not in a group — the shell shows it on top.
 */
export function navGroupsFor(visible: Iterable<string>): NavGroup[] {
  const allowed = new Set(visible);
  return NAV_GROUPS.map((key) => ({
    key,
    modules: ADMIN_MODULES.filter((module) => module.group === key && allowed.has(module.slug)).sort(compareModules),
  })).filter((group) => group.modules.length > 0);
}

/**
 * The module an admin pathname belongs to ("/admin/orders/TT-1" → orders, "/admin" → dashboard), or null for the
 * shell's own pages (/admin/me, /admin/blueprint) and anything else. For navigation highlighting only — access is
 * decided on the server from the matched route (shell/gate.server.ts).
 */
export function moduleOfPath(pathname: string): AdminModule | null {
  if (pathname === "/admin" || pathname === "/admin/") return BY_SLUG.get("dashboard") ?? null;
  const match = /^\/admin\/([^/]+)/.exec(pathname);
  return match ? (BY_SLUG.get(match[1]) ?? null) : null;
}
