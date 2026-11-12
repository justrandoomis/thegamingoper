/**
 * Small building blocks shared by the screens of module 08 (promotions). Admin rules (DESIGN.md §10): data has no
 * material, status is words with a dot, numbers are tabular and isolated (<bdi>), money is integer IQD with the figure
 * first, a label always comes with the sentence that explains it (never colour alone); raised clay only where a person
 * must decide.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useDir, useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { PROMOTIONS_NS, bpsToPercent, type HistoryRow, type Tone } from "~/server/services/admin/promotions/types";
import { cx } from "~/ui/cx";
import { ConfirmDialog, type ImpactRow } from "~/ui/Dialog";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { PROMOTIONS_LAYOUT_ID } from "./meta";

/** `t()` for the module's strings (sent by the promotions layout's loader, with the shared "errors" namespace). */
export function usePromotionsT(): TFunction {
  const layout = useRouteLoaderData(PROMOTIONS_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(PROMOTIONS_NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[PROMOTIONS_NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? translate(shared, locale, key, vars) : undefined) ?? key;
  }, [layout, locale, fallback]);
}

/** From what was to what will be, in reading order: "→" on a left-to-right page, "←" on a right-to-left one. */
export function useArrow(): string {
  return useDir() === "rtl" ? "←" : "→";
}

export function Arrow() {
  return <span aria-hidden="true"> {useArrow()} </span>;
}

/**
 * "before → after" as ONE string (a dialog's impact row, rendered in a <bdi>). Bare numbers carry no direction of their
 * own, so a <bdi> would lay "300 ← 450" out left to right and the arrow would point at the old value; a right-to-left
 * mark first keeps the reading order on an Arabic page.
 */
export function useChangeText(): (from: string, to: string) => string {
  const rtl = useDir() === "rtl";
  return (from, to) => (rtl ? `‏${from} ← ${to}` : `${from} → ${to}`);
}

/** An IQD amount, figure first ("749,000 د.ع"), isolated; "—" when there is no number. */
export function Money({ iqd, className }: { iqd: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (typeof iqd !== "number" || !Number.isSafeInteger(iqd)) return <span className={className}>—</span>;
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", iqd < 0 && "text-red-ink", className)}>
      {f.iqd(iqd)}
    </bdi>
  );
}

export function Num({ value, className }: { value: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (typeof value !== "number" || !Number.isFinite(value)) return <span className={className}>—</span>;
  return <bdi className={cx("nums", value < 0 && "text-red-ink", className)}>{f.number(value)}</bdi>;
}

/** Basis points as a percentage ("12.5%"), isolated; "—" without a number. */
export function Pct({ bps, className }: { bps: number | null | undefined; className?: string }) {
  if (typeof bps !== "number" || !Number.isFinite(bps)) return <span className={className}>—</span>;
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", bps < 0 && "text-red-ink", className)}>
      {bpsToPercent(bps)}%
    </bdi>
  );
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

/** A code or reference (coupon code, TT-…, SKU): left to right inside any text. */
export function Code({ value, className }: { value: string; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums prm-code", className)}>
      {value}
    </bdi>
  );
}

export function PhoneText({ phone }: { phone: { display: string; full: boolean } | null | undefined }) {
  const t = usePromotionsT();
  if (!phone) return <span>—</span>;
  return (
    <bdi dir="ltr" className="nums" title={phone.full ? undefined : t("common.phoneMasked")}>
      {phone.display}
    </bdi>
  );
}

export function ToneStatus({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Status tone={tone}>{children}</Status>;
}

export function DemoNote({ show }: { show: boolean }) {
  const t = usePromotionsT();
  if (!show) return null;
  return <span className="prm-tag">{t("common.demo")}</span>;
}

/** An outlined fact tag (a condition, a reason, a signal). */
export function Tag({ icon, children, warn }: { icon?: IconName; children: ReactNode; warn?: boolean }) {
  return (
    <span className="prm-tag">
      {icon ? <Icon name={icon} size={13} className={warn ? "text-warn" : undefined} /> : null}
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
    <dl className={cx("prm-facts", className)}>
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

/** Flat KPI tiles: caption label, the figure, an optional line. */
export function Kpis({ items }: { items: { label: ReactNode; value: ReactNode; note?: ReactNode; hidden?: boolean }[] }) {
  return (
    <div className="prm-kpis">
      {items
        .filter((item) => !item.hidden)
        .map((item, index) => (
          <div key={index} className="prm-kpi">
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

/** A plain notice line (an honest boundary, a rule) — words and an icon. */
export function Notice({ icon = "info", tone = "neutral", children }: { icon?: IconName; tone?: "neutral" | "warn"; children: ReactNode }) {
  return (
    <p className={cx("flex items-start gap-2 type-body", tone === "warn" ? "text-ink" : "text-ink-2")}>
      <Icon name={icon} size={18} className={cx("mt-0.5 flex-none", tone === "warn" && "text-warn")} />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

/** The honest boundary of a section: what the checkout does not apply yet. */
export function Boundary({ children }: { children: ReactNode }) {
  const t = usePromotionsT();
  return (
    <div className="prm-boundary" role="note">
      <p className="flex items-center gap-2 type-label">
        <Icon name="plugs-connected" size={18} className="text-warn" />
        {t("common.boundaryTitle")}
      </p>
      <p className="type-body text-ink-2">{children}</p>
    </div>
  );
}

/** The audit history of a record (newest first). */
export function History({ rows }: { rows: readonly HistoryRow[] }) {
  const t = usePromotionsT();
  if (rows.length === 0) return <p className="type-body text-ink-2">{t("common.noHistory")}</p>;
  return (
    <ol className="prm-history">
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

/** "promotions.coupon.create" → its sentence; an unknown action stays as written. */
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

export type ActionFailure = { ok: false; intent?: string | null; code: string; message?: string; fields?: Record<string, string> };
export type ActionSuccess = { ok: true; intent: string; replayed?: boolean; [key: string]: unknown };
export type ActionResult = ActionFailure | ActionSuccess;

/**
 * A fetcher for one intent: its failure sentence and field errors, and a toast + `onDone` when it succeeded. The toast
 * says "sent before; nothing repeated" for a replay. `doneKey: null` = no toast (a read, such as a check before a
 * confirm dialog).
 */
export function useIntent(intent: string, doneKey: string | null | ((result: ActionSuccess) => string), onDone?: (result: ActionSuccess) => void, action?: string) {
  const fetcher = useFetcher<ActionResult>();
  const t = usePromotionsT();
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

/**
 * A key that opens a confirm dialog (consequence, impact, reason) and posts one intent with `values` + the reason.
 */
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
  reasonLabel,
  tone = "neutral",
  icon,
  size = "sm",
  doneKey,
  onDone,
  children,
  variant,
  disabled,
  action,
  extra,
}: {
  intent: string;
  label: ReactNode;
  title: ReactNode;
  consequence: ReactNode;
  confirmLabel: string;
  values?: Record<string, string | string[]>;
  impact?: ImpactRow[];
  reason?: boolean;
  reasonField?: string;
  reasonLabel?: string;
  tone?: "neutral" | "destructive" | "commit";
  icon?: IconName;
  size?: "sm" | "md";
  doneKey: string | ((result: ActionSuccess) => string);
  onDone?: (result: ActionSuccess) => void;
  children?: ReactNode;
  variant?: "secondary" | "ghost" | "danger";
  disabled?: boolean;
  action?: string;
  /** More values read when confirming (fields inside `children`). */
  extra?: () => Record<string, string | string[]>;
}) {
  const t = usePromotionsT();
  const [open, setOpen] = useState(false);
  const { submit, pending, message } = useIntent(
    intent,
    doneKey,
    (result) => {
      setOpen(false);
      onDone?.(result);
    },
    action,
  );
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
        reason={reason ? { label: reasonLabel ?? t("common.reason"), hint: t("common.reasonHint") } : undefined}
        pending={pending}
        error={message}
        onConfirm={({ reason: typed }) => submit({ ...values, ...(extra?.() ?? {}), ...(reason ? { [reasonField]: typed } : {}) })}
      >
        {children}
      </ConfirmDialog>
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

/** A list of checkboxes for a multi-choice condition (platforms, categories…), in a scrolling panel. */
export function ChoiceList({ name, legend, hint, options, selected, error }: { name: string; legend: ReactNode; hint?: ReactNode; options: readonly { value: string; label: string; depth?: number }[]; selected: readonly string[]; error?: string }) {
  const chosen = new Set(selected);
  const id = `prm-${name}`;
  return (
    <fieldset className="prm-choices" aria-describedby={hint || error ? `${id}-hint` : undefined}>
      <legend className="type-label">{legend}</legend>
      {hint || error ? (
        <p id={`${id}-hint`} className={cx("type-caption", error ? "text-red-ink" : "text-ink-2")}>
          {error ?? hint}
        </p>
      ) : null}
      <div className="prm-choices__list">
        {options.length === 0 ? <p className="type-caption text-ink-2">—</p> : null}
        {options.map((option) => (
          <label key={option.value} className="prm-choice" style={option.depth ? { paddingInlineStart: `${option.depth * 16}px` } : undefined}>
            <input type="checkbox" name={name} value={option.value} defaultChecked={chosen.has(option.value)} />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** The format helpers the approvals queue needs on the server too (figure first, unit after). */
export function usePercent() {
  return (bps: number | null | undefined) => (typeof bps === "number" ? `${bpsToPercent(bps)}%` : "—");
}
