import { useEffect, useState } from "react";
import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/sign-in";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";
import { adminSecrets } from "../shell/env.server";
import { AuthFrame } from "./AuthFrame";
import { loginAction, loginLoader, type LoginFailure } from "./sign-in.server";

/**
 * /admin/login — see ./sign-in.server.ts for the rules (lockout wording, recovery codes, the same-site hop for links from
 * other sites, `next` validation). No caching, never indexed.
 */
export async function loader({ request, context, url }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const page = await loginLoader(ctx, getDb(), request, url);
  return data({ ...page, i18n: messagesFor(ctx.locale, "admin-auth", "errors") }, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}

export async function action({ request, context, url }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const result = await loginAction(ctx, getDb(), adminSecrets(), url, await request.formData());
  if (result instanceof Response) return result;
  return data(result, { status: result.ok ? 200 : result.status, headers: { "Cache-Control": "no-store" } });
}

export function headers() {
  return { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
}

export const meta: Route.MetaFunction = ({ loaderData }) => {
  const tree = loaderData?.i18n["admin-auth"] as { meta?: { login?: string; suffix?: string } } | undefined;
  return [{ title: tree?.meta ? `${tree.meta.login} · ${tree.meta.suffix}` : "TamTam" }, { name: "robots", content: "noindex, nofollow" }];
};

export default function AdminLogin({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("admin-auth");
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const failure = actionData && !actionData.ok ? (actionData as LoginFailure) : null;
  const step = actionData?.step ?? loaderData.step;
  const [recovery, setRecovery] = useState(false);

  // The same-site hop: re-request this page from its own origin so the SameSite=Strict session cookie is sent.
  useEffect(() => {
    if (loaderData.hop) window.location.replace(loaderData.hop);
  }, [loaderData.hop]);

  if (loaderData.hop) {
    return (
      <AuthFrame>
        <div className="grid gap-4" role="status">
          <p className="flex items-center gap-2 type-body text-ink">
            <Icon name="circle-notch" size={20} className="animate-spin motion-reduce:animate-none" />
            {t("login.checking")}
          </p>
          <TextLink href={loaderData.hop}>
            {t("login.continue")}
          </TextLink>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      {loaderData.notice && !failure ? (
        <p className="adm-notice adm-notice--ok" role="status">
          <Icon name="check-circle" size={18} />
          <span>{t(`login.notice.${loaderData.notice}`)}</span>
        </p>
      ) : null}

      {step === "password" ? (
        <Form method="post" className="grid gap-4" noValidate>
          <div className="grid gap-1">
            <h1 className="type-title">{t("login.title")}</h1>
            <p className="type-body text-ink-2">{t("login.lead")}</p>
          </div>
          <input type="hidden" name="intent" value="password" />
          <input type="hidden" name="next" value={loaderData.next} />
          {failure ? (
            <p className="adm-notice adm-notice--bad" role="alert">
              <Icon name="warning-circle" size={18} />
              <span>{failure.message}</span>
            </p>
          ) : null}
          <TextField
            label={t("login.email")}
            name="email"
            type="email"
            autoComplete="username"
            required
            defaultValue={failure?.email ?? ""}
            error={failure?.fields?.email}
            autoFocus
          />
          <TextField label={t("login.password")} name="password" type="password" autoComplete="current-password" required error={failure?.fields?.password && failure.code !== "invalid_credentials" ? failure.fields.password : undefined} />
          <Key type="submit" variant="ink" block loading={busy} icon="sign-in">
            {t("login.submit")}
          </Key>
        </Form>
      ) : (
        <div className="grid gap-4">
          <Form method="post" className="grid gap-4" noValidate>
            <div className="grid gap-1">
              <h1 className="type-title">{t("login.codeTitle")}</h1>
              <p className="type-body text-ink-2">
                {t("login.codeLead", { email: "⁨" + (loaderData.email ?? "") + "⁩" })}
              </p>
            </div>
            <input type="hidden" name="intent" value="code" />
            <input type="hidden" name="next" value={loaderData.next} />
            {recovery ? (
              <TextField
                key="recovery"
                label={t("login.recovery")}
                hint={t("login.recoveryHint")}
                name="code"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                ltr
                required
                maxLength={40}
                error={failure?.message}
                autoFocus
              />
            ) : (
              <TextField
                key="app"
                label={t("login.code")}
                hint={t("login.codeHint")}
                name="code"
                inputMode="numeric"
                autoComplete="one-time-code"
                required
                maxLength={8}
                error={failure?.message}
                autoFocus
              />
            )}
            <Key type="submit" variant="ink" block loading={busy} icon="shield-check">
              {t("login.codeSubmit")}
            </Key>
          </Form>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <TextLink as="button" type="button" arrow={false} aria-pressed={recovery} onClick={() => setRecovery((on) => !on)}>
              {recovery ? t("login.useApp") : t("login.useRecovery")}
            </TextLink>
            <Form method="post">
              <input type="hidden" name="intent" value="restart" />
              <input type="hidden" name="next" value={loaderData.next} />
              <TextLink as="button" type="submit" arrow={false}>
                {t("login.restart")}
              </TextLink>
            </Form>
          </div>
        </div>
      )}
    </AuthFrame>
  );
}
