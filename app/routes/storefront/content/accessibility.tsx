/**
 * /accessibility — the accessibility statement, honest and short (Design System v2 §6.15):
 *
 *   head        the h1, the lead and the aim (WCAG 2.2 AA) in one line
 *   settings    what a shopper can change here, applied at once: theme and language (the shell's own segmented
 *               controls) and the motion engine's "reduce motion" override (the kit's segmented control)
 *   supports    six fact rows of what the shell, the kit and the engine really do
 *   not tested  ONE short section: browsers and phones, screen readers and high contrast, the Sorani review
 *   report      «أبلغنا عن مشكلة» → the support area's hand-off form (the view's one red key); the store's own contact
 *               card under it when it has published one
 */
import type { ReactNode } from "react";

import type { Route } from "./+types/accessibility";
import { Icon } from "~/art/Icon";
import { serverT } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { LanguageBank, ThemeBank } from "~/routes/storefront/shell/Preferences";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { contentMessages, getContactDetails } from "~/server/services/content.server";
import { ContactCard } from "~/ui/ContactCard";
import { FactList, type Fact } from "~/ui/FactList";
import { Note } from "~/ui/Note";
import { revealProps } from "~/ui/reveal";
import { ContentHeader, Section } from "./components/ContentHeader";
import { HandoffCard } from "./components/HandoffCard";
import { MotionChoice } from "./components/MotionChoice";
import "./content.css";

export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const contact = await getContactDetails(getDb(), ctx.locale);
  const t = serverT(ctx.locale, "content");
  return { card: contact.card, meta: { title: t("a11y.title"), description: t("a11y.metaDescription") }, i18n: contentMessages(ctx.locale) };
}

export const meta: Route.MetaFunction = (args) => shellMeta(args, args.loaderData?.meta);

const SUPPORTS: { key: "languages" | "keyboard" | "readers" | "contrast" | "touch" | "motion"; icon: Fact["icon"] }[] = [
  { key: "languages", icon: "translate" },
  { key: "keyboard", icon: "key" },
  { key: "readers", icon: "chat-circle" },
  { key: "contrast", icon: "eye" },
  { key: "touch", icon: "device-mobile" },
  { key: "motion", icon: "sparkle" },
];

export default function AccessibilityPage({ loaderData }: Route.ComponentProps) {
  const t = useT("content");
  return (
    <div className="page cpage">
      <ContentHeader crumbs={[{ label: t("common.home"), href: "/" }, { label: t("a11y.title") }]} title={t("a11y.title")} lead={t("a11y.lead")}>
        <Note variant="line" icon="seal-check">
          {t("a11y.goal")}
        </Note>
      </ContentHeader>

      <Section id="a11y-settings" title={t("a11y.settingsTitle")} text={t("a11y.settingsText")} className="ccol">
        <div className="csettings">
          <Setting label={t("a11y.themeLabel")}>
            <ThemeBank />
          </Setting>
          <Setting label={t("a11y.languageLabel")}>
            <LanguageBank />
          </Setting>
          <Setting label={t("a11y.motionLabel")}>
            <MotionChoice hintClassName="csettings__hint" />
          </Setting>
        </div>
      </Section>

      <Section id="a11y-supports" title={t("a11y.supportsTitle")} className="ccol" reveal>
        <FactList facts={SUPPORTS.map((item) => ({ id: item.key, icon: item.icon, title: t(`a11y.supports.${item.key}.title`), text: t(`a11y.supports.${item.key}.text`) }))} />
      </Section>

      <Section id="a11y-limits" title={t("a11y.limitsTitle")} className="ccol" reveal>
        <ul className="climits">
          {(["devices", "readers", "kurdish"] as const).map((key) => (
            <li key={key}>
              <Icon name="hourglass" size={20} />
              <span>{t(`a11y.limits.${key}`)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <div className="ccol grid gap-4" {...revealProps()}>
        <HandoffCard id="a11y-report" title={t("a11y.reportTitle")} text={t("a11y.reportText")} action={t("a11y.reportAction")} primary />
        {loaderData.card ? (
          <>
            <p className="csec__text">{t("a11y.reportDirect")}</p>
            <ContactCard channels={loaderData.card} />
          </>
        ) : null}
      </div>
    </div>
  );
}

/** A visible label beside its control. The control names itself with the same words, so the label is not read twice. */
function Setting({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="csettings__row">
      <p className="csettings__label" aria-hidden="true">
        {label}
      </p>
      <div className="csettings__control">{children}</div>
    </div>
  );
}
