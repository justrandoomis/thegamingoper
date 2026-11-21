/**
 * The builder's spotlight guide (docs/switch-builder.md §6.7). STUB written by the lead; the sheet-and-tour owner
 * replaces the body and keeps the signature.
 */
import type { ReactNode } from "react";
import type { BuilderStep } from "~/lib/switch-builder/types";

export interface BuilderTour {
  /** Render this once in the page (the overlay; null while closed). */
  element: ReactNode;
  /** Show this step's guide again (the page's «?» key). */
  replay: () => void;
  open: boolean;
}

/** `ready` = the step's targets are on screen (e.g. the game list has loaded); the guide starts only then. */
export function useBuilderTour(_step: BuilderStep, _options: { ready: boolean }): BuilderTour {
  return { element: null, replay: () => undefined, open: false };
}
