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
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";

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

export function Header({ shell }: { shell: ShellData | null }) {
  const t = useShellT();
  const f = useFormat();
  const { count } = useCartCount();
  const sentinel = useRef<HTMLDivElement>(null);
  const header = useRef<HTMLElement>(null);
  const scrolled = useScrolled(sentinel);

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
      <header ref={header} className="shell-header" data-scrolled={scrolled ? "" : undefined} data-motion-persist="header">
        {scrolled ? <Glass className="shell-header__glass" aria-hidden="true" /> : null}
        <div className="page shell-header__bar">
          <LocaleLink to="/" className="shell-logo text-logo" aria-label={t("brandHome")}>
            <Logo variant="wordmark" className="shell-logo__word" />
            <Logo variant="mark" className="shell-logo__mark" />
          </LocaleLink>

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
            <Glass as={LocaleLink} to="/cart" variant="static" className="shell-cart" aria-label={t("tools.cartCount", { count })} data-cart-target="" data-press="icon">
              <Icon name="shopping-bag" size={20} />
              {count > 0 ? (
                <b className="bead" data-cart-badge="" aria-hidden="true">
                  {f.number(count)}
                </b>
              ) : null}
            </Glass>
          </div>
        </div>
      </header>
    </>
  );
}
