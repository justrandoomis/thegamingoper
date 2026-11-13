// First on purpose: app.css states the store's CSS layer order, and the first sheet a browser meets fixes that order.
// Any module below that brings its own sheet (the 404 view's not-found.css, through RootNotFound) comes after it.
import "./app.css";
import { useEffect } from "react";
import {
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteLoaderData,
  type ShouldRevalidateFunctionArgs,
} from "react-router";

import type { Route } from "./+types/root";
import { listNamespaces, messagesFor } from "~/i18n/i18n.server";
import { DEFAULT_LOCALE, LOCALES, localePath, splitLocale, type Locale } from "~/lib/locales";
import { useNonce } from "~/lib/nonce";
import { DEFAULT_PREFS, PrefsProvider, usePrefs } from "~/lib/prefs";
import { MOTION_TIER_SCRIPT } from "~/motion/tier-script";
import { RootNotFound } from "~/routes/storefront/content/components/RootNotFound";
import { getCtx, requestContextMiddleware } from "~/server/context.server";
import { loadShell } from "~/server/shell.server";
import { preloadFonts } from "~/styles/fonts";
import { showToast } from "~/ui/toast-store";

export const middleware: Route.MiddlewareFunction[] = [requestContextMiddleware];

/** Brand files (public/, see scripts/logo/assets.mjs): favicons, the home-screen icon and the web app manifest. */
export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
];

/**
 * Browser chrome colour = the page floor (--ground) of each theme in app/styles/tokens.css (Design System v2); the
 * light one is also site.webmanifest's theme_color. Two metas with media queries follow the system; an explicit
 * choice paints both with its colour (ThemeSync keeps them in step after a switch).
 */
// lint-design: allow raw-colour — <meta name="theme-color"> needs literal colours; they mirror site.webmanifest and tokens.css
const THEME_COLOR = { light: "#FDFCFA", dark: "#121316" } as const;

/**
 * The words of `errors.offline` (app/i18n/messages/errors.ts) and its retry, copied here because this boundary stays
 * dependency-free: it must render even when the strings of the failed page never arrived.
 */
const OFFLINE_TEXT = {
  ar: { message: "لا يوجد اتصال بالإنترنت. أعد المحاولة عند عودة الاتصال.", retry: "أعد المحاولة" },
  en: { message: "No internet connection. Try again when you are back online.", retry: "Try again" },
  ckb: { message: "هێڵی ئینتەرنێت نییە. کاتێک هێڵ گەڕایەوە دووبارە هەوڵ بدەرەوە.", retry: "دووبارە هەوڵ بدەرەوە" },
} as const satisfies Record<Locale, { message: string; retry: string }>;

/**
 * A request that never reached the store: the browser is offline, or its fetch failed at the network level
 * ("Failed to fetch" in Chromium, "NetworkError…" in Firefox, "Load failed" in Safari). Only in the browser — on the
 * server a TypeError is the store's own failure and stays a 500.
 */
function isOfflineError(error: unknown): boolean {
  if (typeof window === "undefined") return false;
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  return error instanceof TypeError && /failed to fetch|networkerror|network error|load failed|network connection was lost/i.test(error.message);
}

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const shell = await loadShell(ctx);
  return {
    locale: ctx.locale,
    dir: ctx.dir,
    prefs: ctx.prefs,
    storeMode: ctx.storeMode,
    origin: ctx.origin,
    nonce: ctx.nonce,
    ...shell,
    // "common" plus every design-system namespace ("ui", "ui-*") is available on every page.
    i18n: messagesFor(ctx.locale, ...listNamespaces().filter((ns) => ns === "common" || ns === "ui" || ns.startsWith("ui-"))),
  };
}

export type RootLoaderData = Awaited<ReturnType<typeof loader>>;

/** Root data is refreshed after mutations (cart badge, sign-in) but not on plain navigations. */
export function shouldRevalidate({ formMethod, actionResult, currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  // A form that failed because the device is offline changed nothing on the server: reloading the root data would
  // only fail again and replace the page (and its kept form values) with an error.
  if (isOfflineResult(actionResult)) return false;
  if (formMethod && formMethod.toUpperCase() !== "GET") return true;
  // Language is part of the path: reload shell strings when the locale prefix changes.
  const localeOf = (pathname: string) => pathname.split("/")[1] ?? "";
  if (localeOf(currentUrl.pathname) !== localeOf(nextUrl.pathname)) return defaultShouldRevalidate;
  return false;
}

/** An action answer of the form `{ ok: false, code: "network" | "offline" }` (the support forms send it). */
function isOfflineResult(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const result = value as { ok?: unknown; code?: unknown };
  return result.ok === false && (result.code === "network" || result.code === "offline");
}

/** Sets data-theme before first paint when the shopper follows the system setting. */
const THEME_SCRIPT = `(function(){try{var d=document.documentElement;if(d.dataset.theme==="system"){d.dataset.theme=matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light";d.dataset.themeSource="system"}}catch(e){}})()`;

export function Layout({ children }: { children: React.ReactNode }) {
  const data = useRouteLoaderData("root") as RootLoaderData | undefined;
  const locale = data?.locale ?? DEFAULT_LOCALE;
  const theme = data?.prefs.theme ?? DEFAULT_PREFS.theme;
  // Root data is missing when a page fails before any loader ran (the admin gate refuses in middleware): the nonce
  // then comes from the server render or from the document (app/lib/nonce.tsx), the same on both sides.
  const nonce = useNonce(data?.nonce);
  // The two critical font files of this language's script (app/styles/fonts.ts), through React's preload():
  // React hoists them into <head> once — <link> elements were fetched twice in development (StrictMode remounts).
  preloadFonts(LOCALES[locale].script);
  return (
    <html lang={LOCALES[locale].bcp47} dir={LOCALES[locale].dir} data-theme={theme} data-store-mode={data?.storeMode} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content={theme === "dark" ? THEME_COLOR.dark : THEME_COLOR.light} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={theme === "light" ? THEME_COLOR.light : THEME_COLOR.dark} />
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} suppressHydrationWarning />
        {/* Motion tier (data-motion + fx-low) before first paint — see app/motion/tier-script.ts */}
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: MOTION_TIER_SCRIPT }} suppressHydrationWarning />
        <Meta />
        {/* The same nonce on both sides (root data, else app/lib/nonce.tsx), so server and client render the same attribute. */}
        <Links nonce={nonce} />
      </head>
      <body>
        {children}
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  return (
    <PrefsProvider value={loaderData.prefs}>
      <ThemeSync />
      <OfflineNavigationGuard locale={loaderData.locale} />
      <Outlet />
    </PrefsProvider>
  );
}

/**
 * While the device is offline, a storefront link or a GET form would make React Router fetch a route module it cannot
 * load, and it then reloads the whole page into the browser's own "not connected" screen — the shopper loses the
 * page, the shell and the offline banner (QA 2026-11-12). Keep them where they are and say why. The admin is left
 * alone (its POS till has its own offline mode); POST forms answer offline themselves.
 */
function OfflineNavigationGuard({ locale }: { locale: Locale }) {
  useEffect(() => {
    const refuse = () => showToast({ tone: "warning", title: OFFLINE_TEXT[locale].message, id: "offline-navigation" });
    const inStore = () => !(location.pathname === "/admin" || location.pathname.startsWith("/admin/"));
    const onClick = (event: MouseEvent) => {
      if (navigator.onLine || event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || !inStore()) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || anchor.hasAttribute("download")) return;
      if (anchor.target && anchor.target !== "_self") return;
      const url = new URL(anchor.href, location.href);
      if (url.origin !== location.origin) return;
      // The same page with another query (a filter, a page of results, a tab of the rewards history): its route
      // module is already loaded, so no full reload can happen — the page answers offline itself (the listings hold
      // the tap until the connection is back; pages that read nothing new just switch).
      if (url.pathname === location.pathname) return;
      event.preventDefault();
      refuse();
    };
    const onSubmit = (event: SubmitEvent) => {
      if (navigator.onLine || event.defaultPrevented || !inStore() || !(event.target instanceof HTMLFormElement)) return;
      const method = (event.submitter?.getAttribute("formmethod") || event.target.getAttribute("method") || "get").toLowerCase();
      if (method !== "get") return;
      // A GET form that stays on this page (filters, the help-centre search): the page answers offline itself.
      const action = new URL(event.submitter?.getAttribute("formaction") || event.target.getAttribute("action") || location.href, location.href);
      if (action.origin === location.origin && action.pathname === location.pathname) return;
      event.preventDefault();
      refuse();
    };
    // Capture on window: runs before React's own listeners, so React Router's <Link> sees the click already handled.
    window.addEventListener("click", onClick, true);
    window.addEventListener("submit", onSubmit, true);
    return () => {
      window.removeEventListener("click", onClick, true);
      window.removeEventListener("submit", onSubmit, true);
    };
  }, [locale]);
  return null;
}

/** Keeps <html data-theme> in step with the preference store after the shopper switches theme. */
function ThemeSync() {
  const { theme } = usePrefs();
  useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      if (theme === "system") {
        root.dataset.theme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
        root.dataset.themeSource = "system";
      } else {
        root.dataset.theme = theme;
        delete root.dataset.themeSource;
      }
      // browser chrome follows: system → each media query its own colour; an explicit choice → that colour on both
      for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"][media]')) {
        const forDark = meta.media.includes("dark");
        meta.content = theme === "system" ? (forDark ? THEME_COLOR.dark : THEME_COLOR.light) : THEME_COLOR[theme];
      }
    };
    apply();
    if (theme !== "system") return;
    const media = matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  return null;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  // Deliberately dependency-free: this renders when anything above the storefront/admin shells fails — and for the
  // admin gate's refusals, which are thrown in middleware before any loader runs (React Router then renders the
  // highest boundary with a loader: this one, without the admin's strings). Admin pages get the admin's two
  // languages and a way back into the admin instead of the storefront home. The path decides wording only.
  const { pathname, search } = useLocation();
  const inAdmin = pathname === "/admin" || pathname.startsWith("/admin/");

  // Offline is never "our side" (Design System v2 §9): no status code, the page's own language, and a retry that
  // simply opens the same address again once the connection is back.
  if (isOfflineError(error)) {
    const locale: Locale = inAdmin ? DEFAULT_LOCALE : splitLocale(pathname).locale;
    const words = OFFLINE_TEXT[locale];
    return (
      <main className="root-error" lang={LOCALES[locale].bcp47} dir={LOCALES[locale].dir} data-offline="">
        <h1>{words.message}</h1>
        {inAdmin ? (
          <p lang="en" dir="ltr">
            {OFFLINE_TEXT.en.message}
          </p>
        ) : null}
        <a href={`${pathname}${search}`}>{words.retry}</a>
      </main>
    );
  }

  const status = isRouteErrorResponse(error) ? error.status : 500;
  const kind: ErrorKind = status === 404 ? "notFound" : status === 403 ? "forbidden" : "error";
  const retryHref = `${pathname}${search}`;
  // In development an unexpected error shows its message and stack under the page (never in production).
  const devError = !isRouteErrorResponse(error) && import.meta.env.DEV && error instanceof Error ? error : null;
  const devDetails = devError ? (
    <pre dir="ltr">
      <code>{`${devError.message}\n${devError.stack ?? ""}`}</code>
    </pre>
  ) : null;

  if (!inAdmin) {
    // The storefront shell's own wording (shell.ts) in the page's language (Design System v2 §6.16).
    const locale = splitLocale(pathname).locale;
    // A page that is not there: the store's own 404 view, the same as inside the shell (v2.1, client note 11).
    if (kind === "notFound") return <RootNotFound locale={locale} />;
    const words = STORE_ERROR_TEXT[locale];
    return (
      <main className="root-error" lang={LOCALES[locale].bcp47} dir={LOCALES[locale].dir}>
        <p className="root-error__code" dir="ltr">
          {status}
        </p>
        <h1>{words[kind].title}</h1>
        {words[kind].text ? <p>{words[kind].text}</p> : null}
        {kind === "error" ? <a href={retryHref}>{words.retry}</a> : null}
        <a href={localePath("/", locale)}>{words.home}</a>
        {devDetails}
      </main>
    );
  }

  // The admin gate's refusals carry the employee's admin language (gate.server.ts): one language when it is known,
  // both (on separate lines) when it is not.
  const adminLocale = isRouteErrorResponse(error) ? (error.data as { locale?: string } | null)?.locale : undefined;
  const languages: ("ar" | "en")[] = adminLocale === "en" ? ["en"] : adminLocale === "ar" ? ["ar"] : ["ar", "en"];
  const first = ADMIN_ERROR_TEXT[languages[0]];
  return (
    <main className="root-error" lang={languages[0] === "en" ? "en" : "ar-IQ"} dir={languages[0] === "en" ? "ltr" : "rtl"}>
      <p className="root-error__code" dir="ltr">
        {status}
      </p>
      <h1>{first[kind].title}</h1>
      {languages.map((language) => (
        <p key={language} lang={language === "en" ? "en" : "ar-IQ"} dir={language === "en" ? "ltr" : "rtl"}>
          {ADMIN_ERROR_TEXT[language][kind].text}
        </p>
      ))}
      {kind === "error" ? <a href={retryHref}>{languages.map((language) => ADMIN_ERROR_TEXT[language].retry).join(" · ")}</a> : null}
      {languages.map((language) => (
        <a key={language} href="/admin" lang={language === "en" ? "en" : "ar-IQ"} dir={language === "en" ? "ltr" : "rtl"}>
          {ADMIN_ERROR_TEXT[language].back}
        </a>
      ))}
      {devDetails}
    </main>
  );
}

type ErrorKind = "notFound" | "forbidden" | "error";
type ErrorWords = Record<ErrorKind, { title: string; text: string | null }>;

/** The storefront shell's error words (app/i18n/messages/shell.ts), copied: this boundary stays dependency-free. */
const STORE_ERROR_TEXT: Record<Locale, ErrorWords & { retry: string; home: string }> = {
  ar: {
    notFound: { title: "لم نجد هذه الصفحة", text: null },
    forbidden: { title: "لا يمكنك فتح هذه الصفحة", text: "هذه الصفحة لحساب آخر. سجّل الدخول بالحساب الصحيح، أو افتح رابط الطلب من جديد." },
    error: { title: "تعذّر عرض هذه الصفحة", text: "حدث خطأ من جهتنا، وليس منك. أعد المحاولة بعد قليل." },
    retry: "أعد المحاولة",
    home: "العودة إلى الرئيسية",
  },
  en: {
    notFound: { title: "We could not find this page", text: null },
    forbidden: { title: "You cannot open this page", text: "This page belongs to another account. Sign in with the right account, or open the order link again." },
    error: { title: "This page could not be shown", text: "Something went wrong on our side, not yours. Try again in a moment." },
    retry: "Try again",
    home: "Back to the home page",
  },
  ckb: {
    notFound: { title: "ئەم پەڕەیەمان نەدۆزییەوە", text: null },
    forbidden: { title: "ناتوانیت ئەم پەڕەیە بکەیتەوە", text: "ئەم پەڕەیە هی هەژمارێکی ترە. بە هەژماری دروست بچۆ ژوورەوە، یان بەستەری داواکارییەکە دووبارە بکەرەوە." },
    error: { title: "نەتوانرا ئەم پەڕەیە پیشان بدرێت", text: "هەڵەیەک لە لایەن ئێمەوە ڕوویدا، نەک لە لایەن تۆوە. دوای کەمێک دووبارە هەوڵ بدەرەوە." },
    retry: "دووبارە هەوڵ بدەرەوە",
    home: "گەڕانەوە بۆ پەڕەی سەرەکی",
  },
};

const ADMIN_ERROR_TEXT: Record<"ar" | "en", ErrorWords & { retry: string; back: string }> = {
  ar: {
    notFound: { title: "الصفحة غير موجودة", text: "الرابط الذي فتحته غير صحيح أو أن الصفحة نُقلت." },
    forbidden: { title: "غير مسموح", text: "صلاحيات دورك لا تشمل هذا القسم. اطلبها من مالك المتجر إن كنت تحتاجها." },
    error: { title: "تعذّر عرض هذه الصفحة", text: "حدث خطأ من جهتنا. أعد المحاولة بعد قليل." },
    retry: "أعد المحاولة",
    back: "العودة إلى لوحة الإدارة",
  },
  en: {
    notFound: { title: "Page not found", text: "This page does not exist." },
    forbidden: { title: "Not allowed", text: "Your role does not include this section. Ask the store owner if you need it." },
    error: { title: "This page could not be shown", text: "Something went wrong on our side. Try again in a moment." },
    retry: "Try again",
    back: "Back to the admin",
  },
};
