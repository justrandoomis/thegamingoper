/**
 * The footers (Design System v2 §5.9, §5.8).
 *
 * <Footer> — on --niche with a hairline on top, from the top:
 *   1. the store's contact channels in one row, only those the owner configured (otherwise nothing);
 *   2. the lockup and one factual line (the delivery fee from settings);
 *   3. four columns, each a <nav> named by its heading: تسوّق (the four platforms, الألعاب, الإكسسوارات, المستعمل
 *      والمفحوص, استبدل جهازك — id="shell-categories", where the tab bar's «التصنيفات» leads without script) · الدعم
 *      (تتبّع طلبك, the shipping / returns / warranty policies, الصيانة, تحدّث مع موظف) · عن طمطم (من نحن, privacy, terms,
 *      إمكانية الوصول, and تواصل معنا once channels exist) · طرق الدفع (the methods the store switched on, as text pills,
 *      the manual-check sentence and the payment policy). Below 768 the columns are accordions of 56px rows, closed
 *      by default once the page is live (without script they stay open);
 *   4. the preferences: language, theme and the display currency (segmented, 44px);
 *   5. the legal row: © · the precise demo statement (demo mode; #shell-demo, where the demo strip leads) · the
 *      photo credit line.
 *
 * <TaskFooter> — checkout and task flows: one line of 13px links with 44px hit areas (الإرجاع · الخصوصية · الشروط ·
 * الدعم), the © and, in demo mode, the demo statement.
 *
 * Policy pages are /policies/<slug> (content area): every slug of its POLICY_SLUGS, in the columns ./chrome
 * FOOTER_POLICIES sets (tests/shell.test.ts).
 */
import { useId, useState, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat } from "~/i18n/react";
import { formatMoney } from "~/lib/money";
import { ContactCard } from "~/ui/ContactCard";
import { DemoNote } from "~/ui/DemoNote";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { DEMO_NOTE_ID } from "./Banners";
import { FOOTER_POLICIES, TASK_FOOTER_LINKS } from "./chrome";
import { Lockup } from "./Header";
import { usePlatformName } from "./MegaMenu";
import { CurrencyPanel, LanguageBank, PreferenceGroup, ThemeBank } from "./Preferences";
import { useShellT } from "./i18n";
import type { ShellContactLink, ShellData } from "./types";

const CONTACT_ICON: Record<ShellContactLink["kind"], IconName> = {
  phone: "phone",
  whatsapp: "whatsapp-logo",
  email: "envelope-simple",
  instagram: "link",
  facebook: "link",
  tiktok: "link",
  telegram: "paper-plane-tilt",
  map: "map-pin",
};

/** The channels <ContactCard> shows itself. */
const CARD_KINDS = new Set<ShellContactLink["kind"]>(["phone", "whatsapp", "map"]);

/** The handoff destination: one "talk to a person" page everywhere (v2 §6.13). */
const HANDOFF = "/support/assistant?handoff=1#handoff";

export function Footer({ shell, demo }: { shell: ShellData | null; demo: boolean }) {
  const t = useShellT();
  const f = useFormat();
  const nameOf = usePlatformName();
  const nav = shell?.nav;
  const fee = shell ? "⁨" + formatMoney(shell.deliveryFeeIqd, "IQD", f.locale, f.numbering) + "⁩" : null;
  const payments = shell?.payments;
  const methods = payments ? (["cod", "wallet", "card", "zaincash"] as const).filter((method) => payments[method]) : [];
  const contact = shell?.contact;
  const hasContact = !!contact && (contact.links.length > 0 || !!contact.address || !!contact.hours);
  const games = nav?.categories.find((category) => category.slug === "games");
  const accessories = nav?.categories.find((category) => category.slug === "accessories");

  return (
    <footer className="shell-footer">
      <div className="page">
        {hasContact && contact ? (
          <div className="shell-footer__contact" role="group" aria-label={t("footer.contact")}>
            {/* WhatsApp, phone, address and hours: the kit's contact card (renders nothing without them) */}
            <ContactCard channels={contact.channels} layout="row" />
            {/* the other channels the owner filled in (email, social pages) */}
            {contact.links
              .filter((link) => !CARD_KINDS.has(link.kind))
              .map((link) => (
                <a
                  key={link.href}
                  href={link.href}
                  className="shell-footer__contact-link"
                  {...(link.href.startsWith("https:") ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                >
                  <Icon name={CONTACT_ICON[link.kind]} size={20} />
                  <bdi dir="ltr">{link.label}</bdi>
                </a>
              ))}
          </div>
        ) : null}

        <div className="shell-footer__top">
          <div className="shell-footer__brand">
            <Lockup />
            {fee ? <p className="shell-footer__line">{t("footer.line", { fee })}</p> : null}
          </div>

          <div className="shell-footer__cols">
            <Column id="shell-categories" title={t("footer.shop")}>
              {nav?.platforms.map((platform) => (
                <FooterLink key={platform.slug} to={platform.href} gel={isPlatform(platform.accent) ? platform.accent : undefined}>
                  {nameOf(platform)}
                </FooterLink>
              ))}
              {games ? <FooterLink to={games.href}>{games.label}</FooterLink> : null}
              {accessories ? <FooterLink to={accessories.href}>{accessories.label}</FooterLink> : null}
              <FooterLink to="/used">{t("footer.used")}</FooterLink>
              <FooterLink to="/trade-in">{t("links.tradeIn")}</FooterLink>
            </Column>

            <Column title={t("footer.support")}>
              <FooterLink to="/track">{t("links.track")}</FooterLink>
              {FOOTER_POLICIES.support.map((slug) => (
                <FooterLink key={slug} to={`/policies/${slug}`}>
                  {t(`footer.${slug}`)}
                </FooterLink>
              ))}
              <FooterLink to="/support/repair">{t("footer.repair")}</FooterLink>
              <FooterLink to={HANDOFF}>{t("footer.handoff")}</FooterLink>
            </Column>

            <Column title={t("footer.about")}>
              <FooterLink to="/about">{t("footer.aboutUs")}</FooterLink>
              {FOOTER_POLICIES.about.map((slug) => (
                <FooterLink key={slug} to={`/policies/${slug}`}>
                  {t(`footer.${slug}`)}
                </FooterLink>
              ))}
              <FooterLink to="/accessibility">{t("footer.accessibility")}</FooterLink>
              {hasContact ? <FooterLink to="/contact">{t("footer.contact")}</FooterLink> : null}
            </Column>

            <Column title={t("footer.payments")}>
              {methods.length > 0 ? (
                <li>
                  <ul className="shell-pays">
                    {methods.map((method) => (
                      <li key={method} className="shell-pay">
                        {t(`footer.pay.${method}`)}
                      </li>
                    ))}
                  </ul>
                </li>
              ) : null}
              {payments?.card || payments?.zaincash ? (
                <li>
                  <p className="shell-footer__note">{t("footer.payNote")}</p>
                </li>
              ) : null}
              {FOOTER_POLICIES.payments.map((slug) => (
                <FooterLink key={slug} to={`/policies/${slug}`}>
                  {t(`footer.${slug}`)}
                </FooterLink>
              ))}
            </Column>
          </div>
        </div>

        <div className="shell-footer__prefs" role="group" aria-label={t("footer.preferences")}>
          <PreferenceGroup label={t("language.label")}>
            <LanguageBank />
          </PreferenceGroup>
          <PreferenceGroup label={t("theme.label")}>
            <ThemeBank />
          </PreferenceGroup>
          <PreferenceGroup label={t("currency.label")}>
            <CurrencyPanel />
          </PreferenceGroup>
        </div>

        <div className="shell-footer__legal">
          <p>{shell ? t("footer.rights", { year: shell.year }) : null}</p>
          {demo ? (
            <div id={DEMO_NOTE_ID} className="shell-footer__demo">
              <DemoNote variant="line">{t("demo.footer")}</DemoNote>
            </div>
          ) : null}
          <p>{t("footer.photos")}</p>
        </div>
      </div>
    </footer>
  );
}

/** Checkout and task flows: one line of links (v2 §5.8), the © and the demo statement. */
export function TaskFooter({ shell, demo }: { shell: ShellData | null; demo: boolean }) {
  const t = useShellT();
  const label: Record<(typeof TASK_FOOTER_LINKS)[number], string> = {
    "/policies/returns": t("footer.returns"),
    "/policies/privacy": t("footer.privacy"),
    "/policies/terms": t("footer.terms"),
    "/support": t("footer.helpCentre"),
  };
  return (
    <footer className="shell-tfoot">
      <div className="page">
        <nav aria-label={t("footer.legal")} className="shell-tfoot__row">
          {TASK_FOOTER_LINKS.map((to) => (
            <LocaleLink key={to} to={to} prefetch="none" className="shell-tfoot__link">
              {label[to]}
            </LocaleLink>
          ))}
          <span className="shell-tfoot__copy">{shell ? t("footer.rights", { year: shell.year }) : null}</span>
        </nav>
        {demo ? (
          <div id={DEMO_NOTE_ID}>
            <DemoNote variant="line">{t("demo.footer")}</DemoNote>
          </div>
        ) : null}
      </div>
    </footer>
  );
}

/** A footer column: a <nav> named by its heading; below 768 an accordion row (closed by default once live). */
function Column({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  const headingId = useId();
  const listId = useId();
  const [open, setOpen] = useState(false);
  return (
    <nav id={id} aria-labelledby={headingId} className="shell-fcol" data-open={open ? "" : undefined}>
      <h2 id={headingId} className="shell-fcol__title">
        <button type="button" className="shell-fcol__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((value) => !value)}>
          {title}
          <Icon name="caret-down" size={20} />
        </button>
        <span className="shell-fcol__label">{title}</span>
      </h2>
      <ul id={listId} className="shell-fcol__list">
        {children}
      </ul>
    </nav>
  );
}

function FooterLink({ to, gel, children }: { to: string; gel?: string; children: ReactNode }) {
  return (
    <li data-gel={gel}>
      <LocaleLink to={to} className="shell-flink" prefetch="none">
        {gel ? <PlatformLed /> : null}
        <span className="shell-flink__text">{children}</span>
      </LocaleLink>
    </li>
  );
}
