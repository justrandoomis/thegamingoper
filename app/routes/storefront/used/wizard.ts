/**
 * The trade-in wizard's shared, client-safe pieces (the page flow itself is ./trade-in.server.ts; the domain rules are
 * ~/server/services/tradein.server). Component code imports from here, never from a `.server` module.
 *
 *   TRADE_IN_PATH, WIZARD_STEPS, QUESTION_ORDER     the wizard's path and its steps, in order
 *   wizardOrder(search)                             the sideways-push order of a wizard URL (steps and questions)
 *   answeredQuestionSearch(entries, question)       a question's URL with its answer (what Back returns to)
 *   filterGroups(groups, query)                     the device search: every word in the device's or platform's name
 */
import type { TradeInDevice, TradeInQuestion } from "~/server/services/tradein.server";

/** The wizard's path (locale-less). */
export const TRADE_IN_PATH = "/trade-in";
export const WIZARD_STEPS = ["device", "condition", "photos", "estimate", "inspection"] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];
/** Every question in the order it is asked (a device skips the ones that do not apply to it). */
export const QUESTION_ORDER: readonly TradeInQuestion[] = ["power", "body", "screen", "included", "account"];

export type DeviceGroup = { platformSlug: string; platformName: string; devices: TradeInDevice[] };

/** Steps (and the questions inside "condition") push sideways in order (docs/MOTION.md, sibling order from the URL). */
export function wizardOrder(search: string): number {
  const params = new URLSearchParams(search);
  const step = params.get("step");
  const index = Math.max(0, WIZARD_STEPS.indexOf((step ?? "device") as WizardStep));
  if (step !== "condition") return index * 10;
  const q = params.get("q");
  const at = params.get("at");
  const position = q ? QUESTION_ORDER.indexOf(q as TradeInQuestion) : at ? QUESTION_ORDER.indexOf(at as TradeInQuestion) + 1 : 0;
  return index * 10 + Math.max(0, position);
}

/**
 * "This question, with this answer": the search a question's history entry is rewritten to just before its form moves
 * on (the answer otherwise lives only in the NEXT step's URL, so the browser's Back would show the question empty).
 * `entries` are the form's fields (hidden answers, `at`, the chosen value); `at` and `q` give way to `q=<question>`.
 * Pure.
 */
export function answeredQuestionSearch(entries: Iterable<[string, FormDataEntryValue]>, question: string): string {
  const params = new URLSearchParams();
  for (const [name, value] of entries) if (typeof value === "string" && name !== "at" && name !== "q") params.append(name, value);
  params.set("q", question);
  return `?${params.toString()}`;
}

/** Lower-case words of a name for the device search (Latin names stay Latin; dashes and spaces collapse). Pure. */
export function searchText(value: string): string {
  return value
    .toLocaleLowerCase("en")
    .replace(/[\s\-–—_()]+/g, " ")
    .trim();
}

/** The device groups narrowed to `query`: every word must appear in the device's name, slug or platform. Pure. */
export function filterGroups(groups: readonly DeviceGroup[], query: string): DeviceGroup[] {
  const words = searchText(query).split(" ").filter(Boolean);
  if (words.length === 0) return [...groups];
  const out: DeviceGroup[] = [];
  for (const group of groups) {
    const devices = group.devices.filter((device) => {
      const haystack = searchText(`${device.name} ${device.slug} ${group.platformName} ${group.platformSlug}`);
      return words.every((word) => haystack.includes(word));
    });
    if (devices.length > 0) out.push({ ...group, devices });
  }
  return out;
}
