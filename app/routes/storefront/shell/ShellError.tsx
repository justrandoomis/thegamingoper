/**
 * What the storefront shows inside its shell when a page cannot be shown — rendered by the layout's ErrorBoundary,
 * in the shopper's language, with the header, tab bar and footer still around it:
 *
 *   404  "لم نجد هذه الصفحة" + the search field + the platforms + back home
 *   403  "لا يمكنك فتح هذه الصفحة" + back home
 *   503  "المتجر لا يستجيب الآن" (the database could not be reached) + try again + back home
 *   else "تعذّر عرض هذه الصفحة" + try again + back home; in development also the message and the stack
 *
 * "Try again" is a plain link to the same address (a full reload), so it works whatever broke. No red: none of
 * these keys moves an order forward.
 */
import { isRouteErrorResponse, useLocation } from "react-router";

import { LocaleLink } from "~/i18n/react";
import { Key } from "~/ui/Key";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { usePlatformName } from "./MegaMenu";
import { SearchForm } from "./SearchForm";
import { useShellT } from "./i18n";
import type { NavPlatform } from "./types";

export function ShellError({ error, platforms }: { error: unknown; platforms: NavPlatform[] }) {
  const t = useShellT();
  const location = useLocation();
  const nameOf = usePlatformName();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  const kind = status === 404 ? "notFound" : status === 403 ? "forbidden" : status === 503 ? "unavailable" : "error";
  const debug = import.meta.env.DEV && error instanceof Error ? error : null;

  return (
    <section className="page shell-error" aria-labelledby="shell-error-title">
      <p className="shell-error__code" dir="ltr" aria-hidden="true">
        {status}
      </p>
      <h1 id="shell-error-title" className="type-title">
        {t(`error.${kind}Title`)}
      </h1>
      <p className="type-body shell-error__text">{t(`error.${kind}Text`)}</p>
      {kind !== "notFound" ? <p className="type-caption text-ink-2">{t("error.code", { code: status })}</p> : null}

      {kind === "notFound" ? <SearchForm className="shell-error__search" /> : null}

      <div className="flex flex-wrap items-center justify-center gap-3">
        {kind === "error" || kind === "unavailable" ? (
          <Key as="a" href={`${location.pathname}${location.search}`} icon="arrows-clockwise">
            {t("error.retry")}
          </Key>
        ) : null}
        <Key as={LocaleLink} to="/" icon="house">
          {t("error.home")}
        </Key>
      </div>

      {kind === "notFound" && platforms.length > 0 ? (
        <nav aria-label={t("error.browse")} className="flex flex-col items-center gap-1">
          <p className="type-caption text-ink-2">{t("error.browse")}</p>
          <ul className="flex flex-wrap justify-center gap-x-5">
            {platforms.map((platform) => (
              <li key={platform.slug} data-gel={isPlatform(platform.accent) ? platform.accent : undefined}>
                <LocaleLink to={platform.href} className="link">
                  {isPlatform(platform.accent) ? <PlatformLed solid /> : null}
                  <span className="link__text">{nameOf(platform)}</span>
                </LocaleLink>
              </li>
            ))}
          </ul>
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
