/**
 * Small building blocks shared by the screens of module 07 (customers). Admin rules (DESIGN.md §10): data has no
 * material, status is words with a dot, numbers are tabular and isolated (<bdi>), money is integer IQD with the figure
 * first, a label always comes with the sentence that explains it (never colour alone).
 */
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { CUSTOMER_STATUS_TONE, CUSTOMERS_NS, flagKind, PRIVACY_STATUS_TONE, RFM_SEGMENT_TONE, type CustomerFlag, type CustomerStatusKey, type PhoneView, type PrivacyStatus, type RfmSegment, type Tone } from "~/server/services/admin/customers/types";
import { cx } from "~/ui/cx";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { CUSTOMERS_LAYOUT_ID } from "./meta";

/** `t()` for the module's strings (sent by the customers layout's loader, with the shared "errors" namespace). */
export function useCustomersT(): TFunction {
  const layout = useRouteLoaderData(CUSTOMERS_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(CUSTOMERS_NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[CUSTOMERS_NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? translate(shared, locale, key, vars) : undefined) ?? key;
  }, [layout, locale, fallback]);
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

export function Num({ value, className }: { value: number; className?: string }) {
  const f = useFormat();
  return <bdi className={cx("nums", className)}>{f.number(value)}</bdi>;
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

/** A reference (TT-…, RMA-…, PR-…): left to right inside any text. */
export function Ref({ value, className }: { value: string; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums", className)}>
      {value}
    </bdi>
  );
}

export function PhoneText({ phone }: { phone: PhoneView | null }) {
  const t = useCustomersT();
  if (!phone) return <span>—</span>;
  return (
    <bdi dir="ltr" className="nums" title={phone.full ? undefined : t("phoneMasked")}>
      {phone.display}
    </bdi>
  );
}

export function CustomerStatusBadge({ status }: { status: CustomerStatusKey }) {
  const t = useCustomersT();
  return <Status tone={CUSTOMER_STATUS_TONE[status]}>{t(`status.${status}`)}</Status>;
}

export function SegmentBadge({ segment }: { segment: RfmSegment | null }) {
  const t = useCustomersT();
  if (!segment) return <span className="text-ink-2">—</span>;
  return <Status tone={RFM_SEGMENT_TONE[segment]}>{t(`segment.${segment}.name`)}</Status>;
}

export function ToneStatus({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <Status tone={tone}>{children}</Status>;
}

export function PrivacyStatusBadge({ status }: { status: PrivacyStatus }) {
  const t = useCustomersT();
  return <Status tone={PRIVACY_STATUS_TONE[status]}>{t(`privacy.status.${status}`)}</Status>;
}

export function DemoNote({ show }: { show: boolean }) {
  const t = useCustomersT();
  if (!show) return null;
  return <span className="cus-tag">{t("demo")}</span>;
}

const FLAG_ICON: Record<ReturnType<typeof flagKind>, IconName> = { vip: "star", risk: "warning", complaint: "chat-circle" };

/** Outlined tags for a customer's labels (words and an icon). */
export function FlagTags({ flags, max = 3 }: { flags: readonly CustomerFlag[]; max?: number }) {
  const t = useCustomersT();
  if (flags.length === 0) return null;
  // one tag per kind is enough in a row; the profile explains each rule
  const kinds = [...new Set(flags.map((flag) => flagKind(flag.id)))];
  return (
    <span className="inline-flex flex-wrap gap-1">
      {kinds.slice(0, max).map((kind) => (
        <span key={kind} className="cus-tag">
          <Icon name={FLAG_ICON[kind]} size={13} className={kind === "risk" ? "text-warn" : undefined} />
          {t(`flags.kind.${kind}`)}
        </span>
      ))}
    </span>
  );
}

/** Each label with the sentence that explains it (the reviewer sees why, never a score). */
export function FlagExplanations({ flags, empty }: { flags: readonly CustomerFlag[]; empty?: string }) {
  const t = useCustomersT();
  const f = useFormat();
  if (flags.length === 0) return <p className="type-body text-ink-2">{empty ?? t("flags.none")}</p>;
  return (
    <ul className="grid gap-2">
      {flags.map((flag) => {
        const vars: Record<string, string | number> = { ...flag.vars };
        for (const key of ["amount", "threshold"]) if (typeof vars[key] === "number" && flag.id === "vip_spend") vars[key] = f.iqd(vars[key] as number);
        // the windows are settings (1–3650 days): the noun agrees with the number
        if (typeof vars.days === "number") vars.within = t("withinDays", { count: vars.days });
        const kind = flagKind(flag.id);
        return (
          <li key={flag.id} className="flex items-start gap-2">
            <Icon name={FLAG_ICON[kind]} size={18} className={cx("mt-0.5 flex-none", kind === "risk" ? "text-warn" : "text-ink-2")} />
            <div className="min-w-0">
              <p className="type-strong">{t(`flags.rules.${flag.id}.title`)}</p>
              <p className="type-caption text-ink-2">{t(`flags.rules.${flag.id}.why`, vars)}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** A flat section with a head. */
export function Section({ id, title, action, children, className }: { id: string; title: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx("adm-section", className)} aria-labelledby={id}>
      <div className="adm-section__head">
        <h2 id={id} className="adm-h2">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** Label/value pairs (a definition list), two columns from 600px. */
export function Facts({ rows, className }: { rows: { label: ReactNode; value: ReactNode; hidden?: boolean }[]; className?: string }) {
  return (
    <dl className={cx("cus-facts", className)}>
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

export type ActionFailure = { ok: false; intent?: string | null; code: string; message?: string; fields?: Record<string, string> };
export type ActionSuccess = { ok: true; intent: string; replayed?: boolean; message?: string; [key: string]: unknown };
export type ActionResult = ActionFailure | ActionSuccess;

/**
 * A block that prints ink on paper whatever the screen's theme: while the browser prints, the block carries
 * data-theme="light", so a dark screen does not print light text on white paper (the finance module's rule).
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

/** The sentence for an audit action ("customers.customer.vip" → "VIP label changed"); an unknown action stays as written. */
export function activityLabel(t: (key: string) => string, action: string): string {
  const key = `activity.${action.replace(/\./g, "_")}`;
  const label = t(key);
  return label === key ? action : label;
}

/** The words for a consent's source ("checkout", "account", "admin"…); an unknown source stays as written. */
export function sourceLabel(t: (key: string) => string, source: string | null): string {
  if (!source) return "—";
  const key = `consentSource.${source}`;
  const label = t(key);
  return label === key ? source : label;
}

/** A unique key per form (idempotency, double-submit safe). */
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A fetcher for one intent: its failure sentence and field errors, and a toast + `onDone` when it succeeded. The toast
 * says "saved before; nothing repeated" for a replay.
 */
export function useIntent(intent: string, doneKey: string | ((result: ActionSuccess) => string), onDone?: (result: ActionSuccess) => void) {
  const fetcher = useFetcher<ActionResult>();
  const t = useCustomersT();
  const result = fetcher.data;
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok && result.intent === intent) {
      toast.success(t(result.replayed ? "done.replayed" : typeof doneKey === "function" ? doneKey(result) : doneKey));
      onDone?.(result);
    }
  }, [fetcher.state, result, intent, onDone, t, doneKey]);
  const failure = result && !result.ok && (result.intent === intent || result.intent === null || result.intent === undefined) ? result : null;
  return { fetcher, pending: fetcher.state !== "idle", failure, message: failure ? (failure.message ?? t(`errors.${failure.code}`)) : null, fields: failure?.fields ?? {} };
}
