/**
 * Which <SharedElement> instance owns a name right now.
 *
 * A product can be on screen several times (two rails on the home page). Only the instance the shopper actually
 * touched may carry the shared name into the navigation, otherwise the morph could start from the wrong card.
 * Instances register here; a press inside a link "claims" the shared elements it contains.
 *
 * Without View Transitions (older Safari and Firefox) the morph is a FLIP on the destination instead, which needs
 * to know where the element was on the page being left: claims and Back/Forward record those boxes here.
 *
 * Browser-only state; nothing is written on the server.
 */
import type { ShareRef } from "./nav-plan";
import { supportsViewTransitions } from "./vt";

type Instance = { name: string; slot: string | null; arm: (armed: boolean) => void; isArmed: () => boolean };

const byElement = new WeakMap<Element, Instance>();
const byName = new Map<string, Set<Instance>>();
const elements = new Map<Instance, Element>();
const boxes = new Map<string, { rect: DOMRect; at: number }>();
let lastClaim: { ref: ShareRef; at: number } | null = null;

export function registerShare(element: Element, instance: Instance): () => void {
  byElement.set(element, instance);
  elements.set(instance, element);
  let set = byName.get(instance.name);
  if (!set) byName.set(instance.name, (set = new Set()));
  set.add(instance);
  return () => {
    byElement.delete(element);
    elements.delete(instance);
    set.delete(instance);
    if (set.size === 0) byName.delete(instance.name);
  };
}

function remember(name: string, element: Element): void {
  boxes.set(name, { rect: element.getBoundingClientRect(), at: performance.now() });
}

/** Arm every shared element inside `scope` (the pressed link or card) and disarm same-named ones elsewhere. */
export function claimWithin(scope: Element): void {
  const found: Element[] = scope.hasAttribute("data-share") ? [scope] : [];
  for (const el of scope.querySelectorAll("[data-share]")) found.push(el);
  for (const element of found) {
    const instance = byElement.get(element);
    if (!instance) continue;
    for (const other of byName.get(instance.name) ?? []) other.arm(other === instance);
    lastClaim = { ref: { name: instance.name, slot: instance.slot }, at: performance.now() };
    if (!supportsViewTransitions()) remember(instance.name, element);
  }
}

/** The shared element claimed by the press that is starting a navigation (recent claims only). */
export function recentClaim(maxAgeMs = 5000): ShareRef | null {
  if (!lastClaim || performance.now() - lastClaim.at > maxAgeMs) return null;
  return lastClaim.ref;
}

/** Back/Forward without View Transitions: record where the armed shared elements are before the page changes. */
export function rememberArmed(): void {
  if (supportsViewTransitions()) return;
  for (const [instance, element] of elements) if (instance.isArmed()) remember(instance.name, element);
}

/** Where an element with this name was on the page being left, if that was recorded within `maxAgeMs`. Read once. */
export function takeBox(name: string, maxAgeMs = 5000): DOMRect | null {
  const box = boxes.get(name);
  boxes.delete(name);
  return box && performance.now() - box.at <= maxAgeMs ? box.rect : null;
}
