import { useEffect, useRef, type RefObject } from "react";
import { canDraw, sakuga } from "./fx";

/**
 * Drawn moments on every control (docs/DESIGN.md §7.4 "Every control"; the owner, 2026-11-17: "effects on almost every
 * button and pages widely"). The kit marks each control with ONE attribute and this module's single set of delegated,
 * passive, captured document listeners does the rest — no page wires anything:
 *
 *   data-fx="burst"   the primary and on-band keys            a small burst, chips and two puffs off the END corner
 *   data-fx="fan"     secondary and ghost keys, chips,         a small fan of wedges off the end corner
 *                     page numbers, text-link buttons
 *   data-fx="pop"     icon keys, carousel arrows and dots,     a thin ring round it and three wedges over it
 *                     gallery thumbnails, menu rows, swatches
 *   data-fx="wish"    the wishlist heart                      red chips and glints turning on; a puff turning off
 *   data-fx="dot"     a radio / option card (its <label>)     the dot springs (CSS) and fans, on its `change`
 *   data-fx="none"    a control with a moment of its own (the add key, the stepper's keys, a danger key): nothing
 *   data-fx="off"     on any ancestor: nothing at all inside (fx.ts) — the admin is off by its density
 *   data-fx-tilt      a product card: a gentle tilt toward a FINE pointer, with a glare (CSS vars, transform only)
 *   (no attribute)    text and search fields: a speck of dust at the caret as the shopper types (never a password)
 *
 * The squash and its overshoot are CSS (the engine's data-press → pieces.css "drawn presses"); the canvas half is
 * ./fx.ts (lazy, guarded). The listener reacts to `click`, which a pointer, Enter and Space all fire — so a keyboard
 * press draws exactly what a tap does — and it never calls preventDefault: navigation and submits never wait.
 */

const PRESS = new Set(["burst", "fan", "pop", "wish"]);
const CONTROL = new Set(["BUTTON", "A", "LABEL", "INPUT", "SUMMARY"]);
/** One speck of dust per field at most this often while typing. */
export const TYPE_GAP_MS = 90;
const TYPED = new Set(["text", "search"]);

type El = Element & { disabled?: boolean };
/** The narrow face of the effects the listener uses (fx.ts's `sakuga`; tests pass a recorder). */
export type MomentsFx = Pick<typeof sakuga, "warm" | "press" | "wish" | "dot" | "dust" | "spring">;
type DocLike = Pick<Document, "addEventListener" | "removeEventListener">;

/** The control a click landed in and its press kind, or null (no control, a disabled one, `none`, a container). */
export function pressOf(target: El | null): { element: El; fx: string } | null {
  const element = target?.closest?.("[data-fx]") as El | null;
  if (!element) return null;
  const fx = element.getAttribute("data-fx") ?? "";
  if (!PRESS.has(fx)) return null;
  if (!CONTROL.has(element.tagName) && !element.getAttribute("role")) return null;
  if (element.disabled === true || element.getAttribute("aria-disabled") === "true") return null;
  // a label-wrapped control (an input chip): the label is never disabled itself — its input is
  if ((element as { control?: El | null }).control?.disabled === true) return null;
  return { element, fx };
}

/** Where the caret is in a one-line field (page coords are added by the caller): after `textWidth` px of text from
 *  the field's START edge (left in LTR, right in RTL), clamped inside its padding; a little under the middle. Pure. */
export function caretPoint(
  rect: { left: number; right: number; top: number; bottom: number },
  pad: { start: number; end: number },
  textWidth: number,
  rtl: boolean,
): { x: number; y: number } {
  const y = Math.round(rect.top + (rect.bottom - rect.top) * 0.62);
  const low = rect.left + (rtl ? pad.end : pad.start);
  const high = rect.right - (rtl ? pad.start : pad.end);
  const x = rtl ? rect.right - pad.start - textWidth : rect.left + pad.start + textWidth;
  return { x: Math.min(high, Math.max(low, x)), y };
}

/** A card's tilt toward a pointer at (x, y): at most `max` degrees each way, zero at the centre; the glare at the
 *  pointer (px from the card's top-left). Physical, so it needs no RTL mirror. Pure. */
export function tiltOf(rect: { left: number; top: number; width: number; height: number }, x: number, y: number, max = 4) {
  const px = Math.min(1, Math.max(0, (x - rect.left) / rect.width)) - 0.5;
  const py = Math.min(1, Math.max(0, (y - rect.top) / rect.height)) - 0.5;
  const round = (n: number) => Math.round(n * 100) / 100 + 0;
  return { rx: round(-py * 2 * max), ry: round(px * 2 * max), gx: Math.round(x - rect.left), gy: Math.round(y - rect.top) };
}

let measure: CanvasRenderingContext2D | null | undefined;
function textWidth(input: HTMLInputElement, style: CSSStyleDeclaration): number {
  if (measure === undefined) measure = document.createElement("canvas").getContext("2d");
  if (!measure) return 0;
  measure.font = style.font;
  // scrollLeft is 0 at the start edge and grows AWAY from it — negative in an RTL field — so the hidden part is its size
  return measure.measureText(input.value.slice(0, input.selectionStart ?? input.value.length)).width - Math.abs(input.scrollLeft);
}

/** Installs the listeners on `doc` (once per document: <DrawnMoments/> counts mounts). Returns the uninstall. */
export function installMoments(doc: DocLike, fx: MomentsFx = sakuga): () => void {
  const options = { capture: true, passive: true } as const;
  const typedAt = new WeakMap<Element, number>();
  let card: HTMLElement | null = null;
  let frame = 0;
  let last: { x: number; y: number } | null = null;

  const onClick = (event: Event) => {
    const hit = pressOf(event.target as El);
    if (!hit) return;
    // state BEFORE the toggle: the kit's own click handler runs after this captured listener
    if (hit.fx === "wish") fx.wish(hit.element, hit.element.getAttribute("aria-pressed") !== "true");
    else fx.press(hit.element, hit.fx as "burst" | "fan" | "pop");
  };

  const untilt = () => {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    if (card) card.removeAttribute("data-fx-tilting");
    card = null;
  };
  const onPointerDown = (event: Event) => {
    if (pressOf(event.target as El)) fx.warm((event.target as Element).closest("[data-fx]"));
    // a card about to be opened (the zoom morph snapshots it): it rests flat first
    if (card) untilt();
  };

  const onChange = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.type !== "radio" || !input.checked || !input.closest?.('[data-fx="dot"]')) return;
    const dot = input.nextElementSibling;
    fx.spring(dot);
    fx.dot(dot);
  };

  const onInput = (event: Event) => {
    const input = event.target as HTMLInputElement;
    if (input.tagName !== "INPUT" || !TYPED.has(input.type) || input.readOnly || input.getAttribute("data-fx") === "none") return;
    const now = performance.now();
    if (now - (typedAt.get(input) ?? -Infinity) < TYPE_GAP_MS || !canDraw(input)) return;
    typedAt.set(input, now);
    const style = getComputedStyle(input);
    const rect = input.getBoundingClientRect();
    const pad = { start: parseFloat(style.paddingInlineStart) || 0, end: parseFloat(style.paddingInlineEnd) || 0 };
    const at = caretPoint(rect, pad, textWidth(input, style), style.direction === "rtl");
    fx.dust(input, { x: at.x + window.scrollX, y: at.y + window.scrollY });
  };

  // the card tilt: fine pointers only, one style write per frame, transform only (pieces.css)
  const fine = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(hover: hover) and (pointer: fine)") : null;
  const onMove = (event: Event) => {
    const e = event as PointerEvent;
    if (e.pointerType === "touch" || !fine?.matches) return;
    const over = (e.target as Element | null)?.closest?.<HTMLElement>("[data-fx-tilt]") ?? null;
    if (over !== card) {
      untilt();
      if (!over || !canDraw(over)) return;
      card = over;
    }
    last = { x: e.clientX, y: e.clientY };
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!card || !last) return;
      const t = tiltOf(card.getBoundingClientRect(), last.x, last.y);
      card.style.setProperty("--fx-rx", `${t.rx}deg`);
      card.style.setProperty("--fx-ry", `${t.ry}deg`);
      card.style.setProperty("--fx-gx", `${t.gx}px`);
      card.style.setProperty("--fx-gy", `${t.gy}px`);
      card.setAttribute("data-fx-tilting", "");
    });
  };
  const onOut = (event: Event) => {
    const to = (event as PointerEvent).relatedTarget as Element | null;
    if (card && !card.contains(to)) untilt();
  };

  const listeners: [string, (event: Event) => void][] = [
    ["click", onClick],
    ["pointerdown", onPointerDown],
    ["change", onChange],
    ["input", onInput],
    ["pointermove", onMove],
    ["pointerout", onOut],
  ];
  for (const [type, fn] of listeners) doc.addEventListener(type, fn, options);
  return () => {
    untilt();
    for (const [type, fn] of listeners) doc.removeEventListener(type, fn, options);
  };
}

let mounts = 0;
let uninstall: (() => void) | null = null;

/** Mount once in a storefront layout (the shell; /design-system): renders nothing, installs the listeners. Never in
 *  the admin (its density turns every moment off anyway). */
export function DrawnMoments(): null {
  useEffect(() => {
    if (mounts++ === 0) uninstall = installMoments(document);
    return () => {
      if (--mounts === 0) {
        uninstall?.();
        uninstall = null;
      }
    };
  }, []);
  return null;
}

/**
 * Bounces `ref` (CSS `[data-fx-spring]`) when `value` changes after the first render — the cart bead's count. Not while
 * a fly-to-cart bead is in the air (`.tt-fly`): its landing squishes the bead already.
 */
export function useBounce(ref: RefObject<Element | null>, value: unknown): void {
  const seen = useRef(value);
  useEffect(() => {
    if (Object.is(seen.current, value)) return;
    seen.current = value;
    if (!document.querySelector(".tt-fly")) sakuga.spring(ref.current);
  }, [ref, value]);
}
