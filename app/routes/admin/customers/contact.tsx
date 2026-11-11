import { useState, type FormEvent } from "react";

import type { Route } from "./+types/contact";
import { throwAsResponse } from "~/server/errors";
import { getContactView, type ContactAddress, type ContactView } from "~/server/services/admin/customers/contact.server";
import { MAX_CUSTOMER_ADDRESSES as MAX_ADDRESSES } from "~/server/services/admin/customers/types";
import { ConfirmDialog, Dialog } from "~/ui/Dialog";
import { Checkbox, FieldGroup, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { contactAction } from "./actions.server";
import { openCustomers, respond } from "./customers.server";
import { customersMeta } from "./meta";
import { Failure, Notice, PhoneText, Section, useCustomersT, useIntent } from "./ui";

/**
 * /admin/customers/:customerId/contact — 07.03: the customer's details, contact methods, addresses (several, one
 * default) and notification preferences, changed by staff with a reason (audited before/after). The account phone is
 * the sign-in identity and is not edited here (needs an SMS code; no provider). Channel choices are stored; nothing is
 * delivered until a provider is connected.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openCustomers(context, "customers.customer.read");
  try {
    return { contact: await getContactView(db, actor, params.customerId, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openCustomers(context);
  return respond(await contactAction(req.ctx, req.db, req.session, params.customerId, await request.formData()));
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, "contact.title");

export default function ContactPage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { contact } = loaderData;
  return (
    <div className="cus-layout">
      <div className="cus-main">
        <DetailsSection contact={contact} />
        <AddressesSection contact={contact} />
      </div>
      <aside className="cus-side" aria-label={t("contact.side")}>
        <ChannelsSection contact={contact} />
        <Section id="contact-phone" title={t("contact.phone.title")}>
          <p className="type-body">
            <PhoneText phone={contact.phone} />
          </p>
          <p className="type-caption text-ink-2">{contact.phoneVerifiedAt ? t("contact.phone.verified") : t("contact.phone.unverified")}</p>
          <Notice icon="lock">{t("contact.phone.boundary")}</Notice>
        </Section>
      </aside>
    </div>
  );
}

type Props = { contact: ContactView };

function DetailsSection({ contact }: Props) {
  const t = useCustomersT();
  const { fetcher, pending, message, fields } = useIntent("details", (result) => (result.changed ? "done.details" : "done.nothingChanged"));
  return (
    <Section id="contact-details" title={t("contact.details.title")}>
      {contact.readOnly ? <Notice>{t("contact.readOnly")}</Notice> : null}
      <fetcher.Form method="post" className="grid gap-3 sm:grid-cols-2">
        <input type="hidden" name="intent" value="details" />
        <input type="hidden" name="expectedUpdatedAt" value={String(contact.updatedAt)} />
        <TextField name="name" label={t("contact.details.name")} defaultValue={contact.name ?? ""} maxLength={80} error={fields.name} disabled={!contact.canEdit} autoComplete="off" />
        <TextField name="email" type="email" label={t("contact.details.email")} defaultValue={contact.email ?? ""} maxLength={200} error={fields.email} disabled={!contact.canEdit} autoComplete="off" />
        <Select
          name="locale"
          label={t("contact.details.locale")}
          hint={t("contact.details.localeHint")}
          defaultValue={contact.locale}
          disabled={!contact.canEdit}
          options={[
            { value: "ar", label: "العربية" },
            { value: "en", label: "English" },
            { value: "ckb", label: "کوردی" },
          ]}
        />
        {contact.canEdit ? <TextField name="reason" label={t("dialog.reason")} hint={t("dialog.reasonHint")} required minLength={3} maxLength={500} error={fields.reason} /> : null}
        {contact.canEdit ? (
          <div className="grid gap-2 sm:col-span-2">
            <Failure message={Object.keys(fields).length ? null : message} />
            <div>
              <Key type="submit" variant="ink" loading={pending} icon="floppy-disk">
                {t("contact.details.save")}
              </Key>
            </div>
          </div>
        ) : null}
      </fetcher.Form>
    </Section>
  );
}

function AddressesSection({ contact }: Props) {
  const t = useCustomersT();
  const [editing, setEditing] = useState<ContactAddress | "new" | null>(null);
  const full = contact.addresses.length >= MAX_ADDRESSES;
  return (
    <Section
      id="contact-addresses"
      title={t("contact.addresses.title", { count: contact.addresses.length })}
      action={
        contact.canEdit ? (
          <Key size="sm" icon="plus" disabled={full} aria-describedby={full ? "address-limit" : undefined} onClick={() => setEditing("new")}>
            {t("contact.addresses.add")}
          </Key>
        ) : null
      }
    >
      {full ? (
        <p id="address-limit" className="type-caption text-ink-2">
          {t("contact.addresses.limit", { count: MAX_ADDRESSES })}
        </p>
      ) : null}
      {contact.addresses.length === 0 ? (
        <p className="type-body text-ink-2">{t("contact.addresses.none")}</p>
      ) : (
        <ul className="cus-rows">
          {contact.addresses.map((address) => (
            <li key={address.id} className="cus-row">
              <span className="grid min-w-0 gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="type-strong">{address.label || t("contact.addresses.unnamed")}</span>
                  {address.isDefault ? <Status tone="ok">{t("contact.addresses.default")}</Status> : null}
                </span>
                <span className="type-body">
                  {address.governorateName}
                  {address.districtName ? ` — ${address.districtName}` : ""}
                  {address.areaText ? ` — ${address.areaText}` : ""}
                </span>
                <span className="type-caption text-ink-2">{address.addressText}</span>
                <span className="type-caption text-ink-2">
                  {address.recipientName ?? t("contact.addresses.noRecipient")} · <PhoneText phone={address.phone} />
                </span>
              </span>
              {contact.canEdit ? (
                <span className="cus-actions">
                  <Key size="sm" icon="pencil-simple" onClick={() => setEditing(address)}>
                    {t("contact.addresses.edit")}
                  </Key>
                  {!address.isDefault ? <AddressDefault address={address} /> : null}
                  <AddressDelete address={address} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {editing ? <AddressDialog contact={contact} address={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
    </Section>
  );
}

function AddressDialog({ contact, address, onClose }: { contact: ContactView; address: ContactAddress | null; onClose: () => void }) {
  const t = useCustomersT();
  const [governorateId, setGovernorateId] = useState(address?.governorateId ?? contact.geography[0]?.id ?? "");
  const { fetcher, pending, message, fields } = useIntent("address-save", (result) => (result.created ? "done.addressAdded" : "done.addressSaved"), onClose);
  const districts = contact.geography.find((governorate) => governorate.id === governorateId)?.districts ?? [];
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    fetcher.submit(new FormData(event.currentTarget), { method: "post" });
  };
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!pending}
      title={address ? t("contact.addresses.editTitle") : t("contact.addresses.addTitle")}
      description={t("contact.addresses.dialogLead")}
      onSubmit={submit}
      footer={
        <>
          <Key type="button" onClick={onClose} disabled={pending}>
            {t("dialog.cancel")}
          </Key>
          <Key type="submit" variant="ink" loading={pending}>
            {t("contact.addresses.save")}
          </Key>
        </>
      }
    >
      <input type="hidden" name="intent" value="address-save" />
      {address ? <input type="hidden" name="id" value={address.id} /> : null}
      {address ? <input type="hidden" name="expectedUpdatedAt" value={String(address.updatedAt)} /> : null}
      <div className="grid gap-3">
        <TextField name="label" label={t("contact.addresses.label")} hint={t("contact.addresses.labelHint")} defaultValue={address?.label ?? ""} maxLength={40} error={fields.label} />
        <TextField name="recipientName" label={t("contact.addresses.recipient")} defaultValue={address?.recipientName ?? ""} maxLength={80} error={fields.recipientName} />
        <TextField
          name="phone"
          type="tel"
          inputMode="tel"
          label={t("contact.addresses.phone")}
          hint={address?.phone ? (address.phone.full ? t("contact.addresses.phoneHint") : t("contact.addresses.phoneMasked", { phone: address.phone.display })) : t("contact.addresses.phoneHint")}
          defaultValue={address?.phone?.full ? address.phone.display.replace(/\s/g, "") : ""}
          maxLength={40}
          error={fields.phone}
        />
        <Select name="governorateId" label={t("contact.addresses.governorate")} value={governorateId} onChange={(event) => setGovernorateId(event.currentTarget.value)} options={contact.geography.map((governorate) => ({ value: governorate.id, label: governorate.name }))} error={fields.governorateId} required />
        {districts.length ? (
          <Select name="districtId" label={t("contact.addresses.district")} defaultValue={address?.governorateId === governorateId ? (address?.districtId ?? "") : ""} options={[{ value: "", label: t("contact.addresses.noDistrict") }, ...districts.map((district) => ({ value: district.id, label: district.name }))]} error={fields.districtId} />
        ) : null}
        <TextField name="areaText" label={t("contact.addresses.area")} defaultValue={address?.areaText ?? ""} maxLength={120} error={fields.areaText} required />
        <TextArea name="addressText" label={t("contact.addresses.address")} defaultValue={address?.addressText ?? ""} maxLength={300} rows={2} error={fields.addressText} required />
        <TextArea name="notes" label={t("contact.addresses.notes")} defaultValue={address?.notes ?? ""} maxLength={300} rows={2} error={fields.notes} />
        {!address?.isDefault ? <Checkbox name="makeDefault" label={t("contact.addresses.makeDefault")} defaultChecked={false} /> : null}
        <TextField name="reason" label={t("dialog.reason")} hint={t("dialog.reasonHint")} required minLength={3} maxLength={500} error={fields.reason} />
        <Failure message={Object.keys(fields).length ? null : message} />
      </div>
    </Dialog>
  );
}

function AddressDefault({ address }: { address: ContactAddress }) {
  const t = useCustomersT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("address-default", "done.addressDefault", () => setOpen(false));
  return (
    <>
      <Key size="sm" onClick={() => setOpen(true)}>
        {t("contact.addresses.setDefault")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("contact.addresses.defaultQ")}
        consequence={t("contact.addresses.defaultWhat", { label: address.label || t("contact.addresses.unnamed") })}
        confirmLabel={t("contact.addresses.setDefault")}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "address-default", addressId: address.id, reason, expectedUpdatedAt: String(address.updatedAt) }, { method: "post" })}
      />
    </>
  );
}

function AddressDelete({ address }: { address: ContactAddress }) {
  const t = useCustomersT();
  const [open, setOpen] = useState(false);
  const { fetcher, pending, message } = useIntent("address-delete", "done.addressDeleted", () => setOpen(false));
  return (
    <>
      <Key size="sm" icon="trash" className="enabled:[--on:var(--red-ink)]" onClick={() => setOpen(true)}>
        {t("contact.addresses.delete")}
      </Key>
      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        tone="destructive"
        title={t("contact.addresses.deleteQ")}
        consequence={t("contact.addresses.deleteWhat")}
        confirmLabel={t("contact.addresses.delete")}
        reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
        pending={pending}
        error={message}
        onConfirm={({ reason }) => fetcher.submit({ intent: "address-delete", addressId: address.id, reason, expectedUpdatedAt: String(address.updatedAt) }, { method: "post" })}
      />
    </>
  );
}

function ChannelsSection({ contact }: Props) {
  const t = useCustomersT();
  const { fetcher, pending, message, fields } = useIntent("channels", "done.channels");
  const anyProvider = contact.providers.sms || contact.providers.whatsapp || contact.providers.email;
  return (
    <Section id="contact-channels" title={t("contact.channels.title")}>
      {!anyProvider ? <Notice icon="info">{t("contact.channels.boundary")}</Notice> : null}
      <fetcher.Form method="post" className="grid gap-3">
        <input type="hidden" name="intent" value="channels" />
        <input type="hidden" name="expectedUpdatedAt" value={String(contact.updatedAt)} />
        <FieldGroup legend={t("contact.channels.legend")} hint={t("contact.channels.hint")}>
          {(["sms", "whatsapp", "email"] as const).map((channel) => (
            <Checkbox key={channel} name={channel} label={t(`channel.${channel}`)} hint={contact.providers[channel] ? undefined : t("contact.channels.noProvider")} defaultChecked={contact.channels[channel]} disabled={!contact.canEdit} />
          ))}
        </FieldGroup>
        {contact.canEdit ? (
          <>
            <TextField name="reason" label={t("dialog.reason")} hint={t("dialog.reasonHint")} required minLength={3} maxLength={500} error={fields.reason} />
            <Failure message={Object.keys(fields).length ? null : message} />
            <div>
              <Key type="submit" size="sm" loading={pending}>
                {t("contact.channels.save")}
              </Key>
            </div>
          </>
        ) : null}
      </fetcher.Form>
      <p className="type-caption text-ink-2">{t("contact.channels.marketingNote")}</p>
    </Section>
  );
}
