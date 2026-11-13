import type { ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";

/**
 * An icon row of a `<dl className="co-facts">` (client round 1: the review and the order show what was given as icon
 * rows — phone, recipient, place, address, time): the icon in a small clay circle at the start, the label (13px, muted)
 * over the value (16px). The circle is decorative: the label says what the row is.
 */
/**
 * What the shopper typed (a name, an area, an address, a note) in its own direction, aligned as the page: an Arabic
 * address on /en keeps its commas and its house number where they belong (review 2026-11-13). `.co-typed` in
 * checkout.css.
 */
export function Typed({ children }: { children: ReactNode }) {
  return (
    <span dir="auto" className="co-typed">
      {children}
    </span>
  );
}

export function Fact({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="co-fact">
      <dt className="co-fact__label">
        <span className="clay-disc co-fact__icon" aria-hidden="true">
          <Icon name={icon} size={18} />
        </span>
        {label}
      </dt>
      <dd className="co-fact__value">{children}</dd>
    </div>
  );
}
