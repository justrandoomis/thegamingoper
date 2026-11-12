import { Link } from "react-router";

import type { Route } from "./+types/branches";
import { listBranches } from "~/server/services/admin/channels/branches.server";
import { BRANCH_VIEWS, parseBranchView, type BranchRow } from "~/server/services/admin/channels/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Code, LinkChips, Note, Num, PageHead, Pair, ResponsiveList, Section, StatusText, useChT } from "./components/ui";
import { ch } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/branches — 21.01: the store's branches (channels.branch.manage), active first, with what points at
 * each one in the other modules (stock locations 04, registers 06, employees limited to it 20, price lists 03). The view
 * is in the URL (?view=active|inactive|all), so it works without JavaScript and survives Back.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args, "channels.branch.manage");
  const view = parseBranchView(new URL(args.request.url).searchParams);
  const list = await ch.orRespond(() => listBranches(req.db, req.actor, view, req.locale));
  return { list, view, limited: Boolean(req.actor.branchId), created: new URL(args.request.url).searchParams.get("created") === "1" };
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "branches.title");

export default function BranchesPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const { list, view, limited } = loaderData;
  const columns: DataColumn<BranchRow>[] = [
    {
      key: "branch",
      header: t("branches.col.branch"),
      cell: (row) => (
        <Link to={`/admin/channels/branches/${row.id}`} className="adm-link">
          {row.name} · <Code>{row.code}</Code>
        </Link>
      ),
    },
    { key: "place", header: t("branches.col.place"), cell: (row) => [row.governorate, row.district].filter(Boolean).join(t("common.listSep")) || <span className="text-ink-2">—</span> },
    { key: "phone", header: t("branches.col.phone"), cell: (row) => (row.phone ? <Code>{row.phone}</Code> : <span className="text-ink-2">—</span>) },
    { key: "locations", header: t("branches.col.locations"), numeric: true, cell: (row) => <Num value={row.locations} /> },
    { key: "registers", header: t("branches.col.registers"), numeric: true, cell: (row) => <Num value={row.registers} /> },
    { key: "employees", header: t("branches.col.employees"), numeric: true, cell: (row) => <Num value={row.employees} /> },
    { key: "lists", header: t("branches.col.lists"), numeric: true, cell: (row) => <Num value={row.priceLists} /> },
    { key: "state", header: t("branches.col.state"), cell: (row) => <StatusText tone={row.isActive ? "ok" : "out"}>{t(row.isActive ? "branches.active" : "branches.inactive")}</StatusText> },
  ];
  return (
    <>
      <PageHead
        title={t("branches.title")}
        lead={t("branches.lead")}
        actions={
          limited ? null : (
            <Key as={Link} to="/admin/channels/branches/new" icon="plus" variant="ink">
              {t("branches.new")}
            </Key>
          )
        }
      />
      {loaderData.created ? (
        <Note tone="ok" icon="check-circle">
          <p>{t("branches.createdNote")}</p>
        </Note>
      ) : null}
      <Section id="ch-branches" title={t("branches.list")}>
        <LinkChips
          label={t("branches.view")}
          items={BRANCH_VIEWS.map((value) => ({ value, label: t(`branches.views.${value}`), href: value === "active" ? "/admin/channels/branches" : `/admin/channels/branches?view=${value}`, selected: view === value, count: list.counts[value] }))}
        />
        <ResponsiveList
          caption={t("branches.list")}
          columns={columns}
          rows={list.rows}
          rowKey={(row) => row.id}
          empty={
            <EmptyState
              icon="buildings"
              title={view === "active" && list.counts.all === 0 ? t("branches.empty") : t("branches.emptyView")}
              text={view === "active" && list.counts.all === 0 ? t("branches.emptyHint") : undefined}
              action={
                list.counts.all === 0 && !limited ? (
                  <Key as={Link} to="/admin/channels/branches/new" icon="plus">
                    {t("branches.new")}
                  </Key>
                ) : undefined
              }
            />
          }
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/channels/branches/${row.id}`} className="adm-link type-strong">
                  {row.name} · <Code>{row.code}</Code>
                </Link>
                <StatusText tone={row.isActive ? "ok" : "out"}>{t(row.isActive ? "branches.active" : "branches.inactive")}</StatusText>
              </div>
              <Pair label={t("branches.col.place")}>{[row.governorate, row.district].filter(Boolean).join(t("common.listSep")) || "—"}</Pair>
              <Pair label={t("branches.col.locations")}>
                <Num value={row.locations} />
              </Pair>
              <Pair label={t("branches.col.registers")}>
                <Num value={row.registers} />
              </Pair>
              <Pair label={t("branches.col.employees")}>
                <Num value={row.employees} />
              </Pair>
              <Pair label={t("branches.col.lists")}>
                <Num value={row.priceLists} />
              </Pair>
            </>
          )}
        />
        <p className="type-caption text-ink-2">{t("branches.usageNote")}</p>
      </Section>
    </>
  );
}
