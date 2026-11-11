/**
 * Small building blocks shared by the screens of module 10 (finance). Admin rules (DESIGN.md §10): data has no
 * material, status is words with a dot, numbers are tabular at the inline end and isolated (<bdi>), money is integer
 * IQD with the figure first, a negative amount carries a minus sign in red-ink text, a figure that cannot be shown is
 * "—" with the reason (never a zero), raised clay only for what a person must decide.
 */
import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { Form, Link, useFetcher, useLocation, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { LOCALES } from "~/lib/locales";
import { cx } from "~/ui/cx";
import { DataTable, type DataColumn, type DataSort } from "~/ui/DataTable";
import { ConfirmDialog, Dialog, type ImpactRow, type ReasonOptions } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import type { ByView, FinanceAccess, RefLink } from "~/server/services/admin/finance/shared.server";
import { FINANCE_NS, periodOf, periodRange, REF_TYPES, shiftPeriod, TONES, type RangeFilter, type StatusTone } from "~/server/services/admin/finance/types";
import { FINANCE_LAYOUT_ID } from "./meta";

/** The finance layout's data (every page below can read it). */
export type FinanceLayoutData = {
  access: FinanceAccess;
  counts: { topups: number | null; adjustments: number | null; expenses: number | null; statements: number | null };
  storeMode: "demo" | "live";
};

export function useFinanceLayout(): FinanceLayoutData | undefined {
  return useRouteLoaderData(FINANCE_LAYOUT_ID) as FinanceLayoutData | undefined;
}

/**
 * `t()` for the module's strings (the finance layout's loader sends them, with the shared "errors" namespace). An
 * `errors.<code>` key the module does not define comes from "errors" (the commerce core's codes).
 */
export function useFinT(): TFunction {
  const layout = useRouteLoaderData(FINANCE_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(FINANCE_NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[FINANCE_NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? translate(shared, locale, key, vars) : undefined) ?? key;
  }, [layout, locale, fallback]);
}

// ───────────────────────────────────────────────────────────────── figures

/**
 * Integer IQD, figure first ("749,000 د.ع"), isolated. null/undefined is "—" with the reason for screen readers
 * (never a made-up zero); a negative amount gets a minus sign and red-ink text.
 */
export function Money({ iqd, unknown, signed = false, plain = false, className }: { iqd: number | null | undefined; unknown?: string; signed?: boolean; plain?: boolean; className?: string }) {
  const f = useFormat();
  const t = useFinT();
  if (iqd === null || iqd === undefined || !Number.isSafeInteger(iqd)) {
    const why = unknown ?? t("common.notAvailable");
    return (
      <span className={cx("text-ink-2", className)} title={why}>
        —<span className="sr-only"> {why}</span>
      </span>
    );
  }
  const sign = iqd < 0 ? "−" : signed && iqd > 0 ? "+" : "";
  const text = plain ? f.number(Math.abs(iqd)) : f.iqd(Math.abs(iqd));
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", iqd < 0 && "text-red-ink", className)}>
      {sign}
      {text}
    </bdi>
  );
}

export function Num({ value, className }: { value: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={className}>—</span>;
  return <bdi className={cx("nums", value < 0 && "text-red-ink", className)}>{value < 0 ? `−${f.number(-value)}` : f.number(value)}</bdi>;
}

/** Basis points as a percentage ("12.5 %"); null is "—". */
export function Bps({ value }: { value: number | null | undefined }) {
  const f = useFormat();
  if (value === null || value === undefined) return <span>—</span>;
  return <bdi className={cx("nums", value < 0 && "text-red-ink")}>{f.percent(value / 10_000)}</bdi>;
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

/** A Baghdad day "YYYY-MM-DD" as a date. */
export function Day({ day }: { day: string }) {
  const f = useFormat();
  const ms = Date.parse(`${day}T09:00:00Z`);
  if (!Number.isFinite(ms)) return <span>{day}</span>;
  return (
    <time dateTime={day} className="nums whitespace-nowrap">
      {f.date(ms, "medium")}
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

// ───────────────────────────────────────────────────────────────── page structure

export function PageHead({ eyebrow, title, lead, actions }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="adm-page-head">
      {eyebrow ? <p className="adm-eyebrow">{eyebrow}</p> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="adm-title min-w-0">{title}</h1>
        {actions ? <div className="fin-noprint flex flex-wrap items-center gap-2">{actions}</div> : null}
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
        {aside ? <div className="fin-noprint flex flex-wrap items-center gap-2">{aside}</div> : null}
      </div>
      {children}
    </section>
  );
}

/** A flat KPI card: caption label, the figure in KPI type, an optional hint. */
export function Kpi({ label, value, hint, icon }: { label: ReactNode; value: ReactNode; hint?: ReactNode; icon?: IconName }) {
  return (
    <div className="adm-card content-start">
      <p className="flex items-center gap-1.5 type-caption text-ink-2">
        {icon ? <Icon name={icon} size={16} /> : null}
        {label}
      </p>
      <p className="type-kpi nums text-ink">{value}</p>
      {hint ? <p className="type-caption text-ink-2">{hint}</p> : null}
    </div>
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

export function StateTag<K extends keyof typeof TONES>({ group, value, label }: { group: K; value: string; label: string }) {
  const tone = ((TONES[group] as Record<string, StatusTone>)[value] ?? "neutral") as StatusTone;
  return <Status tone={tone}>{label}</Status>;
}

/** An outlined fact tag (demo, a flag). */
export function Flag({ children, icon }: { children: ReactNode; icon?: IconName }) {
  return (
    <span className="fin-flag">
      {icon ? <Icon name={icon} size={13} /> : null}
      {children}
    </span>
  );
}

export function DemoTag({ show }: { show: boolean }) {
  const t = useFinT();
  return show ? <Flag>{t("common.demo")}</Flag> : null;
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

/** A small ledger: label at the start, figure at the end; `strong` rows are totals. */
export function Ledger({ rows, className }: { rows: { label: ReactNode; value: ReactNode; strong?: boolean; hint?: ReactNode; hidden?: boolean; indent?: boolean }[]; className?: string }) {
  return (
    <dl className={cx("fin-ledger", className)}>
      {rows
        .filter((row) => !row.hidden)
        .map((row, index) => (
          <div key={index} className={cx(row.strong && "fin-ledger__total", row.indent && "fin-ledger__indent")}>
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

/** Who made a posting, in words. */
export function ByLabel({ by }: { by: ByView }) {
  const t = useFinT();
  if (by.kind === "employee") return <span>{by.name}</span>;
  if (by.kind === "system") return <span className="text-ink-2">{t("common.bySystem")}</span>;
  if (by.kind === "customer") return <span className="text-ink-2">{t("common.byCustomer")}</span>;
  return <span className="text-ink-2">—</span>;
}

/** Where a journal reference leads, as a link (or the reference type in words when it has no page). */
export function RefView({ link, refType }: { link: RefLink; refType: string | null }) {
  const t = useFinT();
  const kind = refType && (REF_TYPES as readonly string[]).includes(refType) ? refType : "other";
  const label = t(`refType.${kind}`);
  if (!link.href) return <span className="text-ink-2">{label}</span>;
  return (
    <Link to={link.href} prefetch="intent" className="adm-link whitespace-nowrap">
      {label}
      {link.label ? (
        <>
          {" "}
          <Code>{link.label}</Code>
        </>
      ) : null}
    </Link>
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
        <DataTable
          caption={caption}
          columns={columns}
          rows={rows}
          rowKey={rowKey}
          rowLabel={rowLabel}
          sort={sort ?? null}
          sortHref={sortHref}
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

/**
 * The range of a report or list, in the URL (works without JavaScript): this month / last month as links, a month
 * field, or two days; and "include demo data". `keep` names other query parameters to carry along.
 */
export function RangeBar({ range, action, keep = {}, now, showDemo = true }: { range: RangeFilter; action: string; keep?: Record<string, string | null | undefined>; now: number; showDemo?: boolean }) {
  const t = useFinT();
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
    for (const [key, value] of Object.entries(keep)) if (value) params.set(key, value);
    return `${action}?${params.toString()}`;
  };
  const custom = range.period !== current && range.period !== previous;
  return (
    <div className="fin-noprint grid gap-2">
      <nav aria-label={t("range.quick")} className="flex flex-wrap items-center gap-2">
        {[current, previous].map((period) => (
          <Key key={period} as={Link} to={link({ period })} size="sm" held={range.period === period} aria-current={range.period === period ? "true" : undefined}>
            {label(period)}
          </Key>
        ))}
        {showDemo ? (
          // a link that says what it does: demo rows in, or out again (the rows carry a "demo" tag while they are in)
          <Key as={Link} to={link({ demo: !range.demo })} size="sm" icon={range.demo ? "x" : "plus"}>
            {range.demo ? t("range.hideDemo") : t("range.demo")}
          </Key>
        ) : null}
      </nav>
      <Disclosure summary={custom ? t("range.customShown", { from: range.from, to: range.to }) : t("range.custom")} defaultOpen={custom} variant="row">
        <Form method="get" action={action} className="flex flex-wrap items-end gap-3 pt-2">
          {Object.entries(keep).map(([key, value]) => (value ? <input key={key} type="hidden" name={key} value={value} /> : null))}
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

/** "N demo rows are hidden — show them" (real figures leave demo data out: docs/metrics.md §1). */
export function DemoHidden({ count, href }: { count: number; href: string }) {
  const t = useFinT();
  if (count <= 0) return null;
  return (
    <Note icon="info">
      <p>
        {t("range.demoHidden", { count })}{" "}
        <Link to={href} className="adm-link">
          {t("range.showDemo")}
        </Link>
      </p>
    </Note>
  );
}

// ───────────────────────────────────────────────────────────────── module navigation

type NavItem = { to: string; label: string; icon: IconName; count?: number | null; show: boolean; exact?: boolean };

/** The module's sections as link tabs (URL state; Back works); only those this employee may open, with beads. */
export function FinanceNav({ items }: { items: NavItem[] }) {
  const t = useFinT();
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
    <nav aria-label={t("nav.label")} className="fin-nav fin-noprint">
      <ul ref={listRef} className="fin-nav__list">
        {visible.map((item) => {
          const current = item.exact ? location.pathname.replace(/\/$/, "") === item.to : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
          return (
            <li key={item.to}>
              <Link to={item.to} prefetch="intent" className="fin-nav__link" aria-current={current ? "page" : undefined}>
                <Icon name={item.icon} size={18} />
                <span>{item.label}</span>
                {item.count ? (
                  <b className="bead nums" aria-label={t("nav.waiting", { count: item.count })}>
                    {item.count}
                  </b>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

// ───────────────────────────────────────────────────────────────── actions

export type ActionData = { ok: boolean; message?: string; code?: string; fields?: Record<string, string>; intent?: string };

/** A unique key per form (idempotency on money actions, double-submit safe). */
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The confirm-with-reason dialog of the module (blueprint uxRules: dangerous and financial actions need a confirmation
 * and a reason, and show their financial impact first). Posts through a fetcher, stays open while the request runs,
 * shows the server's sentence on failure, and closes with a toast on success.
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
  fetcherKey,
  onDone,
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
  successMessage?: string;
  children?: ReactNode;
  fetcherKey?: string;
  onDone?: (data: ActionData) => void;
}) {
  const fetcher = useFetcher<ActionData>({ key: fetcherKey });
  const handled = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      toast.success(result.message ?? successMessage ?? "");
      onDone?.(result);
      onClose();
    }
  }, [fetcher.data, fetcher.state, onClose, onDone, successMessage]);
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
  fetcherKey,
  successMessage,
  hidden,
}: {
  title: ReactNode;
  description?: ReactNode;
  submitLabel: string;
  action?: string;
  onClose: () => void;
  children: (fields: Record<string, string>) => ReactNode;
  fetcherKey?: string;
  successMessage?: string;
  hidden?: Record<string, string>;
}) {
  const t = useFinT();
  const fetcher = useFetcher<ActionData>({ key: fetcherKey });
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

/** A file field: a clay key that opens the picker, then the chosen file's name; works without JavaScript too. */
export function FileField({ name, label, accept, hint, error, required }: { name: string; label: string; accept: string; hint?: string; error?: string; required?: boolean }) {
  const t = useFinT();
  const id = useId();
  const [file, setFile] = useState<string | null>(null);
  return (
    <div className="grid gap-1">
      <span className="type-label text-ink" id={`${id}-label`}>
        {label}
        {required ? <span className="text-ink-2"> *</span> : null}
      </span>
      <div className="flex flex-wrap items-center gap-3">
        <input
          id={id}
          name={name}
          type="file"
          accept={accept}
          required={required}
          className="peer sr-only"
          aria-labelledby={`${id}-label`}
          aria-describedby={hint ? `${id}-hint` : undefined}
          aria-invalid={error ? true : undefined}
          onChange={(event) => setFile(event.currentTarget.files?.[0]?.name ?? null)}
        />
        <Key as="label" htmlFor={id} size="sm" icon="paperclip" className="cursor-pointer peer-focus-visible:outline-[2.5px] peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-ink">
          {t("common.chooseFile")}
        </Key>
        <span className="type-caption text-ink-2" aria-live="polite">
          {file ? <bdi>{file}</bdi> : t("common.noFile")}
        </span>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="type-caption text-ink-2">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="flex items-center gap-1 type-caption text-red-ink">
          <Icon name="warning-circle" size={16} />
          {error}
        </p>
      ) : null}
    </div>
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

export function failureOf(data: unknown, intent?: string): ActionData | null {
  const result = data as ActionData | undefined;
  if (!result || result.ok) return null;
  if (intent && result.intent && result.intent !== intent) return null;
  return result;
}

// ───────────────────────────────────────────────────────────────── printing

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

export function PrintKey({ label }: { label: string }) {
  return (
    <Key type="button" size="sm" icon="printer" onClick={() => window.print()}>
      {label}
    </Key>
  );
}
