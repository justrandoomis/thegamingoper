/**
 * /pages/:slug — a landing page staff wrote and approved in the content module (admin 17.01; the CMS's
 * getLandingPage), Design System v2 §6.15: breadcrumbs, the page's h1, its description as the lead, «آخر تحديث …» and
 * the text as the store's own blocks (<Blocks>: never HTML) in the 720px reading column. No red key: a reading view.
 *
 * Served only while it is published (or scheduled and due), inside its window, not demo, with Arabic text: the
 * visitor's language when the page has it, else Arabic — said so, with lang/dir on the text (the description falls back
 * on its own: its lang/dir from its letters, content-model textLangOf). Anything else is the
 * shell's 404, after a redirect staff may have set for the path (./redirect.server). `noindex` pages say so to search
 * engines; the others are in the sitemap (content.server getSitemapEntries).
 */
import { data } from "react-router";

import type { Route } from "./+types/landing";
import { Icon } from "~/art/Icon";
import { useLocale, useT } from "~/i18n/react";
import { LOCALES } from "~/lib/locales";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getLandingPage } from "~/server/services/admin/cms/pages.server";
import { contentMessages, isLandingSlug } from "~/server/services/content.server";
import { Blocks } from "~/ui/Blocks";
import { ContentHeader } from "./components/ContentHeader";
import { textLangOf } from "./content-model";
import { PolicyStatus } from "./components/PolicyStatus";
import { redirectIfMoved } from "./redirect.server";
import "./content.css";

export async function loader({ params, context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const page = isLandingSlug(params.slug) ? await getLandingPage(db, ctx.locale, params.slug, ctx.now) : null;
  if (!page) {
    await redirectIfMoved(db, url, ctx);
    throw data({ error: "not_found" }, { status: 404 });
  }
  return { page, i18n: contentMessages(ctx.locale) };
}

export const meta: Route.MetaFunction = (args) =>
  shellMeta(args, {
    title: args.loaderData?.page.title,
    description: args.loaderData?.page.description ?? undefined,
    type: "article",
    noindex: args.loaderData?.page.noindex,
  });

export default function LandingPage({ loaderData }: Route.ComponentProps) {
  const { page } = loaderData;
  const t = useT("content");
  const locale = useLocale();
  const fallback = page.textLocale !== locale;
  const textLang = fallback ? { lang: LOCALES[page.textLocale].bcp47, dir: LOCALES[page.textLocale].dir } : {};
  // the description has its own fallback (the page's language, else Arabic, else English): its letters say which
  const leadLocale = page.description ? textLangOf(page.description, locale) : null;
  const lead =
    page.description && leadLocale ? (
      <span lang={LOCALES[leadLocale].bcp47} dir={LOCALES[leadLocale].dir}>
        {page.description}
      </span>
    ) : (
      (page.description ?? undefined)
    );
  return (
    <div className="page cpage">
      <article className="ccol grid min-w-0 content-start gap-8 md:gap-10" data-landing={page.slug}>
        <ContentHeader crumbs={[{ label: t("common.home"), href: "/" }, { label: page.title }]} title={<span {...textLang}>{page.title}</span>} lead={lead}>
          <PolicyStatus approved updatedAt={page.updatedAt} />
        </ContentHeader>
        {fallback ? (
          <p className="cnote">
            <Icon name="translate" size={20} />
            <span>{t("common.textFallback")}</span>
          </p>
        ) : null}
        <div {...textLang}>
          <Blocks blocks={page.blocks} />
        </div>
      </article>
    </div>
  );
}
