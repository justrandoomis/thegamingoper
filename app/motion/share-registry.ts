/**
 * Which <SharedElement> instance owns a name right now.
 *
 * A product can be on screen several times (two rails on the home page). Only the instance the shopper actually
 * touched may carry the shared name into the navigation, otherwise the morph could start from the wrong card.
 * Instances register here; a press inside a link "claims" the shared elements it contains.
 *
 * Browser-only state; nothing is written on the server.
 */
import type { ShareRef } from "./nav-plan";

type Instance = { name: string; slot: string | null; arm: (armed: boolean) => void };

const byElement = new WeakMap<Element, Instance>();
const byName = new Map<string, Set<Instance>>();
let lastClaim: { ref: ShareRef; at: number } | null = null;

export function registerShare(element: Element, instance: Instance): () => void {
  byElement.set(element, instance);
  let set = byName.get(instance.name);
  if (!set) byName.set(instance.name, (set = new Set()));
  set.add(instance);
  return () => {
    byElement.delete(element);
    set.delete(instance);
    if (set.size === 0) byName.delete(instance.name);
  };
}

/** Arm every shared element inside `scope` (the pressed link or card) and disarm same-named ones elsewhere. */
export function claimWithin(scope: Element): void {
  const elements: Element[] = scope.hasAttribute("data-share") ? [scope] : [];
  for (const el of scope.querySelectorAll("[data-share]")) elements.push(el);
  for (const element of elements) {
    const instance = byElement.get(element);
    if (!instance) continue;
    for (const other of byName.get(instance.name) ?? []) other.arm(other === instance);
    lastClaim = { ref: { name: instance.name, slot: instance.slot }, at: performance.now() };
  }
}

/** The shared element claimed by the press that is starting a navigation (recent claims only). */
export function recentClaim(maxAgeMs = 5000): ShareRef | null {
  if (!lastClaim || performance.now() - lastClaim.at > maxAgeMs) return null;
  return lastClaim.ref;
}
