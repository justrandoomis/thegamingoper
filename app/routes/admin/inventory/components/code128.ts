/**
 * Code 128 (code set B) — the barcode printed on storage-location labels (04.02). Pure and client-safe.
 *
 *   const bars = code128("MAIN-A01-S02");   // { widths: [2,1,1,2,1,4, …], modules: 167 } — bar, space, bar, …
 *   <svg viewBox={`0 0 ${bars.modules} 40`}>{bars.rects.map(…)}</svg>
 *
 * Code set B covers printable ASCII (space … ~), which is every location code this module issues (A–Z, 0–9, "-",
 * "_", "."). Every keyboard-wedge barcode reader decodes it: it types the code and presses Enter, which the scan
 * fields of this module listen for. The symbol is: start B (104), the characters, the check character
 * ((104 + Σ value × position) mod 103) and stop, with a quiet zone of 10 modules on each side.
 */

/** Bar/space widths (in modules) of the 107 Code 128 symbols; 106 (stop) has 7 elements. */
export const CODE128_PATTERNS: readonly string[] = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

const START_B = 104;
const STOP = 106;
export const QUIET_ZONE = 10;

export type Code128 = {
  /** Symbol values: start, characters, check, stop. */
  values: number[];
  /** Element widths, alternating bar and space, starting with a bar (quiet zones not included). */
  widths: number[];
  /** Total width in modules, quiet zones included. */
  modules: number;
  /** Bars as [x, width] in modules (x counts the leading quiet zone). */
  bars: [number, number][];
};

/** True when `text` can be drawn with code set B. */
export function isCode128B(text: string): boolean {
  return text.length > 0 && text.length <= 80 && [...text].every((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126);
}

export function code128(text: string): Code128 {
  if (!isCode128B(text)) throw new RangeError("code128: only printable ASCII, 1 to 80 characters");
  const data = [...text].map((ch) => ch.charCodeAt(0) - 32);
  const check = (START_B + data.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
  const values = [START_B, ...data, check, STOP];
  const widths = values.flatMap((value) => [...(CODE128_PATTERNS[value] ?? "")].map(Number));
  const bars: [number, number][] = [];
  let x = QUIET_ZONE;
  widths.forEach((width, index) => {
    if (index % 2 === 0) bars.push([x, width]);
    x += width;
  });
  return { values, widths, modules: x + QUIET_ZONE, bars };
}

/** Reads the symbol values back from element widths (tests, and a self-check before printing). */
export function decodeCode128(widths: readonly number[]): string | null {
  const values: number[] = [];
  let i = 0;
  while (i < widths.length) {
    const size = widths.length - i === 7 ? 7 : 6;
    const chunk = widths.slice(i, i + size).join("");
    const value = CODE128_PATTERNS.indexOf(chunk);
    if (value === -1) return null;
    values.push(value);
    i += size;
  }
  if (values[0] !== START_B || values[values.length - 1] !== STOP || values.length < 4) return null;
  const data = values.slice(1, -2);
  const check = (START_B + data.reduce((sum, value, index) => sum + value * (index + 1), 0)) % 103;
  if (check !== values[values.length - 2]) return null;
  return data.map((value) => String.fromCharCode(value + 32)).join("");
}
