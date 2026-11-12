import { useEffect, useRef, useState } from "react";

import { Chip } from "~/ui/Chip";
import { revealFocusedItem, revealInRow } from "~/ui/reveal";
import { currentSection } from "./format";

/**
 * The hub's sticky anchor nav — Design System v2 §6.6: one row of the kit's chips (40px, a 44px hit) under the header:
 * الإصدارات · قارن · المواصفات · الإكسسوارات · الألعاب · الإعداد والصيانة · الأسئلة · المستعمل — only the sections
 * this hub has. The section being read is the chosen chip (ink fill + check, `aria-current`) — none while the head is
 * on screen, the last one at the very end of the page; the row keeps it in view and scrolls sideways when it does
 * not fit. Plain `#fragment` links, so they work before JavaScript; the hub's stylesheet extends the page's scroll
 * padding by this row (devices.css), so a jump — and a focused control — lands below the header and the row. Opaque
 * floor colour, never glass (the header and the tab bar are the two live panes).
 */
export type SectionLink = { id: string; label: string };

/** The reading line: a section is "being read" once its top has passed 35% of the viewport's height. */
const READING_LINE = 0.35;

export function SectionNav({ sections, label }: { sections: readonly SectionLink[]; label: string }) {
  const [current, setCurrent] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const ids = sections.map((section) => section.id).join(" ");

  // measured on scroll (one read per frame): above the first section nothing is chosen, so going back up to the head
  // never leaves a stale chip behind
  useEffect(() => {
    const order = ids.split(" ");
    let frame = 0;
    const measure = () => {
      frame = 0;
      const tops: { id: string; top: number }[] = [];
      for (const id of order) {
        const element = document.getElementById(id);
        if (element) tops.push({ id, top: element.getBoundingClientRect().top });
      }
      const atEnd = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2;
      setCurrent(currentSection(tops, window.innerHeight * READING_LINE, atEnd));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [ids]);

  // keep the current chip inside the row (the row scrolls, never the page) — unless the reader is on another chip
  useEffect(() => {
    const row = list.current;
    if (!row || !current || row.contains(document.activeElement)) return;
    const link = row.querySelector<HTMLElement>(`a[href="#${current}"]`);
    if (link) revealInRow(row, link, "nearest");
  }, [current]);

  if (sections.length < 2) return null;
  return (
    <nav aria-label={label} className="devhub-nav">
      {/* a chip that takes the keyboard's focus is brought fully into the row (the kit's reveal: the row scrolls, never the page) */}
      <ul ref={list} role="list" className="devhub-nav__list" onFocus={revealFocusedItem}>
        {sections.map((section) => (
          <li key={section.id}>
            <Chip as="a" href={`#${section.id}`} selected={current === section.id} onClick={() => setCurrent(section.id)}>
              {section.label}
            </Chip>
          </li>
        ))}
      </ul>
    </nav>
  );
}
