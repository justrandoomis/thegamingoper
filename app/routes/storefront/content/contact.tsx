/**
 * /contact — the store's contact details from settings `store.contact`, and nothing invented (Design System v2 §6.15,
 * §4.25). A published CMS page of kind "contact" adds its text under the head.
 *
 *   channels    the kit's <ContactCard> first, WhatsApp as the view's one red key (phone as a tel: link, the address
 *               with its map link, the hours in the owner's words), then e-mail and social pages as rows
 *   none        (today) the page leads with «اكتب لموظف»: the hand-off card, «تحدّث مع موظف» as the one red key —
 *               never "coming soon"; the footer leaves /contact out until a channel exists (the shell)
 *   always      the anti-fraud line and «مساعدة سريعة» (track, returns, book a repair, the support centre) — an
 *               aside from 1024
 *
 * A failed read is the shell's error panel: an outage is never shown as "no contact details".
 */
import type { Route } from "./+types/contact";
import { serverT } from "~/i18n/i18n.server";
import { useLocale, useT } from "~/i18n/react";
import { LOCALES } from "~/lib/locales";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, getCmsText, getContactDetails } from "~/server/services/content.server";
import { Blocks } from "~/ui/Blocks";
import { ContactCard } from "~/ui/ContactCard";
import { Note } from "~/ui/Note";
import { ContactChannels, otherChannels } from "./components/ContactChannels";
import { ContentHeader, Section } from "./components/ContentHeader";
import { HandoffCard } from "./components/HandoffCard";
import { LinkRows } from "./components/LinkRows";
import "./content.css";

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [contact, cms] = await Promise.all([getContactDetails(db, ctx.locale), getCmsText(db, ctx.locale, "contact", { now: ctx.now })]);
  const t = serverT(ctx.locale, "content");
  return { contact, cms, now: ctx.now, meta: { title: t("contact.title"), description: t("contact.metaDescription") }, i18n: contentMessages(ctx.locale) };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, args.loaderData?.meta);

export default function ContactPage({ loaderData }: Route.ComponentProps) {
  const { contact, cms, now } = loaderData;
  const t = useT("content");
  const locale = useLocale();
  const cmsLang = cms && cms.textLocale !== locale ? { lang: LOCALES[cms.textLocale].bcp47, dir: LOCALES[cms.textLocale].dir } : {};
  const others = otherChannels(contact.channels, Boolean(contact.address));
  const reachable = contact.card !== null || others.length > 0;

  return (
    <div className="page cpage">
      {/* «اختر الطريقة الأسهل لك» only when there is a choice; without a channel the one way is the hand-off */}
      <ContentHeader crumbs={[{ label: t("common.home"), href: "/" }, { label: t("contact.title") }]} title={t("contact.title")} lead={reachable ? t("contact.lead") : t("contact.leadHandoff")} />

      {cms ? (
        <div {...cmsLang} className="ccol">
          <Blocks blocks={cms.blocks} />
        </div>
      ) : null}

      <div className="csplit">
        <div className="grid min-w-0 content-start gap-8">
          {contact.card ? <ContactCard channels={contact.card} primary now={now} /> : null}
          {others.length > 0 ? (
            <Section id="contact-others" title={t("contact.othersTitle")} size="sm">
              <ContactChannels channels={others} />
            </Section>
          ) : null}
          {/* no channel yet: the hand-off leads, as the page's one red key */}
          {reachable ? null : <HandoffCard id="contact-handoff" primary />}
          {/* the anti-fraud rule is side information: the kit's calm note (v2.1 G5), its shield on the ok tint */}
          <Note tone="success" icon="shield-check">
            {t("contact.safety")}
          </Note>
        </div>

        <div className="csplit__aside">
          <Section id="contact-quick" title={t("contact.quickTitle")} size="sm" reveal>
            <LinkRows
              card
              rows={[
                { to: "/track", icon: "package", title: t("links.track"), hint: t("links.trackHint") },
                { to: "/policies/returns", icon: "arrow-counter-clockwise", title: t("links.returns"), hint: t("links.returnsHint") },
                { to: "/support/repair", icon: "wrench", title: t("links.repair"), hint: t("links.repairHint") },
                { to: "/support", icon: "lifebuoy", title: t("links.support"), hint: t("links.supportHint") },
              ]}
            />
          </Section>
          {/* with channels, the hand-off is still there — a quiet door, not the lead */}
          {reachable ? <HandoffCard id="contact-handoff" stack headingLevel={2} reveal /> : null}
        </div>
      </div>
    </div>
  );
}
