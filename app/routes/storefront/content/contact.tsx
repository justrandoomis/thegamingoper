/**
 * /contact — the store's contact details from settings `store.contact`, and nothing invented. While the owner has
 * not filled them in, the page says so ("بيانات التواصل قريباً") and points to the help centre, where a support
 * request reaches the team. Quick help (tracking, returns, repairs) is always there. A published CMS page of kind
 * "contact" adds its text above the details.
 *
 * States: details · partial (only some channels, or only an address) · empty (coming soon + help centre) · a failed
 * read → the shell's error panel (an outage is never shown as "no contact details").
 */
import type { Route } from "./+types/contact";
import { Icon } from "~/art/Icon";
import { serverT } from "~/i18n/i18n.server";
import { LocaleLink, useLocale, useT } from "~/i18n/react";
import { LOCALES } from "~/lib/locales";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, getCmsText, getContactDetails } from "~/server/services/content.server";
import { Blocks } from "~/ui/Blocks";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { ContactChannels } from "./components/ContactChannels";
import { ContentHeader, Section } from "./components/ContentHeader";
import { LinkRows } from "./components/LinkRows";

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const [contact, cms] = await Promise.all([getContactDetails(db, ctx.locale), getCmsText(db, ctx.locale, "contact", { now: ctx.now })]);
  const t = serverT(ctx.locale, "content");
  return { contact, cms, meta: { title: t("contact.title"), description: t("contact.metaDescription") }, i18n: contentMessages(ctx.locale) };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, args.loaderData?.meta);

export default function ContactPage({ loaderData }: Route.ComponentProps) {
  const { contact, cms } = loaderData;
  const t = useT("content");
  const locale = useLocale();
  const cmsLang = cms && cms.textLocale !== locale ? { lang: LOCALES[cms.textLocale].bcp47, dir: LOCALES[cms.textLocale].dir } : {};

  return (
    <div className="page grid gap-10 pb-12 pt-4 md:pt-6">
      <ContentHeader crumbs={[{ label: t("common.home"), href: "/" }, { label: t("contact.title") }]} title={t("contact.title")} lead={t("contact.lead")} />

      {cms ? (
        <div {...cmsLang} className="-mt-4 max-w-[44rem]">
          <Blocks blocks={cms.blocks} />
        </div>
      ) : null}

      <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_22rem] lg:gap-14">
        <div className="grid min-w-0 content-start gap-10">
          {contact.isEmpty ? (
            <EmptyState
              headingLevel={2}
              icon="chat-circle"
              title={t("contact.emptyTitle")}
              text={t("contact.emptyText")}
              action={
                <Key as={LocaleLink} to="/support" iconEnd="arrow-right">
                  {t("contact.emptyAction")}
                </Key>
              }
            />
          ) : (
            <>
              {contact.channels.length > 0 ? (
                <Section id="contact-channels" title={t("contact.channelsTitle")}>
                  <ContactChannels channels={contact.channels} />
                </Section>
              ) : null}
              {contact.address || contact.hours ? (
                <dl className="grid gap-4 sm:grid-cols-2">
                  {contact.address ? (
                    <div className="grid content-start gap-1">
                      <dt className="flex items-center gap-2 type-label text-ink-2">
                        <Icon name="map-pin" size={18} />
                        {t("contact.addressTitle")}
                      </dt>
                      <dd className="type-body text-ink">{contact.address}</dd>
                    </div>
                  ) : null}
                  {contact.hours ? (
                    <div className="grid content-start gap-1">
                      <dt className="flex items-center gap-2 type-label text-ink-2">
                        <Icon name="clock" size={18} />
                        {t("contact.hoursTitle")}
                      </dt>
                      <dd className="type-body text-ink nums">{contact.hours}</dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </>
          )}
          <p className="flex items-start gap-3 type-body text-ink">
            <Icon name="shield-check" size={20} className="mt-1 shrink-0" />
            <span>{t("contact.safety")}</span>
          </p>
        </div>

        <Section id="contact-quick" title={t("contact.quickTitle")} heading="type-sub">
          <LinkRows
            rows={[
              { to: "/track", icon: "package", title: t("links.track"), hint: t("links.trackHint") },
              { to: "/policies/returns", icon: "arrow-counter-clockwise", title: t("links.returns"), hint: t("links.returnsHint") },
              { to: "/support/repair", icon: "wrench", title: t("links.repair"), hint: t("links.repairHint") },
              { to: "/support", icon: "lifebuoy", title: t("links.support"), hint: t("links.supportHint") },
            ]}
          />
        </Section>
      </div>
    </div>
  );
}
