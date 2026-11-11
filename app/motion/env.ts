/**
 * Motion environment: the adaptive quality tier, the shopper's override, and haptics.
 *
 *   'full'     everything
 *   'lite'     primary motion only — secondary and ambient layers are dropped (stagger, overshoot, parallax,
 *              tilt, squish, idle motion). Chosen for Save-Data and low-memory / low-core devices.
 *   'reduced'  prefers-reduced-motion: short opacity cross-fades or nothing; no movement, no view transitions.
 *
 * SSR-safe: nothing touches `window` at module scope; on the server the tier is always 'full' and the
 * client corrects it right after hydration (CSS already honours `prefers-reduced-motion` before that).
 */
import { useSyncExternalStore } from "react";
import { haptics, type HapticKind } from "./tokens";

export type MotionTier = "full" | "lite" | "reduced";

export type TierSignals = {
  /** `(prefers-reduced-motion: reduce)` */
  reducedMotion: boolean;
  /** `navigator.connection.saveData` (the Save-Data client hint) */
  saveData: boolean;
  /** `navigator.deviceMemory` in GiB (Chromium only) */
  deviceMemory?: number;
  /** `navigator.hardwareConcurrency` */
  hardwareConcurrency?: number;
  /** The shopper's explicit choice; wins over every signal, in both directions. */
  override?: MotionTier | null;
};

/** Pure tier resolution (unit-tested). */
export function resolveTier(signals: TierSignals): MotionTier {
  if (signals.override === "full" || signals.override === "lite" || signals.override === "reduced") return signals.override;
  if (signals.reducedMotion) return "reduced";
  if (signals.saveData) return "lite";
  const memory = signals.deviceMemory;
  const cores = signals.hardwareConcurrency;
  if (memory !== undefined && memory <= 2) return "lite";
  if (cores !== undefined && cores <= 2) return "lite";
  // 4 GiB with four cores or fewer is the budget-Android profile; iPhones report no deviceMemory and stay 'full'.
  if (memory !== undefined && memory <= 4 && cores !== undefined && cores <= 4) return "lite";
  return "full";
}

const OVERRIDE_KEY = "tt:motion";
const QUERY = "(prefers-reduced-motion: reduce)";

let tier: MotionTier | null = null;
let watching = false;
const listeners = new Set<() => void>();

type NavigatorHints = Navigator & {
  connection?: { saveData?: boolean; addEventListener?: (type: string, listener: () => void) => void };
  deviceMemory?: number;
};

function isTier(value: unknown): value is MotionTier {
  return value === "full" || value === "lite" || value === "reduced";
}

/** Holds the override for this page view when localStorage is unavailable (private mode, embedded webview). */
let sessionOverride: MotionTier | null | undefined;

/** The shopper's stored override, or null when they follow the device. Browser only. */
export function getMotionOverride(): MotionTier | null {
  if (typeof window === "undefined") return null;
  if (sessionOverride !== undefined) return sessionOverride;
  try {
    const stored = window.localStorage.getItem(OVERRIDE_KEY);
    return isTier(stored) ? stored : null;
  } catch {
    return null; // storage blocked (private mode, embedded webview)
  }
}

function readSignals(): TierSignals {
  const nav = navigator as NavigatorHints;
  return {
    reducedMotion: typeof matchMedia === "function" && matchMedia(QUERY).matches,
    saveData: nav.connection?.saveData === true,
    deviceMemory: typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined,
    hardwareConcurrency: typeof nav.hardwareConcurrency === "number" ? nav.hardwareConcurrency : undefined,
    override: getMotionOverride(),
  };
}

function refresh(): void {
  const next = resolveTier(readSignals());
  if (next === tier) return;
  tier = next;
  for (const listener of listeners) listener();
}

function watch(): void {
  if (watching) return;
  watching = true;
  if (typeof matchMedia === "function") matchMedia(QUERY).addEventListener("change", refresh);
  (navigator as NavigatorHints).connection?.addEventListener?.("change", refresh);
  // Another tab changed the override.
  window.addEventListener("storage", (event) => {
    if (event.key === OVERRIDE_KEY) refresh();
  });
}

/** The current tier. 'full' on the server. */
export function getMotionTier(): MotionTier {
  if (typeof window === "undefined") return "full";
  if (tier === null) {
    tier = resolveTier(readSignals());
    watch();
  }
  return tier;
}

/** Subscribe to tier changes (OS setting, Save-Data, override). Returns the unsubscribe function. */
export function subscribeMotionTier(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const serverTier = (): MotionTier => "full";

/** Reactive tier. Renders 'full' on the server and during hydration, then the device's real tier. */
export function useMotionTier(): MotionTier {
  return useSyncExternalStore(subscribeMotionTier, getMotionTier, serverTier);
}

/** True when motion must be reduced to cross-fades (OS setting or the shopper's override). */
export function useReducedMotion(): boolean {
  return useMotionTier() === "reduced";
}

/**
 * Let the shopper choose their own tier ('full' | 'lite' | 'reduced'), or pass null to follow the device again.
 * Stored in localStorage; applies immediately everywhere, no reload.
 */
export function setMotionOverride(next: MotionTier | null): void {
  if (typeof window === "undefined") return;
  try {
    if (next === null) window.localStorage.removeItem(OVERRIDE_KEY);
    else window.localStorage.setItem(OVERRIDE_KEY, next);
    sessionOverride = undefined;
  } catch {
    sessionOverride = next; // storage unavailable: keep the choice for this page view
  }
  getMotionTier();
  refresh();
}

/**
 * A short vibration where the platform supports it (Android browsers); silently nothing elsewhere (iOS, desktop).
 * Never throws and never logs: browsers block vibration before the first completed tap, so that case is skipped.
 */
export function haptic(kind: HapticKind = "tap"): void {
  if (typeof navigator === "undefined" || typeof navigator.vibrate !== "function") return;
  const activation = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (activation && !activation.hasBeenActive) return;
  const pattern = haptics[kind];
  try {
    navigator.vibrate(typeof pattern === "number" ? pattern : [...pattern]);
  } catch {
    // vibration disallowed by policy
  }
}
