/**
 * Building blocks of the shipping pages (admin module 11): the module's `t()`, page heads and sections, flat figures
 * and money in tabular type, statuses with words, a dense table from 768px with a card per row below it, URL-state
 * helpers, the confirm-with-reason dialog and the print-in-light hook (DESIGN.md §10: data has no material, status is
 * words with a dot, numbers are tabular and isolated, money is integer IQD with the figure first).
 */
import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react";
import { Link, useFetcher, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useDir, useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import { CURRENCIES } from "~/lib/money";
import { SETTLEMENT_TONE, SHIPMENT_TONE, type CodSettlementStatus, type CodView, type PhoneView, type ShipmentStatus } from "~/server/services/admin/shipping/rules";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog, type ImpactRow, type ReasonOptions } from "~/ui/Dialog";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { SHIPPING_LAYOUT_ID } from "../meta";

export const NS = "admin-shipping";

/** `t()` for the module's strings (sent by the shipping layout with the shared "errors" namespace). */
export function useShipT(): TFunction {
  const layout = useRouteLoaderData(SHIPPING_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => translate(mine, locale, key, vars) ?? (key.startsWith("errors.") ? translate(shared, locale, key, vars) : undefined) ?? key;
  }, [layout, locale, fallback]);
}

export function PageHead({ eyebrow, title, lead, actions }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="adm-page-head">
      {eyebrow ? <p className="adm-eyebrow">{eyebrow}</p> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="adm-title min-w-0">{title}</h1>
        {actions ? <div className="shp-noprint flex flex-wrap items-center gap-2">{actions}</div> : null}
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
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A flat figure card: caption label, the figure, an optional hint. */
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
export function DecisionCard({ icon, title, count, text, to, action }: { icon: IconName; title: ReactNode; count: number; text: ReactNode; to: string; action: string }) {
  const f = useFormat();
  return (
    <li className="adm-card adm-card--act">
      <div className="flex items-start gap-3">
        <Icon name={icon} size={22} className="mt-1 shrink-0 text-ink-2" />
        <div className="grid min-w-0 gap-1">
          <p className="type-strong text-ink">
            {title} · <bdi className="nums">{f.number(count)}</bdi>
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

/**
 * Integer IQD, the figure first in the reading direction (DESIGN.md §11: "749,000 د.ع" reads figure-then-currency in
 * Arabic too), isolated; the sign stays glued to the figure. null shows "—" with the reason (never a made-up zero).
 */
export function Money({ iqd, unknown, className, signed = false }: { iqd: number | null | undefined; unknown?: string; className?: string; signed?: boolean }) {
  const f = useFormat();
  const locale = useLocale();
  if (iqd === null || iqd === undefined || !Number.isFinite(iqd)) {
    return (
      <span className={cx("text-ink-2", className)} title={unknown}>
        —{unknown ? <span className="sr-only"> {unknown}</span> : null}
      </span>
    );
  }
  const sign = iqd < 0 ? "−" : signed && iqd > 0 ? "+" : "";
  return (
    <bdi className={cx("nums whitespace-nowrap", iqd < 0 && "text-red-ink", className)}>
      <bdi dir="ltr">
        {sign}
        {f.number(Math.abs(iqd))}
      </bdi>{" "}
      {CURRENCIES.IQD.symbol[locale]}
    </bdi>
  );
}

export function Num({ value, className }: { value: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (value === null || value === undefined) return <span className={className}>—</span>;
  return <bdi className={cx("nums", className)}>{f.number(value)}</bdi>;
}

export function When({ at, kind = "dateTime" }: { at: number | null | undefined; kind?: "dateTime" | "date" }) {
  const f = useFormat();
  if (at === null || at === undefined) return <span>—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} className="nums whitespace-nowrap">
      {kind === "date" ? f.date(at) : f.dateTime(at)}
    </time>
  );
}

/** A code, a reference, a tracking number: left to right, tabular. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cx("nums whitespace-nowrap", className)}>
      {children}
    </bdi>
  );
}

export function ParcelStatus({ status }: { status: ShipmentStatus }) {
  const t = useShipT();
  return <Status tone={SHIPMENT_TONE[status]}>{t(`status.${status}`)}</Status>;
}

export function SettlementStatus({ status }: { status: CodSettlementStatus }) {
  const t = useShipT();
  return <Status tone={SETTLEMENT_TONE[status]}>{t(`settlementStatus.${status}`)}</Status>;
}

/** "→" in a left-to-right page, "←" in Arabic: a before/after pair reads from the current value to the next. */
export function useArrow(): string {
  return useDir() === "rtl" ? "←" : "→";
}

/**
 * What the courier does about money for a parcel, in words with the amount. With the parcel's status: a delivered
 * parcel's cash that is not recorded yet is with the courier; a parcel back at the store or cancelled collects nothing.
 */
export function CodText({ cod, short = false, status }: { cod: CodView; short?: boolean; status?: ShipmentStatus }) {
  const t = useShipT();
  if (status === "returned" || status === "cancelled") return <span className="text-ink-2">{t("cod.none")}</span>;
  if (status === "delivered" && cod.kind === "collect") {
    return (
      <span>
        <span className="text-ink-2">{t("cod.held")} </span>
        <Money iqd={cod.amountIqd} />
      </span>
    );
  }
  switch (cod.kind) {
    case "collect":
      return (
        <span>
          {short ? null : <span className="text-ink-2">{t("cod.collect")} </span>}
          <Money iqd={cod.amountIqd} />
        </span>
      );
    case "collected":
      return (
        <span>
          <span className="text-ink-2">{t("cod.collected")} </span>
          <Money iqd={cod.amountIqd} />
        </span>
      );
    case "with_first":
      return <span className="text-ink-2">{t("cod.withFirst")}</span>;
    case "prepaid":
      return <span className="text-ink-2">{t("cod.prepaid")}</span>;
    default:
      return <span className="text-red-ink">{t("cod.unpaid")}</span>;
  }
}

/** A phone as this employee may see it; a full number is a call link. */
export function PhoneText({ phone }: { phone: PhoneView | null | undefined }) {
  const t = useShipT();
  if (!phone) return <span className="text-ink-2">—</span>;
  if (phone.full && phone.e164) {
    return (
      <a href={`tel:${phone.e164}`} className="adm-link nums" dir="ltr">
        {phone.display}
      </a>
    );
  }
  return (
    <span>
      <bdi dir="ltr" className="nums">
        {phone.display}
      </bdi>
      {phone.full ? null : <span className="sr-only"> {t("common.phoneMasked")}</span>}
    </span>
  );
}

/** A label/value pair inside a card. */
export function Pair({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="type-caption text-ink-2">{label}</span>
      <span className="type-data text-end text-ink">{children}</span>
    </div>
  );
}

/** A flat note with an icon: rules, boundaries, honest limits. */
export function Note({ icon = "info", tone = "info", children, className }: { icon?: IconName; tone?: "info" | "warn"; children: ReactNode; className?: string }) {
  return (
    <div role="note" className={cx("adm-notice", tone === "warn" && "adm-notice--warn", className)}>
      <Icon name={icon} size={18} className={tone === "info" ? "text-info" : undefined} />
      <div className="grid gap-1 text-ink">{children}</div>
    </div>
  );
}

export function RowLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} prefetch="intent" className="adm-link">
      {children}
    </Link>
  );
}

/** Filter chips that are links (URL state, work without JavaScript). */
export function LinkChips({ label, items }: { label: string; items: { value: string; label: ReactNode; href: string; selected: boolean; count?: number }[] }) {
  const f = useFormat();
  return (
    <nav aria-label={label}>
      <ul role="list" className="flex flex-wrap gap-2">
        {items.map((item) => (
          <li key={item.value}>
            <Chip as={Link} to={item.href} preventScrollReset selected={item.selected}>
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
        <DataTable caption={caption} columns={columns} rows={rows} rowKey={rowKey} rowLabel={rowLabel} empty={empty} selected={selected} onSelectedChange={onSelectedChange} bulkActions={bulkActions} maxHeight={null} />
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
 * What an amount field keeps of what was typed: Arabic-Indic and Persian digits become 0–9, thousands separators
 * ("," "٬" spaces) go, a leading minus stays when allowed — and a decimal mark ("." or the Arabic "٫") STAYS, so a
 * fraction of a dinar is refused by the server ("invalid") instead of being read as a ten times larger amount
 * ("5000.5" used to become 50005).
 */
export function digitsOnly(value: string, allowMinus = false): string {
  const latin = value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  const minus = allowMinus && /^\s*[-−]/.test(latin) ? "-" : "";
  return minus + latin.replace(/٫/g, ".").replace(/[^0-9.]/g, "");
}

/** A typed whole amount: null when empty, NaN when it is not a whole number of dinars (a fraction, a stray mark). */
export function wholeValue(value: string): number | null {
  if (value === "") return null;
  return /^-?\d{1,13}$/.test(value) ? Number(value) : Number.NaN;
}

/** A typed percentage ("1.5", "١٫٥", "1,5") as a plain decimal string ("1.5"): what the cash-fee field keeps. */
export function percentOnly(value: string): string {
  const latin = value.replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660)).replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
  return latin.replace(/[٫,،]/g, ".").replace(/[^0-9.]/g, "");
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

/** A failure result's sentence: the translated message, else the first field error, else the code's text. */
export function failureText(t: TFunction, result: { ok: boolean; message?: string; code?: string; fields?: Record<string, string> } | undefined | null): string | null {
  if (!result || result.ok) return null;
  return result.message ?? Object.values(result.fields ?? {})[0] ?? (result.code ? t(`errors.${result.code}`) : null);
}

/**
 * While the browser prints, the block carries data-theme="light", so a dark screen never prints light text on white
 * paper (the inventory review's finding on printed slips).
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

type ActionData = { ok: boolean; message?: string; code?: string; fields?: Record<string, string>; intent?: string | null };

/**
 * The confirm-with-reason dialog of the module (blueprint uxRules: dangerous and financial actions show their impact
 * and need a reason). Posts to the page's action through a fetcher, stays open while the request runs, shows the
 * server's sentence on failure, closes with a toast on success.
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
  extra,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  consequence: ReactNode;
  confirmLabel: string;
  tone?: "neutral" | "destructive" | "commit";
  impact?: ReactNode | readonly ImpactRow[];
  reason?: boolean | ReasonOptions;
  /** Posted with the reason: intent, ids, expected values. */
  fields: Record<string, string>;
  successMessage: string;
  children?: ReactNode;
  /** More fields read from inputs inside `children` at confirm time (name → value). */
  extra?: () => Record<string, string>;
}) {
  const t = useShipT();
  const fetcher = useFetcher<ActionData>();
  const handled = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      toast.success(result.message ?? successMessage);
      onClose();
    }
  }, [fetcher.data, fetcher.state, onClose, successMessage]);
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
      onConfirm={({ reason: note, code }) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key, value);
        for (const [key, value] of Object.entries(extra?.() ?? {})) form.set(key, value);
        if (reason) form.set("reason", note);
        if (code) form.set("code", code);
        fetcher.submit(form, { method: "post" });
      }}
    >
      {children}
    </ConfirmDialog>
  );
}

/** Server data for a tiny fetcher form: posts the fields, toasts the result, shows the failure next to the key. */
export function useActionToast(fetcher: { data?: ActionData; state: string }, success: string) {
  const t = useShipT();
  const handled = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) toast.success(result.message ?? success);
  }, [fetcher.data, fetcher.state, success]);
  return fetcher.data && !fetcher.data.ok && fetcher.state === "idle" ? failureText(t, fetcher.data) : null;
}
