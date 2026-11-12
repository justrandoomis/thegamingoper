/**
 * The bottom of the screen below 1024px (Design System v2 §5.6, §5.7).
 *
 * TAB BAR: a floating glass pill — 64px tall, 12px from the sides, 10px + the safe area from the bottom, --r-xl,
 * --e-float, at most 520px wide and centred from 600. Five tabs in reading order: الرئيسية · التصنيفات · السلة ·
 * المفضلة · حسابي; a 24px icon over a 13px label. The current tab: its icon filled in --red-ink on the active pill
 * (56 × 32, --red-tint), its label 600 ink, `aria-current` ("page" on that very page, "true" inside its section); the
 * others an outline icon and a 400 --ink-2 label. ONE pill slides from tab to tab when the section changes (v2.1 G6;
 * its place is rendered on the server, so it is right without script; instant under reduced motion), and a pressed
 * tab's icon dips (the engine's press, `data-pressed`). The cart carries the bead (`data-cart-target` on the tab,
 * `data-cart-badge` on the bead). "التصنيفات" opens the categories sheet; it is a link to the footer's shop column
 * (#shell-categories), so it still leads somewhere without script.
 *
 * It is drawn on store pages only (not in checkout or task flows) and gives way BY ITSELF to a page's own bottom bar:
 * while a <TaskBar> is in the page (product buy bar, a cart with items) the tab bar is hidden (CSS), so an empty cart —
 * which draws no task bar — keeps the tab bar. Never two bars at one edge.
 *
 * PAGES WITH THEIR OWN BOTTOM BAR declare it in the route module, so the server already renders the right header, and
 * render the bar with <TaskBar>:
 *
 *   export const handle = { shell: { tabBar: false } } satisfies ShellHandle;      // task flows: { chrome: "task" }
 *   <TaskBar aria-label={t("buy")} className="lg:hidden">
 *     <Price amountIqd={total} size="lg" tone="total" /> <Key variant="primary" block>{t("checkout")}</Key>
 *   </TaskBar>
 *
 * <TaskBar> is glass on the bottom edge, 72px + the safe area, --e-float, content inset 16 (centred, at most 640 wide
 * on tablets); persisted through page transitions; it publishes its measured height as `--shell-taskbar-h`, which the
 * shell turns into `--shell-bottom` (the page's bottom padding and the global scroll padding). Sticky page elements
 * sit at `inset-block-end: var(--shell-bottom)`. Below 1024 the header becomes the task header once the page scrolls
 * (back · the page's <h1> · the cart with its bead — ./Header), so the cart stays one tap away.
 */
import { useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import { useLocation } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { cx } from "~/ui/cx";
import { useCartCount } from "~/ui/cart-client";
import { Glass } from "~/ui/Glass";
import { tabOf, type TabId } from "./chrome";
import { useShellT } from "./i18n";

/** Which tab the current page belongs to (locale-less path). Kept for callers of the 1.0 name. */
export const sectionOf = tabOf;

/** The tabs in reading order: the active pill's column is the section's place here. */
const TAB_ORDER: readonly TabId[] = ["home", "categories", "cart", "wishlist", "account"];

export type TabBarProps = {
  sheetOpen: boolean;
  onCategories: () => void;
};

export function TabBar({ sheetOpen, onCategories }: TabBarProps) {
  const t = useShellT();
  const f = useFormat();
  const location = useLocation();
  const { count } = useCartCount();
  const path = splitLocale(location.pathname).path;
  const section = sheetOpen ? "categories" : tabOf(path);
  /** aria-current: "page" on the link to this very page, "true" when the page is inside the tab's section. */
  const current = (tab: TabId, href: string) => (section !== tab ? undefined : path === href ? ("page" as const) : ("true" as const));

  const openSheet = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onCategories();
  };
  // the active pill's column (reading order); no section (a content page): no pill
  const pill = section ? TAB_ORDER.indexOf(section) : -1;

  return (
    <Glass
      as="nav"
      edge="bottom"
      aria-label={t("tabs.label")}
      className="shell-tabbar"
      data-motion-persist="nav"
      style={pill >= 0 ? ({ "--tab-i": pill } as CSSProperties) : undefined}
    >
      <span className="shell-tabbar__pill" data-on={pill >= 0 ? "" : undefined} aria-hidden="true" />
      <Tab to="/" icon="house" label={t("tabs.home")} current={current("home", "/")} />
      <a
        href="#shell-categories"
        className="shell-tab"
        aria-haspopup="dialog"
        aria-expanded={sheetOpen}
        aria-current={section === "categories" ? "true" : undefined}
        data-press="soft"
        onClick={openSheet}
      >
        <TabIcon icon="squares-four" filled={section === "categories"} />
        <span className="shell-tab__label">{t("tabs.categories")}</span>
      </a>
      <LocaleLink
        to="/cart"
        className="shell-tab"
        aria-current={current("cart", "/cart")}
        aria-label={t("tools.cartCount", { count })}
        data-cart-target=""
        data-press="soft"
      >
        <span className="shell-tab__ico">
          <Icon name="shopping-bag" size={24} filled={section === "cart"} />
          {count > 0 ? (
            <b className="bead" data-cart-badge="" aria-hidden="true">
              {f.number(count)}
            </b>
          ) : null}
        </span>
        <span className="shell-tab__label">{t("tabs.cart")}</span>
      </LocaleLink>
      <Tab to="/wishlist" icon="heart" label={t("tabs.wishlist")} current={current("wishlist", "/wishlist")} />
      <Tab to="/account" icon="user" label={t("tabs.account")} current={current("account", "/account")} />
    </Glass>
  );
}

function TabIcon({ icon, filled }: { icon: IconName; filled: boolean }) {
  return (
    <span className="shell-tab__ico">
      <Icon name={icon} size={24} filled={filled} />
    </span>
  );
}

function Tab({ to, icon, label, current }: { to: string; icon: IconName; label: string; current: "page" | "true" | undefined }) {
  return (
    <LocaleLink to={to} className="shell-tab" aria-current={current} data-press="soft">
      <TabIcon icon={icon} filled={current !== undefined} />
      <span className="shell-tab__label">{label}</span>
    </LocaleLink>
  );
}

export type TaskBarProps = {
  children: ReactNode;
  /** e.g. "lg:hidden" when the page moves its buy controls into a column on wide screens. */
  className?: string;
  /** Accessible name of the bar ("الدفع", "إضافة إلى السلة"). */
  "aria-label"?: string;
};

/** A page's own bottom bar in place of the tab bar (see the file header). */
export function TaskBar({ children, className, "aria-label": label }: TaskBarProps) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--shell-taskbar-h", `${Math.round(element.getBoundingClientRect().height)}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--shell-taskbar-h");
    };
  }, []);
  return (
    <Glass ref={ref} edge="bottom" role="region" aria-label={label} className={cx("shell-taskbar", className)} data-motion-persist="bar">
      {children}
    </Glass>
  );
}
