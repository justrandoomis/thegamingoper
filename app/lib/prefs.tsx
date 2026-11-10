/**
 * Shopper preferences: theme, display currency, numeral system.
 *
 * They live in one small cookie (`tt_prefs`) so the server renders the right theme and prices on the
 * first byte (no flash), and in a tiny client store so switching is instant — no request, no reload,
 * cart and form state untouched. Language is NOT here: it is part of the URL.
 *
 * Server safety: nothing request-specific is kept in module state on the server. During SSR the value
 * comes from <PrefsProvider> (React context); the module-level store is only ever written in the browser.
 */
import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import { isCurrency, type CurrencyCode, type NumberingSystem } from "./money";

export type Theme = "light" | "dark" | "system";
export type Prefs = { theme: Theme; currency: CurrencyCode; numbering: NumberingSystem };

export const DEFAULT_PREFS: Prefs = { theme: "system", currency: "IQD", numbering: "latn" };
export const PREFS_COOKIE = "tt_prefs";
const ONE_YEAR = 60 * 60 * 24 * 365;

/** Cookie value is compact: "<theme>.<currency>.<numbering>", e.g. "dark.USD.latn". */
export function parsePrefs(raw: string | null | undefined): Prefs {
  if (!raw) return DEFAULT_PREFS;
  const [theme, currency, numbering] = raw.split(".");
  return {
    theme: theme === "light" || theme === "dark" || theme === "system" ? theme : DEFAULT_PREFS.theme,
    currency: isCurrency(currency) ? currency : DEFAULT_PREFS.currency,
    numbering: numbering === "arab" || numbering === "latn" ? numbering : DEFAULT_PREFS.numbering,
  };
}

export function serializePrefs(prefs: Prefs): string {
  return `${prefs.theme}.${prefs.currency}.${prefs.numbering}`;
}

export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

// --- browser store (never written during SSR) --------------------------------

let current: Prefs = DEFAULT_PREFS;
let initialised = false;
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const ServerPrefs = createContext<Prefs>(DEFAULT_PREFS);

/** Rendered once in the root route with the cookie value read by the root loader. */
export function PrefsProvider({ value, children }: { value: Prefs; children: ReactNode }) {
  if (typeof document !== "undefined" && !initialised) {
    initialised = true;
    current = value;
  }
  return <ServerPrefs value={value}>{children}</ServerPrefs>;
}

/** Reactive preferences (SSR-safe). */
export function usePrefs(): Prefs {
  const server = useContext(ServerPrefs);
  return useSyncExternalStore(
    subscribe,
    () => (initialised ? current : server),
    () => server,
  );
}

export function getPrefs(): Prefs {
  return current;
}

/** Browser only. Updates the cookie and every subscribed component immediately. */
export function setPrefs(patch: Partial<Prefs>): void {
  if (typeof document === "undefined") return;
  current = { ...current, ...patch };
  initialised = true;
  const secure = location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${PREFS_COOKIE}=${serializePrefs(current)}; Path=/; Max-Age=${ONE_YEAR}; SameSite=Lax${secure}`;
  for (const listener of listeners) listener();
}

/** Resolve "system" against the OS setting (browser only; returns "light" on the server). */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  if (typeof matchMedia === "undefined") return "light";
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
