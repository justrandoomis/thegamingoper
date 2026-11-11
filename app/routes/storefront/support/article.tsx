/**
 * /support/article/:slug — one approved public guide (services/support/kb.server getArticle; anything else is a 404 in
 * the shell's own panel). Rendered with <Blocks> (app/ui), safety callouts included; a guide that is not translated
 * yet is shown in Arabic and says so. Seeded guides say they are demo content not yet reviewed by a technician.
 *
 * Under the guide: what to do when it did not help (the assistant for this device, a repair request — never "open
 * it yourself") and other guides for the same device or platform.
 */
import { useId } from "react";
import { data, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/article";
import { productShareImage, parsePhotoKey } from "~/art";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getArticle, listRelatedArticles } from "~/server/services/support/kb.server";
import { LAYOUT_ROUTE_ID, shellMeta } from "~/routes/storefront/shell/meta";
import type { ShellData } from "~/routes/storefront/shell/types";
import { Blocks } from "~/ui/Blocks";
import { Breadcrumbs } from "~/ui/Breadcrumbs";
import { DemoNote } from "~/ui/DemoNote";
import { Key } from "~/ui/Key";
import { GuideList, PlatformName, UpdatedOn } from "./components/parts";

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
  const platformName = article.platform ? (["nintendo", "playstation", "xbox", "handheld"].includes(article.platform.slug) ? ui(`platform.${article.platform.slug}`) : article.platform.name) : null;
  const assistantHref = article.device ? `/support/assistant?device=${article.device.slug}` : article.platform ? `/support/assistant?platform=${article.platform.slug}` : "/support/assistant";
  const repairHref = article.device ? `/support/repair?device=${article.device.slug}` : "/support/repair";
  const crumbs = [
    { label: t("article.breadcrumb"), href: "/support" },
    ...(article.device ? [{ label: article.device.name, href: `/support?device=${article.device.slug}` }] : platformName ? [{ label: platformName }] : []),
    { label: article.title },
  ];

  return (
    <div className="page grid gap-section pb-12 pt-4 lg:grid-cols-12 lg:pt-6">
      <article className="grid min-w-0 content-start gap-5 lg:col-span-8">
        <Breadcrumbs items={crumbs} jsonLd={layout?.shell?.publicOrigin ? { origin: layout.shell.publicOrigin } : undefined} />
        <header className="grid gap-2">
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 type-caption text-ink-2">
            <span className="font-semibold text-ink">{t(`kind.${article.kind}`)}</span>
            <span aria-hidden="true">·</span>
            {article.device ? (
              <bdi>{t("article.forDevice", { device: article.device.name })}</bdi>
            ) : article.platform ? (
              <span className="inline-flex items-center gap-1">
                <PlatformName slug={article.platform.slug} name={article.platform.name} />
              </span>
            ) : null}
          </p>
          <h1 className="type-title text-ink">{article.title}</h1>
          {article.summary ? <p className="max-w-[65ch] type-body text-ink-2">{article.summary}</p> : null}
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <UpdatedOn at={article.updatedAt} />
            {!article.reviewed ? <span className="type-caption text-ink-2">· {t("article.notReviewed")}</span> : null}
          </p>
        </header>
        {article.fallback ? <p className="rounded-md bg-niche px-3 py-2 type-caption text-ink-2">{t("article.fallback")}</p> : null}
        {article.isDemo ? <DemoNote>{t("help.demo")}</DemoNote> : null}
        <div lang={article.fallback ? "ar" : undefined} dir={article.fallback ? "rtl" : undefined} className="max-w-[70ch]">
          <Blocks blocks={article.blocks} headingLevel={2} />
        </div>
      </article>

      <aside className="grid content-start gap-section lg:col-span-4 lg:pt-12">
        <section aria-labelledby={nextId} className="grid gap-3 rounded-panel bg-paper p-4 md:p-5 lg:sticky lg:top-[calc(var(--shell-header-h)+var(--s-4))]">
          <h2 id={nextId} className="type-sub text-ink">
            {t("article.next.title")}
          </h2>
          <p className="type-body text-ink-2">{t("article.next.text")}</p>
          <div className="flex flex-wrap gap-2">
            <Key as={LocaleLink} to={assistantHref} variant="ink" size="sm" icon="lifebuoy">
              {t("article.next.assistant")}
            </Key>
            <Key as={LocaleLink} to={repairHref} size="sm" icon="wrench">
              {t("article.next.repair")}
            </Key>
          </div>
        </section>
        {related.length > 0 ? (
          <section aria-labelledby={relatedId} className="grid gap-2">
            <h2 id={relatedId} className="type-sub text-ink">
              {t("article.related")}
            </h2>
            <GuideList articles={related} headingLevel={3} />
          </section>
        ) : null}
      </aside>
    </div>
  );
}
