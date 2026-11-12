/**
 * Small building blocks shared by the screens of module 18 (reports). Admin rules (DESIGN.md §10): data has no
 * material, numbers are tabular at the inline end and isolated (<bdi>), money is integer IQD with the figure first, a
 * negative amount carries a minus sign in red-ink text, a figure that cannot be computed is "—" with the reason
 * (never a zero), cost and profit columns are absent (not blank) for those without the permission, raised clay only
 * for what a person must decide (nothing in a report).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Form, Link, useFetcher, useLocation, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useDir, useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { LOCALES } from "~/lib/locales";
import { BidiText, hasRtl } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { DataTable, type DataColumn, type DataSort } from "~/ui/DataTable";
import { ConfirmDialog, Dialog, type ImpactRow, type ReasonOptions } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { toast } from "~/ui/toast-store";
import type { ReportsAccess } from "~/server/services/admin/reports/shared.server";
import { periodOf, periodRange, REPORTS_NS, shiftPeriod, type RangeFilter, type ReportKey } from "~/server/services/admin/reports/types";
import { REPORTS_LAYOUT_ID } from "./meta";

/** The reports layout's data (every page below can read it). */
export type ReportsLayoutData = { access: ReportsAccess; storeMode: "demo" | "live" };

export function useReportsLayout(): ReportsLayoutData | undefined {
  return useRouteLoaderData(REPORTS_LAYOUT_ID) as ReportsLayoutData | undefined;
}

/** `t()` for the module's strings (the layout sends them, with the shared "errors" namespace for `errors.<code>`). */
export function useRepT(): TFunction {
  const layout = useRouteLoaderData(REPORTS_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(REPORTS_NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[REPORTS_NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? translate(shared, locale, key, vars) : undefined) ?? key;
  }, [layout, locale, fallback]);
}

// ───────────────────────────────────────────────────────────────── figures

/** Integer IQD, figure first, isolated; null/undefined is "—" with the reason (never a made-up zero). */
export function Money({ iqd, unknown, className }: { iqd: number | null | undefined; unknown?: string; className?: string }) {
  const f = useFormat();
  const t = useRepT();
  if (iqd === null || iqd === undefined || !Number.isSafeInteger(iqd)) {
    const why = unknown ?? t("common.notAvailable");
    return (
      <span className={cx("text-ink-2", className)} title={why}>
        —<span className="sr-only"> {why}</span>
      </span>
    );
  }
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", iqd < 0 && "text-red-ink", className)}>
      {iqd < 0 ? "−" : ""}
      {f.iqd(Math.abs(iqd))}
    </bdi>
  );
}

export function Num({ value, digits = 0, className }: { value: number | null | undefined; digits?: number; className?: string }) {
  const f = useFormat();
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cx("text-ink-2", className)}>—</span>;
  const text = f.number(Math.abs(value), { maximumFractionDigits: digits, minimumFractionDigits: 0 });
  return <bdi className={cx("nums", value < 0 && "text-red-ink", className)}>{value < 0 ? `−${text}` : text}</bdi>;
}

/** A share 0–1 as a percentage; null is "—" (nothing to divide), never 0 %. */
export function Pct({ value, className }: { value: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cx("text-ink-2", className)}>—</span>;
  return <bdi className={cx("nums whitespace-nowrap", value < 0 && "text-red-ink", className)}>{f.percent(value)}</bdi>;
}

/** Basis points as a percentage; null is "—". */
export function Bps({ value }: { value: number | null | undefined }) {
  return <Pct value={value === null || value === undefined ? null : value / 10_000} />;
}

/**
 * A share 0–1 as a short bar beside its percentage (ABC, segments): ink on a hairline track, filled from the page's
 * reading start (the right in Arabic) even inside a numeric cell, whose content is isolated left-to-right.
 */
export function ShareBar({ value }: { value: number | null | undefined }) {
  const dir = useDir();
  const share = value === null || value === undefined || !Number.isFinite(value) ? 0 : Math.min(1, Math.max(0, value));
  return (
    <span className="inline-flex items-center gap-2" dir={dir}>
      <span className="rep-bar w-16" aria-hidden="true">
        <span style={{ inlineSize: `${Math.round(share * 100)}%` }} />
      </span>
      <Pct value={value} />
    </span>
  );
}

/** A Baghdad day "YYYY-MM-DD" as a date. */
export function DayName({ day, style = "medium" }: { day: string; style?: "medium" | "short" | "long" }) {
  const f = useFormat();
  const ms = Date.parse(`${day}T09:00:00Z`);
  if (!Number.isFinite(ms)) return <span>{day}</span>;
  return (
    <time dateTime={day} className="nums whitespace-nowrap">
      {f.date(ms, style)}
    </time>
  );
}

/** "تشرين الثاني 2026" / "November 2026" for a fiscal period "YYYY-MM". */
export function usePeriodLabel(): (period: string) => string {
  const f = useFormat();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(`${LOCALES[f.locale].bcp47}-u-nu-${f.numbering}`, { month: "long", year: "numeric", timeZone: "Asia/Baghdad" });
    return (period: string) => {
      try {
        return format.format(periodRange(period).from + 24 * 60 * 60 * 1000);
      } catch {
        return period;
      }
    };
  }, [f.locale, f.numbering]);
}

export function When({ at }: { at: number | null | undefined }) {
  const f = useFormat();
  if (at === null || at === undefined) return <span>—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} className="nums whitespace-nowrap">
      {f.dateTime(at)}
    </time>
  );
}

/**
 * A name as typed — a product, a person, a supplier, a carrier — in the order a reader expects on either page: Latin
 * names and mixed titles through the kit's <BidiText> ("MSI Claw 8 EX AI+" keeps its "+" at the end on an Arabic
 * page); a name written only in Arabic script as one right-to-left isolate (an Arabic name with brackets on an English
 * page stays whole).
 */
export function Name({ text, className }: { text: string; className?: string }) {
  if (hasRtl(text) && !/[A-Za-z]/.test(text)) {
    return (
      <bdi dir="rtl" className={className}>
        {text}
      </bdi>
    );
  }
  return className ? (
    <span className={className}>
      <BidiText text={text} />
    </span>
  ) : (
    <BidiText text={text} />
  );
}

/**
 * A name placed inside a translated sentence (plain text), wrapped in first-strong isolate … pop isolate (U+2068 …
 * U+2069): the browser lays it out on its own, so an Arabic name with brackets stays whole in an English sentence.
 */
export function isolated(text: string): string {
  return `⁨${text}⁩`;
}

/** A code, SKU or reference: left-to-right, tabular. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", className)}>
      {children}
    </bdi>
  );
}

/** The range in words: the month, or "from — to". */
export function RangeLabel({ range }: { range: Pick<RangeFilter, "period" | "from" | "to"> }) {
  const label = usePeriodLabel();
  if (range.period) return <span className="whitespace-nowrap">{label(range.period)}</span>;
  return (
    <span className="whitespace-nowrap">
      <DayName day={range.from} /> — <DayName day={range.to} />
    </span>
  );
}

// ───────────────────────────────────────────────────────────────── page structure

export function PageHead({ eyebrow, title, lead, actions }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="adm-page-head">
      {eyebrow ? <p className="adm-eyebrow">{eyebrow}</p> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="adm-title min-w-0">{title}</h1>
        {actions ? <div className="rep-noprint flex flex-wrap items-center gap-2">{actions}</div> : null}
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
        {aside ? <div className="rep-noprint flex flex-wrap items-center gap-2">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A flat KPI card: caption label, the figure in KPI type, an optional hint. */
export function Kpi({ label, value, hint }: { label: ReactNode; value: ReactNode; hint?: ReactNode }) {
  return (
    <div className="adm-card content-start">
      <p className="type-caption text-ink-2">{label}</p>
      <p className="type-kpi nums text-ink">{value}</p>
      {hint ? <p className="type-caption text-ink-2">{hint}</p> : null}
    </div>
  );
}

export function Kpis({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="rep-kpis" role="group" aria-label={label}>
      {children}
    </div>
  );
}

/** A note with an icon (flat, never a toast): rules, boundaries, honest limits. */
export function Note({ icon = "info", tone = "info", children, className }: { icon?: IconName; tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode; className?: string }) {
  return (
    <div role={tone === "bad" ? "alert" : "note"} className={cx("adm-notice", tone === "warn" && "adm-notice--warn", tone === "bad" && "adm-notice--bad", tone === "ok" && "adm-notice--ok", className)}>
      <Icon name={icon} size={18} className={tone === "info" ? "text-info" : undefined} />
      <div className="grid min-w-0 gap-1 text-ink">{children}</div>
    </div>
  );
}

/** A section the employee may not open: what it needs, in words (never an empty table that looks like "nothing"). */
export function NeedsPermission({ permission, children }: { permission: string; children?: ReactNode }) {
  const t = useRepT();
  return (
    <Note icon="lock">
      <p>{children ?? t("common.needs")}</p>
      <p className="type-caption text-ink-2">
        {t("common.needsPermission")} <Code>{permission}</Code>
      </p>
    </Note>
  );
}

/** "Showing demo data" — the rows of a demo store, marked as such. */
export function DemoShown({ range, href }: { range: Pick<RangeFilter, "demo">; href: string }) {
  const t = useRepT();
  if (!range.demo) return null;
  return (
    <Note icon="info">
      <p>
        {t("common.demoShown")}{" "}
        <Link to={href} className="adm-link">
          {t("range.hideDemo")}
        </Link>
      </p>
    </Note>
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

// ───────────────────────────────────────────────────────────────── lists

/** A dense table from 768px and one card per row below it (phones). */
export function ResponsiveTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  card,
  sort,
  sortHref,
  empty,
  footer,
}: {
  caption: string;
  columns: DataColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  card: (row: Row) => ReactNode;
  sort?: DataSort | null;
  sortHref?: (sort: DataSort) => string;
  empty?: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid gap-3">
      <div className="rep-table hidden md:block">
        <DataTable caption={caption} columns={columns} rows={rows} rowKey={rowKey} sort={sort ?? null} sortHref={sortHref} empty={empty} maxHeight={null} />
      </div>
      <div className="rep-cards md:hidden">
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

/** "?a=1&b=2" with `patch` applied (null/"" removes a key); the page resets unless it is part of the patch. */
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

/** Links that choose one value of a URL parameter (views, dimensions): a held ink key marks the current one. */
export function ChoiceLinks<V extends string | number>({ label, options, current, href }: { label: string; options: readonly { value: V; label: string }[]; current: V | null; href: (value: V) => string }) {
  return (
    <nav aria-label={label} className="rep-noprint flex flex-wrap items-center gap-2">
      {options.map((option) => (
        <Key key={String(option.value)} as={Link} to={href(option.value)} size="sm" held={current === option.value} aria-current={current === option.value ? "page" : undefined}>
          {option.label}
        </Key>
      ))}
    </nav>
  );
}

/**
 * The range of a report, in the URL (works without JavaScript): this month / last month as links, a month field or
 * two days, and "include demo data". `keep` names other query parameters to carry along.
 */
export function RangeBar({ range, action, keep = {}, now, showDemo = true }: { range: RangeFilter; action: string; keep?: Record<string, string | number | null | undefined>; now: number; showDemo?: boolean }) {
  const t = useRepT();
  const label = usePeriodLabel();
  const current = periodOf(now);
  const previous = shiftPeriod(current, -1);
  const link = (patch: { period?: string; demo?: boolean }) => {
    const params = new URLSearchParams();
    const period = patch.period ?? range.period;
    if (period) params.set("period", period);
    else {
      params.set("from", range.from);
      params.set("to", range.to);
    }
    if (patch.demo ?? range.demo) params.set("demo", "1");
    for (const [key, value] of Object.entries(keep)) if (value !== null && value !== undefined && value !== "") params.set(key, String(value));
    return `${action}?${params.toString()}`;
  };
  const custom = range.period !== current && range.period !== previous;
  return (
    <div className="rep-noprint grid gap-2">
      <nav aria-label={t("range.quick")} className="flex flex-wrap items-center gap-2">
        {[current, previous].map((period) => (
          <Key key={period} as={Link} to={link({ period })} size="sm" held={range.period === period} aria-current={range.period === period ? "true" : undefined}>
            {label(period)}
          </Key>
        ))}
        {showDemo ? (
          <Key as={Link} to={link({ demo: !range.demo })} size="sm" icon={range.demo ? "x" : "plus"}>
            {range.demo ? t("range.hideDemo") : t("range.demo")}
          </Key>
        ) : null}
      </nav>
      <Disclosure summary={custom ? t("range.customShown", { from: range.from, to: range.to }) : t("range.custom")} defaultOpen={custom} variant="row">
        <Form method="get" action={action} className="flex flex-wrap items-end gap-3 pt-2">
          {Object.entries(keep).map(([key, value]) => (value !== null && value !== undefined && value !== "" ? <input key={key} type="hidden" name={key} value={String(value)} /> : null))}
          {range.demo ? <input type="hidden" name="demo" value="1" /> : null}
          <TextField name="period" type="month" label={t("range.month")} defaultValue={range.period ?? ""} ltr className="w-44" />
          <span className="pb-2 type-caption text-ink-2">{t("range.or")}</span>
          <TextField name="from" type="date" label={t("range.from")} defaultValue={range.period ? "" : range.from} ltr className="w-44" />
          <TextField name="to" type="date" label={t("range.to")} defaultValue={range.period ? "" : range.to} ltr className="w-44" />
          <Key type="submit" variant="ink" icon="funnel" size="sm">
            {t("range.apply")}
          </Key>
        </Form>
      </Disclosure>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── module navigation

type NavItem = { to: string; label: string; icon: IconName; show: boolean; exact?: boolean };

/** The module's sections as link tabs (URL state; Back works); only those this employee may open. */
export function ReportsNav({ items }: { items: NavItem[] }) {
  const t = useRepT();
  const location = useLocation();
  const listRef = useRef<HTMLUListElement>(null);
  const visible = items.filter((item) => item.show);
  useEffect(() => {
    const list = listRef.current;
    const current = list?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!list || !current || list.scrollWidth <= list.clientWidth) return;
    const box = list.getBoundingClientRect();
    const item = current.getBoundingClientRect();
    if (item.left >= box.left && item.right <= box.right) return;
    list.scrollBy({ left: item.left + item.width / 2 - (box.left + box.width / 2), behavior: "instant" });
  }, [location.pathname]);
  return (
    <nav aria-label={t("nav.label")} className="rep-nav rep-noprint">
      <ul ref={listRef} className="rep-nav__list">
        {visible.map((item) => {
          const current = item.exact ? location.pathname.replace(/\/$/, "") === item.to : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
          return (
            <li key={item.to}>
              <Link to={item.to} prefetch="intent" className="rep-nav__link" aria-current={current ? "page" : undefined}>
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ───────────────────────────────────────────────────────────────── report actions: print, export, save

/**
 * A block that prints ink on paper whatever the screen's theme: while the browser prints, the block carries
 * data-theme="light", so a dark screen does not print light text on white paper.
 */
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

/**
 * The keys of a report's head: print, CSV and XLSX (reports.export.create), save this view (reports.saved.manage).
 * `search` is the report's current query string; the export link carries it, so the file is what the page shows.
 */
export function ReportActions({ report, search, exportable = true }: { report: ReportKey; search: string; exportable?: boolean }) {
  const t = useRepT();
  const layout = useReportsLayout();
  const [saving, setSaving] = useState(false);
  const query = search.startsWith("?") ? search.slice(1) : search;
  const href = (format: "csv" | "xlsx") => `/admin/reports/export?report=${report}&format=${format}${query ? `&${query}` : ""}`;
  return (
    <>
      <Key type="button" size="sm" icon="printer" onClick={() => window.print()}>
        {t("common.print")}
      </Key>
      {layout?.access.export && exportable ? (
        <>
          <Key as="a" href={href("csv")} size="sm" icon="download-simple" download>
            {t("common.exportCsv")}
          </Key>
          <Key as="a" href={href("xlsx")} size="sm" icon="table" download>
            {t("common.exportXlsx")}
          </Key>
        </>
      ) : null}
      {layout?.access.saved ? (
        <Key type="button" size="sm" icon="floppy-disk" onClick={() => setSaving(true)}>
          {t("saved.saveView")}
        </Key>
      ) : null}
      {saving ? <SaveViewDialog report={report} search={search} onClose={() => setSaving(false)} /> : null}
    </>
  );
}

export type ActionData = { ok: boolean; message?: string; code?: string; fields?: Record<string, string>; intent?: string; replayed?: boolean };

/** A unique key per form (a double submit finds the first record). */
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function SaveViewDialog({ report, search, onClose }: { report: ReportKey; search: string; onClose: () => void }) {
  const t = useRepT();
  const [key] = useState(newKey);
  return (
    <FormDialog title={t("saved.saveTitle")} description={t("saved.saveLead")} submitLabel={t("saved.saveView")} action="/admin/reports/saved" onClose={onClose} hidden={{ intent: "create", reportKey: report, search, idempotencyKey: key }} successMessage={t("saved.saved")}>
      {(fields) => (
        <>
          <TextField name="name" label={t("saved.name")} hint={t("saved.nameHint")} error={fields.name} required maxLength={80} autoComplete="off" />
          <Checkbox name="shared" label={t("saved.shareLabel")} hint={t("saved.shareHint")} />
          <p className="type-caption text-ink-2">{t("saved.scheduleBoundary")}</p>
        </>
      )}
    </FormDialog>
  );
}

/**
 * A form in a dialog: posts through a fetcher, keeps the dialog open while the request runs, shows field errors
 * where they belong (`children` gets them) and the form's sentence, closes with a toast.
 */
export function FormDialog({
  title,
  description,
  submitLabel,
  action,
  onClose,
  children,
  successMessage,
  hidden,
}: {
  title: ReactNode;
  description?: ReactNode;
  submitLabel: string;
  action?: string;
  onClose: () => void;
  children: (fields: Record<string, string>) => ReactNode;
  successMessage?: string;
  hidden?: Record<string, string>;
}) {
  const t = useRepT();
  const fetcher = useFetcher<ActionData>();
  const handled = useRef<unknown>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok) {
      toast.success(fetcher.data.message ?? successMessage ?? "");
      onClose();
    }
  }, [fetcher.data, fetcher.state, onClose, successMessage]);
  const failure = fetcher.data && !fetcher.data.ok ? fetcher.data : null;
  const busy = fetcher.state !== "idle";
  return (
    <Dialog
      open
      onClose={onClose}
      title={title}
      description={description}
      dismissible={!busy}
      onSubmit={(event) => {
        event.preventDefault();
        fetcher.submit(new FormData(event.currentTarget), { method: "post", action });
      }}
      footer={
        <>
          <Key onClick={onClose} disabled={busy} className="flex-1 sm:flex-none">
            {t("common.back")}
          </Key>
          <Key type="submit" variant="ink" loading={busy} className="flex-1 sm:flex-none">
            {submitLabel}
          </Key>
        </>
      }
    >
      <div className="grid gap-4">
        {Object.entries(hidden ?? {}).map(([name, value]) => (
          <input key={name} type="hidden" name={name} value={value} />
        ))}
        {children(failure?.fields ?? {})}
        {failure?.message && !failure.fields ? (
          <p role="alert" className="type-label text-red-ink">
            {failure.message}
          </p>
        ) : failure?.fields ? (
          <p role="alert" className="type-label text-red-ink">
            {t("common.checkFields")}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/**
 * The confirm-with-reason dialog of the module (blueprint uxRules: dangerous actions need a confirmation and a
 * reason, and show their impact first). Posts through a fetcher, stays open while the request runs, shows the
 * server's sentence on failure, and closes with a toast on success.
 */
export function ActionDialog({
  open,
  onClose,
  title,
  consequence,
  confirmLabel,
  tone = "neutral",
  impact,
  reason,
  fields,
  action,
  successMessage,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  consequence: ReactNode;
  confirmLabel: string;
  tone?: "neutral" | "destructive";
  impact?: ReactNode | readonly ImpactRow[];
  reason?: boolean | ReasonOptions;
  fields: Record<string, string>;
  action?: string;
  successMessage?: string;
}) {
  const fetcher = useFetcher<ActionData>();
  const handled = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      toast.success(result.message ?? successMessage ?? "");
      onClose();
    }
  }, [fetcher.data, fetcher.state, onClose, successMessage]);
  const failed = fetcher.data && !fetcher.data.ok && fetcher.state === "idle" && handled.current === fetcher.data ? fetcher.data : null;
  const error = failed ? (failed.message ?? Object.values(failed.fields ?? {})[0] ?? failed.code) : undefined;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={title}
      consequence={consequence}
      confirmLabel={confirmLabel}
      tone={tone}
      impact={impact}
      reason={reason}
      pending={fetcher.state !== "idle"}
      error={error}
      onConfirm={({ reason: note }) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key, value);
        if (reason) form.set("reason", note);
        fetcher.submit(form, { method: "post", action });
      }}
    />
  );
}
