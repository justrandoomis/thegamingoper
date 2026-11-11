import { useSyncExternalStore } from "react";

/**
 * Toasts — the store (docs/DESIGN.md §9.13). The logic is plain TypeScript with no framework in it (unit-tested in
 * tests/ui-overlays.test.ts); `useToasts()` at the bottom is the one React hook, used by <Toaster> (./Toast.tsx).
 *
 *   import { toast } from "~/ui/toast-store";
 *   toast.success(t("addressSaved"));
 *   toast.error(t("saveFailed"), { detail: t("tryAgain"), action: { label: t("retry"), onAction: save } });
 *   toast.cart({ name: "Xbox Series X", variant: "1TB", art: "xbox-series-x--1", onUndo: () => removeLine(lineId) });
 *   const id = toast.info(t("copied")); toast.dismiss(id);
 *
 * Rules the store enforces:
 *  - ONE toast is on screen at a time; a new one replaces it (§9.13). The exception is importance: a toast that is
 *    less important than the one showing (error > warning > info · success · cart) waits behind it instead of
 *    pushing it away. At most `limit` (3) toasts wait; beyond that the oldest waiting one is dropped.
 *  - The same `id` updates the toast in place (a cart toast defaults to id "cart", so rapid adds refresh one toast
 *    instead of queueing several); the update counts as new content, so it is announced and its 4s start again.
 *  - A toast leaves after `duration` (4000 ms; `Infinity` = until dismissed). The clock only runs while a <Toaster>
 *    is mounted and nothing holds it: the Toaster holds it while the pointer is over the toast, while focus is in
 *    it, while it is being dragged and while the tab is hidden.
 *  - Anything that needs a decision is not a toast: it is inline (§9.13). Toasts never carry the commit key.
 *  - On the server every call is a no-op: toasts exist only in the browser.
 */
export type ToastKind = "info" | "success" | "warning" | "error" | "cart";

export type ToastAction = {
  /** What the key does, in the shopper's words ("اعرض السلة"). */
  label: string;
  /** Runs, then the toast is dismissed. */
  onAction?: () => void;
  /** A link instead: a locale-less path ("/cart"); rendered with <LocaleLink>. */
  href?: string;
};

/** An uploaded photo for the thumbnail (used devices); renders and product photos use `art`. */
export type ToastImage = { src: string; width: number; height: number };

export type Toast = {
  id: string;
  kind: ToastKind;
  /** First line, bold. A cart toast without one says "أُضيف إلى السلة" (ui-overlays:toast.added). */
  title?: string;
  /** Second line, on-glass-2. */
  detail?: string;
  /** Cart toasts: the product name and the variant line ("Xbox Series X · 1TB"). */
  name?: string;
  variant?: string;
  /** Cart toasts: an <Art> key for the thumbnail ("xbox-series-x--1"). */
  art?: string;
  image?: ToastImage;
  /** The one small clay key: an action or a link. */
  action?: ToastAction;
  /** Cart toasts: shows the undo key ("تراجع"); runs, then the toast is dismissed. */
  onUndo?: () => void;
  undoLabel?: string;
  /** Milliseconds on screen once shown. `Infinity` keeps it until it is dismissed. */
  duration: number;
  /** Bumped when the same id is shown again with new content (it is announced again, its clock restarts). */
  revision: number;
};

export type ToastInput = Omit<Toast, "id" | "duration" | "revision"> & { id?: string; duration?: number };

export type ToastOptions = {
  /** Same id = update in place instead of showing another toast. */
  id?: string;
  detail?: string;
  action?: ToastAction;
  duration?: number;
};

export type CartToastInput = {
  /** Default "cart": rapid adds refresh one toast. */
  id?: string;
  name: string;
  variant?: string;
  art?: string;
  image?: ToastImage;
  /** Default "أُضيف إلى السلة". */
  title?: string;
  onUndo?: () => void;
  undoLabel?: string;
  /** Used when there is no undo (e.g. "اعرض السلة" → /cart). */
  action?: ToastAction;
  duration?: number;
};

export type ToastState = { readonly current: Toast | null; readonly queue: readonly Toast[] };

export type ToastTimers = {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  now: () => number;
};

export type ToastStoreConfig = {
  /** Toasts allowed to wait behind the visible one. Default 3. */
  limit?: number;
  /** Default time on screen, ms. Default 4000 (DESIGN.md §9.13). */
  duration?: number;
  /** Injected clock (tests). Default: setTimeout / Date.now. */
  timers?: ToastTimers;
};

export type ToastStore = ReturnType<typeof createToastStore>;

export const TOAST_DURATION = 4000;
export const TOAST_QUEUE_LIMIT = 3;

const EMPTY: ToastState = Object.freeze({ current: null, queue: Object.freeze([]) as readonly Toast[] });

/** Importance: a toast never pushes away a more important one. */
export function toastRank(kind: ToastKind): number {
  return kind === "error" ? 3 : kind === "warning" ? 2 : 1;
}

const realTimers: ToastTimers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export function createToastStore(config: ToastStoreConfig = {}) {
  const limit = Math.max(0, Math.floor(config.limit ?? TOAST_QUEUE_LIMIT));
  const defaultDuration = config.duration ?? TOAST_DURATION;
  const timers = config.timers ?? realTimers;

  let state: ToastState = EMPTY;
  let seq = 0;
  let attached = 0;
  const holds = new Set<string>();
  const listeners = new Set<() => void>();
  /** The visible toast's clock. */
  let clock: { id: string; revision: number; remaining: number; startedAt: number | null; handle: unknown } | null = null;

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const stopClock = () => {
    if (!clock || clock.startedAt === null) return;
    clock.remaining -= timers.now() - clock.startedAt;
    clock.startedAt = null;
    timers.clear(clock.handle);
    clock.handle = null;
  };

  /** Runs the visible toast's clock exactly when a Toaster shows it and nothing holds it. */
  const schedule = () => {
    const current = state.current;
    if (!current) {
      stopClock();
      clock = null;
      return;
    }
    if (!clock || clock.id !== current.id || clock.revision !== current.revision) {
      stopClock();
      clock = { id: current.id, revision: current.revision, remaining: current.duration, startedAt: null, handle: null };
    }
    const running = clock.startedAt !== null;
    const shouldRun = attached > 0 && holds.size === 0 && Number.isFinite(clock.remaining);
    if (running && !shouldRun) {
      stopClock();
    } else if (!running && shouldRun) {
      const { id, revision } = clock;
      clock.startedAt = timers.now();
      clock.handle = timers.set(
        () => {
          // Only the toast (and the version of it) this clock was started for.
          if (state.current?.id === id && state.current.revision === revision) dismiss(id);
        },
        Math.max(0, clock.remaining),
      );
    }
  };

  const commit = (next: ToastState) => {
    state = next;
    schedule();
    emit();
  };

  /** The most important waiting toast; the oldest among equals. */
  const takeNext = (queue: readonly Toast[]): [Toast | null, Toast[]] => {
    if (queue.length === 0) return [null, []];
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (toastRank(queue[i].kind) > toastRank(queue[best].kind)) best = i;
    return [queue[best], queue.filter((_, i) => i !== best)];
  };

  function show(input: ToastInput): string {
    const id = input.id ?? `toast-${++seq}`;
    const duration = input.duration ?? defaultDuration;
    const { current, queue } = state;
    if (current && current.id === id) {
      commit({ current: { ...input, id, duration, revision: current.revision + 1 }, queue });
      return id;
    }
    const toast: Toast = { ...input, id, duration, revision: 0 };
    const waiting = queue.filter((item) => item.id !== id);
    if (!current || toastRank(toast.kind) >= toastRank(current.kind)) {
      // One toast at a time: the new one replaces what is showing.
      commit({ current: toast, queue: waiting });
      return id;
    }
    // Less important than what is showing: wait behind it.
    const next = [...waiting, toast];
    commit({ current, queue: next.slice(Math.max(0, next.length - limit)) });
    return id;
  }

  /** Remove one toast (the next waiting one takes its place), or every toast when no id is given. */
  function dismiss(id?: string): void {
    if (id === undefined) {
      if (state !== EMPTY) commit(EMPTY);
      return;
    }
    const { current, queue } = state;
    if (current?.id === id) {
      const [next, rest] = takeNext(queue);
      commit(next ? { current: next, queue: rest } : EMPTY);
    } else if (queue.some((item) => item.id === id)) {
      commit({ current, queue: queue.filter((item) => item.id !== id) });
    }
  }

  return {
    show,
    dismiss,
    /** Stop the clock for a reason ("hover", "focus", "drag", "hidden"); it restarts when every reason is released. */
    hold(reason: string): void {
      if (holds.has(reason)) return;
      holds.add(reason);
      schedule();
    },
    release(reason: string): void {
      if (!holds.delete(reason)) return;
      schedule();
    },
    /** A <Toaster> is showing the store; the clock only runs while one is. Returns the detach function. */
    attach(): () => void {
      attached++;
      schedule();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        attached = Math.max(0, attached - 1);
        schedule();
      };
    },
    getState: (): ToastState => state,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/* ───────────────────────────── the app's store ───────────────────────────── */

/** The one store <Toaster> shows. Feature code uses `toast` below. */
export const toastStore = createToastStore();

const inBrowser = typeof window !== "undefined";

/** Show a toast. Every call returns the toast's id (an empty string on the server, where nothing happens). */
export const toast = {
  info: (title: string, options: ToastOptions = {}): string => (inBrowser ? toastStore.show({ kind: "info", title, ...options }) : ""),
  success: (title: string, options: ToastOptions = {}): string => (inBrowser ? toastStore.show({ kind: "success", title, ...options }) : ""),
  warning: (title: string, options: ToastOptions = {}): string => (inBrowser ? toastStore.show({ kind: "warning", title, ...options }) : ""),
  error: (title: string, options: ToastOptions = {}): string => (inBrowser ? toastStore.show({ kind: "error", title, ...options }) : ""),
  /** The "added to cart" toast: thumbnail, name · variant, and an undo key when `onUndo` is given. */
  cart: (input: CartToastInput): string => (inBrowser ? toastStore.show({ kind: "cart", ...input, id: input.id ?? "cart" }) : ""),
  /** Remove one toast, or all of them. */
  dismiss: (id?: string): void => toastStore.dismiss(id),
};

const serverState = (): ToastState => EMPTY;

/** The visible toast and the ones waiting, for <Toaster>. Always empty on the server and during hydration. */
export function useToasts(): ToastState {
  return useSyncExternalStore(toastStore.subscribe, toastStore.getState, serverState);
}
