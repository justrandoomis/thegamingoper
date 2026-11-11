/**
 * The maintenance assistant's conversation state — client-safe, pure.
 *
 * The whole conversation lives in the page URL, never in a database row: which platform and device, what the shopper
 * typed (`q`), which verified symptom tree, and the index of every answer given in it.
 *
 *   /support/assistant?device=ps5-slim&symptom=no_power&a=1&a=0
 *
 * So every step is a plain link (works without JavaScript, survives a reload), Back undoes the last answer, and
 * nothing is stored until the shopper asks for a person (handoff, with consent). The server replays the state through
 * the approved tree on every request (assistant.server.ts), so a hand-edited URL can only ever select verified text.
 */

export type AssistantState = {
  platform: string | null;
  /** A device model slug, or "other" when the shopper's device is not in our list. */
  device: string | null;
  /** What the shopper typed into the composer (one message; a new one replaces it). */
  q: string | null;
  /** Symptom key of an approved troubleshooting tree. */
  symptom: string | null;
  /** Option index chosen at each node of the tree, from its start. */
  answers: number[];
  /** Show the "talk to staff" form. */
  handoff: boolean;
};

export const EMPTY_ASSISTANT_STATE: AssistantState = Object.freeze({ platform: null, device: null, q: null, symptom: null, answers: [], handoff: false }) as AssistantState;

export const DEVICE_OTHER = "other";
export const MAX_QUESTION_LENGTH = 300;
export const MAX_ANSWERS = 40;
const MAX_OPTION_INDEX = 19;

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SYMPTOM = /^[a-z][a-z0-9_]{0,39}$/;

type ParamsLike = { get(name: string): string | null; getAll(name: string): string[] };

/** C0 controls, DEL and the two Unicode line separators (built from code points so the source stays plain ASCII). */
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(0x1f)}${String.fromCharCode(0x7f)}${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]+`, "g");

/** The free text as stored: control characters removed, white space collapsed, at most 300 characters. */
export function cleanQuestion(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const text = value
    .replace(CONTROL, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUESTION_LENGTH)
    .trim();
  return text === "" ? null : text;
}

/** Reads the state from a query string. Anything malformed is dropped, never an error. */
export function parseAssistantState(params: ParamsLike): AssistantState {
  const slug = (value: string | null) => (value && SLUG.test(value) ? value : null);
  const symptom = params.get("symptom");
  const answers: number[] = [];
  for (const raw of params.getAll("a")) {
    if (answers.length >= MAX_ANSWERS || !/^\d{1,2}$/.test(raw)) break;
    const index = Number(raw);
    if (index > MAX_OPTION_INDEX) break;
    answers.push(index);
  }
  const state: AssistantState = {
    platform: slug(params.get("platform")),
    device: slug(params.get("device")),
    q: cleanQuestion(params.get("q")),
    symptom: symptom && SYMPTOM.test(symptom) ? symptom : null,
    answers,
    handoff: params.get("handoff") === "1",
  };
  // Answers only mean something inside a tree.
  if (!state.symptom && !state.q) state.answers = [];
  return state;
}

/** The query string of a state ("?device=…&a=0"), "" for the empty state. Parameters always in the same order. */
export function assistantSearch(state: AssistantState): string {
  const params = new URLSearchParams();
  if (state.platform && !state.device) params.set("platform", state.platform);
  if (state.device) params.set("device", state.device);
  if (state.q) params.set("q", state.q);
  if (state.symptom) params.set("symptom", state.symptom);
  for (const answer of state.answers) params.append("a", String(answer));
  if (state.handoff) params.set("handoff", "1");
  const text = params.toString();
  return text ? `?${text}` : "";
}

export function withState(state: AssistantState, patch: Partial<AssistantState>): AssistantState {
  return { ...state, ...patch };
}

/** The hidden form fields that carry a state through a POST (the handoff form, the repair link). */
export function stateFields(state: AssistantState): Array<[string, string]> {
  const fields: Array<[string, string]> = [];
  for (const [name, value] of new URLSearchParams(assistantSearch(state).slice(1))) if (name !== "handoff") fields.push([name, value]);
  return fields;
}
