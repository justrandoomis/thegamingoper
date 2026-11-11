import { useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/template";
import { getTemplate, saveTemplate } from "~/server/services/admin/settings/templates.server";
import { TEMPLATE_LOCALES, TEMPLATE_MAX_LENGTH, renderTemplate, templateVariables, type TemplateLocale } from "~/server/services/admin/settings/catalog";
import { can } from "~/server/actor";
import { invalid } from "~/server/errors";
import { Checkbox, TextArea } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { Code, FormError, Note, PageHead, Section, When, failureText, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { checked, ok, optional, text } from "../security/route-kit.server";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/templates/:key — 22.04: one message's text per language: the variables it may use (anything else is
 * refused) and must keep, a preview with sample values, at most one long SMS. Saved per language, guarded on the
 * version the form was built on, audited. Nothing is sent: no message provider is connected.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, now } = await settingsKit.open(context, "settings.read");
  return { template: await settingsKit.orRespond(() => getTemplate(db, actor, params.key, now)), canManage: can(actor, "settings.template.manage") };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await settingsKit.open(context, "settings.template.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "save") throw invalid({ intent: "invalid" });
    return ok(intent, await saveTemplate(req.db, req.actor, { key: params.key, locale: text(form, "locale"), body: text(form, "body"), isActive: checked(form, "isActive"), version: text(form, "version"), reason: optional(form, "reason") }, req.now));
  } catch (error) {
    return settingsKit.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "templates.title");

type Template = Route.ComponentProps["loaderData"]["template"];

function LocaleForm({ template, locale, canManage }: { template: Template; locale: TemplateLocale; canManage: boolean }) {
  const t = useModuleT();
  const stored = template.texts[locale];
  const [body, setBody] = useState(stored?.body ?? "");
  const [active, setActive] = useState(stored?.isActive ?? true);
  const fetcher = useFetcher<{ ok: boolean } & Record<string, unknown>>();
  const used = templateVariables(body);
  const unknown = used.filter((name) => !(template.variables as readonly string[]).includes(name));
  const missing = template.required.filter((name) => !used.includes(name));
  const fieldError = (fetcher.data as { fields?: Record<string, string> } | undefined)?.fields?.body;
  return (
    <fetcher.Form method="post" className="adm-card grid gap-2" noValidate>
      <input type="hidden" name="intent" value="save" />
      <input type="hidden" name="locale" value={locale} />
      <input type="hidden" name="version" value={template.versions[locale] === null ? "" : String(template.versions[locale])} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="adm-h3">{t(`lang.${locale}`)}</h3>
        {stored ? (
          <span className="type-caption text-ink-2">
            {t("template.updated")} <When at={stored.updatedAt} />
          </span>
        ) : (
          <Status tone="warn">{t("templates.missing")}</Status>
        )}
      </div>
      <TextArea name="body" label={t("template.body")} rows={4} value={body} onChange={(event) => setBody(event.currentTarget.value)} maxLength={TEMPLATE_MAX_LENGTH} readOnly={!canManage} dir={locale === "en" ? "ltr" : "rtl"} error={fieldError} hint={t("template.length", { count: body.length, max: TEMPLATE_MAX_LENGTH })} />
      {unknown.length ? <p className="type-caption text-red-ink">{t("template.unknown", { names: unknown.join(", ") })}</p> : null}
      {missing.length && body.trim() ? <p className="type-caption text-red-ink">{t("template.missingVars", { names: missing.join(", ") })}</p> : null}
      <div className="grid gap-1">
        <span className="type-caption text-ink-2">{t("template.preview")}</span>
        <p className="sec-pre" dir={locale === "en" ? "ltr" : "rtl"}>
          {body ? renderTemplate(body) : "—"}
        </p>
      </div>
      <Checkbox name="isActive" label={t("template.active")} checked={active} onChange={(event) => setActive(event.currentTarget.checked)} disabled={!canManage} />
      <FormError message={fetcher.data && !fetcher.data.ok && !fieldError ? failureText(t, fetcher.data) : null} />
      {fetcher.data?.ok && fetcher.state === "idle" ? (
        <p role="status" className="type-label text-ok">
          {t("template.saved")}
        </p>
      ) : null}
      {canManage ? (
        <div>
          <Key type="submit" size="sm" variant="ink" icon="floppy-disk" disabled={!body.trim() || unknown.length > 0 || missing.length > 0} loading={fetcher.state !== "idle"}>
            {t("template.save")}
          </Key>
        </div>
      ) : null}
    </fetcher.Form>
  );
}

export default function TemplatePage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const { template } = loaderData;
  const { canManage } = loaderData;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/settings/templates" className="adm-link">
            {t("templates.title")}
          </Link>
        }
        title={t(`template.${template.key}`)}
        lead={t("template.lead")}
      />
      <Note>
        <p>
          {t("template.variables")}{" "}
          {template.variables.map((name) => (
            <Code key={name} className="me-2">{`{${name}}`}</Code>
          ))}
        </p>
        {template.required.length ? <p>{t("template.required", { names: template.required.map((name) => `{${name}}`).join(", ") })}</p> : null}
        <p>{t("templates.boundary")}</p>
      </Note>
      <Section id="texts" title={t("template.texts")} className="mt-4">
        <div className="grid gap-3 lg:grid-cols-3">
          {TEMPLATE_LOCALES.map((locale) => (
            <LocaleForm key={`${locale}:${template.versions[locale] ?? "new"}`} template={template} locale={locale} canManage={canManage} />
          ))}
        </div>
      </Section>
    </>
  );
}
