/**
 * The admin gate — server middleware of the authenticated admin layout (app/routes/admin/_layout.tsx). It runs before
 * every loader and action under /admin (document and data requests alike), so nothing below it runs for:
 *
 *   · nobody signed in, or the second step still owed → document redirect to /admin/login?next=<this page>
 *     (`redirectDocument`: the sign-in page sits behind a Cloudflare challenge that a data fetch cannot pass)
 *   · a module the employee may not see (no permission of that module's group) → 403, even by direct URL; the module's
 *     loaders and actions are never called, so a missing check inside a module cannot leak its data. The one
 *     exception is a page another group's permission opens too, by exact route pattern (ALSO_OPENED_BY: module 20's
 *     role editor for staff.manage)
 *
 * and on the way out every admin response gets `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`.
 *
 * Which module a request is for comes from the MATCHED ROUTE PATTERN ("admin/orders/:ref" → orders), never from the
 * raw URL, so encodings such as /admin/%6Frders cannot dodge it. Convention for module owners: register your routes
 * under your folder's slug (/admin/<slug>/…) — a route under /admin that is neither a module's nor one of the shell's
 * own pages is REFUSED for everyone (fail closed, gateRuleOf). The shell's own landing route (/admin/:module) checks access itself and
 * renders its 403 inside the shell. A module's finer permissions stay with the module: every loader and action calls
 * requireEmployee(ctx, db, "<permission>") and every service assertCan(…).
 *
 * Note on rendering: an error thrown by middleware before the loaders run is rendered by the ROOT error boundary
 * (React Router picks the first matched route with a loader), so the 403 of a built module that the employee cannot
 * see is the root's plain page, not the admin shell. That is the price of refusing before any module code runs.
 *
 * Three narrow exceptions, each by exact route pattern (2026-11-12):
 *   · PUBLIC_PATTERNS — the password-set page of a one-time link (/admin/welcome): nobody is signed in there yet, the
 *     link itself is the proof (auth/employees.server.ts); no session is read and the shell renders without data
 *   · ANY_EMPLOYEE_POSTS — POST /admin/ops/report: every signed-in employee's browser reports its own errors and slow
 *     loads (the operations module's resource route; it reads nothing back)
 *   · a session that still owes two-step enrolment (a role requires it — session.restriction) opens My security only:
 *     everything else is a document redirect to its two-step section (MFA_ENROLMENT_PATH)
 */
import { createContext, data, redirectDocument, type MiddlewareFunction, type RouterContextProvider } from "react-router";
import { canAny, type Actor } from "~/server/actor";
import { MFA_ENROLMENT_PATH, requireEmployee, type EmployeeSession } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import type { Permission } from "~/server/permissions";
import { canSeeModule } from "./access.server";
import { isAdminModuleSlug, type AdminModuleSlug } from "./modules";
import { ADMIN_HOME, adminNextPath } from "./next.server";

const sessionContext = createContext<EmployeeSession | null>(null);

/** The employee of this admin request (set by the gate). Throws when called outside the admin layout. */
export function getAdminSession(context: Readonly<RouterContextProvider>): EmployeeSession {
  const session = context.get(sessionContext);
  if (!session) throw new Error("No admin session: is this route inside the admin layout (app/routes/admin/_layout.tsx)?");
  return session;
}

/** The employee of this admin request, or null on a page that needs nobody signed in (PUBLIC_PATTERNS). */
export function findAdminSession(context: Readonly<RouterContextProvider>): EmployeeSession | null {
  return context.get(sessionContext);
}

/**
 * The module a matched route pattern belongs to: "admin/orders/:ref" → "orders". Null for the admin home ("admin"),
 * the shell's own pages (admin/me, admin/blueprint), the landing route (admin/:module) and the not-found splat.
 */
export function moduleOfPattern(pattern: string): AdminModuleSlug | null {
  const segments = pattern.split("/").filter(Boolean);
  if (segments[0] !== "admin") return null;
  const first = segments[1];
  return first && isAdminModuleSlug(first) ? first : null;
}

/** The shell's own route patterns: the home, My security, the blueprint, the landing fallback and the not-found splat. */
const SHELL_PATTERNS: ReadonlySet<string> = new Set(["admin", "admin/me", "admin/blueprint", "admin/:module", "admin/*"]);

/**
 * Pages of a module that a permission of ANOTHER group opens too, by exact matched route pattern — each because the
 * module's own pages and services accept that permission, which the group rule alone would refuse:
 *
 *   admin/security/roles, admin/security/roles/:roleId   staff.manage (group "staff", module 15): the role editor of
 *       module 20 is where roles are given and changed — roles.server reads with staff.manage, security.access_review
 *       .perform or security.session.read and changes only with staff.manage (docs/areas/admin-security.md)
 *   admin/security                                       staff.manage: the frame's own tab bar links every visitor of
 *       the role editor to the module's front page, which shows each figure only to who may open the page behind it
 *       (securityOverview: all of them null for staff.manage alone)
 *
 * Nothing else of the module opens with it (/admin/security/staff/… needs security.session.read): every other pattern
 * of the module still needs a permission of its group.
 *
 *   admin/staff/me                                       dashboard.overview.read (every built-in role holds it): My day
 *       of module 15 — one's own clock, shifts, leave, tasks and pay, which its loaders and actions give every
 *       employee about themselves (2026-11-12, asked by the staff module); nothing else of module 15 opens with it
 */
const ALSO_OPENED_BY: ReadonlyMap<string, readonly Permission[]> = new Map<string, readonly Permission[]>([
  ["admin/security", ["staff.manage"]],
  ["admin/security/roles", ["staff.manage"]],
  ["admin/security/roles/:roleId", ["staff.manage"]],
  ["admin/staff/me", ["dashboard.overview.read"]],
]);

/** Shell pages for nobody signed in yet: the one-time password-set link's page (shell/welcome.tsx). */
const PUBLIC_PATTERNS: ReadonlySet<string> = new Set(["admin/welcome"]);

/** Module routes that every signed-in employee may POST to, whatever their roles (the browser's own reports). */
const ANY_EMPLOYEE_POSTS: ReadonlySet<string> = new Set(["admin/ops/report"]);

const normalized = (pattern: string) => pattern.split("/").filter(Boolean).join("/");

/** `alsoOpenedBy` only on the patterns of ALSO_OPENED_BY. */
export type GateRule =
  | { kind: "module"; module: AdminModuleSlug; alsoOpenedBy?: readonly Permission[] }
  | { kind: "shell" }
  /** any signed-in employee (ANY_EMPLOYEE_POSTS) */
  | { kind: "employee" }
  /** nobody needs to be signed in (PUBLIC_PATTERNS) */
  | { kind: "public" }
  | { kind: "unmapped" };

/**
 * How the gate treats a matched route pattern: a module's route (checked against the module's permission group, and
 * the few permissions of another group that open that exact page — ALSO_OPENED_BY), one of the shell's own pages (any
 * signed-in employee; the page decides the rest), a POST any employee may send (ANY_EMPLOYEE_POSTS), a page for nobody
 * signed in yet (PUBLIC_PATTERNS), or none of these — a route registered under /admin but outside /admin/<module>/,
 * which the gate cannot attribute to a permission group and therefore REFUSES (fail closed: a module owner who
 * registers /admin/payments instead of /admin/orders/payments finds out at once, instead of shipping a page every
 * employee can open).
 */
export function gateRuleOf(pattern: string, method = "GET"): GateRule {
  const key = normalized(pattern);
  if (PUBLIC_PATTERNS.has(key)) return { kind: "public" };
  if (ANY_EMPLOYEE_POSTS.has(key) && method.toUpperCase() === "POST") return { kind: "employee" };
  const module = moduleOfPattern(pattern);
  if (module) {
    const alsoOpenedBy = ALSO_OPENED_BY.get(key);
    return alsoOpenedBy ? { kind: "module", module, alsoOpenedBy } : { kind: "module", module };
  }
  return SHELL_PATTERNS.has(key) ? { kind: "shell" } : { kind: "unmapped" };
}

/** Whether the gate lets this actor through to a module route: a permission of the module's group, or one that opens that page. */
export function gateAllows(actor: Actor, rule: Extract<GateRule, { kind: "module" }>): boolean {
  return canSeeModule(actor, rule.module) || canAny(actor, rule.alsoOpenedBy ?? []);
}

/** The page to come back to after signing in: the normalized URL (no ".data", no router params). */
function returnPath(url: URL): string | null {
  const target = adminNextPath(`${url.pathname}${url.search}`, "");
  return target && target !== ADMIN_HOME ? target : null;
}

/** Every admin response: never cached, never indexed. */
function sealed(response: Response): Response {
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Robots-Tag", "noindex, nofollow");
  return response;
}

export const adminGate: MiddlewareFunction<Response> = async ({ request, context, url, pattern }, next) => {
  const ctx = getCtx(context);
  const rule = gateRuleOf(pattern, request.method);
  // A page for nobody signed in yet: no session is read, so none is set (findAdminSession → null).
  if (rule.kind === "public") return sealed(await next());

  const session = await requireEmployee(ctx, getDb(), undefined, { next: returnPath(url), allowEnrolment: true });
  context.set(sessionContext, session);
  // A role requires two-step verification the employee has not turned on: My security only, until it is on.
  if (session.restriction === "mfa_enrolment" && normalized(pattern) !== "admin/me") throw redirectDocument(MFA_ENROLMENT_PATH);

  // The refusal renders in the root ErrorBoundary, which has no loader data: it carries the admin language with it.
  const locale = ctx.locale === "en" ? "en" : "ar";
  if (rule.kind === "module" && !gateAllows(session.actor, rule)) {
    throw data({ error: "forbidden", module: rule.module, locale }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }
  if (rule.kind === "unmapped") {
    console.error(`[admin] refused: the route pattern "${pattern}" is neither under /admin/<module>/ nor one of the shell's pages (docs/areas/admin-shell.md, "For module owners")`);
    throw data({ error: "forbidden", locale }, { status: 403, headers: { "Cache-Control": "no-store" } });
  }

  return sealed(await next());
};
