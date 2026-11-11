/**
 * The navigation grammar as data — which transition a navigation should play. Pure (unit-tested), no React, no DOM.
 *
 *   zoom           shared-element card → detail: the world zooms toward the tapped thing
 *   push-forward   sideways to a neighbouring context that comes later (mirrored for RTL in CSS)
 *   push-back      sideways to a neighbour that comes earlier
 *   rise           a sheet-like child page lifts over the page beneath it
 *   fade           the default: a short dissolve with a small settle
 *   direction      language switch: out toward the old reading direction's end, in from the new start
 *
 * Back navigation plays the reverse of whatever brought the shopper to the page they are leaving.
 */

/** What callers ask for (links, hooks, route handles). `push` resolves to forward/back from sibling order. */
export type NavKind = "fade" | "zoom" | "push" | "rise" | "direction";

/** What ends up on `<html data-nav>` while the transition runs. */
export type NavName = "fade" | "zoom" | "push-forward" | "push-back" | "rise" | "direction";

export type NavPoint = { x: number; y: number };

/** The shared element that was tapped to start a navigation (so Back can morph into the same card). */
export type ShareRef = { name: string; slot: string | null };

/** One side of a navigation, derived from the location and the matched routes' `handle`. */
export type NavDescriptor = {
  /** `location.key` */
  key: string;
  pathname: string;
  search: string;
  /** Position among siblings (route `handle.order`), or null. */
  order: number | null;
  /** Sibling group: `handle.group`, or the id of the parent of the route that declares the handle. */
  group: string | null;
  /** `handle.nav` of the deepest route that declares one. */
  nav: Exclude<NavKind, "direction"> | null;
};

/** An explicit request for the next navigation (`<MotionLink nav>` / `useNavIntent()`). */
export type NavIntent = {
  nav: NavKind;
  /** Sibling order of the destination, for `push`. */
  order?: number | null;
  /** Play the reverse (an in-page "back" link that pushes a new entry). */
  back?: boolean;
  /** Tap point in viewport px — the zoom origin. */
  origin?: NavPoint | null;
};

/** How a history entry was arrived at; remembered so Back/Forward can replay it. */
export type NavRecord = {
  nav: NavName;
  /** True when the transition is played in reverse (`data-nav-dir="back"`). */
  back: boolean;
  origin: NavPoint | null;
  share: ShareRef | null;
};

export type NavPlan = NavRecord & {
  /** Sibling order the destination ends up with (handle order or the intent's). */
  order: number | null;
  /** Reading direction of the page being left (filled in by the browser-side planner; used by "direction"). */
  fromDir?: "rtl" | "ltr";
};

export type ResolveInput = {
  /** React Router's navigation type for the destination. */
  type: "PUSH" | "POP" | "REPLACE";
  /** History index delta for POP (−1 = Back, +1 = Forward), null when unknown. */
  delta: number | null;
  from: NavDescriptor;
  to: NavDescriptor;
  /** Explicit intent for this navigation, if any (ignored for POP). */
  intent: NavIntent | null;
  /** Record of the entry being left: how the shopper got to `from`. */
  arrivedBy: NavRecord | null;
  /** Record of the entry being entered, when it has been visited before (Forward). */
  destination: NavRecord | null;
  /** Sibling order of the page being left when its route handle does not say (set by an earlier intent). */
  fromOrder: number | null;
  /** Shared element claimed by the tap that started this navigation. */
  claim: ShareRef | null;
};

/** The transition that undoes `record`. */
export function reverseNav(record: Pick<NavRecord, "nav" | "back">): Pick<NavRecord, "nav" | "back"> {
  if (record.nav === "push-forward") return { nav: "push-back", back: true };
  if (record.nav === "push-back") return { nav: "push-forward", back: false };
  return { nav: record.nav, back: !record.back };
}

function pushByOrder(from: number | null, to: number | null): NavName | null {
  if (from === null || to === null || from === to) return null;
  return to > from ? "push-forward" : "push-back";
}

/**
 * Decide the transition for one navigation, or null for "no page transition" (same page with only the
 * query or hash changing, unless something asked for one).
 */
export function resolveNav(input: ResolveInput): NavPlan | null {
  const { from, to, intent, type } = input;
  const samePage = from.pathname === to.pathname;
  const fromOrder = from.order ?? input.fromOrder;
  const sameGroup = from.group === to.group;
  const structural = sameGroup ? pushByOrder(fromOrder, to.order) : null;

  if (type === "POP") {
    if (input.delta === -1 && input.arrivedBy) {
      const reversed = reverseNav(input.arrivedBy);
      return { ...reversed, origin: input.arrivedBy.origin, share: input.arrivedBy.share, order: to.order };
    }
    if (input.delta === 1 && input.destination) {
      return { ...input.destination, order: to.order };
    }
    // No memory of this step (reload, deep link, a jump of several entries): fall back to structure.
    if (structural) return { nav: structural, back: structural === "push-back", origin: null, share: null, order: to.order };
    if (samePage) return null;
    return { nav: "fade", back: input.delta !== null && input.delta < 0, origin: null, share: null, order: to.order };
  }

  if (intent) {
    const origin = intent.origin ?? null;
    const order = intent.order ?? to.order;
    if (intent.nav === "push") {
      const byOrder = pushByOrder(fromOrder, order);
      const nav: NavName = byOrder ?? (intent.back ? "push-back" : "push-forward");
      return { nav, back: nav === "push-back", origin, share: null, order };
    }
    // A tapped shared element morphs whatever the page does; remember it so Back can morph into the same card.
    return { nav: intent.nav, back: intent.back === true, origin, share: intent.nav === "direction" ? null : input.claim, order };
  }

  if (structural) return { nav: structural, back: structural === "push-back", origin: null, share: null, order: to.order };
  if (samePage) return null;
  if (to.nav === "push") return { nav: "push-forward", back: false, origin: null, share: null, order: to.order };
  return { nav: to.nav ?? "fade", back: false, origin: null, share: input.claim, order: to.order };
}
