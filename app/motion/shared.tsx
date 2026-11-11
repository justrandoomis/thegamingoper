/**
 * <SharedElement name="product-image:abc"> — the same thing on two pages morphs from one into the other
 * (DESIGN.md §7.2 "Shared-element card → page zoom": the niche grows into the stage on the `settle` spring).
 *
 *   // product card (list)                                  // product page (detail)
 *   <MotionLink nav="zoom" to={`/p/${slug}`}>               <SharedElement name={`product-image:${id}`} target>
 *     <SharedElement name={`product-image:${id}`}>            <Art name={art} priority … />
 *       <Art name={art} … />                                 </SharedElement>
 *     </SharedElement>
 *   </MotionLink>
 *
 * Rules that make it safe by construction:
 *  - It renders one wrapper element (`as`, default div) and that element is what morphs. Give both sides the same
 *    aspect ratio when you can; when they differ the snapshots are fitted (`fit="contain" | "cover"`), never stretched.
 *    The niche and the render may be two shared elements with two names (both inside the pressed link).
 *  - A card carries the shared name only while it is the one the shopper pressed (or the one Back returns to), so the
 *    same product can appear in several rails. The destination side sets `target` and is always armed. If one page
 *    can show two cards with the same name, give them different `slot`s so Back returns into the right one.
 *  - No pair on the other page, off-screen, or reduced motion → nothing happens; the page transition still plays.
 *  - No View Transitions in the browser: the destination FLIPs from the box the card had (transform only, `settle`
 *    spring) while the page fades in over 120 ms.
 *  - Images inside must not hold the navigation back: React waits (up to ~800 ms) for an unloaded <img> inside a
 *    view-transition boundary unless that <img> has an `onLoad` handler or `loading="lazy"`.
 *  - Changing `name` (the element now shows another product) remounts the wrapper and its children.
 */
import { ViewTransition, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { getMotionTier, useMotionTier } from "./env";
import { NavContext, type NavContextValue } from "./nav";
import { registerShare, takeBox } from "./share-registry";
import { springTiming } from "./timing";
import { supportsViewTransitions } from "./vt";

export type SharedElementProps = {
  /** Stable identity shared by both sides, e.g. `product-image:${product.id}`. */
  name: string;
  /** Distinguishes two elements with the same name on one page (e.g. the rail they sit in). */
  slot?: string;
  /** The destination side (detail hero): always carries the name. */
  target?: boolean;
  /** How the snapshots fill the morphing box when the two sides have different proportions. Default "contain". */
  fit?: "contain" | "cover";
  /** Wrapper element. Default "div". */
  as?: ElementType;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
};

type ShareState = {
  /** name + slot this state belongs to */
  identity: string;
  /** carries the shared name right now */
  armed: boolean;
  /** React's own boundary is remounted when this changes (see below) */
  epoch: number;
};

function returningTo(nav: NavContextValue | null, name: string, slot: string | undefined): boolean {
  return nav?.share != null && nav.share.name === name && nav.share.slot === (slot ?? null);
}

/** No View Transitions: move the element from the box it had on the previous page to its own (transform only). */
function flipFrom(element: HTMLElement, from: DOMRect): void {
  const to = element.getBoundingClientRect();
  if (to.width === 0 || to.height === 0 || from.width === 0) return;
  // One scale for both axes (never stretched); the centres line up.
  const scale = from.width / to.width;
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  element.animate([{ transform: `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px) scale(${scale.toFixed(4)})` }, { transform: "none" }], springTiming("settle"));
}

export function SharedElement({ name, slot, target = false, fit = "contain", as: Tag = "div", className, style, children }: SharedElementProps) {
  const nav = useContext(NavContext);
  const tier = useMotionTier();
  const element = useRef<HTMLElement>(null);
  const identity = `${name}\n${slot ?? ""}`;

  // Armed at mount when it is the destination, or the card that Back/Forward is returning to.
  const [state, setState] = useState<ShareState>(() => ({ identity, armed: target || returningTo(nav, name, slot), epoch: 0 }));
  let current = state;
  if (state.identity !== identity) {
    // The same component instance now stands for another thing (e.g. product → next product on the same route).
    current = { identity, armed: target || returningTo(nav, name, slot), epoch: state.epoch + 1 };
    setState(current);
  }
  const armed = useRef(current.armed);
  useLayoutEffect(() => {
    armed.current = current.armed;
  });

  useLayoutEffect(() => {
    if (!element.current) return;
    return registerShare(element.current, {
      name,
      slot: slot ?? null,
      isArmed: () => armed.current,
      arm: (next) =>
        setState((s) => {
          if (s.armed === next) return s;
          // React (in development) remembers a boundary's name from the moment it mounted, so a boundary that
          // gives its name up is replaced by a fresh one rather than renamed in place. Taking a name is fine.
          return { ...s, armed: next, epoch: next ? s.epoch : s.epoch + 1 };
        }),
    });
  }, [name, slot, current.epoch]);

  // The fallback morph for browsers without View Transitions, once, when an armed element arrives.
  useLayoutEffect(() => {
    const el = element.current;
    if (!el || !armed.current || supportsViewTransitions() || getMotionTier() === "reduced") return;
    const from = takeBox(name);
    if (from) flipFrom(el, from);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the element's first appearance morphs
  }, []);

  // Under reduced motion the boundary keeps its name but never takes part (share="none").
  const share = current.armed && tier !== "reduced" ? (fit === "cover" ? "tt-share tt-share-cover" : "tt-share") : "none";

  return (
    <ViewTransition key={current.epoch} name={current.armed ? name : "auto"} share={share} default="none" enter="none" exit="none" update="none">
      <Tag ref={element} data-share={name} className={className} style={style}>
        {children}
      </Tag>
    </ViewTransition>
  );
}
