import { Link } from "react-router";

import type { Route } from "./+types/admin-home";
import { Icon } from "~/art/Icon";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { Key } from "~/ui/Key";
import { ModuleFunctions, statusCounts } from "../blueprint-status";
import { useAdminShell } from "../shell/actions";
import { useAdminT } from "../shell/i18n";
import { adminMeta } from "../shell/meta";
import { ADMIN_MODULES, compareModules } from "../shell/modules";

/**
 * /admin — the admin home. A minimal landing until module 01 (the command center: KPIs, funnel, activity) is built:
 * what is waiting for this employee first (the cards that need a human decision are the only raised ones — a clean
 * desk has none), a nudge to turn on two-step verification, the employee's sections, and module 01's blueprint status.
 * Everything comes from the layout's data; this page needs a signed-in employee and no particular permission (it only
 * ever shows what the employee may open).
 */
export async function loader({ context }: Route.LoaderArgs) {
  await requireEmployee(getCtx(context), getDb());
  return null;
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.dashboard"));

export default function AdminHome() {
  const t = useAdminT();
  const shell = useAdminShell();
  if (!shell) return null;
  const { employee, waiting } = shell;
  const visible = new Set<string>(shell.modules);
  const modules = ADMIN_MODULES.filter((module) => module.slug !== "dashboard" && visible.has(module.slug)).sort(compareModules);
  const security = waiting.notices[0] ?? null;
  const firstName = employee.name.trim().split(/\s+/)[0] ?? employee.name;

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("modules.dashboard")}</p>
        <h1 className="adm-title">{t("home.title", { name: `⁨${firstName}⁩` })}</h1>
        <p className="type-body text-ink-2">{t("home.lead")}</p>
      </header>

      <section className="adm-section" aria-labelledby="home-waiting">
        <h2 id="home-waiting" className="adm-h2">
          {t("home.waitingTitle")}
        </h2>
        {waiting.queues.length > 0 ? (
          <div className="adm-grid">
            {waiting.queues.map((queue) => (
              <article key={queue.id} className="adm-card adm-card--act">
                <p className="type-kpi nums">
                  <bdi>{queue.count}</bdi>
                </p>
                <p className="type-body text-ink">{t(`notices.${queue.id}`, { count: queue.count })}</p>
                <div>
                  <Key as={Link} to={queue.href} size="sm" iconEnd="arrow-right">
                    {t("home.openModule", { module: t(`modules.${queue.module}`) })}
                  </Key>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="adm-card">
            <p className="type-strong text-ink">{t("home.nothingWaiting")}</p>
            <p className="type-caption text-ink-2">{t("home.nothingWaitingHint")}</p>
          </div>
        )}
        {security ? (
          <div className="adm-notice adm-notice--warn" role="note">
            <Icon name="shield-check" size={18} />
            <div className="grid gap-2">
              <p className="type-strong text-ink">{security.id === "mfa_off" ? t("home.mfaTitle") : t("notices.recovery_low", { count: security.count ?? 0 })}</p>
              <p className="type-body text-ink">{security.id === "mfa_off" ? t("home.mfaText") : t("home.recoveryText")}</p>
              <div>
                <Key as={Link} to={security.href} size="sm" variant="ink">
                  {security.id === "mfa_off" ? t("home.mfaAction") : t("home.recoveryAction")}
                </Key>
              </div>
            </div>
          </div>
        ) : null}
      </section>

      <section className="adm-section" aria-labelledby="home-modules">
        <div className="adm-section__head">
          <h2 id="home-modules" className="adm-h2">
            {t("home.modulesTitle")}
          </h2>
          <p className="type-caption text-ink-2">{t("home.modulesCount", { count: modules.length })}</p>
        </div>
        {modules.length > 0 ? (
          <ul className="adm-grid">
            {modules.map((module) => {
              const counts = statusCounts(module.id);
              return (
                <li key={module.slug}>
                  <Link to={module.href} prefetch="intent" className="adm-module-link">
                    <Icon name={module.icon} size={22} />
                    <span className="grid min-w-0 flex-1">
                      <span className="type-strong">{t(`modules.${module.slug}`)}</span>
                      <span className="type-caption text-ink-2">{t("home.moduleProgress", { done: counts.implemented, total: counts.total })}</span>
                    </span>
                    <Icon name="caret-right" size={18} />
                  </Link>
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="adm-card">
            <p className="type-body text-ink">{t("home.noModules")}</p>
          </div>
        )}
      </section>

      <ModuleFunctions moduleId="01" />
    </>
  );
}
