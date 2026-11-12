import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/trade-in-new";
import { randomToken } from "~/lib/ids";
import { counterModelOptions, openCounterTradeIn } from "~/server/services/admin/devices/tradeins.server";
import { Checkbox, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { devicesStoreMode } from "./env.server";
import { failed, openDevices, text } from "./devices.server";
import { devicesMeta } from "./meta";
import { Failure, useDevicesT, type ActionFailure } from "./ui";

/**
 * /admin/devices/trade-ins/new — a trade-in for a customer at the counter (devices.tradein.inspect): the customer's
 * phone (a store account with that number is linked, so store credit is possible) and name, the device as a model or a
 * catalogue SKU / barcode (scanner: games, controllers, accessories), notes, and the customer's declaration that the
 * device is theirs to sell. No estimate: the inspection prices it. A double submit opens one trade-in.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, locale } = await openDevices(context, "devices.tradein.inspect");
  // The form's one-time key comes from the server, so the page hydrates with the same value.
  return { models: await counterModelOptions(db, locale), key: randomToken(18) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openDevices(context, "devices.tradein.inspect");
  const form = await request.formData();
  try {
    const result = await openCounterTradeIn(
      db,
      actor,
      {
        idempotencyKey: text(form, "idempotencyKey"),
        phone: text(form, "phone"),
        contactName: text(form, "contactName"),
        deviceModelId: text(form, "deviceModelId"),
        code: text(form, "code"),
        notes: text(form, "notes"),
        ownershipDeclared: form.get("ownershipDeclared") === "on" ? true : undefined,
        accountConfirmed: form.get("accountConfirmed") === "on",
      },
      now,
      devicesStoreMode(),
    );
    return redirect(`/admin/devices/trade-ins/${result.ref}`);
  } catch (error) {
    return failed(error, locale, "counter");
  }
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, "counter.title");

export default function CounterTradeIn({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const navigation = useNavigation();
  const failure = useActionData<typeof action>() as ActionFailure | undefined;
  const fields = failure?.fields ?? {};
  const key = loaderData.key;
  const busy = navigation.state === "submitting";
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/devices/trade-ins" className="adm-link">
            {t("detail.back")}
          </Link>
        </p>
        <h1 className="adm-title">{t("counter.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("counter.lead")}</p>
      </header>
      <section className="adm-section" aria-labelledby="counter-form">
        <h2 id="counter-form" className="sr-only">
          {t("counter.title")}
        </h2>
        <Form method="post" className="grid max-w-[44rem] gap-4" noValidate>
          <input type="hidden" name="idempotencyKey" value={key} />
          <div className="dev-grid-2">
            <TextField name="phone" type="tel" autoComplete="off" label={t("counter.phone")} required hint={t("counter.phoneHint")} error={fields.phone} />
            <TextField name="contactName" label={t("counter.name")} optional error={fields.contactName} />
          </div>
          <fieldset className="grid gap-3">
            <legend className="type-label">{t("counter.device")}</legend>
            <p className="type-caption text-ink-2">{t("counter.deviceHint")}</p>
            <div className="dev-grid-2">
              <Select
                name="deviceModelId"
                label={t("counter.model")}
                error={fields.deviceModelId ?? fields.device}
                options={[{ value: "", label: t("counter.chooseModel") }, ...loaderData.models.map((model) => ({ value: model.id, label: model.platform ? `${model.name} · ${model.platform}` : model.name }))]}
              />
              <TextField name="code" label={t("counter.code")} hint={t("counter.codeHint")} ltr autoComplete="off" error={fields.code} />
            </div>
          </fieldset>
          <TextArea name="notes" label={t("counter.notes")} optional hint={t("counter.notesHint")} error={fields.notes} />
          <Checkbox name="ownershipDeclared" label={t("counter.ownership")} hint={t("counter.ownershipHint")} error={fields.ownershipDeclared} />
          <Checkbox name="accountConfirmed" label={t("counter.account")} hint={t("counter.accountHint")} error={fields.accountConfirmed} />
          <Failure message={failure && !failure.fields ? failure.message : null} />
          <div className="dev-actions">
            <Key type="submit" variant="ink" icon="plus" loading={busy}>
              {t("counter.submit")}
            </Key>
            <Key as={Link} to="/admin/devices/trade-ins">
              {t("cancel")}
            </Key>
          </div>
        </Form>
      </section>
    </>
  );
}
