/**
 * The top of every storefront page (Design v2.1 "Clay & Glass", client notes 1 and 9; Design System v2 §5.1–§5.3, §5.8).
 * One sticky <header> for every width. It sits on the page floor at the top of the page; once the page has scrolled,
 * its frosted glass layer and the bar's edge fade in (opacity only).
 *
 *   BELOW 1024   56px: the lockup (the mascot + the wordmark; the wordmark alone below 375px) · the search pill that
 *                opens the full-screen search sheet («ابحث» below 430px, «ابحث عن جهاز أو لعبة» from 430) — or, on a page
 *                that is not for finding products (./chrome searchMode), only the round search key that opens the same
 *                sheet · the cart with its bead. Account and favourites live in the tab bar. The demo strip
 *                (./Banners) sits above it and scrolls away.
 *   FROM 1024    three rows:
 *                  the utility strip (36px): the delivery fee fact (and cash on delivery when the store takes it) ·
 *                    تتبّع طلبك · استبدل جهازك · الدعم · the three languages · the light / dark switch;
 *                  the main row (64px, after a 12px lead): the lockup, larger · the wide search well with its «/» hint
 *                    (search pages) or the round search key with the other keys (the rest) · round clay keys:
 *                    favourites, account, the cart with its count;
 *                  the nav row (44px): the four platforms (./MegaMenu: each with its device glyph in its colour light
 *                    and the mega-menu chevron) · الألعاب · الإكسسوارات (from 1280) · المستعمل · الصيانة · the demo chip;
 *                    an indicator in the platform's colour slides under the item the pointer or the focus is on.
 *                COMPACTING: the header sticks at minus (strip + lead), so the strip and the lead scroll away with the
 *                page, 1:1 — the sticky header is then 64 + 44 = 108px (`--shell-header-h`); the glass fades in and the
 *                lockup tightens. Transforms and opacity only: nothing below the header moves (CLS 0).
 *   TASK SCREENS pages with their own bottom task bar (handle `tabBar: false`, task flows) have no tab bar, so below 1024
 *                the header becomes the task header once the page has scrolled 24px: back · the page's <h1> · the cart.
 *                Back is real history Back when an earlier page of this site is in the tab, else a link to `task.back`.
 *   CHECKOUT     <CheckoutBar>: one 56px bar (64 from 1024) — back to the cart · the mascot (home) · the step rail · the
 *                «طلب تجريبي» tag · help. No strip, no search, no menus.
 *
 * The cart key is the fly-to-cart target (`data-cart-target`, drawn at every count) and its bead `data-cart-badge`.
 * Scrolling is observed with an IntersectionObserver on a sentinel at the top of the document (24px; from 1024 the
 * strip + the lead, so "scrolled" is the compact header) — no scroll listener.
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { useLocation, useNavigate } from "react-router";

import { Icon } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { LocaleLink, useFormat } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { formatMoney } from "~/lib/money";
import { cx } from "~/ui/cx";
import { useCartCount } from "~/ui/cart-client";
import { DemoNote } from "~/ui/DemoNote";
import { Glass } from "~/ui/Glass";
import { IconKey } from "~/ui/IconKey";
import { ProgressSteps } from "~/ui/ProgressSteps";
import { PageProgress } from "./Banners";
import { checkoutRail, clampWords, type SearchMode } from "./chrome";
import { useShellT } from "./i18n";
import { PlatformNav } from "./MegaMenu";
import { LanguageLinks, ThemeSwitch } from "./Preferences";
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
  /** The phone search pill or the round search key was pressed: open the search sheet. */
  onSearch: () => void;
  /** Words the desktop search field starts with (a missing product's slug words on its 404). */
  searchQuery?: string;
  /** The search field, or only the round search key (./chrome searchMode — the shell decides it by path). */
  search?: SearchMode;
};

/** True once the page has scrolled past the sentinel at the top of the document (its height is set in shell.css). */
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

/** The cart key with its bead: a round clay key, the fly-to-cart target at every count (the bead appears from 1). */
export function CartButton({ className }: { className?: string }) {
  const t = useShellT();
  const f = useFormat();
  const { count } = useCartCount();
  return (
    <LocaleLink
      to="/cart"
      className={cx("key key--round key--outline shell-cart", className)}
      aria-label={t("tools.cartCount", { count })}
      title={t("tools.cart")}
      data-cart-target=""
      data-press="icon"
    >
      <span className="key__cap">
        <Icon name="shopping-bag" size={22} />
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

/**
 * The round search key of the pages that are not for finding products (every width; ./chrome searchMode): a link to
 * /search (without script) that opens the same search sheet, its field focused — search stays one tap away.
 */
function SearchKey({ onOpen }: { onOpen: () => void }) {
  const t = useShellT();
  return (
    <IconKey
      as={LocaleLink}
      to="/search"
      prefetch="none"
      icon={<Icon name="magnifying-glass" size={22} />}
      label={t("search.label")}
      aria-haspopup="dialog"
      className="shell-searchkey"
      onClick={(event: MouseEvent<HTMLAnchorElement>) => {
        if (!isPlainClick(event)) return;
        event.preventDefault();
        onOpen();
      }}
    />
  );
}

/**
 * The desktop utility strip (from 1024 — the before's strip, client note 1): 36px over the main row, scrolling away
 * with the page. The delivery fee fact from the settings (and «الدفع عند الاستلام» while the store takes cash) · the
 * service links · the languages · the light / dark switch. Its links keep a 44px hit area over the strip's edges.
 */
function UtilityStrip({ shell }: { shell: ShellData | null }) {
  const t = useShellT();
  const f = useFormat();
  const location = useLocation();
  const path = splitLocale(location.pathname).path;
  const fee = shell ? "⁨" + formatMoney(shell.deliveryFeeIqd, "IQD", f.locale, f.numbering) + "⁩" : null;
  const here = (href: string) => (path === href || path.startsWith(`${href}/`) ? ("page" as const) : undefined);
  return (
    <div className="shell-utility">
      <div className="page shell-utility__row">
        {fee ? (
          <p className="shell-utility__fact">
            <Icon name="truck" size={18} />
            <span>{t("utility.delivery", { fee })}</span>
            {shell?.payments.cod ? (
              // from 1280 (the strip's room below that goes to the links)
              <span className="shell-utility__cod">
                <span className="shell-utility__dot" aria-hidden="true" />
                <span>{t("footer.pay.cod")}</span>
              </span>
            ) : null}
          </p>
        ) : (
          <span />
        )}
        <div className="shell-utility__end">
          <nav className="shell-utility__links" aria-label={t("utility.label")}>
            <LocaleLink to="/track" className="shell-utility__link" aria-current={here("/track")}>
              <Icon name="package" size={18} />
              {t("links.track")}
            </LocaleLink>
            <LocaleLink to="/trade-in" className="shell-utility__link" aria-current={here("/trade-in")}>
              <Icon name="recycle" size={18} />
              {t("links.tradeIn")}
            </LocaleLink>
            <LocaleLink to="/support" className="shell-utility__link" aria-current={path === "/support" ? "page" : undefined}>
              <Icon name="lifebuoy" size={18} />
              {t("nav.support")}
            </LocaleLink>
          </nav>
          <LanguageLinks />
          <ThemeSwitch />
        </div>
      </div>
    </div>
  );
}

export function Header({ shell, task = null, demo, onSearch, searchQuery, search = "field" }: HeaderProps) {
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
      <header
        className="shell-header"
        data-scrolled={scrolled ? "" : undefined}
        data-task={task ? "" : undefined}
        data-search={search}
        data-motion-persist="header"
      >
        {/* the frost: a layer behind the rows that fades in once the page has scrolled (opacity only) */}
        <Glass className="shell-header__glass" aria-hidden="true" />
        <UtilityStrip shell={shell} />
        <div className="page shell-bar">
          {task ? <TaskBack to={task.back} /> : null}
          <Lockup />
          {task && title ? <TaskTitle title={title} /> : null}
          {search === "field" ? (
            <>
              <SearchPill onOpen={onSearch} />
              <SearchForm variant="header" query={searchQuery} />
            </>
          ) : null}
          <div className="shell-end">
            <div className="shell-tools">
              {search === "key" ? <SearchKey onOpen={onSearch} /> : null}
              <IconKey as={LocaleLink} to="/wishlist" icon={<Icon name="heart" size={22} />} label={t("tools.wishlist")} className="shell-desk" aria-current={here("/wishlist")} />
              <IconKey as={LocaleLink} to="/account" icon={<Icon name="user" size={22} />} label={t("tools.account")} className="shell-desk" aria-current={here("/account")} />
              <CartButton />
            </div>
          </div>
        </div>
        <div className="page shell-navrow">
          <PlatformNav platforms={shell?.nav.platforms ?? []} current={currentPlatform} demo={demo}>
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
            <LocaleLink to="/support/repair" className="shell-navitem" aria-current={here("/support/repair")}>
              {t("nav.repair")}
            </LocaleLink>
          </PlatformNav>
          {demo ? (
            <div className="shell-navend">
              <DemoNote variant="chip" />
            </div>
          ) : null}
        </div>
        <PageProgress />
      </header>
    </>
  );
}

/**
 * The task header's title: the page's <h1> on one line, cut BETWEEN words with «…» at its logical end (./chrome
 * clampWords) — CSS alone cut «قاعدة الشحن DualSense Charging Station» inside the Latin name («…lSense Charging
 * Station»). A hidden probe in the same font measures each candidate; it runs again when the bar's width changes. The
 * page's own <h1> names the page for assistive technology; this is its visual echo on the bar.
 */
function TaskTitle({ title }: { title: string }) {
  const box = useRef<HTMLParagraphElement>(null);
  const probe = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(title);
  useLayoutEffect(() => {
    const element = box.current;
    const measure = probe.current;
    if (!element || !measure) return;
    const fit = () => {
      const room = element.clientWidth;
      // not laid out (from 1024 the task header is not used): the whole title
      if (room === 0) return setShown(title);
      const fitted = clampWords(title, (candidate) => {
        measure.textContent = candidate;
        return measure.getBoundingClientRect().width <= room;
      });
      // emptied again: a long candidate left in the probe would widen the title's scrollable area
      measure.textContent = "";
      setShown(fitted);
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [title]);
  return (
    <p ref={box} className="shell-task shell-task--title" aria-hidden="true">
      {shown}
      <span ref={probe} className="shell-task__probe" />
    </p>
  );
}

/**
 * The task header's back key: real history Back when an earlier page of this site is in the tab, else a link. A round
 * clay key like the cart key at the bar's other end (v2.1 G2: back is one of the clay circles).
 */
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
      <IconKey as={LocaleLink} to={to} icon={<Icon name="arrow-left" size={22} />} label={t("tools.back")} onClick={back} />
    </span>
  );
}

/**
 * The checkout shell's one bar (v2 §5.8): back to the cart · the mascot (home; on a narrow phone it gives way first) ·
 * the step rail from `?step=` (numbers and labels; below 600px the numbers and the current label, from 360 up) ·
 * «طلب تجريبي» in demo mode, whole at every width · help. 56px, 64 from 1024. Sizes: shell.css "checkout bar".
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
          // the glossary's «طلب تجريبي» at every width (never a short «تجريبي»): the mascot gives way first
          <span className="shell-cobar__tag" title={t("demo.orderHint")}>
            <DemoNote variant="tag">{t("demo.order")}</DemoNote>
          </span>
        ) : null}
        <IconKey as={LocaleLink} to="/support" variant="plain" icon={<Icon name="question" size={24} />} label={t("checkout.help")} className="shell-cobar__help" />
      </div>
      <PageProgress />
    </Glass>
  );
}
