/**
 * What the storefront shows inside its shell when a page cannot be shown (Design System v2 §5.11, §6.16) — rendered by
 * the layout's ErrorBoundary, in the shopper's language, with the header, the tab bar and the footer still around it.
 * The kit's empty-state anatomy (a picture, a title that says what happened, one sentence of what to do, the actions):
 *
 *   404      the mascot · «لم نجد هذه الصفحة» · home and the support centre · the four platforms as compact tiles. The
 *            one search field is the header's (focused on desktop; on a phone the header's search pill is right there).
 *   product  a product address that led nowhere (the product page's 404 carries `what: "product"` and the slug's
 *            words): «هذا المنتج لم يعد متوفراً أو تغيّر رابطه» · «ابحث عن …» with those words (they are also in the
 *            header's field and the phone search sheet) · the newest consoles of the platform the words name (else
 *            the four platform tiles) · the used devices
 *   403/401  «لا يمكنك فتح هذه الصفحة» · sign in, or open the order link again · home
 *   503      «المتجر لا يستجيب الآن» · try again · home · the error code
 *   offline  a request that never reached the store (the device is offline, "Failed to fetch"): «لا يوجد اتصال
 *            بالإنترنت» · «أعد المحاولة عند عودة الاتصال.» — word for word `errors.offline`, the root boundary's
 *            sentence (app/root.tsx), so the shopper reads one wording wherever the failure lands; what is kept (the
 *            cart, what was typed) is the offline banner's to say. Never "500", never "an error on our side"; the icon
 *            is inline (the sprite may not be cached).
 *   else     «تعذّر عرض هذه الصفحة» · try again · home · the error code; in development also the message and the stack
 *
 * "Try again" after a server error is a plain link to the same address (a full reload works whatever broke); offline it
 * re-runs the page's loaders instead (a reload would show the browser's own offline page). One red key at most: the
 * retry, or the product's search — the action that moves the shopper on.
 */
import { useEffect, type MouseEvent } from "react";
import { useLocation, useRevalidator } from "react-router";

import { Icon } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { LocaleLink } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { BidiText } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { TextLink } from "~/ui/TextLink";
import { PlatformTilesCompact, ShellRow } from "./CategoriesSheet";
import { canonicalSearch, errorKind, missingProduct, platformForQuery } from "./chrome";
import { useShellT } from "./i18n";
import { usePlatformName } from "./MegaMenu";
import type { NavPlatform } from "./types";

/** Phosphor wifi-slash, inline: the icon sprite itself may not be in the cache when the connection is gone. */
function WifiSlash() {
  return (
    <svg viewBox="0 0 256 256" width={32} height={32} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M213.92,210.62a8,8,0,1,1-11.84,10.76l-52-57.15a60,60,0,0,0-57.41,7.24,8,8,0,1,1-9.42-12.93A75.43,75.43,0,0,1,128,144c1.28,0,2.55,0,3.82.1L104.9,114.49A108,108,0,0,0,61,135.31,8,8,0,0,1,49.73,134,8,8,0,0,1,51,122.77a124.27,124.27,0,0,1,41.71-21.66L69.37,75.4a155.43,155.43,0,0,0-40.29,24A8,8,0,0,1,18.92,87,171.87,171.87,0,0,1,58,62.86L42.08,45.38A8,8,0,1,1,53.92,34.62ZM128,192a12,12,0,1,0,12,12A12,12,0,0,0,128,192ZM237.08,87A172.3,172.3,0,0,0,106,49.4a8,8,0,1,0,2,15.87A158.33,158.33,0,0,1,128,64a156.25,156.25,0,0,1,98.92,35.37A8,8,0,0,0,237.08,87ZM195,135.31a8,8,0,0,0,11.24-1.3,8,8,0,0,0-1.3-11.24,124.25,124.25,0,0,0-51.73-24.2A8,8,0,1,0,150,114.24,108.12,108.12,0,0,1,195,135.31Z" />
    </svg>
  );
}

/** The header's search field (from 1024; below it the header has the search pill and the sheet). */
const HEADER_FIELD = '.shell-header .shell-search[data-variant="header"] input[type="search"]';

export function ShellError({ error, platforms }: { error: unknown; platforms: NavPlatform[] }) {
  const t = useShellT();
  const nameOf = usePlatformName();
  const location = useLocation();
  const online = useOnline();
  const revalidator = useRevalidator();
  const { kind, status } = errorKind(error, online);
  // a product address that led nowhere: the slug's words ("" when it had none), else null
  const product = kind === "notFound" ? missingProduct(error) : null;
  const platform = product ? platformForQuery(product, platforms) : null;
  const debug = import.meta.env.DEV && error instanceof Error && kind === "error" ? error : null;
  const title = product !== null ? t("error.productTitle") : t(`error.${kind}Title`);
  const text = product !== null ? t("error.productText") : t(`error.${kind}Text`);

  // the 404's one search field is the header's: focused on desktop (on a phone that would raise the keyboard over the
  // page); not for a missing product, whose words would open their suggestions over the panel — its key searches them
  useEffect(() => {
    if (kind !== "notFound" || product !== null || !window.matchMedia("(min-width: 64rem)").matches) return;
    document.querySelector<HTMLInputElement>(HEADER_FIELD)?.focus({ preventScroll: true });
  }, [kind, product]);

  // the query in the server's spelling, so the link hydrates unchanged (./chrome canonicalSearch)
  const here = `${location.pathname}${canonicalSearch(location.search)}`;

  return (
    <section className="page shell-error" aria-labelledby="shell-error-title">
      <div className={cx("empty", kind !== "notFound" && "empty--error")}>
        <span className="empty__art" aria-hidden="true">
          {kind === "notFound" ? <Logo variant="mark" className="shell-error__mark text-logo" /> : kind === "offline" ? <WifiSlash /> : <Icon name="warning-circle" size={32} />}
        </span>
        <h1 id="shell-error-title" className="empty__title">
          {title}
        </h1>
        <p className="empty__text">{text}</p>

        <div className="empty__actions">
          {product ? (
            <Key variant="primary" as={LocaleLink} to={`/search?${new URLSearchParams({ q: product })}`} icon="magnifying-glass">
              {t("error.searchFor", { q: "⁨" + product + "⁩" })}
            </Key>
          ) : null}
          {kind === "offline" || kind === "error" || kind === "unavailable" ? (
            // lint-design: allow primary-count — never in one view with the product's search key (a 404 has no retry)
            <Key
              variant="primary"
              as="a"
              href={here}
              icon="arrows-clockwise"
              loading={kind === "offline" && revalidator.state === "loading"}
              onClick={(event: MouseEvent<HTMLAnchorElement>) => {
                if (kind !== "offline") return;
                // offline, a reload would show the browser's own page: run the page's loaders again instead
                event.preventDefault();
                void revalidator.revalidate();
              }}
            >
              {t("error.retry")}
            </Key>
          ) : null}
          {kind === "forbidden" ? (
            <Key as={LocaleLink} to={`/account/login?next=${encodeURIComponent(splitLocale(location.pathname).path)}`} icon="sign-in">
              {t("error.signIn")}
            </Key>
          ) : null}
          {kind !== "offline" ? (
            <Key as={LocaleLink} to="/" icon="house">
              {t("error.home")}
            </Key>
          ) : null}
          {kind === "notFound" ? (
            <TextLink as={LocaleLink} to="/support">
              {t("error.help")}
            </TextLink>
          ) : null}
        </div>
        {kind === "error" || kind === "unavailable" ? (
          <p className="empty__ref">
            <span className="shell-error__ref">{t("error.code", { code: status })}</span>
          </p>
        ) : null}
      </div>

      {kind === "notFound" && platform ? (
        // a missing product whose words name a platform: under its name, its newest consoles, its consoles category
        // (by the category's own name — «حواسيب الألعاب المحمولة», never «أجهزة الأجهزة المحمولة»), its used devices
        <nav className="shell-error__browse" aria-labelledby="shell-error-browse">
          <h2 id="shell-error-browse" className="shell-error__browse-title">
            {nameOf(platform)}
          </h2>
          <ul className="shell-csheet__rows">
            {platform.consoles.map((link) => (
              <ShellRow key={link.href} to={link.href} icon="game-controller" title={<BidiText text={link.label} />} />
            ))}
            {platform.allConsoles ? <ShellRow to={platform.allConsoles.href} icon="squares-four" title={<BidiText text={platform.allConsoles.label} />} /> : null}
            <ShellRow to={platform.used?.href ?? "/used"} icon="recycle" title={t("footer.used")} />
          </ul>
        </nav>
      ) : kind === "notFound" && platforms.length > 0 ? (
        <nav className="shell-error__browse" aria-labelledby="shell-error-browse">
          <h2 id="shell-error-browse" className="shell-error__browse-title">
            {t("error.browse")}
          </h2>
          <PlatformTilesCompact platforms={platforms} className="shell-error__tiles" />
          {product !== null ? (
            <ul className="shell-csheet__rows">
              <ShellRow to="/used" icon="recycle" title={t("footer.used")} />
            </ul>
          ) : null}
        </nav>
      ) : null}

      {debug ? (
        <pre dir="ltr" className="shell-error__stack">
          <code>{`${debug.message}\n\n${debug.stack ?? ""}`}</code>
        </pre>
      ) : null}
    </section>
  );
}
