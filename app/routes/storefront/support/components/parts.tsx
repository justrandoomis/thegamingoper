/**
 * Small pieces shared by the /support pages (Design v2.1 «Clay & Glass», client note 9 — the before's support pages):
 * the section tabs, guide rows (with the searched words marked), device pictures and tiles, the safety note, the copy
 * keys and the "updated" line. Rows sit in the soft raised card; pictures on the product ground; keys only for actions.
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import { highlightParts } from "~/server/services/support/helpsearch";
import type { ArticleKind, ArticleSummary } from "~/server/services/support/types";
import { BidiLabel, hasRtl, splitBidi } from "~/ui/BidiText";
import { cx } from "~/ui/cx";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Niche } from "~/ui/Niche";
import { Note } from "~/ui/Note";
import { isPlatform, PlatformLabel } from "~/ui/PlatformLed";
import { Render } from "~/ui/Stage";
import { Tabs } from "~/ui/Tabs";
import { VisuallyHidden } from "~/ui/VisuallyHidden";

export type SupportSection = "help" | "assistant" | "repair" | "status";

/**
 * A product or device name, isolated from the text around it (the kit's BidiLabel): a Latin-only name reads left to
 * right; a name that mixes in Arabic script ("PlayStation 5 (الطراز الأصلي 2020)") keeps the page's direction.
 */
export function Name({ children, className }: { children: string; className?: string }) {
  return <BidiLabel className={className}>{children}</BidiLabel>;
}

/**
 * The support pages' shared navigation — the before's underline tabs (client note 9): «مركز المساعدة · مساعد الصيانة ·
 * احجز صيانة · تابع طلب», the kit's link Tabs (one ink underline slides from tab to tab; a row too long for a phone
 * scrolls sideways with the current tab kept in view). The route handles give the sideways push between them.
 * `section`: the page belongs to that tab's part of the site but is not the tab's own page (a guide, a message to
 * staff). The kit's link Tabs say `aria-current="page"` for every chosen tab; "true" for such a page waits for the kit
 * (asked of the design-system owner, round 1 wave B).
 */
export function SupportNav({ current, className }: { current: SupportSection; section?: boolean; className?: string }) {
  const t = useT("support");
  return (
    <Tabs
      aria-label={t("nav.label")}
      value={current}
      className={cx("sup-nav", className)}
      items={[
        { value: "help", label: t("nav.help"), href: "/support" },
        { value: "assistant", label: t("nav.assistant"), href: "/support/assistant" },
        { value: "repair", label: t("nav.repair"), href: "/support/repair" },
        { value: "status", label: t("nav.status"), href: "/support/repair/status" },
      ]}
    />
  );
}

/**
 * A text with the words that matched a search marked (<mark>), isolated like the kit's BidiLabel: a Latin run inside
 * Arabic stays one left-to-right run, and the marks go inside it (cutting the run at a mark would reverse its words).
 * No query: the plain BidiLabel.
 */
export function Highlighted({ text, query, className }: { text: string; query?: string | null; className?: string }) {
  if (!query) return <BidiLabel className={className}>{text}</BidiLabel>;
  const marked = (value: string) => highlightParts(value, query).map((part, index) => (part.hit ? <mark key={index} className="sup-hit">{part.text}</mark> : <Fragment key={index}>{part.text}</Fragment>));
  if (text.trim() !== "" && !hasRtl(text)) {
    return (
      <bdi dir="ltr" className={className}>
        {marked(text)}
      </bdi>
    );
  }
  return (
    <span className={cx("bidi", className)}>
      {splitBidi(text).map((part, index) =>
        part.ltr ? (
          <bdi key={index} dir="ltr">
            {marked(part.text)}
          </bdi>
        ) : (
          <Fragment key={index}>{marked(part.text)}</Fragment>
        ),
      )}
    </span>
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

/** The icon of a guide's kind (a guide row, a suggestion). */
export function guideIcon(kind: ArticleKind): IconName {
  return KIND_ICON[kind] ?? "book-open";
}

/**
 * One guide: a row link — the kind's icon on a clay disc, what it is and for whom, the title, two lines of summary, an
 * arrow that nudges toward the reading end. `highlight`: the searched words, marked in the title and the summary.
 */
export function GuideRow({ article, showScope = false, headingLevel, highlight }: { article: ArticleSummary; showScope?: boolean; headingLevel?: 3 | 4; highlight?: string | null }) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "span";
  return (
    <li className="sup-guide">
      <MotionLink nav="rise" to={`/support/article/${article.slug}`} prefetch="intent" className="sup-guide__link" data-press="soft">
        <span className="clay-disc sup-guide__icon" aria-hidden="true">
          <Icon name={guideIcon(article.kind)} size={20} />
        </span>
        <span className="sup-guide__body">
          <GuideMeta article={article} showScope={showScope} />
          <Title className="sup-guide__title">
            <Highlighted text={article.title} query={highlight} />
          </Title>
          {article.summary ? (
            <span className="sup-guide__summary">
              <Highlighted text={article.summary} query={highlight} />
            </span>
          ) : null}
        </span>
        <Icon name="arrow-right" size={20} className="sup-guide__go" />
      </MotionLink>
    </li>
  );
}

/** Guide rows in the soft raised card (`plain`: no card — inside a bubble or another surface). */
export function GuideList({
  articles,
  showScope,
  headingLevel,
  plain = false,
  highlight,
  className,
}: {
  articles: readonly ArticleSummary[];
  showScope?: boolean;
  headingLevel?: 3 | 4;
  plain?: boolean;
  highlight?: string | null;
  className?: string;
}) {
  return (
    <ul role="list" className={cx("sup-guides", plain && "sup-guides--plain", className)}>
      {articles.map((article) => (
        <GuideRow key={`${article.id}:${article.scope}`} article={article} showScope={showScope} headingLevel={headingLevel} highlight={highlight} />
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
 * A safety note — the kit's calm Note (client notes 5 and 8: the before's way of writing side information): the
 * warning icon in its tinted disc, a short bold title, the words, never dismissible. The tone's word is said to screen
 * readers before the title (never colour alone). `danger` (a stop: smoke, swelling, liquid) tints the disc and the
 * title with --danger — never brand red; `action`: what to do, on its own line; `flat` inside another card (a bubble).
 */
export function SafetyNote({
  title,
  children,
  tone = "warn",
  action,
  flat = false,
  className,
}: {
  title?: ReactNode;
  children: ReactNode;
  tone?: "warn" | "danger";
  action?: ReactNode;
  flat?: boolean;
  className?: string;
}) {
  const ui = useT("ui-overlays");
  const word = ui(tone === "danger" ? "blocks.danger" : "blocks.warning");
  return (
    <Note
      tone="warning"
      icon="warning"
      variant={flat ? "flat" : "card"}
      title={
        <>
          <VisuallyHidden>{word}: </VisuallyHidden>
          {title ?? word}
        </>
      }
      action={action}
      className={cx("sup-safety-note", tone === "danger" && "sup-safety-note--danger", className)}
    >
      {children}
    </Note>
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
