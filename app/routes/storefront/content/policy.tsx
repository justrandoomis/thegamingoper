/**
 * /policies/:slug — one store policy (shipping, returns, warranty, payment, privacy, terms, or any policy the owner
 * published in the CMS), Design System v2 §6.15. The text is an approved CMS page when there is one, else the draft
 * written in code and filled with the live settings (~/server/services/content.server → getPolicy).
 *
 *   article   breadcrumbs · the h1 · the summary · ONE status line («● نسخة أولى — قد تتغيّر قبل الإطلاق.» while the
 *             text is the draft, then «آخر تحديث …») · «باختصار» (live facts, kit fact rows) · the text (<Blocks>) ·
 *             «قد تحتاج أيضاً» rows — in the 720px reading column
 *   list      every policy: a 240px sticky column at the start from 1024, after the article below it
 *
 * Drafts are kept out of search engines (noindex here, no sitemap entry). States: draft or approved · partial (an
 * approved page without this language: shown in Arabic, said so) · unknown slug → the shell's 404 · a failed read →
 * the shell's error panel (never an empty policy). No red key: a reading view.
 */
import { data } from "react-router";

import type { Route } from "./+types/policy";
import { Icon } from "~/art/Icon";
import { useLocale, useT } from "~/i18n/react";
import { LOCALES } from "~/lib/locales";
import type { MotionHandle } from "~/motion";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, getPolicy, listPolicies } from "~/server/services/content.server";
import { Blocks } from "~/ui/Blocks";
import { ContentHeader, Section, useHasContact } from "./components/ContentHeader";
import { FactPanel } from "./components/FactPanel";
import { LinkRows, type LinkRow } from "./components/LinkRows";
import { PolicyNav } from "./components/PolicyNav";
import { PolicyStatus } from "./components/PolicyStatus";
import { HANDOFF_PATH, POLICY_ICONS, isPolicySlug, policyOrder, type PolicySlug, type PolicySummary } from "./content-model";
import "./content.css";

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
    <div className="page cpage">
      <div className="cpolicy">
        <article className="cpolicy__main ccol">
          <ContentHeader
            crumbs={[{ label: t("common.home"), href: "/" }, { label: t("index.title"), href: "/policies" }, { label: policy.title }]}
            title={<span {...textLang}>{policy.title}</span>}
            lead={policy.summary || undefined}
          >
            <PolicyStatus approved={policy.approved} updatedAt={policy.updatedAt} />
          </ContentHeader>
          <FactPanel facts={policy.facts} />
          {fallback ? (
            <p className="cnote">
              <Icon name="translate" size={20} />
              <span>{t("common.textFallback")}</span>
            </p>
          ) : null}
          <div {...textLang}>
            <Blocks blocks={policy.blocks} />
          </div>
          {related.length > 0 ? (
            <Section id="policy-related" title={t("common.related")} size="sm">
              <LinkRows rows={related} card />
            </Section>
          ) : null}
        </article>
        <PolicyNav policies={policies} current={policy.slug} className="cpolicy__toc" />
      </div>
    </div>
  );
}

/**
 * What a shopper reading this policy often needs next — other policies by their current titles, and the pages. While
 * the store has published no contact channel, "contact us" is «تحدّث مع موظف» (the hand-off form) instead.
 */
function useRelated(slug: string, policies: readonly PolicySummary[]): LinkRow[] {
  const t = useT("content");
  const hasContact = useHasContact();
  const titleOf = (target: PolicySlug) => policies.find((policy) => policy.slug === target)?.title ?? target;
  const policyRow = (target: PolicySlug): LinkRow => ({ to: `/policies/${target}`, icon: POLICY_ICONS[target], title: titleOf(target), nav: "push", order: policyOrder(target) ?? undefined });
  const track: LinkRow = { to: "/track", icon: "package", title: t("links.track"), hint: t("links.trackHint") };
  const contact: LinkRow = hasContact
    ? { to: "/contact", icon: "chat-circle", title: t("links.contact"), hint: t("links.contactHint") }
    : { to: HANDOFF_PATH, icon: "chat-circle", title: t("handoff.action"), hint: t("handoff.text") };
  const repair: LinkRow = { to: "/support/repair", icon: "wrench", title: t("links.repair"), hint: t("links.repairHint") };
  const askWarranty: LinkRow = { to: HANDOFF_PATH, icon: "chat-circle", title: t("links.warrantyAsk"), hint: t("handoff.text") };
  const accessibility: LinkRow = { to: "/accessibility", icon: "eye", title: t("links.accessibility"), hint: t("links.accessibilityHint") };
  if (!isPolicySlug(slug)) return [contact, policyRow("privacy")];
  const map: Record<PolicySlug, LinkRow[]> = {
    shipping: [track, policyRow("payment"), contact],
    returns: [policyRow("warranty"), track, contact],
    warranty: [repair, policyRow("returns"), hasContact ? contact : askWarranty],
    payment: [policyRow("returns"), track, policyRow("privacy")],
    privacy: [contact, policyRow("terms"), accessibility],
    terms: [policyRow("privacy"), policyRow("payment"), policyRow("returns")],
  };
  return map[slug];
}
