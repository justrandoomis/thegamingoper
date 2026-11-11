import { Link } from "react-router";

import type { Route } from "./+types/fields";
import { useFormat } from "~/i18n/react";
import { listCustomFields, type CustomFieldRow } from "~/server/services/admin/settings/custom-fields.server";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { Note, PageHead, Pair, ResponsiveList, RowLink, Section, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/fields — 22.03: the custom fields of products per kind, with their type, whether they are required
 * (a required field blocks publishing in the catalogue until it is filled), how many products hold a value, and how
 * many live or draft products of the kind still miss one.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await settingsKit.open(context, "settings.read");
  return { list: await settingsKit.orRespond(() => listCustomFields(db, actor, locale)) };
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "fields.title");

export default function FieldsPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { list } = loaderData;
  const columns: DataColumn<CustomFieldRow>[] = [
    {
      key: "label",
      header: t("fields.col.label"),
      cell: (row) => (
        <span className="grid">
          <RowLink to={`/admin/settings/fields/${row.id}`}>{row.label}</RowLink>
          <bdi dir="ltr" className="type-caption text-ink-2">
            {row.key}
          </bdi>
        </span>
      ),
    },
    { key: "kind", header: t("fields.col.kind"), cell: (row) => t(`kinds.${row.productKind === "*" ? "all" : row.productKind}`) },
    { key: "type", header: t("fields.col.type"), cell: (row) => t(`types.${row.type}`) },
    { key: "required", header: t("fields.col.required"), cell: (row) => (row.required ? <Status tone="warn">{t("fields.required")}</Status> : t("fields.optional")) },
    { key: "values", header: t("fields.col.values"), numeric: true, cell: (row) => f.number(row.usage.withValue) },
    { key: "missing", header: t("fields.col.missing"), numeric: true, cell: (row) => (row.required && row.usage.liveMissing ? <Status tone="warn">{f.number(row.usage.liveMissing)}</Status> : f.number(row.usage.liveMissing)) },
    { key: "state", header: t("fields.col.state"), cell: (row) => <Status tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? t("fields.active") : t("fields.inactive")}</Status> },
  ];
  return (
    <>
      <PageHead
        title={t("fields.title")}
        lead={t("fields.lead")}
        actions={
          list.canManage ? (
            <Key as={Link} to="/admin/settings/fields/new" size="sm" variant="ink" icon="plus">
              {t("fields.new")}
            </Key>
          ) : null
        }
      />
      <Note>
        <p>{t("fields.rules")}</p>
        <p>{t("fields.noValidation")}</p>
      </Note>
      <Section id="list" title={t("fields.list")} className="mt-4">
        <ResponsiveList
          caption={t("fields.list")}
          columns={columns}
          rows={list.rows}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("fields.empty")} text={t("fields.emptyHint")} icon="sliders-horizontal" action={list.canManage ? <Key as={Link} to="/admin/settings/fields/new" size="sm">{t("fields.new")}</Key> : undefined} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/settings/fields/${row.id}`} className="adm-link type-strong">
                  {row.label}
                </Link>
                <Status tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? t("fields.active") : t("fields.inactive")}</Status>
              </div>
              <Pair label={t("fields.col.kind")}>{t(`kinds.${row.productKind === "*" ? "all" : row.productKind}`)}</Pair>
              <Pair label={t("fields.col.type")}>{t(`types.${row.type}`)}</Pair>
              <Pair label={t("fields.col.required")}>{row.required ? t("fields.required") : t("fields.optional")}</Pair>
              <Pair label={t("fields.col.missing")}>{f.number(row.usage.liveMissing)}</Pair>
            </>
          )}
        />
      </Section>
    </>
  );
}
