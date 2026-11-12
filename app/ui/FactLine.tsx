import { hasRtl, splitBidi } from "./BidiText";
import { cx } from "./cx";

/**
 * One line of facts joined by « · » — the card's kind line («جهاز محمول · ROG Xbox Ally») and meta line («Ryzen AI Z2
 * Extreme · 24GB RAM»), the toast's product line (name · version) and the buy bar's version (Design System v2 §4.11,
 * §4.15, §4.16). A line that does not fit is shortened at its LOGICAL end and never cut through a Latin name:
 *
 *   · each fact is whole or not shown — a fact that does not fit beside the one before it drops out with its « · »
 *     (it wraps onto a hidden second row), so the line ends on a whole fact;
 *   · only a first fact wider than the line is shortened, inside its own isolate: a Latin-only fact is a left-to-right
 *     box, so its ellipsis falls at its end ("SteamOS Z1 Extreme 32…"), never at its start («…2GB / 1TB Nebula»);
 *   · inside a fact with Arabic or Kurdish words every Latin name is ONE piece: the ellipsis hides it whole («جهاز
 *     Switch 2 بسعة …») or shortens it at its own end — a plain one-line ellipsis in a right-to-left box cuts the
 *     visual left edge, which is the START of a trailing Latin name («…G Xbox Ally», «…nds: Z-A»; QA 2026-11-12).
 *
 *   <FactLine facts={["Ryzen AI Z2 Extreme", "24GB RAM"]} className="pcard__meta" />
 *   <FactLine facts={kindLabel.split(" · ")} />
 *   <FactLine facts={[battery, warranty, storage]} lines={2} />      a used row: up to two rows of whole facts
 *
 * Screen readers and copy read every fact, including the ones the width hides. Empty facts are skipped; no facts, nothing.
 */
export type FactLineProps = {
  facts: readonly (string | null | undefined | false)[];
  /** Rows that may show: 1 (default) or 2. */
  lines?: 1 | 2;
  as?: "span" | "p";
  className?: string;
};

export function FactLine({ facts, lines = 1, as: Tag = "span", className }: FactLineProps) {
  const list = facts.flatMap((fact) => (typeof fact === "string" && fact.trim() !== "" ? [fact.trim()] : []));
  if (list.length === 0) return null;
  return (
    <Tag className={cx("factline", lines === 2 && "factline--2", className)}>
      {list.map((fact, index) => (
        <span key={index} className="factline__fact">
          {index > 0 ? <span className="factline__sep"> · </span> : null}
          <Fact text={fact} />
        </span>
      ))}
    </Tag>
  );
}

/** An Arabic or Kurdish LETTER (not just an Arabic comma «،» between Latin names). Pure. */
export function hasRtlLetter(text: string): boolean {
  for (const char of text) if (hasRtl(char) && /\p{L}/u.test(char)) return true;
  return false;
}

/**
 * One fact in its own isolate: without Arabic-script letters → one left-to-right box («SteamOS، Z1 Extreme 32GB / 1TB»
 * in Kurdish is a Latin list with Arabic commas); with them → the page's direction, each Latin run one piece.
 */
function Fact({ text }: { text: string }) {
  if (!hasRtlLetter(text)) {
    return (
      <bdi dir="ltr" className="factline__text">
        {text}
      </bdi>
    );
  }
  const parts = splitBidi(text);
  return (
    <span className="factline__text bidi">
      {parts.map((part, index) =>
        part.ltr ? (
          // a Latin run that opens a longer fact leaves room for the fact's own ellipsis after it
          <bdi key={index} dir="ltr" className={index === 0 && parts.length > 1 ? "factline__lead" : undefined}>
            {part.text}
          </bdi>
        ) : (
          part.text
        ),
      )}
    </span>
  );
}
