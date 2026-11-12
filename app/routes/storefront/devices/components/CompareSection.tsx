import { useId, type CSSProperties, type FocusEvent } from "react";

import { useFormat, useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import type { CompareRow, DeviceHub } from "~/server/services/devices.server";
import { BidiText } from "~/ui/BidiText";
import { Niche } from "~/ui/Niche";
import { SectionHead } from "~/ui/SectionHead";
import { Render } from "~/ui/Stage";
import { deviceIn, isolateName, researchDate } from "./format";
import { revealInRow } from "~/ui/reveal";

/** A link inside the scrolling table took focus: bring it fully into view, clear of the sticky first column. */
function revealFocused(event: FocusEvent<HTMLDivElement>) {
  const region = event.currentTarget;
  if (event.target === region || !(event.target instanceof HTMLElement)) return;
  const sticky = region.querySelector("thead th")?.getBoundingClientRect().width ?? 0;
  // the sticky first column covers the row's start: it is the row's start padding for the kit's reveal
  region.style.scrollPaddingInlineStart = `${Math.round(sticky)}px`;
  revealInRow(region, event.target, "nearest");
}

/**
 * Comparison with sibling models — v2 §6.6: a paper table with hairlines, the first column sticky while the table
 * scrolls sideways on a phone (the region is focusable, so a keyboard scrolls it too). Rows are fixed comparable facts
 * (release date, storage, discs, screen, …) read from each model's researched spec sheet; a fact our sources do not
 * give reads «غير موثّق» — never a guess. The current device's column carries an ink line and «هذا الجهاز»; each
 * sibling's name opens its own hub with the sideways push (neighbouring contexts), in the store's model order.
 */
export function CompareSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const f = useFormat();
  const titleId = useId();
  const comparison = hub.comparison;
  if (!comparison) return null;
  const device = deviceIn(hub.model.name);
  const columns = comparison.columns;

  const cellText = (row: CompareRow, cell: string[]) => (row.id === "released" ? cell.map((value) => researchDate(value, f)?.text ?? value) : cell);

  return (
    <section id="compare" aria-labelledby={titleId} className="min-w-0">
      <SectionHead id={titleId} title={t("compare.title", { device })} reason={<span className="lg:hidden">{t("compare.hint")}</span>} />
      {/* `relative` makes the region the containing block of the screen-reader-only caption, so it is clipped with the
          table instead of widening the page; a sibling's link that takes focus is scrolled clear of the sticky column */}
      <div role="region" aria-labelledby={titleId} tabIndex={0} className="panel relative min-w-0 overflow-x-auto" onFocus={revealFocused}>
        <table className="devhub-table devhub-table--sticky min-w-[calc(8rem+var(--cols)*12rem)]" style={{ "--cols": columns.length } as CSSProperties}>
          <caption className="sr-only">{t("compare.caption", { device })}</caption>
          <thead>
            <tr>
              <th scope="col" className="w-32">
                {t("compare.feature")}
              </th>
              {columns.map((column) => (
                <th key={column.slug} scope="col" data-current={column.current ? "" : undefined}>
                  <span className="grid justify-items-start gap-2">
                    {column.artKey ? (
                      <Niche as="span" size="sm" className="w-16" aria-hidden="true">
                        <Render name={column.artKey} alt="" sizes="64px" />
                      </Niche>
                    ) : null}
                    {column.current ? (
                      <span className="grid gap-0.5">
                        <span className="type-sm-strong text-ink">
                          <BidiText text={column.name} />
                        </span>
                        <span className="type-xs text-ink-2">{t("compare.current")}</span>
                      </span>
                    ) : (
                      <MotionLink
                        to={`/device/${column.slug}`}
                        nav="push"
                        order={column.sort}
                        back={column.sort < hub.model.sort}
                        className="devhub-table__link"
                        aria-label={t("compare.open", { device: isolateName(column.name) })}
                      >
                        {/* one inline run: the Latin name isolated, an Arabic qualifier («الطراز الأصلي 2020») in the sentence */}
                        <span>
                          <BidiText text={column.name} />
                        </span>
                      </MotionLink>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => (
              <tr key={row.id}>
                <th scope="row">{t(`compare.rows.${row.id}`)}</th>
                {row.cells.map((cell, index) => (
                  <td key={columns[index]?.slug ?? index}>
                    {cell ? (
                      cellText(row, cell).map((line, lineIndex) => (
                        <span key={lineIndex} className="block text-ink [&+&]:mt-1">
                          {/* Latin runs isolated («Joy-Con», «Wi-Fi 6»): a line that breaks inside one keeps its order */}
                          <BidiText text={line} />
                        </span>
                      ))
                    ) : (
                      <span className="text-ink-2">{t("compare.missing")}</span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
