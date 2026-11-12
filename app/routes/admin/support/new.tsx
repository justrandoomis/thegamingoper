import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/new";
import { openStaffTicket } from "~/server/services/admin/support/tickets.server";
import { STAFF_CHANNELS, TICKET_CATEGORIES, TICKET_PRIORITIES, type StaffChannel } from "~/server/services/admin/support/types";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { supportMeta } from "./meta";
import { checked, failed, openSupport, text } from "./support.server";
import { Boundary, Failure, useSupportT } from "./ui";

/**
 * /admin/support/new — a ticket for a customer who called, wrote on WhatsApp, e-mail or social media, or came to the
 * shop (14.01, 14.02): the contact (an Iraqi mobile or an e-mail), what they said, the order or repair it is about
 * (linked by id; the account with that phone is linked by itself), priority and category (the SLA due times follow),
 * and who holds it (the creator, or the routing rules). `?order=TT-…` / `?repair=RP-…` / `?phone=` prefill it.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  await openSupport(context, "support.ticket.reply");
  const url = new URL(request.url);
  const clean = (value: string | null) => (value ?? "").replace(/[^A-Za-z0-9+\-\s٠-٩۰-۹]/g, "").trim().slice(0, 40);
  return { key: crypto.randomUUID(), prefill: { order: clean(url.searchParams.get("order")), repair: clean(url.searchParams.get("repair")), phone: clean(url.searchParams.get("phone")) } };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now, storeMode } = await openSupport(context, "support.ticket.reply");
  const form = await request.formData();
  try {
    const channel = text(form, "channel") as StaffChannel;
    const result = await openStaffTicket(
      db,
      actor,
      {
        channel,
        phone: text(form, "phone"),
        email: text(form, "email"),
        contactName: text(form, "contactName"),
        subject: text(form, "subject"),
        category: text(form, "category") as never,
        priority: text(form, "priority") as never,
        message: text(form, "message"),
        orderRef: text(form, "orderRef"),
        repairRef: text(form, "repairRef"),
        locale: (["ar", "en", "ckb"].includes(text(form, "locale")) ? text(form, "locale") : "ar") as "ar" | "en" | "ckb",
        takeIt: checked(form, "takeIt"),
        idempotencyKey: text(form, "idempotencyKey"),
      },
      now,
      storeMode,
    );
    throw redirect(`/admin/support/tickets/${result.ref}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "open");
  }
}

export const meta: Route.MetaFunction = (args) => supportMeta(args, "new.title");

export default function NewTicket({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const navigation = useNavigation();
  const result = useActionData<typeof action>();
  const failure = result && "ok" in result && !result.ok ? result : null;
  const fields = failure?.fields ?? {};
  const { key, prefill } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/support" className="adm-link">
            {t("ticket.back")}
          </Link>
        </p>
        <h1 className="adm-title">{t("new.title")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{t("new.lead")}</p>
      </header>
      <Boundary>{t("new.boundary")}</Boundary>
      <Form method="post" className="grid max-w-[60rem] gap-4 md:grid-cols-2" noValidate>
        <input type="hidden" name="idempotencyKey" value={key} />
        <Select name="channel" label={t("new.channel")} defaultValue="phone" options={STAFF_CHANNELS.map((channel) => ({ value: channel, label: t(`channel.${channel}`) }))} error={fields.channel} />
        <Select name="locale" label={t("new.locale")} hint={t("new.localeHint")} defaultValue="ar" options={["ar", "en", "ckb"].map((locale) => ({ value: locale, label: t(`language.${locale}`) }))} />
        <TextField name="phone" type="tel" label={t("new.phone")} hint={t("new.phoneHint")} defaultValue={prefill.phone} ltr autoComplete="off" error={fields.phone} />
        <TextField name="email" type="email" label={t("new.email")} optional ltr autoComplete="off" error={fields.email} />
        <TextField name="contactName" label={t("new.name")} optional error={fields.contactName} />
        <TextField name="subject" label={t("new.subject")} hint={t("new.subjectHint")} required error={fields.subject} />
        <Select name="category" label={t("inbox.category")} defaultValue="other" options={TICKET_CATEGORIES.map((category) => ({ value: category, label: t(`category.${category}`) }))} error={fields.category} />
        <Select name="priority" label={t("inbox.priority")} defaultValue="normal" options={TICKET_PRIORITIES.map((priority) => ({ value: priority, label: t(`priority.${priority}`) }))} error={fields.priority} />
        <TextArea name="message" label={t("new.message")} hint={t("new.messageHint")} rows={5} className="md:col-span-2" optional error={fields.message} />
        <TextField name="orderRef" label={t("new.order")} hint={t("new.orderHint")} defaultValue={prefill.order} ltr optional error={fields.orderRef} />
        <TextField name="repairRef" label={t("new.repair")} hint={t("new.repairHint")} defaultValue={prefill.repair} ltr optional error={fields.repairRef} />
        <Checkbox name="takeIt" label={t("new.takeIt")} hint={t("new.takeItHint")} defaultChecked className="md:col-span-2" />
        <div className="grid gap-2 md:col-span-2">
          <Failure message={failure ? (failure.message ?? t(`errors.${failure.code}`)) : null} />
          <div className="sup-actions">
            <Key type="submit" variant="ink" icon="plus" loading={navigation.state === "submitting"}>
              {t("new.submit")}
            </Key>
            <Key as={Link} to="/admin/support">
              {t("new.cancel")}
            </Key>
          </div>
        </div>
      </Form>
    </>
  );
}
