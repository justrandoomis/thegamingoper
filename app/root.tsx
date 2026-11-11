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
import { DEFAULT_LOCALE, LOCALES } from "~/lib/locales";
import { useNonce } from "~/lib/nonce";
import { DEFAULT_PREFS, PrefsProvider, usePrefs } from "~/lib/prefs";
import { MOTION_TIER_SCRIPT } from "~/motion/tier-script";
import { getCtx, requestContextMiddleware } from "~/server/context.server";
import { loadShell } from "~/server/shell.server";
import { fontPreloadLinks } from "~/styles/fonts";
import "./app.css";

export const middleware: Route.MiddlewareFunction[] = [requestContextMiddleware];

/** Brand files (public/, see scripts/logo/assets.mjs): favicons, the home-screen icon and the web app manifest. */
export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "48x48" },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  { rel: "manifest", href: "/site.webmanifest" },
];

/**
 * Browser chrome colour = the floor of each theme. Light is the manifest's theme_color; dark is --ground of the
 * dark theme (app/styles/tokens.css). Two metas with media queries follow the system; an explicit choice paints
 * both with its colour (ThemeSync keeps them in step after a switch).
 */
// lint-design: allow raw-colour — <meta name="theme-color"> needs literal colours; they mirror site.webmanifest and tokens.css
const THEME_COLOR = { light: "#F3EFEC", dark: "#16171B" } as const;

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
export function shouldRevalidate({ formMethod, currentUrl, nextUrl, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod.toUpperCase() !== "GET") return true;
  // Language is part of the path: reload shell strings when the locale prefix changes.
  const localeOf = (pathname: string) => pathname.split("/")[1] ?? "";
  if (localeOf(currentUrl.pathname) !== localeOf(nextUrl.pathname)) return defaultShouldRevalidate;
  return false;
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
  return (
    <html lang={LOCALES[locale].bcp47} dir={LOCALES[locale].dir} data-theme={theme} data-store-mode={data?.storeMode} suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="color-scheme" content="light dark" />
        <meta name="theme-color" media="(prefers-color-scheme: light)" content={theme === "dark" ? THEME_COLOR.dark : THEME_COLOR.light} />
        <meta name="theme-color" media="(prefers-color-scheme: dark)" content={theme === "light" ? THEME_COLOR.light : THEME_COLOR.dark} />
        {/* the two critical font files of this language's script (app/styles/fonts.ts) */}
        {fontPreloadLinks(LOCALES[locale].script).map((font) => (
          <link key={font.href} rel="preload" as="font" href={font.href} type={font.type} crossOrigin="anonymous" />
        ))}
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
      <Outlet />
    </PrefsProvider>
  );
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
  const { pathname } = useLocation();
  const inAdmin = pathname === "/admin" || pathname.startsWith("/admin/");
  // The admin gate's refusals carry the employee's admin language (gate.server.ts): English admins read English first.
  const adminEnglish = inAdmin && isRouteErrorResponse(error) && (error.data as { locale?: string } | null)?.locale === "en";
  let status = 500;
  let title = "حدث خطأ غير متوقع";
  let detail = "تعذّر تحميل الصفحة. حاول مرة أخرى بعد قليل.";
  let english: string | null = inAdmin ? "Something went wrong. Please try again in a moment." : null;
  let englishTitle = "Something went wrong";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    if (error.status === 404) {
      title = "الصفحة غير موجودة";
      detail = "الرابط الذي فتحته غير صحيح أو أن الصفحة نُقلت.";
      englishTitle = "Page not found";
      if (inAdmin) english = "This page does not exist.";
    } else if (error.status === 403) {
      title = "غير مسموح";
      detail = inAdmin ? "صلاحيات دورك لا تشمل هذا القسم. اطلبها من مالك المتجر إن كنت تحتاجها." : "لا تملك صلاحية الوصول إلى هذه الصفحة.";
      englishTitle = "Not allowed";
      if (inAdmin) english = "Your role does not include this section. Ask the store owner if you need it.";
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    detail = error.message;
    stack = error.stack;
  }

  if (adminEnglish && english) {
    return (
      <main className="root-error" lang="en" dir="ltr">
        <p className="root-error__code">{status}</p>
        <h1>{englishTitle}</h1>
        <p>{english}</p>
        <p lang="ar" dir="rtl">
          {detail}
        </p>
        <a href="/admin">Back to the admin</a>
      </main>
    );
  }

  return (
    <main className="root-error">
      <p className="root-error__code" dir="ltr">{status}</p>
      <h1>{title}</h1>
      <p>{detail}</p>
      {english ? (
        <p lang="en" dir="ltr">
          {english}
        </p>
      ) : null}
      {inAdmin ? (
        <a href="/admin">
          العودة إلى لوحة الإدارة{" "}
          <bdi lang="en" dir="ltr">
            · Back to the admin
          </bdi>
        </a>
      ) : (
        <a href="/">العودة إلى الرئيسية</a>
      )}
      {stack ? (
        <pre dir="ltr">
          <code>{stack}</code>
        </pre>
      ) : null}
    </main>
  );
}
