import { useLocation } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
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

/** Order of a section, for route handles. */
export const sectionOrder = (key: AccountSectionKey): number => ACCOUNT_SECTIONS.find((section) => section.key === key)?.order ?? 0;

/**
 * The list of account sections: a column of flat rows (icon, name, a short fact, a caret). Used as the side column
 * from 1024px and as the section list on the overview page on phones. `hints` add the fact after the name
 * ("3 طلبات"), `badge` marks unread notifications with words — never a colour alone.
 */
export function AccountNav({
  hints = {},
  include = "all",
  className,
}: {
  hints?: Partial<Record<AccountSectionKey | "wishlist", string | null>>;
  /** "all" = every section; "sections" = without the overview (the overview's own list). */
  include?: "all" | "sections";
  className?: string;
}) {
  const t = useT("account");
  const location = useLocation();
  const path = splitLocale(location.pathname).path.replace(/\/+$/, "") || "/";
  const items = include === "all" ? ACCOUNT_SECTIONS : ACCOUNT_SECTIONS.filter((section) => section.key !== "overview");
  const isCurrent = (to: string) => (to === "/account" ? path === "/account" : path === to || path.startsWith(`${to}/`));
  return (
    <nav aria-label={t("nav.label")} className={className}>
      <ul className="grid">
        {items.map((section) => {
          const current = isCurrent(section.to);
          const hint = hints[section.key];
          return (
            <li key={section.key}>
              <MotionLink
                to={section.to}
                nav="push"
                order={section.order}
                aria-current={current ? (path === section.to ? "page" : "true") : undefined}
                data-press="soft"
                className={cx(
                  "group flex min-h-[52px] items-center gap-3 rounded-md px-3 py-2 text-ink",
                  current ? "bg-paper font-semibold shadow-e1" : "hover:bg-niche",
                )}
              >
                <Icon name={section.icon} size={22} className={current ? "text-ink" : "text-ink-2"} />
                <span className="grid min-w-0 flex-1">
                  <span className="type-label text-ink">{t(`nav.${section.key}`)}</span>
                  {hint ? <span className="type-caption text-ink-2">{hint}</span> : null}
                </span>
                <Icon name="caret-right" size={18} className="text-ink-2" />
              </MotionLink>
            </li>
          );
        })}
        <li className="mt-2 border-t border-line pt-2">
          <MotionLink to="/wishlist" nav="fade" data-press="soft" className="flex min-h-[52px] items-center gap-3 rounded-md px-3 py-2 text-ink hover:bg-niche">
            <Icon name="heart" size={22} className="text-ink-2" />
            <span className="grid min-w-0 flex-1">
              <span className="type-label text-ink">{t("nav.wishlist")}</span>
              {hints.wishlist ? <span className="type-caption text-ink-2">{hints.wishlist}</span> : null}
            </span>
            <Icon name="caret-right" size={18} className="text-ink-2" />
          </MotionLink>
        </li>
      </ul>
    </nav>
  );
}
