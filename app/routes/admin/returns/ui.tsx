/**
 * Small building blocks shared by the screens of module 12 (returns). Admin rules (DESIGN.md §10): data has no
 * material, status is words with a dot, numbers are tabular and isolated (<bdi>), money is integer IQD with the figure
 * first, a late step says so in words (never colour alone).
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { REPAIR_TONE, RMA_TONE, WARRANTY_TONE, type FraudRuleId, type FraudSignal, type PhoneView, type RepairStatusKey, type RmaStatus, type WarrantyState } from "~/server/services/admin/returns/types";
import { cx } from "~/ui/cx";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { RETURNS_LAYOUT_ID } from "./meta";

export const NS = "admin-returns";

/** `t()` for the module's strings (sent by the returns layout's loader, with the shared "errors" namespace). */
export function useReturnsT(): TFunction {
  const layout = useRouteLoaderData(RETURNS_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? translate(shared, locale, key, vars) : undefined) ?? key;
  }, [layout, locale, fallback]);
}

/** An IQD amount, figure first ("749,000 د.ع"), isolated so it never reorders inside Arabic. */
export function Money({ iqd, className }: { iqd: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (typeof iqd !== "number" || !Number.isSafeInteger(iqd)) return <span className={className}>—</span>;
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", className)}>
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

/** A reference (RMA-…, TT-…, RP-…, a serial): left to right inside any text. */
export function Ref({ value, className }: { value: string; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums", className)}>
      {value}
    </bdi>
  );
}

export function PhoneText({ phone }: { phone: PhoneView | null }) {
  const t = useReturnsT();
  if (!phone) return <span>—</span>;
  return (
    <bdi dir="ltr" className="nums" title={phone.full ? undefined : t("phoneMasked")}>
      {phone.display}
    </bdi>
  );
}

export function RmaStatusBadge({ status }: { status: RmaStatus }) {
  const t = useReturnsT();
  return <Status tone={RMA_TONE[status]}>{t(`status.${status}`)}</Status>;
}

export function RepairStatusBadge({ status }: { status: RepairStatusKey }) {
  const t = useReturnsT();
  return <Status tone={REPAIR_TONE[status]}>{t(`repairStatus.${status}`)}</Status>;
}

export function WarrantyBadge({ state }: { state: WarrantyState }) {
  const t = useReturnsT();
  return <Status tone={WARRANTY_TONE[state]}>{t(`warrantyState.${state}`)}</Status>;
}

export function DemoNote({ show }: { show: boolean }) {
  const t = useReturnsT();
  if (!show) return null;
  return <span className="ret-tag">{t("demo")}</span>;
}

/** "by <date>" or "late since <date>" — words and an icon, never colour alone. */
export function Due({ dueAt, late, dueKey = "list.dueBy", lateKey = "list.lateSince" }: { dueAt: number | null; late: boolean; dueKey?: string; lateKey?: string }) {
  const t = useReturnsT();
  const f = useFormat();
  if (!dueAt) return <span className="text-ink-2">—</span>;
  return late ? (
    <span className="inline-flex items-center gap-1 text-red-ink">
      <Icon name="clock" size={14} />
      {t(lateKey, { date: f.dateTime(dueAt) })}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-ink-2">
      <Icon name="hourglass" size={14} />
      {t(dueKey, { date: f.dateTime(dueAt) })}
    </span>
  );
}

/** Outlined tags for the fraud signals of a row (words, an icon). */
export function FlagTags({ flags, max = 2 }: { flags: readonly FraudRuleId[]; max?: number }) {
  const t = useReturnsT();
  if (flags.length === 0) return null;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {flags.slice(0, max).map((flag) => (
        <span key={flag} className="ret-tag">
          <Icon name="warning" size={13} className="text-warn" />
          {t(`fraud.rules.${flag}.title`)}
        </span>
      ))}
      {flags.length > max ? <span className="ret-tag">+{flags.length - max}</span> : null}
    </span>
  );
}

/** Each signal with the sentence that explains it (the reviewer sees why, never a score). */
export function FlagExplanations({ signals }: { signals: readonly FraudSignal[] }) {
  const t = useReturnsT();
  const f = useFormat();
  if (signals.length === 0) return <p className="type-body text-ink-2">{t("fraud.none")}</p>;
  return (
    <ul className="grid gap-2">
      {signals.map((signal) => {
        const vars: Record<string, string | number> = { ...signal.vars };
        for (const key of ["amount", "threshold"]) if (typeof vars[key] === "number") vars[key] = f.iqd(vars[key] as number);
        return (
          <li key={signal.id} className="flex items-start gap-2">
            <Icon name="warning" size={18} className="mt-0.5 flex-none text-warn" />
            <div>
              <p className="type-strong">{t(`fraud.rules.${signal.id}.title`)}</p>
              <p className="type-caption text-ink-2">{t(`fraud.rules.${signal.id}.why`, vars)}</p>
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
    <dl className={cx("ret-facts", className)}>
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

export type ActionFailure = { ok: false; intent?: string | null; code: string; message?: string; fields?: Record<string, string> };
export type ActionSuccess = { ok: true; intent: string; replayed?: boolean; message?: string; [key: string]: unknown };
export type ActionResult = ActionFailure | ActionSuccess;

/** A unique key per form (idempotency on money and stock actions, double-submit safe). */
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A fetcher for one intent: its failure sentence and field errors, and a toast + `onDone` when it succeeded. The toast
 * says "saved before; nothing repeated" for a replay.
 */
export function useIntent(intent: string, doneKey: string | ((result: ActionSuccess) => string), onDone?: () => void) {
  const fetcher = useFetcher<ActionResult>();
  const t = useReturnsT();
  const result = fetcher.data;
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok && result.intent === intent) {
      toast.success(t(result.replayed ? "done.replayed" : typeof doneKey === "function" ? doneKey(result) : doneKey));
      onDone?.();
    }
  }, [fetcher.state, result, intent, onDone, t, doneKey]);
  const failure = result && !result.ok && (result.intent === intent || result.intent === null || result.intent === undefined) ? result : null;
  return { fetcher, pending: fetcher.state !== "idle", failure, message: failure ? (failure.message ?? t(`errors.${failure.code}`)) : null, fields: failure?.fields ?? {} };
}
