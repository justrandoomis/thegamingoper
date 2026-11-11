/**
 * Code 128 (code set B) for shipping labels: the order reference as bars a keyboard-wedge scanner reads back as
 * text (ISO/IEC 15417). Pure and client-safe. `code128Modules("TT-7K4M2Q9X")` → the widths of bars and spaces,
 * alternating, starting with a bar, quiet zones excluded.
 */

/** Widths (bar, space, bar, space, bar, space) of the 107 symbols; 106 (stop) has a seventh bar. */
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

/** Symbol values for `text` in code set B (printable ASCII 32–126 only), with the start, checksum and stop symbols. */
export function code128Values(text: string): number[] | null {
  const values: number[] = [START_B];
  for (const char of text) {
    const code = char.charCodeAt(0);
    if (code < 32 || code > 126) return null;
    values.push(code - 32);
  }
  let checksum = START_B;
  for (let i = 1; i < values.length; i++) checksum += values[i] * i;
  values.push(checksum % 103, STOP);
  return values;
}

/** Bar and space widths in modules (a bar first), or null when the text cannot be encoded. */
export function code128Modules(text: string): number[] | null {
  const values = code128Values(text);
  if (!values) return null;
  return values.flatMap((value) => [...CODE128_PATTERNS[value]].map(Number));
}
