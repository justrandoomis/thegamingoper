import type { ReactNode } from "react";

import { useDir } from "~/i18n/react";
import { ChipCount } from "./ChipCount";

/**
 * Text laid out in the PAGE's direction inside an auto-direction isolate (a chip's <bdi> label). A name such as
 * "PlayStation 5 (الطراز الأصلي 2020)" starts with Latin, so an auto isolate would read it left-to-right and pull the
 * brackets apart; in an Arabic or Kurdish page it is an Arabic phrase with a Latin name in it.
 */
export function InPageDir({ children }: { children: ReactNode }) {
  return <span dir={useDir()}>{children}</span>;
}

/**
 * "label · count" for a chip: the label isolated in the page's direction, so the count always ends the chip — a count
 * after "ألعاب Nintendo Switch" would otherwise join the Latin run and land in the middle.
 */
export function ChipText({ label, count }: { label: ReactNode; count: number }) {
  const dir = useDir();
  return (
    <span dir={dir}>
      <span dir={dir}>{label}</span>
      <ChipCount n={count} />
    </span>
  );
}
