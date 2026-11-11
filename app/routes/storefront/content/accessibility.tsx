/**
 * /accessibility — the accessibility statement: the settings a shopper can change here (theme, language and the
 * motion engine's "reduce motion" override), what the site really supports (from the design system and the shell:
 * skip link, focus, dialogs, live regions, 44px targets, reduced motion, measured contrast), what has NOT been tested
 * yet (said plainly), and how to report a problem — the owner's contact channels when there are any, else the help
 * centre and the contact page.
 */
import type { ReactNode } from "react";

import type { Route } from "./+types/accessibility";
import { Icon, type IconName } from "~/art/Icon";
import { serverT } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { LanguageBank, ThemeBank } from "~/routes/storefront/shell/Preferences";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, getContactDetails } from "~/server/services/content.server";
import { ContactChannels } from "./components/ContactChannels";
import { ContentHeader, Section } from "./components/ContentHeader";
import { LinkRows } from "./components/LinkRows";
import { MotionChoice } from "./components/MotionChoice";

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const contact = await getContactDetails(getDb(), ctx.locale);
  const t = serverT(ctx.locale, "content");
  // Only the direct channels are offered for reports (phone, WhatsApp, email); social pages are not a support desk.
  const channels = contact.channels.filter((channel) => channel.kind === "phone" || channel.kind === "whatsapp" || channel.kind === "email");
  return { channels, meta: { title: t("a11y.title"), description: t("a11y.metaDescription") }, i18n: contentMessages(ctx.locale) };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, args.loaderData?.meta);

export default function AccessibilityPage({ loaderData }: Route.ComponentProps) {
  const t = useT("content");
  const groups: { id: string; title: string; icon: IconName; items: string[] }[] = [
    { id: "a11y-reading", title: t("a11y.readingTitle"), icon: "translate", items: [t("a11y.reading.languages"), t("a11y.reading.contrast"), t("a11y.reading.prices")] },
    {
      id: "a11y-keyboard",
      title: t("a11y.keyboardTitle"),
      icon: "key",
      items: [t("a11y.keyboard.skip"), t("a11y.keyboard.focus"), t("a11y.keyboard.dialogs"), t("a11y.keyboard.structure"), t("a11y.keyboard.live")],
    },
    { id: "a11y-touch", title: t("a11y.touchTitle"), icon: "device-mobile", items: [t("a11y.touch.targets"), t("a11y.touch.motion"), t("a11y.touch.still")] },
  ];

  return (
    <div className="page grid gap-12 pb-12 pt-4 md:pt-6">
      <ContentHeader crumbs={[{ label: t("common.home"), href: "/" }, { label: t("a11y.title") }]} title={t("a11y.title")} lead={t("a11y.lead")}>
        <p className="flex items-start gap-2 type-body text-ink">
          <Icon name="seal-check" size={20} className="mt-1 shrink-0" />
          <span>{t("a11y.goal")}</span>
        </p>
      </ContentHeader>

      <Section id="a11y-settings" title={t("a11y.settingsTitle")} className="max-w-[44rem]">
        <p className="-mt-2 type-caption text-ink-2">{t("a11y.settingsText")}</p>
        <div className="panel grid gap-5 p-4 md:p-5">
          <Setting label={t("a11y.themeLabel")}>
            <ThemeBank />
          </Setting>
          <Setting label={t("a11y.languageLabel")}>
            <LanguageBank />
          </Setting>
          <Setting label={t("a11y.motionLabel")}>
            <MotionChoice />
          </Setting>
        </div>
      </Section>

      <Section id="a11y-supports" title={t("a11y.supportsTitle")}>
        <div className="grid gap-8 md:grid-cols-3 md:gap-6">
          {groups.map((group) => (
            <section key={group.id} aria-labelledby={group.id} className="grid content-start gap-3">
              <h3 id={group.id} className="flex items-center gap-2 type-sub text-ink">
                <Icon name={group.icon} size={20} />
                {group.title}
              </h3>
              <ul className="grid list-disc gap-2 ps-5 type-body text-ink marker:text-ink-2">
                {group.items.map((item) => (
                  <li key={item} className="ps-1">
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      </Section>

      <Section id="a11y-limits" title={t("a11y.limitsTitle")} className="max-w-[44rem]">
        <ul className="grid gap-3">
          {[t("a11y.limits.browsers"), t("a11y.limits.readers"), t("a11y.limits.contrast"), t("a11y.limits.kurdish")].map((item) => (
            <li key={item} className="flex items-start gap-3 type-body text-ink">
              <Icon name="hourglass" size={20} className="mt-1 shrink-0 text-ink-2" />
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section id="a11y-report" title={t("a11y.reportTitle")} className="max-w-[44rem]">
        <p className="type-body text-ink">{t("a11y.reportText")}</p>
        <ul className="grid list-disc gap-1.5 ps-5 type-body text-ink marker:text-ink-2">
          {[t("a11y.report.page"), t("a11y.report.task"), t("a11y.report.device"), t("a11y.report.tools")].map((item) => (
            <li key={item} className="ps-1">
              {item}
            </li>
          ))}
        </ul>
        <h3 className="mt-2 type-sub text-ink">{t("a11y.reportWays")}</h3>
        {loaderData.channels.length > 0 ? <ContactChannels channels={loaderData.channels} compact /> : null}
        <LinkRows
          rows={[
            { to: "/support", icon: "lifebuoy", title: t("links.support"), hint: t("links.supportHint") },
            { to: "/contact", icon: "chat-circle", title: t("links.contact"), hint: t("links.contactHint") },
          ]}
        />
      </Section>
    </div>
  );
}

/** A visible label over a key bank. The bank names itself with the same words, so the label is not read twice. */
function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-2">
      <p className="type-label text-ink" aria-hidden="true">
        {label}
      </p>
      {children}
    </div>
  );
}
