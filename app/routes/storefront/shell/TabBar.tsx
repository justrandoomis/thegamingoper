/**
 * Mobile and tablet bottom navigation (< 1200px, docs/DESIGN.md §9.3) and the task-bar slot that replaces it.
 *
 * TAB BAR: live glass pinned to the bottom edge, top corners r-xl, 64px + the safe-area inset. Five always-labelled
 * tabs in reading order — الرئيسية، التصنيفات، السلة، المفضلة، حسابي. The active tab has a filled icon, a heavier
 * label and a 22 × 3 ink marker on the bar's top edge (never colour alone, never red). The cart tab carries the red
 * bead (`data-cart-target` / `data-cart-badge`: where fly-to-cart lands). "التصنيفات" opens the categories sheet; it
 * is a link to the footer's category list (#shell-categories), so it still leads somewhere without script.
 *
 * PAGES WITH THEIR OWN BOTTOM BAR (product buy bar, cart and checkout bars — §8 sticky rule: never two bars at one
 * edge). Declare it in the route module, so the server already renders the page without the tab bar:
 *
 *   export const handle = { shell: { tabBar: false } } satisfies ShellHandle;
 *
 * and render the bar with <TaskBar>:
 *
 *   <TaskBar className="lg:hidden">
 *     <Price amountIqd={total} /> <Key variant="commit" block>{t("checkout")}</Key>
 *   </TaskBar>
 *
 * <TaskBar> is the same live-glass bar (safe-area padded, persisted through page transitions) and publishes its
 * measured height as `--shell-taskbar-h`; the shell pads the page by `--shell-bottom`, which is the tab bar's
 * height, the task bar's, or 0 on desktop. Sticky page elements sit at `inset-block-end: var(--shell-bottom)` so the
 * bars never cover a call to action. Without the tab bar the cart is still one tap away: below 1200 the header turns
 * into the task header once the page scrolls (back · the page's <h1> · the cart with its bead — ./Header).
 */
import { useLayoutEffect, useRef, type MouseEvent, type ReactNode } from "react";
import { useLocation } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { cx } from "~/ui/cx";
import { useCartCount } from "~/ui/cart-client";
import { Glass } from "~/ui/Glass";
import { useShellT } from "./i18n";

type Section = "home" | "categories" | "cart" | "wishlist" | "account" | null;

const CATALOGUE = /^\/(c|platform|device|used|support|search|compare|trade-in|p)(\/|$)/;

/** Which tab the current page belongs to (locale-less path). */
export function sectionOf(path: string): Section {
  if (path === "/") return "home";
  if (/^\/(cart|checkout)(\/|$)/.test(path)) return "cart";
  if (/^\/wishlist(\/|$)/.test(path)) return "wishlist";
  if (/^\/account(\/|$)/.test(path)) return "account";
  if (CATALOGUE.test(path)) return "categories";
  return null;
}

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
  const section = sheetOpen ? "categories" : sectionOf(path);
  /** aria-current: "page" on the link to this very page, "true" when the page is inside the tab's section. */
  const current = (tab: Exclude<Section, null>, href: string) => (section !== tab ? undefined : path === href ? ("page" as const) : ("true" as const));

  const openSheet = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onCategories();
  };

  return (
    <Glass as="nav" edge="bottom" aria-label={t("tabs.label")} className="shell-tabbar" data-motion-persist="nav">
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
