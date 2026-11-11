/** Left-to-right isolate (U+2066), first-strong isolate (U+2068) and pop (U+2069). */
const LRI = String.fromCharCode(0x2066);
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);

/** Keeps `text` left-to-right inside a sentence of any direction (a plain-string `<bdi dir="ltr">`): phones, references. */
export const ltr = (text: string): string => `${LRI}${text}${PDI}`;

/**
 * An amount inside a sentence ("1,000 د.ع" from iqdText): isolated by its own first strong letter, so the figure reads
 * first in every language — "1,000 د.ع" in Arabic and Kurdish (figure at the start, the right), "1,000 IQD" in English —
 * like <Price>. (An LTR isolate would put the Arabic currency first when read right to left.)
 */
export const amount = (text: string): string => `${FSI}${text}${PDI}`;

/** The phone example of the hints, isolated so its digit groups keep their order in Arabic and Kurdish. */
export const PHONE_EXAMPLE = ltr("0770 123 4567");
