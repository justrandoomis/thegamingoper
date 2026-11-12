/**
 * Pieces every page of the pricing module (admin 03) shares: the page head with the module's own navigation, money
 * and percent cells (integer IQD, figure first, "—" with a reason when a number cannot be computed — never a fake
 * zero), margin states, and URL helpers for list filters (state lives in the URL, DataTable sorts are links).
 */
import type { ReactNode } from "react";
import { Link, useLocation, useRouteLoaderData } from "react-router";

import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree } from "~/i18n/translate";
import { CURRENCIES } from "~/lib/money";
import type { Locale } from "~/lib/locales";
import { Status, type StatusTone } from "~/ui/Tag";
import { Tabs } from "~/ui/Tabs";
import type { PricingPages } from "~/server/services/admin/pricing/overview.server";
import { DROP_APPROVAL_BPS, parseDecimal } from "~/server/services/admin/pricing/rules";
import { adminMeta, ADMIN_LAYOUT_ID } from "../shell/meta";

/**
 * A whole-dinar amount as typed in a form ("735,000", "٧٣٥٬٠٠٠", "۱۳۱۰") — the server's own parser, so the preview and
 * the button agree with what will be saved. Null when it is not a whole non-negative number (never a guess: "1310.5"
 * is refused, not read as 13105).
 */
export const typedIqd = (text: string): number | null => parseDecimal(text, 0);

export const PRICING_LAYOUT_ID = "routes/admin/pricing/layout";

export type PricingLayoutData = { pages: PricingPages; decidable: number; usedDecidable: number; dropLimitBps: number };

type MetaArgs = { matches: readonly ({ id: string; loaderData?: unknown } | undefined)[] };

/** <title> for a pricing page: "<page> · التسعير · لوحة إدارة طمطم" (keeps the shell's noindex). */
export function pricingMeta(args: MetaArgs, key: string, vars?: Record<string, string | number>) {
  const layout = args.matches.find((match) => match?.id === PRICING_LAYOUT_ID)?.loaderData as { i18n?: Record<string, MessageTree> } | undefined;
  const shell = args.matches.find((match) => match?.id === ADMIN_LAYOUT_ID)?.loaderData as { shell?: { locale?: Locale } } | undefined;
  const locale: Locale = shell?.shell?.locale ?? "ar";
  const page = translate(layout?.i18n?.["admin-pricing"], locale, key, vars);
  return adminMeta(args, (t) => (page ? `${page} · ${t("modules.pricing")}` : t("modules.pricing")));
}

/** "before → after" in the reading direction: ← in Arabic (and Sorani), → in English. */
export function useArrow(): string {
  return useLocale() === "en" ? "→" : "←";
}

export function usePricingT() {
  return useT("admin-pricing");
}

export function usePricingLayout(): PricingLayoutData | null {
  return (useRouteLoaderData(PRICING_LAYOUT_ID) as PricingLayoutData | undefined) ?? null;
}

/**
 * The variables of the words that name the cut limit (`reason.drop_over_limit`, `special.usedLead`: "{pct}%"): the
 * setting in force, which the layout sends (DROP_APPROVAL_BPS, its default, until it arrives).
 */
export function useDropLimit(): { pct: string } {
  const f = useFormat();
  return { pct: f.number((usePricingLayout()?.dropLimitBps ?? DROP_APPROVAL_BPS) / 100) };
}

const NAV: { key: keyof PricingPages | "overview"; href: string }[] = [
  { key: "overview", href: "/admin/pricing" },
  { key: "skus", href: "/admin/pricing/skus" },
  { key: "changes", href: "/admin/pricing/changes" },
  { key: "landed", href: "/admin/pricing/landed" },
  { key: "lists", href: "/admin/pricing/lists" },
  { key: "simulate", href: "/admin/pricing/simulate" },
  { key: "special", href: "/admin/pricing/special" },
  { key: "fx", href: "/admin/pricing/fx" },
];

/** The module's pages as link tabs (only those this employee may open). */
export function PricingNav() {
  const t = usePricingT();
  const layout = usePricingLayout();
  const { pathname } = useLocation();
  if (!layout) return null;
  const items = NAV.filter((item) => item.key === "overview" || layout.pages[item.key]).map((item) => ({
    value: item.href,
    href: item.href,
    label: t(`nav.${item.key}`),
    count: item.key === "changes" && layout.decidable > 0 ? layout.decidable : item.key === "special" && layout.usedDecidable > 0 ? layout.usedDecidable : undefined,
  }));
  const current = [...items].sort((a, b) => b.href.length - a.href.length).find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`))?.value ?? "/admin/pricing";
  return <Tabs aria-label={t("nav.label")} items={items} value={current} className="mb-6" />;
}

/** h1 first (the shell's <main> is the landmark), then one sentence, then the module's navigation. */
export function PageHead({ title, lead, eyebrow, actions }: { title: ReactNode; lead?: ReactNode; eyebrow?: ReactNode; actions?: ReactNode }) {
  return (
    <>
      <header className="adm-page-head">
        {eyebrow ? <p className="adm-eyebrow">{eyebrow}</p> : null}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="adm-title">{title}</h1>
          {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
        {lead ? <p className="max-w-[70ch] type-body text-ink-2">{lead}</p> : null}
      </header>
      <PricingNav />
    </>
  );
}

/** An IQD amount (figure first, tabular, isolated); a negative one with a minus sign in red ink. Null → "—". */
export function Iqd({ value, strike = false, className }: { value: number | null | undefined; strike?: boolean; className?: string }) {
  const f = useFormat();
  if (value === null || value === undefined) return <span className={className}>—</span>;
  const negative = value < 0;
  // Like <Price>: only the figure is isolated, so it reads first in every direction ("749,000 د.ع").
  return (
    <span className={`nums whitespace-nowrap ${strike ? "text-ink-2 line-through" : ""} ${negative ? "text-red-ink" : ""} ${className ?? ""}`}>
      <bdi>{negative ? `−${f.number(-value)}` : f.number(value)}</bdi> {CURRENCIES.IQD.symbol[f.locale]}
    </span>
  );
}

/** Basis points as a percent ("12.5%"). Null → "—". */
export function Pct({ bps, signed = false, className }: { bps: number | null | undefined; signed?: boolean; className?: string }) {
  const f = useFormat();
  if (bps === null || bps === undefined) return <span className={className}>—</span>;
  const text = f.percent(bps / 10_000);
  return (
    <bdi dir="ltr" className={`nums ${className ?? ""}`}>
      {signed && bps > 0 ? `+${text}` : text}
    </bdi>
  );
}

export function pctText(f: ReturnType<typeof useFormat>, bps: number | null | undefined, signed = false): string {
  if (bps === null || bps === undefined) return "—";
  const text = f.percent(bps / 10_000);
  return signed && bps > 0 ? `+${text}` : text;
}

export function iqdText(f: ReturnType<typeof useFormat>, value: number | null | undefined, signed = false): string {
  if (value === null || value === undefined) return "—";
  const text = f.iqd(Math.abs(value));
  return value < 0 ? `−${text}` : signed && value > 0 ? `+${text}` : text;
}

export const MARGIN_TONE: Record<string, StatusTone> = { ok: "ok", below_target: "warn", below_min: "bad", below_cost: "bad", no_cost: "neutral", loss: "bad" };

/** The margin state in words with a dot (never colour alone). */
export function MarginStatus({ state, bps }: { state: string; bps?: number | null }) {
  const t = usePricingT();
  return (
    <Status tone={MARGIN_TONE[state] ?? "neutral"}>
      {bps !== undefined && bps !== null && state !== "no_cost" ? (
        <>
          <Pct bps={bps} /> · {t(`margin.state.${state}`)}
        </>
      ) : (
        t(`margin.state.${state}`)
      )}
    </Status>
  );
}

/** The current query with some parameters changed (null removes one); resets the page unless it is the change. */
export function withSearch(search: string, changes: Record<string, string | number | null>): string {
  const params = new URLSearchParams(search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null || value === "") params.delete(key);
    else params.set(key, String(value));
  }
  if (!("page" in changes)) params.delete("page");
  const text = params.toString();
  return text ? `?${text}` : "?";
}

/** A link inside a dense row. */
export function RowLink({ to, children }: { to: string; children: ReactNode }) {
  return (
    <Link to={to} className="adm-link" prefetch="intent">
      {children}
    </Link>
  );
}

/** "Who and when" in one line. */
export function ByLine({ name, at }: { name: string | null | undefined; at: number | null | undefined }) {
  const f = useFormat();
  return (
    <span className="type-caption text-ink-2">
      {name ? <bdi>{name}</bdi> : null}
      {name && at ? " · " : null}
      {at ? <bdi className="nums">{f.dateTime(at)}</bdi> : null}
    </span>
  );
}

/** The error of an action result, as one sentence (the field errors go beside their fields). */
export type ActionFailureData = { ok: false; intent?: string | null; code: string; message?: string; fields?: Record<string, string> };
export const failureOf = (data: unknown): ActionFailureData | null => (data && typeof data === "object" && (data as { ok?: boolean }).ok === false ? (data as ActionFailureData) : null);
