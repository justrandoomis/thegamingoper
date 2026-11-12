import { useEffect, useRef } from "react";
import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/profile";
import { useT } from "~/i18n/react";
import { LOCALE_CODES, LOCALES } from "~/lib/locales";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getProfile, updateProfile, type UpdateProfileInput } from "~/server/services/account/profile.server";
import { FieldGroup, Radio, TextField } from "~/ui/Field";
import { Segmented } from "~/ui/Segmented";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { accountFailure, formFields, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { fieldError, FormFailure, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { useHydrated } from "./components/useHydrated";

/**
 * Name, e-mail and the language of the store's messages — one card width (Design System v2 §6.12). The phone number is
 * the sign-in name: shown, not edited (changing it needs a person).
 */
export const handle = { nav: "push", order: sectionOrder("profile") } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const profile = await getProfile(db, customer.id);
  if (!profile) throw data({ error: "not_found" }, { status: 404 });
  return { profile };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireSignedIn(request, ctx, db);
  const fields = formFields(await request.formData());
  try {
    // Raw strings from the form; the service parses and validates them (zod).
    await updateProfile(db, actor, { name: fields.name ?? "", email: fields.email ?? "", locale: fields.locale } as UpdateProfileInput, ctx.now);
    return data({ ok: true as const, done: "saved" as const });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data({ ...failure, values: fields }, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "profile");

export default function Profile({ loaderData, actionData }: Route.ComponentProps) {
  const t = useT("account");
  const navigation = useNavigation();
  const { profile } = loaderData;
  const answer = (actionData ?? null) as (ActionAnswer & { values?: Record<string, string> }) | null;
  const failed = answer && answer.ok === false ? answer : null;
  const values = failed?.values;
  const pending = navigation.state === "submitting";
  const hydrated = useHydrated();
  const locale = values?.locale ?? profile.locale;

  // Saved: a toast (§6.17), once per answer.
  const told = useRef<unknown>(null);
  useEffect(() => {
    if (!answer?.ok || told.current === answer) return;
    told.current = answer;
    toast.success(t("profile.saved"));
  }, [answer, t]);

  return (
    <>
      <PageHead title={t("profile.title")} lead={t("profile.lead")} />
      <Form method="post" className="acct-card acct-narrow" noValidate>
        <FormFailure
          answer={failed}
          fields={[
            { name: "name", id: "profile-name", label: t("profile.name") },
            { name: "email", id: "profile-email", label: t("profile.email") },
          ]}
        />
        <div className="grid gap-1">
          <span className="field__label">{t("profile.phone")}</span>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <bdi dir="ltr" className="type-card nums text-ink">
              {profile.phoneMasked}
            </bdi>
            {profile.phoneVerified ? <Status tone="ok">{t("common.verified")}</Status> : null}
          </p>
          <p className="field__hint">{t("profile.phoneHint")}</p>
        </div>
        <TextField id="profile-name" name="name" autoComplete="name" label={t("profile.name")} optional defaultValue={values?.name ?? profile.name ?? ""} error={fieldError(failed, "name")} />
        <TextField id="profile-email" name="email" type="email" autoComplete="email" label={t("profile.email")} hint={t("profile.emailHint")} optional defaultValue={values?.email ?? profile.email ?? ""} error={fieldError(failed, "email")} />
        {/*
          The segmented control needs script: it takes the field's name once script runs. Until then — and for good
          without script (it is hidden then) — the same choice is native radios inside <noscript>, as before the v2
          rebuild. Never both: the form sends one locale.
        */}
        <div className="field noscript:hidden">
          <span className="field__label" id="profile-locale-label">
            {t("profile.locale")}
          </span>
          <Segmented
            aria-labelledby="profile-locale-label"
            name={hydrated ? "locale" : undefined}
            defaultValue={locale}
            options={LOCALE_CODES.map((code) => ({ value: code, label: t(`profile.languages.${code}`), lang: LOCALES[code].bcp47 }))}
          />
          <p className="field__hint">{t("profile.localeHint")}</p>
          {fieldError(failed, "locale") ? <p className="field__error">{fieldError(failed, "locale")}</p> : null}
        </div>
        <noscript>
          <FieldGroup legend={t("profile.locale")} hint={t("profile.localeHint")} error={fieldError(failed, "locale")} layout="row">
            {LOCALE_CODES.map((code) => (
              <Radio key={code} name="locale" value={code} label={<span lang={LOCALES[code].bcp47}>{t(`profile.languages.${code}`)}</span>} defaultChecked={locale === code} />
            ))}
          </FieldGroup>
        </noscript>
        <SubmitKey variant="primary" pending={pending} icon="floppy-disk" className="pt-1">
          {t("profile.save")}
        </SubmitKey>
      </Form>
    </>
  );
}
