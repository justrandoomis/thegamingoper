/**
 * Page transitions and the navigation grammar.
 *
 *   <PageTransition><Outlet /></PageTransition>     in a layout, around the outlet
 *   <MotionLink nav="zoom" to="/p/abc">             a link that asks for a transition
 *   const intent = useNavIntent(); intent("rise")   before navigate() / a form submit
 *   export const handle = { nav: "push", order: 2 } siblings slide in the right direction automatically
 *
 * How it works (measured, see docs/MOTION.md §"What React and React Router actually do"):
 * React Router commits every navigation inside React.startTransition, so React can run a view transition for it.
 * <PageTransition> renders a 1px sentinel inside a keyed React <ViewTransition>; when a navigation should animate,
 * the key changes, React starts exactly one view transition for that commit, and the engine marks <html> with
 * data-nav / data-nav-dir so motion.css animates the viewport-sized root snapshots (transform + opacity only).
 * Nothing else is inside a <ViewTransition update> boundary, so fetchers, pending states and Suspense reveals never
 * trigger (or wait for) a page animation, and images outside shared elements never hold a navigation back.
 */
import {
  ViewTransition,
  createContext,
  memo,
  use,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from "react";
import { useLocation, useMatches, useNavigate, useNavigationType, type LinkProps, type Location } from "react-router";
import { LocaleLink } from "~/i18n/react";
import { switchLocalePath, type Locale } from "~/lib/locales";
import { getMotionTier, markJanky, useMotionTier } from "./env";
import type { NavDescriptor, NavIntent, NavKind, NavPlan, ShareRef } from "./nav-plan";
import { commitNavigation, getCommittedKey, noteLocation, planNavigation, setNavIntent } from "./nav-state";
import { easings, lowEnd, page as pageTokens } from "./tokens";
import { activeTransition, hurryWhenAwaited, isTransitionActive, supportsViewTransitions, watchFrames, whenTransitionEnds } from "./vt";

/**
 * Route `handle` fields the engine understands. Neighbouring routes (tabs, steps, a product and the next one)
 * declare an `order`; navigating between them pushes sideways in the right direction without any link props.
 *
 *   export const handle = { nav: "push", order: 2 } satisfies MotionHandle;
 *   export const handle = { nav: "push", order: ({ params }) => STEPS.indexOf(params.step!) } satisfies MotionHandle;
 *   export const handle = { nav: "rise" } satisfies MotionHandle;        // sheet-like child page
 */
export type MotionHandle = {
  nav?: Exclude<NavKind, "direction">;
  order?: number | ((at: { pathname: string; search: string; params: Record<string, string | undefined> }) => number | null | undefined);
  /** Sibling group; defaults to the parent route, which is right for routes registered side by side. */
  group?: string;
};

type MatchLike = { id: string; params: Record<string, string | undefined>; handle: unknown };

function describe(location: Location, matches: readonly MatchLike[]): NavDescriptor {
  let order: number | null = null;
  let group: string | null = null;
  let nav: NavDescriptor["nav"] = null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const handle = matches[i].handle as MotionHandle | null | undefined;
    if (!handle || (handle.nav === undefined && handle.order === undefined)) continue;
    const raw =
      typeof handle.order === "function"
        ? handle.order({ pathname: location.pathname, search: location.search, params: matches[i].params })
        : handle.order;
    order = typeof raw === "number" && Number.isFinite(raw) ? raw : null;
    group = handle.group ?? matches[i - 1]?.id ?? null;
    nav = handle.nav ?? null;
    break;
  }
  return { key: location.key, pathname: location.pathname, search: location.search, order, group, nav };
}

// --- running a transition ------------------------------------------------------------------------

let navToken = 0;

function clearNavigationMarks(): void {
  const root = document.documentElement;
  root.removeAttribute("data-nav");
  root.removeAttribute("data-nav-dir");
  for (const name of ["--nav-x", "--nav-y", "--nav-start"]) root.style.removeProperty(name);
  if (root.style.viewTransitionName === "root") root.style.viewTransitionName = "";
  releaseAnchors();
}

function finishNavigation(token: number): void {
  if (token !== navToken) return; // a newer navigation owns the marks
  clearNavigationMarks();
}

/** How long the page fades in when the browser has no View Transitions (DESIGN.md: "then a 120ms cross-fade"). */
const FALLBACK_FADE_MS = 120;

/**
 * Called from the layout effect of the navigation commit — inside React's view-transition update callback,
 * after the old page was captured and before the new one is.
 */
function playNavigation(plan: NavPlan, page: HTMLElement | null): void {
  if (!isTransitionActive()) {
    // React committed without a view transition (no browser support, or a synchronous commit): the new page still
    // arrives softly while a <SharedElement> target, if any, FLIPs from the card. Opacity only — a transform here
    // would re-anchor fixed descendants mid-animation.
    page?.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: FALLBACK_FADE_MS, easing: easings.settle });
    releaseAnchors();
    return;
  }
  const token = ++navToken;
  const root = document.documentElement;
  root.setAttribute("data-nav", plan.nav);
  root.setAttribute("data-nav-dir", plan.back ? "back" : "forward");
  if (plan.origin) {
    root.style.setProperty("--nav-x", `${Math.round(plan.origin.x)}px`);
    root.style.setProperty("--nav-y", `${Math.round(plan.origin.y)}px`);
  } else {
    root.style.removeProperty("--nav-x");
    root.style.removeProperty("--nav-y");
  }
  // <html dir> already belongs to the new page here. A language switch drifts toward the new reading direction's
  // start: the left for LTR (−1), the right for RTL (+1).
  if (plan.nav === "direction") root.style.setProperty("--nav-start", root.dir === "rtl" ? "1" : "-1");
  // React hides the root snapshot unless the root is explicitly part of the transition. The page animation is
  // the root snapshot (viewport-sized, so scroll offsets and fixed chrome need no special handling).
  root.style.viewTransitionName = "root";
  whenTransitionEnds(() => finishNavigation(token));
  const active = activeTransition();
  if (active) {
    // Content that becomes ready while the page is still animating must not wait for the animation.
    hurryWhenAwaited(active, pageTokens.hurry);
    // A device that cannot keep up drops to the low-end tier for the rest of the session (DESIGN.md §6.5).
    if (getMotionTier() === "full") watchFrames(active, lowEnd.longFrameMs, lowEnd.longFrames, markJanky);
  }
}

// --- anchors for the language switch ---------------------------------------------------------------

const ANCHOR_LIMIT = 6;
let anchored: HTMLElement[] = [];
let anchorTimer: ReturnType<typeof setTimeout> | undefined;
/** Where the first on-screen anchor was when the language switch was asked for. */
let anchorProbe: { element: HTMLElement; top: number } | null = null;

/**
 * Language switch: the stage and its render (`data-motion-anchor`) stay exactly where they are as the visual anchor
 * (DESIGN.md §7.2). Called right before the navigation:
 *  - the first anchor on screen is remembered, and once the other language has rendered the page is scrolled by
 *    however much the new text above it moved it, so it is still in the same place (every tier);
 *  - at the full tier each on-screen anchor also gets a view-transition name, so it does not slide with the content.
 * Names are released when the transition ends, or after 4 s if no switch happens.
 */
export function armAnchors(): void {
  releaseAnchors();
  if (typeof document === "undefined") return;
  const name = getMotionTier() === "full" && supportsViewTransitions();
  for (const element of document.querySelectorAll<HTMLElement>("[data-motion-anchor]")) {
    if (anchored.length >= ANCHOR_LIMIT) break;
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.bottom < 0 || rect.top > window.innerHeight) continue; // off screen: it travels with the page
    anchorProbe ??= { element, top: rect.top };
    if (name) {
      element.style.viewTransitionName = `tt-anchor-${anchored.length}`;
      element.style.setProperty("view-transition-class", "tt-anchor");
    }
    anchored.push(element);
  }
  if (anchored.length > 0) anchorTimer = setTimeout(releaseAnchors, 4000);
}

/** Runs in the commit of the language switch, before the new page is captured: put the first anchor back in place. */
function keepAnchorInPlace(): void {
  const probe = anchorProbe;
  anchorProbe = null;
  if (!probe || !probe.element.isConnected) return;
  const moved = probe.element.getBoundingClientRect().top - probe.top;
  if (Math.abs(moved) >= 1) window.scrollBy({ top: moved, behavior: "instant" });
}

function releaseAnchors(): void {
  clearTimeout(anchorTimer);
  for (const element of anchored) {
    element.style.viewTransitionName = "";
    element.style.removeProperty("view-transition-class");
  }
  anchored = [];
  anchorProbe = null;
}

/** React calls this when the sentinel's view transition starts; the returned function runs when it ends. */
function onSentinelEnter(): () => void {
  const token = navToken;
  return () => finishNavigation(token);
}

// --- the pop gate ----------------------------------------------------------------------------------

type Gate = { promise: Promise<void>; done: boolean };
const gates = new Map<string, Gate>();

/**
 * React renders a transition that was scheduled during `popstate` synchronously (so the browser can restore
 * scroll), and a synchronous commit cannot be a view transition. When Back/Forward needs no data — nothing to
 * await — that is exactly what happens and the page would just swap. This component notices that it is being
 * rendered inside the popstate event for a navigation that should animate and suspends for one macrotask;
 * React then finishes the same transition asynchronously, with the view transition. History and scroll
 * restoration are untouched: React Router has already moved the URL and restores scroll in its layout effect.
 */
const PopGate = memo(function PopGate({ locationKey, active }: { locationKey: string; active: boolean }) {
  if (active && typeof window !== "undefined") {
    let gate = gates.get(locationKey);
    if (!gate && window.event?.type === "popstate" && getCommittedKey() !== locationKey && supportsViewTransitions()) {
      const created: Gate = { promise: Promise.resolve(), done: false };
      created.promise = new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
          created.done = true;
          gates.delete(locationKey);
          channel.port1.close();
          resolve();
        };
        channel.port2.postMessage(0);
      });
      gates.set(locationKey, created);
      gate = created;
    }
    if (gate && !gate.done) use(gate.promise);
  }
  return null;
});

// --- <PageTransition> ------------------------------------------------------------------------------

export type NavContextValue = {
  /** `location.key` of the page being rendered. */
  key: string;
  /** Shared element that should pair with the page being left (set on Back so the right card is armed). */
  share: ShareRef | null;
};

/** Read by <SharedElement> and <Bubble>. */
export const NavContext = createContext<NavContextValue | null>(null);

type PageState = { at: NavDescriptor; seq: number; plan: NavPlan | null };

export type PageTransitionProps = {
  children: ReactNode;
  /** Class for the wrapper element around the page (a plain block `<div data-motion-page>`). */
  className?: string;
  style?: CSSProperties;
};

/**
 * Wrap the outlet of a layout. Keep it mounted across navigations (do not key it).
 * Nested layouts may each have one; a navigation is planned once.
 */
export function PageTransition({ children, className, style }: PageTransitionProps) {
  const location = useLocation();
  const type = useNavigationType();
  const matches = useMatches();
  const tier = useMotionTier();
  const descriptor = describe(location, matches);

  const [state, setState] = useState<PageState>(() => ({ at: descriptor, seq: 0, plan: null }));
  let current = state;
  if (state.at.key !== descriptor.key) {
    // A navigation is being rendered. Decide its transition now so the sentinel key (and with it React's
    // decision to run a view transition) is part of this very commit. Reduced motion still gets a transition:
    // motion.css makes it a 120 ms cross-fade (DESIGN.md §7.3).
    const plan = planNavigation(state.at, descriptor, type, tier);
    current = { at: descriptor, seq: plan ? state.seq + 1 : state.seq, plan };
    setState(current);
  }

  const page = useRef<HTMLDivElement>(null);
  const committed = useRef(current.at);

  useLayoutEffect(() => {
    noteLocation(committed.current);
  }, []);

  useLayoutEffect(() => {
    const from = committed.current;
    const to = current.at;
    if (from.key === to.key) return;
    committed.current = to;
    const first = commitNavigation(current.plan, from, to, type);
    // A language switch (replace, or planned as `direction`) keeps its anchor in place before anything is captured.
    if (first && anchorProbe && (type === "REPLACE" || current.plan?.nav === "direction")) keepAnchorInPlace();
    if (first && current.plan) playNavigation(current.plan, page.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the location being committed; plan and type belong to it
  }, [current.at.key]);

  const shareName = current.plan?.share?.name ?? null;
  const shareSlot = current.plan?.share?.slot ?? null;
  const context = useMemo<NavContextValue>(
    () => ({ key: current.at.key, share: shareName === null ? null : { name: shareName, slot: shareSlot } }),
    [current.at.key, shareName, shareSlot],
  );

  return (
    <NavContext value={context}>
      <ViewTransition key={current.seq} default="none" enter="tt-nav" exit="tt-nav" update="none" onEnter={onSentinelEnter}>
        <i className="tt-nav-sentinel" aria-hidden="true" />
      </ViewTransition>
      <PopGate locationKey={current.at.key} active={current.plan !== null} />
      <div ref={page} data-motion-page="" className={className} style={style}>
        {children}
      </div>
    </NavContext>
  );
}

// --- intents ---------------------------------------------------------------------------------------

function requestNav(nav: NavKind, options?: Omit<NavIntent, "nav">): void {
  setNavIntent({ nav, ...options });
}

/**
 * For navigations that are not a link: call the returned function right before `navigate()` or a form submit.
 *
 *   const intent = useNavIntent();
 *   intent("rise");
 *   navigate("/cart");
 */
export function useNavIntent(): (nav: NavKind, options?: Omit<NavIntent, "nav">) => void {
  return requestNav;
}

/**
 * Language switch with the direction morph: same page in another language, same scroll position, same form state.
 *
 *   const switchLanguage = useDirectionMorph();
 *   <button onClick={() => switchLanguage("en")}>English</button>
 *
 * It replaces the history entry (Back should leave the page, not walk through languages). The content slides 16px
 * toward the new reading direction's start and cross-fades; fixed chrome cross-fades in place; elements marked
 * `data-motion-anchor` stay put. Instant at the lite and reduced tiers.
 */
export function useDirectionMorph(): (locale: Locale) => void {
  const navigate = useNavigate();
  const location = useLocation();
  return (locale) => {
    setNavIntent({ nav: "direction" });
    armAnchors();
    void navigate(switchLocalePath(location.pathname, location.search, location.hash, locale), { replace: true, preventScrollReset: true });
  };
}

export type MotionLinkProps = Omit<LinkProps, "to" | "viewTransition"> & {
  /** Locale-less path, exactly like `<LocaleLink to>`. */
  to: string;
  /** Transition to play. Default "fade". */
  nav?: NavKind;
  /** Sibling order of the destination for `nav="push"` (direction is chosen by comparing with the current page). */
  order?: number;
  /** Play the reverse — for an in-page "back" link that pushes a new history entry. */
  back?: boolean;
};

/** `<LocaleLink>` that also tells the engine which transition the navigation should play. */
export function MotionLink({ nav = "fade", order, back, onClick, ...rest }: MotionLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    let origin = { x: event.clientX, y: event.clientY };
    if (event.detail === 0) {
      // Keyboard activation has no pointer position: zoom from the middle of the link.
      const rect = event.currentTarget.getBoundingClientRect();
      origin = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    setNavIntent({ nav, order, back, origin });
  };
  return <LocaleLink {...rest} data-motion-link={nav} onClick={handleClick} />;
}
