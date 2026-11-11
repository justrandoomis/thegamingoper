import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { LocaleLink, useT } from "~/i18n/react";
import { Key } from "~/ui/Key";

/**
 * The frame of the pages before an account exists (sign in, sign up, password reset): the form on a paper panel at the
 * start, and — because an account is never needed to order (brief §4) — a flat panel that says so, with the ways to
 * carry on as a guest.
 */
export function AuthShell({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
  return (
    <div className="page grid items-start gap-6 pb-12 pt-4 sm:pt-6 lg:grid-cols-[minmax(0,34rem)_minmax(0,1fr)] lg:gap-10 lg:pt-10">
      <div className="grid gap-6 rounded-lg bg-paper p-4 shadow-e1 sm:p-6 lg:p-8">{children}</div>
      <div className="grid gap-4">{aside ?? <GuestPanel />}</div>
    </div>
  );
}

/** "You do not need an account to order": track an order, or keep shopping. */
export function GuestPanel() {
  const t = useT("account");
  return (
    <section aria-labelledby="guest-panel-title" className="panel grid gap-3 p-4 sm:p-6">
      <span className="grid size-11 place-items-center rounded-full bg-well text-ink" aria-hidden="true">
        <Icon name="shopping-bag" size={22} />
      </span>
      <h2 id="guest-panel-title" className="type-sub text-ink">
        {t("login.guestTitle")}
      </h2>
      <p className="type-body text-ink-2">{t("login.guestText")}</p>
      <div className="flex flex-wrap gap-2 pt-1">
        <Key as={LocaleLink} to="/track" size="sm" icon="truck">
          {t("login.track")}
        </Key>
        <Key as={LocaleLink} to="/" size="sm" variant="quiet" iconEnd="arrow-right">
          {t("login.shop")}
        </Key>
      </div>
    </section>
  );
}
