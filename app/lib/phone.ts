/**
 * Iraqi mobile numbers — client-safe.
 * Accepted input: 07XXXXXXXXX, 7XXXXXXXXX, +9647XXXXXXXXX, 009647XXXXXXXXX, with spaces/dashes,
 * and Arabic-Indic or Persian digits. Canonical storage form is E.164: +9647XXXXXXXXX.
 */
const ARABIC_INDIC = "٠١٢٣٤٥٦٧٨٩";
const PERSIAN = "۰۱۲۳۴۵۶۷۸۹";

/** Replace Arabic-Indic / Persian digits with Latin digits. */
export function toLatinDigits(input: string): string {
  let out = "";
  for (const ch of input) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    const p = PERSIAN.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    out += ch;
  }
  return out;
}

/** Returns the E.164 form (+9647XXXXXXXXX) or null when the input is not a valid Iraqi mobile number. */
export function normalizeIraqPhone(input: string | null | undefined): string | null {
  if (!input) return null;
  let digits = toLatinDigits(input).replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("964")) digits = digits.slice(3);
  if (digits.startsWith("0")) digits = digits.slice(1);
  // National significant number: 10 digits, mobile ranges 73x–79x.
  if (!/^7[3-9]\d{8}$/.test(digits)) return null;
  return `+964${digits}`;
}

/** "+9647719061852" → "0771 906 1852" (always Latin digits, always left-to-right). */
export function formatIraqPhone(e164: string): string {
  const n = e164.replace(/^\+964/, "0");
  if (n.length !== 11) return e164;
  return `${n.slice(0, 4)} ${n.slice(4, 7)} ${n.slice(7)}`;
}

/** Mask for logs and staff without the full-phone permission: "0771 ••• ••52". */
export function maskPhone(e164: string): string {
  const n = e164.replace(/^\+964/, "0");
  if (n.length < 6) return "••••";
  return `${n.slice(0, 4)} ••• ••${n.slice(-2)}`;
}
