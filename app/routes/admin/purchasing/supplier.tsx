import { useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/supplier";
import { useFormat } from "~/i18n/react";
import { AppError, throwAsResponse } from "~/server/errors";
import { COST_CURRENCIES, RATING, SUPPLIER_STATUS_LIST } from "~/server/services/admin/purchasing/rules";
import { purchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { getSupplier, removeContact, reviewSupplier, saveContact, setSupplierStatus, updateSupplier } from "~/server/services/admin/purchasing/suppliers.server";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog } from "./components/ActionDialog";
import { Code, Facts, FormError, History, Kpi, Minor, Money, Note, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { checked, failed, ok, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/suppliers/:supplierId — one supplier (09.01): the profile (currency, payment terms, lead time,
 * contacts), its status (with a reason), its rating explained (09.08: on time, defects, lead time, the formula), staff
 * reviews (purchasing.supplier.rate), recent orders and the audit history.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, now } = await openPurchasing(context, "purchasing.supplier.read");
  try {
    return { detail: await getSupplier(db, actor, params.supplierId, now), access: purchasingAccess(actor) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const { db, actor, locale, now } = await openPurchasing(context, intent === "review" ? "purchasing.supplier.rate" : "purchasing.supplier.manage");
  const supplierId = params.supplierId;
  try {
    switch (intent) {
      case "update": {
        const result = await updateSupplier(
          db,
          actor,
          {
            supplierId,
            version: text(form, "version"),
            code: text(form, "code"),
            name: text(form, "name"),
            legalName: text(form, "legalName"),
            country: text(form, "country"),
            currency: text(form, "currency"),
            paymentTerms: text(form, "paymentTerms"),
            leadTimeDays: text(form, "leadTimeDays"),
            phone: text(form, "phone"),
            email: text(form, "email"),
            address: text(form, "address"),
            notes: text(form, "notes"),
          },
          now,
        );
        return ok({ intent, changed: result.changed });
      }
      case "status":
        await setSupplierStatus(db, actor, { supplierId, status: text(form, "status"), reason: text(form, "reason") }, now);
        return ok({ intent });
      case "contact":
        await saveContact(db, actor, { supplierId, contactId: text(form, "contactId") || undefined, name: text(form, "name"), role: text(form, "role"), phone: text(form, "phone"), email: text(form, "email"), isPrimary: checked(form, "isPrimary"), notes: text(form, "notes") }, now);
        return ok({ intent });
      case "removeContact":
        await removeContact(db, actor, { supplierId, contactId: text(form, "contactId") }, now);
        return ok({ intent });
      case "review":
        await reviewSupplier(db, actor, { supplierId, score: text(form, "score"), note: text(form, "note") }, now);
        return ok({ intent });
      default:
        return failed(new AppError("invalid", 400), locale, intent);
    }
  } catch (error) {
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "supplier.metaTitle", { name: args.loaderData?.detail.supplier.name ?? "" });

const CURRENCY_OPTIONS = Object.keys(COST_CURRENCIES).map((code) => ({ value: code, label: code }));

export default function SupplierPage({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { detail, access } = loaderData;
  const { supplier, rating } = detail;
  const [dialog, setDialog] = useState<null | { kind: "status" } | { kind: "remove"; contactId: string; name: string }>(null);
  const [status, setStatus] = useState<string>(supplier.status === "active" ? "inactive" : "active");
  const [editing, setEditing] = useState<string | null>(null);
  const failure = result && !result.ok ? result : null;
  const fieldsOf = (intent: string) => (failure && failure.intent === intent ? (failure.fields ?? {}) : {});
  const busy = navigation.state === "submitting";
  const update = fieldsOf("update");
  const contactFields = fieldsOf("contact");
  const editingContact = detail.contacts.find((contact) => contact.id === editing) ?? null;

  return (
    <>
      <p className="mb-2">
        <Link to="/admin/purchasing/suppliers" className="adm-link type-label">
          {t("supplier.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={
          <>
            <Code>{supplier.code}</Code>
            {supplier.isDemo ? ` · ${t("common.demo")}` : ""}
          </>
        }
        title={<bdi>{supplier.name}</bdi>}
        lead={supplier.legalName ?? undefined}
        actions={
          <>
            <StateTag group="supplier" value={supplier.status} label={t(`supplierStatus.${supplier.status}`)} />
            {access.poCreate && access.cost && supplier.status === "active" ? (
              <Key as={Link} to={`/admin/purchasing/orders/new?supplier=${supplier.id}`} size="sm" icon="plus">
                {t("supplier.newOrder")}
              </Key>
            ) : null}
            {access.claim ? (
              <Key as={Link} to={`/admin/purchasing/claims?supplier=${supplier.id}#new`} size="sm" icon="warning">
                {t("supplier.newClaim")}
              </Key>
            ) : null}
            {access.supplierManage ? (
              <Key size="sm" onClick={() => setDialog({ kind: "status" })}>
                {t("supplier.changeStatus")}
              </Key>
            ) : null}
          </>
        }
      />
      {supplier.status !== "active" ? (
        <Note tone="warn" icon="warning" className="mb-5">
          {t(`supplier.statusNote.${supplier.status}`)}
        </Note>
      ) : null}
      {failure && (failure.intent === "status" || failure.intent === "removeContact") ? <FormError result={failure} /> : null}
      {result && result.ok && result.intent === "update" ? (
        <p role="status" className="mb-4 type-label text-ok">
          {"changed" in result && result.changed === false ? t("supplier.unchanged") : t("supplier.saved")}
        </p>
      ) : null}

      <Section id="rating" title={t("rating.title")}>
        <div className="pur-kpis">
          <Kpi label={t("rating.grade")} value={rating.grade ? t("rating.gradeScore", { grade: rating.grade, score: rating.score ?? 0 }) : "—"} hint={rating.enough ? undefined : t("rating.notEnough", { count: rating.receipts, min: RATING.minReceipts })} />
          <Kpi label={t("rating.onTime")} value={rating.onTimeRate === null ? "—" : f.percent(rating.onTimeRate)} hint={t("rating.onTimeHint", { onTime: f.number(rating.unitsOnTime), due: f.number(rating.unitsOnTime + rating.unitsLate + rating.unitsOverdue + (rating.unitsShortClosed ?? 0)) })} />
          <Kpi label={t("rating.defects")} value={rating.defectRate === null ? "—" : f.percent(rating.defectRate)} hint={t("rating.defectsHint", { defects: f.number(rating.defectUnits), units: f.number(rating.unitsReceived) })} />
          <Kpi label={t("rating.lead")} value={rating.avgLeadDays === null ? "—" : t("rating.days", { count: rating.avgLeadDays })} hint={supplier.leadTimeDays !== null ? t("rating.promised", { count: supplier.leadTimeDays }) : t("rating.noPromise")} />
        </div>
        <Note icon="scales">
          <p className="type-body">{t("rating.formula", { window: RATING.windowDays, onTime: RATING.onTimeWeight, quality: RATING.qualityWeight, min: RATING.minReceipts })}</p>
          <p className="type-caption text-ink-2">{t("rating.facts", { receipts: f.number(rating.receipts), late: f.number(rating.unitsLate), overdue: f.number(rating.unitsOverdue), short: f.number(rating.unitsShortClosed ?? 0) })}</p>
        </Note>
      </Section>

      <Section id="profile" title={t("supplier.profile")}>
        {access.supplierManage ? (
          <Form method="post" className="adm-card grid gap-4 lg:grid-cols-2" key={supplier.updatedAt}>
            <input type="hidden" name="intent" value="update" />
            <input type="hidden" name="version" value={supplier.updatedAt} />
            <TextField name="code" label={t("supplier.code")} defaultValue={supplier.code} required ltr maxLength={20} error={update.code} />
            <TextField name="name" label={t("supplier.name")} defaultValue={supplier.name} required maxLength={120} error={update.name} />
            <TextField name="legalName" label={t("supplier.legalName")} defaultValue={supplier.legalName ?? ""} optional maxLength={160} error={update.legalName} />
            <TextField name="country" label={t("supplier.country")} defaultValue={supplier.country ?? ""} optional maxLength={60} error={update.country} />
            <Select name="currency" label={t("supplier.currency")} options={CURRENCY_OPTIONS} defaultValue={supplier.currency} required error={update.currency} />
            <TextField name="paymentTerms" label={t("supplier.paymentTerms")} hint={t("supplier.paymentTermsHint")} defaultValue={supplier.paymentTerms ?? ""} optional maxLength={120} error={update.paymentTerms} />
            <TextField name="leadTimeDays" label={t("supplier.leadTime")} defaultValue={supplier.leadTimeDays === null ? "" : String(supplier.leadTimeDays)} inputMode="numeric" optional error={update.leadTimeDays} />
            <TextField name="phone" label={t("supplier.phone")} type="tel" defaultValue={supplier.phone ?? ""} optional maxLength={40} error={update.phone} />
            <TextField name="email" label={t("supplier.email")} type="email" defaultValue={supplier.email ?? ""} optional maxLength={200} error={update.email} />
            <TextField name="address" label={t("supplier.address")} defaultValue={supplier.address ?? ""} optional maxLength={300} error={update.address} />
            <TextArea name="notes" label={t("supplier.notes")} defaultValue={supplier.notes ?? ""} optional maxLength={1000} rows={2} className="lg:col-span-2" error={update.notes} />
            <div className="grid gap-2 lg:col-span-2">
              {failure?.intent === "update" && !failure.fields ? <FormError result={failure} /> : null}
              <div>
                <Key type="submit" variant="ink" icon="floppy-disk" loading={busy && navigation.formData?.get("intent") === "update"}>
                  {t("supplier.save")}
                </Key>
              </div>
            </div>
          </Form>
        ) : (
          <Facts
            items={[
              { label: t("supplier.currency"), value: <Code>{supplier.currency}</Code> },
              { label: t("supplier.paymentTerms"), value: supplier.paymentTerms ?? "—" },
              { label: t("supplier.leadTime"), value: supplier.leadTimeDays === null ? "—" : t("rating.days", { count: supplier.leadTimeDays }) },
              { label: t("supplier.country"), value: supplier.country ?? "—" },
              { label: t("supplier.phone"), value: supplier.phone ? <Code>{supplier.phone}</Code> : "—" },
              { label: t("supplier.email"), value: supplier.email ? <Code>{supplier.email}</Code> : "—" },
              { label: t("supplier.address"), value: supplier.address ?? "—", wide: true },
              { label: t("supplier.notes"), value: supplier.notes ?? "—", wide: true },
            ]}
          />
        )}
      </Section>

      <Section id="contacts" title={t("supplier.contacts")}>
        {detail.contacts.length === 0 ? <p className="type-body text-ink-2">{t("supplier.noContacts")}</p> : null}
        <ul role="list" className="grid gap-2 sm:grid-cols-2">
          {detail.contacts.map((contact) => (
            <li key={contact.id} className="adm-card gap-1">
              <p className="type-strong">
                {contact.name}
                {contact.isPrimary ? <span className="type-caption text-ink-2"> · {t("supplier.primary")}</span> : null}
              </p>
              {contact.role ? <p className="type-caption text-ink-2">{contact.role}</p> : null}
              {contact.phone ? (
                <Pair label={t("supplier.phone")}>
                  <Code>{contact.phone}</Code>
                </Pair>
              ) : null}
              {contact.email ? (
                <Pair label={t("supplier.email")}>
                  <Code>{contact.email}</Code>
                </Pair>
              ) : null}
              {contact.notes ? <p className="type-caption text-ink-2">{contact.notes}</p> : null}
              {access.supplierManage ? (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Key size="sm" icon="pencil-simple" onClick={() => setEditing(contact.id)}>
                    {t("supplier.editContact")}
                  </Key>
                  <Key size="sm" icon="trash" className="[--on:var(--red-ink)]" onClick={() => setDialog({ kind: "remove", contactId: contact.id, name: contact.name })}>
                    {t("supplier.removeContact")}
                  </Key>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {access.supplierManage ? (
          <Form method="post" className="adm-card grid gap-3 lg:grid-cols-2" key={editing ?? "new"}>
            <p className="type-label lg:col-span-2">{editingContact ? t("supplier.editContactTitle", { name: editingContact.name }) : t("supplier.addContact")}</p>
            <input type="hidden" name="intent" value="contact" />
            {editingContact ? <input type="hidden" name="contactId" value={editingContact.id} /> : null}
            <TextField name="name" label={t("supplier.contactName")} defaultValue={editingContact?.name ?? ""} required maxLength={120} error={contactFields.name} />
            <TextField name="role" label={t("supplier.contactRole")} defaultValue={editingContact?.role ?? ""} optional maxLength={80} error={contactFields.role} />
            <TextField name="phone" label={t("supplier.phone")} type="tel" defaultValue={editingContact?.phone ?? ""} optional maxLength={40} error={contactFields.phone} />
            <TextField name="email" label={t("supplier.email")} type="email" defaultValue={editingContact?.email ?? ""} optional maxLength={200} error={contactFields.email} />
            <TextField name="notes" label={t("supplier.notes")} defaultValue={editingContact?.notes ?? ""} optional maxLength={300} className="lg:col-span-2" error={contactFields.notes} />
            <Checkbox name="isPrimary" label={t("supplier.primary")} defaultChecked={editingContact?.isPrimary ?? detail.contacts.length === 0} className="lg:col-span-2" />
            <div className="flex flex-wrap gap-2 lg:col-span-2">
              <Key type="submit" variant="ink" icon="user" loading={busy && navigation.formData?.get("intent") === "contact"}>
                {editingContact ? t("supplier.saveContact") : t("supplier.addContactKey")}
              </Key>
              {editingContact ? <Key onClick={() => setEditing(null)}>{t("common.cancel")}</Key> : null}
            </div>
          </Form>
        ) : null}
      </Section>

      {access.supplierRate || detail.reviews.length > 0 ? (
        <Section id="reviews" title={t("supplier.reviews")}>
          <p className="type-caption text-ink-2">{t("supplier.reviewsLead")}</p>
          {detail.reviews.length > 0 ? (
            <ul role="list" className="grid gap-2">
              {detail.reviews.map((review, index) => (
                <li key={index} className="adm-card gap-1">
                  <p className="type-strong">
                    {review.score !== null ? t("supplier.reviewScore", { score: review.score }) : "—"} · {review.by ?? "—"}
                  </p>
                  <p className="type-body">{review.note}</p>
                  <p className="type-caption text-ink-2">
                    <When at={review.at} />
                  </p>
                </li>
              ))}
            </ul>
          ) : null}
          {access.supplierRate ? (
            <Form method="post" className="adm-card grid gap-3 sm:grid-cols-[10rem_1fr]">
              <input type="hidden" name="intent" value="review" />
              <Select name="score" label={t("supplier.reviewScoreLabel")} options={[5, 4, 3, 2, 1].map((score) => ({ value: String(score), label: t("supplier.reviewScore", { score }) }))} defaultValue="4" error={fieldsOf("review").score} />
              <TextField name="note" label={t("supplier.reviewNote")} hint={t("supplier.reviewNoteHint")} required maxLength={500} error={fieldsOf("review").note} />
              <div className="sm:col-span-2">
                <Key type="submit" icon="star" loading={busy && navigation.formData?.get("intent") === "review"}>
                  {t("supplier.addReview")}
                </Key>
              </div>
            </Form>
          ) : null}
        </Section>
      ) : null}

      {access.poRead ? (
        <Section
          id="orders"
          title={t("supplier.orders")}
          aside={
            <Link to={`/admin/purchasing/orders?view=all&supplier=${supplier.id}`} className="adm-link type-label">
              {t("home.seeAll")}
            </Link>
          }
        >
          <ResponsiveList
            caption={t("supplier.orders")}
            rows={detail.orders}
            rowKey={(row) => row.id}
            columns={[
              { key: "ref", header: t("common.reference"), cell: (row) => <RowLink to={`/admin/purchasing/orders/${row.id}`}><Code>{row.ref}</Code></RowLink> },
              { key: "status", header: t("common.status"), cell: (row) => <StateTag group="po" value={row.status} label={t(`poStatus.${row.status}`)} /> },
              { key: "expected", header: t("order.expected"), cell: (row) => (row.late ? <span className="text-red-ink">{t("order.lateSince")} <When at={row.expectedAt} kind="date" /></span> : <When at={row.expectedAt} kind="date" />) },
              { key: "units", header: t("order.unitsReceivedOf"), numeric: true, cell: (row) => <span><Num value={row.unitsReceived} /> / <Num value={row.units} /></span> },
              ...(access.cost ? [{ key: "total", header: t("order.totalIqd"), numeric: true, cell: (row: (typeof detail.orders)[number]) => <Money iqd={row.totalIqd} /> }] : []),
            ]}
            card={(row) => (
              <>
                <div className="flex items-start justify-between gap-2">
                  <Link to={`/admin/purchasing/orders/${row.id}`} className="adm-link type-strong">
                    <Code>{row.ref}</Code>
                  </Link>
                  <StateTag group="po" value={row.status} label={t(`poStatus.${row.status}`)} />
                </div>
                <Pair label={t("order.unitsReceivedOf")}>
                  <Num value={row.unitsReceived} /> / <Num value={row.units} />
                </Pair>
                {access.cost && row.totalMinor !== undefined ? (
                  <Pair label={t("order.total")}>
                    <Minor minor={row.totalMinor} currency={supplier.currency} />
                  </Pair>
                ) : null}
              </>
            )}
            empty={<p className="type-body text-ink-2">{t("supplier.noOrders")}</p>}
          />
        </Section>
      ) : null}

      <Section id="history" title={t("common.history")}>
        <History entries={detail.history} />
      </Section>

      <ActionDialog
        open={dialog?.kind === "status"}
        onClose={() => setDialog(null)}
        title={t("supplier.statusTitle")}
        consequence={t(`supplier.statusConsequence.${status}`)}
        confirmLabel={t("supplier.changeStatus")}
        tone={status === "blocked" ? "destructive" : "neutral"}
        reason
        fields={{ intent: "status", status }}
        successMessage={t("supplier.statusChanged")}
      >
        <Select label={t("common.status")} value={status} onChange={(event) => setStatus(event.currentTarget.value)} options={SUPPLIER_STATUS_LIST.filter((value) => value !== supplier.status).map((value) => ({ value, label: t(`supplierStatus.${value}`) }))} />
      </ActionDialog>
      <ActionDialog
        open={dialog?.kind === "remove"}
        onClose={() => setDialog(null)}
        title={t("supplier.removeContactTitle")}
        consequence={t("supplier.removeContactConsequence", { name: dialog?.kind === "remove" ? dialog.name : "" })}
        confirmLabel={t("supplier.removeContact")}
        tone="destructive"
        fields={{ intent: "removeContact", contactId: dialog?.kind === "remove" ? dialog.contactId : "" }}
        successMessage={t("supplier.contactRemoved")}
      />
    </>
  );
}
