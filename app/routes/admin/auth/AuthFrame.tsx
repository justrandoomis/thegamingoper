/**
 * The frame of the admin's sign-in and setup pages: the floor, the logo with "Admin", a language switch (a plain POST
 * form to /admin/locale, so it works before JavaScript) and one paper card. Default density (these forms are often
 * filled on a phone); no navigation, nothing that needs a session.
 */
import type { ReactNode } from "react";
import { Form, useLocation } from "react-router";

import { Logo } from "~/art/Logo";
import { useLocale, useT } from "~/i18n/react";
import { MotionRoot } from "~/motion";
import { Key } from "~/ui/Key";

import "../shell/admin-shell.css";

export function AuthFrame({ children }: { children: ReactNode }) {
  const t = useT("admin-auth");
  const locale = useLocale();
  const location = useLocation();
  const other = locale === "en" ? "ar" : "en";
  return (
    <div className="adm-auth">
      <MotionRoot />
      <div className="adm-auth__column">
        <div className="adm-auth__bar">
          <span className="flex items-center gap-3">
            <Logo variant="mark" className="h-10 w-auto text-logo" />
            <span className="grid">
              <span className="type-strong text-ink">{t("frame.logo")}</span>
              <span className="type-caption text-ink-2">{t("frame.admin")}</span>
            </span>
          </span>
          <Form method="post" action="/admin/locale" reloadDocument>
            <input type="hidden" name="locale" value={other} />
            <input type="hidden" name="back" value={`${location.pathname}${location.search}`} />
            <Key type="submit" size="sm" variant="quiet" icon="translate" title={t("frame.switchLabel")} lang={other} dir={other === "ar" ? "rtl" : "ltr"}>
              {t("frame.switchTo")}
            </Key>
          </Form>
        </div>
        <main id="main" className="adm-auth__card">
          {children}
        </main>
      </div>
    </div>
  );
}
