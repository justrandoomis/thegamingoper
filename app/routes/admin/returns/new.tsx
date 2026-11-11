import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/new";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { AppError } from "~/server/errors";
import { enforceRateLimit, limitKey, RATE_LIMITS } from "~/server/ratelimit.server";
import { assertPhotoSlot, findOrderForReturn, MAX_RETURN_PHOTOS, openReturn, recordReturnPhoto } from "~/server/services/admin/returns/rma.server";
import { REASON_LIST, REQUESTABLE_RESOLUTIONS, type EligibleLine } from "~/server/services/admin/returns/types";
import { saveImageUpload } from "~/server/uploads.server";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, FieldGroup, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { returnsBlobStore } from "./env.server";
import { returnsMeta } from "./meta";
import { checked, failed, openReturns, optional, text, whole } from "./returns.server";
import { Failure, PhoneText, Ref, RmaStatusBadge, useReturnsT } from "./ui";

/**
 * /admin/returns/new — open an RMA on the customer's behalf (12.01): the order by its reference (GET ?order=, works
 * without JavaScript), its lines with what can still be returned and the rules' verdict (12.02), the units (by serial
 * for serial-tracked lines), the reason, what the customer asks for, private photos. One POST: openReturn (idempotent on
 * the form's key), then the photos (private files, owner = the RMA), then the RMA's page.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReturns(context, "returns.rma.create");
  const query = (new URL(request.url).searchParams.get("order") ?? "").trim().slice(0, 40);
  let order = null;
  let lookup: string | null = null;
  if (query) {
    try {
      order = await findOrderForReturn(db, actor, query, locale, now);
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") lookup = "not_found";
      else throw error;
    }
  }
  return { query, order, lookup, canOverride: can(actor, "returns.rma.approve"), maxPhotos: MAX_RETURN_PHOTOS, key: crypto.randomUUID() };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openReturns(context, "returns.rma.create");
  const form = await request.formData();
  const ids = form.getAll("line").map(String);
  try {
    const items = ids.map((orderItemId) => ({
      orderItemId,
      qty: form.getAll(`serial:${orderItemId}`).length || (whole(form, `qty:${orderItemId}`) ?? 0),
      serialIds: form.getAll(`serial:${orderItemId}`).map(String),
      sealed: form.has(`sealed-asked:${orderItemId}`) ? checked(form, `sealed:${orderItemId}`) : undefined,
    }));
    const opened = await openReturn(
      db,
      actor,
      {
        orderRef: text(form, "orderRef"),
        items,
        reasonCode: text(form, "reasonCode") as never,
        reason: text(form, "reason"),
        requestedResolution: text(form, "requestedResolution") as never,
        phone: optional(form, "phone"),
        override: checked(form, "override"),
        overrideReason: optional(form, "overrideReason"),
        idempotencyKey: text(form, "idempotencyKey"),
      },
      now,
      locale,
    );
    // Photos after the RMA exists (they are its private files); a failed photo never undoes the RMA.
    let photosFailed = false;
    const photos = form.getAll("photos").filter((value): value is File => typeof value === "object" && value !== null && (value as File).size > 0);
    if (!opened.replayed) {
      for (const photo of photos.slice(0, MAX_RETURN_PHOTOS)) {
        try {
          const ret = await assertPhotoSlot(db, actor, opened.returnId);
          await enforceRateLimit(db, await limitKey("upload", "employee", actor.id), RATE_LIMITS.upload, now);
          const { file } = await saveImageUpload(db, returnsBlobStore(), photo, { visibility: "private", kind: "return_photo", ownerType: "return", ownerId: opened.returnId, createdBy: actor, now });
          await recordReturnPhoto(db, actor, ret, file.id, now);
        } catch {
          photosFailed = true;
        }
      }
    }
    throw redirect(`/admin/returns/${opened.rma}${photosFailed ? "?photos=failed" : ""}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "open");
  }
}

export const meta: Route.MetaFunction = (args) => returnsMeta(args, "new.title");

export default function NewReturn({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const f = useFormat();
  const navigation = useNavigation();
  const result = useActionData<typeof action>();
  const failure = result && "ok" in result && !result.ok ? result : null;
  const { query, order, lookup, canOverride, maxPhotos, key } = loaderData;
  const submitting = navigation.state === "submitting";
  const blocked = order?.lines.some((line) => line.returnableQty > 0 && !line.eligibility.eligible) ?? false;

  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("new.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("new.lead")}</p>
      </header>

      <Form method="get" action="/admin/returns/new" className="flex flex-wrap items-end gap-2">
        <TextField name="order" label={t("new.find.label")} hint={t("new.find.hint")} defaultValue={query} ltr className="min-w-[16rem] flex-1" error={lookup ? t(`errors.${lookup}`) : undefined} />
        <Key type="submit" variant="ink" icon="magnifying-glass">
          {t("new.find.submit")}
        </Key>
      </Form>

      {order ? (
        <Form method="post" encType="multipart/form-data" className="grid gap-5" noValidate>
          <input type="hidden" name="orderRef" value={order.ref} />
          <input type="hidden" name="idempotencyKey" value={key} />

          <section className="adm-section" aria-labelledby="new-order">
            <div className="adm-section__head">
              <h2 id="new-order" className="adm-h2">
                {t("new.order.title", { ref: order.ref })}
              </h2>
              <Link to={`/admin/orders/${order.ref}`} className="adm-link type-caption">
                {t("new.order.open")}
              </Link>
            </div>
            <p className="type-body">
              {order.deliveredAt ? t("new.order.delivered", { date: f.dateTime(order.deliveredAt) }) : t("new.order.notDelivered", { status: order.status })}
            </p>
            <p className="type-caption text-ink-2">
              {t("new.order.customer")}: <bdi>{order.customer.name ?? (order.customer.kind === "guest" ? t("new.order.guest") : "—")}</bdi> · <PhoneText phone={order.customer.phone} />
            </p>
            {order.returns.length ? (
              <div className="grid gap-1">
                <p className="type-label">{t("new.order.earlier")}</p>
                <ul className="flex flex-wrap gap-2">
                  {order.returns.map((entry) => (
                    <li key={entry.rma} className="inline-flex items-center gap-2">
                      <Link to={`/admin/returns/${entry.rma}`} className="adm-link">
                        <Ref value={entry.rma} />
                      </Link>
                      <RmaStatusBadge status={entry.status} />
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </section>

          {order.status !== "delivered" ? (
            <EmptyState title={t("new.order.notDelivered", { status: order.status })} icon="truck" />
          ) : (
            <>
              <fieldset className="adm-section">
                <legend className="adm-h2">{t("new.lines.title")}</legend>
                {order.lines.every((line) => line.returnableQty === 0) ? <p className="type-body text-ink-2">{t("new.lines.none")}</p> : null}
                <ul className="grid gap-2">
                  {order.lines.map((line) => (
                    <li key={line.orderItemId}>
                      <LineChoice line={line} />
                    </li>
                  ))}
                </ul>
                <Failure message={failure?.fields?.items ?? null} />
              </fieldset>

              <section className="adm-section grid gap-3 md:grid-cols-2" aria-label={t("new.form.reasonCode")}>
                <Select name="reasonCode" label={t("new.form.reasonCode")} required defaultValue="" options={[{ value: "", label: t("new.form.choose") }, ...REASON_LIST.map((reason) => ({ value: reason, label: t(`reason.${reason}`) }))]} error={failure?.fields?.reasonCode} />
                <Select
                  name="requestedResolution"
                  label={t("new.form.resolution")}
                  required
                  defaultValue=""
                  options={[{ value: "", label: t("new.form.choose") }, ...REQUESTABLE_RESOLUTIONS.map((resolution) => ({ value: resolution, label: t(`resolution.${resolution}`) }))]}
                  error={failure?.fields?.requestedResolution}
                />
                <TextArea name="reason" label={t("new.form.reasonText")} hint={t("new.form.reasonHint")} required className="md:col-span-2" error={failure?.fields?.reason} />
                <TextField name="phone" type="tel" label={t("new.form.phone")} hint={t("new.form.phoneHint")} optional ltr error={failure?.fields?.phone} />
                <div className="grid gap-1">
                  <label htmlFor="return-photos" className="type-label">
                    {t("new.form.photos")}
                  </label>
                  <input id="return-photos" name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple className="type-body" aria-describedby="return-photos-hint" />
                  <p id="return-photos-hint" className="type-caption text-ink-2">
                    {t("new.form.photosHint", { count: maxPhotos })}
                  </p>
                </div>
              </section>

              {blocked ? (
                <section className="adm-section" aria-labelledby="new-override">
                  <h2 id="new-override" className="adm-h2">
                    {t("new.override.title")}
                  </h2>
                  <p className="max-w-[70ch] type-body text-ink-2">{t("new.override.lead")}</p>
                  {canOverride ? (
                    <div className="grid gap-3 md:grid-cols-2">
                      <Checkbox name="override" value="1" label={t("new.override.check")} />
                      <TextField name="overrideReason" label={t("new.override.reason")} hint={t("new.override.reasonHint")} error={failure?.fields?.overrideReason} />
                    </div>
                  ) : (
                    <p className="flex items-center gap-1 type-body text-ink-2">
                      <Icon name="lock" size={16} />
                      {t("new.override.notAllowed")}
                    </p>
                  )}
                </section>
              ) : null}

              <div className="grid gap-2">
                <Failure message={failure ? (failure.message ?? t(`errors.${failure.code}`)) : null} />
                <div>
                  <Key type="submit" variant="ink" icon="arrow-u-up-left" loading={submitting}>
                    {t("new.form.submit")}
                  </Key>
                </div>
              </div>
            </>
          )}
        </Form>
      ) : null}
    </>
  );
}

/** One order line: include it, how many (or which units), still sealed, and the rules' verdict. */
function LineChoice({ line }: { line: EligibleLine }) {
  const t = useReturnsT();
  const f = useFormat();
  const e = line.eligibility;
  const disabled = line.returnableQty === 0;
  const pct = `${(e.restockingFeeBps / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
  return (
    <div className="ret-line" data-blocked={!e.eligible}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="type-strong">{line.name}</p>
          <p className="type-caption text-ink-2">
            <Ref value={line.sku} /> · {t("new.lines.value", { amount: f.iqd(line.unitValueIqd) })}
            {line.isUsed ? ` · ${t("new.lines.used")}` : ""}
          </p>
        </div>
        <Status tone={e.eligible ? "ok" : "warn"}>{e.eligible ? t("eligibility.eligible") : t("eligibility.notEligible")}</Status>
      </div>
      <ul className="grid gap-0.5 type-caption text-ink-2">
        {e.problems.map((problem) => (
          <li key={problem} className="flex items-start gap-1 text-ink">
            <Icon name="warning" size={14} className="mt-0.5 flex-none text-warn" />
            {t(`eligibility.problems.${problem}`)}
          </li>
        ))}
        {e.windowEndsAt ? <li>{t(e.problems.includes("window_closed") ? "eligibility.windowEnded" : "eligibility.windowEnds", { date: f.date(e.windowEndsAt) })}</li> : <li>{t("eligibility.noDelivery")}</li>}
        {e.daysSinceDelivery !== null ? <li>{t("eligibility.sinceDelivery", { count: e.daysSinceDelivery })}</li> : null}
        <li>
          {t(`eligibility.source.${e.rule.source}`)} · {t("policies.days", { count: e.windowDays })}
          {e.rule.note ? ` · ${e.rule.note}` : ""}
        </li>
        {e.requiresSealed ? <li>{t("eligibility.sealRule")}</li> : null}
        {e.restockingFeeBps > 0 ? <li>{t("eligibility.fee", { percent: pct })}</li> : null}
      </ul>
      {!disabled ? (
        <div className="grid gap-2 sm:grid-cols-[auto_1fr] sm:items-start">
          <Checkbox name="line" value={line.orderItemId} label={t("new.lines.include")} />
          {line.serials.length > 0 ? (
            <FieldGroup legend={t("new.lines.serials")} hint={t("new.lines.ofReturnable", { count: line.returnableQty, qty: line.qty })}>
              {line.serials.map((serial) => (
                <Checkbox key={serial.id} name={`serial:${line.orderItemId}`} value={serial.id} label={serial.serial} />
              ))}
            </FieldGroup>
          ) : (
            <TextField name={`qty:${line.orderItemId}`} label={t("new.lines.qty")} hint={t("new.lines.ofReturnable", { count: line.returnableQty, qty: line.qty })} inputMode="numeric" defaultValue={String(line.returnableQty)} ltr className="max-w-[12rem]" />
          )}
          {e.requiresSealed ? (
            <>
              <input type="hidden" name={`sealed-asked:${line.orderItemId}`} value="1" />
              <Checkbox name={`sealed:${line.orderItemId}`} value="1" label={t("new.lines.sealed")} hint={t("new.lines.sealedHint")} />
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
