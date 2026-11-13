/**
 * What the storefront shows inside its shell when a page cannot be shown (Design System v2 §5.11, §6.16; v2.1 client
 * note 11) — rendered by the layout's ErrorBoundary, in the shopper's language, with the header, the tab bar and the
 * footer still around it.
 *
 *   404      the store's 404 view (~/routes/storefront/content/components/NotFoundView — the same view the root boundary
 *            draws): the mascot in a circle · a big «404» · «لم نجد هذه الصفحة» · one line · the search field (the
 *            shell's own form with its suggestions, focused on desktop — `focusesNotFoundField`) · the clay «العودة
 *            إلى الرئيسية» with «مركز الدعم» beside it · «أو ابدأ من منصّتك» · the four platforms as compact tiles
 *            (their product counts and hardware photos from the navigation). Each address is a new view: a client
 *            navigation from one 404 to another starts the field over with the new address's words.
 *   product  a product address that led nowhere (the product page's 404 carries `what: "product"` and the slug's
 *            words): the same view with «هذا المنتج لم يعد متوفراً أو تغيّر رابطه» and its line, the field starting with
 *            those words (they are also in the header's field and the phone search sheet; not focused — their
 *            suggestions would open over the page), and the used devices under the tiles
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
 * retry. The 404 has none — its search field is the way on.
 */
import { useEffect, useRef, type MouseEvent } from "react";
import { useLocation, useRevalidator } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink } from "~/i18n/react";
import { splitLocale } from "~/lib/locales";
import { useRecentSearches } from "~/routes/storefront/catalog/components/recent-searches";
import { NotFoundView, type NotFoundPlatform } from "~/routes/storefront/content/components/NotFoundView";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { isPlatform } from "~/ui/PlatformLed";
import { TextLink } from "~/ui/TextLink";
import { canonicalSearch, errorKind, missingProduct } from "./chrome";
import { useShellT } from "./i18n";
import { usePlatformName } from "./MegaMenu";
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

/** Desktop: where focusing a field does not raise a keyboard over the page. */
const DESKTOP = "(min-width: 64rem)";

export function ShellError({ error, platforms }: { error: unknown; platforms: NavPlatform[] }) {
  const t = useShellT();
  const location = useLocation();
  const online = useOnline();
  const revalidator = useRevalidator();
  const { kind, status } = errorKind(error, online);
  // keyed by the address: between two 404s React would keep the last one's field (its words, what was typed, its
  // focus) — a missing product reached from a 404 showed an empty, focused field instead of the product's words
  if (kind === "notFound") return <NotFound key={`${location.pathname}${location.search}`} product={missingProduct(error)} platforms={platforms} />;

  const debug = import.meta.env.DEV && error instanceof Error && kind === "error" ? error : null;
  // the query in the server's spelling, so the link hydrates unchanged (./chrome canonicalSearch)
  const here = `${location.pathname}${canonicalSearch(location.search)}`;

  return (
    <section className="page shell-error" aria-labelledby="shell-error-title">
      <div className="empty empty--error">
        <span className="empty__art" aria-hidden="true">
          {kind === "offline" ? <WifiSlash /> : <Icon name="warning-circle" size={32} />}
        </span>
        <h1 id="shell-error-title" className="empty__title">
          {t(`error.${kind}Title`)}
        </h1>
        <p className="empty__text">{t(`error.${kind}Text`)}</p>

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
        </div>
        {kind === "error" || kind === "unavailable" ? (
          <p className="empty__ref">
            <span className="shell-error__ref">{t("error.code", { code: status })}</span>
          </p>
        ) : null}
      </div>

      {debug ? (
        <pre dir="ltr" className="shell-error__stack">
          <code>{`${debug.message}\n\n${debug.stack ?? ""}`}</code>
        </pre>
      ) : null}
    </section>
  );
}

/**
 * Whether the 404 focuses its search field on arrival (v2 §6.16: the field is the way on) — only where nothing then
 * opens over the page: on desktop (on a phone the keyboard would rise over it), for a plain 404 (a missing product's
 * words would open their suggestions over the panel), and while this device keeps no recent searches (focus opens
 * that list right over the home key and «مركز الدعم»).
 */
export function focusesNotFoundField({ product, desktop, keepsRecent }: { product: string | null; desktop: boolean; keepsRecent: boolean }): boolean {
  return desktop && product === null && !keepsRecent;
}

/**
 * The 404 inside the shell: the store's 404 view in the shell's words, with the shell's search form (suggestions and
 * recent searches) and the navigation's platforms. `product`: the words of a missing product's address ("" when it had
 * none), else null.
 */
function NotFound({ product, platforms }: { product: string | null; platforms: NavPlatform[] }) {
  const t = useShellT();
  const nameOf = usePlatformName();
  const field = useRef<HTMLInputElement | null>(null);
  // the same list the field opens on focus (catalog's recent searches: this device only, with consent)
  const recent = useRecentSearches();
  const keepsRecent = useRef(false);
  useEffect(() => {
    keepsRecent.current = recent.items.length > 0;
  });

  useEffect(() => {
    // one frame later: on a first load the device's recent searches are read only after hydration (the server render
    // has none), so the decision waits for them
    const frame = requestAnimationFrame(() => {
      if (focusesNotFoundField({ product, desktop: window.matchMedia(DESKTOP).matches, keepsRecent: keepsRecent.current })) field.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [product]);

  // a platform without one of the four colours is left out (no invented surface)
  const tiles: NotFoundPlatform[] = platforms.flatMap((platform) =>
    isPlatform(platform.accent) ? [{ platform: platform.accent, to: platform.href, name: nameOf(platform), count: platform.productCount, art: platform.artKey ?? undefined }] : [],
  );

  return (
    <NotFoundView
      words={{
        title: product !== null ? t("error.productTitle") : t("error.notFoundTitle"),
        text: product !== null ? t("error.productText") : t("error.notFoundText"),
        home: t("error.home"),
        help: t("error.help"),
        browse: t("error.browse"),
      }}
      search={<SearchForm variant="panel" query={product || undefined} inputRef={field} />}
      platforms={tiles}
      after={
        // «…أو تصفّح الأجهزة الجديدة والمستعملة»: the tiles are the new devices, this is the used ones
        product !== null ? (
          <TextLink as={LocaleLink} to="/used">
            {t("footer.used")}
          </TextLink>
        ) : null
      }
    />
  );
}
