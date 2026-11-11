import { Link } from "react-router";

import type { Route } from "./+types/labels";
import { qrPath } from "../shell/qr.server";
import { locationLabels } from "~/server/services/admin/inventory/locations.server";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Barcode } from "./components/Barcode";
import { Code, PageHead, useInvT } from "./components/kit";
import { openInventory } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/locations/labels?ids=a,b[&children=1] — printable storage-location labels (04.02): a Code 128
 * barcode and a QR code of the location's barcode value, its code and name. Printing is the browser's (no printer
 * integration): only the label sheet prints (inventory.css). A keyboard-wedge reader scanning a label types the code
 * into the module's scan fields.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor } = await openInventory(context, "inventory.stock.read");
  const url = new URL(request.url);
  const ids = (url.searchParams.get("ids") ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    .slice(0, 200);
  const labels = await locationLabels(db, actor, ids, { withChildren: url.searchParams.get("children") === "1" });
  return { labels: labels.map((label) => ({ ...label, qr: qrPath(label.barcode) })) };
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "labels.title");

export default function Labels({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const { labels } = loaderData;
  return (
    <>
      <div className="inv-no-print">
        <PageHead
          title={t("labels.title")}
          lead={t("labels.lead")}
          actions={
            <>
              <Key as={Link} to="/admin/inventory/locations" icon="arrow-left">
                {t("labels.back")}
              </Key>
              {labels.length > 0 ? (
                <Key variant="ink" icon="printer" onClick={() => window.print()}>
                  {t("common.print")}
                </Key>
              ) : null}
            </>
          }
        />
        <p className="mb-3 type-caption text-ink-2">{t("labels.count", { count: labels.length })}</p>
      </div>
      {labels.length === 0 ? (
        <EmptyState icon="barcode" title={t("labels.none")} action={<Key as={Link} to="/admin/inventory/locations">{t("labels.back")}</Key>} />
      ) : (
        <div className="inv-print inv-label-sheet" data-theme="light">
          {labels.map((label) => (
            <article key={label.id} className="inv-label">
              <div className="grid min-w-0 gap-0.5">
                <p className="inv-label__code">
                  <Code>{label.code}</Code>
                </p>
                <p className="type-caption">{label.name}</p>
                <p className="type-caption">
                  {t(`levels.${label.level}`)} · <Code>{label.path}</Code>
                </p>
              </div>
              <svg viewBox={`-2 -2 ${label.qr.size + 4} ${label.qr.size + 4}`} className="inv-qr" role="img" aria-label={`QR ${label.barcode}`} shapeRendering="crispEdges">
                <path d={label.qr.path} fill="currentColor" />
              </svg>
              <Barcode value={label.barcode} label={`${t("location.barcode")} ${label.barcode}`} className="inv-label__bars" />
            </article>
          ))}
        </div>
      )}
    </>
  );
}
