import { useState } from "react";
import { Link, useActionData, useNavigation, Form } from "react-router";

import type { Route } from "./+types/roles";
import { useFormat } from "~/i18n/react";
import { createRole, listRoles, type RoleRow } from "~/server/services/admin/security/roles.server";
import { invalid } from "~/server/errors";
import { can } from "~/server/actor";
import type { DataColumn } from "~/ui/DataTable";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { FormError, Note, PageHead, Pair, ResponsiveList, RowLink, Section, When, failureText, useListSep, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { ok, optional, text } from "./route-kit.server";
import { sec } from "./security.server";

/**
 * /admin/security/roles — 20.02: every role with its members (and how many of them lack two-step verification), how
 * many permissions it grants, which protected-data permissions are among them, and when its access was last reviewed
 * (20.07). A new role starts empty or as a copy of another role, within the creator's own permissions (staff.manage).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await sec.open(context);
  const roles = await sec.orRespond(() => listRoles(db, actor, locale, now));
  return { roles, canCreate: can(actor, "staff.manage") };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await sec.open(context, "staff.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "create") throw invalid({ intent: "invalid" });
    const result = await createRole(req.db, req.actor, { key: text(form, "key"), nameAr: text(form, "nameAr"), nameEn: optional(form, "nameEn"), descriptionAr: optional(form, "descriptionAr"), copyFrom: optional(form, "copyFrom"), reason: text(form, "reason") }, req.now);
    return ok(intent, result);
  } catch (error) {
    return sec.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "roles.title");

export default function RolesPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const sep = useListSep();
  const f = useFormat();
  const { roles, canCreate } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const [creating, setCreating] = useState(false);
  const fields = result && !result.ok ? (result.fields ?? {}) : {};
  const columns: DataColumn<RoleRow>[] = [
    {
      key: "name",
      header: t("roles.col.name"),
      cell: (row) => (
        <span className="grid">
          <RowLink to={`/admin/security/roles/${row.id}`}>{row.name}</RowLink>
          <code className="type-caption text-ink-2" dir="ltr">
            {row.key}
          </code>
        </span>
      ),
    },
    { key: "members", header: t("roles.col.members"), numeric: true, cell: (row) => f.number(row.activeMembers) },
    { key: "noTwoStep", header: t("roles.col.noTwoStep"), numeric: true, cell: (row) => (row.withoutTwoStep ? <Status tone="warn">{f.number(row.withoutTwoStep)}</Status> : "0") },
    { key: "perms", header: t("roles.col.permissions"), numeric: true, cell: (row) => (row.permissionCount === null ? t("roles.everything") : f.number(row.permissionCount)) },
    { key: "field", header: t("roles.col.field"), cell: (row) => (row.isOwner ? t("roles.everything") : row.field.length ? row.field.map((p) => t(`field.${p.replace(/\./g, "_")}`)).join(sep) : "—") },
    { key: "review", header: t("roles.col.review"), cell: (row) => (row.lastReview ? <When at={row.lastReview.at} kind="date" /> : <Status tone="warn">{t("roles.neverReviewed")}</Status>) },
  ];
  return (
    <>
      <PageHead
        title={t("roles.title")}
        lead={t("roles.lead")}
        actions={
          canCreate ? (
            <Key size="sm" variant="ink" icon="plus" onClick={() => setCreating((open) => !open)} aria-expanded={creating}>
              {t("roles.new")}
            </Key>
          ) : null
        }
      />
      <Note className="mb-6">
        <p>{t("roles.rules")}</p>
      </Note>

      {canCreate && creating ? (
        <Section id="new-role" title={t("roles.new")}>
          <Form method="post" className="adm-card grid gap-3 sm:grid-cols-2" noValidate>
            <input type="hidden" name="intent" value="create" />
            <TextField name="key" label={t("roles.key")} hint={t("roles.keyHint")} ltr required error={fields.key} />
            <TextField name="nameAr" label={t("roles.nameAr")} required error={fields.nameAr} />
            <TextField name="nameEn" label={t("roles.nameEn")} optional error={fields.nameEn} />
            <Select name="copyFrom" label={t("roles.copyFrom")} hint={t("roles.copyHint")} defaultValue="" options={[{ value: "", label: t("roles.empty") }, ...roles.map((role) => ({ value: role.id, label: role.name }))]} />
            <TextField name="descriptionAr" label={t("roles.description")} optional error={fields.descriptionAr} className="sm:col-span-2" />
            <TextField name="reason" label={t("common.reason")} required error={fields.reason} className="sm:col-span-2" />
            <div className="grid gap-2 sm:col-span-2">
              <FormError message={result && !result.ok && !Object.keys(fields).length ? failureText(t, result) : null} />
              {result?.ok ? (
                <p role="status" className="type-label text-ok">
                  {t("roles.created", { copied: (result as { copied?: number }).copied ?? 0 })}{" "}
                  <Link className="adm-link" to={`/admin/security/roles/${(result as { roleId?: string }).roleId ?? ""}`}>
                    {t("roles.open")}
                  </Link>
                </p>
              ) : null}
              <div>
                <Key type="submit" size="sm" variant="ink" loading={navigation.state === "submitting"}>
                  {t("roles.create")}
                </Key>
              </div>
            </div>
          </Form>
        </Section>
      ) : null}

      <Section id="roles" title={t("roles.list")} aside={<span className="type-caption text-ink-2">{t("roles.count", { count: roles.length })}</span>}>
        <ResponsiveList
          caption={t("roles.list")}
          columns={columns}
          rows={roles}
          rowKey={(row) => row.id}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/security/roles/${row.id}`} className="adm-link type-strong">
                  {row.name}
                </Link>
                {row.reviewDue ? <Status tone="warn">{t("roles.reviewDue")}</Status> : <Status tone="ok">{t("roles.reviewed")}</Status>}
              </div>
              <Pair label={t("roles.col.members")}>{f.number(row.activeMembers)}</Pair>
              <Pair label={t("roles.col.permissions")}>{row.permissionCount === null ? t("roles.everything") : f.number(row.permissionCount)}</Pair>
              <Pair label={t("roles.col.field")}>{row.isOwner ? t("roles.everything") : row.field.length ? row.field.map((p) => t(`field.${p.replace(/\./g, "_")}`)).join(sep) : "—"}</Pair>
            </>
          )}
        />
      </Section>
    </>
  );
}
