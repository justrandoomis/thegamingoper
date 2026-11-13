/**
 * /policies — the store's policies in one list (the breadcrumbs of every policy lead here), Design System v2 §6.15:
 * the head with ONE status line while any policy is still the first version («نسخة أولى — قد تتغيّر قبل الإطلاق.»,
 * instead of a "draft" tag on every row), then one row per policy (icon, title, one line about it) in a paper card.
 * Only when some are approved and some are not does a first-version row say so at its end. Rows open the policy
 * (fade); between policies the sideways push takes over. Under the list: «لم تجد جوابك؟» → «اكتب لموظف».
 */
import type { Route } from "./+types/policies";
import { serverT } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, listPolicies } from "~/server/services/content.server";
import { ContentHeader } from "./components/ContentHeader";
import { HandoffCard } from "./components/HandoffCard";
import { LinkRows } from "./components/LinkRows";
import { PolicyStatus } from "./components/PolicyStatus";
import "./content.css";

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const policies = await listPolicies(getDb(), ctx.locale, { now: ctx.now });
  const t = serverT(ctx.locale, "content");
  return { policies, meta: { title: t("index.title"), description: t("index.metaDescription") }, i18n: contentMessages(ctx.locale) };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, args.loaderData?.meta);

export default function PoliciesPage({ loaderData }: Route.ComponentProps) {
  const t = useT("content");
  const { policies } = loaderData;
  const drafts = policies.filter((policy) => !policy.approved).length;
  const mixed = drafts > 0 && drafts < policies.length;
  return (
    <div className="page cpage">
      <ContentHeader crumbs={[{ label: t("common.home"), href: "/" }, { label: t("index.title") }]} title={t("index.title")} lead={t("index.lead")}>
        {drafts > 0 ? <PolicyStatus approved={false} updatedAt={null} /> : null}
      </ContentHeader>
      <div className="ccol grid gap-8">
        <LinkRows
          card
          rows={policies.map((policy) => ({
            to: `/policies/${policy.slug}`,
            icon: policy.icon,
            title: policy.title,
            hint: policy.summary || undefined,
            aside: mixed && !policy.approved ? t("common.statusDraftShort") : undefined,
          }))}
        />
        <HandoffCard id="policies-ask" title={t("index.askTitle")} reveal />
      </div>
    </div>
  );
}
