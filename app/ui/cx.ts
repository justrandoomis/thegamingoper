/**
 * Join class names, skipping falsy parts.
 *
 *   cx("key", variant === "commit" && "key--red", className)   → "key key--red extra"
 *
 * No deduplication and no Tailwind conflict resolution: the design-system classes live in the `components` layer
 * and utilities in the `utilities` layer, so a utility passed in `className` always wins without merging.
 */
export type ClassValue = string | number | false | null | undefined;

export function cx(...parts: ClassValue[]): string {
  let out = "";
  for (const part of parts) {
    if (!part && part !== 0) continue;
    out = out ? `${out} ${part}` : String(part);
  }
  return out;
}
