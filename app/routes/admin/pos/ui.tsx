/**
 * Small building blocks shared by the screens of module 06 (point of sale). Admin rules (DESIGN.md §10): data has no
 * material, status is words with a dot, numbers are tabular and isolated (<bdi>), money is integer IQD with the figure
 * first, a missing figure is "—" with its reason (never a zero).
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { SHIFT_TONE, type ShiftState } from "~/server/services/admin/pos/types";
import { cx } from "~/ui/cx";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { POS_LAYOUT_ID } from "./meta";

export const NS = "admin-pos";

/** `t()` for the module's strings (sent by the POS layout's loader, with the shared "errors" namespace). */
export function usePosT(): TFunction {
  const layout = useRouteLoaderData(POS_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? translate(shared, locale, key, vars) : undefined) ?? key;
  }, [layout, locale, fallback]);
}

/** An IQD amount, figure first ("749,000 د.ع"), isolated so it never reorders inside Arabic. "—" when unknown. */
export function Money({ iqd, className, signed = false }: { iqd: number | null | undefined; className?: string; signed?: boolean }) {
  const f = useFormat();
  if (typeof iqd !== "number" || !Number.isSafeInteger(iqd)) return <span className={className}>—</span>;
  const text = f.iqd(Math.abs(iqd));
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", iqd < 0 && "text-red-ink", className)}>
      {iqd < 0 ? `−${text}` : signed && iqd > 0 ? `+${text}` : text}
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

/** A reference (TT-…, RC-…, a SKU, a serial): left to right inside any text. */
export function Ref({ value, className }: { value: string; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums", className)}>
      {value}
    </bdi>
  );
}

export function ShiftBadge({ state }: { state: ShiftState }) {
  const t = usePosT();
  return <Status tone={SHIFT_TONE[state]}>{t(`state.${state}`)}</Status>;
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
    <dl className={cx("pos-facts", className)}>
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

export function Notice({ tone = "info", icon, children }: { tone?: "info" | "warn" | "ok" | "bad"; icon?: "info" | "warning" | "check-circle" | "wifi-slash" | "lock"; children: ReactNode }) {
  return (
    <div className={cx("adm-notice", tone === "warn" && "adm-notice--warn", tone === "ok" && "adm-notice--ok", tone === "bad" && "adm-notice--bad")} role={tone === "bad" ? "alert" : undefined}>
      <Icon name={icon ?? (tone === "ok" ? "check-circle" : tone === "info" ? "info" : "warning")} size={18} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export type ActionFailure = { ok: false; intent?: string | null; code: string; message?: string; fields?: Record<string, string> };
export type ActionSuccess = { ok: true; intent: string; replayed?: boolean; message?: string; [key: string]: unknown };
export type ActionResult = ActionFailure | ActionSuccess;

/** A unique key per form or per sale (idempotency on money and stock actions, double-submit safe). URL-safe, 32 chars. */
export function newKey(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * A fetcher for one intent: its failure sentence and field errors, and a toast + `onDone` when it succeeded. The toast
 * says "recorded before; nothing repeated" for a replay.
 */
export function useIntent(intent: string, doneKey: string | ((result: ActionSuccess) => string), onDone?: (result: ActionSuccess) => void) {
  const fetcher = useFetcher<ActionResult>();
  const t = usePosT();
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

/** The method of a till payment, in words. */
export function MethodName({ method }: { method: string }) {
  const t = usePosT();
  return <>{t(`method.${method}`)}</>;
}
