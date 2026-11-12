/**
 * The admin's tool bar, sticky on top of the content column. Solid glass: tables scroll under it, and the admin keeps
 * live blur for the phone tab bar and temporary layers (two live panes at most, DESIGN.md §6.2).
 *
 *   < 1200px   the sections key (768–1199) and the logo; ≥ 1200 those live in the rail
 *   ≥ 768px    the search field (a key that opens the command palette, Ctrl/⌘ K) and the notifications bell
 *   always     the employee key: their menu with My security, language, theme and sign-out
 */
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { LOCALES } from "~/lib/locales";
import { usePrefs } from "~/lib/prefs";
import { Glass } from "~/ui/Glass";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Menu, type MenuItem } from "~/ui/Menu";
import { useShellActions } from "./actions";
import { useAdminT } from "./i18n";
import type { ShellQueueId, ShellWaiting } from "./queues.server";

/** One glyph per queue in the notifications menu. */
const QUEUE_ICON: Record<ShellQueueId, IconName> = {
  proofs: "receipt",
  refunds: "hand-coins",
  pos_shifts: "clock",
  privacy_requests: "lock",
  failed_deliveries: "warning",
  cod_settlements: "scales",
  rmas: "arrow-u-up-left",
  inspections: "magnifying-glass",
  prices: "tag",
  counts: "clipboard-text",
  transfers: "truck",
  tradein_inspections: "recycle",
  // (never a dollar sign: offers are in dinars — "currency-dollar" is the pricing module's USD rate)
  tradein_offers: "swap",
  tradein_payouts: "hand-coins",
  used_inspections: "wrench",
  used_listings: "storefront",
  po_approvals: "factory",
  stuck_receipts: "hourglass",
  invoice_mismatches: "file-text",
  topups: "wallet",
  adjustments: "coins",
  expenses: "money",
  signin_alerts: "warning-circle",
  access_reviews: "users",
  settings_changes: "sliders-horizontal",
  promotion_approvals: "percent",
  support_escalated: "lifebuoy",
  support_unassigned: "ticket",
  support_late: "hourglass",
  staff_leave: "calendar-blank",
  staff_payroll: "money",
  staff_advances: "hand-coins",
  ops_findings: "scales",
  ops_jobs: "pulse",
  ops_incidents: "fire",
  cms_policies: "file-text",
};
import type { AdminShellData } from "./shell.server";

/** "Ctrl K" everywhere, "⌘ K" on Apple devices (decided after hydration, so the server and first render agree). */
export function useShortcutLabel(): "ctrl" | "mac" {
  const [label, setLabel] = useState<"ctrl" | "mac">("ctrl");
  useEffect(() => {
    if (/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)) setLabel("mac");
  }, []);
  return label;
}

function NoticesMenu({ waiting }: { waiting: ShellWaiting | null }) {
  const t = useAdminT();
  const { go } = useShellActions();
  const total = waiting?.total ?? 0;
  const items: MenuItem[] = [];
  for (const queue of waiting?.queues ?? []) {
    items.push({ id: queue.id, label: t(`notices.${queue.id}`, { count: queue.count }), icon: QUEUE_ICON[queue.id], onSelect: () => go(queue.href) });
  }
  for (const notice of waiting?.notices ?? []) {
    items.push({
      id: notice.id,
      label: notice.id === "mfa_off" ? t("notices.mfa_off") : t("notices.recovery_low", { count: notice.count ?? 0 }),
      icon: "shield-check",
      onSelect: () => go(notice.href),
    });
  }
  if (items.length === 0) items.push({ id: "none", label: t("notices.empty"), disabled: true, onSelect: () => {} });
  return (
    <Menu
      label={t("notices.bell", { count: total })}
      title={t("notices.label")}
      align="end"
      items={items}
      trigger={(props) => (
        <span className="adm-bell">
          <IconKey {...props} icon="bell" label={t("notices.bell", { count: total })} variant="quiet" />
          {total > 0 ? (
            <span className="bead" aria-hidden="true">
              {total > 99 ? "99+" : total}
            </span>
          ) : null}
        </span>
      )}
    />
  );
}

function EmployeeMenu({ employee, locale }: { employee: AdminShellData["employee"]; locale: "ar" | "en" }) {
  const t = useAdminT();
  const { theme } = usePrefs();
  const { go, setLocale, setTheme, signOut } = useShellActions();
  const items: MenuItem[] = [
    { id: "me", label: t("nav.me"), icon: "shield-check", onSelect: () => go("/admin/me") },
    { id: "blueprint", label: t("nav.blueprint"), icon: "kanban", onSelect: () => go("/admin/blueprint") },
    { kind: "separator", id: "s1" },
    { id: "lang-ar", kind: "radio", label: LOCALES.ar.label, checked: locale === "ar", onSelect: () => locale !== "ar" && setLocale("ar") },
    { id: "lang-en", kind: "radio", label: LOCALES.en.label, checked: locale === "en", onSelect: () => locale !== "en" && setLocale("en") },
    { kind: "separator", id: "s2" },
    { id: "theme-light", kind: "radio", label: t("account.themeLight"), checked: theme === "light", onSelect: () => setTheme("light") },
    { id: "theme-dark", kind: "radio", label: t("account.themeDark"), checked: theme === "dark", onSelect: () => setTheme("dark") },
    { id: "theme-system", kind: "radio", label: t("account.themeSystem"), checked: theme === "system", onSelect: () => setTheme("system") },
    { kind: "separator", id: "s3" },
    { id: "sign-out", label: t("actions.signOut"), icon: "sign-out", onSelect: () => signOut("one") },
    { id: "sign-out-all", label: t("actions.signOutAll"), icon: "sign-out", onSelect: () => signOut("all") },
  ];
  return (
    <Menu
      label={t("account.menu", { name: employee.name })}
      title={
        <span className="grid">
          <bdi className="type-strong text-ink">{employee.name}</bdi>
          <bdi dir="ltr" className="text-start">
            {employee.email}
          </bdi>
          {employee.roles.length > 0 ? <span>{employee.roles.join(" · ")}</span> : null}
        </span>
      }
      align="end"
      items={items}
      trigger={(props) => (
        <Key {...props} variant="quiet" size="sm" aria-label={t("account.menu", { name: employee.name })} icon={<span className="adm-avatar" aria-hidden="true">{employee.initials}</span>} iconEnd="caret-down">
          <span className="adm-me__name">{employee.name}</span>
        </Key>
      )}
    />
  );
}

type TopBarProps = {
  data: AdminShellData | null;
  onSearch: () => void;
  onSections: () => void;
  sectionsOpen: boolean;
};

export function TopBar({ data, onSearch, onSections, sectionsOpen }: TopBarProps) {
  const t = useAdminT();
  const shortcut = useShortcutLabel();
  return (
    <Glass as="header" variant="solid" className="adm-top" data-motion-persist="nav">
      {data ? (
        <IconKey
          className="adm-top__sections"
          icon="list"
          label={t("nav.open")}
          variant="quiet"
          aria-haspopup="dialog"
          aria-expanded={sectionsOpen}
          onClick={onSections}
        />
      ) : null}
      <Link to="/admin" className="adm-top__brand">
        <Logo variant="mark" className="h-7 w-auto text-logo" />
        <span className="type-strong">{t("brand.admin")}</span>
      </Link>
      {data ? (
        <>
          <button type="button" className="adm-search" onClick={onSearch} aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K">
            <Icon name="magnifying-glass" size={18} />
            <span className="adm-search__text">{t("search.trigger")}</span>
            <kbd className="adm-kbd" dir="ltr">
              {t(`search.${shortcut}`)}
            </kbd>
          </button>
          <span className="adm-top__spacer" />
          <div className="adm-top__tools">
            <span className="hidden md:inline-flex">
              <NoticesMenu waiting={data.waiting} />
            </span>
            <EmployeeMenu employee={data.employee} locale={data.locale} />
          </div>
        </>
      ) : (
        <span className="adm-top__spacer" />
      )}
    </Glass>
  );
}
