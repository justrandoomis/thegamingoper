import { Link, useFetcher, useNavigate } from "react-router";
import { useEffect } from "react";

import type { Route } from "./+types/pages";
import { createLandingPage, listPages, type PageListItem } from "~/server/services/admin/cms/pages.server";
import { LANDING_SLUG_MAX, PAGE_TEXT } from "~/server/services/admin/cms/rules";
import { invalid } from "~/server/errors";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { failed, ok, openCms, orRespond, text } from "./cms.server";
import { Code, DemoTag, FormError, Note, PageHead, ResponsiveList, Section, StateBadge, When, useCmsT, useResult } from "./ui";

/**
 * /admin/cms/pages — 17.01 / 17.04: the store's own pages. The six policies with whether the storefront serves an
 * approved text or the code's draft (marked as awaiting the owner); returns and warranty are approved in Settings
 * (module 22); the about and contact texts; landing pages (new ones start as drafts).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCms(context, ["cms.page.manage", "cms.page.publish"]);
  return { list: await orRespond(() => listPages(db, actor, locale, now)) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openCms(context, "cms.page.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "create") throw invalid({ intent: "invalid" });
    return ok(intent, await createLandingPage(req.db, req.actor, { slug: text(form, "slug"), titleAr: text(form, "titleAr") }, req.now));
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "pages.title");

function PageState({ item }: { item: PageListItem }) {
  const t = useCmsT();
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      {item.kind === "policy" ? <Status tone={item.live ? "ok" : "warn"}>{item.live ? t("pages.approved") : t("pages.codeDraft")}</Status> : item.state ? <StateBadge state={item.state} /> : <Status tone="neutral">{t("pages.none")}</Status>}
      {item.hasDraft ? <Status tone="info">{t("pages.hasDraft")}</Status> : null}
      <DemoTag show={item.isDemo} />
    </span>
  );
}

/** About and contact have no title of their own until a text is written: their names. */
function useTitleOf() {
  const t = useCmsT();
  return (item: PageListItem) => (item.status === null && (item.kind === "about" || item.kind === "contact") ? t(`pages.fixedTitle.${item.kind}`) : item.title);
}

function EditLink({ item }: { item: PageListItem }) {
  const t = useCmsT();
  const titleOf = useTitleOf();
  if (item.inSettings)
    return (
      <Link to={`/admin/settings/policies/${item.slug}`} className="adm-link">
        {t("pages.inSettings")}
      </Link>
    );
  return (
    <Link to={`/admin/cms/pages/${item.slug}`} className="adm-link">
      {titleOf(item)}
    </Link>
  );
}

export default function PagesPage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const { list } = loaderData;
  const create = useFetcher<Record<string, unknown>>();
  const navigate = useNavigate();
  const created = useResult(create, "create", t("pages.created"));
  const createdSlug = create.data && (create.data as { ok?: boolean }).ok ? String((create.data as { slug: string }).slug) : null;
  useEffect(() => {
    if (createdSlug && create.state === "idle") navigate(`/admin/cms/pages/${createdSlug}`);
  }, [createdSlug, create.state, navigate]);

  const titleOf = useTitleOf();
  const columns = (showPath: boolean) => [
    { key: "title", header: t("pages.page"), cell: (row: PageListItem) => (row.inSettings ? <span className="grid gap-0.5"><span>{titleOf(row)}</span><EditLink item={row} /></span> : <EditLink item={row} />) },
    { key: "state", header: t("common.state"), cell: (row: PageListItem) => <PageState item={row} /> },
    ...(showPath ? [{ key: "path", header: t("pages.path"), cell: (row: PageListItem) => <Code>{row.storePath}</Code> }] : []),
    { key: "updated", header: t("common.updated"), cell: (row: PageListItem) => <When at={row.updatedAt} /> },
  ];
  const card = (row: PageListItem) => (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="type-strong">{titleOf(row)}</span>
        <PageState item={row} />
      </div>
      <Code className="type-caption">{row.storePath}</Code>
      <EditLink item={row} />
    </>
  );

  return (
    <>
      <PageHead title={t("pages.title")} lead={t("pages.lead")} />

      <Section id="policies" title={t("pages.policies")}>
        <Note>
          <p>{t("pages.policiesNote")}</p>
        </Note>
        <ResponsiveList caption={t("pages.policies")} rows={list.policies} rowKey={(row) => row.slug} columns={columns(true)} card={card} />
      </Section>

      <Section id="fixed" title={t("pages.fixed")}>
        <p className="max-w-[72ch] type-body text-ink-2">{t("pages.fixedLead")}</p>
        <ResponsiveList caption={t("pages.fixed")} rows={list.fixed} rowKey={(row) => row.slug} columns={columns(true)} card={card} />
      </Section>

      <Section id="landing" title={t("pages.landing")}>
        <p className="max-w-[72ch] type-body text-ink-2">{t("pages.landingLead")}</p>
        <ResponsiveList
          caption={t("pages.landing")}
          rows={list.landing}
          rowKey={(row) => row.slug}
          columns={columns(true)}
          card={card}
          empty={<EmptyState icon="file-text" title={t("pages.landingEmpty")} text={t("pages.landingEmptyText")} />}
        />
        {list.can.edit ? (
          <create.Form method="post" className="cms-filters">
            <input type="hidden" name="intent" value="create" />
            <TextField name="slug" label={t("pages.slug")} hint={t("pages.slugHint")} maxLength={LANDING_SLUG_MAX} error={created.fields.slug} ltr required />
            <TextField name="titleAr" label={t("pages.titleAr")} maxLength={PAGE_TEXT.title} error={created.fields.titleAr} required />
            <Key type="submit" size="sm" icon="plus" loading={created.pending}>
              {t("pages.create")}
            </Key>
            <FormError message={created.message && !created.fields.slug && !created.fields.titleAr ? created.message : null} />
          </create.Form>
        ) : null}
      </Section>
    </>
  );
}
