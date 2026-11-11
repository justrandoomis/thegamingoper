/**
 * Small building blocks shared by the screens of module 05 (orders). Admin rules (DESIGN.md §10): data has no material,
 * status is words with a dot, numbers are tabular and isolated (<bdi>), money is integer IQD with the figure first.
 */
import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { Link, useLocation, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { ORDERS_LAYOUT_ID } from "./meta";
import {
  PAYMENT_TONE,
  RISK_THRESHOLDS,
  riskKind,
  STATUS_TONE,
  type AnyPaymentMethod,
  type OrderPaymentStatus,
  type OrderStatus,
  type PhoneView,
  type ReviewStatus,
  type RiskRuleId,
} from "~/server/services/admin/orders/types";
import { cx } from "~/ui/cx";
import { Status } from "~/ui/Tag";

export const NS = "admin-orders";

/**
 * `t()` for the module's strings (the orders layout's loader sends them, with the shared "errors" namespace). An
 * `errors.<code>` key the module does not define comes from "errors" (the commerce core's codes).
 */
export function useOrdersT(): TFunction {
  const layout = useRouteLoaderData(ORDERS_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
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
export function Money({ iqd, className, negative }: { iqd: number; className?: string; negative?: boolean }) {
  const f = useFormat();
  if (!Number.isSafeInteger(iqd)) return <span className={className}>—</span>;
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", negative && "text-red-ink", className)}>
      {negative && iqd > 0 ? "−" : ""}
      {f.iqd(iqd)}
    </bdi>
  );
}

/** A plain number for a table cell whose column head names the unit. */
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

export function Ref({ value, className }: { value: string; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums", className)}>
      {value}
    </bdi>
  );
}

export function PhoneText({ phone }: { phone: PhoneView | null }) {
  const t = useOrdersT();
  if (!phone) return <span>—</span>;
  return (
    <bdi dir="ltr" className="nums" title={phone.full ? undefined : t("phoneMasked")}>
      {phone.display}
    </bdi>
  );
}

export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  const t = useOrdersT();
  return <Status tone={STATUS_TONE[status]}>{t(`status.${status}`)}</Status>;
}

export function PaymentBadge({ status, method }: { status: OrderPaymentStatus; method?: AnyPaymentMethod | null }) {
  const t = useOrdersT();
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2">
      <Status tone={PAYMENT_TONE[status]}>{t(`payment.${status}`)}</Status>
      {method && !(status === "cod_due" && method === "cod") ? <span className="type-caption text-ink-2">{t(`method.${method}`)}</span> : null}
    </span>
  );
}

export function ReviewBadge({ status }: { status: ReviewStatus }) {
  const t = useOrdersT();
  if (status === "none") return null;
  const tone = status === "blocked" ? "bad" : status === "cleared" ? "ok" : "warn";
  return <Status tone={tone}>{t(`reviewStatus.${status}`)}</Status>;
}

/** The variables each rule's sentence uses. */
export function riskVars(id: RiskRuleId, f: ReturnType<typeof useFormat>): Record<string, string | number> {
  const T = RISK_THRESHOLDS;
  switch (id) {
    case "proof_waiting":
      return { hours: T.proofWaitingHours };
    case "cod_unconfirmed":
      return { hours: T.codUnconfirmedHours };
    case "not_shipped":
      return { hours: T.notShippedHours };
    case "not_delivered":
      return { days: T.notDeliveredDays };
    case "high_value_cod":
      return { amount: f.iqd(T.highValueCodIqd) };
    case "phone_cancellations":
      return { count: T.phoneCancellations, days: T.phoneCancellationDays };
    case "phone_open_orders":
      return { count: T.phoneOpenOrders };
    case "bulk_quantity":
      return { count: T.bulkQuantity };
    default:
      return {};
  }
}

/** Outlined tags for a row's review flags (late = clock, suspicious = warning) — words, not colour. */
export function FlagTags({ flags, max = 3 }: { flags: readonly RiskRuleId[]; max?: number }) {
  const t = useOrdersT();
  if (flags.length === 0) return null;
  const shown = flags.slice(0, max);
  return (
    <span className="inline-flex flex-wrap gap-1">
      {shown.map((flag) => (
        <span key={flag} className="ord-flag" data-kind={riskKind(flag)}>
          <Icon name={riskKind(flag) === "late" ? "clock" : "warning"} size={13} />
          {t(`risk.${flag}.title`)}
        </span>
      ))}
      {flags.length > max ? <span className="ord-flag">+{flags.length - max}</span> : null}
    </span>
  );
}

/** The flags with the sentence that explains each one (the reviewer sees why, never just a score). */
export function FlagExplanations({ flags }: { flags: readonly RiskRuleId[] }) {
  const t = useOrdersT();
  const f = useFormat();
  if (flags.length === 0) return <p className="type-body text-ink-2">{t("review.noFlags")}</p>;
  return (
    <ul className="grid gap-2">
      {flags.map((flag) => (
        <li key={flag} className="flex items-start gap-2">
          <Icon name={riskKind(flag) === "late" ? "clock" : "warning"} size={18} className={riskKind(flag) === "late" ? "text-info" : "text-warn"} />
          <div>
            <p className="type-strong">{t(`risk.${flag}.title`)}</p>
            <p className="type-caption text-ink-2">{t(`risk.${flag}.why`, riskVars(flag, f))}</p>
          </div>
        </li>
      ))}
    </ul>
  );
}

type NavItem = { to: string; label: string; icon: IconName; count?: number | null; show: boolean };

/** The module's sections as link tabs (URL state; Back works). Only the sections this employee may open. */
export function OrdersNav({ items }: { items: NavItem[] }) {
  const t = useOrdersT();
  const location = useLocation();
  const listRef = useRef<HTMLUListElement>(null);
  const visible = items.filter((item) => item.show);
  // On phones the row scrolls sideways: bring the current section into view. Only the row moves (scrollBy on the
  // list), never the page, so a restored scroll position stays where it was.
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
    <nav aria-label={t("nav.label")} className="ord-nav">
      <ul ref={listRef} className="ord-nav__list">
        {visible.map((item) => {
          const current = item.to === "/admin/orders" ? location.pathname === "/admin/orders" || location.pathname === "/admin/orders/" : location.pathname.startsWith(item.to);
          return (
            <li key={item.to}>
              <Link to={item.to} className="ord-nav__link" aria-current={current ? "page" : undefined}>
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
    <dl className={cx("ord-facts", className)}>
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

/** What a failed action result carries (see ./actions.server.ts). */
export type ActionFailure = { ok: false; intent?: string | null; code: string; message?: string; fields?: Record<string, string> };
export type ActionSuccess = { ok: true; intent: string; message?: string; [key: string]: unknown };
export type ActionResult = ActionFailure | ActionSuccess;

export function failureOf(data: unknown, intent?: string): ActionFailure | null {
  const result = data as ActionResult | undefined;
  if (!result || result.ok) return null;
  if (intent && result.intent && result.intent !== intent) return null;
  return result;
}

/** A unique key per form submission (idempotency on money and stock actions, double-submit safe). */
export function newKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * "before → after". The arrow follows the reading direction (it points left in Arabic and Sorani: the first value
 * sits on the right), and screen readers hear "from … to …" instead of an arrow's name.
 */
export function Change({ from, to }: { from: ReactNode; to: ReactNode }) {
  const t = useOrdersT();
  return (
    <span className="ord-change">
      <span className="sr-only">{t("change.from")} </span>
      {from}
      <span aria-hidden="true" className="ord-change__arrow">
        →
      </span>
      <span className="sr-only"> {t("change.to")} </span>
      {to}
    </span>
  );
}

export function DemoNote({ show }: { show: boolean }) {
  const t = useOrdersT();
  if (!show) return null;
  return <span className="ord-flag">{t("demo")}</span>;
}
