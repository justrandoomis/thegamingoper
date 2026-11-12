/**
 * Building blocks shared by the screens of module 15 (staff). Admin rules (DESIGN.md §10): data has no material,
 * status is words with a dot, numbers are tabular at the inline end and isolated (<bdi>), money is integer IQD with
 * the figure first, a negative amount carries a minus sign in red-ink text, a figure that cannot be shown is "—" with
 * the reason (never a zero), raised clay only for what a person must decide. Strings come from the module's layout
 * (useStaffT); interpolated names and codes are isolated so they never reorder inside a sentence.
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useFetcher, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { LOCALES } from "~/lib/locales";
import { CURRENCIES } from "~/lib/money";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { DataTable, type DataColumn, type DataSort } from "~/ui/DataTable";
import { ConfirmDialog, Dialog, type ImpactRow, type ReasonOptions } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import type { StaffAccess } from "~/server/services/admin/staff/shared.server";
import { periodRange, STAFF_NS, TONES, type ByView, type Tone } from "~/server/services/admin/staff/types";
import { STAFF_LAYOUT_ID } from "./meta";

/** The staff layout's data (every page below can read it). */
export type StaffLayoutData = { access: StaffAccess; me: { id: string; name: string } };

export function useStaffLayout(): StaffLayoutData | undefined {
  return useRouteLoaderData(STAFF_LAYOUT_ID) as StaffLayoutData | undefined;
}

/** Interpolated text in its own direction (FIRST STRONG ISOLATE … POP DIRECTIONAL ISOLATE); `count` stays a number. */
function isolate(vars?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!vars) return vars;
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(vars)) out[name] = typeof value === "string" && value !== "" && name !== "count" ? `⁨${value}⁩` : value;
  return out;
}

/** `t()` for the module's strings (sent by the staff layout with the shared "errors" namespace). */
export function useStaffT(): TFunction {
  const layout = useRouteLoaderData(STAFF_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(STAFF_NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[STAFF_NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => {
      const safe = isolate(vars);
      return translate(mine, locale, key, safe) ?? (key.startsWith("errors.") ? translate(shared, locale, key, safe) : undefined) ?? key;
    };
  }, [layout, locale, fallback]);
}

/** A translation, or `fallback` when the strings have none for this key. */
export function tOr(t: TFunction, key: string, fallback: string): string {
  const text = t(key);
  return text === key ? fallback : text;
}

/** How the page's language separates the items of a list. */
export function useListSep(): string {
  return useLocale() === "en" ? ", " : "، ";
}

// ───────────────────────────────────────────────────────────────── figures

/** Integer IQD, figure first ("749,000 د.ع"), isolated; null is "—" with the reason (never a made-up zero). */
export function Money({ iqd, unknown, signed = false, className }: { iqd: number | null | undefined; unknown?: string; signed?: boolean; className?: string }) {
  const f = useFormat();
  const locale = useLocale();
  const t = useStaffT();
  if (iqd === null || iqd === undefined || !Number.isSafeInteger(iqd)) {
    const why = unknown ?? t("common.notAvailable");
    return (
      <span className={cx("text-ink-2", className)} title={why}>
        —<span className="sr-only"> {why}</span>
      </span>
    );
  }
  const sign = iqd < 0 ? "−" : signed && iqd > 0 ? "+" : "";
  return (
    <bdi className={cx("nums whitespace-nowrap", iqd < 0 && "text-red-ink", className)}>
      <bdi dir="ltr">
        {sign}
        {f.number(Math.abs(iqd))}
      </bdi>{" "}
      {CURRENCIES.IQD.symbol[locale]}
    </bdi>
  );
}

export function Num({ value, className }: { value: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={className}>—</span>;
  return <bdi className={cx("nums", value < 0 && "text-red-ink", className)}>{value < 0 ? `−${f.number(-value)}` : f.number(value)}</bdi>;
}

/** Basis points as a percentage ("2.5 %"); null is "—" with the reason. */
export function Rate({ bps, unknown }: { bps: number | null | undefined; unknown?: string }) {
  const f = useFormat();
  if (bps === null || bps === undefined) {
    return (
      <span className="text-ink-2" title={unknown}>
        —{unknown ? <span className="sr-only"> {unknown}</span> : null}
      </span>
    );
  }
  return <bdi className="nums whitespace-nowrap">{f.number(bps / 100, { maximumFractionDigits: 2 })} %</bdi>;
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

/** A wall-clock time in Iraq ("09:30"), tabular. */
export function Clock({ at }: { at: number | null | undefined }) {
  const f = useFormat();
  const locale = useLocale();
  if (at === null || at === undefined) return <span>—</span>;
  const text = new Intl.DateTimeFormat(`${LOCALES[locale].bcp47}-u-nu-${f.numbering}`, { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "Asia/Baghdad" }).format(at);
  return (
    <time dateTime={new Date(at).toISOString()} className="nums whitespace-nowrap">
      <bdi dir="ltr">{text}</bdi>
    </time>
  );
}

/** A Baghdad day "YYYY-MM-DD" as a date. */
export function Day({ day, withWeekday = false }: { day: string; withWeekday?: boolean }) {
  const f = useFormat();
  const locale = useLocale();
  const ms = Date.parse(`${day}T09:00:00Z`);
  if (!Number.isFinite(ms)) return <span>{day}</span>;
  const weekday = withWeekday ? new Intl.DateTimeFormat(LOCALES[locale].bcp47, { weekday: "long", timeZone: "Asia/Baghdad" }).format(ms) : null;
  return (
    <time dateTime={day} className="nums whitespace-nowrap">
      {weekday ? `${weekday} ` : ""}
      {f.date(ms, "medium")}
    </time>
  );
}

/** Minutes as "7 h 35 min" in the page's language. */
export function Duration({ minutes }: { minutes: number | null | undefined }) {
  const t = useStaffT();
  const f = useFormat();
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return <span>—</span>;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return <bdi className="nums whitespace-nowrap">{h > 0 ? t("common.hoursMinutes", { h: f.number(h), m: f.number(m) }) : t("common.minutes", { m: f.number(m) })}</bdi>;
}

/** "تشرين الثاني 2026" / "November 2026" for a month "YYYY-MM". */
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

export function PeriodName({ period }: { period: string }) {
  const label = usePeriodLabel();
  return <span className="whitespace-nowrap">{label(period)}</span>;
}

/** A code, id or reference: left-to-right, tabular. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", className)}>
      {children}
    </bdi>
  );
}

export function ByName({ by }: { by: ByView | null | undefined }) {
  const t = useStaffT();
  if (!by || by.kind === "unknown") return <span className="text-ink-2">—</span>;
  if (by.kind === "system") return <span className="text-ink-2">{t("common.bySystem")}</span>;
  return <span>{by.name}</span>;
}

// ───────────────────────────────────────────────────────────────── page structure

export function PageHead({ eyebrow, title, lead, actions }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="adm-page-head">
      {eyebrow ? <p className="adm-eyebrow">{eyebrow}</p> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="adm-title min-w-0">{title}</h1>
        {actions ? <div className="stf-noprint flex flex-wrap items-center gap-2">{actions}</div> : null}
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
        {aside ? <div className="stf-noprint flex flex-wrap items-center gap-2">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A flat figure card; a link when `to` is given. */
export function Kpi({ label, value, hint, to, icon }: { label: ReactNode; value: ReactNode; hint?: ReactNode; to?: string; icon?: IconName }) {
  const body = (
    <>
      <p className="flex items-start gap-1.5 type-caption text-ink-2">
        {icon ? <Icon name={icon} size={16} className="mt-0.5 shrink-0" /> : null}
        {/* one item, so a long label wraps inside a narrow card instead of pushing out of it */}
        <span className="min-w-0">{label}</span>
      </p>
      <p className="type-kpi nums text-ink">{value}</p>
      {hint ? <p className="type-caption text-ink-2">{hint}</p> : null}
    </>
  );
  return to ? (
    <Link to={to} className="adm-card content-start no-underline">
      {body}
    </Link>
  ) : (
    <div className="adm-card content-start">{body}</div>
  );
}

/** A raised card for something that needs this person's decision (DESIGN.md §10: only decisions are raised). */
export function DecisionCard({ icon, title, text, to, action }: { icon: IconName; title: ReactNode; text?: ReactNode; to: string; action: string }) {
  return (
    <li className="adm-card adm-card--act">
      <div className="flex items-start gap-3">
        <Icon name={icon} size={22} className="mt-1 shrink-0 text-ink-2" />
        <div className="grid min-w-0 gap-1">
          <p className="type-strong text-ink">{title}</p>
          {text ? <p className="type-caption text-ink-2">{text}</p> : null}
          <Link to={to} className="adm-link type-label">
            {action}
          </Link>
        </div>
      </div>
    </li>
  );
}

/** A note with an icon (flat, never a toast): rules, boundaries, honest limits. */
export function Note({ icon = "info", tone = "info", children, className }: { icon?: IconName; tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode; className?: string }) {
  return (
    <div role="note" className={cx("adm-notice", tone === "warn" && "adm-notice--warn", tone === "bad" && "adm-notice--bad", tone === "ok" && "adm-notice--ok", className)}>
      <Icon name={icon} size={18} className={tone === "info" ? "text-info" : undefined} />
      <div className="grid min-w-0 gap-1 text-ink">{children}</div>
    </div>
  );
}

const TONE_OF: Record<Tone, "ok" | "warn" | "info" | "bad" | "neutral"> = { ok: "ok", warn: "warn", info: "info", bad: "bad", neutral: "neutral" };

/** A status in words with its dot, by the module's tone table. */
export function StateTag<K extends keyof typeof TONES>({ group, value, label }: { group: K; value: string; label: string }) {
  const tone = ((TONES[group] as Record<string, Tone>)[value] ?? "neutral") as Tone;
  return <Status tone={TONE_OF[tone]}>{label}</Status>;
}

/** An outlined fact tag (demo, a flag). */
export function Flag({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <span className="stf-flag">
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </span>
  );
}

export function DemoTag({ show }: { show: boolean | undefined }) {
  const t = useStaffT();
  return show ? <Flag>{t("common.demo")}</Flag> : null;
}

/** A label/value pair inside a card. */
export function Pair({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="type-caption text-ink-2">{label}</span>
      <span className="type-data text-end text-ink">{children}</span>
    </div>
  );
}

/** A small ledger: label at the start, figure at the end; `strong` rows are totals. */
export function Ledger({ rows, className }: { rows: { label: ReactNode; value: ReactNode; strong?: boolean; hint?: ReactNode; hidden?: boolean }[]; className?: string }) {
  return (
    <dl className={cx("stf-ledger", className)}>
      {rows
        .filter((row) => !row.hidden)
        .map((row, index) => (
          <div key={index} className={cx(row.strong && "stf-ledger__total")}>
            <dt>
              {row.label}
              {row.hint ? <span className="block type-caption text-ink-2">{row.hint}</span> : null}
            </dt>
            <dd>{row.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Filter chips that are links (URL state; works without script). */
export function LinkChips({ label, items }: { label: string; items: { value: string; label: string; href: string; selected: boolean; count?: number }[] }) {
  return (
    <nav aria-label={label} className="stf-noprint">
      <ul role="list" className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.value}>
            <Chip as={Link} to={item.href} selected={item.selected} aria-current={item.selected ? "true" : undefined}>
              {item.count !== undefined ? `${item.label} · ${item.count}` : item.label}
            </Chip>
          </li>
        ))}
      </ul>
    </nav>
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
  sortHref?: (sort: DataSort) => string;
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
        <DataTable caption={caption} columns={columns} rows={rows} rowKey={rowKey} rowLabel={rowLabel} sort={sort ?? null} sortHref={sortHref} empty={empty} selected={selected} onSelectedChange={onSelectedChange} bulkActions={bulkActions} maxHeight={null} />
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

// ───────────────────────────────────────────────────────────────── actions

export type ActionData = { ok: boolean; message?: string; code?: string; fields?: Record<string, string>; intent?: string | null };

/** A unique key per form render (idempotency on money actions, double-submit safe). */
export function newKey(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The confirm-with-reason dialog of the module (blueprint uxRules: dangerous and financial actions need a confirmation
 * and a reason and show their impact first). Posts through a fetcher, stays open while the request runs, shows the
 * server's sentence on failure, closes with a toast on success.
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
  children,
  reasonName = "reason",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  consequence: ReactNode;
  confirmLabel: string;
  tone?: "neutral" | "destructive" | "commit";
  impact?: ReactNode | readonly ImpactRow[];
  reason?: boolean | ReasonOptions;
  fields: Record<string, string>;
  action?: string;
  successMessage: string;
  children?: ReactNode;
  /** The form field the typed reason is sent as (default "reason"). */
  reasonName?: string;
}) {
  const fetcher = useFetcher<ActionData>();
  const handled = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      toast.success(result.message ?? successMessage);
      onClose();
    }
  }, [fetcher.data, fetcher.state, onClose, successMessage]);
  const failure = fetcher.data && !fetcher.data.ok && fetcher.state === "idle" ? fetcher.data : null;
  const error = failure ? (failure.message ?? Object.values(failure.fields ?? {})[0] ?? failure.code) : undefined;
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
        if (reason) form.set(reasonName, note);
        fetcher.submit(form, { method: "post", action });
      }}
    >
      {children}
    </ConfirmDialog>
  );
}

/**
 * A form in a dialog (add or change a record): posts through a fetcher, keeps the dialog open while the request runs,
 * shows field errors where they belong (`children` gets them) and the form's sentence, closes with a toast.
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
  successMessage: string;
  hidden?: Record<string, string>;
}) {
  const t = useStaffT();
  const fetcher = useFetcher<ActionData>();
  const handled = useRef<unknown>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok) {
      toast.success(fetcher.data.message ?? successMessage);
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
          <Key type="submit" variant="primary" loading={busy} className="flex-1 sm:flex-none">
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
        {failure ? (
          <p role="alert" className="flex items-start gap-1 type-label text-red-ink">
            <Icon name="warning-circle" size={16} className="mt-0.5 flex-none" />
            <span>{failure.message && !failure.fields ? failure.message : t("common.checkFields")}</span>
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** A sentence that a request failed, beside the control that sent it (role=alert). */
export function Failure({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-start gap-1 type-body text-red-ink">
      <Icon name="warning-circle" size={18} className="mt-0.5 flex-none" />
      <span>{message}</span>
    </p>
  );
}

// ───────────────────────────────────────────────────────────────── printing

/**
 * While the browser prints, the whole document is light (<html data-theme="light">) and goes back to the theme it had
 * right after: a dark screen never prints light ink on white paper — the page head included, not only the slips.
 */
export function usePrintInLight(): void {
  useEffect(() => {
    const root = document.documentElement;
    let previous: string | null = null;
    let printing = false;
    const before = () => {
      if (!printing) previous = root.getAttribute("data-theme");
      printing = true;
      root.setAttribute("data-theme", "light");
    };
    const after = () => {
      if (!printing) return;
      printing = false;
      if (previous === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", previous);
    };
    window.addEventListener("beforeprint", before);
    window.addEventListener("afterprint", after);
    return () => {
      after();
      window.removeEventListener("beforeprint", before);
      window.removeEventListener("afterprint", after);
    };
  }, []);
}

export function PrintKey({ label }: { label: string }) {
  return (
    <Key type="button" size="sm" icon="printer" onClick={() => window.print()}>
      {label}
    </Key>
  );
}
