import type { Route } from "./+types/files";
import { useFormat } from "~/i18n/react";
import { filesView } from "~/server/services/admin/settings/templates.server";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Status } from "~/ui/Tag";
import { Code, Note, PageHead, Pair, ResponsiveList, Section, When, tOr, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/files — 22.04 (settings.file.manage): what the store keeps in its file store — counts and sizes by
 * kind and visibility, the newest uploads (metadata only: a private file is served by its own module after that
 * module's permission check, never from here) and uploads nothing refers to any more. Deleting is the nightly
 * retention's (unused top-up proofs after a day, abandoned trade-in photos after two), not a key on this page.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await settingsKit.open(context, "settings.file.manage");
  return { view: await settingsKit.orRespond(() => filesView(db, actor)) };
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "files.title");

type Recent = Route.ComponentProps["loaderData"]["view"]["recent"][number];

function size(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

export default function FilesPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { view } = loaderData;
  const columns: DataColumn<Recent>[] = [
    { key: "kind", header: t("files.col.kind"), cell: (row) => tOr(t, `files.kind.${row.kind}`, row.kind) },
    { key: "visibility", header: t("files.col.visibility"), cell: (row) => <Status tone={row.visibility === "public" ? "info" : "neutral"}>{t(`files.visibility.${row.visibility}`)}</Status> },
    { key: "mime", header: t("files.col.type"), cell: (row) => <Code>{row.mime}</Code> },
    { key: "size", header: t("files.col.size"), numeric: true, cell: (row) => <bdi dir="ltr" className="nums">{size(row.bytes)}</bdi> },
    { key: "dims", header: t("files.col.dims"), cell: (row) => (row.width && row.height ? <bdi dir="ltr" className="nums">{`${row.width}×${row.height}`}</bdi> : "—") },
    { key: "by", header: t("files.col.by"), cell: (row) => tOr(t, `files.by.${row.createdByKind ?? "unknown"}`, row.createdByKind ?? "—") },
    { key: "at", header: t("files.col.at"), cell: (row) => <When at={row.createdAt} /> },
  ];
  return (
    <>
      <PageHead title={t("files.title")} lead={t("files.lead")} />
      <div className="sec-kpis">
        <div className="adm-card gap-1">
          <p className="type-caption text-ink-2">{t("files.total")}</p>
          <p className="type-kpi nums">{f.number(view.total.files)}</p>
          <p className="type-caption text-ink-2">
            <bdi dir="ltr">{size(view.total.bytes)}</bdi>
          </p>
        </div>
        {view.byKind.slice(0, 7).map((row) => (
          <div key={`${row.kind}:${row.visibility}`} className="adm-card gap-1">
            <p className="type-caption text-ink-2">
              {tOr(t, `files.kind.${row.kind}`, row.kind)} · {t(`files.visibility.${row.visibility}`)}
            </p>
            <p className="type-kpi nums">{f.number(row.files)}</p>
            <p className="type-caption text-ink-2">
              <bdi dir="ltr">{size(row.bytes)}</bdi>
            </p>
          </div>
        ))}
      </div>
      <Section id="unreferenced" title={t("files.unreferenced")}>
        {view.unreferenced.length === 0 ? (
          <p className="type-body text-ink-2">{t("files.noUnreferenced")}</p>
        ) : (
          <ul role="list" className="grid gap-1">
            {view.unreferenced.map((row) => (
              <li key={row.kind} className="adm-card gap-1">
                <Pair label={tOr(t, `files.kind.${row.kind}`, row.kind)}>
                  {f.number(row.files)} · <bdi dir="ltr">{size(row.bytes)}</bdi>
                </Pair>
              </li>
            ))}
          </ul>
        )}
        <Note>
          <p>{t("files.retention")}</p>
        </Note>
      </Section>
      <Section id="recent" title={t("files.recent")}>
        <ResponsiveList
          caption={t("files.recent")}
          columns={columns}
          rows={view.recent}
          rowKey={(row) => row.id}
          empty={<EmptyState title={t("files.empty")} icon="image" />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <span className="type-strong">{tOr(t, `files.kind.${row.kind}`, row.kind)}</span>
                <Status tone={row.visibility === "public" ? "info" : "neutral"}>{t(`files.visibility.${row.visibility}`)}</Status>
              </div>
              <Pair label={t("files.col.size")}>
                <bdi dir="ltr">{size(row.bytes)}</bdi>
              </Pair>
              <Pair label={t("files.col.at")}>
                <When at={row.createdAt} />
              </Pair>
            </>
          )}
        />
      </Section>
    </>
  );
}
