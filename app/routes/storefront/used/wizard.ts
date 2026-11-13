/**
 * The trade-in wizard's shared, client-safe pieces (the page flow itself is ./trade-in.server.ts; the domain rules are
 * ~/server/services/tradein.server). Component code imports from here, never from a `.server` module.
 *
 *   TRADE_IN_PATH, WIZARD_STEPS, QUESTION_ORDER     the wizard's path and its steps, in order
 *   wizardOrder(search)                             the sideways-push order of a wizard URL (steps and questions)
 *   answeredQuestionSearch(entries, question)       a question's URL with its answer (what Back returns to)
 *   filterGroups(groups, query)                     the device search: every word in the device's or platform's name —
 *                                                   Arabic and Sorani spellings read as the catalogue's names
 *   tradeInRefFromInput(" ti-7k4m 2q9x ")           a typed request number → "TI-7K4M2Q9X", or null (the start page's
 *                                                   track card; the same shape as tradein.server normalizeTradeInRef)
 */
import { nameTerms, normalizeForMatch } from "~/server/services/support/matcher";
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

/**
 * A request number as people type it — any case, spaces or a dash in the middle, the «TI-» left out, Arabic-Indic
 * digits from a phone keyboard — in the one form the store writes it ("TI-" + 8 Crockford characters), or null when it
 * cannot be one. The server's own check is ~/server/services/tradein.server normalizeTradeInRef (same alphabet; a test
 * keeps the two in step). Pure.
 */
export function tradeInRefFromInput(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const latin = value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  const compact = latin.toUpperCase().replace(/[\s\-–—_]+/g, "");
  const body = compact.startsWith("TI") && compact.length === 10 ? compact.slice(2) : compact;
  return /^[2-9A-HJ-NP-Z]{8}$/.test(body) ? `TI-${body}` : null;
}

/**
 * The words of a name for the device search: lower case, Arabic letter variants folded, diacritics gone, digits Latin
 * (the support matcher's normalizeForMatch — the help centre reads names the same way), dashes and brackets as spaces.
 * Pure.
 */
export function searchText(value: string): string {
  return normalizeForMatch(value).replace(/-/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The device groups narrowed to `query` (the start page's device search; the server renders the same for a `?q=` sent
 * without script). Every word typed must be found in the device's name, slug or platform — as typed, or, for a name
 * spelled the shoppers' way («بلايستيشن», «اكس بوكس», «سويتش 2», «ستيم ديك», «روغ», Sorani), as the catalogue's words
 * it stands for (~/server/services/support/matcher nameTerms: the help centre's own spellings; a word still being
 * typed stands for every name it can begin). Pure.
 */
export function filterGroups(groups: readonly DeviceGroup[], query: string): DeviceGroup[] {
  const terms = nameTerms(query);
  if (terms.length === 0) return [...groups];
  const out: DeviceGroup[] = [];
  for (const group of groups) {
    const devices = group.devices.filter((device) => {
      const text = searchText(`${device.name} ${device.slug} ${group.platformName} ${group.platformSlug}`);
      const words = new Set(text.split(" "));
      return terms.every((term) => text.includes(term.typed) || term.names.some((name) => name.every((word) => words.has(word))));
    });
    if (devices.length > 0) out.push({ ...group, devices });
  }
  return out;
}
