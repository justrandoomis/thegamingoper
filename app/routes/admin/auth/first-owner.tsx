import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/first-owner";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { useT } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { adminSecrets } from "../shell/env.server";
import { AuthFrame } from "./AuthFrame";
import { setupAction, setupLoader, type SetupFailure } from "./first-owner.server";

/**
 * /admin/setup — the first owner, once (./first-owner.server.ts). A 404 as soon as any employee exists. In production the
 * edge puts a managed challenge in front of this path (docs/SECURITY.md §13).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const page = await setupLoader(getDb(), adminSecrets());
  return data({ ...page, i18n: messagesFor(ctx.locale, "admin-auth", "errors") }, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" } });
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const result = await setupAction(ctx, getDb(), adminSecrets(), await request.formData());
  if (result instanceof Response) return result;
  return data(result, { status: result.status, headers: { "Cache-Control": "no-store" } });
}

export function headers() {
  return { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
}

export const meta: Route.MetaFunction = ({ loaderData }) => {
  const tree = loaderData?.i18n["admin-auth"] as { meta?: { setup?: string; suffix?: string } } | undefined;
  return [{ title: tree?.meta ? `${tree.meta.setup} · ${tree.meta.suffix}` : "TamTam" }, { name: "robots", content: "noindex, nofollow" }];
};

export default function AdminSetup({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("admin-auth");
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formMethod?.toUpperCase() === "POST";
  const failure = actionData as SetupFailure | undefined;
  const disabled = loaderData.state === "disabled" || failure?.code === "setup_disabled";

  if (disabled) {
    return (
      <AuthFrame>
        <div className="grid gap-3">
          <h1 className="type-title">{t("setup.disabledTitle")}</h1>
          <p className="adm-notice adm-notice--warn">
            <Icon name="lock" size={18} />
            <span>{t("setup.disabledText")}</span>
          </p>
        </div>
      </AuthFrame>
    );
  }

  return (
    <AuthFrame>
      <Form method="post" className="grid gap-4" noValidate>
        <div className="grid gap-1">
          <h1 className="type-title">{t("setup.title")}</h1>
          <p className="type-body text-ink-2">{t("setup.lead")}</p>
        </div>
        {failure?.message ? (
          <p className="adm-notice adm-notice--bad" role="alert">
            <Icon name="warning-circle" size={18} />
            <span>{failure.message}</span>
          </p>
        ) : null}
        <TextField
          label={t("setup.token")}
          hint={t("setup.tokenHint")}
          name="setupToken"
          type="password"
          autoComplete="off"
          spellCheck={false}
          required
          ltr
          error={failure?.fields?.setupToken}
          autoFocus
        />
        <TextField label={t("setup.name")} name="name" autoComplete="name" required defaultValue={failure?.values.name ?? ""} error={failure?.fields?.name} />
        <TextField label={t("setup.email")} hint={t("setup.emailHint")} name="email" type="email" autoComplete="username" required defaultValue={failure?.values.email ?? ""} error={failure?.fields?.email} />
        <TextField label={t("setup.password")} hint={t("setup.passwordHint")} name="password" type="password" autoComplete="new-password" required error={failure?.fields?.password} />
        <TextField label={t("setup.confirm")} name="confirm" type="password" autoComplete="new-password" required error={failure?.fields?.confirm} />
        <Key type="submit" variant="ink" block loading={busy} icon="user-gear">
          {t("setup.submit")}
        </Key>
        <p className="type-caption text-ink-2">{t("setup.after")}</p>
      </Form>
    </AuthFrame>
  );
}
