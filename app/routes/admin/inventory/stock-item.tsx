import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/stock-item";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { AppError, throwAsResponse } from "~/server/errors";
import { inventoryAccess, locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import { adjustFromAdmin, getVariantStock, setReorderPoint } from "~/server/services/admin/inventory/stock.server";
import { Dialog } from "~/ui/Dialog";
import { Checkbox, Radio, FieldGroup, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import type { ActionData } from "./components/ActionDialog";
import { Code, Kpi, Money, Note, Num, PageHead, Pair, ResponsiveList, FromTo, RowLink, Section, StateTag, When, digitsOnly, useInvT } from "./components/kit";
import { checked, failed, int, newKey, ok, openInventory, text } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/stock/:variantId — one SKU: stock per location (04.01), cover and the stock-out forecast (04.06),
 * reservations, open transfers, serial numbers (inventory.serial.read), FIFO cost layers (cost.read only, 04.10),
 * the latest movements, and two actions: adjust or write off at a location — with the oversell exception for those
 * allowed (04.09) — and set the reorder point.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.stock.read");
  try {
    const [item, tree] = await Promise.all([getVariantStock(db, actor, params.variantId, locale, now), locationTree(db)]);
    return { item, locations: locationOptions(tree), access: inventoryAccess(actor), key: newKey() };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  if (intent === "adjust") {
    const { db, actor, locale, now } = await openInventory(context, "inventory.stock.adjust");
    try {
      const result = await adjustFromAdmin(
        db,
        actor,
        {
          variantId: params.variantId,
          locationId: text(form, "locationId"),
          kind: text(form, "kind") === "damage" ? "damage" : "adjust",
          direction: text(form, "direction") === "remove" ? "remove" : "add",
          qty: int(form, "qty"),
          reason: text(form, "reason"),
          unitCostIqd: can(actor, "cost.read") ? int(form, "unitCostIqd") : undefined,
          allowOversell: checked(form, "allowOversell"),
          idempotencyKey: text(form, "key"),
        },
        now,
      );
      return ok({ intent, replayed: result.replayed });
    } catch (error) {
      return failed(error, locale, intent);
    }
  }
  if (intent === "reorder") {
    const { db, actor, locale, now } = await openInventory(context, "inventory.reorder.manage");
    try {
      const point = int(form, "reorderPoint");
      const qty = int(form, "reorderQty");
      await setReorderPoint(db, actor, { variantId: params.variantId, locationId: text(form, "locationId"), reorderPoint: point ?? null, reorderQty: qty ?? null }, now);
      return ok({ intent });
    } catch (error) {
      return failed(error, locale, intent);
    }
  }
  const { locale } = await openInventory(context, "inventory.stock.read");
  return failed(new AppError("invalid", 400), locale, intent);
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, null);

type Loaded = Route.ComponentProps["loaderData"];
type Level = Loaded["item"]["levels"][number];

export default function StockItem({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const { item, access, locations } = loaderData;
  const { variant, totals, forecast } = item;
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [reordering, setReordering] = useState<string | null>(null);
  const rate = forecast.rate30.basis === "sales" ? forecast.rate30 : forecast.rate90;

  return (
    <>
      <p className="mb-2">
        <Link to="/admin/inventory/stock" className="adm-link type-label">
          {t("item.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={
          <>
            <Code>{variant.sku}</Code>
            {variant.barcode ? (
              <>
                {" · "}
                {t("item.barcode")} <Code>{variant.barcode}</Code>
              </>
            ) : null}
          </>
        }
        title={variant.name}
        lead={variant.trackSerials ? t("common.tracked") : undefined}
        actions={
          <>
            {access.adjust && !variant.trackSerials ? (
              <Key icon="scales" onClick={() => setAdjusting(item.levels[0]?.location.id ?? locations[0]?.value ?? "")}>
                {t("item.adjust")}
              </Key>
            ) : null}
            {access.reorder ? (
              <Key icon="arrows-clockwise" onClick={() => setReordering(item.levels[0]?.location.id ?? locations[0]?.value ?? "")}>
                {t("item.setReorder")}
              </Key>
            ) : null}
          </>
        }
      />

      <div className="inv-kpis mb-6">
        <Kpi label={t("common.onHand")} value={f.number(totals.onHand)} />
        <Kpi label={t("common.reserved")} value={f.number(totals.reserved)} />
        <Kpi label={t("common.available")} value={f.number(totals.available)} />
        <Kpi label={t("common.incoming")} value={f.number(totals.incoming)} />
        {item.cost ? <Kpi wide label={t("common.value")} value={<Money iqd={item.cost.valueIqd} />} hint={item.cost.unlayeredUnits > 0 ? t("common.unlayered", { count: item.cost.unlayeredUnits }) : undefined} /> : null}
      </div>

      {variant.trackSerials && access.adjust ? (
        <Note icon="barcode" className="mb-6">
          {t("adjust.trackedNote")}
        </Note>
      ) : null}

      <Section id="item-levels" title={t("item.byLocation")}>
        {item.levels.length === 0 ? (
          <p className="adm-card type-body text-ink-2">{t("item.noLevels")}</p>
        ) : (
          <ResponsiveList
            caption={t("item.byLocation")}
            rows={item.levels}
            rowKey={(level) => level.location.id}
            columns={[
              { key: "location", header: t("common.location"), cell: (level) => <LocationCell level={level} /> },
              { key: "onHand", header: t("common.onHand"), numeric: true, cell: (level) => <Num value={level.onHand} /> },
              { key: "reserved", header: t("common.reserved"), numeric: true, cell: (level) => <Num value={level.reserved} /> },
              { key: "free", header: t("common.free"), numeric: true, cell: (level) => <Num value={level.free} />, negative: (level) => level.free < 0 },
              { key: "incoming", header: t("common.incoming"), numeric: true, cell: (level) => <Num value={level.incoming} /> },
              { key: "reorder", header: t("common.reorderPoint"), numeric: true, cell: (level) => (level.reorderPoint === null ? "—" : <><Num value={level.reorderPoint} />{level.reorderQty ? <span className="type-caption text-ink-2"> / <Num value={level.reorderQty} /></span> : null}</>) },
              ...(item.cost ? [{ key: "value", header: t("common.value"), numeric: true, cell: (level: Level) => <Money iqd={level.valueIqd} /> }] : []),
              // No empty "Actions" column for those who may do neither (cashiers, support).
              ...((access.adjust && !variant.trackSerials) || access.reorder
                ? [
                    {
                      key: "actions",
                      header: t("common.actions"),
                      cell: (level: Level) => (
                        <span className="flex flex-wrap gap-1">
                          {access.adjust && !variant.trackSerials ? (
                            <Key size="sm" onClick={() => setAdjusting(level.location.id)}>
                              {t("item.adjust")}
                            </Key>
                          ) : null}
                          {access.reorder ? (
                            <Key size="sm" onClick={() => setReordering(level.location.id)}>
                              {t("item.setReorder")}
                            </Key>
                          ) : null}
                        </span>
                      ),
                    },
                  ]
                : []),
            ]}
            card={(level) => (
              <>
                <LocationCell level={level} />
                <Pair label={t("common.onHand")}>
                  <Num value={level.onHand} />
                </Pair>
                <Pair label={t("common.reserved")}>
                  <Num value={level.reserved} />
                </Pair>
                <Pair label={t("common.free")}>
                  <Num value={level.free} />
                </Pair>
                {level.valueIqd !== undefined ? (
                  <Pair label={t("common.value")}>
                    <Money iqd={level.valueIqd} />
                  </Pair>
                ) : null}
                <div className="flex flex-wrap gap-2 pt-1">
                  {access.adjust && !variant.trackSerials ? (
                    <Key size="sm" onClick={() => setAdjusting(level.location.id)}>
                      {t("item.adjust")}
                    </Key>
                  ) : null}
                  {access.reorder ? (
                    <Key size="sm" onClick={() => setReordering(level.location.id)}>
                      {t("item.setReorder")}
                    </Key>
                  ) : null}
                </div>
              </>
            )}
          />
        )}
      </Section>

      <Section id="item-forecast" title={t("item.forecast")}>
        <div className="inv-kpis">
          <Kpi label={t("item.sold30")} value={f.number(forecast.sold30)} />
          <Kpi label={t("item.sold90")} value={f.number(forecast.sold90)} />
          <Kpi label={t("item.rate")} value={rate.perDay === null ? t("item.noForecast") : t("common.perDay", { rate: f.number(rate.perDay, { maximumFractionDigits: 2 }) })} />
          <Kpi label={t("item.cover")} value={forecast.plan.daysOfCover === null ? "—" : t("common.days", { count: forecast.plan.daysOfCover })} />
          <Kpi label={t("item.stockOut")} value={forecast.plan.stockOutAt === null ? "—" : f.date(forecast.plan.stockOutAt)} />
          <Kpi label={t("item.suggested")} value={forecast.plan.suggestedQty === null ? "—" : f.number(forecast.plan.suggestedQty)} />
        </div>
        <p className="type-caption text-ink-2">
          {rate.basis === "sales" ? t("item.basisSales", { units: rate.unitsSold, days: rate.days }) : rate.basis === "no_sales" ? t("item.basisNoSales", { days: rate.days }) : t("item.basisLittle")}{" "}
          <StateTag group="reorder" value={forecast.plan.status} label={t(`reorder.statuses.${forecast.plan.status}`)} />
        </p>
      </Section>

      <Section id="item-reservations" title={t("item.reservations")}>
        {item.reservations.length === 0 ? (
          <p className="type-body text-ink-2">{t("item.noReservations")}</p>
        ) : (
          <ResponsiveList
            caption={t("item.reservations")}
            rows={item.reservations}
            rowKey={(row) => row.id}
            columns={[
              { key: "order", header: t("reservations.order"), cell: (row) => <Code>{row.orderRef}</Code> },
              { key: "status", header: t("reservations.orderStatus"), cell: (row) => t(`orderStatus.${row.orderStatus}`) },
              { key: "location", header: t("common.location"), cell: (row) => <Code>{row.locationCode}</Code> },
              { key: "qty", header: t("common.qty"), numeric: true, cell: (row) => <Num value={row.qty} /> },
              { key: "expires", header: t("reservations.expires"), cell: (row) => (row.expiresAt === null ? t("item.heldUntil") : <When at={row.expiresAt} />) },
            ]}
            card={(row) => (
              <>
                <p className="type-strong">
                  <Code>{row.orderRef}</Code> · {t(`orderStatus.${row.orderStatus}`)}
                </p>
                <Pair label={t("common.qty")}>
                  <Num value={row.qty} />
                </Pair>
                <Pair label={t("reservations.expires")}>{row.expiresAt === null ? t("item.heldUntil") : <When at={row.expiresAt} />}</Pair>
              </>
            )}
          />
        )}
      </Section>

      {item.transfers.length > 0 ? (
        <Section id="item-transfers" title={t("item.transfers")}>
          <ul role="list" className="grid gap-2">
            {item.transfers.map((transfer) => (
              <li key={transfer.id} className="adm-card flex flex-wrap items-center justify-between gap-2">
                <RowLink to={`/admin/inventory/transfers/${transfer.id}`}>
                  <Code>{transfer.ref}</Code>
                </RowLink>
                <span className="type-data">
                  <FromTo from={transfer.fromCode} to={transfer.toCode} /> · <Num value={transfer.qty} />
                </span>
                <StateTag group="transfer" value={transfer.status} label={t(`transferStatus.${transfer.status}`)} />
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {item.serials ? (
        <Section id="item-serials" title={t("item.serials")} aside={<span className="type-caption text-ink-2">{t("item.serialsCount", { total: f.number(item.serials.total) })}</span>}>
          {item.serials.rows.length === 0 ? (
            <p className="type-body text-ink-2">{t("item.noSerials")}</p>
          ) : (
            <>
              <p className="flex flex-wrap gap-3 type-caption text-ink-2">
                {Object.entries(item.serials.counts).map(([status, count]) => (
                  <span key={status}>
                    {t(`serialStatus.${status}`)}: <Num value={count} />
                  </span>
                ))}
              </p>
              <ResponsiveList
                caption={t("item.serials")}
                rows={item.serials.rows}
                rowKey={(row) => row.id}
                columns={[
                  { key: "serial", header: t("movements.serial"), cell: (row) => <RowLink to={`/admin/inventory/serials/${row.id}`}><Code>{row.serial}</Code></RowLink> },
                  { key: "status", header: t("common.status"), cell: (row) => <StateTag group="serial" value={row.status} label={t(`serialStatus.${row.status}`)} /> },
                  { key: "location", header: t("common.location"), cell: (row) => (row.locationCode ? <Code>{row.locationCode}</Code> : "—") },
                  { key: "order", header: t("serials.order"), cell: (row) => (row.orderRef ? <Code>{row.orderRef}</Code> : "—") },
                  { key: "used", header: "", cell: (row) => (row.usedUnit ? <Status tone="neutral">{t("item.usedDevice")}</Status> : null) },
                ]}
                card={(row) => (
                  <>
                    <Link to={`/admin/inventory/serials/${row.id}`} className="adm-link type-strong">
                      <Code>{row.serial}</Code>
                    </Link>
                    <StateTag group="serial" value={row.status} label={t(`serialStatus.${row.status}`)} />
                    {row.locationCode ? <Pair label={t("common.location")}><Code>{row.locationCode}</Code></Pair> : null}
                  </>
                )}
              />
            </>
          )}
        </Section>
      ) : null}

      {item.cost ? (
        <Section id="item-layers" title={t("item.layers")} aside={<span className="type-caption text-ink-2">{t("item.standardCost")}: {item.cost.standardCostIqd === null ? t("item.noStandard") : <Money iqd={item.cost.standardCostIqd} />}</span>}>
          <p className="type-caption text-ink-2">{t("item.layersLead")}</p>
          {item.cost.layers.length === 0 ? (
            <p className="type-body text-ink-2">{t("item.noLayers")}</p>
          ) : (
            <ResponsiveList
              caption={t("item.layers")}
              rows={item.cost.layers}
              rowKey={(layer) => layer.id}
              columns={[
                { key: "location", header: t("common.location"), cell: (layer) => <Code>{layer.locationCode}</Code> },
                { key: "received", header: t("item.receivedAt"), cell: (layer) => <When at={layer.receivedAt} kind="date" /> },
                { key: "source", header: t("item.source"), cell: (layer) => t(`sources.${layer.source}`) },
                { key: "qtyReceived", header: t("item.qtyReceived"), numeric: true, cell: (layer) => <Num value={layer.qtyReceived} /> },
                { key: "qtyRemaining", header: t("item.qtyRemaining"), numeric: true, cell: (layer) => <Num value={layer.qtyRemaining} /> },
                { key: "unitCost", header: t("item.unitCost"), numeric: true, cell: (layer) => <Num value={layer.unitCostIqd} /> },
                { key: "value", header: t("common.value"), numeric: true, cell: (layer) => <Num value={layer.qtyRemaining * layer.unitCostIqd} /> },
              ]}
              card={(layer) => (
                <>
                  <p className="type-strong">
                    <Code>{layer.locationCode}</Code> · <When at={layer.receivedAt} kind="date" />
                  </p>
                  <Pair label={t("item.qtyRemaining")}>
                    <Num value={layer.qtyRemaining} /> / <Num value={layer.qtyReceived} />
                  </Pair>
                  <Pair label={t("item.unitCost")}>
                    <Num value={layer.unitCostIqd} />
                  </Pair>
                </>
              )}
            />
          )}
        </Section>
      ) : null}

      {item.movements ? (
        <Section
          id="item-movements"
          title={t("item.movements")}
          aside={
            <Link to={`/admin/inventory/movements?q=${encodeURIComponent(variant.sku)}`} className="adm-link type-label">
              {t("item.allMovements")}
            </Link>
          }
        >
          <ResponsiveList
            caption={t("item.movements")}
            rows={item.movements}
            rowKey={(row) => row.id}
            columns={[
              { key: "at", header: t("common.when"), cell: (row) => <When at={row.at} /> },
              { key: "kind", header: t("movements.kind"), cell: (row) => t(`kinds.${row.kind}`) },
              { key: "location", header: t("common.location"), cell: (row) => <Code>{row.locationCode}</Code> },
              { key: "qty", header: t("movements.change"), numeric: true, cell: (row) => <Num value={row.qtyDelta} signed />, negative: (row) => row.qtyDelta < 0 },
              { key: "reason", header: t("common.reason"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.reason ?? (row.refType ? `${t(`refTypes.${row.refType}`)} ${row.refLabel ?? ""}` : "—")}</span> },
              { key: "actor", header: t("common.by"), cell: (row) => row.actor.name ?? t(`actorKinds.${row.actor.kind}`) },
            ]}
            card={(row) => (
              <>
                <p className="type-strong">
                  {t(`kinds.${row.kind}`)} · <Num value={row.qtyDelta} signed />
                </p>
                <p className="type-caption text-ink-2">{row.reason ?? "—"}</p>
                <Pair label={t("common.when")}>
                  <When at={row.at} />
                </Pair>
              </>
            )}
            empty={<p className="type-body text-ink-2">{t("movements.empty")}</p>}
          />
        </Section>
      ) : null}

      {adjusting !== null ? <AdjustDialog item={item} locations={locations} access={access} locationId={adjusting} idempotencyKey={loaderData.key} onClose={() => setAdjusting(null)} /> : null}
      {reordering !== null ? <ReorderDialog item={item} locations={locations} locationId={reordering} onClose={() => setReordering(null)} /> : null}
    </>
  );
}

function LocationCell({ level }: { level: Level }) {
  const t = useInvT();
  return (
    <span className="grid min-w-[10rem]">
      <span className="type-data">
        <Code>{level.location.path}</Code>
      </span>
      <span className="type-caption text-ink-2">
        {level.location.name}
        {!level.location.isSellable ? ` · ${t("common.notSellable")}` : ""}
        {!level.location.isActive ? ` · ${t("common.inactive")}` : ""}
        {level.allowOversell ? ` · ${t("oversell.flag")}` : ""}
      </span>
    </span>
  );
}

// ───────────────────────────────────────────────────────────────── dialogs

function useCloseOnSuccess(fetcher: { data?: ActionData; state: string }, onDone: () => void, message: string) {
  const handled = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    if (fetcher.data.ok) {
      toast.success(message);
      onDone();
    }
  }, [fetcher.data, fetcher.state, onDone, message]);
}

function AdjustDialog({
  item,
  locations,
  access,
  locationId: initialLocation,
  idempotencyKey,
  onClose,
}: {
  item: Loaded["item"];
  locations: Loaded["locations"];
  access: Loaded["access"];
  locationId: string;
  idempotencyKey: string;
  onClose: () => void;
}) {
  const t = useInvT();
  const f = useFormat();
  const fetcher = useFetcher<ActionData>({ key: `adjust-${item.variant.id}` });
  const [locationId, setLocationId] = useState(initialLocation);
  const [kind, setKind] = useState<"adjust" | "damage">("adjust");
  const [direction, setDirection] = useState<"add" | "remove">("remove");
  const [qty, setQty] = useState("");
  const [cost, setCost] = useState("");
  const [reason, setReason] = useState("");
  const [allow, setAllow] = useState(false);
  const [tried, setTried] = useState(false);
  useCloseOnSuccess(fetcher, onClose, t("adjust.done"));

  const level = item.levels.find((entry) => entry.location.id === locationId) ?? { onHand: 0, reserved: 0 };
  const units = Number.parseInt(qty, 10);
  const valid = Number.isSafeInteger(units) && units > 0;
  const delta = valid ? (kind === "damage" || direction === "remove" ? -units : units) : 0;
  const onHandAfter = level.onHand + delta;
  const freeAfter = onHandAfter - level.reserved;
  const oversell = delta < 0 && freeAfter < 0;
  const negativeOnHand = onHandAfter < 0;
  const valueChange = useMemo(() => {
    if (!item.cost || !valid) return undefined;
    if (delta > 0) return cost ? delta * Number(cost) : null;
    // FIFO: the oldest layers at this location go first; beyond them the standard cost, else unknown.
    const layers = item.cost.layers.filter((layer) => layer.locationCode === item.levels.find((entry) => entry.location.id === locationId)?.location.code && layer.qtyRemaining > 0);
    let left = -delta;
    let total = 0;
    for (const layer of layers) {
      const take = Math.min(left, layer.qtyRemaining);
      total += take * layer.unitCostIqd;
      left -= take;
      if (left === 0) break;
    }
    if (left > 0) {
      if (item.cost.standardCostIqd === null) return null;
      total += left * item.cost.standardCostIqd;
    }
    return -total;
  }, [item, valid, delta, cost, locationId]);
  const failed = fetcher.data && !fetcher.data.ok ? fetcher.data : null;
  const reasonError = tried && reason.trim().length < 3 ? t("adjust.reasonHint") : failed?.fields?.reason;
  const qtyError = tried && !valid ? t("adjust.qty") : (failed?.fields?.delta ?? failed?.fields?.qty);
  const blocked = negativeOnHand || (oversell && (!access.oversell || !allow));

  return (
    <Dialog
      open
      onClose={onClose}
      title={t("adjust.title", { sku: item.variant.sku })}
      description={t("adjust.lead")}
      dismissible={fetcher.state === "idle"}
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (!valid || reason.trim().length < 3 || blocked) return;
        fetcher.submit(
          { intent: "adjust", key: idempotencyKey, locationId, kind, direction: kind === "damage" ? "remove" : direction, qty: String(units), unitCostIqd: cost, reason, allowOversell: allow ? "on" : "" },
          { method: "post" },
        );
      }}
      footer={
        <>
          <Key onClick={onClose} disabled={fetcher.state !== "idle"} className="flex-1 sm:flex-none">
            {t("common.cancel")}
          </Key>
          <Key type="submit" variant="ink" loading={fetcher.state !== "idle"} disabled={blocked} className="flex-1 sm:flex-none">
            {kind === "damage" ? t("adjust.submitDamage") : t("adjust.submit")}
          </Key>
        </>
      }
    >
      <div className="grid gap-4">
        <Select label={t("adjust.location")} value={locationId} onChange={(event) => setLocationId(event.target.value)} options={locations.map((option) => ({ value: option.value, label: option.label }))} />
        <FieldGroup legend={t("adjust.kind")}>
          <Radio name="kind" value="adjust" label={t("adjust.kindAdjust")} checked={kind === "adjust"} onChange={() => setKind("adjust")} />
          <Radio name="kind" value="damage" label={t("adjust.kindDamage")} checked={kind === "damage"} onChange={() => setKind("damage")} />
        </FieldGroup>
        {kind === "adjust" ? (
          <FieldGroup legend={t("adjust.direction")} layout="row">
            <Radio name="direction" value="add" label={t("adjust.add")} checked={direction === "add"} onChange={() => setDirection("add")} />
            <Radio name="direction" value="remove" label={t("adjust.remove")} checked={direction === "remove"} onChange={() => setDirection("remove")} />
          </FieldGroup>
        ) : null}
        <TextField label={t("adjust.qty")} inputMode="numeric" value={qty} onChange={(event) => setQty(digitsOnly(event.target.value))} required error={qtyError} />
        {access.cost && delta > 0 ? <TextField label={t("adjust.unitCost")} hint={t("adjust.unitCostHint")} inputMode="numeric" value={cost} onChange={(event) => setCost(digitsOnly(event.target.value))} optional /> : null}
        <TextArea label={t("adjust.reason")} hint={t("adjust.reasonHint")} value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={500} error={reasonError} />

        <div className="rounded-lg bg-niche px-4 py-3">
          <p className="type-caption text-ink-2">{t("adjust.impact")}</p>
          <dl className="mt-1 grid gap-1">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="type-label">{t("adjust.onHandAfter")}</dt>
              <dd className="type-data">
                <bdi dir="ltr" className="nums">
                  {f.number(level.onHand)} → <Num value={onHandAfter} />
                </bdi>
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-4">
              <dt className="type-label">{t("adjust.freeAfter")}</dt>
              <dd className="type-data">
                <Num value={freeAfter} />
              </dd>
            </div>
            {valueChange !== undefined ? (
              <div className="flex items-baseline justify-between gap-4">
                <dt className="type-label">{t("adjust.valueChange")}</dt>
                <dd className="type-data">
                  <Money iqd={valueChange} />
                </dd>
              </div>
            ) : null}
          </dl>
        </div>

        {negativeOnHand ? (
          <p role="alert" className="type-label text-red-ink">
            {t("adjust.negativeOnHand")}
          </p>
        ) : oversell ? (
          <div className="grid gap-2" role="alert">
            <p className="type-label text-red-ink">{t("adjust.oversellWarn", { units: f.number(-freeAfter) })}</p>
            {access.oversell ? <Checkbox label={t("adjust.oversellConfirm")} hint={t("adjust.oversellConfirmHint")} checked={allow} onChange={(event) => setAllow(event.target.checked)} /> : <p className="type-body text-ink">{t("adjust.oversellNeedsPermission")}</p>}
          </div>
        ) : null}
        {failed?.message ? (
          <p role="alert" className="type-label text-red-ink">
            {failed.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

function ReorderDialog({ item, locations, locationId: initial, onClose }: { item: Loaded["item"]; locations: Loaded["locations"]; locationId: string; onClose: () => void }) {
  const t = useInvT();
  const fetcher = useFetcher<ActionData>({ key: `reorder-${item.variant.id}` });
  const [locationId, setLocationId] = useState(initial);
  const level = item.levels.find((entry) => entry.location.id === locationId);
  useCloseOnSuccess(fetcher, onClose, t("reorderForm.done"));
  const failed = fetcher.data && !fetcher.data.ok ? fetcher.data : null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={t("reorderForm.title", { sku: item.variant.sku })}
      description={t("reorderForm.lead")}
      dismissible={fetcher.state === "idle"}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        form.set("intent", "reorder");
        form.set("locationId", locationId);
        fetcher.submit(form, { method: "post" });
      }}
      footer={
        <>
          <Key onClick={onClose} disabled={fetcher.state !== "idle"} className="flex-1 sm:flex-none">
            {t("common.cancel")}
          </Key>
          <Key type="submit" variant="ink" loading={fetcher.state !== "idle"} className="flex-1 sm:flex-none">
            {t("reorderForm.submit")}
          </Key>
        </>
      }
    >
      <div className="grid gap-4" key={locationId}>
        <Select label={t("reorderForm.location")} value={locationId} onChange={(event) => setLocationId(event.target.value)} options={locations.map((option) => ({ value: option.value, label: option.label }))} />
        <TextField name="reorderPoint" label={t("reorderForm.point")} hint={t("reorderForm.pointHint")} inputMode="numeric" defaultValue={level?.reorderPoint ?? ""} optional error={failed?.fields?.reorderPoint} />
        <TextField name="reorderQty" label={t("reorderForm.qty")} hint={t("reorderForm.qtyHint")} inputMode="numeric" defaultValue={level?.reorderQty ?? ""} optional error={failed?.fields?.reorderQty} />
        {failed?.message ? (
          <p role="alert" className="type-label text-red-ink">
            {failed.message}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
