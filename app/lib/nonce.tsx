/**
 * The request's CSP nonce for the document's own inline scripts and links, the same on the server and in the browser.
 *
 * Normally it comes from root loader data. When a page fails before any loader runs (the admin gate refuses in
 * middleware, so the root ErrorBoundary renders without root data), the server still knows it — app/entry.server.tsx
 * provides it through NonceContext — and the browser reads it back from a script the server emitted with it
 * (browsers hide the attribute's value but keep `element.nonce`). Without this, the error page rendered its inline
 * scripts without the nonce (blocked by the production CSP) and React logged a hydration mismatch on <Links>.
 */
import { createContext, useContext } from "react";

export const NonceContext = createContext<string | undefined>(undefined);

export function useNonce(fromData: string | undefined): string | undefined {
  const fromServer = useContext(NonceContext);
  if (fromData) return fromData;
  if (fromServer) return fromServer;
  if (typeof document === "undefined") return undefined;
  return document.querySelector<HTMLScriptElement>("script[nonce]")?.nonce || undefined;
}
