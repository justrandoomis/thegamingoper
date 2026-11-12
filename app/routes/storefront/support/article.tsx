/**
 * /support/article/:slug — one approved public guide (services/support/kb.server getArticle; anything else is a 404 in
 * the shell's own panel). Design System v2: the support sub-pages' four-segment navigation (§6.13), then a 720px reading
 * column — breadcrumbs (from 768), what the guide is and for
 * which device, the h1, its summary, when it was updated and whether a store technician reviewed it — rendered with
 * <Blocks> (safety callouts included); a guide that is not translated yet is shown in Arabic and says so. Seeded guides
 * say they are demo content.
 *
 * Beside it (under it on phones): what to do when it did not help — the assistant for this device (the view's one
 * primary) or a repair request, never "open it yourself" — and other guides for the same device or platform.
 */
import { useId } from "react";
import { data, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/article";
import { productShareImage, parsePhotoKey } from "~/art";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getArticle, listRelatedArticles } from "~/server/services/support/kb.server";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { BidiLabel } from "~/ui/BidiText";
import { Blocks } from "~/ui/Blocks";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { DemoNote } from "~/ui/DemoNote";
import { Key } from "~/ui/Key";
import { isPlatform } from "~/ui/PlatformLed";
import { GuideList, PlatformName, SupportNav, UpdatedOn } from "./components/parts";
import "./support.css";

export const handle = { nav: "rise" } satisfies MotionHandle;

export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const article = await getArticle(db, ctx.locale, params.slug);
  if (!article) throw data({ error: "not_found" }, { status: 404 });
  const related = await listRelatedArticles(db, ctx.locale, article, 4);
  return { article, related, i18n: messagesFor(ctx.locale, "support") };
}

export const meta: Route.MetaFunction = (args) => {
  const article = args.loaderData?.article;
  const photo = article?.artKey ? parsePhotoKey(article.artKey) : undefined;
  const image = photo ? productShareImage(photo.slug)?.src : undefined;
  return shellMeta(args, { title: article?.title, description: article?.summary, type: "article", image });
};

export default function Article({ loaderData }: Route.ComponentProps) {
  const { article, related } = loaderData;
  const t = useT("support");
  const ui = useT("ui");
  const layout = useRouteLoaderData(LAYOUT_ROUTE_ID) as { shell?: ShellData } | undefined;
  const nextId = useId();
  const relatedId = useId();
  const platformName = article.platform ? (isPlatform(article.platform.slug) ? ui(`platform.${article.platform.slug}`) : article.platform.name) : null;
  const assistantHref = article.device ? `/support/assistant?device=${article.device.slug}` : article.platform ? `/support/assistant?platform=${article.platform.slug}` : "/support/assistant";
  const repairHref = article.device ? `/support/repair?device=${article.device.slug}` : "/support/repair";
  const crumbs = [
    { label: t("article.breadcrumb"), href: "/support" },
    ...(article.device ? [{ label: article.device.name, href: `/support?device=${article.device.slug}#device-help` }] : platformName ? [{ label: platformName }] : []),
    { label: article.title },
  ];

  return (
    <div className="page sup sup-article">
      <div className="sup-article__main">
        {/* the support sub-pages' shared navigation (§6.13): on phones (no breadcrumbs) the way back to the other guides */}
        {/* a guide is part of the guides, not the support centre page itself */}
        <SupportNav current="help" section />
        <article className="sup-article__text">
          <Breadcrumbs items={crumbs} jsonLd={layout?.shell?.publicOrigin ? { origin: layout.shell.publicOrigin } : undefined} />
          <header className="grid gap-3">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 type-xs text-ink-2">
              <span className="type-xs-strong text-ink">{t(`kind.${article.kind}`)}</span>
              <span aria-hidden="true">·</span>
              {article.device ? (
                <BidiLabel>{t("article.forDevice", { device: article.device.name })}</BidiLabel>
              ) : article.platform ? (
                <PlatformName slug={article.platform.slug} name={article.platform.name} />
              ) : null}
            </p>
            <h1 className="type-h1 text-ink">
              <BidiLabel>{article.title}</BidiLabel>
            </h1>
            {article.summary ? <p className="type-lead text-ink-2">{article.summary}</p> : null}
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <UpdatedOn at={article.updatedAt} />
              {!article.reviewed ? <span className="type-xs text-ink-2">· {t("article.notReviewed")}</span> : null}
            </p>
          </header>
          {article.fallback ? (
            <p className="sup-note">
              <Icon name="translate" size={20} />
              <span>{t("article.fallback")}</span>
            </p>
          ) : null}
          {article.isDemo ? <DemoNote variant="line">{t("help.demo")}</DemoNote> : null}
          <div lang={article.fallback ? "ar" : undefined} dir={article.fallback ? "rtl" : undefined} className="sup-article__body">
            <Blocks blocks={article.blocks} headingLevel={2} />
          </div>
        </article>
      </div>

      <aside className="sup-article__aside">
        <section aria-labelledby={nextId} className="sup-card">
          <h2 id={nextId} className="type-h3 text-ink">
            {t("article.next.title")}
          </h2>
          <p className="type-sm text-ink-2">{t("article.next.text")}</p>
          <div className="flex flex-wrap gap-2">
            <Key as={LocaleLink} to={assistantHref} variant="primary" size="sm" icon="lifebuoy">
              {t("article.next.assistant")}
            </Key>
            <Key as={LocaleLink} to={repairHref} size="sm" icon="wrench">
              {t("article.next.repair")}
            </Key>
          </div>
        </section>
        {related.length > 0 ? (
          <section aria-labelledby={relatedId} className="grid gap-3">
            <h2 id={relatedId} className="type-h3 text-ink">
              {t("article.related")}
            </h2>
            <GuideList articles={related} headingLevel={3} />
          </section>
        ) : null}
      </aside>
    </div>
  );
}
