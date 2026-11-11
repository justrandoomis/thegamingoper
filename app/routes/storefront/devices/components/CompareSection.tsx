import { useId, type CSSProperties } from "react";

import { useFormat, useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import type { CompareRow, DeviceHub } from "~/server/services/devices.server";
import { cx } from "~/ui/cx";
import { ProductImage } from "~/ui/ProductCard";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { isolate, researchDate, SECTION_SCROLL_MARGIN } from "./format";

/**
 * Comparison with sibling models (DESIGN.md §8.7): paper, hairlines, the first column sticky while the table scrolls
 * sideways on a phone. Rows are fixed comparable facts (release date, storage, discs, screen, …) read from each
 * model's researched spec sheet; a fact our sources do not give is a dash with "not in our sources" for screen
 * readers — never a guess. Each sibling's name opens its own hub with the sideways push (neighbouring contexts,
 * DESIGN.md §7.2), the direction following the store's model order.
 */
export function CompareSection({ hub }: { hub: DeviceHub }) {
  const t = useT("devices");
  const f = useFormat();
  const titleId = useId();
  const comparison = hub.comparison;
  if (!comparison) return null;
  const device = isolate(hub.model.name);
  const columns = comparison.columns;

  const cellText = (row: CompareRow, cell: string[]) => (row.id === "released" ? cell.map((value) => researchDate(value, f)?.text ?? value) : cell);

  return (
    <section id="compare" aria-labelledby={titleId} className={cx("grid min-w-0 gap-3", SECTION_SCROLL_MARGIN)}>
      <div className="grid gap-0.5">
        <h2 id={titleId} className="type-section text-ink">
          {t("compare.title", { device })}
        </h2>
        <p className="type-caption text-ink-2 lg:hidden">{t("compare.hint")}</p>
      </div>
      {/* the region scrolls sideways; it is focusable so a keyboard can scroll it too. `relative` makes it the containing
          block of the screen-reader-only texts inside (absolutely positioned), so they are clipped with the table
          instead of widening the page */}
      <div role="region" aria-labelledby={titleId} tabIndex={0} className="panel panel--paper relative min-w-0 overflow-x-auto">
        <table className="w-full min-w-[calc(7.5rem+var(--cols)*11.5rem)] border-collapse" style={{ "--cols": columns.length } as CSSProperties}>
          <caption className="sr-only">{t("compare.caption", { device })}</caption>
          <thead>
            <tr className="border-b border-line-strong">
              <th scope="col" className="sticky start-0 z-[1] w-30 bg-paper px-3 py-3 text-start align-bottom type-label text-ink-2">
                {t("compare.feature")}
              </th>
              {columns.map((column) => (
                <th key={column.slug} scope="col" className="px-3 py-3 text-start align-bottom">
                  <span className="grid justify-items-start gap-1.5">
                    {column.artKey ? (
                      <span className="render-slot h-14 w-20" aria-hidden="true">
                        <ProductImage image={{ artKey: column.artKey, mediaKey: null, alt: "", isIllustration: false }} alt="" sizes="80px" shadow={false} pose={0} />
                      </span>
                    ) : null}
                    {column.current ? (
                      <span className="grid gap-0.5">
                        <span className="type-strong text-ink">
                          <bdi>{column.name}</bdi>
                        </span>
                        <span className="type-caption text-ink-2">{t("compare.current")}</span>
                      </span>
                    ) : (
                      <MotionLink
                        to={`/device/${column.slug}`}
                        nav="push"
                        order={column.sort}
                        back={column.sort < hub.model.sort}
                        className="inline-flex min-h-11 items-center type-strong text-ink underline decoration-line-strong underline-offset-4 hover:decoration-ink"
                        aria-label={t("compare.open", { device: column.name })}
                      >
                        <bdi>{column.name}</bdi>
                      </MotionLink>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {comparison.rows.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-b-0">
                <th scope="row" className="sticky start-0 z-[1] bg-paper px-3 py-3 text-start align-top type-label text-ink-2">
                  {t(`compare.rows.${row.id}`)}
                </th>
                {row.cells.map((cell, index) => (
                  <td key={columns[index]?.slug ?? index} className={cx("px-3 py-3 align-top type-caption text-ink", columns[index]?.current && "bg-niche/40")}>
                    {cell ? (
                      cellText(row, cell).map((line, lineIndex) => (
                        <span key={lineIndex} className="block [&+&]:mt-1">
                          {line}
                        </span>
                      ))
                    ) : (
                      <>
                        <span aria-hidden="true" className="text-ink-3">
                          —
                        </span>
                        <VisuallyHidden>{t("compare.missing")}</VisuallyHidden>
                      </>
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
