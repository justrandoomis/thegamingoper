/**
 * The functions of one blueprint module with their status in the admin — rendered through <ModuleFunctions> from
 * ../blueprint-status (which supplies the registry) on module pages, and by the module landing page.
 * Flat rows between hairlines (data has no material); each row is addressable as #fn-05-03 (the palette links there).
 */
import { useId } from "react";
import { Link, useLocation } from "react-router";

import { useLocale, useT } from "~/i18n/react";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import type { BlueprintModuleDef } from "./blueprint-catalog";

type FnStatus = "implemented" | "partial" | "boundary" | "planned";
type Entry = { status: FnStatus; route?: string; note?: { ar: string; en: string } };

export const STATUS_TONE: Record<FnStatus, StatusTone> = { implemented: "ok", partial: "warn", boundary: "info", planned: "neutral" };

export type FunctionListProps = {
  module: BlueprintModuleDef;
  statuses: Readonly<Record<string, Entry>>;
  /** Level of the list's heading (default 2). */
  headingLevel?: 2 | 3;
  /** Replaces the default heading ("هذا القسم في المخطط"). */
  title?: string;
  className?: string;
};

export const functionAnchor = (functionId: string) => `fn-${functionId.replace(".", "-")}`;

export function FunctionList({ module, statuses, headingLevel = 2, title, className }: FunctionListProps) {
  const t = useT("admin");
  const locale = useLocale();
  const { pathname } = useLocation();
  const headingId = useId();
  const Heading = `h${headingLevel}` as const;
  const lang = locale === "en" ? "en" : "ar";

  const counts: Record<FnStatus, number> = { implemented: 0, partial: 0, boundary: 0, planned: 0 };
  for (const fn of module.functions) counts[statuses[fn.id]?.status ?? "planned"]++;
  const total = module.functions.length;
  const summary = (["implemented", "partial", "boundary", "planned"] as const)
    .filter((status) => counts[status] > 0)
    .map((status) => t(`status.count.${status}`, { count: counts[status] }))
    .join(" · ");

  return (
    <section className={className ? `adm-section ${className}` : "adm-section"} aria-labelledby={headingId}>
      <div className="adm-section__head">
        <Heading id={headingId} className="adm-h2">
          {title ?? t("fn.title")}
        </Heading>
        <p className="type-caption text-ink-2">{t("fn.summary", { total, summary })}</p>
      </div>
      <div className="adm-progress" role="img" aria-label={summary}>
        {counts.implemented > 0 ? <span className="adm-progress__done" style={{ inlineSize: `${(counts.implemented / total) * 100}%` }} /> : null}
        {counts.partial > 0 ? <span className="adm-progress__partial" style={{ inlineSize: `${(counts.partial / total) * 100}%` }} /> : null}
        {counts.boundary > 0 ? <span className="adm-progress__boundary" style={{ inlineSize: `${(counts.boundary / total) * 100}%` }} /> : null}
      </div>
      <ol className="adm-fn-list">
        {module.functions.map((fn) => {
          const entry = statuses[fn.id] ?? { status: "planned" as const };
          const route = entry.route && entry.route !== pathname ? entry.route : null;
          return (
            <li key={fn.id} id={functionAnchor(fn.id)} className="adm-fn">
              <span className="adm-fn__id">
                <bdi dir="ltr">{fn.id}</bdi>
              </span>
              <p className="type-body text-ink">{fn[lang]}</p>
              <div className="adm-fn__state">
                <Status tone={STATUS_TONE[entry.status]}>{t(`status.${entry.status}`)}</Status>
                {entry.note ? <p className="type-caption text-ink-2">{entry.note[lang]}</p> : null}
                {route ? (
                  <TextLink as={Link} to={route} prefetch="intent">
                    {t("fn.open")}
                  </TextLink>
                ) : null}
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
