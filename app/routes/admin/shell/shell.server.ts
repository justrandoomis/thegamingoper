/**
 * Data of the admin layout: who is signed in, which modules they may open, what is waiting for them, and the shell's
 * own preferences (rail collapsed or not, admin language). Built on every admin navigation (React Router revalidates
 * active loaders on navigation), so a permission change shows on the next click.
 */
import { inArray } from "drizzle-orm";
import type { EmployeeSession } from "~/server/auth/admin.server";
import type { RequestCtx } from "~/server/context.server";
import type { Db } from "~/server/db.server";
import { roles } from "~/server/db/schema";
import { pick } from "~/lib/locales";
import { visibleModules } from "./access.server";
import type { AdminModuleSlug } from "./modules";
import { loadWaiting, type ShellWaiting } from "./queues.server";

export const RAIL_COOKIE = "tt_admin_rail";
export const ADMIN_LOCALE_COOKIE = "tt_admin_locale";

export type AdminLocale = "ar" | "en";

export type AdminShellData = {
  employee: { name: string; email: string; initials: string; roles: string[]; totpEnabled: boolean };
  /** Modules the employee may open, in blueprint order. */
  modules: AdminModuleSlug[];
  waiting: ShellWaiting;
  rail: "expanded" | "collapsed";
  locale: AdminLocale;
};

/** Up to two letters from a name ("صاحب المتجر" → "صم", "Noor Ali" → "NA"); the Arabic article "ال" is skipped. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((word) => Array.from(word.length > 3 && word.startsWith("ال") ? word.slice(2) : word)[0] ?? "");
  return letters.join("").toUpperCase() || "؟";
}

export async function loadAdminShell(ctx: RequestCtx, db: Db, session: EmployeeSession): Promise<AdminShellData> {
  const locale: AdminLocale = ctx.locale === "en" ? "en" : "ar";
  const [roleRows, waiting] = await Promise.all([
    session.roles.length > 0 ? db.select({ key: roles.key, name: roles.name }).from(roles).where(inArray(roles.key, session.roles)) : Promise.resolve([]),
    // the request's clock, like every loader (a test's fixed now, a request that started just before midnight)
    loadWaiting(db, session, ctx.now),
  ]);
  const names = new Map(roleRows.map((row) => [row.key, pick(row.name, locale) || row.key]));
  return {
    employee: {
      name: session.employee.name,
      email: session.employee.email,
      initials: initialsOf(session.employee.name),
      roles: session.roles.map((key) => names.get(key) ?? key),
      totpEnabled: session.employee.totpEnabled,
    },
    modules: visibleModules(session.actor),
    waiting,
    rail: ctx.cookie(RAIL_COOKIE) === "collapsed" ? "collapsed" : "expanded",
    locale,
  };
}
