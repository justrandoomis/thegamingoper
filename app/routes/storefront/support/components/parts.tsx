/**
 * Small pieces shared by the /support pages (Design System v2 §6.13): the four-segment sub-navigation, guide rows,
 * device pictures and tiles, the safety callout, the copy key and the "updated" line. Flat by default: rows between
 * hairlines in a paper card, the product ground for pictures, keys only for actions.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import type { ArticleKind, ArticleSummary } from "~/server/services/support/types";
import { BidiLabel } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { isPlatform, PlatformLabel } from "~/ui/PlatformLed";
import { Segmented } from "~/ui/Segmented";
import { Render } from "~/ui/Stage";

export type SupportSection = "help" | "assistant" | "repair" | "status";

/**
 * A product or device name, isolated from the text around it (the kit's BidiLabel): a Latin-only name reads left to
 * right; a name that mixes in Arabic script ("PlayStation 5 (الطراز الأصلي 2020)") keeps the page's direction.
 */
export function Name({ children, className }: { children: string; className?: string }) {
  return <BidiLabel className={className}>{children}</BidiLabel>;
}

/**
 * The sub-pages' shared navigation (§6.13): four link segments — guides (the support centre), the assistant, book a
 * repair, track a repair. The route handles give the sideways push between them. Segments keep their words: on a
 * narrow phone the track scrolls sideways instead of cutting a label (the kit's link Segmented). `section`: the page
 * belongs to that segment's part of the site but is not the segment's own page (a guide, a message to staff) — the
 * segment then says `aria-current="true"`, not "page".
 */
export function SupportNav({ current, section = false, className }: { current: SupportSection; section?: boolean; className?: string }) {
  const t = useT("support");
  return (
    <Segmented
      aria-label={t("nav.label")}
      value={current}
      current={section ? "true" : "page"}
      className={cx("sup-nav", className)}
      options={[
        { value: "help", label: t("nav.guides"), href: "/support" },
        { value: "assistant", label: t("nav.assistant"), href: "/support/assistant" },
        { value: "repair", label: t("nav.repair"), href: "/support/repair" },
        { value: "status", label: t("nav.status"), href: "/support/repair/status" },
      ]}
    />
  );
}

const KIND_ICON: Record<ArticleKind, IconName> = { setup: "toolbox", troubleshooting: "wrench", guide: "book-open", faq: "question", policy: "file-text" };

/** The platform as the design system writes it: an 8px dot and the name (Latin brand names stay Latin). */
export function PlatformName({ slug, name }: { slug: string; name: string }) {
  if (isPlatform(slug)) return <PlatformLabel platform={slug} />;
  return <BidiLabel>{name}</BidiLabel>;
}

/** "Safe fixes · For every Xbox device" — what the guide is and why it is listed. */
function GuideMeta({ article, showScope }: { article: ArticleSummary; showScope: boolean }) {
  const t = useT("support");
  const ui = useT("ui");
  const platformName = article.platform ? (isPlatform(article.platform.slug) ? ui(`platform.${article.platform.slug}`) : article.platform.name) : "";
  let scope: ReactNode = null;
  if (showScope) {
    if (article.scope === "related" && article.device) scope = <BidiLabel>{t("scope.related", { device: article.device.name })}</BidiLabel>;
    else if (article.scope === "platform" && article.platform) scope = <BidiLabel>{t("scope.platform", { platform: platformName })}</BidiLabel>;
    else if (article.scope === "device") scope = t("scope.device");
  } else if (article.device) {
    scope = <Name>{article.device.name}</Name>;
  } else if (article.platform) {
    scope = <BidiLabel>{t("article.forPlatform", { platform: platformName })}</BidiLabel>;
  }
  return (
    <span className="sup-guide__meta">
      {t(`kind.${article.kind}`)}
      {scope ? <> · {scope}</> : null}
    </span>
  );
}

/** One guide: a row link between hairlines — kind icon, what it is and for whom, the title, one line of summary. */
export function GuideRow({ article, showScope = false, headingLevel }: { article: ArticleSummary; showScope?: boolean; headingLevel?: 3 | 4 }) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "span";
  return (
    <li className="sup-guide">
      <MotionLink nav="rise" to={`/support/article/${article.slug}`} prefetch="intent" className="sup-guide__link" data-press="soft">
        <span className="sup-guide__icon" aria-hidden="true">
          <Icon name={KIND_ICON[article.kind] ?? "book-open"} size={20} />
        </span>
        <span className="sup-guide__body">
          <GuideMeta article={article} showScope={showScope} />
          <Title className="sup-guide__title">
            <BidiLabel>{article.title}</BidiLabel>
          </Title>
          {article.summary ? (
            <span className="sup-guide__summary">
              <BidiLabel>{article.summary}</BidiLabel>
            </span>
          ) : null}
        </span>
        <Icon name="arrow-right" size={20} className="sup-guide__go" />
      </MotionLink>
    </li>
  );
}

/** Guide rows in a paper card (`plain`: no card — inside a bubble or another surface). */
export function GuideList({ articles, showScope, headingLevel, plain = false, className }: { articles: readonly ArticleSummary[]; showScope?: boolean; headingLevel?: 3 | 4; plain?: boolean; className?: string }) {
  return (
    <ul role="list" className={cx("sup-guides", plain && "sup-guides--plain", className)}>
      {articles.map((article) => (
        <GuideRow key={`${article.id}:${article.scope}`} article={article} showScope={showScope} headingLevel={headingLevel} />
      ))}
    </ul>
  );
}

/** The well's fit rule for a device kind (§7.3): handheld PCs are wide objects. */
export const deviceFit = (kind: string | null | undefined) => (kind === "handheld_pc" ? "wide" : undefined);

/** A device's official photo on the product ground (a 1:1 well), or the empty well when there is none. */
export function DeviceArt({ artKey, kind, sizes, small = false, priority = false, className }: { artKey: string | null; kind?: string | null; sizes: string; small?: boolean; priority?: boolean; className?: string }) {
  return (
    <Niche as="span" size={small ? "sm" : "md"} kind={deviceFit(kind)} className={className}>
      {artKey ? <Render name={artKey} alt="" sizes={sizes} priority={priority} /> : null}
    </Niche>
  );
}

/**
 * A device as a link tile: its photo on the product ground and the name under it (14/600, two lines at most). The
 * chosen device carries aria-current, a check before its name and an ink ring around its well.
 */
export function DeviceTile({ name, artKey, kind, href, current = false, sizes = "(min-width: 768px) 170px, 38vw" }: { name: string; artKey: string | null; kind?: string | null; href: string; current?: boolean; sizes?: string }) {
  return (
    <LocaleLink to={href} aria-current={current ? "true" : undefined} data-press="soft" className="sup-dtile group">
      <Niche as="span" kind={deviceFit(kind)} className="sup-dtile__art" aria-hidden="true">
        {artKey ? <Render name={artKey} alt="" sizes={sizes} className="group-hover:scale-103" /> : null}
      </Niche>
      <span className="sup-dtile__name">
        {current ? <Icon name="check-circle-fill" size={16} className="sup-dtile__check" /> : null}
        <Name>{name}</Name>
      </span>
    </LocaleLink>
  );
}

/**
 * A safety note as a callout: a paper panel with a 3px inline-start bar in the tone colour, an icon AND the tone's word
 * (never colour alone), never dismissible. `danger` uses --danger (never brand red).
 */
export function SafetyNote({ title, children, tone = "warn", className }: { title?: ReactNode; children: ReactNode; tone?: "warn" | "danger"; className?: string }) {
  const ui = useT("ui-overlays");
  return (
    <aside className={cx("sup-callout", tone === "danger" ? "sup-callout--danger" : "sup-callout--warn", className)}>
      <Icon name="warning" size={20} title={ui(tone === "danger" ? "blocks.danger" : "blocks.warning")} className="sup-callout__icon" />
      <div className="grid min-w-0 gap-1">
        {title ? <p className="sup-callout__title">{title}</p> : null}
        <div className="type-sm text-ink">{children}</div>
      </div>
    </aside>
  );
}

/**
 * Copying, with an honest result: the Clipboard API first, then a temporary selection (in-app browsers and pages
 * without HTTPS often refuse the API); "copied" for 2 s, or "failed" — never a copy that did not happen.
 */
function useCopy(): { state: "idle" | "copied" | "failed"; copy: (text: string) => Promise<void> } {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );
  const copy = async (text: string) => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = copyBySelection(text);
    setState(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), ok ? 2000 : 4000);
  };
  return { state, copy };
}

function copyBySelection(text: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.insetBlockStart = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}

/** Copies a reference; shows a check and «نُسخ» for 2 s and says so to screen readers. */
export function CopyKey({ text, what }: { text: string; what: string }) {
  const t = useT("support");
  const { state, copy } = useCopy();
  return (
    <span className="inline-flex items-center gap-1">
      <IconKey icon={state === "copied" ? "check" : "copy"} variant="plain" label={state === "copied" ? t("copy.done") : t("copy.label", { what })} onClick={() => void copy(text)} />
      <span role="status" className="type-xs text-ink-2">
        {state === "copied" ? t("copy.done") : state === "failed" ? t("copy.failed") : ""}
      </span>
    </span>
  );
}

/**
 * «انسخ رابط الصفحة»: copies this page's private link (the hand-off receipt, a repair's status) — the way back to a
 * staff reply. Many shoppers open the store in an in-app browser that hides the address bar, so "save this page's
 * link" needs a key. `drop`: query parameters that only mean something once («new=1»).
 */
export function CopyLinkKey({ drop = [] }: { drop?: readonly string[] }) {
  const t = useT("support");
  const { state, copy } = useCopy();
  const link = () => {
    const url = new URL(window.location.href);
    for (const name of drop) url.searchParams.delete(name);
    url.hash = "";
    return url.toString();
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
      <Key size="sm" icon={state === "copied" ? "check" : "link"} onClick={() => void copy(link())}>
        {state === "copied" ? t("copy.done") : t("copy.link")}
      </Key>
      {/* the key itself says «نُسخ»; screen readers hear the whole sentence, and a failure is shown */}
      <span role="status" className={state === "failed" ? "type-xs text-ink-2" : "sr-only"}>
        {state === "copied" ? t("copy.linkDone") : state === "failed" ? t("copy.failed") : ""}
      </span>
    </span>
  );
}

/** «آخر تحديث 10/11/2026» in the shopper's language and numerals (day first). */
export function UpdatedOn({ at }: { at: number }) {
  const t = useT("support");
  const f = useFormat();
  return <span className="type-xs text-ink-2">{t("article.updated", { date: f.date(at, "medium") })}</span>;
}
