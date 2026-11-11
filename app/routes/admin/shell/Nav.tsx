/**
 * The admin's navigation (DESIGN.md §10): built from the modules the employee may see — never a fixed list.
 *
 *   <Rail>      ≥ 1200px: 248px at the inline start, static glass on the flat page; collapsed it is 64px of icons
 *               with their names as tooltips
 *   <NavList>   the rows: the command center on top, then caption-headed groups ordered by priority (P0 first).
 *               Rows are flat 36px; only the active module is clay (a held ink key). Queue rows carry a red bead with
 *               the number of things waiting for a person — the only meaning red has in the admin.
 *   <TabBar>    < 768px: a glass tab bar with the approvals queue first, then the employee's first module, search
 *               and the sections sheet
 *
 * Links are react-router <Link>s with plain /admin paths: the admin's language is a cookie, not a URL prefix, so
 * LocaleLink (which adds /en) must not be used here.
 */
import { useId } from "react";
import { Link, useLocation } from "react-router";

import { Icon } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { Glass } from "~/ui/Glass";
import { IconKey } from "~/ui/IconKey";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { useAdminT } from "./i18n";
import { ADMIN_MODULES, moduleBySlug, moduleOfPath, navGroupsFor, type AdminModule } from "./modules";
import type { ShellWaiting } from "./queues.server";

type NavProps = {
  modules: readonly string[];
  waiting: ShellWaiting | null;
  /** Rail collapsed to icons (rows then carry their name as a tooltip). */
  collapsed?: boolean;
  /** Called after a row is chosen (the sections sheet closes). */
  onNavigate?: () => void;
};

/** "page" for the module's home itself, "true" anywhere inside the module. */
function currentOf(module: AdminModule, pathname: string): "page" | "true" | undefined {
  if (pathname === module.href) return "page";
  return moduleOfPath(pathname)?.slug === module.slug ? "true" : undefined;
}

function waitingFor(waiting: ShellWaiting | null, slug: string): number {
  return waiting ? waiting.queues.filter((queue) => queue.module === slug).reduce((sum, queue) => sum + queue.count, 0) : 0;
}

function NavRow({ module, pathname, count, collapsed, onNavigate }: { module: AdminModule; pathname: string; count: number; collapsed?: boolean; onNavigate?: () => void }) {
  const t = useAdminT();
  const label = t(`modules.${module.slug}`);
  const current = currentOf(module, pathname);
  return (
    <li>
      <Link
        to={module.href}
        prefetch="intent"
        className="adm-nav__row"
        aria-current={current}
        title={collapsed ? label : undefined}
        onClick={onNavigate}
        data-press="soft"
      >
        <Icon name={module.icon} size={18} filled={current !== undefined} />
        <span className="adm-nav__label">{label}</span>
        {count > 0 ? (
          <>
            <span className="bead" aria-hidden="true">
              {count > 99 ? "99+" : count}
            </span>
            <VisuallyHidden>{t("nav.waiting", { count })}</VisuallyHidden>
          </>
        ) : null}
      </Link>
    </li>
  );
}

export function NavList({ modules, waiting, collapsed, onNavigate }: NavProps) {
  const t = useAdminT();
  const { pathname } = useLocation();
  const home = moduleBySlug("dashboard") ?? ADMIN_MODULES[0];
  const groups = navGroupsFor(modules);
  const uid = useId();
  return (
    <nav aria-label={t("nav.label")} className="adm-nav">
      <ul className="adm-nav__group">
        <NavRow module={home} pathname={pathname} count={0} collapsed={collapsed} onNavigate={onNavigate} />
      </ul>
      {groups.map((group) => (
        <div key={group.key} className="adm-nav__group" role="group" aria-labelledby={`${uid}-${group.key}`}>
          <p id={`${uid}-${group.key}`} className="adm-nav__head">
            {t(`nav.groups.${group.key}`)}
          </p>
          <ul className="adm-nav__group">
            {group.modules.map((module) => (
              <NavRow key={module.slug} module={module} pathname={pathname} count={waitingFor(waiting, module.slug)} collapsed={collapsed} onNavigate={onNavigate} />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function Rail({ modules, waiting, collapsed, onToggle }: NavProps & { onToggle: () => void }) {
  const t = useAdminT();
  const { pathname } = useLocation();
  return (
    <Glass as="aside" variant="static" className="adm-rail" aria-label={t("brand.admin")} data-motion-persist="nav">
      <Link to="/admin" className="adm-brand" title={collapsed ? t("brand.home") : undefined}>
        <Logo variant="mark" className="adm-brand__mark text-logo" />
        <span className="adm-brand__text">
          <span className="type-strong">{t("brand.name")}</span>
          <span className="type-caption text-ink-2">{t("brand.admin")}</span>
        </span>
      </Link>
      <NavList modules={modules} waiting={waiting} collapsed={collapsed} />
      <div className="adm-rail__foot">
        <ul className="adm-nav__group min-w-0 flex-1">
          <li>
            <Link to="/admin/blueprint" className="adm-nav__row" aria-current={pathname === "/admin/blueprint" ? "page" : undefined} title={collapsed ? t("nav.blueprint") : undefined}>
              <Icon name="kanban" size={18} />
              <span className="adm-nav__label">{t("nav.blueprint")}</span>
            </Link>
          </li>
        </ul>
        <IconKey
          icon={collapsed ? "caret-right" : "caret-left"}
          label={collapsed ? t("nav.expand") : t("nav.collapse")}
          variant="quiet"
          size="sm"
          aria-expanded={!collapsed}
          onClick={onToggle}
        />
      </div>
    </Glass>
  );
}

type TabBarProps = { modules: readonly string[]; waiting: ShellWaiting | null; onSearch: () => void; onSections: () => void; sectionsOpen: boolean };

export function TabBar({ modules, waiting, onSearch, onSections, sectionsOpen }: TabBarProps) {
  const t = useAdminT();
  const { pathname } = useLocation();
  // The employee's first module after the home, in navigation order (orders for most roles, the till for a cashier).
  const first = navGroupsFor(modules)[0]?.modules[0] ?? null;
  const total = waiting?.total ?? 0;
  return (
    <Glass as="nav" edge="bottom" className="adm-tabbar" aria-label={t("tabs.label")} data-motion-persist="nav">
      <Link to="/admin" className="adm-tab" aria-current={pathname === "/admin" ? "page" : undefined} data-press="icon">
        <span className="adm-tab__icon">
          <Icon name="clipboard-text" size={22} filled={pathname === "/admin"} />
          {total > 0 ? (
            <span className="bead" aria-hidden="true">
              {total > 99 ? "99+" : total}
            </span>
          ) : null}
        </span>
        <span>{t("tabs.waiting")}</span>
        {total > 0 ? <VisuallyHidden>{t("nav.waiting", { count: total })}</VisuallyHidden> : null}
      </Link>
      {first ? (
        <Link to={first.href} className="adm-tab" aria-current={moduleOfPath(pathname)?.slug === first.slug ? "page" : undefined} data-press="icon">
          <span className="adm-tab__icon">
            <Icon name={first.icon} size={22} filled={moduleOfPath(pathname)?.slug === first.slug} />
          </span>
          <span>{t(`modules.${first.slug}`)}</span>
        </Link>
      ) : (
        <Link to="/admin/me" className="adm-tab" aria-current={pathname === "/admin/me" ? "page" : undefined} data-press="icon">
          <span className="adm-tab__icon">
            <Icon name="shield-check" size={22} />
          </span>
          <span>{t("nav.me")}</span>
        </Link>
      )}
      <button type="button" className="adm-tab" onClick={onSearch} aria-haspopup="dialog" data-press="icon">
        <span className="adm-tab__icon">
          <Icon name="magnifying-glass" size={22} />
        </span>
        <span>{t("tabs.search")}</span>
      </button>
      <button type="button" className="adm-tab" onClick={onSections} aria-haspopup="dialog" aria-expanded={sectionsOpen} data-press="icon">
        <span className="adm-tab__icon">
          <Icon name="list" size={22} />
        </span>
        <span>{t("tabs.sections")}</span>
      </button>
    </Glass>
  );
}
