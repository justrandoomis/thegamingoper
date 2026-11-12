/**
 * Building blocks of the pages of admin module 19 (automation): page heads and sections, flat figures, times in
 * tabular type, statuses with words, a dense table from 768px with a card per row below it, filter chips that are
 * links (URL state), the confirm-with-reason dialog and the server's sentence under a form (DESIGN.md §10: data has no
 * material, only decisions are raised, status is words with a dot, numbers are tabular and isolated). Strings come
 * from the module's layout (AutoT).
 */
import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useFetcher, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { AUTOMATION_NS, type Tone } from "~/server/services/admin/automation/catalog";
import type { PersonView } from "~/server/services/admin/automation/types";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog, type ImpactRow, type ReasonOptions } from "~/ui/Dialog";
import { Status, Tag } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";

export const AUTOMATION_LAYOUT_ID = "routes/admin/automation/layout";

/** Interpolated values keep their own direction (a name typed in Arabic inside English, a code inside Arabic). */
export function isolate(vars?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!vars) return vars;
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(vars)) out[name] = typeof value === "string" && value !== "" && name !== "count" ? `⁨${value}⁩` : value;
  return out;
}

export const AutoT = createContext<TFunction | null>(null);

/** The module's `t()`: its own strings first, then the shared error texts for `errors.*`. */
export function useAutoT(): TFunction {
  const fromLayout = useContext(AutoT);
  const layout = useRouteLoaderData(AUTOMATION_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT("admin");
  return useMemo(() => {
    if (fromLayout) return fromLayout;
    const mine = layout?.i18n?.[AUTOMATION_NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, raw?: Record<string, string | number>) => {
      const vars = isolate(raw);
      return translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? translate(shared, locale, key, vars) : undefined) ?? key;
    };
  }, [fromLayout, layout, locale, fallback]);
}

/** On a phone the section links scroll sideways: keep the current one in view after each navigation. */
export function useCurrentTabInView(navClass: string, current: string): void {
  useEffect(() => {
    const link = document.querySelector<HTMLElement>(`.${navClass} [aria-current="page"]`);
    let strip = link?.parentElement ?? null;
    while (strip && strip.scrollWidth <= strip.clientWidth) strip = strip.parentElement;
    if (!link || !strip || strip === document.documentElement || strip === document.body) return;
    const box = strip.getBoundingClientRect();
    const tab = link.getBoundingClientRect();
    const margin = 16;
    if (tab.left < box.left) strip.scrollBy({ left: tab.left - box.left - margin });
    else if (tab.right > box.right) strip.scrollBy({ left: tab.right - box.right + margin });
  }, [navClass, current]);
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
    <section className={cx("adm-section", className)} aria-labelledby={id} id={`${id}-section`}>
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

/** A flat figure card: caption label, the figure, an optional hint; a link when `to` is given. */
export function Kpi({ label, value, hint, to }: { label: ReactNode; value: ReactNode; hint?: ReactNode; to?: string }) {
  const body = (
    <>
      <p className="type-caption text-ink-2">{label}</p>
      <p className="type-kpi nums text-ink">
        <bdi>{value}</bdi>
      </p>
      {hint ? <p className="type-caption text-ink-2">{hint}</p> : null}
    </>
  );
  return to ? (
    <Link to={to} className="adm-card content-start">
      {body}
    </Link>
  ) : (
    <div className="adm-card content-start">{body}</div>
  );
}

/** A raised card for something that needs a person's decision (DESIGN.md §10: only decisions are raised). */
export function DecisionCard({ icon, title, count, text, to, action }: { icon: IconName; title: ReactNode; count: number | null; text: ReactNode; to: string; action: string }) {
  const f = useFormat();
  return (
    <li className="adm-card adm-card--act">
      <div className="flex items-start gap-3">
        <Icon name={icon} size={22} className="mt-1 shrink-0 text-ink-2" />
        <div className="grid min-w-0 gap-1">
          <p className="type-strong text-ink">
            {title}
            {count === null ? null : (
              <>
                {" "}
                · <bdi className="nums">{f.number(count)}</bdi>
              </>
            )}
          </p>
          <p className="type-caption text-ink-2">{text}</p>
          <Link to={to} className="adm-link type-label">
            {action}
          </Link>
        </div>
      </div>
    </li>
  );
}

/** A flat note with an icon: rules, boundaries, honest limits. */
export function Note({ icon = "info", tone = "info", children, className }: { icon?: IconName; tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode; className?: string }) {
  return (
    <div role="note" className={cx("adm-notice", tone === "warn" && "adm-notice--warn", tone === "bad" && "adm-notice--bad", tone === "ok" && "adm-notice--ok", className)}>
      <Icon name={icon} size={18} className={tone === "info" ? "text-info" : undefined} />
      <div className="grid gap-1 text-ink">{children}</div>
    </div>
  );
}

/** Words with a dot in the state's colour (never colour alone). */
export function StatusText({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Status tone={tone}>{children}</Status>;
}

/** A demo record, said in words (the kit's demo tag takes its words from its caller). */
export function DemoTag() {
  const t = useAutoT();
  return <Tag kind="demo">{t("common.demo")}</Tag>;
}

export function Num({ value, className }: { value: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cx("text-ink-2", className)}>—</span>;
  return <bdi className={cx("nums", className)}>{f.number(value)}</bdi>;
}

/** Integer IQD, the figure first, isolated; null shows "—" (never a made-up zero). */
export function Money({ iqd }: { iqd: number | null | undefined }) {
  const f = useFormat();
  if (iqd === null || iqd === undefined || !Number.isFinite(iqd)) return <span className="text-ink-2">—</span>;
  return <bdi className={cx("nums whitespace-nowrap", iqd < 0 && "text-red-ink")}>{f.iqd(iqd)}</bdi>;
}

/** A time in Iraq time; "—" when there is none. */
export function When({ at, kind = "dateTime" }: { at: number | null | undefined; kind?: "dateTime" | "date" }) {
  const f = useFormat();
  if (at === null || at === undefined) return <span>—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} className="nums whitespace-nowrap">
      {kind === "date" ? f.date(at) : f.dateTime(at)}
    </time>
  );
}

/** "3 hours ago" next to the time it stands for (the title carries the exact time). */
export function Ago({ at, now }: { at: number | null | undefined; now: number }) {
  const f = useFormat();
  if (at === null || at === undefined) return <span>—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={f.dateTime(at)} className="nums whitespace-nowrap">
      {f.relative(at, now)}
    </time>
  );
}

/** A code, a SKU, an id, a reference: left to right, tabular. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums break-words", className)}>
      {children}
    </bdi>
  );
}

/** A label/value pair inside a card. */
export function Pair({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="type-caption text-ink-2">{label}</span>
      <span className="type-data min-w-0 text-end text-ink">{children}</span>
    </div>
  );
}

/** Who did it: a person's name, the scheduler, or "—". */
export function Person({ who }: { who: PersonView }) {
  const t = useAutoT();
  if (!who) return <span className="text-ink-2">—</span>;
  if ("system" in who) return <span>{t("common.system")}</span>;
  return <bdi>{who.name}</bdi>;
}

/** Filter chips that are links (URL state, work without JavaScript). */
export function LinkChips({ label, items }: { label: string; items: { value: string; label: ReactNode; href: string; selected: boolean; count?: number }[] }) {
  const f = useFormat();
  return (
    <nav aria-label={label}>
      <ul role="list" className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.value}>
            <Chip as={Link} to={item.href} preventScrollReset selected={item.selected} aria-current={item.selected ? "page" : undefined}>
              {item.label}
              {item.count !== undefined ? <span className="nums"> · {f.number(item.count)}</span> : null}
            </Chip>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** A dense table from 768px and one card per row below it (phones). */
export function ResponsiveList<Row>({
  caption,
  columns,
  rows,
  rowKey,
  card,
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
        <DataTable caption={caption} columns={columns} rows={rows} rowKey={rowKey} empty={empty} maxHeight={null} selected={selected} onSelectedChange={onSelectedChange} bulkActions={bulkActions} rowLabel={rowLabel} />
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

/** The server's sentence under a form (role=alert); nothing when there is no failure. */
export function FormError({ message }: { message: string | null | undefined }) {
  if (!message) return null;
  return (
    <p role="alert" className="flex items-center gap-2 type-label text-red-ink">
      <Icon name="warning-circle" size={16} />
      <span>{message}</span>
    </p>
  );
}

export type ActionData = { ok: boolean; message?: string; code?: string; fields?: Record<string, string>; intent?: string | null };

/** A failure result's sentence: the translated message, else the first field error, else the code's text. */
export function failureText(t: TFunction, result: ActionData | undefined | null): string | null {
  if (!result || result.ok) return null;
  return result.message ?? Object.values(result.fields ?? {})[0] ?? (result.code ? t(`errors.${result.code}`) : null);
}

/**
 * The confirm-with-reason dialog (blueprint uxRules: dangerous actions show their impact and need a reason). Posts to
 * the page's action (or `action`) through a fetcher, stays open while the request runs, shows the server's sentence on
 * failure, closes with a toast on success.
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
  successMessage,
  children,
  action,
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
  fields: Record<string, string | readonly string[]>;
  successMessage: string | ((data: Record<string, unknown>) => string);
  children?: ReactNode;
  action?: string;
  onDone?: (data: Record<string, unknown>) => void;
}) {
  const t = useAutoT();
  const fetcher = useFetcher<ActionData & Record<string, unknown>>();
  const handled = useRef<unknown>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      toast.success(typeof successMessage === "function" ? successMessage(result) : (result.message ?? successMessage));
      onDone?.(result);
      onClose();
    }
  }, [fetcher.data, fetcher.state, onClose, onDone, successMessage]);
  const failure = fetcher.data && !fetcher.data.ok && fetcher.state === "idle" ? failureText(t, fetcher.data) : null;
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={title}
      consequence={consequence}
      confirmLabel={confirmLabel}
      cancelLabel={t("common.back")}
      tone={tone}
      impact={impact}
      reason={reason}
      pending={fetcher.state !== "idle"}
      error={failure}
      onConfirm={({ reason: note }) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) {
          if (typeof value === "string") form.set(key, value);
          else for (const item of value) form.append(key, item);
        }
        if (reason) form.set("reason", note);
        fetcher.submit(form, { method: "post", ...(action ? { action } : {}) });
      }}
    >
      {children}
    </ConfirmDialog>
  );
}
