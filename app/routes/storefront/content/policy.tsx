/**
 * /policies/:slug — one store policy (shipping, returns, warranty, payment, privacy, terms, or any policy the owner
 * published in the CMS). The text is an approved CMS page when there is one, else the draft written in code and
 * filled with the live settings (~/server/services/content.server → getPolicy). The page reads the `approved` flag:
 * a draft says "مسودة — بانتظار مراجعة صاحب المتجر" under the title and is kept out of search engines.
 *
 * States: default (draft or approved) · partial (an approved page without this language: shown in Arabic, said so) ·
 * unknown slug → the shell's 404 · a failed read → the shell's error panel (never an empty policy).
 */
import { data } from "react-router";

import type { Route } from "./+types/policy";
import { Icon } from "~/art/Icon";
import { useFormat, useLocale, useT } from "~/i18n/react";
import { LOCALES } from "~/lib/locales";
import type { MotionHandle } from "~/motion";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, getPolicy, listPolicies } from "~/server/services/content.server";
import { Blocks } from "~/ui/Blocks";
import { Status } from "~/ui/Tag";
import { ContentHeader, Section } from "./components/ContentHeader";
import { FactPanel } from "./components/FactPanel";
import { LinkRows, type LinkRow } from "./components/LinkRows";
import { PolicyNav } from "./components/PolicyNav";
import { POLICY_ICONS, isPolicySlug, policyOrder, type PolicySlug, type PolicySummary, type PolicyView } from "./content-model";

/** The six policies are siblings: moving between them pushes sideways in their order (docs/MOTION.md). */
export const handle = { order: ({ params }) => policyOrder(params.slug), group: "policies" } satisfies MotionHandle;

export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [policy, policies] = await Promise.all([
    getPolicy(db, ctx.locale, params.slug, { now: ctx.now, storeMode: ctx.storeMode }),
    listPolicies(db, ctx.locale, { now: ctx.now }),
  ]);
  if (!policy) throw data({ error: "not_found" }, { status: 404 });
  return { policy, policies, i18n: contentMessages(ctx.locale) };
}

export const meta: Route.MetaFunction = (args) =>
  shellMeta(args, {
    title: args.loaderData?.policy.title,
    description: args.loaderData?.policy.summary,
    type: "article",
    noindex: args.loaderData?.policy.noindex,
  });

export default function PolicyPage({ loaderData }: Route.ComponentProps) {
  const { policy, policies } = loaderData;
  const t = useT("content");
  const locale = useLocale();
  const fallback = policy.textLocale !== locale;
  const textLang = fallback ? { lang: LOCALES[policy.textLocale].bcp47, dir: LOCALES[policy.textLocale].dir } : {};
  const related = useRelated(policy.slug, policies);

  return (
    <div className="page grid gap-12 pb-12 pt-4 md:pt-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-14">
      <article className="grid min-w-0 max-w-[44rem] content-start gap-8 lg:col-start-2 lg:row-start-1">
        <ContentHeader
          crumbs={[{ label: t("common.home"), href: "/" }, { label: t("index.title"), href: "/policies" }, { label: policy.title }]}
          title={<span {...textLang}>{policy.title}</span>}
          lead={policy.summary || undefined}
        >
          <PolicyStatus policy={policy} />
        </ContentHeader>
        <FactPanel facts={policy.facts} />
        {fallback ? (
          <p className="flex items-start gap-2 type-caption text-ink-2">
            <Icon name="translate" size={18} className="mt-0.5" />
            <span>{t("common.textFallback")}</span>
          </p>
        ) : null}
        <div {...textLang}>
          <Blocks blocks={policy.blocks} />
        </div>
        {related.length > 0 ? (
          <Section id="policy-related" title={t("common.related")} heading="type-sub">
            <LinkRows rows={related} />
          </Section>
        ) : null}
      </article>
      <PolicyNav
        policies={policies}
        current={policy.slug}
        className="lg:sticky lg:top-[calc(var(--shell-header-h)_+_var(--s-6))] lg:col-start-1 lg:row-start-1 lg:self-start lg:pt-14"
      />
    </div>
  );
}

/** Under the title: the draft notice (from the data flag), or who approved it and when. */
function PolicyStatus({ policy }: { policy: PolicyView }) {
  const t = useT("content");
  const f = useFormat();
  if (!policy.approved) {
    return (
      <div className="panel grid gap-1 p-4" role="note">
        <Status tone="warn" className="type-strong">
          {t("common.draftStatus")}
        </Status>
        <p className="type-caption text-ink-2">{t("common.draftText")}</p>
      </div>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-1 type-caption text-ink-2">
      <Status tone="ok">{t("common.approvedStatus")}</Status>
      {policy.updatedAt ? <span className="nums">{t("common.updated", { date: f.date(policy.updatedAt, "long") })}</span> : null}
    </p>
  );
}

/** What a shopper reading this policy often needs next — other policies by their current titles, and the pages. */
function useRelated(slug: string, policies: readonly PolicySummary[]): LinkRow[] {
  const t = useT("content");
  const titleOf = (target: PolicySlug) => policies.find((policy) => policy.slug === target)?.title ?? target;
  const policyRow = (target: PolicySlug): LinkRow => ({ to: `/policies/${target}`, icon: POLICY_ICONS[target], title: titleOf(target), nav: "push", order: policyOrder(target) ?? undefined });
  const track: LinkRow = { to: "/track", icon: "package", title: t("links.track"), hint: t("links.trackHint") };
  const contact: LinkRow = { to: "/contact", icon: "chat-circle", title: t("links.contact"), hint: t("links.contactHint") };
  const repair: LinkRow = { to: "/support/repair", icon: "wrench", title: t("links.repair"), hint: t("links.repairHint") };
  if (!isPolicySlug(slug)) return [contact, policyRow("privacy")];
  const map: Record<PolicySlug, LinkRow[]> = {
    shipping: [track, policyRow("payment"), contact],
    returns: [policyRow("warranty"), track, contact],
    warranty: [repair, policyRow("returns"), contact],
    payment: [policyRow("returns"), track, policyRow("privacy")],
    privacy: [contact, policyRow("terms"), { to: "/accessibility", icon: "eye", title: t("links.accessibility") }],
    terms: [policyRow("privacy"), policyRow("payment"), policyRow("returns")],
  };
  return map[slug];
}
