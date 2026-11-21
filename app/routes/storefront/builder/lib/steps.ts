/**
 * The builder's steps as addresses (client-safe): `/build/switch` is the device step, `?step=memory|games|review` the
 * others (docs/switch-builder.md §6.1). Steps push sideways in their own group, in this order.
 */
import { BUILDER_STEPS, type BuilderStep } from "~/lib/switch-builder/types";
import { SWITCH_BUILDER_PATH } from "../flags";

export function isBuilderStep(value: unknown): value is BuilderStep {
  return typeof value === "string" && (BUILDER_STEPS as readonly string[]).includes(value);
}

/** The step a query names; no step (or an unknown one) is the first step. */
export function stepOf(search: string | URLSearchParams): BuilderStep {
  const params = typeof search === "string" ? new URLSearchParams(search) : search;
  const step = params.get("step");
  return isBuilderStep(step) ? step : "device";
}

export function stepIndex(step: BuilderStep): number {
  return BUILDER_STEPS.indexOf(step);
}

/** The sideways-push order of a builder address (route handle `order`). */
export function stepOrder(search: string): number {
  return stepIndex(stepOf(search)) * 10;
}

/** A step's locale-less address. */
export function stepHref(step: BuilderStep): string {
  return step === "device" ? SWITCH_BUILDER_PATH : `${SWITCH_BUILDER_PATH}?step=${step}`;
}

export function nextStep(step: BuilderStep): BuilderStep | null {
  return BUILDER_STEPS[stepIndex(step) + 1] ?? null;
}

export function previousStep(step: BuilderStep): BuilderStep | null {
  const index = stepIndex(step);
  return index > 0 ? BUILDER_STEPS[index - 1] : null;
}
