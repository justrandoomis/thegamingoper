import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/api-keys";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { createApiKey, listApiKeys, revokeApiKey, type ApiKeyRow } from "~/server/services/admin/channels/apikeys.server";
import { API_EXPIRY_CHOICES, API_EXPIRY_DEFAULT, API_KEY_STATE_TONE, API_RATE_DEFAULT, API_RATE_MAX, API_SCOPES } from "~/server/services/admin/channels/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, FieldGroup, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog, Code, DialogKey, FormError, Note, OnceSecret, PageHead, Pair, ResponsiveList, Section, StatusText, When, failureText, useChT } from "./components/ui";
import { all, ch, newKey, ok, text } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/api — 21.03: keys for the read-only API (channels.api_key.manage, the owner by default). Create a
 * key with a name, its scopes (only those the creator holds), an expiry and a rate a minute — the key is shown ONCE
 * on the page that created it (only its SHA-256 is stored); revoke one with a reason. Every change is audited; the
 * API itself is documented on /admin/channels/api/docs.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args, "channels.api_key.manage");
  const keys = await ch.orRespond(() => listApiKeys(req.db, req.actor, req.now));
  // the API reads every branch: an employee limited to one is not offered the form (the service refuses it too)
  return { keys, held: API_SCOPES.filter((scope) => can(req.actor, scope)), key: newKey(), now: req.now, limited: Boolean(req.actor.branchId) };
}

export async function action(args: Route.ActionArgs) {
  const req = await ch.open(args, "channels.api_key.manage");
  const form = await ch.form(args.request).catch(() => new FormData());
  const intent = text(form, "intent");
  try {
    if (intent === "create") {
      const result = await createApiKey(
        req.db,
        req.actor,
        { name: text(form, "name"), scopes: all(form, "scope"), expiresInDays: text(form, "expiresInDays"), rateLimitPerMin: text(form, "rateLimitPerMin"), reason: text(form, "reason"), idempotencyKey: text(form, "formKey") },
        req.now,
      );
      return ok("create", { secret: result.key, prefix: result.prefix, replayed: result.replayed });
    }
    if (intent === "revoke") {
      const result = await revokeApiKey(req.db, req.actor, { keyId: text(form, "keyId"), reason: text(form, "reason") }, req.now);
      return ok("revoke", { changed: result.changed });
    }
    throw new Response(null, { status: 400 });
  } catch (error) {
    return ch.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "apiKeys.title");

export default function ApiKeysPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const f = useFormat();
  const { keys, held, now, limited } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const creating = navigation.state !== "idle" && navigation.formData?.get("intent") === "create";
  const created = result?.intent === "create" && result.ok ? result : null;
  const createFailure = result?.intent === "create" && !result.ok ? result : null;
  const fields = createFailure?.fields ?? {};
  const scopesText = (row: ApiKeyRow) => row.scopes.map((scope) => t(`scope.${scope}`)).join(t("common.listSep"));
  const revoke = (row: ApiKeyRow) =>
    row.state === "revoked" ? null : (
      <DialogKey label={t("apiKeys.revoke")} icon="x-circle" variant="ghost">
        {(close) => (
          <ActionDialog
            open
            onClose={close}
            title={t("apiKeys.revokeTitle", { name: row.name })}
            consequence={t("apiKeys.revokeText")}
            confirmLabel={t("apiKeys.revoke")}
            tone="destructive"
            impact={[{ label: t("apiKeys.col.scopes"), value: scopesText(row) }]}
            reason
            fields={{ intent: "revoke", keyId: row.id }}
            successMessage={t("apiKeys.revoked")}
          />
        )}
      </DialogKey>
    );
  const columns: DataColumn<ApiKeyRow>[] = [
    { key: "name", header: t("apiKeys.col.name"), cell: (row) => <span className="type-strong">{row.name}</span> },
    { key: "prefix", header: t("apiKeys.col.prefix"), cell: (row) => <Code className="whitespace-nowrap">{`${row.prefix}_…`}</Code> },
    { key: "scopes", header: t("apiKeys.col.scopes"), cell: scopesText },
    { key: "rate", header: t("apiKeys.col.rate"), numeric: true, cell: (row) => f.number(row.rateLimitPerMin) },
    { key: "created", header: t("apiKeys.col.created"), cell: (row) => <span>{row.createdBy?.name ?? "—"} · <When at={row.createdAt} kind="date" /></span> },
    { key: "used", header: t("apiKeys.col.used"), cell: (row) => <When at={row.lastUsedAt} /> },
    { key: "expires", header: t("apiKeys.col.expires"), cell: (row) => <When at={row.expiresAt} kind="date" /> },
    { key: "state", header: t("apiKeys.col.state"), cell: (row) => <StatusText tone={API_KEY_STATE_TONE[row.state]}>{t(`apiKeys.state.${row.state}`)}</StatusText> },
    { key: "actions", header: t("apiKeys.col.actions"), cell: revoke },
  ];

  return (
    <>
      <PageHead
        title={t("apiKeys.title")}
        lead={t("apiKeys.lead")}
        actions={
          <Key as={Link} to="/admin/channels/api/docs" icon="book-open">
            {t("apiKeys.docs")}
          </Key>
        }
      />
      <Note tone="warn" icon="warning">
        <p>{t("apiKeys.routeNote")}</p>
      </Note>

      {created ? (
        created.secret ? (
          <OnceSecret title={t("apiKeys.createdTitle")} value={created.secret} note={t("apiKeys.createdNote")} />
        ) : (
          <Note tone="warn" icon="warning">
            <p>{t("apiKeys.replayedNote", { prefix: created.prefix })}</p>
          </Note>
        )
      ) : null}

      <Section
        id="ch-keys"
        title={t("apiKeys.list")}
        aside={<span className="type-caption text-ink-2">{t("apiKeys.counts", { active: f.number(keys.counts.active), suspended: f.number(keys.counts.suspended), expired: f.number(keys.counts.expired), revoked: f.number(keys.counts.revoked) })}</span>}
      >
        {keys.counts.suspended > 0 ? (
          <Note tone="bad" icon="warning-circle">
            <p>{t("apiKeys.suspendedNote")}</p>
          </Note>
        ) : null}
        <ResponsiveList
          caption={t("apiKeys.list")}
          columns={columns}
          rows={keys.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState icon="key" title={t("apiKeys.empty")} text={t("apiKeys.emptyHint")} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="type-strong">{row.name}</span>
                <StatusText tone={API_KEY_STATE_TONE[row.state]}>{t(`apiKeys.state.${row.state}`)}</StatusText>
              </div>
              <Pair label={t("apiKeys.col.prefix")}>
                <Code>{`${row.prefix}_…`}</Code>
              </Pair>
              <Pair label={t("apiKeys.col.scopes")}>{scopesText(row)}</Pair>
              <Pair label={t("apiKeys.col.expires")}>
                <When at={row.expiresAt} kind="date" />
              </Pair>
              <Pair label={t("apiKeys.col.used")}>
                <When at={row.lastUsedAt} />
              </Pair>
              <div className="ch-actions">{revoke(row)}</div>
            </>
          )}
        />
        {keys.rows.some((row) => row.state === "active" && row.expiresAt !== null && row.expiresAt - now < 14 * 86_400_000) ? <p className="type-caption text-ink-2">{t("apiKeys.expiringNote")}</p> : null}
      </Section>

      <Section id="ch-key-new" title={t("apiKeys.new")}>
        {limited ? (
          <Note tone="warn" icon="lock">
            <p>{t("apiKeys.limitedNote")}</p>
          </Note>
        ) : (
          <Form method="post" className="grid max-w-[44rem] gap-4" noValidate>
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="formKey" value={loaderData.key} />
            <TextField name="name" label={t("apiKeys.field.name")} hint={t("apiKeys.field.nameHint")} required maxLength={80} error={fields.name} />
            <FieldGroup legend={t("apiKeys.field.scopes")} hint={t("apiKeys.field.scopesHint")} required error={fields.scopes}>
              {API_SCOPES.map((scope) => (
                <Checkbox key={scope} name="scope" value={scope} label={t(`scope.${scope}`)} hint={held.includes(scope) ? t(`scopeHint.${scope}`) : t("apiKeys.field.notHeld")} disabled={!held.includes(scope)} />
              ))}
            </FieldGroup>
            <div className="ch-form ch-form--two">
              <Select name="expiresInDays" label={t("apiKeys.field.expiry")} defaultValue={String(API_EXPIRY_DEFAULT)} options={API_EXPIRY_CHOICES.map((days) => ({ value: String(days), label: t("apiKeys.field.days", { count: days }) }))} error={fields.expiresInDays} />
              <TextField name="rateLimitPerMin" label={t("apiKeys.field.rate")} hint={t("apiKeys.field.rateHint", { max: f.number(API_RATE_MAX) })} inputMode="numeric" ltr defaultValue={String(API_RATE_DEFAULT)} error={fields.rateLimitPerMin} />
            </div>
            <TextField name="reason" label={t("common.reason")} hint={t("apiKeys.field.reasonHint")} required maxLength={500} error={fields.reason} />
            <FormError message={createFailure ? (createFailure.fields ? t("common.checkFields") : failureText(t, createFailure)) : null} />
            <div className="ch-actions">
              <Key type="submit" variant="ink" icon="key" loading={creating}>
                {t("apiKeys.create")}
              </Key>
            </div>
          </Form>
        )}
      </Section>
    </>
  );
}
