import { useEffect, useRef, useState } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/welcome";
import { Icon } from "~/art/Icon";
import { serverT } from "~/i18n/i18n.server";
import { useFormat } from "~/i18n/react";
import { checkPasswordLink, setPasswordWithLink, type PasswordLinkView } from "~/server/auth/employees.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { actionError, type FieldErrors } from "~/server/errors";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useAdminT } from "./i18n";
import { adminMeta } from "./meta";

/**
 * /admin/welcome#<token> — an employee sets their own password with the one-time link the staff member who created
 * (or re-opened) their account gave them (auth/employees.server.ts: createEmployee, issuePasswordLink, enableEmployee).
 * Nobody is signed in here: the gate lets this one pattern through without a session (PUBLIC_PATTERNS) and the
 * shell renders without navigation.
 *
 * The token travels in the URL's FRAGMENT, which browsers never send: it reaches no request log and no Referer. The
 * page reads it once, takes it out of the address bar (history.replaceState), asks who the link is for ("check") and
 * then posts it with the new password ("set") — both POSTs, both answered from the auth core, which also limits the
 * attempts per address. Setting the password signs the employee out everywhere and signs nobody in: they go to the
 * sign-in page (a document navigation — it sits behind the edge's challenge).
 */
export async function loader() {
  return null;
}

type CheckResult = { ok: true; intent: "check"; link: PasswordLinkView } | { ok: false; intent: "check"; code: string; message?: string };
type SetResult = { ok: true; intent: "set" } | { ok: false; intent: "set"; code: string; message?: string; fields?: FieldErrors };

const field = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
};

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const errors = serverT(ctx.locale, "errors");
  const intent = field(form, "intent");
  const token = field(form, "token");
  if (intent === "check") {
    try {
      // limited per address: nobody is signed in here (the auth core counts each look-up)
      const link = await checkPasswordLink(db, token, ctx.now, { ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
      if (link) return { ok: true, intent: "check", link } satisfies CheckResult;
    } catch (error) {
      const failure = actionError(error, errors);
      return data({ ok: false, intent: "check", code: failure.code, message: failure.message } satisfies CheckResult, { status: failure.status });
    }
    // a lookup that found no working link is an answer, not a failed request (200: the page says what to do)
    return { ok: false, intent: "check", code: "password_link_invalid", message: errors("errors.password_link_invalid") } satisfies CheckResult;
  }
  if (intent === "set") {
    const password = field(form, "password");
    if (password && password !== field(form, "confirm")) {
      return data({ ok: false, intent: "set", code: "invalid", fields: { confirm: serverT(ctx.locale, "admin")("notices.passwordLink.mismatch") } } satisfies SetResult, { status: 400 });
    }
    try {
      await setPasswordWithLink(db, { token, password }, ctx.now, { ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
      return { ok: true, intent: "set" } satisfies SetResult;
    } catch (error) {
      const failure = actionError(error, errors);
      return data({ ok: false, intent: "set", code: failure.code, message: failure.message, fields: failure.fields } satisfies SetResult, { status: failure.status });
    }
  }
  return data({ ok: false, intent: "check", code: "invalid" } satisfies CheckResult, { status: 400 });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("notices.passwordLink.meta"));

export default function Welcome() {
  const t = useAdminT();
  const f = useFormat();
  // undefined: not read yet (server render, before hydration) · "": the address has no token · the token itself
  const [token, setToken] = useState<string | undefined>(undefined);
  const check = useFetcher<CheckResult>({ key: "welcome-check" });
  const save = useFetcher<SetResult>({ key: "welcome-set" });

  // Read once: the address loses the token right after (an effect that runs again — React's development double run, a
  // remount — must not read the emptied address as "no link").
  const read = useRef(false);
  useEffect(() => {
    if (read.current) return;
    read.current = true;
    const fromHash = window.location.hash.replace(/^#/, "").trim();
    setToken(fromHash);
    // the token leaves the address bar and the history entry at once (it stays in this page's memory only)
    if (fromHash) {
      window.history.replaceState(window.history.state, "", window.location.pathname);
      void check.submit({ intent: "check", token: fromHash }, { method: "post" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on the first render in the browser
  }, []);

  const checked = check.data;
  const saved = save.data;
  const link = checked?.ok ? checked.link : null;
  const failure = saved && !saved.ok ? saved : null;
  const checkFailed = checked && !checked.ok ? checked : null;
  const linkGone = Boolean(checkFailed) || failure?.code === "password_link_invalid";
  // "open the full link" helps when the link does not work — not when the page was only asked too often (rate_limited)
  const linkHint = !checkFailed || checkFailed.code === "password_link_invalid";

  return (
    <div className="adm-narrow">
      <header className="adm-page-head">
        <h1 className="adm-title">{saved?.ok ? t("notices.passwordLink.doneTitle") : t("notices.passwordLink.title")}</h1>
        {!saved?.ok ? <p className="max-w-[65ch] type-body text-ink-2">{t("notices.passwordLink.lead")}</p> : null}
      </header>

      <noscript>
        <p className="type-body text-ink">{t("notices.passwordLink.noScript")}</p>
      </noscript>

      {saved?.ok ? (
        <section className="adm-card grid gap-3" aria-live="polite">
          <p className="flex items-center gap-2 type-body text-ink">
            <Icon name="check-circle" size={20} />
            {t("notices.passwordLink.doneText")}
          </p>
          <div>
            {/* a document navigation: the sign-in page sits behind the edge's challenge */}
            <Key as="a" href="/admin/login" variant="ink" icon="sign-in">
              {t("notices.passwordLink.signIn")}
            </Key>
          </div>
        </section>
      ) : token === "" || linkGone ? (
        <section className="adm-card grid gap-2" role="alert">
          {linkGone ? <p className="type-strong text-ink">{(checkFailed ? checkFailed.message : failure?.message) ?? t("notices.passwordLink.noLink")}</p> : null}
          {linkHint ? <p className="type-body text-ink-2">{t("notices.passwordLink.noLink")}</p> : null}
        </section>
      ) : !link ? (
        <p className="type-body text-ink-2" aria-live="polite">
          {t("notices.passwordLink.checking")}
        </p>
      ) : (
        <section className="adm-card grid gap-4" aria-labelledby="welcome-account">
          <dl className="grid gap-1">
            <dt id="welcome-account" className="type-caption text-ink-2">
              {t("notices.passwordLink.account")}
            </dt>
            <dd className="type-strong text-ink">
              <bdi>{link.name}</bdi> · <bdi dir="ltr">{link.email}</bdi>
            </dd>
            <dd className="type-caption text-ink-2">{t("notices.passwordLink.expires", { date: f.dateTime(link.expiresAt) })}</dd>
          </dl>
          {failure && !failure.fields ? (
            <p className="type-body text-red-ink" role="alert">
              {failure.message ?? failure.code}
            </p>
          ) : null}
          <save.Form method="post" className="grid max-w-[24rem] gap-3">
            <input type="hidden" name="intent" value="set" />
            <input type="hidden" name="token" value={token ?? ""} />
            {/* the account's email for the browser's password manager */}
            <input type="email" name="username" autoComplete="username" value={link.email} readOnly hidden />
            <TextField label={t("notices.passwordLink.password")} hint={t("notices.passwordLink.passwordHint")} name="password" type="password" autoComplete="new-password" minLength={12} required error={failure?.fields?.password} />
            <TextField label={t("notices.passwordLink.confirm")} name="confirm" type="password" autoComplete="new-password" minLength={12} required error={failure?.fields?.confirm} />
            <div>
              <Key type="submit" variant="ink" icon="lock" loading={save.state !== "idle"}>
                {t("notices.passwordLink.submit")}
              </Key>
            </div>
          </save.Form>
        </section>
      )}
    </div>
  );
}
