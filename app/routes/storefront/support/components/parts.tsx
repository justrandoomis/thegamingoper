/**
 * Small pieces shared by the /support pages: the section tabs, guide rows, device tiles, the safety panel, the copy
 * key and the demo line. Flat by default (DESIGN.md §0 law 5): rows on hairlines, niches for pictures, keys only for
 * actions.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useDir, useFormat, useT } from "~/i18n/react";
import { MotionLink } from "~/motion";
import type { ArticleKind, ArticleSummary } from "~/server/services/support/types";
import { cx } from "~/ui/cx";
import { IconKey } from "~/ui/IconKey";
import { Niche } from "~/ui/Niche";
import { HrefLink } from "~/ui/Pagination";
import { isPlatform, PlatformGlyph, PlatformLabel } from "~/ui/PlatformLed";
import { Render } from "~/ui/Stage";
import { Tabs } from "~/ui/Tabs";
import { VisuallyHidden } from "~/ui/VisuallyHidden";

export type SupportSection = "help" | "assistant" | "repair" | "status";

/** Arabic-script letters (Arabic and Sorani), built from code points so the source stays ASCII. */
const ARABIC_SCRIPT = new RegExp(`[${String.fromCharCode(0x0600)}-${String.fromCharCode(0x06ff)}]`);

/**
 * A product or device name, isolated from the text around it. A Latin-only name ("PlayStation 5 Pro") reads left to
 * right; a name that mixes in Arabic script ("PlayStation 5 (الطراز الأصلي 2020)") takes the page's direction, so its
 * Arabic words are in reading order.
 */
export function Name({ children, className }: { children: string; className?: string }) {
  const dir = useDir();
  return ARABIC_SCRIPT.test(children) ? (
    <bdi dir={dir} className={className}>
      {children}
    </bdi>
  ) : (
    <bdi className={className}>{children}</bdi>
  );
}

/** The four sibling pages of /support as link tabs (the route handles give the sideways push). */
export function SupportTabs({ current, className }: { current: SupportSection; className?: string }) {
  const t = useT("support");
  return (
    <Tabs
      aria-label={t("nav.label")}
      value={current}
      className={className}
      items={[
        { value: "help", label: t("nav.helpCenter"), href: "/support" },
        { value: "assistant", label: t("nav.assistant"), href: "/support/assistant" },
        { value: "repair", label: t("nav.repair"), href: "/support/repair" },
        { value: "status", label: t("nav.status"), href: "/support/repair/status" },
      ]}
    />
  );
}

const KIND_ICON: Record<ArticleKind, IconName> = { setup: "toolbox", troubleshooting: "wrench", guide: "book-open", faq: "question", policy: "file-text" };

/** The platform name as the design system writes it (Latin brand names stay Latin), else the catalogue's. */
export function PlatformName({ slug, name }: { slug: string; name: string }) {
  if (isPlatform(slug)) return <PlatformLabel platform={slug} />;
  return <bdi>{name}</bdi>;
}

/** "Safe fixes · For every Xbox device" — what the guide is and why it is listed. */
function GuideMeta({ article, showScope }: { article: ArticleSummary; showScope: boolean }) {
  const t = useT("support");
  const ui = useT("ui");
  const platformName = article.platform ? (isPlatform(article.platform.slug) ? ui(`platform.${article.platform.slug}`) : article.platform.name) : "";
  let scope: ReactNode = null;
  let isName = false;
  if (showScope) {
    if (article.scope === "related" && article.device) scope = t("scope.related", { device: article.device.name });
    else if (article.scope === "platform" && article.platform) scope = t("scope.platform", { platform: platformName });
    else if (article.scope === "device") scope = t("scope.device");
  } else if (article.device) {
    scope = article.device.name;
    isName = true;
  } else if (article.platform) {
    scope = t("article.forPlatform", { platform: platformName });
  }
  return (
    <span className="type-caption text-ink-2">
      {t(`kind.${article.kind}`)}
      {scope ? (
        <>
          {" · "}
          {isName && typeof scope === "string" ? <Name>{scope}</Name> : scope}
        </>
      ) : null}
    </span>
  );
}

/** One guide: a row link on a hairline (icon, kind and scope, title, one line of summary). */
export function GuideRow({ article, showScope = false, headingLevel }: { article: ArticleSummary; showScope?: boolean; headingLevel?: 3 | 4 }) {
  const Title = headingLevel ? (`h${headingLevel}` as const) : "span";
  return (
    <li className="border-b border-line last:border-b-0">
      <MotionLink nav="rise" to={`/support/article/${article.slug}`} prefetch="intent" className="group flex min-h-11 items-start gap-3 py-3">
        <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-full bg-niche text-ink" aria-hidden="true">
          <Icon name={KIND_ICON[article.kind] ?? "book-open"} size={20} />
        </span>
        <span className="grid min-w-0 flex-1 gap-0.5">
          <GuideMeta article={article} showScope={showScope} />
          <Title className="type-strong text-ink group-hover:underline">{article.title}</Title>
          {article.summary ? <span className="type-caption text-ink-2 line-clamp-2">{article.summary}</span> : null}
        </span>
        <Icon name="arrow-right" size={18} className="mt-3 shrink-0 text-ink-2" />
      </MotionLink>
    </li>
  );
}

export function GuideList({ articles, showScope, headingLevel, className }: { articles: readonly ArticleSummary[]; showScope?: boolean; headingLevel?: 3 | 4; className?: string }) {
  return (
    <ul role="list" className={cx("grid", className)}>
      {articles.map((article) => (
        <GuideRow key={`${article.id}:${article.scope}`} article={article} showScope={showScope} headingLevel={headingLevel} />
      ))}
    </ul>
  );
}

/** A device's official photo in a flat 1:1 niche (category-card style, DESIGN.md §9.4), or its platform pictogram. */
export function DeviceArt({ artKey, platform, sizes, priority = false }: { artKey: string | null; platform: string; sizes: string; priority?: boolean }) {
  return (
    <Niche ratio="1/1" tagZone={false}>
      {artKey ? <Render name={artKey} alt="" sizes={sizes} priority={priority} /> : isPlatform(platform) ? <PlatformGlyph platform={platform} size={48} className="text-ink-3" /> : null}
    </Niche>
  );
}

/** A device as a link tile: niche + name under it; the chosen one carries aria-current and an ink ring. */
export function DeviceTile({ name, artKey, platform, href, current = false, sizes = "(min-width: 1200px) 160px, (min-width: 768px) 22vw, 30vw" }: { name: string; artKey: string | null; platform: string; href: string; current?: boolean; sizes?: string }) {
  return (
    <HrefLink to={href} aria-current={current ? "true" : undefined} data-press="soft" className="group grid w-full min-w-0 content-start gap-2 rounded-niche outline-offset-4">
      <span className={cx("block rounded-niche", current && "outline-2 outline-ink outline-offset-2 [outline-style:solid]")}>
        <DeviceArt artKey={artKey} platform={platform} sizes={sizes} />
      </span>
      <span className="flex items-start gap-1 type-strong text-ink">
        {current ? <Icon name="check-circle-fill" size={18} className="mt-0.5 shrink-0" /> : null}
        <span className="min-w-0 text-start">
          <Name>{name}</Name>
        </span>
      </span>
    </HrefLink>
  );
}

/** A flat warning panel (DESIGN.md §9.22): warn icon and words, never dismissible. */
export function SafetyNote({ title, children, tone = "warn", className }: { title?: ReactNode; children: ReactNode; tone?: "warn" | "danger"; className?: string }) {
  const ui = useT("ui-overlays");
  const toneClass = tone === "danger" ? "text-red-ink" : "text-warn";
  return (
    <aside className={cx("panel flex gap-3 p-4", className)}>
      <Icon name="warning" size={22} title={ui(tone === "danger" ? "blocks.danger" : "blocks.warning")} className={cx("mt-0.5 shrink-0", toneClass)} />
      <div className="grid min-w-0 gap-1">
        {title ? <p className={cx("type-strong", toneClass)}>{title}</p> : null}
        <div className="type-body text-ink">{children}</div>
      </div>
    </aside>
  );
}

/** Copies a reference; shows a check and "نُسخ" for 2 s and says so to screen readers. */
export function CopyKey({ text, what }: { text: string; what: string }) {
  const t = useT("support");
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };
  return (
    <span className="inline-flex items-center gap-1">
      <IconKey icon={copied ? "check" : "copy"} size="sm" variant="quiet" label={copied ? t("copy.done") : t("copy.label", { what })} onClick={copy} />
      <span role="status" className="type-caption text-ink-2">
        {copied ? t("copy.done") : <VisuallyHidden>{""}</VisuallyHidden>}
      </span>
    </span>
  );
}

/** "Updated 10 Nov 2026" in the shopper's language and numerals. */
export function UpdatedOn({ at }: { at: number }) {
  const t = useT("support");
  const f = useFormat();
  return <span className="type-caption text-ink-2">{t("article.updated", { date: f.date(at, "long") })}</span>;
}
