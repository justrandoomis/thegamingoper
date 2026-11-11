import { data, Form, useNavigation } from "react-router";

import type { Route } from "./+types/profile";
import { LocaleLink, useT } from "~/i18n/react";
import { LOCALE_CODES } from "~/lib/locales";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getProfile, updateProfile, type UpdateProfileInput } from "~/server/services/account/profile.server";
import { FieldGroup, Radio, TextField } from "~/ui/Field";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { accountFailure, formFields, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { AnswerNotice, fieldError, FormNotice, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";

/** Name, e-mail and the language of the store's messages. The phone number is the sign-in name and is shown, not edited. */
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
  return (
    <>
      <PageHead title={t("profile.title")} />
      {answer?.ok ? <FormNotice tone="ok">{t("profile.saved")}</FormNotice> : null}
      {failed && failed.code !== "invalid" ? <AnswerNotice answer={failed} /> : null}
      <Form method="post" className="grid max-w-[40rem] gap-5 rounded-lg bg-paper p-4 sm:p-6" noValidate>
        <div className="grid gap-1">
          <span className="field__label">{t("profile.phone")}</span>
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <bdi dir="ltr" className="type-sub nums text-ink">
              {profile.phoneMasked}
            </bdi>
            <Status tone={profile.phoneVerified ? "ok" : "neutral"}>{t(profile.phoneVerified ? "common.verified" : "common.unverified")}</Status>
            {!profile.phoneVerified ? (
              <TextLink as={LocaleLink} to="/account/settings#phone">
                {t("profile.verify")}
              </TextLink>
            ) : null}
          </p>
          <p className="field__hint">{t("profile.phoneHint")}</p>
        </div>
        <TextField name="name" autoComplete="name" label={t("profile.name")} optional defaultValue={values?.name ?? profile.name ?? ""} error={fieldError(failed, "name")} />
        <TextField name="email" type="email" autoComplete="email" label={t("profile.email")} hint={t("profile.emailHint")} optional defaultValue={values?.email ?? profile.email ?? ""} error={fieldError(failed, "email")} />
        <FieldGroup legend={t("profile.locale")} hint={t("profile.localeHint")} error={fieldError(failed, "locale")}>
          {LOCALE_CODES.map((code) => (
            <Radio key={code} row name="locale" value={code} label={<span lang={code}>{t(`profile.languages.${code}`)}</span>} defaultChecked={(values?.locale ?? profile.locale) === code} />
          ))}
        </FieldGroup>
        <SubmitKey pending={pending} icon="floppy-disk" className="justify-self-start">
          {t("profile.save")}
        </SubmitKey>
      </Form>
    </>
  );
}
