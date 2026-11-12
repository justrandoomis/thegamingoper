import type { ReactNode } from "react";

import { LocaleLink, useT } from "~/i18n/react";
import { TextLink } from "~/ui/TextLink";
import "../account.css";

/**
 * The frame of the pages before an account exists — sign in, sign up, password reset (Design System v2 §6.12): ONE
 * centred 480px card (h1, one line, the form, the switch to the other page), and under it the guest note — an account
 * is never needed to order (brief §4): «يمكنك الطلب بدون حساب، وتتبّع طلبك برقمه ورقم موبايلك.» with the two ways on.
 */
export function AuthCard({ title, lead, children, footer }: { title: ReactNode; lead?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const t = useT("account");
  return (
    <div className="page">
      <div className="acct-auth">
        <div className="acct-auth__card">
          <header className="grid gap-2">
            <h1 className="type-h1 text-ink">{title}</h1>
            {lead ? <p className="type-body text-ink-2">{lead}</p> : null}
          </header>
          {children}
          {footer ? <div className="acct-auth__switch">{footer}</div> : null}
        </div>
        <div className="acct-auth__guest">
          <p>{t("login.guestNote")}</p>
          <div className="acct-auth__links">
            <TextLink as={LocaleLink} to="/track">
              {t("login.track")}
            </TextLink>
            <TextLink as={LocaleLink} to="/">
              {t("login.shop")}
            </TextLink>
          </div>
        </div>
      </div>
    </div>
  );
}
