/**
 * What the shell's chrome can do, as one hook: sign out (this device or all), switch the admin language, switch
 * theme, collapse the rail. Client-side wrappers — the work happens in /admin/logout and /admin/locale (POST only;
 * the root middleware refuses cross-site posts) or in the browser (theme and rail are per-device preferences).
 */
import { useCallback, useMemo } from "react";
import { useLocation, useNavigate, useRouteLoaderData, useSubmit } from "react-router";

import { setPrefs, type Theme } from "~/lib/prefs";
import { ADMIN_LAYOUT_ID } from "./meta";
import type { AdminShellData } from "./shell.server";

export const RAIL_COOKIE_NAME = "tt_admin_rail";

/** The admin layout's data (null outside the layout, or when its loader failed). */
export function useAdminShell(): AdminShellData | null {
  const data = useRouteLoaderData(ADMIN_LAYOUT_ID) as { shell?: AdminShellData } | undefined;
  return data?.shell ?? null;
}

export function useShellActions() {
  const submit = useSubmit();
  const navigate = useNavigate();
  const location = useLocation();
  const here = `${location.pathname}${location.search}${location.hash}`;

  const signOut = useCallback((scope: "one" | "all") => submit({ scope }, { method: "post", action: "/admin/logout" }), [submit]);
  const setLocale = useCallback((locale: "ar" | "en") => submit({ locale, back: here }, { method: "post", action: "/admin/locale" }), [submit, here]);
  const setTheme = useCallback((theme: Theme) => setPrefs({ theme }), []);
  const setRail = useCallback((rail: "expanded" | "collapsed") => {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${RAIL_COOKIE_NAME}=${rail}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax${secure}`;
  }, []);
  const go = useCallback((href: string) => navigate(href), [navigate]);

  return useMemo(() => ({ signOut, setLocale, setTheme, setRail, go }), [signOut, setLocale, setTheme, setRail, go]);
}
