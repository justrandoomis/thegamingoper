/**
 * Small building blocks shared by the screens of module 16 (marketing). Admin rules (DESIGN.md §10): data has no
 * material, status is words with a dot, numbers are tabular and isolated (<bdi>), money is integer IQD with the figure
 * first, a figure that cannot be computed says so in words (never 0), raised clay only where a person must decide.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { MARKETING_NS, type HistoryRow, type Tone } from "~/server/services/admin/marketing/types";
import { cx } from "~/ui/cx";
import { ConfirmDialog, type ImpactRow, type ReasonOptions } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { MARKETING_LAYOUT_ID } from "./meta";

/** `t()` for the module's strings (sent by the marketing layout's loader, with the shared "errors" namespace). */
export function useMarketingT(): TFunction {
  const layout = useRouteLoaderData(MARKETING_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(MARKETING_NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[MARKETING_NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? translate(shared, locale, key, vars) : undefined) ?? key;
  }, [layout, locale, fallback]);
}

/** An IQD amount, figure first ("749,000 د.ع"), isolated; the `none` words when there is no number (never 0). */
export function Money({ iqd, none, className }: { iqd: number | null | undefined; none?: ReactNode; className?: string }) {
  const f = useFormat();
  if (typeof iqd !== "number" || !Number.isFinite(iqd)) return <span className={cx("text-ink-2", className)}>{none ?? "—"}</span>;
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", iqd < 0 && "text-red-ink", className)}>
      {f.iqd(Math.round(iqd))}
    </bdi>
  );
}

export function Num({ value, className, digits = 0 }: { value: number | null | undefined; className?: string; digits?: number }) {
  const f = useFormat();
  if (typeof value !== "number" || !Number.isFinite(value)) return <span className={cx("text-ink-2", className)}>—</span>;
  return <bdi className={cx("nums", value < 0 && "text-red-ink", className)}>{f.number(value, { maximumFractionDigits: digits, minimumFractionDigits: digits })}</bdi>;
}

export function When({ at, style = "datetime" }: { at: number | null | undefined; style?: "datetime" | "date" }) {
  const f = useFormat();
  if (!at) return <span>—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} className="nums">
      {style === "date" ? f.date(at) : f.dateTime(at)}
    </time>
  );
}

/** A code, a path or a URL (left to right inside any text). */
export function Code({ value, className }: { value: string; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums mkt-code", className)}>
      {value}
    </bdi>
  );
}

export function PhoneText({ phone }: { phone: { display: string; full: boolean } | null | undefined }) {
  const t = useMarketingT();
  if (!phone) return <span className="text-ink-2">—</span>;
  return (
    <bdi dir="ltr" className="nums" title={phone.full ? undefined : t("common.phoneMasked")}>
      {phone.display}
    </bdi>
  );
}

export function ToneStatus({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Status tone={tone}>{children}</Status>;
}

export function DemoTag({ show }: { show: boolean }) {
  const t = useMarketingT();
  if (!show) return null;
  return <span className="mkt-tag">{t("common.demo")}</span>;
}

/** An outlined fact tag (a reason, a variable, a placement). */
export function Tag({ icon, children, tone }: { icon?: IconName; children: ReactNode; tone?: "warn" | "ok" }) {
  return (
    <span className="mkt-tag">
      {icon ? <Icon name={icon} size={13} className={tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : undefined} /> : null}
      {children}
    </span>
  );
}

/** A flat section with a head. */
export function Section({ id, title, action, children, className, lead }: { id: string; title: ReactNode; action?: ReactNode; children: ReactNode; className?: string; lead?: ReactNode }) {
  return (
    <section className={cx("adm-section", className)} aria-labelledby={id}>
      <div className="adm-section__head">
        <h2 id={id} className="adm-h2">
          {title}
        </h2>
        {action}
      </div>
      {lead ? <p className="max-w-[75ch] type-body text-ink-2">{lead}</p> : null}
      {children}
    </section>
  );
}

/** Label/value pairs (a definition list), two columns from 600px. */
export function Facts({ rows, className }: { rows: { label: ReactNode; value: ReactNode; hidden?: boolean }[]; className?: string }) {
  return (
    <dl className={cx("mkt-facts", className)}>
      {rows
        .filter((row) => !row.hidden)
        .map((row, index) => (
          <div key={index}>
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
    </dl>
  );
}

/** Flat KPI tiles: caption label, the figure, the line that says where it comes from. */
export function Kpis({ items }: { items: { label: ReactNode; value: ReactNode; note?: ReactNode; hidden?: boolean }[] }) {
  return (
    <div className="mkt-kpis">
      {items
        .filter((item) => !item.hidden)
        .map((item, index) => (
          <div key={index} className="mkt-kpi">
            <p className="type-caption text-ink-2">{item.label}</p>
            <p className="type-kpi">{item.value}</p>
            {item.note ? <p className="type-caption text-ink-2">{item.note}</p> : null}
          </div>
        ))}
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

/** A plain notice line (a rule, a source) — words and an icon. */
export function Notice({ icon = "info", tone = "neutral", children }: { icon?: IconName; tone?: "neutral" | "warn"; children: ReactNode }) {
  return (
    <p className={cx("flex items-start gap-2 type-body", tone === "warn" ? "text-ink" : "text-ink-2")}>
      <Icon name={icon} size={18} className={cx("mt-0.5 flex-none", tone === "warn" && "text-warn")} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** The honest boundary of a section: what cannot happen without a provider or another module. */
export function Boundary({ title, children }: { title?: ReactNode; children: ReactNode }) {
  const t = useMarketingT();
  return (
    <div className="mkt-boundary" role="note">
      <p className="flex items-center gap-2 type-label">
        <Icon name="plugs-connected" size={18} className="text-warn" />
        {title ?? t("common.boundaryTitle")}
      </p>
      <p className="type-body text-ink-2">{children}</p>
    </div>
  );
}

/** The audit history of a record (newest first). */
export function History({ rows }: { rows: readonly HistoryRow[] }) {
  const t = useMarketingT();
  if (rows.length === 0) return <p className="type-body text-ink-2">{t("common.noHistory")}</p>;
  return (
    <ol className="mkt-history">
      {rows.map((row) => (
        <li key={row.id}>
          <span className="type-strong">{actionLabel(t, row.action)}</span>
          <span className="type-caption text-ink-2">
            {row.actor ?? t("common.system")} · <When at={row.at} />
          </span>
          {row.reason ? <span className="type-caption text-ink-2">{t("common.reasonWas", { reason: row.reason })}</span> : null}
        </li>
      ))}
    </ol>
  );
}

/** "marketing.campaign.create" → its sentence; an unknown action stays as written. */
export function actionLabel(t: (key: string) => string, action: string): string {
  const key = `history.${action.replace(/\./g, "_")}`;
  const label = t(key);
  return label === key ? action : label;
}

/** A unique key per form (idempotency, double-submit safe). */
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A key made once per mounted form (a reload makes a new one; a resubmit of the same form keeps it). */
export function useFormKey(): string {
  const [key] = useState(newKey);
  return key;
}

export type ActionFailure = { ok: false; intent?: string | null; code: string; message?: string; fields?: Record<string, string> };
export type ActionSuccess = { ok: true; intent: string; replayed?: boolean; [key: string]: unknown };
export type ActionResult = ActionFailure | ActionSuccess;

/**
 * A fetcher for one intent: its failure sentence and field errors, and a toast + `onDone` when it succeeded. The toast
 * says "nothing repeated" for a replay. `doneKey: null` = no toast.
 */
export function useIntent(intent: string, doneKey: string | null | ((result: ActionSuccess) => string), onDone?: (result: ActionSuccess) => void, action?: string) {
  const fetcher = useFetcher<ActionResult>();
  const t = useMarketingT();
  const result = fetcher.data;
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok && result.intent === intent) {
      if (doneKey !== null) toast.success(t(result.replayed ? "done.replayed" : typeof doneKey === "function" ? doneKey(result) : doneKey));
      onDone?.(result);
    }
  }, [fetcher.state, result, intent, onDone, t, doneKey]);
  const failure = result && !result.ok && (result.intent === intent || result.intent === null || result.intent === undefined) ? result : null;
  const submit = (values: Record<string, string | string[]>) => {
    const form = new FormData();
    form.set("intent", intent);
    for (const [name, value] of Object.entries(values)) for (const entry of Array.isArray(value) ? value : [value]) form.append(name, entry);
    fetcher.submit(form, { method: "post", ...(action ? { action } : {}) });
  };
  return { fetcher, submit, pending: fetcher.state !== "idle", failure, message: failure ? (failure.message ?? t(`errors.${failure.code}`)) : null, fields: failure?.fields ?? {}, data: result && result.ok && result.intent === intent ? result : null };
}

/** A key that opens a confirm dialog (consequence, impact, reason) and posts one intent with `values` + the reason. */
export function ConfirmAction({
  intent,
  label,
  title,
  consequence,
  confirmLabel,
  values = {},
  impact,
  reason = true,
  reasonField = "reason",
  tone = "neutral",
  icon,
  size = "sm",
  doneKey,
  onDone,
  children,
  variant,
  disabled,
  extra,
}: {
  intent: string;
  label: ReactNode;
  title: ReactNode;
  consequence: ReactNode;
  confirmLabel: string;
  values?: Record<string, string | string[]>;
  impact?: ImpactRow[];
  /** true: a typed reason (≥ 3); an object: the dialog's reason options (codes, an optional note); false: none. */
  reason?: boolean | ReasonOptions;
  reasonField?: string;
  tone?: "neutral" | "destructive" | "commit";
  icon?: IconName;
  size?: "sm" | "md";
  doneKey: string | ((result: ActionSuccess) => string);
  onDone?: (result: ActionSuccess) => void;
  children?: ReactNode;
  variant?: "secondary" | "ghost" | "danger";
  disabled?: boolean;
  extra?: () => Record<string, string | string[]>;
}) {
  const t = useMarketingT();
  const [open, setOpen] = useState(false);
  const { submit, pending, message } = useIntent(
    intent,
    doneKey,
    (result) => {
      setOpen(false);
      onDone?.(result);
    },
  );
  const options: ReasonOptions | undefined = reason === true ? { label: t("common.reason"), hint: t("common.reasonHint") } : reason === false ? undefined : reason;
  return (
    <>
      <Key size={size} icon={icon} variant={variant} disabled={disabled} onClick={() => setOpen(true)}>
        {label}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        consequence={consequence}
        confirmLabel={confirmLabel}
        tone={tone}
        impact={impact}
        reason={options}
        pending={pending}
        error={message}
        onConfirm={({ reason: typed, code }) => submit({ ...values, ...(extra?.() ?? {}), ...(options ? { [reasonField]: typed } : {}), ...(code ? { code } : {}) })}
      >
        {children}
      </ConfirmDialog>
    </>
  );
}

type FormFetcher = { state: string; submit: (target: HTMLFormElement, options: { method: "post" }) => unknown };

/**
 * A form's submit key that first opens the confirm dialog — what will happen and its impact, read from the form as it
 * is filled — and then posts THE FORM through its own fetcher, so a refused field still shows under that field (the
 * reason is the form's own required field). Without JavaScript the key simply submits the form.
 */
export function ConfirmSubmit({
  fetcher,
  label,
  title,
  consequence,
  confirmLabel,
  impact,
  icon,
  disabled,
}: {
  fetcher: FormFetcher;
  label: ReactNode;
  title: ReactNode;
  consequence: (form: FormData) => ReactNode;
  confirmLabel: string;
  impact: (form: FormData) => ImpactRow[];
  icon?: IconName;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [sent, setSent] = useState(false);
  const [view, setView] = useState<{ rows: ImpactRow[]; consequence: ReactNode }>({ rows: [], consequence: null });
  const form = useRef<HTMLFormElement | null>(null);
  const pending = fetcher.state !== "idle";
  // the request answered: close (its success toast, or its field errors under the fields)
  useEffect(() => {
    if (sent && !pending) {
      setSent(false);
      setOpen(false);
    }
  }, [sent, pending]);
  return (
    <>
      <Key
        type="submit"
        icon={icon}
        loading={pending}
        disabled={disabled}
        onClick={(event) => {
          const target = event.currentTarget.form;
          if (!target) return;
          event.preventDefault();
          form.current = target;
          const data = new FormData(target);
          setView({ rows: impact(data), consequence: consequence(data) });
          setOpen(true);
        }}
      >
        {label}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={title}
        consequence={view.consequence}
        confirmLabel={confirmLabel}
        impact={view.rows.length > 0 ? view.rows : undefined}
        pending={pending}
        onConfirm={() => {
          if (!form.current) return;
          setSent(true);
          fetcher.submit(form.current, { method: "post" });
        }}
      />
    </>
  );
}

/** A block that prints ink on paper whatever the screen's theme (the finance module's rule). */
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

/** A list of checkboxes for a multi-choice field (platforms…), in a scrolling panel. */
export function ChoiceList({ name, legend, hint, options, selected, error, disabled }: { name: string; legend: ReactNode; hint?: ReactNode; options: readonly { value: string; label: string }[]; selected: readonly string[]; error?: string; disabled?: boolean }) {
  const chosen = new Set(selected);
  const id = `mkt-${name}`;
  return (
    <fieldset className="mkt-choices" aria-describedby={hint || error ? `${id}-hint` : undefined} disabled={disabled}>
      <legend className="type-label">{legend}</legend>
      {hint || error ? (
        <p id={`${id}-hint`} className={cx("type-caption", error ? "text-red-ink" : "text-ink-2")}>
          {error ?? hint}
        </p>
      ) : null}
      <div className="mkt-choices__list">
        {options.length === 0 ? <p className="type-caption text-ink-2">—</p> : null}
        {options.map((option) => (
          <label key={option.value} className="mkt-choice">
            <input type="checkbox" name={name} value={option.value} defaultChecked={chosen.has(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The number of people left out per reason, as rows (only the reasons that apply). */
export function ExclusionRows({ excluded }: { excluded: Record<string, number> }) {
  const t = useMarketingT();
  const rows = Object.entries(excluded).filter(([, n]) => n > 0);
  if (rows.length === 0) return <p className="type-body text-ink-2">{t("audience.noneExcluded")}</p>;
  return (
    <ul className="mkt-rows">
      {rows.map(([reason, n]) => (
        <li key={reason} className="mkt-row">
          <span className="type-body">{t(`audience.reason.${reason}`)}</span>
          <Num value={n} className="type-strong" />
        </li>
      ))}
    </ul>
  );
}
