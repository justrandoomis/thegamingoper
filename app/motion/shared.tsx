/**
 * <SharedElement name="product-image:abc"> — the same thing on two pages morphs from one into the other.
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
 *  - A card carries the shared name only while it is the one the shopper pressed (or the one Back returns to), so the
 *    same product can appear in several rails. The destination side sets `target` and is always armed. If one page
 *    can show two cards with the same name, give them different `slot`s so Back returns into the right one.
 *  - No pair on the other page, off-screen, reduced motion, no View Transitions support → nothing happens; the page
 *    transition still plays.
 *  - Images inside must not hold the navigation back: React waits (up to ~800 ms) for an unloaded <img> inside a
 *    view-transition boundary unless that <img> has an `onLoad` handler or `loading="lazy"`.
 *  - Changing `name` (the element now shows another product) remounts the wrapper and its children.
 */
import { ViewTransition, useContext, useLayoutEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";
import { useMotionTier } from "./env";
import { NavContext, type NavContextValue } from "./nav";
import { registerShare } from "./share-registry";

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

  useLayoutEffect(() => {
    if (!element.current) return;
    return registerShare(element.current, {
      name,
      slot: slot ?? null,
      arm: (armed) =>
        setState((s) => {
          if (s.armed === armed) return s;
          // React (in development) remembers a boundary's name from the moment it mounted, so a boundary that
          // gives its name up is replaced by a fresh one rather than renamed in place. Taking a name is fine.
          return { ...s, armed, epoch: armed ? s.epoch : s.epoch + 1 };
        }),
    });
  }, [name, slot, current.epoch]);

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
