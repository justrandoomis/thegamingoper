import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/providers";
import { can } from "~/server/actor";
import { clearProviderCredentials, listProviders, saveProviderCredentials, type ProviderView } from "~/server/services/admin/channels/providers.server";
import { PROVIDER_KINDS } from "~/server/services/admin/channels/types";
import { Disclosure } from "~/ui/Disclosure";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog, Code, DialogKey, FormError, Note, PageHead, Section, StatusText, When, failureText, useChT } from "./components/ui";
import { ch, dataKey, ok, text } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/providers — 21.05: payment, shipping and messaging providers that operate in Iraq (the store's own
 * couriers from module 11 among the shipping ones), each NOT CONNECTED: no adapter talks to any of them, so nothing
 * here can show "connected" or claim a test passed. Who manages integrations (channels.integration.manage, the owner by
 * default) may keep a provider's settings and its secret ready — the secret is encrypted with DATA_KEY, never shown
 * again, never logged — and remove the secret again; both with a reason, audited.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args);
  const providers = await ch.orRespond(() => listProviders(req.db, req.actor, req.locale));
  return { providers, manage: can(req.actor, "channels.integration.manage"), canEncrypt: Boolean(dataKey()), carriersLink: can(req.actor, "shipping.carrier.manage") ? "/admin/shipping/carriers" : null };
}

export async function action(args: Route.ActionArgs) {
  const req = await ch.open(args, "channels.integration.manage");
  const form = await ch.form(args.request).catch(() => new FormData());
  const intent = text(form, "intent");
  const provider = text(form, "provider");
  try {
    if (intent === "save") {
      const config: Record<string, string> = {};
      for (const [name, value] of form.entries()) if (name.startsWith("config.") && typeof value === "string") config[name.slice(7)] = value;
      const result = await saveProviderCredentials(req.db, req.actor, dataKey(), { provider, config, secret: text(form, "secret") || undefined, expected: text(form, "expected"), reason: text(form, "reason") }, req.now);
      return ok("save", { provider, changed: result.changed });
    }
    if (intent === "clear") {
      const result = await clearProviderCredentials(req.db, req.actor, { provider, reason: text(form, "reason") }, req.now);
      return ok("clear", { provider, changed: result.changed });
    }
    throw new Response(null, { status: 400 });
  } catch (error) {
    return ch.failed(error, req, intent, { provider });
  }
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "providers.title");

export default function ProvidersPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const { providers, manage, canEncrypt, carriersLink } = loaderData;
  const result = useActionData<typeof action>();
  return (
    <>
      <PageHead title={t("providers.title")} lead={t("providers.lead")} />
      <Note tone="warn" icon="warning">
        <p>{t("providers.boundary")}</p>
        <p>{t("providers.list")}</p>
      </Note>
      {manage && !canEncrypt ? (
        <Note tone="bad" icon="warning-circle">
          <p>{t("errors.data_key_missing")}</p>
        </Note>
      ) : null}
      {PROVIDER_KINDS.map((kind) => {
        const rows = providers.filter((provider) => provider.kind === kind);
        return (
          <Section key={kind} id={`ch-providers-${kind}`} title={t(`providers.kind.${kind}`)}>
            <p className="type-caption text-ink-2">{t(`providers.kindNote.${kind}`)}</p>
            {rows.length ? (
              <ul role="list" className="ch-cards">
                {rows.map((provider) => (
                  <ProviderCard key={provider.key} provider={provider} manage={manage} result={result && "provider" in result && result.provider === provider.key ? result : null} />
                ))}
              </ul>
            ) : (
              <p className="type-body text-ink-2">
                {t("providers.noCarriers")}{" "}
                {carriersLink ? (
                  <Link to={carriersLink} className="adm-link">
                    {t("providers.openCarriers")}
                  </Link>
                ) : null}
              </p>
            )}
          </Section>
        );
      })}
    </>
  );
}

type Result = { ok: boolean; intent?: string | null; fields?: Record<string, string>; message?: string; code?: string; changed?: boolean } | null;

function ProviderCard({ provider, manage, result }: { provider: ProviderView; manage: boolean; result: Result }) {
  const t = useChT();
  const navigation = useNavigation();
  const saving = navigation.state !== "idle" && navigation.formData?.get("intent") === "save" && navigation.formData?.get("provider") === provider.key;
  const saveResult = result?.intent === "save" ? result : null;
  const fields = (saveResult && !saveResult.ok ? saveResult.fields : undefined) ?? {};
  return (
    // content-start: a card beside an opened one is as tall as it, without spreading its own lines over that height
    <li className="adm-card content-start gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="type-strong text-ink">
            <bdi>{provider.name}</bdi>
            {provider.carrier ? (
              <>
                {" "}
                · <Code>{provider.carrier.code}</Code>
              </>
            ) : null}
          </p>
          {provider.carries.length ? <p className="type-caption text-ink-2">{t("providers.carries", { list: provider.carries.map((channel) => t(`outbox.${channel}`)).join(t("common.listSep")) })}</p> : null}
          {provider.carrier?.isDemo ? <p className="type-caption text-ink-2">{t("providers.demoCarrier")}</p> : null}
        </div>
        <StatusText tone="warn">{t("providers.notConnected")}</StatusText>
      </div>
      <dl className="ch-facts type-data">
        <dt>{t("providers.secret")}</dt>
        <dd>{provider.hasSecret ? t("providers.secretSaved") : t("providers.secretNone")}</dd>
        {Object.keys(provider.config).length ? (
          <>
            <dt>{t("providers.settings")}</dt>
            <dd>
              {Object.entries(provider.config).map(([key, value]) => (
                <span key={key} className="block">
                  {t(`providers.field.${key}`)}: <Code>{value}</Code>
                </span>
              ))}
            </dd>
          </>
        ) : null}
        {provider.savedAt ? (
          <>
            <dt>{t("providers.savedBy")}</dt>
            <dd>
              {provider.savedBy?.name ?? "—"} · <When at={provider.savedAt} />
            </dd>
          </>
        ) : null}
      </dl>
      {saveResult?.ok ? <p className="type-caption text-ink-2">{t(saveResult.changed ? "providers.saved" : "branch.unchanged")}</p> : null}
      {manage ? (
        <div className="grid gap-2">
          <Disclosure summary={t(provider.hasSecret ? "providers.change" : "providers.prepare")} defaultOpen={Boolean(saveResult && !saveResult.ok)}>
            <Form method="post" className="grid gap-3" noValidate autoComplete="off">
              <input type="hidden" name="intent" value="save" />
              <input type="hidden" name="provider" value={provider.key} />
              <input type="hidden" name="expected" value={provider.expected === null ? "" : String(provider.expected)} />
              {provider.fields.map((field) => (
                <TextField
                  key={field.key}
                  name={`config.${field.key}`}
                  type={field.url ? "url" : undefined}
                  placeholder={field.url ? "https://" : undefined}
                  hint={field.url ? t("webhooks.field.urlHint") : undefined}
                  label={t(`providers.field.${field.key}`)}
                  optional
                  ltr={field.ltr}
                  maxLength={field.max}
                  defaultValue={provider.config[field.key] ?? ""}
                  error={fields[`config.${field.key}`]}
                />
              ))}
              <TextField
                name="secret"
                type="password"
                autoComplete="new-password"
                label={t("providers.field.secret")}
                hint={provider.hasSecret ? t("providers.field.secretKeep") : t("providers.field.secretHint")}
                required={!provider.hasSecret}
                optional={provider.hasSecret}
                ltr
                maxLength={2000}
                error={fields.secret}
              />
              <TextField name="reason" label={t("common.reason")} required maxLength={500} error={fields.reason} />
              <FormError message={saveResult && !saveResult.ok ? (saveResult.fields ? t("common.checkFields") : failureText(t, saveResult)) : null} />
              <p className="type-caption text-ink-2">{t("providers.saveNote")}</p>
              <div className="ch-actions">
                <Key type="submit" size="sm" variant="ink" icon="lock" loading={saving}>
                  {t("providers.save")}
                </Key>
              </div>
            </Form>
          </Disclosure>
          {provider.hasSecret ? (
            <div className="ch-actions">
              <DialogKey label={t("providers.clear")} icon="trash" variant="ghost">
                {(close) => (
                  <ActionDialog
                    open
                    onClose={close}
                    title={t("providers.clearTitle", { name: provider.name })}
                    consequence={t("providers.clearText")}
                    confirmLabel={t("providers.clear")}
                    tone="destructive"
                    reason
                    fields={{ intent: "clear", provider: provider.key }}
                    successMessage={t("providers.cleared")}
                  />
                )}
              </DialogKey>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
