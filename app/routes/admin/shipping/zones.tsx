import { useMemo, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/zones";
import { useFormat } from "~/i18n/react";
import { assertCan } from "~/server/actor";
import { invalid, throwAsResponse } from "~/server/errors";
import { feeChanges, type FeePolicy } from "~/server/services/admin/shipping/rules";
import { listZones, setFlatFee, setOverrideFee, setOverridesEnabled } from "~/server/services/admin/shipping/zones.server";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ActionDialog, Money, Note, PageHead, Pair, ResponsiveList, RowLink, Section, When, digitsOnly, useArrow, useShipT, wholeValue } from "./components/kit";
import { shippingMeta } from "./meta";
import { amount, failed, ok, openShipping, text } from "./shipping.server";

/**
 * /admin/shipping/zones — 11.01: where the store delivers and what it charges. The flat fee (settings
 * "shipping.flat_fee_iqd", 5,000 IQD) and the switch for per-governorate fees change what CHECKOUT charges from the
 * next order on, so each change shows the governorates whose fee moves before it is confirmed, needs a reason and is
 * audited (settings.shipping.manage). The list shows each governorate's availability, the fee in force, its override,
 * its delivery estimate and its districts; a governorate's page changes them.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openShipping(context);
  try {
    return { zones: await listZones(db, actor, locale) };
  } catch (error) {
    // a role that passes the module's gate without any of the page's permissions: 403, not a crash
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await openShipping(context);
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    // the permission before the input: a role that may not change fees gets 403, never a field error
    if (intent === "flat" || intent === "switch") assertCan(req.actor, "settings.shipping.manage");
    if (intent === "all") assertCan(req.actor, "shipping.rate.manage");
    switch (intent) {
      case "flat": {
        const fee = amount(form, "feeIqd");
        if (fee === undefined || Number.isNaN(fee)) throw invalid({ feeIqd: fee === undefined ? "required" : "invalid" });
        const result = await setFlatFee(req.db, req.actor, { feeIqd: fee, expectedFeeIqd: Number(text(form, "expected")), reason: text(form, "reason") }, req.now);
        return ok(intent, { changed: result.changes.length });
      }
      case "switch": {
        const result = await setOverridesEnabled(req.db, req.actor, { enabled: text(form, "enabled") === "1", expected: text(form, "expected") === "1", reason: text(form, "reason") }, req.now);
        return ok(intent, { changed: result.changes.length });
      }
      case "all": {
        const fee = amount(form, "feeIqd");
        if (Number.isNaN(fee)) throw invalid({ feeIqd: "invalid" });
        const expected = text(form, "expected");
        const result = await setOverrideFee(req.db, req.actor, { governorateId: null, feeIqd: fee ?? null, expectedIqd: expected === "" ? null : Number(expected), reason: text(form, "reason") }, req.now);
        return ok(intent, { changed: result.changes.length, applies: result.applies });
      }
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => shippingMeta(args, "zones.title");

type Zones = Route.ComponentProps["loaderData"]["zones"];

export default function ZonesPage({ loaderData }: Route.ComponentProps) {
  const t = useShipT();
  const f = useFormat();
  const { zones } = loaderData;
  const { policy, rows } = zones;
  const paused = rows.filter((row) => !row.isActive).length;
  return (
    <>
      <PageHead title={t("zones.title")} lead={t("zones.lead")} />
      <Section id="policy" title={t("zones.policy")}>
        <div className="grid gap-3 lg:grid-cols-3">
          <FlatFeeCard zones={zones} />
          <SwitchCard zones={zones} />
          <AllOverrideCard zones={zones} />
        </div>
        <Note>
          <p>{t("zones.policyNote")}</p>
          <p>{t("zones.etaNote")}</p>
        </Note>
      </Section>

      <Section id="governorates" title={t("zones.governorates", { count: rows.length })} aside={paused ? <span className="type-caption text-ink-2">{t("zones.pausedCount", { count: paused })}</span> : undefined}>
        <ResponsiveList
          caption={t("zones.governorates", { count: rows.length })}
          rows={rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "name", header: t("common.governorate"), cell: (row) => <RowLink to={`/admin/shipping/zones/${encodeURIComponent(row.id)}`}>{row.name}</RowLink> },
            { key: "state", header: t("zones.delivery"), cell: (row) => <Status tone={row.isActive ? "ok" : "warn"}>{row.isActive ? t("zones.active") : t("zones.paused")}</Status> },
            { key: "fee", header: t("zones.fee"), numeric: true, cell: (row) => (row.feeIqd === null ? <span className="text-ink-2">{t("zones.notOffered")}</span> : <Money iqd={row.feeIqd} />) },
            { key: "override", header: t("zones.override"), numeric: true, cell: (row) => (row.overrideIqd === null ? "—" : <Money iqd={row.overrideIqd} />) },
            { key: "eta", header: t("zones.eta"), cell: (row) => (row.etaDaysMin === null ? <span className="text-ink-2">{t("zones.noEta")}</span> : t("zones.etaRange", { min: row.etaDaysMin, max: row.etaDaysMax ?? row.etaDaysMin })) },
            { key: "districts", header: t("zones.districts"), numeric: true, cell: (row) => `${f.number(row.districts.active)} / ${f.number(row.districts.total)}` },
            { key: "open", header: t("zones.openOrders"), numeric: true, cell: (row) => f.number(row.openOrders) },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/shipping/zones/${encodeURIComponent(row.id)}`} className="adm-link type-strong">
                  {row.name}
                </Link>
                <Status tone={row.isActive ? "ok" : "warn"}>{row.isActive ? t("zones.active") : t("zones.paused")}</Status>
              </div>
              <Pair label={t("zones.fee")}>{row.feeIqd === null ? t("zones.notOffered") : <Money iqd={row.feeIqd} />}</Pair>
              <Pair label={t("zones.eta")}>{row.etaDaysMin === null ? t("zones.noEta") : t("zones.etaRange", { min: row.etaDaysMin, max: row.etaDaysMax ?? row.etaDaysMin })}</Pair>
              <Pair label={t("zones.districts")}>
                <bdi className="nums">
                  {f.number(row.districts.active)} / {f.number(row.districts.total)}
                </bdi>
              </Pair>
            </>
          )}
        />
        {policy.updatedAt ? (
          <p className="type-caption text-ink-2">
            {t("zones.lastChange", { who: policy.updatedBy ?? "—" })} · <When at={policy.updatedAt} />
          </p>
        ) : null}
      </Section>
    </>
  );
}

const zoneRows = (zones: Zones) => zones.rows.map((row) => ({ id: row.id, name: row.name, isActive: row.isActive, overrideIqd: row.overrideIqd }));
const basePolicy = (zones: Zones): FeePolicy => ({ flatFeeIqd: zones.policy.flatFeeIqd, overridesEnabled: zones.policy.overridesEnabled, allOverrideIqd: zones.policy.allOverrideIqd });

/** The governorates whose fee changes, as dialog impact rows (at most 6 named, then "and N more"). */
function useImpact(changes: { name: string; beforeIqd: number; afterIqd: number }[]) {
  const t = useShipT();
  const f = useFormat();
  const arrow = useArrow();
  return useMemo(() => {
    if (changes.length === 0) return [{ label: t("zones.impactNone"), value: "—" }];
    const rows = changes.slice(0, 6).map((change) => ({ label: change.name, value: `${f.iqd(change.beforeIqd)} ${arrow} ${f.iqd(change.afterIqd)}`, negative: change.afterIqd < change.beforeIqd }));
    if (changes.length > 6) rows.push({ label: t("zones.impactMore", { count: changes.length - 6 }), value: "", negative: false });
    return [{ label: t("zones.impactCount"), value: f.number(changes.length) }, ...rows];
  }, [arrow, changes, f, t]);
}

function FlatFeeCard({ zones }: { zones: Zones }) {
  const t = useShipT();
  const f = useFormat();
  const [value, setValue] = useState(String(zones.policy.flatFeeIqd));
  const [open, setOpen] = useState(false);
  const fee = wholeValue(value);
  const bad = fee !== null && Number.isNaN(fee);
  const changes = useMemo(() => (fee === null || Number.isNaN(fee) ? [] : feeChanges(zoneRows(zones), basePolicy(zones), { ...basePolicy(zones), flatFeeIqd: fee })), [fee, zones]);
  const impact = useImpact(changes);
  return (
    <div className="adm-card">
      <h3 className="adm-h3">{t("zones.flatTitle")}</h3>
      <p className="type-kpi nums">
        <Money iqd={zones.policy.flatFeeIqd} />
      </p>
      {zones.can.fee ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (fee !== null && !bad && fee !== zones.policy.flatFeeIqd) setOpen(true);
          }}
        >
          <TextField label={t("zones.newFlat")} inputMode="numeric" value={value} onChange={(event) => setValue(digitsOnly(event.currentTarget.value))} hint={t("zones.flatHint")} error={bad ? t("common.wholeDinars") : undefined} />
          <div>
            <Key type="submit" size="sm" disabled={fee === null || bad || fee === zones.policy.flatFeeIqd}>
              {t("zones.changeFlat")}
            </Key>
          </div>
        </form>
      ) : (
        <p className="type-caption text-ink-2">{t("zones.flatReadOnly")}</p>
      )}
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("zones.flatDialogTitle")}
        consequence={t("zones.flatDialogConsequence", { fee: fee === null ? "—" : f.iqd(fee) })}
        confirmLabel={t("zones.changeFlat")}
        impact={impact}
        reason={{ label: t("zones.reason"), hint: t("zones.reasonHint") }}
        fields={{ intent: "flat", feeIqd: value, expected: String(zones.policy.flatFeeIqd) }}
        successMessage={t("zones.flatDone")}
      />
    </div>
  );
}

function SwitchCard({ zones }: { zones: Zones }) {
  const t = useShipT();
  const [open, setOpen] = useState(false);
  const next = !zones.policy.overridesEnabled;
  const changes = useMemo(() => feeChanges(zoneRows(zones), basePolicy(zones), { ...basePolicy(zones), overridesEnabled: next }), [next, zones]);
  const impact = useImpact(changes);
  const count = zones.rows.filter((row) => row.overrideIqd !== null).length + (zones.policy.allOverrideIqd !== null ? 1 : 0);
  return (
    <div className="adm-card">
      <h3 className="adm-h3">{t("zones.switchTitle")}</h3>
      <p className="type-body">
        <Status tone={zones.policy.overridesEnabled ? "info" : "neutral"}>{zones.policy.overridesEnabled ? t("zones.switchOn") : t("zones.switchOff")}</Status>
      </p>
      <p className="type-caption text-ink-2">{t("zones.switchHint", { count })}</p>
      {zones.can.fee ? (
        <div>
          <Key size="sm" onClick={() => setOpen(true)}>
            {next ? t("zones.turnOn") : t("zones.turnOff")}
          </Key>
        </div>
      ) : null}
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={next ? t("zones.turnOnTitle") : t("zones.turnOffTitle")}
        consequence={next ? t("zones.turnOnConsequence") : t("zones.turnOffConsequence")}
        confirmLabel={next ? t("zones.turnOn") : t("zones.turnOff")}
        impact={impact}
        reason={{ label: t("zones.reason"), hint: t("zones.reasonHint") }}
        fields={{ intent: "switch", enabled: next ? "1" : "0", expected: zones.policy.overridesEnabled ? "1" : "0" }}
        successMessage={t("zones.switchDone")}
      />
    </div>
  );
}

function AllOverrideCard({ zones }: { zones: Zones }) {
  const t = useShipT();
  const current = zones.policy.allOverrideIqd;
  const [value, setValue] = useState(current === null ? "" : String(current));
  const [open, setOpen] = useState(false);
  const fee = wholeValue(value);
  const bad = fee !== null && Number.isNaN(fee);
  const changes = useMemo(() => (bad ? [] : feeChanges(zoneRows(zones), basePolicy(zones), { ...basePolicy(zones), allOverrideIqd: fee })), [bad, fee, zones]);
  const impact = useImpact(changes);
  return (
    <div className="adm-card">
      <h3 className="adm-h3">{t("zones.allTitle")}</h3>
      <p className="type-body">{current === null ? <span className="text-ink-2">{t("zones.allNone")}</span> : <Money iqd={current} />}</p>
      <p className="type-caption text-ink-2">{t("zones.allHint")}</p>
      {zones.can.rates ? (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!bad && fee !== current) setOpen(true);
          }}
        >
          <TextField label={t("zones.allNew")} inputMode="numeric" value={value} onChange={(event) => setValue(digitsOnly(event.currentTarget.value))} hint={t("zones.emptyRemoves")} error={bad ? t("common.wholeDinars") : undefined} />
          <div>
            <Key type="submit" size="sm" disabled={bad || fee === current}>
              {fee === null ? t("zones.removeOverride") : t("zones.saveOverride")}
            </Key>
          </div>
        </form>
      ) : null}
      <ActionDialog
        open={open}
        onClose={() => setOpen(false)}
        title={fee === null ? t("zones.removeAllTitle") : t("zones.allDialogTitle")}
        consequence={zones.policy.overridesEnabled ? t("zones.overrideApplies") : t("zones.overrideDormant")}
        confirmLabel={fee === null ? t("zones.removeOverride") : t("zones.saveOverride")}
        impact={zones.policy.overridesEnabled ? impact : [{ label: t("zones.impactCount"), value: "0" }]}
        reason={{ label: t("zones.reason"), hint: t("zones.reasonHint") }}
        fields={{ intent: "all", feeIqd: value, expected: current === null ? "" : String(current) }}
        successMessage={t("zones.overrideDone")}
      />
    </div>
  );
}
