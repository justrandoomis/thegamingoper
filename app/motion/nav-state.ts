/**
 * Browser-side state for the navigation grammar: the pending intent, the history position and the memory of
 * how each history entry was reached. Module variables are only ever written in the browser (event handlers
 * and layout effects), never while rendering and never on the server.
 */
import type { MotionTier } from "./env";
import { resolveNav, type NavDescriptor, type NavIntent, type NavPlan, type NavRecord } from "./nav-plan";
import { recentClaim } from "./share-registry";

const STORAGE_KEY = "tt:nav";
const MEMORY_LIMIT = 40;
const INTENT_TTL = 8000;

let intent: (NavIntent & { at: number }) | null = null;
let lastIndex: number | null = null;
let lastOrder: number | null = null;
let committedKey: string | null = null;
let memory: Map<string, NavRecord> | null = null;

function loadMemory(): Map<string, NavRecord> {
  if (memory) return memory;
  memory = new Map();
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (raw) for (const [key, record] of JSON.parse(raw) as Array<[string, NavRecord]>) memory.set(key, record);
  } catch {
    // storage blocked or corrupt: start empty
  }
  return memory;
}

function saveMemory(): void {
  const entries = [...loadMemory()].slice(-MEMORY_LIMIT);
  memory = new Map(entries);
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // storage blocked: memory stays in this page view only
  }
}

/** React Router keeps the history position in `history.state.idx`. */
function historyIndex(): number | null {
  const state = window.history.state as { idx?: unknown } | null;
  return typeof state?.idx === "number" ? state.idx : null;
}

/** Ask for a transition on the next navigation. Expires on its own if no navigation follows. */
export function setNavIntent(next: NavIntent): void {
  if (typeof window === "undefined") return;
  intent = { ...next, at: performance.now() };
}

export function clearNavIntent(): void {
  intent = null;
}

function liveIntent(): NavIntent | null {
  if (!intent) return null;
  return performance.now() - intent.at <= INTENT_TTL ? intent : null;
}

/** Remember where we are without planning anything (first mount). */
export function noteLocation(descriptor: NavDescriptor): void {
  if (committedKey !== null) return;
  committedKey = descriptor.key;
  lastIndex = historyIndex();
  lastOrder = descriptor.order;
}

/** The location key that is on screen (updated when a navigation commits). */
export function getCommittedKey(): string | null {
  return committedKey;
}

/**
 * Read-only: decide the transition for `from` → `to`. Safe to call while rendering.
 * The language switch is instant below the full tier (DESIGN.md §6.5, §7.3); at the reduced tier every other
 * navigation is still planned, and motion.css turns it into a 120 ms cross-fade.
 */
export function planNavigation(from: NavDescriptor, to: NavDescriptor, type: "PUSH" | "POP" | "REPLACE", tier: MotionTier): NavPlan | null {
  if (typeof window === "undefined") return null;
  const index = historyIndex();
  const records = loadMemory();
  const plan = resolveNav({
    type,
    delta: type === "POP" && index !== null && lastIndex !== null ? index - lastIndex : null,
    from,
    to,
    intent: type === "POP" ? null : liveIntent(),
    arrivedBy: records.get(from.key) ?? null,
    destination: records.get(to.key) ?? null,
    fromOrder: lastOrder,
    claim: type === "POP" ? null : recentClaim(),
  });
  if (!plan || (plan.nav === "direction" && tier !== "full")) return null;
  // While this render is in progress <html dir> still belongs to the page being left.
  return { ...plan, fromDir: document.documentElement.dir === "rtl" ? "rtl" : "ltr" };
}

/**
 * Record that `to` is now on screen. Returns true the first time it is called for a location
 * (nested <PageTransition>s all report the same navigation).
 */
export function commitNavigation(plan: NavPlan | null, from: NavDescriptor, to: NavDescriptor, type: "PUSH" | "POP" | "REPLACE"): boolean {
  if (committedKey === to.key) return false;
  committedKey = to.key;
  lastIndex = historyIndex();
  if (plan) lastOrder = plan.order;
  else if (from.pathname !== to.pathname) lastOrder = to.order;
  else if (to.order !== null) lastOrder = to.order;
  if (type !== "POP") {
    const records = loadMemory();
    // A replaced entry keeps the story of how the shopper reached this history position, so Back still
    // undoes the original transition (a language switch must not rewrite it).
    const record: NavRecord | null =
      type === "REPLACE" ? (records.get(from.key) ?? null) : plan ? { nav: plan.nav, back: plan.back, origin: plan.origin, share: plan.share } : null;
    records.delete(to.key);
    if (record) records.set(to.key, record);
    saveMemory();
    intent = null;
  }
  return true;
}
