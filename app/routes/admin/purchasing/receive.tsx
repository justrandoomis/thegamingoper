import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/receive";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { createReceipt, receiveFormFor } from "~/server/services/admin/purchasing/receipts.server";
import { baghdadDate } from "~/server/services/admin/purchasing/rules";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Code, FormError, Note, Num, PageHead, Pair, Section, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { failed, linesOf, newKey, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/orders/:poId/receive — count what arrived against an order (09.04, partial receiving): per line the
 * units received and those refused at inspection with the reason, one serial number per accepted unit for tracked SKUs
 * (a barcode scanner types them, one per line), the supplier's delivery note. Saved as a DRAFT receipt: nothing moves
 * until it is posted on the receipt's page (after any freight or customs bills are added — 09.05). No costs here.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.receipt.create");
  try {
    return { form: await receiveFormFor(db, actor, params.poId, locale), today: baghdadDate(now), key: newKey() };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.receipt.create");
  const form = await request.formData();
  const ids = [...new Set([...form.keys()].map((key) => /^line:([A-Za-z0-9_.:-]{1,128}):received$/.exec(key)?.[1]).filter((id): id is string => Boolean(id)))];
  try {
    const { receiptId } = await createReceipt(
      db,
      actor,
      {
        poId: params.poId,
        supplierDocNo: text(form, "supplierDocNo"),
        receivedOn: text(form, "receivedOn"),
        notes: text(form, "notes"),
        lines: ids.map((poItemId) => ({
          poItemId,
          received: text(form, `line:${poItemId}:received`),
          rejected: text(form, `line:${poItemId}:rejected`),
          rejectReason: text(form, `line:${poItemId}:rejectReason`),
          serials: linesOf(text(form, `line:${poItemId}:serials`)),
        })),
        idempotencyKey: text(form, "key"),
      },
      now,
    );
    throw redirect(`/admin/purchasing/receipts/${receiptId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "receive");
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "receive.title", { ref: args.loaderData?.form.order.ref ?? "" });

export default function Receive({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { form, today, key } = loaderData;
  const failure = result && !result.ok ? result : null;
  const fields = failure?.fields ?? {};
  const open = form.lines.filter((line) => line.available > 0);

  return (
    <>
      <p className="mb-2">
        <Link to={`/admin/purchasing/orders/${form.order.id}`} className="adm-link type-label">
          {t("orderForm.backToOrder")}
        </Link>
      </p>
      <PageHead eyebrow={
          <>
            <bdi>{form.supplier.name}</bdi> · {form.location ? form.location.code : "—"}
          </>
        } title={t("receive.title", { ref: form.order.ref })} lead={t("receive.lead")} />
      {!form.open ? (
        <Note tone="warn" icon="warning">
          {t("receive.notOpen", { status: t(`poStatus.${form.order.status}`) })}
        </Note>
      ) : open.length === 0 ? (
        <Note icon="check-circle">{t("receive.nothingLeft")}</Note>
      ) : (
        <Form method="post" className="grid gap-5">
          <input type="hidden" name="key" value={key} />
          <Section id="delivery" title={t("receive.delivery")}>
            <div className="adm-card grid gap-4 lg:grid-cols-2">
              <TextField name="supplierDocNo" label={t("receive.docNo")} hint={t("receive.docNoHint")} optional maxLength={80} ltr error={fields.supplierDocNo} />
              <TextField name="receivedOn" type="date" label={t("receive.receivedOn")} defaultValue={today} max={today} ltr error={fields.receivedOn} />
              <TextField name="notes" label={t("receive.notes")} optional maxLength={500} className="lg:col-span-2" error={fields.notes} />
            </div>
          </Section>
          <Section id="count" title={t("receive.count")}>
            <p className="type-caption text-ink-2">{t("receive.countLead")}</p>
            <ol className="grid gap-3">
              {open.map((line) => {
                const at = `lines.${line.poItemId}`;
                return (
                  <li key={line.poItemId} className="adm-card grid gap-3">
                    <div className="grid gap-0.5">
                      <p className="type-strong">{line.variant.name}</p>
                      <p className="type-caption text-ink-2">
                        <Code>{line.variant.sku}</Code>
                        {line.variant.trackSerials ? ` · ${t("receive.tracked")}` : ""}
                      </p>
                    </div>
                    <div className="grid gap-1 sm:max-w-md">
                      <Pair label={t("order.ordered")}>
                        <Num value={line.qtyOrdered} />
                      </Pair>
                      <Pair label={t("order.received")}>
                        <Num value={line.qtyReceived} />
                      </Pair>
                      {line.qtyPending > 0 ? (
                        <Pair label={t("order.pending")}>
                          <Num value={line.qtyPending} />
                        </Pair>
                      ) : null}
                      <Pair label={t("receive.available")}>
                        <Num value={line.available} />
                      </Pair>
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      <TextField name={`line:${line.poItemId}:received`} label={t("receive.receivedQty")} hint={t("receive.receivedHint", { count: line.available })} defaultValue="" inputMode="numeric" ltr error={fields[`${at}.received`]} />
                      <TextField name={`line:${line.poItemId}:rejected`} label={t("receive.rejectedQty")} defaultValue="" inputMode="numeric" ltr optional error={fields[`${at}.rejected`]} />
                      <TextField name={`line:${line.poItemId}:rejectReason`} label={t("receive.rejectReason")} hint={t("receive.rejectReasonHint")} optional maxLength={300} error={fields[`${at}.rejectReason`]} />
                    </div>
                    {line.variant.trackSerials ? (
                      <TextArea name={`line:${line.poItemId}:serials`} label={t("receive.serials")} hint={t("receive.serialsHint")} rows={3} dir="ltr" spellCheck={false} autoComplete="off" error={fields[`${at}.serials`]} />
                    ) : null}
                  </li>
                );
              })}
            </ol>
          </Section>
          <FormError result={failure && (!failure.fields || failure.fields.lines || failure.fields.serials) ? { ...failure, message: failure.message ?? failure.fields?.lines ?? failure.fields?.serials } : null} />
          <Note icon="info">{t("receive.draftNote")}</Note>
          <div>
            <Key type="submit" variant="ink" icon="package" loading={navigation.state === "submitting"}>
              {t("receive.save")}
            </Key>
          </div>
        </Form>
      )}
    </>
  );
}
