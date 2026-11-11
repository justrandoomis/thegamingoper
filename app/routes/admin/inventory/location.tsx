import { useRef, useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/location";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { getLocation, listLocations, updateLocation } from "~/server/services/admin/inventory/locations.server";
import { inventoryAccess } from "~/server/services/admin/inventory/shared.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { Checkbox, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { AddLocationDialog, MAX_LOCATION_DEPTH } from "./components/AddLocationDialog";
import { Barcode } from "./components/Barcode";
import { Code, Kpi, PageHead, Pair, ResponsiveList, RowLink, Section, useInvT } from "./components/kit";
import { checked, failed, int, ok, openInventory, optionalText, text } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/locations/:locationId — one storage location (04.02): its path, barcode and printable label, what
 * it holds, what is inside it, and its settings (name, barcode, for sale, active — switching off is refused while it
 * is in use; taking it out of sale or off asks for a reason and shows the units that leave availability).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor } = await openInventory(context, "inventory.stock.read");
  try {
    const [detail, all] = await Promise.all([getLocation(db, actor, params.locationId), listLocations(db, actor)]);
    return { detail, all: all.map((row) => ({ id: row.id, path: row.path, name: row.name, depth: row.depth, level: row.level, isActive: row.isActive, isSellable: row.isSellable })), access: inventoryAccess(actor) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.location.manage");
  const form = await request.formData();
  try {
    await updateLocation(
      db,
      actor,
      {
        locationId: params.locationId,
        name: optionalText(form, "name"),
        barcode: optionalText(form, "barcode"),
        isSellable: checked(form, "isSellable"),
        isActive: checked(form, "isActive"),
        sort: int(form, "sort"),
        reason: optionalText(form, "reason"),
      },
      now,
    );
    return ok({ intent: text(form, "intent") || "update" });
  } catch (error) {
    return failed(error, locale, "update");
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "locations.title");

export default function LocationPage({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { detail, all, access } = loaderData;
  const location = detail.location;
  const [adding, setAdding] = useState(false);
  const [sellable, setSellable] = useState(location.isSellable);
  const [active, setActive] = useState(location.isActive);
  const [confirm, setConfirm] = useState(false);
  const [form, setForm] = useState<HTMLFormElement | null>(null);
  const confirmed = useRef(false);
  const sensitive = (location.isSellable && !sellable) || (location.isActive && !active);
  const failure = result && !result.ok ? result : null;
  const saved = result && result.ok;

  return (
    <>
      <p className="mb-2">
        <Link to="/admin/inventory/locations" className="adm-link type-label">
          {t("location.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={
          <>
            {t(`levels.${location.level}`)} · <Code>{location.path}</Code>
          </>
        }
        title={
          <>
            <Code>{location.code}</Code> · {location.name}
          </>
        }
        actions={
          <>
            <Key as={Link} to={`/admin/inventory/stock?location=${location.id}`} icon="package">
              {t("location.stockHere")}
            </Key>
            {access.locations && location.isActive && location.depth < MAX_LOCATION_DEPTH ? (
              <Key icon="plus" onClick={() => setAdding(true)}>
                {t("locations.addInside")}
              </Key>
            ) : null}
          </>
        }
      />

      <div className="mb-6 flex flex-wrap gap-2">
        <Status tone={location.isActive ? "ok" : "neutral"}>{location.isActive ? t("common.active") : t("common.inactive")}</Status>
        <Status tone={location.isSellable ? "info" : "neutral"}>{location.isSellable ? t("common.sellable") : t("common.notSellable")}</Status>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
        <div className="min-w-0">
          <Section id="loc-stats" title={t("location.stats")}>
            <div className="inv-kpis">
              <Kpi label={t("locations.units")} value={f.number(location.units)} />
              <Kpi label={t("locations.skus")} value={f.number(location.skus)} />
              <Kpi label={t("common.reserved")} value={f.number(location.reserved)} />
              <Kpi label={t("location.inTransitTo")} value={f.number(location.inTransitTo)} />
              <Kpi label={t("location.openCounts")} value={f.number(location.openCounts)} />
            </div>
          </Section>

          <Section id="loc-children" title={t("location.children")}>
            {detail.children.length === 0 ? (
              <p className="type-body text-ink-2">{t("location.noChildren")}</p>
            ) : (
              <ResponsiveList
                caption={t("location.children")}
                rows={detail.children}
                rowKey={(row) => row.id}
                columns={[
                  { key: "code", header: t("common.code"), cell: (row) => <RowLink to={`/admin/inventory/locations/${row.id}`}><Code>{row.code}</Code></RowLink> },
                  { key: "name", header: t("common.name"), cell: (row) => row.name },
                  { key: "level", header: t("locations.level"), cell: (row) => t(`levels.${row.level}`) },
                  { key: "units", header: t("locations.units"), numeric: true, cell: (row) => f.number(row.units) },
                ]}
                card={(row) => (
                  <>
                    <Link to={`/admin/inventory/locations/${row.id}`} className="adm-link type-strong">
                      <Code>{row.code}</Code>
                    </Link>
                    <Pair label={t("locations.units")}>{f.number(row.units)}</Pair>
                  </>
                )}
              />
            )}
          </Section>

          {access.locations ? (
            <Section id="loc-edit" title={t("location.edit")}>
              <Form
                method="post"
                ref={setForm}
                className="adm-card grid gap-4"
                onSubmit={(event) => {
                  if (sensitive && !confirmed.current) {
                    event.preventDefault();
                    setConfirm(true);
                    return;
                  }
                  confirmed.current = false;
                }}
              >
                <input type="hidden" name="intent" value="update" />
                <TextField name="name" label={t("locations.name")} defaultValue={location.name} required maxLength={100} error={failure?.fields?.name} />
                <TextField name="barcode" label={t("locations.barcode")} defaultValue={location.barcode ?? location.code} ltr maxLength={64} error={failure?.fields?.barcode} />
                <Checkbox name="isSellable" label={t("location.sellable")} checked={sellable} onChange={(event) => setSellable(event.target.checked)} />
                <Checkbox name="isActive" label={t("location.activeLabel")} checked={active} onChange={(event) => setActive(event.target.checked)} error={failure?.fields?.isActive} />
                {sensitive ? <TextArea name="reason" label={t("common.reason")} hint={t("location.reasonHint")} required maxLength={500} error={failure?.fields?.reason} /> : null}
                {failure?.message && !failure.fields ? (
                  <p role="alert" className="type-label text-red-ink">
                    {failure.message}
                  </p>
                ) : null}
                {saved ? (
                  <p role="status" className="type-label text-ok">
                    {t("location.saved")}
                  </p>
                ) : null}
                <div>
                  <Key type="submit" variant="ink" loading={navigation.state === "submitting"}>
                    {t("location.submit")}
                  </Key>
                </div>
              </Form>
              <ConfirmDialog
                open={confirm}
                onClose={() => setConfirm(false)}
                title={t("location.confirmTitle")}
                consequence={location.isActive && !active ? t("location.confirmInactive") : t("location.confirmUnsellable", { units: t("common.units", { count: location.units }) })}
                confirmLabel={t("location.confirm")}
                tone="destructive"
                impact={[
                  { label: t("locations.units"), value: f.number(location.units) },
                  { label: t("common.reserved"), value: f.number(location.reserved) },
                ]}
                onConfirm={() => {
                  confirmed.current = true;
                  setConfirm(false);
                  form?.requestSubmit();
                }}
              />
            </Section>
          ) : null}
        </div>

        <aside className="min-w-0">
          <Section id="loc-label" title={t("location.label")}>
            <div className="inv-barcode" data-theme="light">
              <Barcode value={location.barcode || location.code} label={`${t("location.barcode")} ${location.barcode || location.code}`} className="inv-barcode__bars" />
              <p className="inv-label__code">
                <Code>{location.barcode || location.code}</Code>
              </p>
              <p className="type-caption">{location.name}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Key as={Link} to={`/admin/inventory/locations/labels?ids=${location.id}`} icon="printer" size="sm">
                {t("location.printLabel")}
              </Key>
              {detail.children.length > 0 ? (
                <Key as={Link} to={`/admin/inventory/locations/labels?ids=${location.id}&children=1`} icon="printer" size="sm">
                  {t("location.printWithChildren")}
                </Key>
              ) : null}
            </div>
          </Section>
        </aside>
      </div>

      {adding ? <AddLocationDialog locations={all} parentId={location.id} onClose={() => setAdding(false)} /> : null}
    </>
  );
}
