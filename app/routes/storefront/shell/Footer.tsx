/**
 * The footer: a flat niche band at the end of every page — the stacked logo and the delivery fact, the platforms
 * (with used and trade-in; id="shell-categories" is where the tab bar's "التصنيفات" leads without script), the
 * departments, help, the store's pages (policies, shipping, returns, privacy, contact, accessibility, about), the
 * payment methods the store has switched on — as text —, the owner's contact details when there are any, the
 * language switch, the demo line while the store is in demo mode, and the © line.
 *
 * Policy pages are /policies/<slug> (content area): every slug of its POLICY_SLUGS, in the columns ./chrome
 * FOOTER_POLICIES sets (help: shipping, returns, warranty, payment · store: privacy, terms), plus /policies, the list
 * of them all.
 */
import { useId, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { formatMoney } from "~/lib/money";
import { PlatformLed, isPlatform } from "~/ui/PlatformLed";
import { FOOTER_POLICIES } from "./chrome";
import { usePlatformName } from "./MegaMenu";
import { LanguageLinks } from "./Preferences";
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

export function Footer({ shell, demo }: { shell: ShellData | null; demo: boolean }) {
  const t = useShellT();
  const common = useT("common");
  const f = useFormat();
  const nameOf = usePlatformName();
  const nav = shell?.nav;
  const fee = shell ? "⁨" + formatMoney(shell.deliveryFeeIqd, "IQD", f.locale, f.numbering) + "⁩" : null;
  const payments = shell?.payments;
  const methods = payments ? (["cod", "wallet", "card", "zaincash"] as const).filter((method) => payments[method]) : [];

  return (
    <footer className="shell-footer">
      <div className="page">
        <div className="shell-footer__grid">
          <div className="shell-footer__brand">
            <LocaleLink to="/" aria-label={t("brandHome")} className="inline-flex w-fit text-logo">
              <Logo variant="stacked" className="shell-footer__logo" />
            </LocaleLink>
            <p className="shell-footer__fact">{common("brand.tagline")}</p>
            {fee ? (
              <p className="shell-footer__fact flex items-center gap-2">
                <Icon name="truck" size={18} className="text-ink" />
                <span>{t("footer.delivery", { fee })}</span>
              </p>
            ) : null}
          </div>

          <Column id="shell-categories" title={t("sheet.platforms")}>
            {nav?.platforms.map((platform) => (
              <FooterLink key={platform.slug} to={platform.href} gel={isPlatform(platform.accent) ? platform.accent : undefined}>
                {nameOf(platform)}
              </FooterLink>
            ))}
            <FooterLink to="/used">{t("sheet.used")}</FooterLink>
            <FooterLink to="/trade-in">{t("utility.tradeIn")}</FooterLink>
          </Column>

          {nav && nav.categories.length > 0 ? (
            <Column title={t("sheet.departments")}>
              {nav.categories.map((category) => (
                <FooterLink key={category.slug} to={category.href}>
                  {category.label}
                </FooterLink>
              ))}
            </Column>
          ) : null}

          <Column title={t("footer.help")}>
            <FooterLink to="/track">{t("utility.track")}</FooterLink>
            <FooterLink to="/support">{t("sheet.support")}</FooterLink>
            {FOOTER_POLICIES.help.map((slug) => (
              <FooterLink key={slug} to={`/policies/${slug}`}>
                {t(`footer.${slug}`)}
              </FooterLink>
            ))}
            <FooterLink to="/contact">{t("footer.contact")}</FooterLink>
          </Column>

          <Column title={t("footer.store")}>
            <FooterLink to="/about">{t("footer.about")}</FooterLink>
            {FOOTER_POLICIES.store.map((slug) => (
              <FooterLink key={slug} to={`/policies/${slug}`}>
                {t(`footer.${slug}`)}
              </FooterLink>
            ))}
            <FooterLink to="/policies">{t("footer.policies")}</FooterLink>
            <FooterLink to="/accessibility">{t("footer.accessibility")}</FooterLink>
          </Column>

          <div className="flex flex-col gap-6">
            {methods.length > 0 ? (
              <TitledSection title={t("footer.payments")}>
                <ul className="flex flex-col gap-1">
                  {methods.map((method) => (
                    <li key={method} className="shell-footer__fact">
                      {t(`footer.pay.${method}`)}
                    </li>
                  ))}
                </ul>
                {payments?.card || payments?.zaincash ? <p className="shell-footer__fact mt-2 text-ink">{t("footer.payNote")}</p> : null}
              </TitledSection>
            ) : null}
            {shell && (shell.contact.links.length > 0 || shell.contact.address || shell.contact.hours) ? (
              <TitledSection title={t("footer.reach")}>
                <ul className="flex flex-col">
                  {shell.contact.links.map((link) => (
                    <li key={link.href}>
                      <a href={link.href} className="shell-footer__link" {...(link.href.startsWith("https:") ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                        <Icon name={CONTACT_ICON[link.kind]} size={18} />
                        <bdi dir="ltr" className="shell-footer__text">
                          {link.label}
                        </bdi>
                      </a>
                    </li>
                  ))}
                </ul>
                {shell.contact.address ? <p className="shell-footer__fact">{shell.contact.address}</p> : null}
                {shell.contact.hours ? <p className="shell-footer__fact">{shell.contact.hours}</p> : null}
              </TitledSection>
            ) : null}
          </div>
        </div>

        {demo ? (
          <p className="shell-footer__demo">
            <Icon name="info" size={18} />
            <span>{t("demo.footer")}</span>
          </p>
        ) : null}

        <div className="shell-footer__base">
          <p>{shell ? t("footer.rights", { year: shell.year }) : null}</p>
          <LanguageLinks className="flex items-center gap-4" linkClassName="shell-footer__link aria-[current=true]:font-semibold aria-[current=true]:text-ink" />
        </div>
      </div>
    </footer>
  );
}

function Column({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <nav id={id} aria-labelledby={headingId}>
      <h2 id={headingId} className="shell-footer__title">
        {title}
      </h2>
      <ul className="shell-footer__list">{children}</ul>
    </nav>
  );
}

function TitledSection({ title, children }: { title: string; children: ReactNode }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId}>
      <h2 id={headingId} className="shell-footer__title">
        {title}
      </h2>
      {children}
    </section>
  );
}

function FooterLink({ to, gel, children }: { to: string; gel?: string; children: ReactNode }) {
  return (
    <li data-gel={gel}>
      <LocaleLink to={to} className="shell-footer__link" prefetch="none">
        {gel ? <PlatformLed solid /> : null}
        <span className="shell-footer__text">{children}</span>
      </LocaleLink>
    </li>
  );
}
