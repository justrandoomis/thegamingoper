/**
 * /policies — the store's policies in one list (the breadcrumbs of every policy lead here): each row has its title,
 * one line about it and, while the owner has not approved it, the word "مسودة". Rows open the policy (fade); between
 * policies the sideways push takes over.
 */
import type { Route } from "./+types/policies";
import { serverT } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, listPolicies } from "~/server/services/content.server";
import { ContentHeader } from "./components/ContentHeader";
import { LinkRows } from "./components/LinkRows";

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const policies = await listPolicies(getDb(), ctx.locale, { now: ctx.now });
  const t = serverT(ctx.locale, "content");
  return { policies, meta: { title: t("index.title"), description: t("index.metaDescription") }, i18n: contentMessages(ctx.locale) };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, args.loaderData?.meta);

export default function PoliciesPage({ loaderData }: Route.ComponentProps) {
  const t = useT("content");
  return (
    <div className="page pb-12 pt-4 md:pt-6">
      <ContentHeader crumbs={[{ label: t("common.home"), href: "/" }, { label: t("index.title") }]} title={t("index.title")} lead={t("index.lead")} />
      <LinkRows
        className="mt-6 max-w-[44rem]"
        rows={loaderData.policies.map((policy) => ({
          to: `/policies/${policy.slug}`,
          icon: policy.icon,
          title: policy.title,
          hint: policy.summary || undefined,
          aside: policy.approved ? t("common.approvedShort") : t("common.draftShort"),
        }))}
      />
    </div>
  );
}
