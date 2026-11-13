/**
 * Focus that survives a swap (QA 2026-11-13, WCAG 2.4.3). After an add, the phone bar (./components/BuyStrip) and the
 * quick look's pinned foot (./QuickPreview) replace «أضف إلى السلة» with «✓ في السلة» + «عرض السلة (n)». Removing the
 * focused key dropped focus to <body> — and out of the quick look's modal dialog, whose next Tab started again at its
 * top. Now the new key takes focus, without scrolling, when focus was on what the swap replaced; a shopper who moved
 * on while the add was on its way is never pulled back. The live region still says «أُضيف … إلى السلة».
 *
 *   const handoff = useFocusHandoff(added);
 *   <div ref={handoff.area}>            the box that is swapped (or that holds the swapped key), in every state
 *     <AddToCartKey … onAdded={() => { handoff.arm(); setAdded(true); }} />
 *     <Key data-focus-target="" …>عرض السلة (n)</Key>        after the swap: where focus lands
 */
import { useLayoutEffect, useRef, useState } from "react";

/** The attribute of the key that takes focus after the swap. */
export const FOCUS_TARGET = "data-focus-target";

type Area = { contains(node: Node | null): boolean };
type Target = { focus(options?: FocusOptions): void };

/**
 * The decision, apart from React and the DOM (tests): `arm` when the add is confirmed — while the old key is still
 * there — notes whether focus is inside the area the swap replaces; `land` hands focus to the new key once.
 */
export function focusHandoff() {
  let armed = false;
  return {
    arm(area: Area | null, active: unknown) {
      armed = Boolean(area && active && area.contains(active as Node));
    },
    land(target: Target | null | undefined): boolean {
      const go = armed && Boolean(target);
      armed = false;
      if (go) target?.focus({ preventScroll: true });
      return go;
    },
  };
}

/**
 * The hook: attach `area` to the swapped box in every state (one ref: the box after the swap holds the new key), call
 * `arm()` in `onAdded` before the state change, and mark the new key with `data-focus-target=""`. Focus moves in the
 * layout phase, before the swapped state is painted.
 */
export function useFocusHandoff<T extends HTMLElement = HTMLDivElement>(swapped: boolean) {
  const area = useRef<T>(null);
  const [handoff] = useState(focusHandoff);
  useLayoutEffect(() => {
    if (swapped) handoff.land(area.current?.querySelector<HTMLElement>(`[${FOCUS_TARGET}]`));
  }, [swapped, handoff]);
  return {
    area,
    /** The add was confirmed: is focus inside what is about to be swapped? */
    arm: () => handoff.arm(area.current, typeof document === "undefined" ? null : document.activeElement),
  };
}
