import { useEffect, useRef, useState } from "react";
import { data, Link, useFetcher } from "react-router";

import type { Route } from "./+types/pack";
import { Icon } from "~/art/Icon";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { throwAsResponse } from "~/server/errors";
import { getPackView, type LineProgress, type ScanOutcome } from "~/server/services/admin/orders/fulfillment.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { ordersMeta } from "./meta";
import { urls } from "./common.server";
import { packAction, type PackActionResult } from "./pack.server";
import { DemoNote, Failure, newKey, OrderStatusBadge, Ref, Section, useOrdersT, When } from "./ui";

/**
 * /admin/orders/:ref/pack — the packing station (04.11 pick → pack → ship, 05.03 serial scan before handover, 05.04
 * parcels). A barcode/QR scanner is a keyboard: it types into the focused field and presses Enter, so the station
 * needs no driver and no integration. Every scan is judged on the server (the right item, the right serial, not sold
 * twice) and written down, accepted or refused. Handing over (shipped) needs every line verified, and the commerce
 * core checks the serials and the stock once more.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.fulfillment.pack");
  try {
    return { view: await getPackView(db, actor, params.ref, ctx.locale, urls.deliveryProof) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await requireEmployee(ctx, db, "orders.fulfillment.pack");
  const result = await packAction(ctx, db, session, params.ref, await request.formData());
  return result.ok ? result : data(result, { status: result.status });
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "pack.title");

export default function PackPage({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const { view } = loaderData;
  const packable = view.status === "confirmed" || view.status === "preparing";
  const complete = view.progress.complete;
  const allPacked = view.parcels.length > 0 && view.parcels.every((parcel) => parcel.status !== "pending");
  return (
    <div className="mx-auto max-w-5xl">
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to={`/admin/orders/${view.ref}`} className="adm-link">
            {t("pack.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-2">
          {t("pack.title")} <Ref value={view.ref} /> <DemoNote show={view.isDemo} />
        </h1>
        <div className="flex flex-wrap items-center gap-3">
          <OrderStatusBadge status={view.status as never} />
          <span className="type-caption text-ink-2">{view.assignedTo ? t("assign.current", { name: view.assignedTo.name }) : t("assign.nobody")}</span>
        </div>
      </header>

      {view.onHold ? (
        <p className="adm-notice adm-notice--bad mb-4" role="alert">
          <Icon name="lock" size={18} />
          <span>{t("errors.order_on_hold")}</span>
        </p>
      ) : null}
      {!packable ? (
        <p className="adm-notice mb-4" role="status">
          <Icon name="info" size={18} />
          <span>{t("pack.notPackable", { status: t(`status.${view.status}`) })}</span>
        </p>
      ) : null}

      {packable && !view.onHold ? <ScanBox /> : null}

      <Section id="pack-lines" title={t("pack.lines")}>
        <ul className="grid gap-2">
          {view.progress.lines.map((line) => (
            <li key={line.orderItemId}>
              <LineCard line={line} canVerify={packable && !view.onHold} />
            </li>
          ))}
        </ul>
      </Section>

      <ParcelsBlock view={view} packable={packable && !view.onHold} />

      {view.rejected.length ? (
        <Section id="pack-rejected" title={t("pack.rejected")}>
          <ul className="grid gap-1">
            {view.rejected.map((row, index) => (
              <li key={index} className="flex flex-wrap items-center gap-2 type-body">
                <Icon name="x-circle" size={16} className="text-red-ink" />
                <bdi dir="ltr">{row.code}</bdi>
                <span className="type-caption text-ink-2">
                  {t(`scan.${row.reason}`)} · <When at={row.at} />
                </span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {packable && !view.onHold ? <FinishBar view={view} complete={complete} allPacked={allPacked} /> : null}
    </div>
  );
}

function ScanBox() {
  const t = useOrdersT();
  const fetcher = useFetcher<PackActionResult>();
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const [last, setLast] = useState<{ tone: "ok" | "bad"; text: string } | null>(null);
  const handled = useRef<unknown>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    const result = fetcher.data;
    if (fetcher.state !== "idle" || !result || handled.current === result) return;
    handled.current = result;
    if (!result.ok) setLast({ tone: "bad", text: result.message ?? t(`errors.${result.code}`) });
    else if (result.intent === "scan") setLast(describe(t, result.outcome));
    inputRef.current?.focus();
  }, [fetcher.state, fetcher.data, t]);

  return (
    <form
      className="ord-scan mb-6"
      onSubmit={(event) => {
        event.preventDefault();
        const value = code.trim();
        if (!value) return;
        fetcher.submit({ intent: "scan", code: value, scanId: newKey() }, { method: "post" });
        setCode("");
      }}
    >
      <TextField
        ref={inputRef}
        name="code"
        label={t("scan.label")}
        hint={t("scan.hint")}
        value={code}
        onChange={(event) => setCode(event.target.value)}
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        ltr
        end={
          <Key type="submit" size="sm" icon="barcode" loading={fetcher.state !== "idle"}>
            {t("scan.submit")}
          </Key>
        }
      />
      <p aria-live="polite" className={last?.tone === "bad" ? "flex items-center gap-1 type-strong text-red-ink" : "flex items-center gap-1 type-strong text-ok"}>
        {last ? (
          <>
            <Icon name={last.tone === "bad" ? "x-circle" : "check-circle"} size={18} />
            {last.text}
          </>
        ) : null}
      </p>
    </form>
  );
}

function describe(t: ReturnType<typeof useOrdersT>, outcome: ScanOutcome): { tone: "ok" | "bad"; text: string } {
  if (!outcome.ok) return { tone: "bad", text: t(`scan.${outcome.code}`) };
  if (outcome.kind === "already") return { tone: "ok", text: t("scan.already", { serial: outcome.serial }) };
  if (outcome.replayed) return { tone: "ok", text: t("scan.replayed") };
  if (outcome.kind === "serial") return { tone: "ok", text: t("scan.serialOk", { serial: outcome.serial, scanned: outcome.scanned, expected: outcome.expected }) };
  return { tone: "ok", text: t("scan.unitOk", { scanned: outcome.scanned, expected: outcome.expected }) };
}

function LineCard({ line, canVerify }: { line: LineProgress; canVerify: boolean }) {
  const t = useOrdersT();
  const [open, setOpen] = useState(false);
  const fetcher = useFetcher<PackActionResult>();
  const done = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && done.current !== fetcher.data) {
      done.current = fetcher.data;
      setOpen(false);
      toast.success(t("done.manual"));
    }
  }, [fetcher.state, fetcher.data, t]);
  const expected = line.serialUnits + line.scanUnits;
  const verified = line.serialsScanned.length + line.scanned;
  const error = fetcher.data && !fetcher.data.ok ? (fetcher.data.message ?? t(`errors.${fetcher.data.code}`)) : null;
  return (
    <article className="adm-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="type-strong">{line.name}</p>
        {line.complete ? <Status tone="ok">{t("pack.lineDone")}</Status> : <Status tone="warn">{t("pack.lineOpen")}</Status>}
      </div>
      <p className="type-caption text-ink-2">
        {t("detail.sku")} <bdi dir="ltr">{line.sku}</bdi>
        {line.barcode ? (
          <>
            {" · "}
            {t("pack.barcode")} <bdi dir="ltr">{line.barcode}</bdi>
          </>
        ) : null}
      </p>
      <div className="ord-progress" role="progressbar" aria-valuemin={0} aria-valuemax={expected} aria-valuenow={verified} aria-label={t("pack.progress", { verified, expected })}>
        <span style={{ inlineSize: `${expected ? Math.round((verified / expected) * 100) : 0}%` }} />
      </div>
      <p className="type-body">{t("pack.progress", { verified, expected })}</p>
      {line.serialUnits > 0 ? (
        <p className="type-caption text-ink-2">
          {t("pack.serialsNeeded", { count: line.serialUnits })}
          {line.serialsScanned.length ? ": " : ""}
          {line.serialsScanned.map((serial, index) => (
            <span key={serial.id}>
              {index > 0 ? "، " : ""}
              <bdi dir="ltr">{serial.serial}</bdi>
            </span>
          ))}
        </p>
      ) : null}
      {canVerify && line.scanUnits > line.scanned ? (
        <div>
          <Key size="sm" icon="check" onClick={() => setOpen(true)}>
            {t("pack.manual")}
          </Key>
        </div>
      ) : null}
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("pack.manualQ", { name: line.name })}
        consequence={t("pack.manualWhat", { count: line.scanUnits - line.scanned })}
        confirmLabel={t("pack.manual")}
        reason={{ label: t("dialog.reason"), hint: t("pack.manualHint") }}
        pending={fetcher.state !== "idle"}
        error={error}
        onConfirm={({ reason }) => fetcher.submit({ intent: "manual", orderItemId: line.orderItemId, reason, scanId: newKey() }, { method: "post" })}
      />
    </article>
  );
}

function ParcelsBlock({ view, packable }: { view: Route.ComponentProps["loaderData"]["view"]; packable: boolean }) {
  const t = useOrdersT();
  const fetcher = useFetcher<PackActionResult>();
  const canSplit = packable && view.parcels.every((parcel) => parcel.status === "pending" || parcel.status === "cancelled");
  const error = fetcher.data && !fetcher.data.ok && fetcher.data.intent === "split" ? (fetcher.data.message ?? t(`errors.${fetcher.data.code}`)) : null;
  return (
    <Section id="pack-parcels" title={t("pack.parcels")}>
      {view.parcels.length === 0 ? <p className="type-body text-ink-2">{t("pack.noParcels")}</p> : null}
      <ul className="grid gap-2 md:grid-cols-2">
        {view.parcels
          .filter((parcel) => parcel.status !== "cancelled")
          .map((parcel) => (
            <li key={parcel.id} className="adm-card">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="type-strong">{t("parcel.title", { number: parcel.number })}</p>
                <Status tone={parcel.status === "pending" ? "warn" : "ok"}>{t(`parcelStatus.${parcel.status}`)}</Status>
              </div>
              <ul className="type-body">
                {parcel.items.map((item) => (
                  <li key={item.orderItemId}>
                    {item.name} × <bdi className="nums">{item.qty}</bdi>
                  </li>
                ))}
              </ul>
            </li>
          ))}
      </ul>
      {canSplit && view.progress.lines.some((line) => line.qty > 0) ? (
        <fetcher.Form method="post" className="grid gap-3 rounded-xs bg-niche p-4">
          <input type="hidden" name="intent" value="split" />
          <p className="type-strong">{t("pack.splitTitle")}</p>
          <p className="type-caption text-ink-2">{t("pack.splitHint")}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {view.progress.lines.map((line) => (
              <div key={line.orderItemId}>
                <input type="hidden" name="line" value={line.orderItemId} />
                <TextField name={`qty_${line.orderItemId}`} label={line.name} type="number" inputMode="numeric" min={0} max={line.qty} defaultValue="0" ltr hint={t("pack.splitMax", { count: line.qty })} />
              </div>
            ))}
          </div>
          <Failure message={error} />
          <div>
            <Key type="submit" size="sm" icon="package" loading={fetcher.state !== "idle"}>
              {t("pack.split")}
            </Key>
          </div>
        </fetcher.Form>
      ) : null}
    </Section>
  );
}

function FinishBar({ view, complete, allPacked }: { view: Route.ComponentProps["loaderData"]["view"]; complete: boolean; allPacked: boolean }) {
  const t = useOrdersT();
  const packFetcher = useFetcher<PackActionResult>();
  const shipFetcher = useFetcher<PackActionResult>();
  const [shipOpen, setShipOpen] = useState(false);
  const [tracking, setTracking] = useState("");
  const shipped = useRef<unknown>(null);
  useEffect(() => {
    if (shipFetcher.state === "idle" && shipFetcher.data?.ok && shipped.current !== shipFetcher.data) {
      shipped.current = shipFetcher.data;
      setShipOpen(false);
      toast.success(t("done.ship"));
    }
  }, [shipFetcher.state, shipFetcher.data, t]);
  const units = view.progress.lines.reduce((sum, line) => sum + line.serialUnits + line.scanUnits, 0);
  const packError = packFetcher.data && !packFetcher.data.ok ? (packFetcher.data.message ?? t(`errors.${packFetcher.data.code}`)) : null;
  const shipError = shipFetcher.data && !shipFetcher.data.ok ? (shipFetcher.data.message ?? t(`errors.${shipFetcher.data.code}`)) : null;
  return (
    <section className="adm-section" aria-labelledby="pack-finish">
      <h2 id="pack-finish" className="adm-h2">
        {t("pack.finish")}
      </h2>
      {!complete ? <p className="type-body text-ink-2">{t("pack.notComplete")}</p> : null}
      <div className="ord-actions">
        <packFetcher.Form method="post">
          <input type="hidden" name="intent" value="packed" />
          <Key type="submit" icon="package" disabled={!complete || allPacked} loading={packFetcher.state !== "idle"}>
            {allPacked ? t("pack.packedDone") : t("pack.markPacked")}
          </Key>
        </packFetcher.Form>
        {view.canShip ? (
          <Key icon="truck" variant="ink" disabled={!complete} onClick={() => setShipOpen(true)}>
            {t("transition.shipped")}
          </Key>
        ) : (
          <span className="type-caption text-ink-2">{t("pack.noShipPermission")}</span>
        )}
      </div>
      <Failure message={packError} />
      <ConfirmDialog
        open={shipOpen}
        onClose={() => setShipOpen(false)}
        tone="commit"
        title={t("transitionQ.shipped", { ref: view.ref })}
        consequence={t("transitionWhat.shipped")}
        confirmLabel={t("transition.shipped")}
        impact={[{ label: t("impact.unitsLeave"), value: t("impact.units", { count: units }), negative: true }]}
        reason={{ noteRequired: false, label: t("dialog.noteOptional") }}
        pending={shipFetcher.state !== "idle"}
        error={shipError}
        onConfirm={({ reason }) => shipFetcher.submit({ intent: "ship", from: view.status, reason, trackingNo: tracking }, { method: "post" })}
      >
        <TextField label={t("ship.tracking")} optional hint={t("ship.trackingHint")} value={tracking} onChange={(event) => setTracking(event.target.value)} ltr />
      </ConfirmDialog>
    </section>
  );
}
