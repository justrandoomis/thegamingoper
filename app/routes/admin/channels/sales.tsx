import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/sales";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { createChannel, listChannels, renameChannel, setChannelActive } from "~/server/services/admin/channels/channels.server";
import { linkIf } from "~/server/services/admin/channels/shared.server";
import { NEW_CHANNEL_KINDS, type ChannelRow } from "~/server/services/admin/channels/types";
import { Disclosure } from "~/ui/Disclosure";
import { Radio, FieldGroup, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog, Code, DialogKey, FormError, Note, PageHead, Section, StatusText, failureText, useChT } from "./components/ui";
import { ch, newKey, ok, optional, text } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/sales — 21.01 per channel: every sales channel and where it takes its stock, prices and delivery
 * from TODAY (the online store: every sellable location, the variant price — price lists for it exist in module 03
 * but the checkout does not apply them yet — and the governorate fee; the POS: its registers' store locations, its
 * price lists, at the counter), each with a link to the module that decides it (never a second copy). Added channels
 * (a marketplace, social selling) are records only: not connected, no order can arrive from them. Rename any channel;
 * switch an added one off or on (channels.channel.manage, with a reason); the built-in two cannot be switched off.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args);
  const rows = await ch.orRespond(() => listChannels(req.db, req.actor, req.locale));
  return {
    rows,
    manage: can(req.actor, "channels.channel.manage"),
    key: newKey(),
    links: {
      locations: linkIf(req.actor, ["inventory.stock.read"], "/admin/inventory/locations"),
      registers: linkIf(req.actor, ["pos.sale.create", "pos.shift.open", "pos.shift.review", "pos.register.manage", "pos.receipt.reprint"], "/admin/pos/registers"),
      lists: linkIf(req.actor, ["pricing.price_list.manage", "pricing.price.update", "pricing.price.approve", "pricing.discount.override", "pricing.simulation.run"], "/admin/pricing/lists"),
      zones: linkIf(req.actor, ["shipping.shipment.read", "shipping.zone.manage", "shipping.rate.manage", "shipping.carrier.manage"], "/admin/shipping/zones"),
    },
  };
}

export async function action(args: Route.ActionArgs) {
  const req = await ch.open(args, "channels.channel.manage");
  const form = await ch.form(args.request).catch(() => new FormData());
  const intent = text(form, "intent");
  try {
    if (intent === "create") {
      const result = await createChannel(req.db, req.actor, { key: text(form, "key"), nameAr: text(form, "nameAr"), nameEn: optional(form, "nameEn"), kind: text(form, "kind"), reason: optional(form, "reason"), idempotencyKey: text(form, "formKey") }, req.now);
      return ok("create", { replayed: result.replayed });
    }
    if (intent === "rename") {
      const result = await renameChannel(req.db, req.actor, { channelId: text(form, "channelId"), nameAr: text(form, "nameAr"), nameEn: optional(form, "nameEn"), fingerprint: text(form, "fingerprint"), reason: text(form, "reason") }, req.now);
      return ok("rename", { changed: result.changed, channelId: text(form, "channelId") });
    }
    if (intent === "active") {
      const result = await setChannelActive(req.db, req.actor, { channelId: text(form, "channelId"), active: text(form, "active") === "1", reason: text(form, "reason") }, req.now);
      return ok("active", { changed: result.changed });
    }
    throw new Response(null, { status: 400 });
  } catch (error) {
    return ch.failed(error, req, intent, { channelId: text(form, "channelId") });
  }
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "sales.title");

export default function SalesChannelsPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const { rows, manage, links } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const creating = navigation.state !== "idle" && navigation.formData?.get("intent") === "create";
  const createResult = result?.intent === "create" ? result : null;
  const createFields = (createResult && !createResult.ok ? createResult.fields : undefined) ?? {};
  const createFailure = createResult && !createResult.ok ? (createResult.fields ? t("common.checkFields") : failureText(t, createResult)) : null;
  return (
    <>
      <PageHead title={t("sales.title")} lead={t("sales.lead")} />
      <Section id="ch-channels" title={t("sales.list")}>
        <ul role="list" className="ch-cards">
          {rows.map((row) => (
            <ChannelCard key={row.id} row={row} manage={manage} links={links} result={result?.intent === "rename" && "channelId" in result && result.channelId === row.id ? result : null} />
          ))}
        </ul>
        <p className="type-caption text-ink-2">{t("sales.sourceNote")}</p>
      </Section>

      {manage ? (
        <Section id="ch-channel-new" title={t("sales.new")}>
          {createResult?.ok ? (
            <Note tone="ok" icon="check-circle">
              <p>{t(createResult.replayed ? "sales.createdAgain" : "sales.created")}</p>
            </Note>
          ) : null}
          <Form method="post" className="grid max-w-[44rem] gap-4" noValidate key={createResult?.ok ? "done" : "form"}>
            <input type="hidden" name="intent" value="create" />
            <input type="hidden" name="formKey" value={loaderData.key} />
            <div className="ch-form ch-form--two">
              <TextField name="key" label={t("sales.field.key")} hint={t("sales.field.keyHint")} required ltr maxLength={24} error={createFields.key} />
              <TextField name="nameAr" label={t("sales.field.nameAr")} required maxLength={60} error={createFields.nameAr} />
              <TextField name="nameEn" label={t("sales.field.nameEn")} optional ltr lang="en" maxLength={60} error={createFields.nameEn} />
              <FieldGroup legend={t("sales.field.kind")} required error={createFields.kind}>
                {NEW_CHANNEL_KINDS.map((kind, index) => (
                  <Radio key={kind} name="kind" value={kind} label={t(`kind.${kind}`)} defaultChecked={index === 0} />
                ))}
              </FieldGroup>
              <TextField className="ch-span" name="reason" label={t("common.reason")} optional maxLength={500} error={createFields.reason} />
            </div>
            <Note icon="info">
              <p>{t("sales.newNote")}</p>
            </Note>
            <FormError message={createFailure} />
            <div className="ch-actions">
              <Key type="submit" variant="ink" icon="plus" loading={creating}>
                {t("sales.create")}
              </Key>
            </div>
          </Form>
        </Section>
      ) : null}
    </>
  );
}

type Links = { locations: string | null; registers: string | null; lists: string | null; zones: string | null };

function ChannelCard({ row, manage, links, result }: { row: ChannelRow; manage: boolean; links: Links; result: { ok: boolean; fields?: Record<string, string>; message?: string; code?: string; changed?: boolean } | null }) {
  const t = useChT();
  const f = useFormat();
  const navigation = useNavigation();
  const renaming = navigation.state !== "idle" && navigation.formData?.get("intent") === "rename" && navigation.formData?.get("channelId") === row.id;
  const fields = (result && !result.ok ? result.fields : undefined) ?? {};
  const rules = row.rules;
  const stock =
    rules.stock.kind === "sellable_locations"
      ? t("sales.rule.stockWeb", { count: rules.stock.locations })
      : rules.stock.kind === "register_stores"
        ? t("sales.rule.stockPos", { registers: f.number(rules.stock.registers), stores: f.number(rules.stock.stores) })
        : t("sales.rule.stockNone");
  const prices = rules.prices.applied ? t("sales.rule.pricesApplied", { count: rules.prices.activeLists }) : row.key === "web" ? t("sales.rule.pricesWeb", { count: rules.prices.activeLists }) : t("sales.rule.pricesNone", { count: rules.prices.activeLists });
  return (
    <li className="adm-card content-start gap-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="grid gap-0.5">
          <p className="type-strong text-ink">
            {row.name} · <Code>{row.key}</Code>
          </p>
          <p className="type-caption text-ink-2">{t(`kind.${row.kind}`)}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <StatusText tone={row.connected ? "ok" : "warn"}>{t(row.connected ? "sales.connected" : "sales.notConnected")}</StatusText>
          {row.isSystem ? null : <StatusText tone={row.isActive ? "ok" : "out"}>{t(row.isActive ? "branches.active" : "branches.inactive")}</StatusText>}
        </div>
      </div>
      <dl className="ch-facts type-data">
        <dt>{t("sales.rule.stock")}</dt>
        <dd>
          {stock}
          {rules.stock.kind === "sellable_locations" && links.locations ? <RuleLink to={links.locations} /> : null}
          {rules.stock.kind === "register_stores" && links.registers ? <RuleLink to={links.registers} /> : null}
        </dd>
        <dt>{t("sales.rule.prices")}</dt>
        <dd>
          {prices}
          {links.lists ? <RuleLink to={links.lists} /> : null}
        </dd>
        <dt>{t("sales.rule.delivery")}</dt>
        <dd>
          {rules.delivery.kind === "governorate_fee" ? (
            <>
              {t(rules.delivery.overridesEnabled ? "sales.rule.deliveryOverrides" : "sales.rule.deliveryFlat", { fee: f.iqd(rules.delivery.flatFeeIqd) })}
              {links.zones ? <RuleLink to={links.zones} /> : null}
            </>
          ) : rules.delivery.kind === "counter" ? (
            t("sales.rule.deliveryCounter")
          ) : (
            t("sales.rule.deliveryNone")
          )}
        </dd>
      </dl>
      {!row.connected ? <p className="type-caption text-ink-2">{t("sales.notConnectedNote")}</p> : null}
      {manage ? (
        <div className="grid gap-2">
          <Disclosure summary={t("sales.rename")} defaultOpen={Boolean(result && !result.ok)}>
            <Form method="post" className="grid gap-3" noValidate>
              <input type="hidden" name="intent" value="rename" />
              <input type="hidden" name="channelId" value={row.id} />
              <input type="hidden" name="fingerprint" value={row.fingerprint} />
              <TextField name="nameAr" label={t("sales.field.nameAr")} required maxLength={60} defaultValue={row.nameAr} error={fields.nameAr} />
              <TextField name="nameEn" label={t("sales.field.nameEn")} optional ltr lang="en" maxLength={60} defaultValue={row.nameEn} error={fields.nameEn} />
              <TextField name="reason" label={t("common.reason")} required maxLength={500} error={fields.reason} />
              <FormError message={result && !result.ok ? (result.fields ? t("common.checkFields") : failureText(t, result)) : null} />
              {result?.ok ? <p className="type-caption text-ink-2">{t(result.changed ? "sales.renamed" : "branch.unchanged")}</p> : null}
              <div className="ch-actions">
                <Key type="submit" size="sm" icon="floppy-disk" loading={renaming}>
                  {t("sales.saveName")}
                </Key>
              </div>
            </Form>
          </Disclosure>
          {row.isSystem ? (
            <p className="type-caption text-ink-2">{t("sales.systemNote")}</p>
          ) : (
            <div className="ch-actions">
              <DialogKey label={t(row.isActive ? "sales.deactivate" : "sales.activate")} icon={row.isActive ? "x-circle" : "check-circle"}>
                {(close) => (
                  <ActionDialog
                    open
                    onClose={close}
                    title={t(row.isActive ? "sales.deactivateTitle" : "sales.activateTitle", { name: row.name })}
                    consequence={t(row.isActive ? "sales.deactivateText" : "sales.activateText")}
                    confirmLabel={t(row.isActive ? "sales.deactivate" : "sales.activate")}
                    tone={row.isActive ? "destructive" : "neutral"}
                    impact={row.isActive ? [{ label: t("sales.impact.lists"), value: t("sales.impact.listsValue", { count: row.rules.prices.activeLists }) }] : undefined}
                    reason
                    fields={{ intent: "active", channelId: row.id, active: row.isActive ? "0" : "1" }}
                    successMessage={t(row.isActive ? "sales.deactivated" : "sales.activated")}
                  />
                )}
              </DialogKey>
            </div>
          )}
        </div>
      ) : null}
    </li>
  );
}

function RuleLink({ to }: { to: string }) {
  const t = useChT();
  return (
    <>
      {" "}
      <Link to={to} className="adm-link">
        {t("sales.rule.open")}
      </Link>
    </>
  );
}

