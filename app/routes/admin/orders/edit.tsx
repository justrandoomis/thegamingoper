import { asc, eq, inArray } from "drizzle-orm";
import { useMemo, useState } from "react";
import { data, Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/edit";
import { Icon } from "~/art/Icon";
import { serverT } from "~/i18n/i18n.server";
import { useFormat } from "~/i18n/react";
import { randomToken } from "~/lib/ids";
import { pick } from "~/lib/locales";
import { maskPhone } from "~/lib/phone";
import { can, type Actor } from "~/server/actor";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { districts, governorates, orderItemSerials, orderItems } from "~/server/db/schema";
import { throwAsResponse, toAppError } from "~/server/errors";
import { orderByRef } from "~/server/services/admin/orders/shared.server";
import { editLineFloors, editOrder, orderEditBlockers, planOrderEdit, type EditOrderInput, type EditPlan } from "~/server/services/orders/edit.server";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Stepper } from "~/ui/Stepper";
import { ordersMeta } from "./meta";
import { amountOf, failure, ORDERS_NS, text } from "./common.server";
import { Change, Failure, Money, Num, Ref, useOrdersT } from "./ui";

/**
 * /admin/orders/:ref/edit — 05.05: change quantities (0 removes a line) and the delivery address before the order
 * ships. Two steps, both visible before anything happens (blueprint uxRules): "preview" recomputes the totals, the
 * payment difference, the coupon and the stock to hold or release (orders/edit.server planOrderEdit — writes
 * nothing); "save" needs a reason and applies exactly what was previewed (editOrder: one batch, guarded; if the order
 * changed meanwhile and the total differs, it refuses instead of saving something else).
 */
function inputFrom(params: URLSearchParams | FormData, lineIds: readonly string[], reason: string): EditOrderInput {
  const get = (name: string) => {
    const value = params.get(name);
    return typeof value === "string" ? value : "";
  };
  const lines = lineIds.filter((id) => get(`q_${id}`) !== "").map((id) => ({ orderItemId: id, qty: Number(get(`q_${id}`)) }));
  const address = get("governorateId")
    ? {
        contactName: get("contactName") || null,
        phone: get("phone"),
        governorateId: get("governorateId"),
        districtId: get("districtId") || null,
        areaText: get("areaText"),
        addressText: get("addressText"),
        notes: get("notes") || null,
      }
    : undefined;
  return { lines, address, reason };
}

async function load(db: ReturnType<typeof getDb>, actor: Actor, ref: string, locale: "ar" | "en" | "ckb") {
  const order = await orderByRef(db, ref);
  const [items, govs, dists, blockers, floors] = await Promise.all([
    db
      .select({ id: orderItems.id, name: orderItems.nameSnapshot, sku: orderItems.sku, qty: orderItems.qty, unitPriceIqd: orderItems.unitPriceIqd, usedUnitId: orderItems.usedUnitId })
      .from(orderItems)
      .where(eq(orderItems.orderId, order.id))
      .orderBy(asc(orderItems.id)),
    db.select({ id: governorates.id, name: governorates.name }).from(governorates).where(eq(governorates.isActive, true)).orderBy(asc(governorates.sort)),
    db.select({ id: districts.id, governorateId: districts.governorateId, name: districts.name }).from(districts).where(eq(districts.isActive, true)).orderBy(asc(districts.sort)),
    orderEditBlockers(db, order),
    editLineFloors(db, order.id),
  ]);
  const serialRows = items.length
    ? await db
        .select({ orderItemId: orderItemSerials.orderItemId, releasedAt: orderItemSerials.releasedAt })
        .from(orderItemSerials)
        .where(
          inArray(
            orderItemSerials.orderItemId,
            items.map((item) => item.id),
          ),
        )
    : [];
  // The number in full only for customer.phone.read_full (field permission, SECURITY.md §7): anyone else sees it
  // masked and leaves the field empty, and the order keeps its number (orders/edit.server).
  const fullPhone = can(actor, "customer.phone.read_full");
  /** The lowest quantity the server accepts (orders/edit.server): attached serials keep the line, verified units stay in it. */
  const floorOf = (item: (typeof items)[number]) => {
    const serials = serialRows.filter((row) => row.orderItemId === item.id);
    if (serials.some((row) => row.releasedAt === null)) return item.qty;
    return Math.max(serials.length > 0 ? 1 : 0, floors.get(item.id) ?? 0);
  };
  return {
    order: {
      id: order.id,
      ref: order.ref,
      status: order.status,
      totalIqd: order.totalIqd,
      contactName: order.contactName ?? "",
      phone: fullPhone && order.contactPhoneE164 ? order.contactPhoneE164.replace(/^\+964/, "0") : "",
      phoneMasked: !fullPhone && order.contactPhoneE164 ? maskPhone(order.contactPhoneE164) : null,
      governorateId: order.governorateId ?? "",
      districtId: order.districtId ?? "",
      areaText: order.areaText ?? "",
      addressText: order.addressText ?? "",
      notes: order.notes ?? "",
    },
    lines: items.map((item) => ({
      id: item.id,
      name: pick(item.name, locale),
      sku: item.sku,
      qty: item.qty,
      unitPriceIqd: item.unitPriceIqd,
      used: item.usedUnitId !== null,
      serials: serialRows.filter((row) => row.orderItemId === item.id && row.releasedAt === null).length,
      min: floorOf(item),
    })),
    governorates: govs.map((row) => ({ id: row.id, name: pick(row.name, locale) })),
    districts: dists.map((row) => ({ id: row.id, governorateId: row.governorateId, name: pick(row.name, locale) })),
    blockers,
  };
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.update");
  const url = new URL(request.url);
  let page: Awaited<ReturnType<typeof load>>;
  try {
    page = await load(db, actor, params.ref, ctx.locale);
  } catch (error) {
    throwAsResponse(error);
  }
  let plan: EditPlan | null = null;
  let problem: { code: string; message: string } | null = null;
  if (url.searchParams.get("preview") === "1") {
    try {
      plan = await planOrderEdit(
        db,
        actor,
        page.order.id,
        inputFrom(
          url.searchParams,
          page.lines.map((line) => line.id),
          "preview",
        ),
      );
    } catch (error) {
      const appError = toAppError(error);
      if (!appError) throw error;
      problem = { code: appError.code, message: failure(error, ctx.locale, "edit").message ?? serverT(ctx.locale, ORDERS_NS)(`errors.${appError.code}`) };
    }
  }
  return { ...page, plan, problem, search: url.search, key: randomToken(18) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.order.update");
  const form = await request.formData();
  try {
    const order = await orderByRef(db, params.ref);
    const lineIds = form.getAll("line").map((value) => String(value));
    const input = inputFrom(form, lineIds, text(form, "reason"));
    await editOrder(db, actor, order.id, { ...input, idempotencyKey: text(form, "idempotencyKey"), expectedTotalIqd: amountOf(form, "expectedTotalIqd") }, ctx.now);
    return redirect(`/admin/orders/${order.ref}?edited=1`);
  } catch (error) {
    const result = failure(error, ctx.locale, "edit");
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "edit.title");

export default function EditOrderPage({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  const { order, lines, governorates: govs, districts: dists, blockers, plan, problem, key, search } = loaderData;
  const linesLocked = blockers.lines !== null;
  const addressLocked = blockers.address !== null;
  const saving = navigation.state === "submitting" && navigation.formMethod?.toLowerCase() === "post";
  const saveError = actionData && !actionData.ok ? (actionData.message ?? t(`errors.${actionData.code}`)) : null;

  return (
    <div className="adm-narrow">
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to={`/admin/orders/${order.ref}`} className="adm-link">
            {t("pack.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-2">
          {t("edit.title")} <Ref value={order.ref} />
        </h1>
        <p className="type-body text-ink-2">{t("edit.lead")}</p>
      </header>

      {linesLocked || addressLocked ? (
        <p className="adm-notice adm-notice--warn mb-4" role="note">
          <Icon name="lock" size={18} />
          <span>{t(`errors.${blockers.address ?? blockers.lines}`)}</span>
        </p>
      ) : null}

      {addressLocked ? null : <EditForm key={search} search={search} order={order} lines={lines} governorates={govs} districts={dists} linesLocked={linesLocked} />}

      {problem ? (
        <p className="adm-notice adm-notice--bad mt-6" role="alert">
          <Icon name="warning-circle" size={18} />
          <span>{problem.message}</span>
        </p>
      ) : null}

      {plan ? <Preview plan={plan} lines={lines} search={loaderData.search} idempotencyKey={key} saving={saving} error={saveError} /> : null}
    </div>
  );
}

type EditData = Route.ComponentProps["loaderData"];

/**
 * The preview form (GET, so the choice lives in the URL). With a preview in the URL its fields start from the URL —
 * a reload, a shared link or Back shows exactly what the preview below was computed from — otherwise from the order.
 * Keyed by the URL by its caller, so Back / Forward re-sync the uncontrolled fields.
 */
function EditForm({ search, order, lines, governorates: govs, districts: dists, linesLocked }: Pick<EditData, "search" | "order" | "lines" | "governorates" | "districts"> & { linesLocked: boolean }) {
  const t = useOrdersT();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const previewing = params.get("preview") === "1";
  const start = (name: string, fallback: string) => (previewing && params.has(name) ? (params.get(name) ?? fallback) : fallback);
  const [governorateId, setGovernorateId] = useState(() => start("governorateId", order.governorateId));
  const districtOptions = useMemo(() => dists.filter((row) => row.governorateId === governorateId), [dists, governorateId]);
  const bounds = (line: EditData["lines"][number]) => ({ min: line.min, max: line.used ? 1 : Math.max(100, line.qty) });
  const qtyOf = (line: EditData["lines"][number]) => {
    const { min, max } = bounds(line);
    const raw = previewing ? params.get(`q_${line.id}`) : null;
    const value = raw === null || raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : line.qty;
  };

  return (
    <Form method="get" className="grid gap-6">
      <input type="hidden" name="preview" value="1" />
      <section className="adm-section" aria-labelledby="edit-lines">
        <h2 id="edit-lines" className="adm-h2">
          {t("edit.lines")}
        </h2>
        <ul className="grid gap-2">
          {lines.map((line) => (
            <li key={line.id} className="adm-card flex flex-wrap items-center justify-between gap-3">
              <div className="grid gap-0.5">
                <p className="type-strong">{line.name}</p>
                <p className="type-caption text-ink-2">
                  <bdi dir="ltr">{line.sku}</bdi> · <Money iqd={line.unitPriceIqd} />
                  {line.serials > 0 ? ` · ${t("edit.serialsAttached", { count: line.serials })}` : line.min > 0 ? ` · ${t("edit.unitsScanned", { count: line.min })}` : ""}
                </p>
              </div>
              {linesLocked ? (
                <span className="type-strong nums">× {line.qty}</span>
              ) : (
                <Stepper name={`q_${line.id}`} defaultValue={qtyOf(line)} min={bounds(line).min} max={bounds(line).max} size="sm" label={t("edit.qtyOf", { name: line.name })} />
              )}
            </li>
          ))}
        </ul>
        {!linesLocked ? <p className="type-caption text-ink-2">{t("edit.linesHint")}</p> : null}
      </section>

      <section className="adm-section" aria-labelledby="edit-address">
        <h2 id="edit-address" className="adm-h2">
          {t("edit.address")}
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField name="contactName" label={t("customer.name")} optional defaultValue={start("contactName", order.contactName)} />
          {order.phoneMasked ? (
            // the number is masked for this employee: an empty field keeps it, a typed one replaces it
            <TextField name="phone" type="tel" label={t("customer.phone")} optional hint={t("edit.phoneKeep", { phone: order.phoneMasked })} defaultValue={start("phone", "")} ltr />
          ) : (
            <TextField name="phone" type="tel" label={t("customer.phone")} required defaultValue={start("phone", order.phone)} />
          )}
          <Select name="governorateId" label={t("address.governorate")} value={governorateId} onChange={(event) => setGovernorateId(event.target.value)} options={govs.map((row) => ({ value: row.id, label: row.name }))} />
          <Select
            name="districtId"
            label={t("address.district")}
            optional
            defaultValue={start("districtId", order.districtId)}
            options={[{ value: "", label: t("edit.noDistrict") }, ...districtOptions.map((row) => ({ value: row.id, label: row.name }))]}
          />
          <TextField name="areaText" label={t("address.area")} required defaultValue={start("areaText", order.areaText)} />
          <TextField name="addressText" label={t("address.address")} required defaultValue={start("addressText", order.addressText)} className="sm:col-span-2" />
          <TextArea name="notes" label={t("address.notes")} optional defaultValue={start("notes", order.notes)} className="sm:col-span-2" />
        </div>
      </section>

      <div>
        <Key type="submit" variant="ink" icon="scales">
          {t("edit.preview")}
        </Key>
      </div>
    </Form>
  );
}

function Preview({ plan, lines, search, idempotencyKey, saving, error }: { plan: EditPlan; lines: { id: string; name: string }[]; search: string; idempotencyKey: string; saving: boolean; error: string | null }) {
  const t = useOrdersT();
  const f = useFormat();
  const params = new URLSearchParams(search);
  const changed = plan.lines.filter((line) => line.qtyAfter !== line.qtyBefore);
  const diff = plan.after.totalIqd - plan.before.totalIqd;
  return (
    <section className="adm-section mt-6" aria-labelledby="edit-preview">
      <h2 id="edit-preview" className="adm-h2">
        {t("edit.previewTitle")}
      </h2>
      <div className="adm-card grid gap-4">
        {changed.length ? (
          <ul className="grid gap-1 type-body">
            {changed.map((line) => (
              <li key={line.orderItemId}>
                {lines.find((entry) => entry.id === line.orderItemId)?.name ?? line.sku}: <Change from={<Num value={line.qtyBefore} />} to={<Num value={line.qtyAfter} />} />
                {line.qtyAfter === 0 ? ` (${t("edit.removed")})` : ""}
              </li>
            ))}
          </ul>
        ) : null}
        {plan.address.changed ? <p className="type-body">{t("edit.addressChanged")}</p> : null}
        <dl className="ord-ledger">
          <div>
            <dt>{t("detail.subtotal")}</dt>
            <dd>
              <Change from={<Money iqd={plan.before.subtotalIqd} />} to={<Money iqd={plan.after.subtotalIqd} />} />
            </dd>
          </div>
          <div>
            <dt>{t("detail.discount")}</dt>
            <dd>
              <Change from={<Money iqd={plan.before.discountIqd} />} to={<Money iqd={plan.after.discountIqd} />} />
            </dd>
          </div>
          <div>
            <dt>{t("detail.shipping")}</dt>
            <dd>
              <Change from={<Money iqd={plan.before.shippingIqd} />} to={<Money iqd={plan.after.shippingIqd} />} />
            </dd>
          </div>
          <div className="ord-ledger__total">
            <dt>{t("detail.total")}</dt>
            <dd>
              <Change from={<Money iqd={plan.before.totalIqd} />} to={<Money iqd={plan.after.totalIqd} />} />
            </dd>
          </div>
        </dl>
        <div className="rounded-xs bg-niche p-3">
          <p className="type-caption text-ink-2">{t("dialogImpact")}</p>
          <ul className="grid gap-1 type-body">
            <li>
              {plan.payment
                ? t("edit.paymentDue", { method: t(`method.${plan.payment.method}`), from: f.iqd(plan.payment.fromIqd), to: f.iqd(plan.payment.toIqd) })
                : diff === 0
                  ? t("edit.paymentSame")
                  : t("edit.paymentNone")}
            </li>
            {plan.coupon ? <li>{plan.coupon.lost ? t("edit.couponLost", { code: plan.coupon.code }) : t("edit.coupon", { code: plan.coupon.code, from: f.iqd(plan.coupon.beforeIqd), to: f.iqd(plan.coupon.afterIqd) })}</li> : null}
            {plan.stock.map((row) => (
              <li key={row.variantId} className={row.deltaQty > 0 ? undefined : "text-ink"}>
                {row.deltaQty > 0 ? t("edit.stockHold", { sku: row.sku, count: row.deltaQty }) : t("edit.stockRelease", { sku: row.sku, count: -row.deltaQty })}
              </li>
            ))}
            {plan.usedUnitsReleased.length ? <li>{t("edit.usedReleased", { count: plan.usedUnitsReleased.length })}</li> : null}
            {plan.stock.length === 0 && plan.usedUnitsReleased.length === 0 ? <li>{t("edit.stockSame")}</li> : null}
          </ul>
        </div>
        <Form method="post" className="grid gap-3">
          {plan.lines.map((line) => (
            <span key={line.orderItemId}>
              <input type="hidden" name="line" value={line.orderItemId} />
              <input type="hidden" name={`q_${line.orderItemId}`} value={String(line.qtyAfter)} />
            </span>
          ))}
          {["contactName", "phone", "governorateId", "districtId", "areaText", "addressText", "notes"].map((name) => (
            <input key={name} type="hidden" name={name} value={params.get(name) ?? ""} />
          ))}
          <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
          <input type="hidden" name="expectedTotalIqd" value={String(plan.after.totalIqd)} />
          <TextArea name="reason" label={t("dialog.reason")} hint={t("edit.reasonHint")} required rows={2} />
          <Failure message={error} />
          <div>
            <Key type="submit" variant="ink" icon="floppy-disk" loading={saving}>
              {t("edit.save")}
            </Key>
          </div>
        </Form>
      </div>
    </section>
  );
}
