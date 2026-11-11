import { useRef, useState, type FormEvent } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/transfer";
import { useFormat } from "~/i18n/react";
import { AppError, throwAsResponse } from "~/server/errors";
import { inventoryAccess } from "~/server/services/admin/inventory/shared.server";
import { getTransfer, serialsAvailableAt } from "~/server/services/admin/inventory/transfers.server";
import { cancelTransfer, closeTransferShortfall, receiveTransfer, shipTransfer } from "~/server/services/inventory/transfers.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog } from "./components/ActionDialog";
import { Code, Kpi, Money, Note, Num, PageHead, Pair, ResponsiveList, FromTo, RowLink, Section, StateTag, When, useInvT, usePrintInLight } from "./components/kit";
import { failed, int, lines, newKey, ok, openInventory, text } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/transfers/:transferId — one transfer (04.07): its lines and people, and the next step: ship the
 * draft (serial numbers scanned for tracked items) or cancel it; receive what arrived (quantities, serials scanned at
 * the destination), as often as goods come; or close a shortfall with a reason. Every step shows its stock impact
 * before it is confirmed and goes through the core-level transfers service. The slip prints from the browser.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "inventory.stock.read");
  try {
    const transfer = await getTransfer(db, actor, params.transferId, locale);
    const tracked = transfer.status === "draft" ? transfer.items.filter((item) => item.variant.trackSerials && !item.serialId).map((item) => item.variant.id) : [];
    const available = await serialsAvailableAt(db, actor, transfer.from.id, tracked);
    return { transfer, available: Object.fromEntries(available), access: inventoryAccess(actor), key: newKey() };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const transferId = params.transferId;
  const permission = intent === "receive" ? "inventory.transfer.receive" : intent === "shortfall" ? "inventory.stock.adjust" : "inventory.transfer.create";
  const { db, actor, locale, now } = await openInventory(context, permission);
  try {
    if (intent === "ship") {
      const serials = [...form.keys()].filter((key) => key.startsWith("serials:")).map((key) => ({ itemId: key.slice("serials:".length), serials: lines(form, key) }));
      await shipTransfer(db, actor, { transferId, serials: serials.filter((entry) => entry.serials.length > 0) }, now);
      return ok({ intent });
    }
    if (intent === "receive") {
      const qtyLines = [...form.keys()].filter((key) => key.startsWith("qty:")).map((key) => ({ itemId: key.slice("qty:".length), qty: int(form, key) ?? 0 }));
      const result = await receiveTransfer(db, actor, { transferId, lines: qtyLines, serials: lines(form, "serials"), idempotencyKey: text(form, "key") }, now);
      return ok({ intent, received: result.received, complete: result.complete, replayed: result.replayed });
    }
    if (intent === "shortfall") {
      const result = await closeTransferShortfall(db, actor, { transferId, reason: text(form, "reason"), idempotencyKey: text(form, "key") }, now);
      return ok({ intent, lost: result.lost });
    }
    if (intent === "cancel") {
      await cancelTransfer(db, actor, { transferId, reason: text(form, "reason") }, now);
      return ok({ intent });
    }
    return failed(new AppError("invalid", 400), locale, intent);
  } catch (error) {
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "transfer.title", { ref: args.loaderData?.transfer.ref ?? "" });

type Transfer = Route.ComponentProps["loaderData"]["transfer"];

/** A form that asks for a confirmation (with the impact) before it posts. */
function useConfirmedSubmit() {
  const [open, setOpen] = useState(false);
  const form = useRef<HTMLFormElement | null>(null);
  const confirmed = useRef(false);
  return {
    open,
    close: () => setOpen(false),
    formRef: form,
    onSubmit: (event: FormEvent<HTMLFormElement>) => {
      if (!confirmed.current) {
        event.preventDefault();
        setOpen(true);
        return;
      }
      confirmed.current = false;
    },
    confirm: () => {
      confirmed.current = true;
      setOpen(false);
      form.current?.requestSubmit();
    },
  };
}

export default function TransferPage({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const { transfer, available, access } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const [dialog, setDialog] = useState<null | "cancel" | "shortfall">(null);
  const ship = useConfirmedSubmit();
  const receive = useConfirmedSubmit();
  const failure = result && !result.ok ? result : null;
  const done = result && result.ok ? result : null;
  const remaining = transfer.units - transfer.unitsReceived;
  const busy = navigation.state === "submitting";
  const canShip = transfer.status === "draft" && access.transferCreate;
  const canReceive = transfer.status === "in_transit" && access.transferReceive;
  const untracked = transfer.items.filter((item) => !item.serialId && item.qtyReceived < item.qty);
  const serialLines = transfer.items.filter((item) => item.serialId && item.qtyReceived < item.qty);
  // The slip prints ink on paper also from a dark screen.
  const slip = useRef<HTMLDivElement | null>(null);
  usePrintInLight(slip);

  return (
    <>
      <p className="mb-2 inv-no-print">
        <Link to="/admin/inventory/transfers" className="adm-link type-label">
          {t("transfer.back")}
        </Link>
      </p>
      <div ref={slip} className="inv-print">
        <PageHead
          eyebrow={
            <>
              <FromTo from={transfer.from.path} to={transfer.to.path} />
            </>
          }
          title={t("transfer.title", { ref: transfer.ref })}
          actions={
            <>
              <StateTag group="transfer" value={transfer.status} label={t(`transferStatus.${transfer.status}`)} />
              <span className="inv-no-print">
                <Key size="sm" icon="printer" onClick={() => window.print()}>
                  {t("transfer.printSlip")}
                </Key>
              </span>
            </>
          }
        />
        <div className="inv-kpis mb-5">
          <Kpi label={t("transfers.units")} value={f.number(transfer.units)} />
          <Kpi label={t("transfers.unitsReceived")} value={f.number(transfer.unitsReceived)} />
          {transfer.unitsLost > 0 ? <Kpi label={t("transfer.lost")} value={f.number(transfer.unitsLost)} /> : null}
          {transfer.valueIqd !== undefined ? <Kpi wide label={t("transfer.value")} value={<Money iqd={transfer.valueIqd} />} /> : null}
        </div>
        <dl className="adm-card mb-5 grid gap-2 sm:grid-cols-3">
          <div>
            <dt className="type-caption text-ink-2">{t("transfer.requestedBy")}</dt>
            <dd className="type-body">
              {transfer.people.requestedBy ?? "—"} · <When at={transfer.times.createdAt} />
            </dd>
          </div>
          <div>
            <dt className="type-caption text-ink-2">{t("transfer.shippedBy")}</dt>
            <dd className="type-body">
              {transfer.people.shippedBy ?? "—"} · <When at={transfer.times.shippedAt} />
            </dd>
          </div>
          <div>
            <dt className="type-caption text-ink-2">{t("transfer.receivedBy")}</dt>
            <dd className="type-body">
              {transfer.people.receivedBy ?? "—"} · <When at={transfer.times.receivedAt} />
            </dd>
          </div>
          {transfer.notes ? <p className="type-body sm:col-span-3">{transfer.notes}</p> : null}
          {transfer.closingReason ? <p className="type-body sm:col-span-3">{t("transfer.closingReason", { reason: transfer.closingReason })}</p> : null}
        </dl>
        {transfer.status === "in_transit" ? (
          <Note icon="truck" className="mb-5">
            {t("transfer.inTransitNote")}
          </Note>
        ) : null}

        <Section id="transfer-lines" title={t("transfer.lines")}>
          <ResponsiveList
            caption={t("transfer.lines")}
            rows={transfer.items}
            rowKey={(item) => item.id}
            columns={[
              { key: "sku", header: t("common.sku"), cell: (item) => <RowLink to={`/admin/inventory/stock/${item.variant.id}`}><Code>{item.variant.sku}</Code></RowLink> },
              { key: "name", header: t("common.product"), cell: (item) => <span className="line-clamp-2 min-w-[12rem]">{item.variant.name}</span> },
              { key: "qty", header: t("common.qty"), numeric: true, cell: (item) => <Num value={item.qty} /> },
              { key: "received", header: t("transfers.unitsReceived"), numeric: true, cell: (item) => <Num value={item.qtyReceived} /> },
              ...(access.serials ? [{ key: "serial", header: t("transfer.serial"), cell: (item: Transfer["items"][number]) => (item.serial ? <span><Code>{item.serial}</Code> · {item.serialStatus ? t(`serialStatus.${item.serialStatus}`) : ""}</span> : "—") }] : []),
            ]}
            card={(item) => (
              <>
                <p className="type-strong">{item.variant.name}</p>
                <p className="type-caption text-ink-2">
                  <Code>{item.variant.sku}</Code>
                  {item.serial ? (
                    <>
                      {" · "}
                      <Code>{item.serial}</Code>
                    </>
                  ) : null}
                </p>
                <Pair label={t("transfers.unitsReceived")}>
                  <Num value={item.qtyReceived} /> / <Num value={item.qty} />
                </Pair>
              </>
            )}
          />
        </Section>
      </div>

      {failure ? (
        <p role="alert" className="mb-4 type-label text-red-ink inv-no-print">
          {failure.message ?? Object.values(failure.fields ?? {})[0]}
        </p>
      ) : null}
      {done && done.intent === "receive" ? (
        <p role="status" className="mb-4 type-label text-ok inv-no-print">
          {"complete" in done && done.complete ? t("transfer.receivedAll") : t("transfer.received_ok", { count: t("common.units", { count: Number("received" in done ? done.received : 0) }) })}
        </p>
      ) : null}
      {done && done.intent === "ship" ? (
        <p role="status" className="mb-4 type-label text-ok inv-no-print">
          {t("transfer.shipped_ok")}
        </p>
      ) : null}

      {canShip ? (
        <Section id="transfer-ship" title={t("transfer.shipTitle")} className="inv-no-print">
          <p className="type-body text-ink-2">{t("transfer.shipLead", { from: transfer.from.code, to: transfer.to.code })}</p>
          <Form method="post" key={loaderData.key} ref={ship.formRef} onSubmit={ship.onSubmit} className="adm-card grid gap-4">
            <input type="hidden" name="intent" value="ship" />
            {transfer.items
              .filter((item) => item.variant.trackSerials && !item.serialId)
              .map((item) => (
                <TextArea
                  key={item.id}
                  name={`serials:${item.id}`}
                  label={t("transfer.shipSerials", { sku: item.variant.sku })}
                  hint={t("transfer.shipSerialsHint", { qty: f.number(item.qty), available: available[item.variant.id]?.slice(0, 12).join(", ") || "—" })}
                  rows={Math.min(6, Math.max(2, item.qty))}
                  dir="ltr"
                  spellCheck={false}
                  required
                />
              ))}
            <div className="flex flex-wrap gap-2">
              <Key type="submit" variant="commit" icon="truck" loading={busy}>
                {t("transfer.ship")}
              </Key>
              <Key onClick={() => setDialog("cancel")} className="[--on:var(--red-ink)]">
                {t("transfer.cancel")}
              </Key>
            </div>
          </Form>
          <ConfirmDialog
            open={ship.open}
            onClose={ship.close}
            title={t("transfer.shipConfirm")}
            consequence={t("transfer.shipConsequence", { units: t("common.units", { count: transfer.units }), from: transfer.from.code, to: transfer.to.code })}
            confirmLabel={t("transfer.ship")}
            tone="commit"
            impact={[
              { label: `${t("common.onHand")} · ${transfer.from.code}`, value: `−${f.number(transfer.units)}`, negative: true },
              { label: `${t("common.incoming")} · ${transfer.to.code}`, value: `+${f.number(transfer.units)}` },
            ]}
            onConfirm={ship.confirm}
          />
        </Section>
      ) : null}

      {canReceive && remaining > 0 ? (
        <Section id="transfer-receive" title={t("transfer.receiveTitle")} className="inv-no-print">
          <p className="type-body text-ink-2">{t("transfer.receiveLead")}</p>
          <Form method="post" key={loaderData.key} ref={receive.formRef} onSubmit={receive.onSubmit} className="adm-card grid gap-4">
            <input type="hidden" name="intent" value="receive" />
            <input type="hidden" name="key" value={loaderData.key} />
            {untracked.map((item) => (
              <TextField
                key={item.id}
                name={`qty:${item.id}`}
                label={`${item.variant.sku} · ${item.variant.name}`}
                hint={t("transfer.remaining", { count: f.number(item.qty - item.qtyReceived) })}
                inputMode="numeric"
                defaultValue={String(item.qty - item.qtyReceived)}
              />
            ))}
            {serialLines.length > 0 ? <TextArea name="serials" label={t("transfer.receiveSerials")} hint={`${t("transfer.receiveSerialsHint")} ${t("transfer.remaining", { count: f.number(serialLines.length) })}`} rows={Math.min(6, Math.max(2, serialLines.length))} dir="ltr" spellCheck={false} /> : null}
            <div className="flex flex-wrap gap-2">
              {/* lint-design: allow commit-count — ship (a draft) and receive (in transit) never render in the same view */}
              <Key type="submit" variant="commit" icon="package" loading={busy}>
                {t("transfer.receive")}
              </Key>
              {access.adjust ? (
                <Key onClick={() => setDialog("shortfall")} className="[--on:var(--red-ink)]">
                  {t("transfer.shortfall")}
                </Key>
              ) : null}
            </div>
          </Form>
          <ConfirmDialog
            open={receive.open}
            onClose={receive.close}
            title={t("transfer.receiveConfirm")}
            consequence={t("transfer.receiveConsequence", { units: t("common.units", { count: remaining }), to: transfer.to.code })}
            confirmLabel={t("transfer.receive")}
            tone="commit"
            impact={[{ label: `${t("common.onHand")} · ${transfer.to.code}`, value: t("transfer.upTo", { n: f.number(remaining) }) }]}
            onConfirm={receive.confirm}
          />
        </Section>
      ) : null}
      {transfer.status === "in_transit" && !access.transferReceive ? <Note className="inv-no-print">{t("transfer.noReceivePermission", { to: transfer.to.code })}</Note> : null}

      <ActionDialog
        open={dialog === "cancel"}
        onClose={() => setDialog(null)}
        title={t("transfer.cancelConfirm")}
        consequence={t("transfer.cancelConsequence")}
        confirmLabel={t("transfer.cancel")}
        tone="destructive"
        reason
        fields={{ intent: "cancel" }}
        successMessage={t("transfer.cancelled_ok")}
      />
      <ActionDialog
        open={dialog === "shortfall"}
        onClose={() => setDialog(null)}
        title={t("transfer.shortfallConfirm")}
        consequence={t("transfer.shortfallConsequence", { units: t("common.units", { count: remaining }) })}
        confirmLabel={t("transfer.shortfall")}
        tone="destructive"
        reason={{ hint: t("transfer.shortfallReasonHint") }}
        impact={[
          { label: t("transfer.lost"), value: `−${f.number(remaining)}`, negative: true },
          // [P] the value of the units written off (not of the whole transfer) — only in cost.read's data
          ...(transfer.shortfallValueIqd !== undefined
            ? [{ label: t("transfer.lostValue"), value: transfer.shortfallValueIqd === null ? t("common.valueUnknown") : `−${f.iqd(transfer.shortfallValueIqd)}`, negative: transfer.shortfallValueIqd !== null }]
            : []),
        ]}
        fields={{ intent: "shortfall", key: loaderData.key }}
        successMessage={t("transfer.shortfallDone")}
      />
    </>
  );
}
