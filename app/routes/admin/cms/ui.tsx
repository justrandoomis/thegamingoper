/**
 * Building blocks of the screens of admin module 17 (content). Admin rules (DESIGN.md §10): data has no material,
 * status is words with a dot, numbers and paths are isolated (<bdi>), Iraq time everywhere, a missing value is "—".
 * The preview frames draw the storefront's own components inside two frames the width of a phone and of a desktop
 * window (17.06): each frame is an empty same-origin document that receives this page's style sheets, so the
 * storefront's breakpoints apply to the frame's width, not the admin window's.
 */
import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Link, useFetcher, useRouteLoaderData } from "react-router";

import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { translate, type MessageTree, type TFunction } from "~/i18n/translate";
import type { Locale } from "~/lib/locales";
import { Chip } from "~/ui/Chip";
import { cx } from "~/ui/cx";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog, type ImpactRow, type ReasonOptions } from "~/ui/Dialog";
import { TextArea, TextField } from "~/ui/Field";
import { Pagination } from "~/ui/Pagination";
import { Status, type StatusTone } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { CATEGORY_PLACEMENT_PREFIX, type LiveState } from "~/server/services/admin/cms/rules";

export const NS = "admin-cms";
export const CMS_LAYOUT_ID = "routes/admin/cms/layout";

/** Interpolated text keeps its own direction inside a sentence of the other script (FSI … PDI). */
function isolate(vars?: Record<string, string | number>): Record<string, string | number> | undefined {
  if (!vars) return vars;
  const out: Record<string, string | number> = {};
  for (const [name, value] of Object.entries(vars)) out[name] = typeof value === "string" && value !== "" && name !== "count" ? `⁨${value}⁩` : value;
  return out;
}

const TContext = createContext<TFunction | null>(null);
export const CmsTProvider = TContext.Provider;

/** `t()` for the module's strings (sent by the layout's loader with the shared "errors" namespace). */
export function useCmsLayoutT(): TFunction {
  const layout = useRouteLoaderData(CMS_LAYOUT_ID) as { i18n?: Record<string, MessageTree> } | undefined;
  const locale = useLocale();
  const fallback = useT(NS);
  return useMemo(() => {
    const mine = layout?.i18n?.[NS];
    const shared = layout?.i18n?.errors;
    if (!mine) return fallback;
    return (key: string, vars?: Record<string, string | number>) => {
      const safe = isolate(vars);
      return translate(mine, locale, key, safe) ?? (key.startsWith("errors.") ? translate(shared, locale, key, safe) : undefined) ?? key;
    };
  }, [layout, locale, fallback]);
}

export function useCmsT(): TFunction {
  const fromContext = useContext(TContext);
  const own = useCmsLayoutT();
  return fromContext ?? own;
}

// ───────────────────────────────────────────────────────────────── page structure

export function PageHead({ eyebrow, title, lead, actions }: { eyebrow?: ReactNode; title: ReactNode; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="adm-page-head">
      {eyebrow ? <p className="adm-eyebrow">{eyebrow}</p> : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="adm-title min-w-0">{title}</h1>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
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

export function Note({ icon = "info", tone = "info", children, className }: { icon?: IconName; tone?: "info" | "warn" | "bad" | "ok"; children: ReactNode; className?: string }) {
  return (
    <div role="note" className={cx("adm-notice", tone === "warn" && "adm-notice--warn", tone === "bad" && "adm-notice--bad", tone === "ok" && "adm-notice--ok", className)}>
      <Icon name={icon} size={18} className={tone === "info" ? "text-info" : undefined} />
      <div className="grid min-w-0 gap-1 text-ink">{children}</div>
    </div>
  );
}

/** A flat figure card; a link when `to` is given. */
export function Figure({ label, value, hint, to }: { label: ReactNode; value: ReactNode; hint?: ReactNode; to?: string }) {
  const body = (
    <>
      <p className="type-caption text-ink-2">{label}</p>
      <p className="type-kpi nums text-ink">
        <bdi dir="ltr">{value}</bdi>
      </p>
      {hint ? <p className="type-caption text-ink-2">{hint}</p> : null}
    </>
  );
  return to ? (
    <Link to={to} className="adm-card content-start" prefetch="intent">
      {body}
    </Link>
  ) : (
    <div className="adm-card content-start">{body}</div>
  );
}

/** A raised card: something that needs a person's decision (DESIGN.md §10). */
export function DecisionCard({ icon, title, text, to, action }: { icon: IconName; title: ReactNode; text: ReactNode; to: string; action: string }) {
  return (
    <li className="adm-card adm-card--act">
      <div className="flex items-start gap-3">
        <Icon name={icon} size={22} className="mt-1 shrink-0 text-ink-2" />
        <div className="grid min-w-0 gap-1">
          <p className="type-strong text-ink">{title}</p>
          <p className="type-caption text-ink-2">{text}</p>
          <Link to={to} className="adm-link type-label" prefetch="intent">
            {action}
          </Link>
        </div>
      </div>
    </li>
  );
}

export function Pair({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="type-caption text-ink-2">{label}</span>
      <span className="min-w-0 type-data text-end text-ink">{children}</span>
    </div>
  );
}

// ───────────────────────────────────────────────────────────────── values

export function When({ at, kind = "dateTime" }: { at: number | null | undefined; kind?: "dateTime" | "date" }) {
  const f = useFormat();
  if (at === null || at === undefined) return <span>—</span>;
  return (
    <time dateTime={new Date(at).toISOString()} className="nums whitespace-nowrap">
      {kind === "date" ? f.date(at) : f.dateTime(at)}
    </time>
  );
}

export function Num({ value, className }: { value: number | null | undefined; className?: string }) {
  const f = useFormat();
  if (value === null || value === undefined) return <span className={className}>—</span>;
  return <bdi className={cx("nums", className)}>{f.number(value)}</bdi>;
}

/** A storefront path, a slug, a search spelling, a key: left to right when Latin, isolated. */
export function Code({ children, className, ltr = true }: { children: ReactNode; className?: string; ltr?: boolean }) {
  return (
    <bdi dir={ltr ? "ltr" : undefined} className={cx("nums break-all", className)}>
      {children}
    </bdi>
  );
}

const STATE_TONE: Record<LiveState, StatusTone> = { live: "ok", upcoming: "info", ended: "neutral", draft: "warn", archived: "neutral" };

export function StateBadge({ state }: { state: LiveState }) {
  const t = useCmsT();
  return <Status tone={STATE_TONE[state]}>{t(`state.${state}`)}</Status>;
}

export function DemoTag({ show }: { show: boolean }) {
  const t = useCmsT();
  return show ? <span className="cms-tag">{t("common.demo")}</span> : null;
}

/** "Home strip", "Every category", "Category: Controllers", "Cart". */
export function usePlacementLabel() {
  const t = useCmsT();
  return (row: { placement: string; categoryName?: string | null }) =>
    row.placement.startsWith(CATEGORY_PLACEMENT_PREFIX) ? t("placement.category", { name: row.categoryName ?? "—" }) : t(`placement.${row.placement}`);
}

const LINK_TONE: Record<string, StatusTone> = { ok: "ok", missing: "bad", not_live: "bad", unchecked: "neutral", external: "info", pending_route: "warn" };

export function LinkState({ state }: { state: string }) {
  const t = useCmsT();
  return <Status tone={LINK_TONE[state] ?? "neutral"}>{t(`link.${state}`)}</Status>;
}

// ───────────────────────────────────────────────────────────────── lists

/** Filter chips that are links (URL state, works without JavaScript). */
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
}) {
  return (
    <div className="grid gap-3">
      <div className="hidden md:block">
        <DataTable caption={caption} columns={columns} rows={rows} rowKey={rowKey} empty={empty} maxHeight={null} selected={selected} onSelectedChange={onSelectedChange} bulkActions={bulkActions} />
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

/** Page links that keep the other URL parameters. */
export function Pager({ page, pageCount, search }: { page: number; pageCount: number; search: string }) {
  const href = (n: number) => {
    const params = new URLSearchParams(search);
    if (n <= 1) params.delete("page");
    else params.set("page", String(n));
    const text = params.toString();
    return text ? `?${text}` : "?";
  };
  return <Pagination page={page} pageCount={pageCount} href={href} />;
}

// ───────────────────────────────────────────────────────────────── forms

type ActionData = { ok: boolean; message?: string; code?: string; fields?: Record<string, string>; intent?: string | null };

/** A failure result's sentence: the translated message, else the first field error, else the code's text. */
export function failureText(t: TFunction, result: ActionData | undefined | null): string | null {
  if (!result || result.ok) return null;
  return result.message ?? Object.values(result.fields ?? {})[0] ?? (result.code ? t(`errors.${result.code}`) : null);
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

/** A toast once a fetcher's request for `intent` succeeded; returns its failure (sentence and fields) otherwise. */
export function useResult(fetcher: { state: string; data?: unknown }, intent: string, done: string | ((data: Record<string, unknown>) => string), onDone?: (data: Record<string, unknown>) => void) {
  const t = useCmsT();
  const handled = useRef<unknown>(undefined);
  const data = fetcher.data as (ActionData & Record<string, unknown>) | undefined;
  useEffect(() => {
    if (!data || fetcher.state !== "idle" || handled.current === data) return;
    handled.current = data;
    if (data.ok && data.intent === intent) {
      toast.success(typeof done === "function" ? done(data) : done);
      onDone?.(data);
    }
  }, [data, fetcher.state, intent, done, onDone]);
  const failure = data && !data.ok && fetcher.state === "idle" && (data.intent === intent || !data.intent) ? data : null;
  return { message: failure ? failureText(t, failure) : null, fields: failure?.fields ?? {}, pending: fetcher.state !== "idle" };
}

/**
 * The confirm-with-reason dialog (blueprint: what changes on the store, and a reason). Posts to the page's action
 * through a fetcher, stays open while the request runs, shows the server's sentence on failure, closes with a toast.
 */
export function ActionDialog({
  open,
  onClose,
  title,
  consequence,
  confirmLabel,
  tone = "neutral",
  impact,
  reason = true,
  fields,
  successMessage,
  children,
  extra,
  action,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  consequence: ReactNode;
  confirmLabel: string;
  tone?: "neutral" | "destructive" | "commit";
  impact?: ReactNode | readonly ImpactRow[];
  reason?: boolean | ReasonOptions;
  fields: Record<string, string>;
  successMessage: string | ((data: Record<string, unknown>) => string);
  children?: ReactNode;
  extra?: () => Record<string, string>;
  action?: string;
}) {
  const t = useCmsT();
  const fetcher = useFetcher<ActionData & Record<string, unknown>>();
  const handled = useRef<unknown>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      toast.success(typeof successMessage === "function" ? successMessage(result) : successMessage);
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
      reason={reason === true ? { label: t("common.reason") } : reason}
      pending={fetcher.state !== "idle"}
      error={failure}
      onConfirm={({ reason: note }) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key, value);
        for (const [key, value] of Object.entries(extra?.() ?? {})) form.set(key, value);
        if (reason) form.set("reason", note);
        fetcher.submit(form, { method: "post", ...(action ? { action } : {}) });
      }}
    >
      {children}
    </ConfirmDialog>
  );
}

const LANGS: readonly { code: Locale; name: string; dir: "rtl" | "ltr" }[] = [
  { code: "ar", name: "العربية", dir: "rtl" },
  { code: "en", name: "English", dir: "ltr" },
  { code: "ckb", name: "کوردی", dir: "rtl" },
];

/** One text in Arabic (the source), English and Sorani: `<name>.ar`, `<name>.en`, `<name>.ckb`. */
export function L10nFields({
  name,
  label,
  values,
  onChange,
  errors,
  required = false,
  multiline = false,
  maxLength,
  readOnly = false,
}: {
  name: string;
  label: string;
  values: Partial<Record<Locale, string>> | null | undefined;
  onChange?: (code: Locale, value: string) => void;
  errors?: Record<string, string>;
  required?: boolean;
  multiline?: boolean;
  maxLength?: number;
  readOnly?: boolean;
}) {
  const t = useCmsT();
  return (
    <fieldset className="cms-l10n">
      <legend className="type-label text-ink">{label}</legend>
      {LANGS.map((lang) => {
        const common = {
          name: `${name}.${lang.code}`,
          label: lang.name,
          dir: lang.dir,
          lang: lang.code,
          maxLength,
          readOnly,
          error: errors?.[`${name}.${lang.code}`] ?? (lang.code === "ar" ? errors?.[name] : undefined),
          required: required && lang.code === "ar",
          optional: lang.code !== "ar" ? true : undefined,
          hint: lang.code === "ckb" ? t("common.sorani") : undefined,
          ...(onChange ? { value: values?.[lang.code] ?? "", onChange: (event: { currentTarget: { value: string } }) => onChange(lang.code, event.currentTarget.value) } : { defaultValue: values?.[lang.code] ?? "" }),
        };
        return multiline ? <TextArea key={lang.code} {...common} rows={2} /> : <TextField key={lang.code} {...common} />;
      })}
    </fieldset>
  );
}

// ───────────────────────────────────────────────────────────────── preview frames (17.06)

export type FrameWidth = "phone" | "desktop";
const WIDTH: Record<FrameWidth, number> = { phone: 390, desktop: 1280 };

/**
 * One frame of a given CSS width, scaled down to fit its column: an empty document of this origin that gets this
 * page's style sheets and the language, direction and theme of the content, then the children through a portal.
 * Links and buttons inside do nothing (a preview never navigates or posts).
 */
export function PreviewFrame({ width, title, lang, dir, children }: { width: FrameWidth; title: string; lang: Locale; dir: "rtl" | "ltr"; children: ReactNode }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);
  const [height, setHeight] = useState(560);
  const [scale, setScale] = useState(1);
  const px = WIDTH[width];

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let resize: ResizeObserver | null = null;
    let mutations: MutationObserver | null = null;
    const setup = () => {
      const doc = frame.contentDocument;
      if (!doc || !doc.body) return;
      if (doc.body.dataset.cmsPreview !== "1") {
        const html = doc.documentElement;
        for (const attribute of Array.from(document.documentElement.attributes)) if (attribute.name !== "lang" && attribute.name !== "dir") html.setAttribute(attribute.name, attribute.value);
        doc.head.replaceChildren();
        const meta = doc.createElement("meta");
        meta.setAttribute("name", "viewport");
        meta.setAttribute("content", `width=${px}`);
        doc.head.appendChild(meta);
        for (const node of Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'))) doc.head.appendChild(node.cloneNode(true));
        const quiet = doc.createElement("style");
        quiet.textContent = "a, button, input, select, textarea, label { pointer-events: none !important; } html, body { margin: 0; min-block-size: 0; }";
        doc.head.appendChild(quiet);
        doc.body.dataset.cmsPreview = "1";
        doc.body.className = "bg-floor text-ink";
      }
      setBody(doc.body);
      // the content's own height (the document is never shorter than the frame, so its scrollHeight could not shrink)
      const measure = () => setHeight(Math.max(200, Math.ceil(Math.max(0, ...Array.from(doc.body.children).map((child) => child.getBoundingClientRect().bottom))) + 8));
      resize?.disconnect();
      mutations?.disconnect();
      const observer = new ResizeObserver(measure);
      resize = observer;
      observer.observe(doc.body);
      for (const child of Array.from(doc.body.children)) observer.observe(child);
      mutations = new MutationObserver(() => {
        for (const child of Array.from(doc.body.children)) observer.observe(child);
        measure();
      });
      mutations.observe(doc.body, { childList: true });
      measure();
    };
    setup();
    frame.addEventListener("load", setup);
    return () => {
      frame.removeEventListener("load", setup);
      resize?.disconnect();
      mutations?.disconnect();
    };
  }, [px]);

  // keep the language and direction of an open frame in step with the chosen content language
  useEffect(() => {
    const html = frameRef.current?.contentDocument?.documentElement;
    if (!html) return;
    html.setAttribute("lang", lang);
    html.setAttribute("dir", dir);
  }, [lang, dir, body]);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const fit = () => setScale(Math.min(1, box.clientWidth / px));
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [px]);

  return (
    <figure className="cms-frame" data-width={width}>
      <figcaption className="type-caption text-ink-2">{title}</figcaption>
      <div ref={boxRef} className="cms-frame__box" style={{ blockSize: `${Math.ceil(height * scale)}px` }}>
        <iframe ref={frameRef} title={title} className="cms-frame__doc" tabIndex={-1} style={{ inlineSize: `${px}px`, blockSize: `${height}px`, transform: `scale(${scale})` }} />
      </div>
      {body ? createPortal(children, body) : null}
    </figure>
  );
}

/** Phone and desktop frames side by side (one under the other on narrow screens), or one of them. */
export function PreviewFrames({ lang, children, show = "both" }: { lang: Locale; children: ReactNode; show?: "both" | FrameWidth }) {
  const t = useCmsT();
  const dir = lang === "en" ? "ltr" : "rtl";
  return (
    <div className="cms-frames" data-show={show}>
      {show !== "desktop" ? (
        <PreviewFrame width="phone" title={t("preview.phone")} lang={lang} dir={dir}>
          {children}
        </PreviewFrame>
      ) : null}
      {show !== "phone" ? (
        <PreviewFrame width="desktop" title={t("preview.desktop")} lang={lang} dir={dir}>
          {children}
        </PreviewFrame>
      ) : null}
    </div>
  );
}

export const CONTENT_LANGS = LANGS;
