import { Form, useLocation, useNavigation } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useLocalePath, useT } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { MotionLink } from "~/motion";
import { cx } from "~/ui/cx";

/** The account's sections in their sibling order (the order drives the sideways push between them). */
export const ACCOUNT_SECTIONS = [
  { key: "overview", to: "/account", icon: "user", order: 0 },
  { key: "orders", to: "/account/orders", icon: "package", order: 1 },
  { key: "wallet", to: "/account/wallet", icon: "wallet", order: 2 },
  { key: "addresses", to: "/account/addresses", icon: "map-pin", order: 3 },
  { key: "devices", to: "/account/devices", icon: "game-controller", order: 4 },
  { key: "returns", to: "/account/returns", icon: "arrow-counter-clockwise", order: 5 },
  { key: "warranties", to: "/account/warranties", icon: "shield-check", order: 6 },
  { key: "notifications", to: "/account/notifications", icon: "bell", order: 7 },
  { key: "profile", to: "/account/profile", icon: "user-gear", order: 8 },
  { key: "settings", to: "/account/settings", icon: "gear", order: 9 },
] as const satisfies readonly { key: string; to: string; icon: IconName; order: number }[];

export type AccountSectionKey = (typeof ACCOUNT_SECTIONS)[number]["key"];
type NavKey = AccountSectionKey | "wishlist";

/** Order of a section, for route handles. */
export const sectionOrder = (key: AccountSectionKey): number => ACCOUNT_SECTIONS.find((section) => section.key === key)?.order ?? 0;

/**
 * The groups of the section list (Design System v2 §6.12): الطلبات والمرتجعات · المال · الحساب. The overview leads the
 * side column; on phones the overview IS the list, so it is left out there.
 */
const GROUPS: readonly { key: "groupOrders" | "groupMoney" | "groupAccount"; items: readonly NavKey[] }[] = [
  { key: "groupOrders", items: ["orders", "returns", "warranties"] },
  { key: "groupMoney", items: ["wallet"] },
  { key: "groupAccount", items: ["addresses", "devices", "wishlist", "notifications", "profile", "settings"] },
];

const WISHLIST = { key: "wishlist", to: "/wishlist", icon: "heart", order: 10 } as const;

function itemOf(key: NavKey) {
  return key === "wishlist" ? WISHLIST : ACCOUNT_SECTIONS.find((section) => section.key === key)!;
}

/**
 * The grouped list of account sections: icon, name, a short fact («3 طلبات», the balance, «2 جديد») and, in the list
 * form, a caret. `variant="side"`: the side column from 1024px (with «نظرة عامة» first). `variant="list"`: the overview's
 * section list on phones (paper panels of 56px rows). The current section carries `aria-current` and an ink bar —
 * never a colour alone.
 */
export function AccountNav({ hints = {}, variant = "side", className }: { hints?: Partial<Record<NavKey, string | null>>; variant?: "side" | "list"; className?: string }) {
  const t = useT("account");
  const location = useLocation();
  const path = splitLocale(location.pathname).path.replace(/\/+$/, "") || "/";
  const isCurrent = (to: string) => (to === "/account" ? path === "/account" : path === to || path.startsWith(`${to}/`));
  const list = variant === "list";

  const row = (key: NavKey) => {
    const item = itemOf(key);
    const current = isCurrent(item.to);
    const hint = hints[key];
    return (
      <li key={key}>
        <MotionLink
          to={item.to}
          nav={key === "wishlist" ? "fade" : "push"}
          order={item.order}
          aria-current={current ? (path === item.to ? "page" : "true") : undefined}
          data-press="soft"
          className="acct-nav__row"
        >
          <Icon name={item.icon} size={list ? 24 : 20} />
          <span className="acct-nav__text">
            <span className="acct-nav__name">{t(`nav.${key}`)}</span>
            {hint ? <span className="acct-nav__hint">{hint}</span> : null}
          </span>
          {list ? <Icon name="caret-right" size={20} className="text-ink-2" /> : null}
        </MotionLink>
      </li>
    );
  };

  return (
    <nav aria-label={t("nav.label")} className={cx("acct-nav", list && "acct-nav--list", className)}>
      {list ? null : <ul className="acct-nav__group">{row("overview")}</ul>}
      {GROUPS.map((group) => (
        <div key={group.key} className="acct-nav__group" role="group" aria-labelledby={`acct-${variant}-${group.key}`}>
          <p id={`acct-${variant}-${group.key}`} className="acct-nav__label">
            {t(`nav.${group.key}`)}
          </p>
          <ul className="grid">{group.items.map(row)}</ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * «سجّل الخروج» — a quiet link at the end of the section list, never the biggest key (§6.12). Signing out is a POST
 * (a prefetch or a crawler must never sign anyone out), so it is a form whose button looks like a text link.
 */
export function SignOut({ className }: { className?: string }) {
  const t = useT("account");
  const href = useLocalePath();
  const navigation = useNavigation();
  const action = href("/account/logout");
  const busy = navigation.state !== "idle" && navigation.formAction === action;
  return (
    <Form method="post" action={action} className={cx("acct-signout", className)}>
      <button type="submit" className="link min-h-11" aria-busy={busy || undefined} disabled={busy}>
        <Icon name="sign-out" size={16} />
        <span className="link__text">{t("common.signOut")}</span>
      </button>
    </Form>
  );
}
