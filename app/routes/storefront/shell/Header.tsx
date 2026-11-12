/**
 * The top of every storefront page (Design System v2 §5.1–§5.3, §5.8). One sticky glass <header> for every width:
 *
 *   BELOW 1024   56px: the lockup (the mascot + the wordmark; the wordmark alone below 375px) · the search pill (it opens
 *                the full-screen search sheet; «ابحث» below 430px, «ابحث عن جهاز أو لعبة» from 430) · the cart with its
 *                bead. Account and favourites live in the tab bar. The demo strip (./Banners) sits above it and scrolls
 *                away.
 *   FROM 1024    two rows, 64 + 44 = 108px. Row 1: the lockup · the search field (320 wide, 560 from 1280 with its "/"
 *                shortcut) · from 1280 «استبدل جهازك» and «تتبّع طلبك» · language (globe → menu), account (a menu
 *                that also holds those two links at 1024–1279), favourites, the cart. Row 2: the four platform menu
 *                buttons (./MegaMenu) · الألعاب · الإكسسوارات (from 1280; it is in every mega menu) · المستعمل · الدعم ·
 *                the demo chip at the end.
 *   TASK SCREENS pages with their own bottom task bar (handle `tabBar: false`, task flows) have no tab bar, so below 1024
 *                the header becomes the task header once the page has scrolled 24px: back · the page's <h1> · the cart.
 *                Back is real history Back when an earlier page of this site is in the tab, else a link to `task.back`.
 *   CHECKOUT     <CheckoutBar>: one 56px bar (64 from 1024) — back to the cart · the mascot (home) · the step rail · the
 *                «طلب تجريبي» tag · help. No strip, no search, no menus.
 *
 * The cart button is the fly-to-cart target (`data-cart-target`, drawn at every count) and its bead `data-cart-badge`.
 * Scrolling is observed with an IntersectionObserver on a 24px sentinel at the top of the document — no scroll listener.
 */
import { useEffect, useRef, useState, type MouseEvent } from "react";
import { useLocation, useNavigate } from "react-router";

import { Icon } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { LocaleLink, useFormat } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { cx } from "~/ui/cx";
import { useCartCount } from "~/ui/cart-client";
import { DemoNote } from "~/ui/DemoNote";
import { Glass } from "~/ui/Glass";
import { IconKey } from "~/ui/IconKey";
import { Menu } from "~/ui/Menu";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { TextLink } from "~/ui/TextLink";
import { PageProgress } from "./Banners";
import { checkoutRail } from "./chrome";
import { useShellT } from "./i18n";
import { PlatformNav } from "./MegaMenu";
import { LanguageMenu } from "./Preferences";
import { SearchForm } from "./SearchForm";
import type { ShellData } from "./types";

/** A page with its own task bar: the header's task mode (see the file header). */
export type HeaderTask = {
  /** Where back leads without in-site history (locale-less). */
  back: string;
};

export type HeaderProps = {
  shell: ShellData | null;
  task?: HeaderTask | null;
  /** STORE_MODE is "demo": the nav row ends with the demo chip. */
  demo: boolean;
  /** The phone search pill was pressed: open the search sheet. */
  onSearch: () => void;
  /** Words the desktop search field starts with (a missing product's slug words on its 404). */
  searchQuery?: string;
};

/** True once the page has scrolled past the 24px sentinel at the top of the document. */
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

/** The logo lockup: the mascot and the wordmark in brand red, one link home. */
export function Lockup({ className, label }: { className?: string; label?: string }) {
  const t = useShellT();
  return (
    <LocaleLink to="/" className={cx("shell-lockup text-logo", className)} aria-label={label ?? t("brandHome")}>
      <Logo variant="mark" className="shell-lockup__mark" />
      <Logo variant="wordmark" className="shell-lockup__word" />
    </LocaleLink>
  );
}

/** The cart button with its bead: the fly-to-cart target at every count (the bead appears from 1). */
export function CartButton({ className }: { className?: string }) {
  const t = useShellT();
  const f = useFormat();
  const { count } = useCartCount();
  return (
    <LocaleLink
      to="/cart"
      className={cx("key key--round key--plain shell-cart", className)}
      aria-label={t("tools.cartCount", { count })}
      data-cart-target=""
      data-press="icon"
    >
      <span className="key__cap">
        <Icon name="shopping-bag" size={24} />
      </span>
      {count > 0 ? (
        <b className="bead" data-cart-badge="" aria-hidden="true">
          {f.number(count)}
        </b>
      ) : null}
    </LocaleLink>
  );
}

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

/** The phone search pill: a link to /search (it works without script) that opens the search sheet. */
function SearchPill({ onOpen }: { onOpen: () => void }) {
  const t = useShellT();
  return (
    <LocaleLink
      to="/search"
      prefetch="none"
      className="shell-pill"
      aria-haspopup="dialog"
      data-press="soft"
      onClick={(event) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen();
      }}
    >
      <Icon name="magnifying-glass" size={20} />
      <span className="shell-pill__text">
        <span className="shell-pill__short">{t("search.short")}</span>
        <span className="shell-pill__long">{t("search.placeholder")}</span>
      </span>
    </LocaleLink>
  );
}

export function Header({ shell, task = null, demo, onSearch, searchQuery }: HeaderProps) {
  const t = useShellT();
  const location = useLocation();
  const path = splitLocale(location.pathname).path;
  const sentinel = useRef<HTMLDivElement>(null);
  const scrolled = useScrolled(sentinel);
  const title = usePageTitle(task !== null && scrolled);
  const categories = shell?.nav.categories ?? [];
  const games = categories.find((category) => category.slug === "games");
  const accessories = categories.find((category) => category.slug === "accessories");
  const currentPlatform = /^\/platform\/([^/?#]+)/.exec(path)?.[1] ?? null;
  const here = (href: string) => (path === href || path.startsWith(`${href}/`) ? ("page" as const) : undefined);

  return (
    <>
      <div ref={sentinel} className="shell-sentinel" aria-hidden="true" />
      <Glass as="header" className="shell-header" data-scrolled={scrolled ? "" : undefined} data-task={task ? "" : undefined} data-motion-persist="header">
        <div className="page shell-bar">
          {task ? <TaskBack to={task.back} /> : null}
          <Lockup />
          {task && title ? (
            // the page's own <h1> names the page for assistive technology; this is its visual echo on the bar
            <p className="shell-task shell-task--title" aria-hidden="true">
              {title}
            </p>
          ) : null}
          <SearchPill onOpen={onSearch} />
          <SearchForm variant="header" query={searchQuery} />
          <div className="shell-end">
            <div className="shell-links">
              <TextLink as={LocaleLink} to="/trade-in" icon="recycle" arrow={false}>
                {t("links.tradeIn")}
              </TextLink>
              <TextLink as={LocaleLink} to="/track" icon="package" arrow={false}>
                {t("links.track")}
              </TextLink>
            </div>
            <div className="shell-tools">
              <span className="shell-desk">
                <LanguageMenu />
              </span>
              <Menu
                label={t("tools.account")}
                align="end"
                items={[
                  { id: "account", kind: "link", icon: "user", label: t("tools.account"), href: "/account" },
                  { id: "track", kind: "link", icon: "package", label: t("links.track"), href: "/track" },
                  { id: "trade-in", kind: "link", icon: "recycle", label: t("links.tradeIn"), href: "/trade-in" },
                ]}
                trigger={(props) => <IconKey {...props} variant="plain" icon={<Icon name="user" size={24} />} label={t("tools.account")} className="shell-desk shell-narrow" />}
              />
              <IconKey as={LocaleLink} to="/account" variant="plain" icon={<Icon name="user" size={24} />} label={t("tools.account")} className="shell-wide" />
              <IconKey as={LocaleLink} to="/wishlist" variant="plain" icon={<Icon name="heart" size={24} />} label={t("tools.wishlist")} className="shell-desk" />
              <CartButton />
            </div>
          </div>
        </div>
        <div className="page shell-navrow">
          <PlatformNav platforms={shell?.nav.platforms ?? []} current={currentPlatform}>
            <span className="shell-navsep" aria-hidden="true" />
            {games ? (
              <LocaleLink to={games.href} className="shell-navitem" aria-current={here(games.href)}>
                {games.label || t("nav.games")}
              </LocaleLink>
            ) : null}
            {accessories ? (
              <LocaleLink to={accessories.href} className="shell-navitem shell-navitem--roomy" aria-current={here(accessories.href)}>
                {accessories.label || t("nav.accessories")}
              </LocaleLink>
            ) : null}
            <LocaleLink to="/used" className="shell-navitem" aria-current={here("/used")}>
              {t("nav.used")}
            </LocaleLink>
            <LocaleLink to="/support" className="shell-navitem" aria-current={here("/support")}>
              {t("nav.support")}
            </LocaleLink>
          </PlatformNav>
          {demo ? (
            <div className="shell-navend">
              <DemoNote variant="chip" />
            </div>
          ) : null}
        </div>
        <PageProgress />
      </Glass>
    </>
  );
}

/** The task header's back key: real history Back when an earlier page of this site is in the tab, else a link. */
function TaskBack({ to }: { to: string }) {
  const t = useShellT();
  const navigate = useNavigate();
  const back = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!isPlainClick(event)) return;
    // React Router numbers the entries it created in this tab; idx 0 = the page the shopper arrived on
    const state = window.history.state as { idx?: number } | null;
    if (typeof state?.idx === "number" && state.idx > 0) {
      event.preventDefault();
      void navigate(-1);
    }
  };
  return (
    <span className="shell-task shell-task--back">
      <IconKey as={LocaleLink} to={to} variant="plain" icon={<Icon name="arrow-left" size={24} />} label={t("tools.back")} onClick={back} />
    </span>
  );
}

/**
 * The checkout shell's one bar (v2 §5.8): back to the cart · the mascot (home) · the step rail from `?step=` (numbers
 * and labels; below 430px the numbers and the current label) · «طلب تجريبي» in demo mode · help. 56px, 64 from 1024.
 */
export function CheckoutBar({ demo }: { demo: boolean }) {
  const t = useShellT();
  const location = useLocation();
  const rail = checkoutRail(location.search);

  return (
    <Glass as="header" className="shell-cobar" data-motion-persist="header">
      <div className="page shell-cobar__bar">
        <IconKey as={LocaleLink} to="/cart" variant="plain" icon={<Icon name="arrow-left" size={24} />} label={t("checkout.back")} className="shell-cobar__back" />
        <LocaleLink to="/" className="shell-cobar__brand text-logo" aria-label={t("checkout.home")}>
          <Logo variant="mark" className="shell-lockup__mark" />
          <Logo variant="wordmark" className="shell-lockup__word" />
        </LocaleLink>
        <ProgressSteps
          className="shell-cobar__steps"
          aria-label={t("checkout.steps.label")}
          current={rail.current}
          steps={rail.steps.map((step) => ({ label: t(`checkout.steps.${step.id}`), href: step.href ?? undefined }))}
        />
        {demo ? (
          <span className="shell-cobar__tag" title={t("demo.orderHint")}>
            <DemoNote variant="tag">
              <span className="shell-cobar__long">{t("demo.order")}</span>
              <span className="shell-cobar__short">{t("demo.orderShort")}</span>
            </DemoNote>
          </span>
        ) : null}
        <IconKey as={LocaleLink} to="/support" variant="plain" icon={<Icon name="question" size={24} />} label={t("checkout.help")} className="shell-cobar__help" />
      </div>
      <PageProgress />
    </Glass>
  );
}
