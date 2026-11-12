import { data, isRouteErrorResponse, Outlet, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/_layout";
import { messagesFor, type I18nPayload } from "~/i18n/i18n.server";
import { isLocale } from "~/lib/locales";
import { PageTransition } from "~/motion";
import { getCtx } from "~/server/context.server";
import { missingProduct } from "./shell/chrome";
import { emptyStorefrontShell, loadStorefrontShell } from "./shell/data.server";
import { shellMeta } from "./shell/meta";
import { ShellError } from "./shell/ShellError";
import { ShellFrame } from "./shell/ShellFrame";
import type { ShellData } from "./shell/types";

/**
 * Storefront layout: validates the optional locale segment and renders the shopping shell (./shell/ShellFrame,
 * Design System v2 §5 — the demo strip, the header and its nav row with the mega menus, the search sheet, the tab bar,
 * the categories sheet, the footer, the checkout bar for `handle.shell.chrome = "checkout"`, the offline banner, the
 * page progress bar, toasts) around every customer page, its error pages included.
 *
 * Loader data: `shell` (navigation taxonomy, delivery fee, payment switches, contact details, PUBLIC_ORIGIN) and the
 * "shell" strings. A 404 for an unknown language prefix and a 503 when the store's data cannot be read are thrown
 * WITH the strings, so the error page inside the shell speaks the shopper's language.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const i18n = messagesFor(ctx.locale, "shell");
  let shell: ShellData;
  try {
    shell = await loadStorefrontShell(ctx);
  } catch (error) {
    if (ctx.isDev) {
      // Development without a migrated database: an empty shell, as the root loader does (app/server/shell.server.ts).
      console.warn(`[storefront] shell data unavailable — empty menus (run "npm run db:reset"): ${error instanceof Error ? error.message : String(error)}`);
      shell = emptyStorefrontShell(ctx);
    } else {
      // Production: a real failure, reported, and shown as "the store is not responding" inside the shell.
      console.error("[storefront] shell data failed", error);
      throw data({ error: "unavailable", i18n }, { status: 503 });
    }
  }
  // "/xyz" matches ":locale?" with locale = "xyz" — anything that is not a non-default locale code is a 404 (with the
  // shell's data, so the error page has its menus).
  if (params.locale !== undefined && (!isLocale(params.locale) || params.locale === "ar")) {
    throw data({ error: "not_found", i18n, shell }, { status: 404 });
  }
  return { shell, i18n };
}

/**
 * The shell's data changes with the language (labels, strings) and otherwise only when the catalogue does, so it is
 * not reloaded on every navigation: only when the locale prefix changes (or React Router's default asks after a
 * mutation that changed the locale). The cart badge comes from the root loader, which revalidates after mutations.
 */
export function shouldRevalidate({ currentParams, nextParams, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (currentParams.locale !== nextParams.locale) return defaultShouldRevalidate;
  return false;
}

export const meta: Route.MetaFunction = (args) => shellMeta(args);

export default function StorefrontLayout({ loaderData }: Route.ComponentProps) {
  return (
    <ShellFrame shell={loaderData.shell} messages={loaderData.i18n.shell}>
      <PageTransition>
        <Outlet />
      </PageTransition>
    </ShellFrame>
  );
}

export function ErrorBoundary({ error, loaderData }: Route.ErrorBoundaryProps) {
  // The layout's data when a page below failed; the strings thrown with the error when the layout's own loader did.
  const thrown = isRouteErrorResponse(error) ? (error.data as { i18n?: I18nPayload; shell?: ShellData } | null) : null;
  const messages = loaderData?.i18n.shell ?? thrown?.i18n?.shell;
  const shell = loaderData?.shell ?? thrown?.shell ?? null;
  // `errored`: the failed page's handle (e.g. a product's tabBar: false) no longer applies — its task bar is gone.
  // A missing product's slug words start the search fields (v2 §6.16 "search prefilled from the slug").
  return (
    <ShellFrame shell={shell} messages={messages} errored searchQuery={missingProduct(error) || undefined}>
      <ShellError error={error} platforms={shell?.nav.platforms ?? []} />
    </ShellFrame>
  );
}
