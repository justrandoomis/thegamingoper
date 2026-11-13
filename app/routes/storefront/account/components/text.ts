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

/** The one "talk to a person" destination (Design System v2 §6.13): the assistant's hand-off form. */
export const HANDOFF = "/support/assistant?handoff=1#handoff";

/**
 * "46 minutes ago" in the page's language, at the kit's thresholds (f.relative: under a minute, minutes under an hour,
 * hours under a day, then days). Intl has no Sorani data — Chromium fell back to English («دوایین بەکارهێنان 46 minutes
 * ago») and the server's ICU to «-46 min», a hydration mismatch (QA 2026-11-13) — so Sorani is written from the account's
 * own words (`settings.ago.*`, plural-aware); Arabic and English keep Intl's. Pure.
 */
export function ago(
  t: (key: string, vars?: Record<string, string | number>) => string,
  f: { locale: string; number: (value: number) => string; relative: (epochMs: number, nowMs?: number) => string },
  at: number,
  now: number,
): string {
  if (f.locale !== "ckb" && typeof Intl.RelativeTimeFormat === "function") return f.relative(at, now);
  const diff = Math.max(0, now - at);
  const words = (unit: "minutes" | "hours" | "days", size: number) => {
    const n = Math.round(diff / size);
    return t(`settings.ago.${unit}`, { count: n, n: f.number(n) });
  };
  if (diff < 60_000) return t("settings.ago.now");
  if (diff < 3_600_000) return words("minutes", 60_000);
  if (diff < 86_400_000) return words("hours", 3_600_000);
  return words("days", 86_400_000);
}

/** "926931742" → "9269 3174 2": a long number read in groups of four (copying keeps the digits). */
export function grouped(value: string): string {
  return /^\d{8,}$/.test(value) ? (value.match(/.{1,4}/g) ?? [value]).join(" ") : value;
}
