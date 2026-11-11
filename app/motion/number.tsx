/**
 * <NumberMorph value format /> — digits roll to the new value in ~220 ms.
 *
 *   const f = useFormat();
 *   <NumberMorph value={product.priceIqd} format={f.money} />       // also morphs when the display currency changes
 *   <NumberMorph value={cart.count} />
 *
 * - Assistive technology gets the final text immediately (a visually hidden copy); the animated glyphs are aria-hidden.
 * - Only digits and their separators are split into slots, inside a left-to-right island, so Arabic currency text
 *   keeps its shaping and the bidi order is the same as plain text. Works with Latin and Arabic-Indic digits.
 * - Tabular figures: a changing digit never nudges its neighbours. When the number of characters changes the row
 *   takes its new width once, at the start — nothing animates layout.
 * - Rolls up when the value grows, down when it shrinks; text around the digits (currency) cross-fades.
 * - Server-rendered output is the plain final value; nothing animates on first paint.
 */
import { useState, type CSSProperties, type HTMLAttributes } from "react";

export type NumberMorphProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  value: number;
  /** Turns the value into display text (e.g. `useFormat().money`). Default: `String(value)`. */
  format?: (value: number) => string;
};

type Segment = { number: boolean; text: string };

/** A digit, optionally followed by more digits with grouping/decimal separators between them. */
const NUMBER_RUN = /\p{Nd}(?:[\p{Nd}.,٫٬'    ]*\p{Nd})?/gu;

function segment(text: string): Segment[] {
  const out: Segment[] = [];
  let index = 0;
  for (const match of text.matchAll(NUMBER_RUN)) {
    const start = match.index;
    if (start > index) out.push({ number: false, text: text.slice(index, start) });
    out.push({ number: true, text: match[0] });
    index = start + match[0].length;
  }
  if (index < text.length) out.push({ number: false, text: text.slice(index) });
  return out;
}

type Snapshot = { text: string; value: number; previous: string | null; direction: 1 | -1; tick: number };

export function NumberMorph({ value, format, className, style, ...rest }: NumberMorphProps) {
  const text = format ? format(value) : String(value);

  const [snapshot, setSnapshot] = useState<Snapshot>(() => ({ text, value, previous: null, direction: 1, tick: 0 }));
  let current = snapshot;
  if (snapshot.text !== text) {
    current = { text, value, previous: snapshot.text, direction: value < snapshot.value ? -1 : 1, tick: snapshot.tick + 1 };
    setSnapshot(current);
  }

  const now = segment(current.text);
  const before = current.previous === null ? null : segment(current.previous);
  const beforeNumbers = before?.filter((s) => s.number) ?? [];
  const beforeTexts = before?.filter((s) => !s.number) ?? [];
  let numberIndex = 0;
  let textIndex = 0;

  return (
    <span className={className ? `tt-num ${className}` : "tt-num"} style={style} {...rest}>
      <span className="tt-num-sr">{current.text}</span>
      <span aria-hidden="true" style={{ "--tt-num-dir": current.direction } as CSSProperties}>
        {now.map((part, partIndex) => {
          if (!part.number) {
            const old = beforeTexts[textIndex++]?.text;
            const changed = before !== null && old !== part.text;
            return (
              <span key={`t${partIndex}:${changed ? current.tick : 0}`} className={changed ? "tt-num-text-in" : undefined}>
                {part.text}
              </span>
            );
          }
          const chars = Array.from(part.text);
          const old = beforeNumbers[numberIndex++];
          const oldChars = old ? Array.from(old.text) : null;
          return (
            <span key={`n${partIndex}`} className="tt-num-run">
              {chars.map((char, i) => {
                const fromEnd = chars.length - i;
                const previous = oldChars ? oldChars[oldChars.length - fromEnd] : undefined;
                const changed = before !== null && previous !== char;
                // Western digits get a fixed 1ch box: not every font honours tabular-nums (heavy weights often do not).
                const digit = char >= "0" && char <= "9";
                return (
                  <span key={fromEnd} className={digit ? "tt-num-slot tt-num-digit" : "tt-num-slot"}>
                    {changed && previous !== undefined ? (
                      <span key={`o${current.tick}`} className="tt-num-out">
                        {previous}
                      </span>
                    ) : null}
                    <span key={changed ? `i${current.tick}` : "s"} className={changed ? "tt-num-in" : undefined}>
                      {char}
                    </span>
                  </span>
                );
              })}
            </span>
          );
        })}
      </span>
    </span>
  );
}
