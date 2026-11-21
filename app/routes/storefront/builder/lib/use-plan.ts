/**
 * The shopper's plan in the page (docs/switch-builder.md §6.1): kept in localStorage `tt.sb.plan.v1` on this device,
 * restored AFTER hydration — the server and the first client render both show the default plan — and checked against
 * what the store sells now (~/lib/switch-builder/plan reconcilePlan). Another tab's changes follow (the storage event).
 *
 *   const { plan, restored, setPlan, reset } = usePlan(catalog);
 *   setPlan(next)      the new plan (the page computes it with the pure helpers, so it can say why a change was refused)
 *   reset()            «ابدأ من جديد»: back to the default plan (the page keeps the old one for the toast's undo)
 */
import { useCallback, useEffect, useState } from "react";

import { decodePlan, defaultPlan, encodePlan, PLAN_STORAGE_KEY, reconcilePlan } from "~/lib/switch-builder/plan";
import type { BuilderCatalog, BuilderPlan } from "~/lib/switch-builder/types";

/** The stored plan; null when there is none, it cannot be read, or storage is blocked (private mode, a sandbox). */
function readStored(): BuilderPlan | null {
  try {
    return decodePlan(window.localStorage.getItem(PLAN_STORAGE_KEY));
  } catch {
    return null;
  }
}

function writeStored(plan: BuilderPlan): void {
  try {
    window.localStorage.setItem(PLAN_STORAGE_KEY, encodePlan(plan));
  } catch {
    // storage full or blocked: the plan still works for this visit
  }
}

export type PlanState = {
  plan: BuilderPlan;
  /** The stored plan has been read (false on the server and in the first client render). */
  restored: boolean;
  setPlan: (plan: BuilderPlan) => void;
  /** Back to the default plan (the page keeps the old one for the toast's undo). */
  reset: () => void;
};

export function usePlan(catalog: BuilderCatalog): PlanState {
  const [plan, setPlanState] = useState<BuilderPlan>(() => defaultPlan(catalog));
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    const saved = readStored();
    if (saved) setPlanState(reconcilePlan(saved, catalog));
    setRestored(true);
    const follow = (event: StorageEvent) => {
      if (event.key !== PLAN_STORAGE_KEY) return;
      const next = decodePlan(event.newValue);
      setPlanState(next ? reconcilePlan(next, catalog) : defaultPlan(catalog));
    };
    window.addEventListener("storage", follow);
    return () => window.removeEventListener("storage", follow);
  }, [catalog]);

  useEffect(() => {
    if (restored) writeStored(plan);
  }, [plan, restored]);

  const setPlan = useCallback((next: BuilderPlan) => setPlanState(next), []);
  const reset = useCallback(() => setPlanState(defaultPlan(catalog)), [catalog]);

  return { plan, restored, setPlan, reset };
}
