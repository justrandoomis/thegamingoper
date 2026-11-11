/**
 * useAmbient — idle, decorative motion that knows when to stop (DESIGN.md §7.2 "Idle motion policy": nothing moves
 * at rest, with one optional exception such as the light pool breathing under the home hero).
 *
 *   const breathe = useAmbient<HTMLDivElement>();
 *   <div ref={breathe} data-ambient="" className="stage__pool" />   // .stage__pool { animation: breathe 5s ease-in-out infinite alternate; }
 *
 * Write the animation in CSS as usual (transform / opacity only, never on the LCP image). An element with
 * `data-ambient` is paused by default; this hook marks it `data-ambient="on"` while it is on screen and at least 2 s
 * after the page loaded, and motion.css lets it run only then — only at the 'full' tier (so never on Save-Data or the
 * low-end tier), only in a visible tab, not on a nearly empty battery, never under reduced motion.
 * One shared IntersectionObserver serves every ambient element.
 */
import { useCallback, useRef } from "react";
import { ambient as tokens } from "./tokens";

let observer: IntersectionObserver | null = null;
const visible = new Set<Element>();
let waiting = false;

function sinceLoad(): number {
  return typeof performance === "undefined" ? Infinity : performance.now();
}

function mark(element: Element, on: boolean): void {
  element.setAttribute("data-ambient", on && sinceLoad() >= tokens.startAfterMs ? "on" : "off");
  if (on && sinceLoad() < tokens.startAfterMs && !waiting) {
    // Start the ones that are on screen once the page has had its first two seconds to itself.
    waiting = true;
    setTimeout(() => {
      waiting = false;
      for (const el of visible) el.setAttribute("data-ambient", "on");
    }, tokens.startAfterMs - sinceLoad());
  }
}

function shared(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver !== "function") return observer;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) visible.add(entry.target);
      else visible.delete(entry.target);
      mark(entry.target, entry.isIntersecting);
    }
  });
  return observer;
}

/** Returns a ref callback for the ambient element. */
export function useAmbient<T extends Element = HTMLElement>(): (element: T | null) => void {
  const current = useRef<T | null>(null);
  return useCallback((element: T | null) => {
    const io = shared();
    if (current.current) {
      io?.unobserve(current.current);
      visible.delete(current.current);
    }
    current.current = element;
    if (!element) return;
    if (!element.hasAttribute("data-ambient")) element.setAttribute("data-ambient", "off");
    if (io) io.observe(element);
    else {
      visible.add(element); // no IntersectionObserver: let the CSS tier and visibility rules decide
      mark(element, true);
    }
  }, []);
}
