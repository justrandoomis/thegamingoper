/**
 * Free text typed by shoppers (names, addresses, notes, references) — what is removed before it is validated and
 * stored (security review 2026-11).
 *
 *   name: z.string().overwrite(cleanLine).trim().min(2, "too_short").max(80, "too_long")     // one line
 *   notes: z.string().overwrite(cleanBlock).trim().max(500, "too_long")                       // line breaks kept
 *
 * Removed, because a person never types them on purpose and they can disguise text where staff read it (the order
 * page, packing slips, delivery labels, CSV exports): C0 and C1 control characters (NUL, ESC sequences, BEL…), the
 * bidirectional embedding / override / isolate controls (U+202A–U+202E, U+2066–U+2069: "Trojan Source" reordering —
 * an address or a name that displays differently from what it says), zero-width space (U+200B), word joiner (U+2060)
 * and a stray BOM (U+FEFF). Kept: everything a language needs — Arabic and Kurdish letters, ZWNJ / ZWJ (U+200C /
 * U+200D, which Sorani and Persian spelling uses), and the LRM / RLM marks (U+200E / U+200F), which only nudge
 * direction and cannot reorder. One-line fields turn line breaks and tabs into a space; multi-line fields keep line
 * breaks (as "\n"; U+2028, U+2029 and NEL become "\n" too).
 *
 * `.overwrite()` keeps the schema a ZodString (types unchanged) and runs first, so `.trim()`, `.min()` and `.max()`
 * judge the cleaned text: a value made only of control characters is "required"/"too_short", not a blank that passed.
 *
 * The character classes are built from code points (no literal or escaped special characters in this source file).
 * Pure; no imports. Must not import "cloudflare:workers".
 */

const ch = (code: number) => String.fromCharCode(code);
const span = (from: number, to: number) => `${ch(from)}-${ch(to)}`;

/** CR LF, CR, NEL (U+0085), LINE SEPARATOR (U+2028), PARAGRAPH SEPARATOR (U+2029). */
const LINE_BREAKS = new RegExp(`\\r\\n?|[${ch(0x85)}${ch(0x2028)}${ch(0x2029)}]`, "g");
/** C0 controls except TAB, LF and CR; DEL; C1 controls. */
const CONTROLS = new RegExp(`[${span(0x00, 0x08)}${ch(0x0b)}${ch(0x0c)}${span(0x0e, 0x1f)}${span(0x7f, 0x9f)}]`, "g");
/** LRE, RLE, PDF, LRO, RLO (U+202A–U+202E) and LRI, RLI, FSI, PDI (U+2066–U+2069). */
const BIDI_CONTROLS = new RegExp(`[${span(0x202a, 0x202e)}${span(0x2066, 0x2069)}]`, "g");
/** Zero-width space, word joiner, byte order mark. */
const INVISIBLES = new RegExp(`[${ch(0x200b)}${ch(0x2060)}${ch(0xfeff)}]`, "g");

export type CleanTextOptions = { multiline?: boolean };

/** The text without control, bidi-override and invisible characters (see the file header). */
export function cleanText(value: string, options: CleanTextOptions = {}): string {
  const text = value.replace(LINE_BREAKS, "\n").replace(BIDI_CONTROLS, "").replace(INVISIBLES, "").replace(CONTROLS, "");
  return options.multiline ? text.replace(/\t/g, " ") : text.replace(/[\n\t]+/g, " ");
}

/** For one-line fields: `z.string().overwrite(cleanLine)`. */
export const cleanLine = (value: string): string => cleanText(value);

/** For multi-line fields (notes, an address, a description of a fault): line breaks kept. */
export const cleanBlock = (value: string): string => cleanText(value, { multiline: true });

/** True when the text holds nothing cleanText() would remove — for tests and checks of stored data. */
export function isCleanText(value: string, options: CleanTextOptions = {}): boolean {
  return cleanText(value, options) === value;
}
