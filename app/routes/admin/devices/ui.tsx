/**
 * Small building blocks shared by the screens of module 13 (devices, games & trade-in). Admin rules (DESIGN.md §10):
 * data has no material, status is words with a dot, numbers are tabular and isolated (<bdi>), money is integer IQD
 * with the figure first, a missing figure is "—" with the reason beside it, never a zero.
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";

import { Icon } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { CODE_TONE, SERIAL_TONE, TRADE_IN_TONE, USED_TONE, type ChecklistView, type PhoneView, type TradeInStatusKey, type UsedStatusKey } from "~/server/services/admin/devices/types";
import type { DigitalCodeStatus, SerialStatus } from "~/server/db/schema";
import { BidiText } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { Select, TextField } from "~/ui/Field";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { DEVICES_LAYOUT_ID } from "./meta";

export const NS = "admin-devices";

/** `t()` for the module's strings (sent by the devices layout's loader, with the shared "errors" namespace). */
export function useDevicesT(): TFunction {
  const layout = useRouteLoaderData(DEVICES_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
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

/** A reference (TI-…, TT-…, a SKU, a serial): left to right inside any text. */
export function Ref({ value, className }: { value: string; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums", className)}>
      {value}
    </bdi>
  );
}

/** A product name: Latin names and numbers isolated inside Arabic text. */
export function Name({ text, className }: { text: string; className?: string }) {
  return (
    <span className={className}>
      <BidiText text={text} />
    </span>
  );
}

export function PhoneText({ phone }: { phone: PhoneView | null }) {
  const t = useDevicesT();
  if (!phone) return <span>—</span>;
  return (
    <bdi dir="ltr" className="nums" title={phone.full ? undefined : t("phoneMasked")}>
      {phone.display}
    </bdi>
  );
}

export function TradeInBadge({ status, expired = false }: { status: TradeInStatusKey; expired?: boolean }) {
  const t = useDevicesT();
  if (expired) return <Status tone="neutral">{t("offerExpired")}</Status>;
  return <Status tone={TRADE_IN_TONE[status]}>{t(`status.${status}`)}</Status>;
}

export function UsedBadge({ status }: { status: UsedStatusKey }) {
  const t = useDevicesT();
  return <Status tone={USED_TONE[status]}>{t(`usedStatus.${status}`)}</Status>;
}

export function SerialBadge({ status }: { status: SerialStatus }) {
  const t = useDevicesT();
  return <Status tone={SERIAL_TONE[status]}>{t(`serialStatus.${status}`)}</Status>;
}

export function CodeBadge({ status }: { status: DigitalCodeStatus }) {
  const t = useDevicesT();
  return <Status tone={CODE_TONE[status]}>{t(`codeStatus.${status}`)}</Status>;
}

/** The grade as an outlined fact tag with its words ("A — ممتاز"). */
export function GradeTag({ grade }: { grade: string | null | undefined }) {
  const t = useDevicesT();
  if (!grade) return <span className="dev-tag">{t("grade.none")}</span>;
  return (
    <span className="dev-tag">
      <bdi dir="ltr">{grade}</bdi>
      <span aria-hidden="true">·</span>
      {t(`gradeWord.${grade}`)}
    </span>
  );
}

export function DemoNote({ show }: { show: boolean }) {
  const t = useDevicesT();
  if (!show) return null;
  return <span className="dev-tag">{t("demo")}</span>;
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
    <dl className={cx("dev-facts", className)}>
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

/** A yes / no / not checked fact, in words with an icon (never colour alone). */
export function Check({ value, yes, no, unknown }: { value: boolean | null | undefined; yes: string; no: string; unknown: string }) {
  if (value === true)
    return (
      <span className="inline-flex items-center gap-1">
        <Icon name="check-circle" size={16} className="text-ok" />
        {yes}
      </span>
    );
  if (value === false)
    return (
      <span className="inline-flex items-center gap-1 text-red-ink">
        <Icon name="x-circle" size={16} />
        {no}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-ink-2">
      <Icon name="hourglass" size={16} />
      {unknown}
    </span>
  );
}

export type ActionFailure = { ok: false; intent?: string | null; code: string; message?: string; fields?: Record<string, string> };
export type ActionSuccess = { ok: true; intent: string; replayed?: boolean; status?: string; [key: string]: unknown };
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
export function useIntent(intent: string, doneKey: string | ((result: ActionSuccess) => string), onDone?: (result: ActionSuccess) => void) {
  const fetcher = useFetcher<ActionResult>();
  const t = useDevicesT();
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

/** A filled-in checklist, read only: each line with its result in words and an icon; critical lines say so. */
export function ChecklistTable({ checklist }: { checklist: ChecklistView }) {
  const t = useDevicesT();
  const f = useFormat();
  if (checklist.lines.length === 0) return <p className="type-body text-ink-2">{t("checklist.noTemplate")}</p>;
  return (
    <div className="grid gap-2">
      <p className="type-caption text-ink-2">
        {checklist.templateName ? `${checklist.templateName} · ` : ""}
        {checklist.completedAt ? t("checklist.completedAt", { date: f.dateTime(checklist.completedAt) }) : t("checklist.notComplete", { count: checklist.missing.length })}
      </p>
      <ul className="dev-checklist">
        {checklist.lines.map((line) => (
          <li key={line.key} data-result={line.result ?? "none"}>
            <span className="inline-flex items-center gap-2">
              <ResultIcon result={line.result} hasValue={line.value !== null && line.value !== ""} />
              <span>
                {line.label}
                {line.critical ? <span className="dev-tag ms-2">{t("checklist.critical")}</span> : null}
              </span>
            </span>
            <span className="type-caption text-ink-2">
              {line.input === "percent" && typeof line.value === "number" ? (
                <bdi className="nums">{f.number(line.value)} %</bdi>
              ) : line.input === "text" && typeof line.value === "string" ? (
                line.value
              ) : line.result ? (
                t(`result.${line.result}`)
              ) : (
                t("result.none")
              )}
              {line.note ? ` — ${line.note}` : ""}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ResultIcon({ result, hasValue }: { result: string | null; hasValue: boolean }) {
  if (result === "pass") return <Icon name="check-circle" size={16} className="text-ok" />;
  if (result === "fail") return <Icon name="x-circle" size={16} className="text-red-ink" />;
  if (result === "na") return <Icon name="minus" size={16} className="text-ink-2" />;
  return hasValue ? <Icon name="file-text" size={16} className="text-ink-2" /> : <Icon name="hourglass" size={16} className="text-ink-2" />;
}

/**
 * The checklist's fields for a form (works without JavaScript): one row per template item — a pass / fail / not
 * applicable choice, a percent, or a text — plus a note. Field names r.<key>, v.<key>, n.<key>.
 */
export function ChecklistFields({ checklist, errors }: { checklist: ChecklistView; errors: Record<string, string> }) {
  const t = useDevicesT();
  if (checklist.lines.length === 0) return <p className="type-body text-ink-2">{t("checklist.noTemplate")}</p>;
  return (
    <div className="dev-check-form">
      {checklist.lines.map((line) => (
        <fieldset key={line.key} className="dev-check-row">
          <legend className="type-label">
            {line.label}
            {line.required ? <span className="text-ink-2"> *</span> : null}
            {line.critical ? <span className="dev-tag ms-2">{t("checklist.critical")}</span> : null}
          </legend>
          {line.hint ? <p className="type-caption text-ink-2">{line.hint}</p> : null}
          <div className="dev-check-row__inputs">
            {line.input === "pass_fail" ? (
              <Select
                name={`r.${line.key}`}
                label={t("checklist.result")}
                hideLabel
                defaultValue={line.result ?? ""}
                error={errors[`r.${line.key}`]}
                options={[
                  { value: "", label: t("result.none") },
                  { value: "pass", label: t("result.pass") },
                  { value: "fail", label: t("result.fail") },
                  { value: "na", label: t("result.na") },
                ]}
              />
            ) : line.input === "percent" ? (
              <>
                <TextField name={`v.${line.key}`} label={t("checklist.percent")} hideLabel inputMode="numeric" defaultValue={typeof line.value === "number" ? String(line.value) : ""} error={errors[`v.${line.key}`]} end={<span className="type-caption">%</span>} />
                <Select name={`r.${line.key}`} label={t("checklist.measurable")} hideLabel defaultValue={line.result === "na" ? "na" : ""} options={[{ value: "", label: t("checklist.measured") }, { value: "na", label: t("checklist.notMeasurable") }]} />
              </>
            ) : (
              <TextField name={`v.${line.key}`} label={t("checklist.value")} hideLabel defaultValue={typeof line.value === "string" ? line.value : ""} error={errors[`v.${line.key}`]} />
            )}
            <TextField name={`n.${line.key}`} label={t("checklist.note")} hideLabel placeholder={t("checklist.notePlaceholder")} defaultValue={line.note ?? ""} />
          </div>
        </fieldset>
      ))}
    </div>
  );
}
