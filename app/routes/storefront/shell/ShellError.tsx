/**
 * What the storefront shows inside its shell when a page cannot be shown (Design System v2 §5.11, §6.16) — rendered by
 * the layout's ErrorBoundary, in the shopper's language, with the header, the tab bar and the footer still around it.
 * The kit's empty-state anatomy (a picture, a title that says what happened, one sentence of what to do, the actions):
 *
 *   404      the mascot · «لم نجد هذه الصفحة» · the search field (focused on desktop) · home and the support centre ·
 *            the four platforms as compact tiles
 *   403/401  «لا يمكنك فتح هذه الصفحة» · sign in, or open the order link again · home
 *   503      «المتجر لا يستجيب الآن» · try again · home · the error code
 *   offline  a request that never reached the store (the device is offline, "Failed to fetch"): «لا يوجد اتصال
 *            بالإنترنت» · try again when back online. Never "500", never "an error on our side"; the icon is inline
 *            (the sprite may not be cached).
 *   else     «تعذّر عرض هذه الصفحة» · try again · home · the error code; in development also the message and the stack
 *
 * "Try again" after a server error is a plain link to the same address (a full reload works whatever broke); offline it
 * re-runs the page's loaders instead (a reload would show the browser's own offline page). One red key at most: the
 * retry, the action that moves the shopper on.
 */
import { useEffect, useRef, type MouseEvent } from "react";
import { useLocation, useRevalidator } from "react-router";

import { Icon } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { LocaleLink } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { cx } from "~/ui/cx";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { TextLink } from "~/ui/TextLink";
import { PlatformTilesCompact } from "./CategoriesSheet";
import { canonicalSearch, errorKind } from "./chrome";
import { useShellT } from "./i18n";
import { SearchForm } from "./SearchForm";
import type { NavPlatform } from "./types";

/** Phosphor wifi-slash, inline: the icon sprite itself may not be in the cache when the connection is gone. */
function WifiSlash() {
  return (
    <svg viewBox="0 0 256 256" width={32} height={32} fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M213.92,210.62a8,8,0,1,1-11.84,10.76l-52-57.15a60,60,0,0,0-57.41,7.24,8,8,0,1,1-9.42-12.93A75.43,75.43,0,0,1,128,144c1.28,0,2.55,0,3.82.1L104.9,114.49A108,108,0,0,0,61,135.31,8,8,0,0,1,49.73,134,8,8,0,0,1,51,122.77a124.27,124.27,0,0,1,41.71-21.66L69.37,75.4a155.43,155.43,0,0,0-40.29,24A8,8,0,0,1,18.92,87,171.87,171.87,0,0,1,58,62.86L42.08,45.38A8,8,0,1,1,53.92,34.62ZM128,192a12,12,0,1,0,12,12A12,12,0,0,0,128,192ZM237.08,87A172.3,172.3,0,0,0,106,49.4a8,8,0,1,0,2,15.87A158.33,158.33,0,0,1,128,64a156.25,156.25,0,0,1,98.92,35.37A8,8,0,0,0,237.08,87ZM195,135.31a8,8,0,0,0,11.24-1.3,8,8,0,0,0-1.3-11.24,124.25,124.25,0,0,0-51.73-24.2A8,8,0,1,0,150,114.24,108.12,108.12,0,0,1,195,135.31Z" />
    </svg>
  );
}

export function ShellError({ error, platforms }: { error: unknown; platforms: NavPlatform[] }) {
  const t = useShellT();
  const location = useLocation();
  const online = useOnline();
  const revalidator = useRevalidator();
  const { kind, status } = errorKind(error, online);
  const debug = import.meta.env.DEV && error instanceof Error && kind === "error" ? error : null;
  const search = useRef<HTMLInputElement | null>(null);

  // the 404's field is focused on desktop (on a phone that would raise the keyboard over the page)
  useEffect(() => {
    if (kind === "notFound" && window.matchMedia("(min-width: 64rem)").matches) search.current?.focus();
  }, [kind]);

  // the query in the server's spelling, so the link hydrates unchanged (./chrome canonicalSearch)
  const here = `${location.pathname}${canonicalSearch(location.search)}`;

  return (
    <section className="page shell-error" aria-labelledby="shell-error-title">
      <div className={cx("empty", kind !== "notFound" && "empty--error")}>
        <span className="empty__art" aria-hidden="true">
          {kind === "notFound" ? <Logo variant="mark" className="shell-error__mark text-logo" /> : kind === "offline" ? <WifiSlash /> : <Icon name="warning-circle" size={32} />}
        </span>
        <h1 id="shell-error-title" className="empty__title">
          {t(`error.${kind}Title`)}
        </h1>
        <p className="empty__text">{t(`error.${kind}Text`)}</p>

        {kind === "notFound" ? <SearchForm variant="panel" className="shell-error__search" inputRef={search} /> : null}

        <div className="empty__actions">
          {kind === "offline" || kind === "error" || kind === "unavailable" ? (
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

      {kind === "notFound" && platforms.length > 0 ? (
        <nav className="shell-error__browse" aria-labelledby="shell-error-browse">
          <h2 id="shell-error-browse" className="shell-error__browse-title">
            {t("error.browse")}
          </h2>
          <PlatformTilesCompact platforms={platforms} className="shell-error__tiles" />
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
