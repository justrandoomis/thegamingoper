/**
 * Recommendation signals from the browser (POST /api/events — app/routes/api/events.ts).
 *
 *   sendRecommendationEvent({ kind: "view", productId, source: "pdp" });     // the product page (integration pass)
 *   const ref = useShelfSignals("device_hub");  <div ref={ref}>…shelves…</div>   // clicks on cards in shelves
 *
 * Nothing is sent unless this device said yes to personalization (`personalizationConsent` from the root loader —
 * the `tt_consent` cookie); the server checks the consent again and does nothing without it. A signal is fire and
 * forget: `navigator.sendBeacon` (survives the navigation the click starts), else a keepalive fetch; a failure is
 * silent because the shopper's action never depends on it. No identifier is built here: the server keys a guest by
 * its own first-party cookie, a customer by the session.
 */
import { useEffect, useRef } from "react";
import { useRouteLoaderData } from "react-router";

export type ClientSignal = { kind: "view" | "click" | "add"; productId: string; source?: string | null };

type RootConsent = { personalizationConsent?: boolean | null };

/** Sends one signal (call it only when the root data says the shopper consented — useConsentedSignals does). */
export function sendRecommendationEvent(signal: ClientSignal): void {
  if (typeof window === "undefined") return;
  const body = new URLSearchParams({ kind: signal.kind, productId: signal.productId });
  if (signal.source) body.set("source", signal.source);
  try {
    if (typeof navigator.sendBeacon === "function" && navigator.sendBeacon("/api/events", body)) return;
  } catch {
    // fall back to fetch
  }
  void fetch("/api/events", { method: "POST", body, credentials: "same-origin", keepalive: true }).catch(() => undefined);
}

/** True when this device said yes to personalization (root loader data). */
export function useSignalConsent(): boolean {
  const root = useRouteLoaderData("root") as RootConsent | undefined;
  return root?.personalizationConsent === true;
}

/**
 * A ref for a container of shelves: a click on a product card's link (`[data-product]`, inside `[data-shelf]`)
 * becomes a "click" signal whose source is the shelf's key, prefixed with `prefix` when it is not already ("device_hub:versions")
 * — the click-through of that shelf. Consent only. Used units are not products and send nothing.
 */
export function useShelfSignals(prefix: string) {
  const consent = useSignalConsent();
  const element = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = element.current;
    if (!node || !consent) return;
    const onClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const card = target?.closest<HTMLElement>("[data-product]");
      if (!card || !target?.closest("a[href]") || !node.contains(card)) return;
      const productId = card.dataset.product;
      const shelf = card.closest<HTMLElement>("[data-shelf]")?.dataset.shelf;
      const source = !shelf ? prefix : shelf.startsWith(`${prefix}:`) ? shelf : `${prefix}:${shelf}`;
      if (productId) sendRecommendationEvent({ kind: "click", productId, source: source.slice(0, 64) });
    };
    node.addEventListener("click", onClick);
    return () => node.removeEventListener("click", onClick);
  }, [consent, prefix]);
  return element;
}
