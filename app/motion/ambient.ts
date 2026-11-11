/**
 * useAmbient — idle, decorative motion that knows when to stop.
 *
 *   const float = useAmbient<HTMLDivElement>();
 *   <div ref={float} data-ambient="" className="hero-bubble" />     // .hero-bubble { animation: drift 9s ease-in-out infinite alternate; }
 *
 * Write the animation in CSS as usual (transform / opacity only). An element with `data-ambient` is paused by default;
 * this hook marks it `data-ambient="on"` while it is on screen, and motion.css lets it run only then, only at the
 * 'full' tier, only in a visible tab and not on a nearly empty battery. At 'lite' and 'reduced' it does not animate at all.
 * One shared IntersectionObserver serves every ambient element.
 */
import { useCallback, useRef } from "react";

let observer: IntersectionObserver | null = null;

function shared(): IntersectionObserver | null {
  if (observer || typeof IntersectionObserver !== "function") return observer;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.setAttribute("data-ambient", entry.isIntersecting ? "on" : "off");
  });
  return observer;
}

/** Returns a ref callback for the ambient element. */
export function useAmbient<T extends Element = HTMLElement>(): (element: T | null) => void {
  const current = useRef<T | null>(null);
  return useCallback((element: T | null) => {
    const io = shared();
    if (current.current && io) io.unobserve(current.current);
    current.current = element;
    if (!element) return;
    if (!element.hasAttribute("data-ambient")) element.setAttribute("data-ambient", "off");
    if (io) io.observe(element);
    else element.setAttribute("data-ambient", "on"); // no IntersectionObserver: let CSS tier/visibility rules decide
  }, []);
}
