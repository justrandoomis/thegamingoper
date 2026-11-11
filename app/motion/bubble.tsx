/**
 * <Bubble> / <BubbleGroup> — content that arrives inflates softly into space that is already reserved.
 *
 *   <Suspense fallback={<div className="card-size placeholder" />}>
 *     <Await resolve={products}>
 *       {(items) => (
 *         <BubbleGroup stagger className="grid">
 *           {items.map((p) => <Bubble key={p.id} className="card-size"><ProductCard product={p} /></Bubble>)}
 *         </BubbleGroup>
 *       )}
 *     </Await>
 *   </Suspense>
 *
 * - The animation is DESIGN.md's inflate: scale .86 → 1 with opacity 0 → 1 on the `inflate` spring, on the wrapper
 *   itself: no layout shift, compositor only. Reserve the geometry on the wrapper (and on the fallback) with your
 *   own classes. A failed load is not a bubble: show the empty reserved space with a message and a retry key.
 * - It plays for content that appears after the page is on screen (first appearance only): Suspense reveals,
 *   results that arrive, items the shopper adds. Content that is part of the server HTML or of a page navigation is
 *   simply there (the page transition is that animation) — pass `always` to opt in.
 * - `origin` makes it grow from a point (a tap) instead of its own centre.
 * - A group staggers its children 45 ms apart; at most six are staggered, the rest appear with the sixth. Items added
 *   to an existing group later are not delayed. Re-key the group to play the wave again (e.g. `key={query}`).
 * - Low-end tier and reduced motion: content appears in place, no animation.
 * - Hydration-safe: a Bubble that HYDRATES server HTML never inflates — not even inside a streamed Suspense section
 *   that hydrates after the engine went live (useSyncExternalStore reports the server snapshot while hydrating), so
 *   the markup always matches the server's. Only a client render of new content can inflate.
 */
import {
  Children,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ElementType,
  type HTMLAttributes,
  type ReactNode,
} from "react";
import { NavContext } from "./nav";
import { getCommittedKey } from "./nav-state";
import { isMotionLive, lastPointer } from "./pointer";
import { staggerStep } from "./stagger";
import { bubble as tokens } from "./tokens";

type GroupValue = { step: number; isFresh: () => boolean };
const GroupContext = /* @__PURE__ */ createContext<GroupValue | null>(null);

/** CSS assigns stagger slots 0–5 by child position; later children share the last slot (motion.css). */
const MAX_SLOTS = tokens.staggerSlots;

export type BubbleProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  children?: ReactNode;
  /** Wrapper element. Default "div". */
  as?: ElementType;
  /** Grow from this viewport point, or from the last press with "pointer". Default: the element's centre. */
  origin?: { x: number; y: number } | "pointer";
  /** Also play when the element is part of a page navigation. */
  always?: boolean;
  /** Position in the stagger wave when the Bubble is not a direct child of the group element. */
  index?: number;
};

export type InflateInput = {
  /** Rendering on the server, or hydrating server HTML (the markup must match the server's). */
  hydrating: boolean;
  /** The engine is live (<MotionRoot> mounted): the page is already on screen. */
  live: boolean;
  always: boolean;
  /** Mounting inside a navigation that has not committed yet: the page transition is the animation. */
  inNavigation: boolean;
};

/** Whether a Bubble inflates when it mounts. Server HTML and hydration never do (a hydration mismatch otherwise). */
export function inflateOnMount({ hydrating, live, always, inNavigation }: InflateInput): boolean {
  if (hydrating || !live) return false;
  return always || !inNavigation;
}

const noSubscription = () => () => {};
const onClient = () => false;
const onServerOrHydrating = () => true;

/**
 * True while React renders on the server or hydrates server HTML — including a Suspense boundary that streamed in
 * and hydrates later — and false for a client render. (After hydration it turns false and the component renders once
 * more; callers read it once, at mount.)
 */
export function useHydrating(): boolean {
  return useSyncExternalStore(noSubscription, onClient, onServerOrHydrating);
}

export function Bubble({ as: Tag = "div", origin, always = false, index, className, style, children, ...rest }: BubbleProps) {
  const nav = useContext(NavContext);
  const group = useContext(GroupContext);
  const element = useRef<HTMLElement>(null);
  const hydrating = useHydrating();

  // Decided once, when the element mounts.
  const [inflate] = useState(() =>
    inflateOnMount({
      hydrating: hydrating || typeof window === "undefined",
      live: isMotionLive(),
      always,
      inNavigation: Boolean(nav && nav.key !== getCommittedKey()),
    }),
  );
  const [wave] = useState(() => inflate && group !== null && group.isFresh());

  useLayoutEffect(() => {
    const el = element.current;
    if (!el || !inflate || origin === undefined) return;
    const point = origin === "pointer" ? lastPointer() : origin;
    if (!point) return;
    const rect = el.getBoundingClientRect();
    el.style.transformOrigin = `${Math.round(point.x - rect.left)}px ${Math.round(point.y - rect.top)}px`;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the origin is read once, when the bubble appears
  }, []);

  const classes = [className, inflate ? "tt-bubble-in" : null, wave ? "tt-bubble-wave" : null].filter(Boolean).join(" ");
  const merged = index !== undefined && wave ? ({ ...style, "--tt-i": Math.min(Math.max(index, 0), MAX_SLOTS - 1) } as CSSProperties) : style;

  return (
    <Tag ref={element} className={classes || undefined} style={merged} {...rest}>
      {children}
    </Tag>
  );
}

export type BubbleGroupProps = Omit<HTMLAttributes<HTMLElement>, "children"> & {
  children?: ReactNode;
  /** Wrapper element. Default "div". */
  as?: ElementType;
  /** true (default) for the standard step, a number of ms for a custom one, false for no stagger. */
  stagger?: boolean | number;
};

export function BubbleGroup({ as: Tag = "div", stagger = true, className, style, children, ...rest }: BubbleGroupProps) {
  // With one child we cannot see how many bubbles are nested inside it; staggerStep then assumes every slot is used.
  const requested = stagger === false ? 0 : typeof stagger === "number" ? stagger : tokens.staggerStep;
  const step = staggerStep(Children.count(children), requested, tokens.staggerMax, MAX_SLOTS);

  const fresh = useRef(true);
  useEffect(() => {
    fresh.current = false;
  }, []);
  const value = useMemo<GroupValue>(() => ({ step, isFresh: () => fresh.current }), [step]);

  return (
    <GroupContext value={value}>
      <Tag className={className ? `tt-bubbles ${className}` : "tt-bubbles"} style={{ ...style, "--tt-step": `${step}ms` } as CSSProperties} {...rest}>
        {children}
      </Tag>
    </GroupContext>
  );
}
