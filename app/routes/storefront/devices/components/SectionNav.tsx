import { useEffect, useRef, useState } from "react";

import { getMotionTier } from "~/motion";
import { cx } from "~/ui/cx";

/**
 * The hub's section keys (DESIGN.md §8.7: "section keys: sticky anchor navigation"): one row of in-page links that
 * sticks under the header and scrolls sideways on a phone. Flat like tabs (they navigate, they do not commit): the
 * section on screen gets ink and the marker on the bottom edge (`aria-current="location"`); the row keeps it in view.
 * Plain `#fragment` links, so they work before JavaScript; the shell's scroll-padding and each section's
 * scroll-margin stop the jump below the header and this row. Opaque floor colour — never glass (the header and the
 * tab bar are the two live panes of a phone screen).
 */
export type SectionLink = { id: string; label: string };

const LINK =
  "relative inline-flex min-h-11 shrink-0 items-center whitespace-nowrap px-3 type-label text-ink-2 outline-offset-[-3px] hover:text-ink aria-[current=location]:text-ink " +
  "after:pointer-events-none after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-full after:bg-ink after:opacity-0 after:transition-opacity after:duration-(--t-micro) aria-[current=location]:after:opacity-100";

export function SectionNav({ sections, label, className }: { sections: readonly SectionLink[]; label: string; className?: string }) {
  const [current, setCurrent] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const ids = sections.map((section) => section.id).join(" ");

  // the section crossing a band a little above the middle of the viewport is the one being read
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const elements = ids
      .split(" ")
      .map((id) => document.getElementById(id))
      .filter((element): element is HTMLElement => element !== null);
    if (elements.length === 0) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) if (entry.isIntersecting) setCurrent(entry.target.id);
      },
      { rootMargin: "-35% 0px -60% 0px" },
    );
    for (const element of elements) observer.observe(element);
    return () => observer.disconnect();
  }, [ids]);

  // keep the current key inside the row (relative scroll: right in both reading directions)
  useEffect(() => {
    const row = list.current;
    if (!row || !current) return;
    const link = row.querySelector<HTMLElement>(`a[href="#${current}"]`);
    if (!link) return;
    const box = row.getBoundingClientRect();
    const rect = link.getBoundingClientRect();
    const behavior: ScrollBehavior = getMotionTier() === "full" ? "smooth" : "auto";
    if (rect.left < box.left) row.scrollBy({ left: rect.left - box.left - 16, behavior });
    else if (rect.right > box.right) row.scrollBy({ left: rect.right - box.right + 16, behavior });
  }, [current]);

  if (sections.length < 2) return null;
  return (
    <nav
      aria-label={label}
      className={cx("sticky top-[calc(var(--safe-top)+var(--shell-header-h))] z-(--z-sticky) -mx-(--gutter) border-b border-line bg-floor px-(--gutter)", className)}
    >
      <ul ref={list} role="list" className="flex min-w-0 gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {sections.map((section) => (
          <li key={section.id} className="flex">
            <a href={`#${section.id}`} className={LINK} aria-current={current === section.id ? "location" : undefined} onClick={() => setCurrent(section.id)}>
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
