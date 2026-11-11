import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useT } from "~/i18n/react";
import { dematerialize, durations, easings, getMotionTier, materialize, springTiming } from "~/motion";
import { cx } from "./cx";
import { useOverlayDepth, useOverlayRoot } from "./Dialog";
import { Glass } from "./Glass";
import { IconKey } from "./IconKey";
import { Key } from "./Key";
import { Render } from "./Stage";
import { toastStore, useToasts, type Toast, type ToastKind } from "./toast-store";

/**
 * <Toaster /> — shows the toast store (./toast-store.ts; feature code calls `toast.success(…)`, `toast.cart({…})`).
 * Mount it once in a layout, near <MotionRoot />. Only one instance renders at a time (the others wait to take over).
 *
 *   <Toaster offset="calc(var(--safe-top) + 64px)" />          under a 56px glass header (+ 8px)
 *   <Toaster fallback />                                       a page that may or may not have a layout toaster
 *
 * docs/DESIGN.md §9.13: live glass, `--r-md`, pinned under the header so it never covers a task bar; at least 60px:
 * a thumbnail in a small niche (cart) or the kind's icon, a bold first line, a secondary line in on-glass-2, and ONE
 * small clay key (undo, view cart, retry) — or a close key when there is no action. One at a time, 4s, paused while
 * hovered, focused, dragged or the tab is hidden. Above an open sheet or dialog it turns solid (two live glass panes
 * per viewport at most).
 *
 * Accessibility: what a toast says is announced through two live regions that exist before any toast does —
 * polite for info / success / warning / cart, assertive for errors. F6 moves focus to the toast's key (Escape returns
 * it and dismisses the toast). The toaster stays usable above modal layers (it is excluded from their inert page).
 *
 * Motion: drops in with 8px of travel and opacity (materialize) and leaves the same way; a new toast cross-fades with
 * the one it replaces. Swipe sideways or up to dismiss (it follows the finger, then keeps going or springs back).
 * Reduced motion: opacity only; swiping still works.
 */
export type ToasterProps = {
  /** Distance from the top of the viewport (under the header). Default `calc(var(--safe-top) + var(--s-2))`. */
  offset?: string;
  /**
   * Render only when no regular <Toaster> is mounted — for a page that needs toasts whether or not it sits inside a
   * layout that has one (the /design-system sections). The layout's toaster, with its header offset, wins.
   */
  fallback?: boolean;
  className?: string;
};

type Entry = { key: number; toast: Toast; leaving: boolean };

/**
 * Mounted toasters in the order they claimed. Exactly one renders: the first regular one, else the first fallback.
 * When it unmounts the next one takes over, so a layout's toaster keeps working after a page with its own leaves.
 */
type Claim = { fallback: boolean; setActive: (active: boolean) => void };
const toasters: Claim[] = [];
function electToaster(): void {
  const winner = toasters.find((claim) => !claim.fallback) ?? toasters[0];
  for (const claim of toasters) claim.setActive(claim === winner);
}
let entrySeq = 0;

export function Toaster({ offset = "calc(var(--safe-top) + var(--s-2))", fallback = false, className }: ToasterProps) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    const claim: Claim = { fallback, setActive };
    toasters.push(claim);
    electToaster();
    return () => {
      const index = toasters.indexOf(claim);
      if (index >= 0) toasters.splice(index, 1);
      setActive(false);
      electToaster();
    };
  }, [fallback]);
  return active ? <ToasterView offset={offset} className={className} /> : null;
}

const KIND: Record<Exclude<ToastKind, "cart">, { icon: IconName; tone: string }> = {
  info: { icon: "info", tone: "text-info" },
  success: { icon: "check-circle", tone: "text-ok" },
  warning: { icon: "warning", tone: "text-warn" },
  error: { icon: "warning-circle", tone: "text-red-ink" },
};

function ToasterView({ offset, className }: Required<Pick<ToasterProps, "offset">> & Pick<ToasterProps, "className">) {
  const t = useT("ui-overlays");
  const root = useOverlayRoot(true);
  const { current } = useToasts();
  const depth = useOverlayDepth();
  const [entries, setEntries] = useState<Entry[]>([]);
  const region = useRef<HTMLElement | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);

  // The store's clock runs only while a toaster shows it; a hidden tab holds it.
  useEffect(() => toastStore.attach(), []);
  useEffect(() => {
    const sync = () => (document.visibilityState === "hidden" ? toastStore.hold("hidden") : toastStore.release("hidden"));
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      toastStore.release("hidden");
    };
  }, []);

  // The rendered cards follow the store: a new toast enters while the one it replaces leaves.
  useLayoutEffect(() => {
    setEntries((list) => {
      const live = list.find((entry) => !entry.leaving);
      if (current && live && live.toast.id === current.id) {
        return live.toast === current ? list : list.map((entry) => (entry === live ? { ...entry, toast: current } : entry));
      }
      const next = list.map((entry) => (entry.leaving ? entry : { ...entry, leaving: true }));
      return current ? [...next, { key: ++entrySeq, toast: current, leaving: false }] : next;
    });
  }, [current]);

  // F6: to the toast (WAI-ARIA landmark-style shortcut); keyboard users can reach "undo" before it leaves.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "F6" || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const card = region.current?.querySelector<HTMLElement>("[data-toast]:not([inert])");
      if (!card) return;
      event.preventDefault();
      if (!region.current?.contains(document.activeElement) && document.activeElement instanceof HTMLElement) returnFocus.current = document.activeElement;
      (card.querySelector<HTMLElement>("a[href], button:not([disabled])") ?? card).focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const onRegionKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape" || !current) return;
    event.preventDefault(); // a sheet underneath must not close
    toastStore.dismiss(current.id);
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected) back.focus({ preventScroll: true });
  };

  if (!root) return null;
  const live = entries.find((entry) => !entry.leaving)?.toast ?? null;
  const said = live ? announcement(live, t("toast.added")) : "";
  const assertive = live?.kind === "error";

  return createPortal(
    <>
      {/* Present from the start, so the first toast is announced; keyed so the same words are announced again. */}
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {live && !assertive ? <span key={`${live.id}:${live.revision}`}>{said}</span> : null}
      </div>
      <div className="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
        {live && assertive ? <span key={`${live.id}:${live.revision}`}>{said}</span> : null}
      </div>
      {entries.length > 0 ? (
        <section
          ref={region}
          aria-label={t("toast.region")}
          aria-keyshortcuts="F6"
          onKeyDown={onRegionKeyDown}
          className={cx("pointer-events-none fixed start-(--gutter) end-(--gutter) z-(--z-toast) grid md:start-auto md:w-[400px]", className)}
          style={{ insetBlockStart: offset }}
        >
          {entries.map((entry) => (
            <ToastCard
              key={entry.key}
              toast={entry.toast}
              leaving={entry.leaving}
              solid={depth > 0}
              onGone={() => setEntries((list) => list.filter((item) => item.key !== entry.key))}
              onFocusLost={() => {
                // The toast that had focus is leaving: to the one replacing it, else back to where F6 came from.
                const next = region.current?.querySelector<HTMLElement>("[data-toast]:not([inert])");
                const target = next?.querySelector<HTMLElement>("a[href], button:not([disabled])") ?? returnFocus.current;
                if (!next) returnFocus.current = null;
                if (target?.isConnected) target.focus({ preventScroll: true });
              }}
            />
          ))}
        </section>
      ) : null}
    </>,
    root,
  );
}

function announcement(toast: Toast, added: string): string {
  if (toast.kind === "cart") {
    const what = [toast.name, toast.variant].filter(Boolean).join(" · ");
    return [toast.title ?? added, what].filter(Boolean).join(". ");
  }
  return [toast.title, toast.detail].filter(Boolean).join(". ");
}

type Drag = { id: number; x: number; y: number; axis: "x" | "y" | null; samples: { t: number; v: number }[] };

type CardProps = { toast: Toast; leaving: boolean; solid: boolean; onGone: () => void; onFocusLost: () => void };

function ToastCard({ toast, leaving, solid, onGone, onFocusLost }: CardProps) {
  const t = useT("ui-overlays");
  const card = useRef<HTMLElement | null>(null);
  const drag = useRef<Drag | null>(null);
  const swiped = useRef(false);
  const latest = useRef({ onGone, onFocusLost });
  useLayoutEffect(() => {
    latest.current = { onGone, onFocusLost };
  });
  const gone = { current: () => latest.current.onGone() };
  /** The pause reasons this card holds, released when it leaves (a card replaced under the pointer gets no pointerleave). */
  const holding = useRef(new Set<"hover" | "focus">());
  const hold = (reason: "hover" | "focus") => {
    holding.current.add(reason);
    toastStore.hold(reason);
  };
  const release = (reason: "hover" | "focus") => {
    if (holding.current.delete(reason)) toastStore.release(reason);
  };
  useEffect(
    () => () => {
      for (const reason of holding.current) toastStore.release(reason);
      holding.current.clear();
    },
    [],
  );

  // In: drops 8px from above with opacity (reduced motion: opacity only).
  useLayoutEffect(() => {
    const element = card.current;
    if (element) void materialize(element, { from: { x: element.getBoundingClientRect().left, y: 0 } });
  }, []);

  // Out: the way it came — unless a swipe already carried it off.
  useLayoutEffect(() => {
    if (!leaving) return;
    const element = card.current;
    if (element?.contains(document.activeElement)) latest.current.onFocusLost();
    release("hover");
    release("focus");
    if (!element || swiped.current) {
      gone.current();
      return;
    }
    let cancelled = false;
    void dematerialize(element).then(() => {
      if (!cancelled) gone.current();
    });
    return () => {
      cancelled = true;
    };
  }, [leaving]);

  const dismiss = () => toastStore.dismiss(toast.id);

  /* ── swipe to dismiss: sideways either way, or up (it sits at the top of the screen) ── */
  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (leaving || (event.pointerType === "mouse" && event.button !== 0)) return;
    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, samples: [] };
  };
  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    const element = card.current;
    if (!state || !element || event.pointerId !== state.id) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.axis) {
      if (Math.hypot(dx, dy) < 6) return;
      state.axis = Math.abs(dx) > Math.abs(dy) ? "x" : dy < 0 ? "y" : null;
      if (!state.axis) {
        drag.current = null; // pulled down: not a dismissal
        return;
      }
      for (const animation of element.getAnimations()) animation.cancel();
      element.setPointerCapture(event.pointerId);
      toastStore.hold("drag");
    }
    const value = state.axis === "x" ? dx : Math.min(0, dy);
    const size = state.axis === "x" ? element.offsetWidth : element.offsetHeight;
    element.style.translate = state.axis === "x" ? `${value}px 0` : `0 ${value}px`;
    element.style.opacity = String(1 - Math.min(Math.abs(value) / Math.max(size, 1), 1) * 0.6);
    state.samples.push({ t: event.timeStamp, v: value });
    if (state.samples.length > 6) state.samples.shift();
  };
  const onPointerEnd = (event: ReactPointerEvent<HTMLElement>) => {
    const state = drag.current;
    const element = card.current;
    if (!state || event.pointerId !== state.id) return;
    drag.current = null;
    if (!state.axis || !element) return;
    toastStore.release("drag");
    const first = state.samples[0];
    const last = state.samples[state.samples.length - 1];
    const value = last?.v ?? 0;
    const velocity = first && last && last.t > first.t ? (last.v - first.v) / (last.t - first.t) : 0; // px/ms
    const size = state.axis === "x" ? element.offsetWidth : element.offsetHeight;
    const from = { translate: element.style.translate || "0 0", opacity: element.style.opacity || "1" };
    const reduced = getMotionTier() === "reduced";
    const away = event.type !== "pointercancel" && (Math.abs(value) > size * 0.35 || (Math.abs(velocity) > 0.45 && Math.sign(velocity) === Math.sign(value)));
    if (away) {
      swiped.current = true;
      const end = Math.sign(value || -1) * (size + 24);
      const to = state.axis === "x" ? `${end}px 0` : `0 ${end}px`;
      const animation = element.animate([from, { translate: to, opacity: "0" }], {
        duration: reduced ? 120 : durations.exit,
        easing: easings.exit,
        fill: "forwards",
      });
      void animation.finished.then(dismiss, dismiss);
      return;
    }
    element.style.translate = "";
    element.style.opacity = "";
    if (!reduced) element.animate([from, { translate: "0 0", opacity: "1" }], springTiming("press"));
  };

  const run = (callback?: () => void) => () => {
    callback?.();
    dismiss();
  };
  const action = toast.onUndo ? (
    <Key size="sm" onClick={run(toast.onUndo)}>
      {toast.undoLabel ?? t("toast.undo")}
    </Key>
  ) : toast.action?.href ? (
    <Key as={LocaleLink} to={toast.action.href} size="sm" onClick={run(toast.action.onAction)}>
      {toast.action.label}
    </Key>
  ) : toast.action ? (
    <Key size="sm" onClick={run(toast.action.onAction)}>
      {toast.action.label}
    </Key>
  ) : (
    <IconKey icon="x" size="sm" label={t("toast.dismiss")} onClick={dismiss} />
  );

  const kind = toast.kind === "cart" ? null : KIND[toast.kind];
  const thumbnail = toast.art || toast.image || toast.kind === "cart";
  return (
    <Glass
      ref={(element: HTMLElement | null) => {
        card.current = element;
      }}
      variant={solid ? "solid" : "live"}
      data-toast=""
      data-kind={toast.kind}
      inert={leaving || undefined}
      aria-hidden={leaving || undefined}
      className="pointer-events-auto relative flex min-h-[60px] touch-none select-none items-center gap-2.5 rounded-md p-2 pe-2.5 [grid-area:1/1]"
      onPointerEnter={() => hold("hover")}
      onPointerLeave={() => release("hover")}
      onFocus={() => hold("focus")}
      onBlur={(event: ReactFocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) release("focus");
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      {thumbnail ? (
        // The product in a small niche (§9.13) instead of the kind's icon; the title says what happened.
        <span className="render-slot grid size-11 shrink-0 place-items-center overflow-hidden rounded-sm bg-stage p-1" aria-hidden="true">
          {toast.art ? (
            <Render name={toast.art} alt="" shadow={false} pose={0} sizes="44px" />
          ) : toast.image ? (
            <img src={toast.image.src} width={toast.image.width} height={toast.image.height} alt="" className="size-full rounded-[6px] object-cover" />
          ) : (
            <Icon name="shopping-bag" size={22} />
          )}
        </span>
      ) : kind ? (
        <span className="grid size-11 shrink-0 place-items-center rounded-sm bg-niche" aria-hidden="true">
          <Icon name={kind.icon} size={22} className={kind.tone} />
        </span>
      ) : null}
      <p className="flex min-w-0 flex-1 flex-col">
        <span className="text-[13.5px] font-semibold leading-[1.45] text-ink">{toast.kind === "cart" ? (toast.title ?? t("toast.added")) : toast.title}</span>
        {toast.kind === "cart" && toast.name ? (
          <span className="is-2 text-[12.5px] leading-[1.5]">
            <bdi>{toast.name}</bdi>
            {toast.variant ? (
              <>
                {" · "}
                <bdi>{toast.variant}</bdi>
              </>
            ) : null}
          </span>
        ) : toast.detail ? (
          <span className="is-2 text-[12.5px] leading-[1.5]">{toast.detail}</span>
        ) : null}
      </p>
      {action}
    </Glass>
  );
}
