import { useState } from "react";
import { Link, useNavigate } from "react-router";

import type { Route } from "./+types/locations";
import { createLocation, listLocations } from "~/server/services/admin/inventory/locations.server";
import { inventoryAccess } from "~/server/services/admin/inventory/shared.server";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { AddLocationDialog, MAX_LOCATION_DEPTH } from "./components/AddLocationDialog";
import { Code, Num, PageHead, Pair, ResponsiveList, RowLink, useInvT } from "./components/kit";
import { checked, failed, ok, openInventory, optionalText, text } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/locations — warehouses and shops, and the aisles, shelves and bins inside them (04.02), with
 * what each holds; add a location (inventory.location.manage); select rows and print their barcode labels.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await openInventory(context, "inventory.stock.read");
  return { locations: await listLocations(db, actor), access: inventoryAccess(actor) };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.location.manage");
  const form = await request.formData();
  try {
    const type = text(form, "type");
    const result = await createLocation(
      db,
      actor,
      {
        kind: type === "store" ? "store" : type === "inside" ? "bin" : "warehouse",
        parentId: type === "inside" ? text(form, "parentId") || null : null,
        code: text(form, "code"),
        name: text(form, "name"),
        barcode: optionalText(form, "barcode"),
        isSellable: checked(form, "isSellable"),
      },
      now,
    );
    return ok({ intent: "create", locationId: result.locationId, code: result.code });
  } catch (error) {
    return failed(error, locale, "create");
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "locations.title");

type Row = Route.ComponentProps["loaderData"]["locations"][number];

export default function Locations({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const navigate = useNavigate();
  const { locations, access } = loaderData;
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState<string | null>(null);
  const printHref = (ids: readonly string[]) => `/admin/inventory/locations/labels?ids=${encodeURIComponent(ids.join(","))}`;

  return (
    <>
      <PageHead
        title={t("locations.title")}
        lead={t("locations.lead")}
        actions={
          <>
            {access.locations ? (
              <Key icon="plus" variant="ink" onClick={() => setAdding("")}>
                {t("locations.add")}
              </Key>
            ) : null}
            <Key as={Link} to={printHref(locations.filter((row) => row.isActive).map((row) => row.id))} icon="printer">
              {t("locations.printAll")}
            </Key>
          </>
        }
      />
      <ResponsiveList
        caption={t("locations.caption")}
        rows={locations}
        rowKey={(row) => row.id}
        rowLabel={(row) => row.code}
        selected={selected}
        onSelectedChange={setSelected}
        bulkActions={(ids) => (
          <Key size="sm" icon="printer" onClick={() => navigate(printHref(ids))}>
            {t("locations.printSelected")}
          </Key>
        )}
        columns={[
          {
            key: "code",
            header: t("common.code"),
            cell: (row) => (
              <span className="inv-indent block" style={{ ["--depth" as string]: row.depth }}>
                <RowLink to={`/admin/inventory/locations/${row.id}`}>
                  <Code>{row.code}</Code>
                </RowLink>
              </span>
            ),
          },
          { key: "name", header: t("common.name"), cell: (row) => row.name },
          { key: "level", header: t("locations.level"), cell: (row) => t(`levels.${row.level}`) },
          { key: "state", header: t("common.status"), cell: (row) => <LocationState row={row} /> },
          { key: "units", header: t("locations.units"), numeric: true, cell: (row) => <Num value={row.units} /> },
          { key: "skus", header: t("locations.skus"), numeric: true, cell: (row) => <Num value={row.skus} /> },
          { key: "reserved", header: t("common.reserved"), numeric: true, cell: (row) => <Num value={row.reserved} /> },
          {
            key: "add",
            header: t("common.actions"),
            cell: (row) =>
              access.locations && row.isActive && row.depth < MAX_LOCATION_DEPTH ? (
                <Key size="sm" icon="plus" onClick={() => setAdding(row.id)}>
                  {t("locations.addInside")}
                </Key>
              ) : null,
          },
        ]}
        card={(row) => (
          <>
            <Link to={`/admin/inventory/locations/${row.id}`} className="adm-link type-strong">
              <Code>{row.path}</Code>
            </Link>
            <p className="type-caption text-ink-2">
              {row.name} · {t(`levels.${row.level}`)}
            </p>
            <LocationState row={row} />
            <Pair label={t("locations.units")}>
              <Num value={row.units} />
            </Pair>
          </>
        )}
        empty={<p className="type-body text-ink-2">{t("locations.empty")}</p>}
      />
      {adding !== null ? <AddLocationDialog locations={locations} parentId={adding} onClose={() => setAdding(null)} /> : null}
    </>
  );
}

function LocationState({ row }: { row: Row }) {
  const t = useInvT();
  return (
    <span className="flex flex-wrap gap-2">
      <Status tone={row.isActive ? "ok" : "neutral"}>{row.isActive ? t("common.active") : t("common.inactive")}</Status>
      <Status tone={row.isSellable ? "info" : "neutral"}>{row.isSellable ? t("common.sellable") : t("common.notSellable")}</Status>
    </span>
  );
}
