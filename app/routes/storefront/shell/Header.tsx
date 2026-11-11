/**
 * The top of every storefront page (docs/DESIGN.md §9.2, §8.8, §8.11).
 *
 *   <UtilityBar>   ≥1200 only, flat, 38px: the delivery fact (fee from settings), track your order, trade in, help,
 *                  the display currency (with its rate), the languages. Below 1200 these live in the categories sheet
 *                  and the footer.
 *   <Header>       sticky. Phones and tablets: logo + search field. ≥1200: logo, platform links with LEDs (each
 *                  with its mega menu), used, repair, search, theme, favourites, account, the cart orb with its bead.
 *                  On the floor at the top of the page; once the page has scrolled about 24px a live glass layer
 *                  fades in behind it (and phones swap the wordmark for the mascot mark). Scrolling is observed with
 *                  an IntersectionObserver on a 24px sentinel — no scroll listener.
 *
 *   TASK SCREENS   pages with their own bottom task bar (handle `tabBar: false`: product, cart, checkout, …) have no
 *                  tab bar, so below 1200 the scrolled header becomes the task header (§9.2): back at the start, the
 *                  page's <h1> as its title, the cart with its bead at the end — the cart stays one tap away and
 *                  fly-to-cart has a target. At the top of the page the header is the usual one (the product page's
 *                  stage has its own back / cart orbs there). The search field comes back while it has focus. Back is
 *                  real history Back when an earlier page of this site is in the tab, else a link to `task.back`.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useLocation, useNavigate } from "react-router";

import { Icon } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { LocaleLink, useFormat } from "~/i18n/react";
import { formatMoney } from "~/lib/money";
import { useCartCount } from "~/ui/cart-client";
import { Glass } from "~/ui/Glass";
import { IconKey } from "~/ui/IconKey";
import { PlatformNav } from "./MegaMenu";
import { CurrencyMenu, LanguageLinks, ThemeToggle } from "./Preferences";
import { SearchForm } from "./SearchForm";
import { useShellT } from "./i18n";
import type { ShellData } from "./types";

/** A page with its own task bar: the header's task mode (see the file header). */
export type HeaderTask = {
  /** Where back leads without in-site history (locale-less). */
  back: string;
};

export function UtilityBar({ shell }: { shell: ShellData | null }) {
  const t = useShellT();
  const f = useFormat();
  return (
    <div className="shell-utility">
      <div className="page shell-utility__row">
        {shell ? (
          <p className="shell-utility__fact">
            <Icon name="truck" size={17} />
            <span>{t("utility.delivery", { fee: "⁨" + formatMoney(shell.deliveryFeeIqd, "IQD", f.locale, f.numbering) + "⁩" })}</span>
          </p>
        ) : (
          <span />
        )}
        <nav className="shell-utility__links" aria-label={t("utility.label")}>
          <LocaleLink to="/track" className="shell-utility__link hit-44">
            {t("utility.track")}
          </LocaleLink>
          <LocaleLink to="/trade-in" className="shell-utility__link hit-44">
            {t("utility.tradeIn")}
          </LocaleLink>
          <LocaleLink to="/support" className="shell-utility__link hit-44">
            {t("utility.help")}
          </LocaleLink>
          <CurrencyMenu />
          <LanguageLinks className="shell-langs" linkClassName="shell-utility__link hit-44" />
        </nav>
      </div>
    </div>
  );
}

/** True once the page has scrolled past the 24px sentinel that sits right above the header. */
function useScrolled(sentinel: React.RefObject<HTMLElement | null>): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const element = sentinel.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => setScrolled(!entry.isIntersecting && entry.boundingClientRect.top < 0), { threshold: 0 });
    observer.observe(element);
    return () => observer.disconnect();
  }, [sentinel]);
  return scrolled;
}

/**
 * The page's title for the task header: the text of the page's <h1> (every storefront page starts with one — the
 * shell contract), read once the task header shows and again after each navigation. Client-only by nature (the
 * header only turns into the task header after a scroll), so server and first client render agree: empty.
 */
function usePageTitle(active: boolean): string {
  const location = useLocation();
  const [title, setTitle] = useState("");
  useEffect(() => {
    if (!active) return;
    const heading = document.querySelector("#main h1");
    setTitle(heading?.textContent?.replace(/\s+/g, " ").trim() ?? "");
  }, [active, location.key]);
  return title;
}

export function Header({ shell, task = null }: { shell: ShellData | null; task?: HeaderTask | null }) {
  const t = useShellT();
  const f = useFormat();
  const { count } = useCartCount();
  const sentinel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const scrolled = useScrolled(sentinel);
  const title = usePageTitle(task !== null && scrolled);

  // toasts start just under the header, wherever it is (below the ribbon and the utility strip at the top of the
  // page, at the top edge once it sticks) — measured only when that changes, never per scroll frame
  useLayoutEffect(() => {
    const element = header.current;
    if (!element) return;
    const root = document.documentElement;
    const publish = () => root.style.setProperty("--shell-toast-top", `${Math.max(0, Math.round(element.getBoundingClientRect().bottom)) + 8}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty("--shell-toast-top");
    };
  }, [scrolled]);

  return (
    <>
      <div className="relative" aria-hidden="true">
        <div ref={sentinel} className="pointer-events-none absolute inset-x-0 h-6" />
      </div>
      <header ref={header} className="shell-header" data-scrolled={scrolled ? "" : undefined} data-task={task ? "" : undefined} data-motion-persist="header">
        {scrolled ? <Glass className="shell-header__glass" aria-hidden="true" /> : null}
        <div className="page shell-header__bar">
          {task ? <TaskBack to={task.back} /> : null}
          <LocaleLink to="/" className="shell-logo text-logo" aria-label={t("brandHome")}>
            <Logo variant="wordmark" className="shell-logo__word" />
            <Logo variant="mark" className="shell-logo__mark" />
          </LocaleLink>
          {task && title ? (
            // the page's own <h1> names the page for assistive technology; this is its visual echo on the bar
            <p className="shell-task shell-task--title" aria-hidden="true">
              {title}
            </p>
          ) : null}

          <PlatformNav platforms={shell?.nav.platforms ?? []}>
            {shell && shell.nav.platforms.length > 0 ? <span className="shell-nav__sep" aria-hidden="true" /> : null}
            <LocaleLink to="/used" className="shell-nav__link">
              <span className="shell-nav__text">{t("nav.used")}</span>
            </LocaleLink>
            <LocaleLink to="/support/repair" className="shell-nav__link">
              <span className="shell-nav__text">{t("nav.repair")}</span>
            </LocaleLink>
          </PlatformNav>

          <SearchForm />

          <div className="shell-tools">
            <ThemeToggle />
            <IconKey as={LocaleLink} to="/wishlist" variant="quiet" icon="heart" label={t("tools.wishlist")} />
            <IconKey as={LocaleLink} to="/account" variant="quiet" icon="user" label={t("tools.account")} />
            <CartOrb count={count} label={t("tools.cartCount", { count })} bead={f.number(count)} />
          </div>
          {task ? (
            <span className="shell-task shell-task--cart">
              <CartOrb count={count} label={t("tools.cartCount", { count })} bead={f.number(count)} />
            </span>
          ) : null}
        </div>
      </header>
    </>
  );
}

/**
 * The cart orb with its bead: the desktop header's, and the task header's below 1200. Fly-to-cart lands on the first
 * VISIBLE `[data-cart-target]`, so the hidden one of the two never receives a bead.
 */
function CartOrb({ count, label, bead }: { count: number; label: string; bead: string }) {
  return (
    <Glass as={LocaleLink} to="/cart" variant="static" className="shell-cart" aria-label={label} data-cart-target="" data-press="icon">
      <Icon name="shopping-bag" size={20} />
      {count > 0 ? (
        <b className="bead" data-cart-badge="" aria-hidden="true">
          {bead}
        </b>
      ) : null}
    </Glass>
  );
}

/** The task header's back key: real history Back when an earlier page of this site is in the tab, else a link. */
function TaskBack({ to }: { to: string }) {
  const t = useShellT();
  const navigate = useNavigate();
  const back = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    // React Router numbers the entries it created in this tab; idx 0 = the page the shopper arrived on
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === "number" && state.idx > 0) {
      event.preventDefault();
      void navigate(-1);
    }
  };
  return (
    <span className="shell-task shell-task--back">
      <IconKey as={LocaleLink} to={to} variant="quiet" icon="arrow-left" label={t("tools.back")} onClick={back} />
    </span>
  );
}
