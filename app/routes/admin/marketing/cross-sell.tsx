import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/cross-sell";
import { throwAsResponse } from "~/server/errors";
import { deviceAddOns, listCrossSellRules, previewDeviceShelf, saveCrossSellRule, setCrossSellRuleActive, type CrossSellRuleRow } from "~/server/services/admin/marketing/crosssell.server";
import { SECTION_READ } from "~/server/services/admin/marketing/shared.server";
import { CROSS_SELL_PLACEMENTS, RULE_KINDS, RULE_WEIGHT_MAX, parseRuleFilters, ruleSearch, type RuleEffect } from "~/server/services/admin/marketing/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { marketingMeta } from "./meta";
import { fields, openMarketing, respond, runIntent, text } from "./marketing.server";
import { ConfirmAction, ConfirmSubmit, Failure, Notice, Section, Tag, ToneStatus, useIntent, useMarketingT, When } from "./ui";

/**
 * /admin/marketing/cross-sell — 16.05: what is suggested with a device (a case, a controller, protection…) as staff
 * rules on the recommendation engine's pin / boost / exclude. A pin or a boost names only a product VERIFIED on the
 * device (the catalogue's compatibility rules) and an add-on; every rule says what it does on the storefront now, and
 * the device page's setup shelf is shown as shoppers see it. Device, kind, state and page in the URL.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openMarketing(context, SECTION_READ.crossSell);
  const filters = parseRuleFilters(new URL(request.url).searchParams);
  try {
    const [rules, addOns, shelf] = await Promise.all([
      listCrossSellRules(db, actor, filters, locale, now),
      filters.device ? deviceAddOns(db, actor, filters.device, locale, now) : Promise.resolve(null),
      filters.device ? previewDeviceShelf(db, actor, filters.device, locale, now) : Promise.resolve(null),
    ]);
    return { rules, addOns, shelf, filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openMarketing(context, "marketing.recommendation.manage");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { create: ["marketing.recommendation.manage"], active: ["marketing.recommendation.manage"] }, async (intent) => {
      if (intent === "create") return { ok: true, intent, ...(await saveCrossSellRule(db, session.actor, fields(form), ctx.now)) };
      return { ok: true, intent, ...(await setCrossSellRuleActive(db, session.actor, { ruleId: text(form, "ruleId"), active: text(form, "active"), reason: text(form, "reason") }, ctx.now)) };
    }),
  );
}

export const meta: Route.MetaFunction = (args) => marketingMeta(args, "crossSell.title");

const EFFECT_TONE: Record<RuleEffect, "ok" | "warn" | "info" | "neutral"> = {
  shows: "ok",
  removes: "info",
  not_verified: "warn",
  partial: "warn",
  incompatible: "warn",
  unverified: "warn",
  not_published: "warn",
  out_of_stock: "warn",
  inactive: "neutral",
  ended: "neutral",
  not_started: "info",
};

export default function CrossSellPage({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const navigation = useNavigation();
  const { rules, addOns, shelf, filters } = loaderData;
  const busy = navigation.state === "loading";
  /** Switch a rule off or on again (a reason, the consequence) — on the table and on the phone cards alike. */
  const ruleSwitch = (row: CrossSellRuleRow) => (
    <ConfirmAction
      intent="active"
      label={row.isActive ? t("crossSell.off") : t("crossSell.on")}
      title={row.isActive ? t("crossSell.offQ") : t("crossSell.onQ")}
      consequence={row.isActive ? t("crossSell.offWhat") : t("crossSell.onWhat")}
      confirmLabel={row.isActive ? t("crossSell.off") : t("crossSell.on")}
      values={{ ruleId: row.id, active: row.isActive ? "0" : "1" }}
      variant="ghost"
      icon={row.isActive ? "x-circle" : "check-circle"}
      doneKey={row.isActive ? "done.ruleOff" : "done.ruleOn"}
    />
  );
  const pageHref = (n: number) => ruleSearch({ ...filters, page: n }) || "?";
  const columns: DataColumn<CrossSellRuleRow>[] = [
    {
      key: "product",
      header: t("crossSell.col.product"),
      cell: (row) => (
        <span className="grid py-1">
          <span className="type-strong">{row.productName}</span>
          {row.productKind ? <span className="type-caption text-ink-2">{t(`kind.${row.productKind}`)}</span> : null}
        </span>
      ),
    },
    { key: "device", header: t("crossSell.col.device"), cell: (row) => row.deviceName ?? <span className="text-ink-2">{t("crossSell.everywhere")}</span> },
    { key: "kind", header: t("crossSell.col.kind"), cell: (row) => <Tag>{t(`crossSell.kind.${row.kind}`)}</Tag> },
    { key: "placement", header: t("crossSell.col.placement"), cell: (row) => t(`crossSell.placement.${row.placement ? row.placement.replace(":", "_") : "all"}`) },
    { key: "weight", header: t("crossSell.col.weight"), numeric: true, cell: (row) => (row.kind === "exclude" ? "—" : <bdi className="nums">{row.weight}</bdi>) },
    {
      key: "window",
      header: t("crossSell.col.window"),
      cell: (row) => (
        <span className="type-caption whitespace-nowrap">
          {row.startsAt ? <When at={row.startsAt} style="date" /> : t("crossSell.now")} – {row.endsAt ? <When at={row.endsAt} style="date" /> : t("crossSell.noEnd")}
        </span>
      ),
    },
    { key: "effect", header: t("crossSell.col.effect"), cell: (row) => <ToneStatus tone={EFFECT_TONE[row.effect]}>{t(`crossSell.effect.${row.effect}`)}</ToneStatus> },
    { key: "switch", header: t("crossSell.col.switch"), cell: (row) => ruleSwitch(row) },
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "16.05" })}</p>
        <h1 className="adm-title">{t("crossSell.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("crossSell.lead")}</p>
      </header>

      <Section id="mkt-device" title={t("crossSell.deviceTitle")} lead={t("crossSell.deviceLead")}>
        <Form method="get" action="/admin/marketing/cross-sell" className="flex flex-wrap items-end gap-3">
          <Select name="device" label={t("crossSell.device")} defaultValue={filters.device ?? ""} options={[{ value: "", label: t("crossSell.chooseDevice") }, ...rules.devices.map((device) => ({ value: device.id, label: device.name }))]} />
          <Key type="submit" icon="funnel" loading={busy}>
            {t("crossSell.showDevice")}
          </Key>
        </Form>
        {filters.device && addOns ? (
          addOns.device ? (
            <div className="mkt-layout">
              <div className="mkt-main">
                <RuleForm deviceId={addOns.device.id} deviceName={addOns.device.name} addOns={addOns.addOns} />
              </div>
              <div className="mkt-side">
                <div className="mkt-panel">
                  <p className="adm-h3">{t("crossSell.shelfTitle")}</p>
                  {shelf ? (
                    <>
                      <p className="type-caption text-ink-2">
                        {shelf.title}
                        {shelf.reason ? ` · ${shelf.reason}` : ""}
                      </p>
                      <ol className="mkt-rows">
                        {shelf.items.map((item) => (
                          <li key={item.productId} className="mkt-row">
                            <span className="type-body">{item.name}</span>
                            {item.ruled ? <Tag icon="star">{t(`crossSell.kind.${item.ruled}`)}</Tag> : <span className="type-caption text-ink-2">{t(`kind.${item.kind}`)}</span>}
                          </li>
                        ))}
                      </ol>
                    </>
                  ) : (
                    <p className="type-body text-ink-2">{t("crossSell.shelfEmpty")}</p>
                  )}
                  <p className="type-caption text-ink-2">{t("crossSell.shelfNote")}</p>
                </div>
              </div>
            </div>
          ) : (
            <Notice tone="warn" icon="warning">
              {t("crossSell.deviceUnknown")}
            </Notice>
          )
        ) : null}
      </Section>

      <Section id="mkt-rules" title={t("crossSell.listTitle")}>
        <Form method="get" action="/admin/marketing/cross-sell" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Select name="device" label={t("crossSell.device")} defaultValue={filters.device ?? ""} options={[{ value: "", label: t("common.all") }, ...rules.devices.map((device) => ({ value: device.id, label: device.name }))]} />
          <Select name="kind" label={t("crossSell.col.kind")} defaultValue={filters.kind ?? ""} options={[{ value: "", label: t("common.all") }, ...RULE_KINDS.map((kind) => ({ value: kind, label: t(`crossSell.kind.${kind}`) }))]} />
          <Select name="active" label={t("crossSell.state")} defaultValue={filters.active} options={(["active", "inactive", "all"] as const).map((value) => ({ value, label: t(`crossSell.states.${value}`) }))} />
          <div className="flex flex-wrap items-end gap-2">
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            <Key as={Link} to="/admin/marketing/cross-sell">
              {t("common.clear")}
            </Key>
          </div>
        </Form>
        <p className="type-caption text-ink-2" aria-live="polite">
          {t("common.count", { count: rules.total })}
        </p>
        {rules.rows.length === 0 ? (
          <EmptyState icon="game-controller" title={t("crossSell.empty")} text={t("crossSell.emptyHint")} />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("crossSell.listTitle")} columns={columns} rows={rules.rows} rowKey={(row) => row.id} busy={busy} maxHeight={null} footer={<Pagination page={rules.page} pageCount={rules.pageCount} href={pageHref} />} />
            </div>
            <div className="md:hidden">
              <ul className="mkt-cards" aria-label={t("crossSell.listTitle")}>
                {rules.rows.map((row) => (
                  <li key={row.id} className="mkt-card">
                    <span className="mkt-card__top">
                      <span className="type-strong">{row.productName}</span>
                      <Tag>{t(`crossSell.kind.${row.kind}`)}</Tag>
                    </span>
                    <span className="type-body text-ink-2">
                      {row.deviceName ?? t("crossSell.everywhere")} · {t(`crossSell.placement.${row.placement ? row.placement.replace(":", "_") : "all"}`)}
                    </span>
                    <span className="mkt-card__top">
                      <ToneStatus tone={EFFECT_TONE[row.effect]}>{t(`crossSell.effect.${row.effect}`)}</ToneStatus>
                      {ruleSwitch(row)}
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={rules.page} pageCount={rules.pageCount} href={pageHref} />
              </div>
            </div>
          </>
        )}
        <Notice icon="shield-check">{t("crossSell.rule")}</Notice>
      </Section>
    </>
  );
}

function RuleForm({ deviceId, deviceName, addOns }: { deviceId: string; deviceName: string; addOns: { productId: string; name: string; kind: string; stock: string | null }[] }) {
  const t = useMarketingT();
  const [kind, setKind] = useState<string>("pin");
  const [formKey, setFormKey] = useState(0);
  const { fetcher, message, fields: errors } = useIntent("create", "done.ruleCreated", () => setFormKey((value) => value + 1));
  /** What the rule will do, read from the form: which product, on which device and shelves (the server verifies it). */
  const impact = (form: FormData) => {
    const product = addOns.find((addOn) => addOn.productId === String(form.get("productId") ?? ""));
    const placement = String(form.get("placement") ?? "");
    const rows = [
      { label: t("crossSell.col.product"), value: product ? product.name : t("crossSell.chooseProduct") },
      { label: t("crossSell.col.device"), value: deviceName },
      { label: t("crossSell.col.placement"), value: t(`crossSell.placement.${placement ? placement.replace(":", "_") : "all"}`) },
    ];
    if (kind !== "exclude") rows.push({ label: t("crossSell.col.weight"), value: String(form.get("weight") ?? "") });
    return rows;
  };
  return (
    <div className="grid gap-3">
      <p className="adm-h3">{t("crossSell.formTitle", { device: deviceName })}</p>
      {addOns.length === 0 ? (
        <Notice tone="warn" icon="warning">
          {t("crossSell.noAddOns")}
        </Notice>
      ) : null}
      <fetcher.Form key={formKey} method="post" className="mkt-form" noValidate>
        <input type="hidden" name="intent" value="create" />
        <input type="hidden" name="deviceModelId" value={deviceId} />
        <div className="mkt-grid">
          <Select name="kind" label={t("crossSell.col.kind")} hint={t(`crossSell.kindHint.${kind}`)} value={kind} onChange={(event) => setKind(event.currentTarget.value)} options={RULE_KINDS.map((value) => ({ value, label: t(`crossSell.kind.${value}`) }))} error={errors.kind} />
          <Select
            name="productId"
            label={t("crossSell.col.product")}
            hint={t("crossSell.productHint")}
            options={[{ value: "", label: t("crossSell.chooseProduct") }, ...addOns.map((addOn) => ({ value: addOn.productId, label: `${addOn.name} · ${t(`kind.${addOn.kind}`)}${addOn.stock === "out_of_stock" ? ` · ${t("crossSell.soldOut")}` : ""}` }))]}
            error={errors.productId}
          />
          <Select name="placement" label={t("crossSell.col.placement")} hint={t("crossSell.placementHint")} options={CROSS_SELL_PLACEMENTS.map((value) => ({ value, label: t(`crossSell.placement.${value ? value.replace(":", "_") : "all"}`) }))} error={errors.placement} />
          {kind !== "exclude" ? <TextField name="weight" label={t("crossSell.col.weight")} hint={t(kind === "pin" ? "crossSell.weightPinHint" : "crossSell.weightBoostHint", { max: RULE_WEIGHT_MAX })} defaultValue={kind === "pin" ? "0" : "10"} inputMode="numeric" error={errors.weight} /> : null}
          <TextField name="startsOn" type="date" label={t("crossSell.startsOn")} error={errors.startsOn} />
          <TextField name="endsOn" type="date" label={t("crossSell.endsOn")} error={errors.endsOn} />
        </div>
        <TextArea name="reason" label={t("common.reason")} hint={t("crossSell.reasonHint")} required rows={2} maxLength={300} error={errors.reason} />
        <Failure message={message} />
        <div className="mkt-actions">
          <ConfirmSubmit fetcher={fetcher} label={t("crossSell.create")} title={t("crossSell.createQ")} consequence={() => t(`crossSell.kindHint.${kind}`)} confirmLabel={t("crossSell.create")} impact={impact} icon="plus" disabled={addOns.length === 0} />
        </div>
      </fetcher.Form>
    </div>
  );
}
