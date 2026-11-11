import { useId, type ReactNode } from "react";

import type { IconName } from "~/art/Icon";
import { cx } from "./cx";
import { Disclosure } from "./Disclosure";

/**
 * Accordion — a stack of <Disclosure> rows between hairlines (FAQ, policy sections, a device's troubleshooting
 * topics). Native <details>, so it works without JavaScript and find-in-page opens the right row.
 *
 *   <Accordion items={faq.map((q) => ({ id: q.id, summary: q.question, content: q.answer }))} />
 *   <Accordion exclusive defaultOpen={["shipping"]} items={…} />        one row open at a time
 *
 * `exclusive` uses the native <details name> group (Chromium 120+, Safari 17.2+, Firefox 130+); an older browser
 * simply lets several rows stay open.
 */
export type AccordionItem = {
  id: string;
  summary: ReactNode;
  content: ReactNode;
  icon?: IconName;
};

export type AccordionProps = {
  items: readonly AccordionItem[];
  /** One row open at a time. */
  exclusive?: boolean;
  /** Ids of the rows that start open. */
  defaultOpen?: readonly string[];
  className?: string;
};

export function Accordion({ items, exclusive = false, defaultOpen = [], className }: AccordionProps) {
  const group = useId();
  return (
    <div className={cx("min-w-0 border-t border-line", className)}>
      {items.map((item) => (
        <Disclosure key={item.id} name={exclusive ? group : undefined} defaultOpen={defaultOpen.includes(item.id)} summary={item.summary} icon={item.icon}>
          {item.content}
        </Disclosure>
      ))}
    </div>
  );
}
