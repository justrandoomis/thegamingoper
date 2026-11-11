/**
 * "Add a location" — a warehouse, a shop, or an aisle / shelf / bin inside one (04.02). Posts to the locations
 * page action (createLocation, inventory.location.manage) and closes with a toast.
 */
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { Dialog } from "~/ui/Dialog";
import { Checkbox, FieldGroup, Radio, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { toast } from "~/ui/toast-store";
import type { ActionData } from "./ActionDialog";
import { useInvT } from "./kit";

/** Three levels inside a warehouse or a shop: aisle, then shelf, then bin (the services enforce it too). */
export const MAX_LOCATION_DEPTH = 3;
const NEXT_LEVEL: Record<string, string> = { warehouse: "aisle", store: "aisle", aisle: "shelf", shelf: "bin" };

export function AddLocationDialog({ locations, parentId, onClose, action }: { locations: readonly { id: string; path: string; name: string; depth: number; level: string; isActive: boolean; isSellable: boolean }[]; parentId: string; onClose: () => void; action?: string }) {
  const t = useInvT();
  const fetcher = useFetcher<ActionData & { code?: string }>({ key: "location-create" });
  const [type, setType] = useState(parentId ? "inside" : "warehouse");
  const [parent, setParent] = useState(parentId || locations.find((row) => row.isActive && row.depth < MAX_LOCATION_DEPTH)?.id || "");
  const handled = useRef<unknown>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok) {
      toast.success(t("locations.created", { code: fetcher.data.code ?? "" }));
      onClose();
    }
  }, [fetcher.data, fetcher.state, onClose, t]);
  const failedResult = fetcher.data && !fetcher.data.ok ? fetcher.data : null;
  const parentRow = locations.find((row) => row.id === parent);
  const level = parentRow ? (NEXT_LEVEL[parentRow.level] ?? null) : null;
  const parents = locations.filter((row) => row.isActive && row.depth < MAX_LOCATION_DEPTH);

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("locations.formTitle")}
      description={t("locations.formLead")}
      dismissible={fetcher.state === "idle"}
      onSubmit={(event) => {
        event.preventDefault();
        fetcher.submit(new FormData(event.currentTarget), { method: "post", action: action ?? "/admin/inventory/locations" });
      }}
      footer={
        <>
          <Key onClick={onClose} disabled={fetcher.state !== "idle"} className="flex-1 sm:flex-none">
            {t("common.cancel")}
          </Key>
          <Key type="submit" variant="ink" loading={fetcher.state !== "idle"} className="flex-1 sm:flex-none">
            {t("locations.submit")}
          </Key>
        </>
      }
    >
      <div className="grid gap-4">
        <FieldGroup legend={t("locations.type")}>
          <Radio name="type" value="warehouse" label={t("locations.typeWarehouse")} checked={type === "warehouse"} onChange={() => setType("warehouse")} />
          <Radio name="type" value="store" label={t("locations.typeStore")} checked={type === "store"} onChange={() => setType("store")} />
          <Radio name="type" value="inside" label={t("locations.typeInside")} checked={type === "inside"} onChange={() => setType("inside")} disabled={parents.length === 0} />
        </FieldGroup>
        {type === "inside" ? (
          <Select
            name="parentId"
            label={t("locations.parent")}
            hint={level ? `${t("locations.willBe", { level: t(`levels.${level}`) })} — ${t("locations.parentHint")}` : t("locations.parentHint")}
            value={parent}
            onChange={(event) => setParent(event.target.value)}
            options={parents.map((row) => ({ value: row.id, label: `${row.path} · ${row.name}` }))}
            error={failedResult?.fields?.parentId}
          />
        ) : null}
        <TextField name="code" label={t("locations.code")} hint={t("locations.codeHint")} ltr required autoCapitalize="characters" maxLength={32} error={failedResult?.fields?.code} />
        <TextField name="name" label={t("locations.name")} required maxLength={100} error={failedResult?.fields?.name} />
        <TextField name="barcode" label={t("locations.barcode")} hint={t("locations.barcodeHint")} ltr optional maxLength={64} error={failedResult?.fields?.barcode} />
        <Checkbox name="isSellable" label={t("locations.sellable")} defaultChecked={type === "inside" ? (parentRow?.isSellable ?? true) : true} key={`${type}-${parent}`} />
        {failedResult?.message && !failedResult.fields ? (
          <p role="alert" className="type-label text-red-ink">
            {failedResult.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
