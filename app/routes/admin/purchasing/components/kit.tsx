/**
 * Small building blocks shared by the purchasing pages (admin module 09): the module's `t()`, page heads, sections,
 * KPI figures, numbers and money in tabular type (IQD and supplier currencies), statuses with words, URL-state helpers,
 * and the responsive list (a dense table from 768px, cards on phones — DESIGN.md §10). Modelled on the inventory
 * module's kit so the admin reads the same everywhere.
 */
import { useEffect, type ReactNode, type RefObject } from "react";
import { Link } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { parseBaghdadDay } from "~/server/services/admin/purchasing/rules";
import type { TFunction } from "~/i18n/translate";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { DataTable, type DataColumn, type DataSort } from "~/ui/DataTable";
import { Status, type StatusTone } from "~/ui/Tag";

export function usePurT(): TFunction {
  return useT("admin-purchasing");
}

/** While the browser prints, the block carries data-theme="light": a dark screen never prints light text on paper. */
export function usePrintInLight(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
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
export function Kpi({ label, value, hint, wide = false }: { label: ReactNode; value: ReactNode; hint?: ReactNode; wide?: boolean }) {
  return (
    <div className={cx("adm-card content-start", wide && "pur-kpi--wide")}>
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
  const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
  return (
    <bdi className={cx("nums", value < 0 && "text-red-ink", className)}>
      {sign}
      {f.number(Math.abs(value))}
    </bdi>
  );
}

/** A share 0–1 as a percentage; null shows "—". */
export function Percent({ value }: { value: number | null | undefined }) {
  const f = useFormat();
  if (value === null || value === undefined || !Number.isFinite(value)) return <span>—</span>;
  return <bdi className="nums">{f.percent(value)}</bdi>;
}

/** Integer IQD; null/undefined shows "—" with the reason (never a made-up zero). */
export function Money({ iqd, unknownLabel, className }: { iqd: number | null | undefined; unknownLabel?: string; className?: string }) {
  const f = useFormat();
  const t = usePurT();
  if (iqd === null || iqd === undefined || !Number.isFinite(iqd)) {
    const label = unknownLabel ?? t("common.valueUnknown");
    return (
      <span className={cx("text-ink-2", className)} title={label}>
        — <span className="sr-only">{label}</span>
      </span>
    );
  }
  return <bdi className={cx("nums", iqd < 0 && "text-red-ink", className)}>{iqd < 0 ? `−${f.iqd(-iqd)}` : f.iqd(iqd)}</bdi>;
}

const DECIMALS: Record<string, number> = { IQD: 0, USD: 2, EUR: 2, GBP: 2, AED: 2, TRY: 2, CNY: 2, JPY: 0 };

/** An amount in a supplier's currency from its minor units ("455.00 USD"); IQD amounts read as dinars. */
export function Minor({ minor, currency, className }: { minor: number | null | undefined; currency: string; className?: string }) {
  const f = useFormat();
  const t = usePurT();
  if (minor === null || minor === undefined || !Number.isFinite(minor)) {
    return (
      <span className={cx("text-ink-2", className)} title={t("common.valueUnknown")}>
        — <span className="sr-only">{t("common.valueUnknown")}</span>
      </span>
    );
  }
  if (currency === "IQD") return <Money iqd={minor} className={className} />;
  const decimals = DECIMALS[currency] ?? 2;
  const major = minor / 10 ** decimals;
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", minor < 0 && "text-red-ink", className)}>
      {f.number(major, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })} {currency}
    </bdi>
  );
}

/** A calendar day stored as "YYYY-MM-DD" (an invoice's issue or due day), written like the other dates on the page. */
export function Day({ value }: { value: string | null | undefined }) {
  const f = useFormat();
  const at = parseBaghdadDay(value);
  if (!value || at === null) return <span>{value || "—"}</span>;
  return (
    <time dateTime={value} className="nums whitespace-nowrap">
      {f.date(at, "medium")}
    </time>
  );
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

/** A code, SKU, serial or reference: left-to-right, tabular. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", className)}>
      {children}
    </bdi>
  );
}

export const TONES = {
  po: { draft: "neutral", pending_approval: "warn", approved: "info", sent: "info", partially_received: "info", received: "ok", closed: "neutral", cancelled: "neutral" },
  receipt: { draft: "warn", posting: "warn", posted: "ok", cancelled: "neutral" },
  invoice: { draft: "neutral", matched: "ok", mismatch: "bad", approved: "ok", paid: "ok", void: "neutral" },
  claim: { open: "warn", submitted: "info", accepted: "info", rejected: "bad", credited: "ok", closed: "neutral" },
  supplier: { active: "ok", inactive: "neutral", blocked: "bad" },
  rfq: { draft: "neutral", sent: "info", quoted: "info", awarded: "ok", cancelled: "neutral" },
  quote: { received: "info", accepted: "ok", rejected: "neutral", expired: "neutral" },
  grade: { A: "ok", B: "ok", C: "warn", D: "bad" },
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
          sortHref={search !== undefined && sort ? (next: DataSort) => withSearch(search, { sort: next.key, dir: next.dir }) : undefined}
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

/** A label/value pair inside a phone card or a details list. */
export function Pair({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="type-caption text-ink-2">{label}</span>
      <span className="type-data text-end text-ink">{children}</span>
    </div>
  );
}

/** A note with an icon (flat, never a toast): rules, boundaries, honest limits. */
export function Note({ icon = "info", tone = "info", children, className }: { icon?: IconName; tone?: "info" | "warn" | "bad"; children: ReactNode; className?: string }) {
  return (
    <div role="note" className={cx("adm-notice", tone === "warn" && "adm-notice--warn", tone === "bad" && "adm-notice--bad", className)}>
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

/** A details list (term / value), two columns from 600px. */
export function Facts({ items }: { items: { label: ReactNode; value: ReactNode; wide?: boolean }[] }) {
  return (
    <dl className="adm-card grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((item, index) => (
        <div key={index} className={cx("grid gap-0.5", item.wide && "sm:col-span-2 lg:col-span-3")}>
          <dt className="type-caption text-ink-2">{item.label}</dt>
          <dd className="type-body text-ink">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Audit actions the history panels put in words; any other action shows as recorded. */
const KNOWN_ACTIONS = new Set([
  "purchasing_supplier_create",
  "purchasing_supplier_update",
  "purchasing_supplier_status",
  "purchasing_supplier_contact_add",
  "purchasing_supplier_contact_update",
  "purchasing_supplier_contact_remove",
  "purchasing_supplier_review",
  "purchasing_po_create",
  "purchasing_po_update",
  "purchasing_po_submit",
  "purchasing_po_approve",
  "purchasing_po_reject",
  "purchasing_po_send",
  "purchasing_po_cancel",
  "purchasing_po_close",
  "purchasing_receipt_create",
  "purchasing_receipt_cancel",
  "purchasing_receipt_post_start",
  "purchasing_receipt_post_resume",
  "purchasing_receipt_post_failed",
  "purchasing_receipt_post",
  "purchasing_invoice_record",
  "purchasing_invoice_approve",
  "purchasing_invoice_rematch",
  "purchasing_invoice_void",
  "purchasing_claim_create",
  "purchasing_claim_submitted",
  "purchasing_claim_accepted",
  "purchasing_claim_rejected",
  "purchasing_claim_credited",
  "purchasing_claim_closed",
  "purchasing_claim_return_start",
  "purchasing_claim_return_failed",
  "purchasing_claim_return",
  "purchasing_rfq_create",
  "purchasing_rfq_send",
  "purchasing_rfq_cancel",
  "purchasing_rfq_quote_record",
  "purchasing_rfq_quote_replace",
  "purchasing_rfq_award",
  "pricing_landed_add",
  "pricing_landed_allocate",
  "pricing_landed_remove",
]);

export function actionLabel(t: TFunction, action: string): string {
  const key = action.replace(/\./g, "_");
  return KNOWN_ACTIONS.has(key) ? t(`actions.${key}`) : action;
}

/** The history panel of a record: who did what, when and why (from the audit trail, newest first). */
export function History({ entries }: { entries: readonly { at: number; action: string; actor: string | null; reason: string | null }[] }) {
  const t = usePurT();
  if (entries.length === 0) return <p className="type-body text-ink-2">{t("common.noHistory")}</p>;
  return (
    <ol className="grid gap-2">
      {entries.map((entry, index) => (
        <li key={index} className="adm-card gap-0.5">
          <p className="type-body">
            <span className="type-strong">{entry.actor ?? t("common.system")}</span> · {actionLabel(t, entry.action)}
          </p>
          {entry.reason ? <p className="type-caption text-ink-2">{t("common.reasonIs", { reason: entry.reason })}</p> : null}
          <p className="type-caption text-ink-2">
            <When at={entry.at} />
          </p>
        </li>
      ))}
    </ol>
  );
}

/** The server's sentence for a failed form (red ink, announced), or nothing. */
export function FormError({ result }: { result: { ok: boolean; message?: string; code?: string; fields?: Record<string, string> } | null | undefined }) {
  if (!result || result.ok) return null;
  const text = result.message ?? (result.fields ? null : result.code);
  const fieldCount = result.fields ? Object.keys(result.fields).length : 0;
  return text || fieldCount > 0 ? (
    <p role="alert" className="type-label text-red-ink">
      {text ?? Object.values(result.fields ?? {})[0]}
    </p>
  ) : null;
}
