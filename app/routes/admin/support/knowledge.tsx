import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/knowledge";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { listArticles, type ArticleRow } from "~/server/services/admin/support/knowledge.server";
import { KNOWLEDGE_VIEWS, parseKnowledgeFilters } from "~/server/services/admin/support/types";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { supportMeta } from "./meta";
import { openSupport } from "./support.server";
import { ArticleStatusBadge, Boundary, DemoTag, useSupportT, When } from "./ui";

/**
 * /admin/support/knowledge — the knowledge base (14.06): the help centre's public guides and the agents' internal
 * articles, by status (drafts, waiting for review, approved, archived) with search in the URL. Agents (support.ticket
 * .read) see the approved ones; writers and reviewers (support.knowledge.manage / .approve) see everything and open
 * the editor. The storefront shows approved public articles only.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openSupport(context, ["support.ticket.read", "support.knowledge.manage", "support.knowledge.approve"]);
  const filters = parseKnowledgeFilters(new URL(request.url).searchParams);
  try {
    return { page: await listArticles(db, actor, filters, locale), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => supportMeta(args, "knowledge.title");

export default function KnowledgePage({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const f = useFormat();
  const navigation = useNavigation();
  const { page, filters } = loaderData;
  const views = page.full ? KNOWLEDGE_VIEWS : (["all", "public", "internal"] as const);
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("knowledge.title")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{t(page.full ? "knowledge.lead" : "knowledge.leadAgent")}</p>
      </header>
      <Boundary icon="shield-check">{t("knowledge.rule")}</Boundary>
      <div className="sup-actions">
        {page.canEdit ? (
          <Key as={Link} to="/admin/support/knowledge/new" variant="ink" icon="plus">
            {t("knowledge.new")}
          </Key>
        ) : null}
      </div>
      <nav aria-label={t("knowledge.viewsLabel")} className="flex flex-wrap gap-2">
        {views.map((view) => {
          const active = filters.view === view;
          return (
            <Key key={view} as={Link} to={`/admin/support/knowledge${view === "all" ? "" : `?view=${view}`}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
              {t(`knowledge.views.${view}`)}
              <span className="ms-1.5">
                <bdi className="nums">{f.number(page.counts[view])}</bdi>
              </span>
            </Key>
          );
        })}
      </nav>
      <Form method="get" action="/admin/support/knowledge" className="flex flex-wrap items-end gap-2">
        {filters.view !== "all" ? <input type="hidden" name="view" value={filters.view} /> : null}
        <TextField name="q" type="search" label={t("knowledge.search")} defaultValue={filters.q} />
        <Key type="submit" icon="magnifying-glass" loading={navigation.state === "loading"}>
          {t("inbox.apply")}
        </Key>
      </Form>
      <p className="type-caption text-ink-2" aria-live="polite">
        {t("knowledge.count", { count: page.rows.length })}
      </p>
      {page.rows.length === 0 ? (
        <EmptyState title={t("knowledge.empty")} text={filters.q || filters.view !== "all" ? t("inbox.emptyFilteredHint") : t("knowledge.emptyHint")} icon="book-open" />
      ) : (
        <ul className="sup-cards md:grid-cols-2">
          {page.rows.map((row) => (
            <li key={row.id}>
              <ArticleCard row={row} />
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ArticleCard({ row }: { row: ArticleRow }) {
  const t = useSupportT();
  return (
    <Link to={`/admin/support/knowledge/${encodeURIComponent(row.id)}`} className="sup-card">
      <span className="sup-card__top">
        <span className="sup-card__title type-strong">{row.title}</span>
        <ArticleStatusBadge status={row.status} />
      </span>
      <span className="inline-flex flex-wrap items-center gap-1">
        <span className="sup-tag">{t(`audience.${row.audience}`)}</span>
        <span className="sup-tag">{t(`articleKind.${row.kind}`)}</span>
        {row.device ?? row.platform ? <span className="sup-tag">{row.device ?? row.platform}</span> : null}
        {row.revisionPending ? <span className="sup-tag">{t("knowledge.revisionPending")}</span> : null}
        <DemoTag show={row.isDemo} />
      </span>
      <span className="type-caption text-ink-2">
        <bdi dir="ltr">{row.slug}</bdi> · <When at={row.updatedAt} />
      </span>
    </Link>
  );
}
