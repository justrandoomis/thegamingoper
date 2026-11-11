/**
 * Small building blocks shared by the inventory pages (admin module 04): the module's `t()`, page heads, sections,
 * KPI figures, numbers and money in tabular type, statuses with words, URL-state helpers, and the responsive list
 * (a dense table from 768px, cards on phones — DESIGN.md §10).
 */
import { useEffect, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useDir, useFormat, useT } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { DataTable, type DataColumn, type DataSort } from "~/ui/DataTable";
import { Status, type StatusTone } from "~/ui/Tag";

export function useInvT(): TFunction {
  return useT("admin-inventory");
}

/**
 * A block that prints ink on paper whatever the screen's theme: while the browser prints (its own print command or
 * window.print), the block carries data-theme="light", so a dark screen does not print light text on white paper.
 *
 *   const slip = useRef<HTMLDivElement>(null);
 *   usePrintInLight(slip);
 *   <div ref={slip} className="inv-print">…</div>
 */
export function usePrintInLight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    // `beforeprint` can arrive twice for one print (window.print and the dialog): remember the screen's value once.
    let printing = false;
    let previous: string | null = null;
    const before = () => {
      if (!printing) previous = ref.current?.getAttribute("data-theme") ?? null;
      printing = true;
      ref.current?.setAttribute("data-theme", "light");
    };
    const after = () => {
      printing = false;
      if (previous === null) ref.current?.removeAttribute("data-theme");
      else ref.current?.setAttribute("data-theme", previous);
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, [ref]);
}

/**
 * What a whole-number field keeps of what was typed: Arabic-Indic (٠–٩) and Persian (۰–۹) digits become 0–9 — an
 * Arabic keyboard types those — and everything else is dropped. `/[^\d]/` alone would throw the Arabic digits away.
 */
export function digitsOnly(value: string): string {
  return value
    .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0))
    .replace(/[^0-9]/g, "");
}

export function PageHead({ eyebrow, title, lead, actions }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="adm-page-head">
      {eyebrow ? <p className="adm-eyebrow">{eyebrow}</p> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="adm-title min-w-0">{title}</h1>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {lead ? <p className="max-w-[72ch] type-body text-ink-2">{lead}</p> : null}
    </header>
  );
}

export function Section({ id, title, aside, children, className }: { id: string; title: ReactNode; aside?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("adm-section", className)} aria-labelledby={id}>
      <div className="adm-section__head">
        <h2 id={id} className="adm-h2">
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A flat KPI card: caption label, the figure in KPI type, an optional hint. */
export function Kpi({ label, value, hint, wide = false, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; wide?: boolean; className?: string }) {
  return (
    <div className={cx("adm-card content-start", wide && "inv-kpi--wide", className)}>
      <p className="type-caption text-ink-2">{label}</p>
      <p className="type-kpi nums text-ink">
        <bdi>{value}</bdi>
      </p>
      {hint ? <p className="type-caption text-ink-2">{hint}</p> : null}
    </div>
  );
}

export function Num({ value, signed = false, className }: { value: number | null | undefined; signed?: boolean; className?: string }) {
  const f = useFormat();
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={className}>—</span>;
  const text = f.number(Math.abs(value));
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  return (
    <bdi className={cx("nums", value < 0 && "text-red-ink", className)}>
      {sign}
      {text}
    </bdi>
  );
}

/** Integer IQD; null/undefined shows "—" with the reason (never a made-up zero). */
export function Money({ iqd, unknownLabel, className }: { iqd: number | null | undefined; unknownLabel?: string; className?: string }) {
  const f = useFormat();
  const t = useInvT();
  if (iqd === null || iqd === undefined || !Number.isFinite(iqd)) {
    return (
      <span className={cx("text-ink-2", className)} title={unknownLabel ?? t("common.valueUnknown")}>
        — <span className="sr-only">{unknownLabel ?? t("common.valueUnknown")}</span>
      </span>
    );
  }
  return <bdi className={cx("nums", iqd < 0 && "text-red-ink", className)}>{iqd < 0 ? `−${f.iqd(-iqd)}` : f.iqd(iqd)}</bdi>;
}

export function When({ at, kind = "dateTime" }: { at: number | null | undefined; kind?: "dateTime" | "date" }) {
  const f = useFormat();
  if (at === null || at === undefined) return <span>—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} className="nums whitespace-nowrap">
      {kind === "date" ? f.date(at, "medium") : f.dateTime(at)}
    </time>
  );
}

/** "from → to" that points along the reading direction (← in Arabic), each end isolated. */
export function FromTo({ from, to }: { from: ReactNode; to: ReactNode }) {
  const dir = useDir();
  return (
    <span className="whitespace-nowrap">
      <Code>{from}</Code> {dir === "rtl" ? "←" : "→"} <Code>{to}</Code>
    </span>
  );
}

/** A code, SKU, serial or reference: left-to-right, tabular. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", className)}>
      {children}
    </bdi>
  );
}

export const TONES = {
  stock: { in_stock: "ok", low: "warn", out: "neutral", oversold: "bad" },
  transfer: { draft: "neutral", in_transit: "info", received: "ok", cancelled: "neutral" },
  count: { draft: "neutral", counting: "info", review: "warn", approved: "ok", cancelled: "neutral" },
  reservation: { active: "info", committed: "ok", released: "neutral", expired: "neutral" },
  serial: { in_stock: "ok", reserved: "info", sold: "neutral", returned: "warn", in_repair: "warn", scrapped: "bad", intake: "info" },
  reorder: { out: "bad", below_reorder: "warn", soon: "warn", ok: "ok", no_forecast: "neutral" },
} as const satisfies Record<string, Record<string, StatusTone>>;

export function StateTag<K extends keyof typeof TONES>({ group, value, label }: { group: K; value: string; label: string }) {
  const tone = ((TONES[group] as Record<string, StatusTone>)[value] ?? "neutral") as StatusTone;
  return <Status tone={tone}>{label}</Status>;
}

/** "?a=1&b=2" with `patch` applied (null/"" removes a key); page resets unless it is part of the patch. */
export function withSearch(search: string, patch: Record<string, string | number | null | undefined>): string {
  const params = new URLSearchParams(search);
  if (!("page" in patch)) params.delete("page");
  for (const [key, value] of Object.entries(patch)) {
    if (value === null || value === undefined || value === "") params.delete(key);
    else params.set(key, String(value));
  }
  const out = params.toString();
  return out ? `?${out}` : "?";
}

export function sortHref(search: string) {
  return (next: DataSort) => withSearch(search, { sort: next.key, dir: next.dir });
}

/** A dense table from 768px and one card per row below it (phones). */
export function ResponsiveList<Row>({
  caption,
  columns,
  rows,
  rowKey,
  card,
  sort,
  search,
  empty,
  footer,
  selected,
  onSelectedChange,
  bulkActions,
  rowLabel,
}: {
  caption: string;
  columns: DataColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  card: (row: Row) => ReactNode;
  sort?: DataSort | null;
  search?: string;
  empty?: ReactNode;
  footer?: ReactNode;
  selected?: readonly string[];
  onSelectedChange?: (ids: string[]) => void;
  bulkActions?: (ids: readonly string[]) => ReactNode;
  rowLabel?: (row: Row) => string;
}) {
  return (
    <div className="grid gap-3">
      <div className="hidden md:block">
        <DataTable
          caption={caption}
          columns={columns}
          rows={rows}
          rowKey={rowKey}
          rowLabel={rowLabel}
          sort={sort ?? null}
          sortHref={search !== undefined && sort !== undefined ? sortHref(search) : undefined}
          empty={empty}
          selected={selected}
          onSelectedChange={onSelectedChange}
          bulkActions={bulkActions}
          maxHeight={null}
        />
      </div>
      <div className="md:hidden">
        {rows.length === 0 ? (
          (empty ?? null)
        ) : (
          <ul role="list" aria-label={caption} className="grid gap-2">
            {rows.map((row) => (
              <li key={rowKey(row)} className="adm-card gap-1.5">
                {card(row)}
              </li>
            ))}
          </ul>
        )}
      </div>
      {footer}
    </div>
  );
}

/** A label/value pair inside a phone card. */
export function Pair({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="type-caption text-ink-2">{label}</span>
      <span className="type-data text-end text-ink">{children}</span>
    </div>
  );
}

/** A note with an icon (flat, never a toast): rules, boundaries, honest limits. */
export function Note({ icon = "info", tone = "info", children, className }: { icon?: IconName; tone?: "info" | "warn"; children: ReactNode; className?: string }) {
  return (
    <div role="note" className={cx("adm-notice", tone === "warn" && "adm-notice--warn", className)}>
      <Icon name={icon} size={18} className={tone === "info" ? "text-info" : undefined} />
      <div className="grid gap-1 text-ink">{children}</div>
    </div>
  );
}

/** A link inside a dense row. */
export function RowLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} prefetch="intent" className="adm-link">
      {children}
    </Link>
  );
}

/** Filter chips that are links (URL state, works without JavaScript). */
export function LinkChips({ label, items }: { label: string; items: { value: string; label: ReactNode; href: string; selected: boolean; count?: number }[] }) {
  const f = useFormat();
  return (
    <nav aria-label={label}>
      <ul role="list" className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.value}>
            <Chip as={Link} to={item.href} preventScrollReset selected={item.selected}>
              {item.label}
              {item.count !== undefined ? <span className="nums"> · {f.number(item.count)}</span> : null}
            </Chip>
          </li>
        ))}
      </ul>
    </nav>
  );
}
