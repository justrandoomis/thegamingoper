/**
 * Small building blocks shared by the screens of module 14 (support). Admin rules (DESIGN.md §10): data has no
 * material, status is words with a dot, numbers and references are tabular and isolated (<bdi>), a late target says so
 * in words and with an icon (never colour alone), raised clay only for what needs a person's decision.
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { useFetcher, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { ARTICLE_TONE, PRIORITY_TONE, REPAIR_TONE, SLA_CLOCK_TONE, TICKET_TONE, isRepairStatus, type ContentStatus, type PhoneView, type SlaClock, type TicketChannel, type TicketPriority, type TicketStatus } from "~/server/services/admin/support/types";
import { cx } from "~/ui/cx";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { SUPPORT_LAYOUT_ID } from "./meta";

export const NS = "admin-support";

/** First-strong isolate … pop directional isolate, built from code points (no literal bidi controls in the source). */
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);
const ISOLATES = new RegExp(`[${FSI}${PDI}]`, "g");

/**
 * Every text value put into a sentence is bidi-isolated: an Arabic name with brackets inside an English sentence (or a
 * Latin reference inside an Arabic one) keeps its own order instead of being reordered with the words around it.
 */
function isolated(vars?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!vars) return vars;
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(vars)) out[key] = typeof value === "string" && value !== "" && !value.startsWith(FSI) ? `${FSI}${value}${PDI}` : value;
  return out;
}

/**
 * The items of a list put into a sentence, each one isolated, joined with the language's separator (`t("listSep")`): the
 * list then runs in the sentence's direction (first name first, in Arabic from the right) whatever script each item is in.
 */
export function listOf(items: readonly string[], separator: string): string {
  return items.map((item) => `${FSI}${item}${PDI}`).join(separator);
}

/** A sentence for a form field's starting value: without the isolates (the server removes them from what is typed). */
export const plainText = (text: string) => text.replace(ISOLATES, "");

/** `t()` for the module's strings (sent by the support layout's loader, with the shared "errors" namespace). */
export function useSupportT(): TFunction {
  const layout = useRouteLoaderData(SUPPORT_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return (key: string, vars?: Record<string, string | number>) => fallback(key, isolated(vars));
    return (key: string, vars?: Record<string, string | number>) => {
      const values = isolated(vars);
      return translate(mine, locale, key, values) ?? (key.startsWith("errors.") ? translate(shared, locale, key, values) : undefined) ?? key;
    };
  }, [layout, locale, fallback]);
}

export function Num({ value, className }: { value: number; className?: string }) {
  const f = useFormat();
  return <bdi className={cx("nums", className)}>{f.number(value)}</bdi>;
}

/** An IQD amount, figure first ("45,000 د.ع"), isolated; "—" when there is none. */
export function Money({ iqd, className }: { iqd: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (typeof iqd !== "number" || !Number.isSafeInteger(iqd)) return <span className={className}>—</span>;
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", className)}>
      {f.iqd(iqd)}
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

/** A reference (SP-…, RP-…, TT-…, RMA-…): left to right inside any text. */
export function Ref({ value, className }: { value: string; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums", className)}>
      {value}
    </bdi>
  );
}

export function PhoneText({ phone, call = false }: { phone: PhoneView | null; call?: boolean }) {
  const t = useSupportT();
  if (!phone) return <span>—</span>;
  const text = (
    <bdi dir="ltr" className="nums" title={phone.full ? undefined : t("phoneMasked")}>
      {phone.display}
    </bdi>
  );
  return call && phone.full && phone.e164 ? (
    <a href={`tel:${phone.e164}`} className="adm-link">
      {text}
    </a>
  ) : (
    text
  );
}

export function TicketStatusBadge({ status }: { status: TicketStatus }) {
  const t = useSupportT();
  return <Status tone={TICKET_TONE[status] ?? "neutral"}>{t(`ticketStatus.${status}`)}</Status>;
}

export function RepairStatusBadge({ status }: { status: string }) {
  const t = useSupportT();
  if (!isRepairStatus(status)) return <Status tone="neutral">{status}</Status>;
  return <Status tone={REPAIR_TONE[status]}>{t(`repairStatus.${status}`)}</Status>;
}

export function ArticleStatusBadge({ status }: { status: ContentStatus }) {
  const t = useSupportT();
  return <Status tone={ARTICLE_TONE[status]}>{t(`articleStatus.${status}`)}</Status>;
}

/** Status of an inbox row: a ticket's or a repair's words. */
export function RowStatus({ kind, status }: { kind: "ticket" | "repair"; status: string }) {
  return kind === "repair" ? <RepairStatusBadge status={status} /> : <TicketStatusBadge status={status as TicketStatus} />;
}

export function PriorityTag({ priority, quiet = false }: { priority: TicketPriority; quiet?: boolean }) {
  const t = useSupportT();
  if (quiet && (priority === "normal" || priority === "low")) return null;
  const tone = PRIORITY_TONE[priority];
  return (
    <span className="sup-tag">
      {tone === "bad" || tone === "warn" ? <Icon name="flag" size={13} className={tone === "bad" ? "text-red-ink" : "text-warn"} /> : null}
      {t(`priority.${priority}`)}
    </span>
  );
}

const CHANNEL_ICON: Record<TicketChannel, IconName> = {
  web: "desktop",
  whatsapp: "whatsapp-logo",
  phone: "phone",
  email: "envelope-simple",
  social: "share-network",
  store: "storefront",
  assistant: "robot",
};

export function ChannelLabel({ channel, kind = "ticket" }: { channel: TicketChannel; kind?: "ticket" | "repair" }) {
  const t = useSupportT();
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon name={kind === "repair" ? "wrench" : CHANNEL_ICON[channel]} size={14} className="text-ink-2" />
      {t(`channel.${channel}`)}
    </span>
  );
}

export function DemoTag({ show }: { show: boolean }) {
  const t = useSupportT();
  if (!show) return null;
  return <span className="sup-tag">{t("demo")}</span>;
}

/** "45 min", "3 h 10 min", "2 d 4 h" — or "—" for nothing measured. */
export function Duration({ minutes, className }: { minutes: number | null | undefined; className?: string }) {
  const t = useSupportT();
  const f = useFormat();
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return <span className={className}>—</span>;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = Math.round(minutes % 60);
  const parts: string[] = [];
  if (days) parts.push(t("duration.days", { count: days, n: f.number(days) }));
  if (hours) parts.push(t("duration.hours", { count: hours, n: f.number(hours) }));
  if ((mins || parts.length === 0) && !days) parts.push(t("duration.minutes", { count: mins, n: f.number(mins) }));
  const text = parts.reduce((a, b) => t("duration.join", { a, b }));
  return <span className={cx("nums whitespace-nowrap", className)}>{text}</span>;
}

/** A due time in words with an icon: "first reply by …" / "late since …" (never colour alone). */
export function Due({ at, late, target }: { at: number; late: boolean; target: "first_response" | "resolution" | "repair" }) {
  const t = useSupportT();
  const f = useFormat();
  return late ? (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-red-ink">
      <Icon name="clock" size={14} />
      {t(`due.late.${target}`, { date: f.dateTime(at) })}
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 whitespace-nowrap text-ink-2">
      <Icon name="hourglass" size={14} />
      {t(`due.by.${target}`, { date: f.dateTime(at) })}
    </span>
  );
}

/** One SLA target of a ticket: its due time and where it stands, in words. */
export function SlaLine({ label, dueAt, doneAt, clock }: { label: string; dueAt: number | null; doneAt: number | null; clock: SlaClock }) {
  const t = useSupportT();
  const f = useFormat();
  const icon: IconName = clock === "met" ? "check-circle" : clock === "late" || clock === "breached" ? "clock" : clock === "running" ? "hourglass" : "minus";
  return (
    <div className="grid gap-0.5">
      <span className="type-caption text-ink-2">{label}</span>
      <span className={cx("inline-flex items-center gap-1 type-body", SLA_CLOCK_TONE[clock] === "bad" && "text-red-ink")}>
        <Icon name={icon} size={15} />
        {t(`sla.clock.${clock}`, { due: dueAt ? f.dateTime(dueAt) : "", done: doneAt ? f.dateTime(doneAt) : "" })}
      </span>
    </div>
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
export function Facts({ rows, className, single = false }: { rows: { label: ReactNode; value: ReactNode; hidden?: boolean }[]; className?: string; single?: boolean }) {
  return (
    <dl className={cx("sup-facts", single && "sup-facts--single", className)}>
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

/** An honest boundary in a sentence: what is not connected and what staff do instead. */
export function Boundary({ children, icon = "plugs-connected" }: { children: ReactNode; icon?: IconName }) {
  return (
    <p className="sup-boundary type-caption">
      <Icon name={icon} size={16} className="mt-0.5 flex-none text-ink-2" />
      <span>{children}</span>
    </p>
  );
}

export type ActionFailure = { ok: false; intent?: string | null; code: string; message?: string; fields?: Record<string, string> };
export type ActionSuccess = { ok: true; intent: string; replayed?: boolean; message?: string; [key: string]: unknown };
export type ActionResult = ActionFailure | ActionSuccess;

/** A unique key per form (double-submit safe). */
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What a success toast says: a message key, or a key with the numbers it needs. */
export type DoneMessage = string | { key: string; vars?: Record<string, string | number> };

/**
 * A fetcher for one intent: its failure sentence and field errors, and a toast + `onDone` when it succeeded. The toast
 * says "recorded before; nothing repeated" for a replay.
 */
export function useIntent(intent: string, doneKey: string | ((result: ActionSuccess) => DoneMessage) | null, onDone?: (result: ActionSuccess) => void) {
  const fetcher = useFetcher<ActionResult>();
  const t = useSupportT();
  const result = fetcher.data;
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (result.ok && result.intent === intent) {
      if (doneKey) {
        const done: DoneMessage = result.replayed ? "done.replayed" : typeof doneKey === "function" ? doneKey(result) : doneKey;
        toast.success(typeof done === "string" ? t(done) : t(done.key, done.vars));
      }
      onDone?.(result);
    }
  }, [fetcher.state, result, intent, onDone, t, doneKey]);
  const failure = result && !result.ok && (result.intent === intent || result.intent === null || result.intent === undefined) ? result : null;
  return { fetcher, pending: fetcher.state !== "idle", failure, message: failure ? (failure.message ?? t(`errors.${failure.code}`)) : null, fields: failure?.fields ?? {} };
}
