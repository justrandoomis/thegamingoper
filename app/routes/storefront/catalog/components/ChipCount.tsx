import { useFormat } from "~/i18n/react";

/**
 * How many products a choice gives, after its label: "Nintendo Switch 2 · 34". The dot keeps a number in the name
 * ("Switch 2") apart from the count; it is not read aloud. The chip's own colour, quieter — so it stays readable on a
 * held, ink-faced chip.
 */
export function ChipCount({ n }: { n: number }) {
  const f = useFormat();
  return (
    <>
      <span aria-hidden="true" className="opacity-50">
        {" · "}
      </span>
      <span className="nums opacity-75">{f.number(n)}</span>
    </>
  );
}
