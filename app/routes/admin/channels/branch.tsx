import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/branch";
import { useFormat } from "~/i18n/react";
import { branchFormOptions, getBranch, setBranchActive, updateBranch } from "~/server/services/admin/channels/branches.server";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { BranchFields, branchValuesFrom, type BranchValues } from "./components/BranchFields";
import { ActionDialog, Code, DialogKey, FormError, Kpi, Money, Note, PageHead, Section, StatusText, failureText, useChT } from "./components/ui";
import { ch, ok, text } from "./kit.server";
import { chMeta } from "./meta";

/**
 * /admin/channels/branches/:branchId — 21.01: one branch. Its details (code, names, governorate and district, address,
 * phone, opening hours — a save is refused when someone changed the branch after this page was built), switching it
 * off or on (with a reason; off is refused while active locations, registers, employees or price lists still use it),
 * and what belongs to it in the other modules — each part only for an employee who may read it there, with the link to
 * the page where it is changed: stock locations and their stock (04), registers (06), employees limited to it (20),
 * price lists (03) and this month's till sales (06).
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await ch.open(args, "channels.branch.manage");
  const branchId = args.params.branchId;
  const [branch, options] = await ch.orRespond(() => Promise.all([getBranch(req.db, req.actor, branchId, req.locale, req.now), branchFormOptions(req.db, req.locale)]));
  const saved = new URL(args.request.url).searchParams.get("saved");
  return { branch, options, saved: saved === "created" || saved === "again" ? saved : null, limited: Boolean(req.actor.branchId) };
}

export async function action(args: Route.ActionArgs) {
  const req = await ch.open(args, "channels.branch.manage");
  const form = await ch.form(args.request).catch(() => new FormData());
  const intent = text(form, "intent");
  try {
    if (intent === "save") {
      const result = await updateBranch(req.db, req.actor, { ...branchValuesFrom(form), branchId: args.params.branchId, fingerprint: text(form, "fingerprint"), reason: text(form, "reason") }, req.now);
      return ok("save", { changed: result.changed });
    }
    if (intent === "active") {
      const result = await setBranchActive(req.db, req.actor, { branchId: args.params.branchId, active: text(form, "active") === "1", reason: text(form, "reason") }, req.now);
      return ok("active", { changed: result.changed });
    }
    throw new Response(null, { status: 400 });
  } catch (error) {
    return ch.failed(error, req, intent, { values: branchValuesFrom(form) });
  }
}

export const meta: Route.MetaFunction = (args) => chMeta(args, "branch.title", { name: args.loaderData?.branch.name ?? "" });

export default function BranchPage({ loaderData }: Route.ComponentProps) {
  const t = useChT();
  const f = useFormat();
  const { branch, options, saved, limited } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle" && navigation.formData?.get("intent") === "save";
  const saveResult = result && result.intent === "save" ? result : null;
  const failure = saveResult && !saveResult.ok ? (saveResult.fields ? t("common.checkFields") : failureText(t, saveResult)) : null;
  const values: BranchValues =
    saveResult && !saveResult.ok && "values" in saveResult
      ? (saveResult.values as BranchValues)
      : {
          code: branch.code,
          nameAr: branch.nameAr,
          nameEn: branch.nameEn,
          governorateId: branch.governorateId ?? "",
          districtId: branch.districtId ?? "",
          addressText: branch.addressText ?? "",
          phone: branch.phone ?? "",
          hoursAr: branch.hoursAr,
          hoursEn: branch.hoursEn,
        };
  const inUse = branch.inUse.locations + branch.inUse.registers + branch.inUse.employees + branch.inUse.priceLists;
  const usage = branch.usage;

  return (
    <>
      <PageHead
        eyebrow={
          <Link to="/admin/channels/branches" className="adm-link">
            {t("branch.back")}
          </Link>
        }
        title={
          <>
            {branch.name} · <Code>{branch.code}</Code>
          </>
        }
        lead={<StatusText tone={branch.isActive ? "ok" : "out"}>{t(branch.isActive ? "branches.active" : "branches.inactive")}</StatusText>}
        actions={
          limited ? null : branch.isActive ? (
            inUse === 0 ? (
              <DialogKey label={t("branch.deactivate")} icon="x-circle">
                {(close) => (
                  <ActionDialog
                    open
                    onClose={close}
                    title={t("branch.deactivateTitle", { name: branch.name })}
                    consequence={t("branch.deactivateText")}
                    confirmLabel={t("branch.deactivate")}
                    tone="destructive"
                    impact={[{ label: t("branch.impact.options"), value: t("branch.impact.optionsValue") }]}
                    reason
                    fields={{ intent: "active", active: "0" }}
                    successMessage={t("branch.deactivated")}
                  />
                )}
              </DialogKey>
            ) : null
          ) : (
            <DialogKey label={t("branch.activate")} icon="check-circle">
              {(close) => (
                <ActionDialog
                  open
                  onClose={close}
                  title={t("branch.activateTitle", { name: branch.name })}
                  consequence={t("branch.activateText")}
                  confirmLabel={t("branch.activate")}
                  reason
                  fields={{ intent: "active", active: "1" }}
                  successMessage={t("branch.activated")}
                />
              )}
            </DialogKey>
          )
        }
      />

      {saved ? (
        <Note tone="ok" icon="check-circle">
          <p>{t(saved === "created" ? "branch.created" : "branch.createdAgain")}</p>
        </Note>
      ) : null}
      {saveResult?.ok ? (
        <Note tone="ok" icon="check-circle">
          <p>{t(saveResult.changed ? "branch.saved" : "branch.unchanged")}</p>
        </Note>
      ) : null}
      {branch.isActive && inUse > 0 && !limited ? (
        <Note icon="info">
          <p>{t("branch.inUse", { locations: f.number(branch.inUse.locations), registers: f.number(branch.inUse.registers), employees: f.number(branch.inUse.employees), lists: f.number(branch.inUse.priceLists) })}</p>
        </Note>
      ) : null}

      <div className="ch-split">
        <Section id="ch-branch-edit" title={t("branch.details")}>
          <Form method="post" className="grid gap-4" noValidate>
            <input type="hidden" name="intent" value="save" />
            <input type="hidden" name="fingerprint" value={branch.fingerprint} />
            <BranchFields key={branch.fingerprint} values={values} options={options} errors={(saveResult && !saveResult.ok ? saveResult.fields : undefined) ?? {}} />
            <TextField name="reason" label={t("common.reason")} hint={t("branch.reasonHint")} required maxLength={500} error={saveResult && !saveResult.ok ? saveResult.fields?.reason : undefined} />
            <FormError message={failure} />
            <div className="ch-actions">
              <Key type="submit" variant="ink" icon="floppy-disk" loading={busy}>
                {t("branch.save")}
              </Key>
            </div>
          </Form>
        </Section>

        <div className="grid gap-5">
          <Section id="ch-branch-stock" title={t("branch.usage.stock")}>
            {usage.stock ? (
              <div className="ch-kpis">
                <Kpi label={t("branch.usage.available")} value={f.number(usage.stock.available)} hint={t("branch.usage.onHand", { count: usage.stock.onHand })} to={branch.links.locations} />
                <Kpi label={t("branch.usage.skus")} value={f.number(usage.stock.skus)} />
              </div>
            ) : (
              <p className="type-caption text-ink-2">{t("branch.usage.needs", { permission: "inventory.stock.read" })}</p>
            )}
          </Section>
          <UsageList
            id="ch-branch-locations"
            title={t("branch.usage.locations")}
            rows={usage.locations?.map((row) => ({ id: row.id, label: `${row.name} · ${row.code}`, tone: row.isActive ? (row.isSellable ? "ok" : "info") : "out", state: t(row.isActive ? (row.isSellable ? "branch.usage.sellable" : "branch.usage.notSellable") : "branches.inactive") })) ?? null}
            link={branch.links.locations}
            permission="inventory.stock.read"
            empty={t("branch.usage.noLocations")}
          />
          <UsageList
            id="ch-branch-registers"
            title={t("branch.usage.registers")}
            rows={usage.registers?.map((row) => ({ id: row.id, label: `${row.name} · ${row.code}`, tone: row.isActive ? "ok" : "out", state: t(row.isActive ? "branches.active" : "branches.inactive") })) ?? null}
            link={branch.links.registers}
            permission="pos.register.manage"
            empty={t("branch.usage.noRegisters")}
          />
          <UsageList
            id="ch-branch-people"
            title={t("branch.usage.employees")}
            rows={usage.employees?.map((row) => ({ id: row.id, label: row.name, tone: row.status === "active" ? "ok" : "out", state: t(row.status === "active" ? "branches.active" : "branch.usage.disabled") })) ?? null}
            link={branch.links.employees}
            permission="security.session.read"
            empty={t("branch.usage.noEmployees")}
          />
          <UsageList
            id="ch-branch-lists"
            title={t("branch.usage.priceLists")}
            rows={usage.priceLists?.map((row) => ({ id: row.id, label: `${row.name} · ${row.code}`, tone: row.isActive ? "ok" : "out", state: t(row.isActive ? "branches.active" : "branches.inactive") })) ?? null}
            link={branch.links.priceLists}
            permission="pricing.price_list.manage"
            empty={t("branch.usage.noLists")}
          />
          <Section id="ch-branch-sales" title={t("branch.usage.sales")}>
            {usage.sales ? (
              <div className="ch-kpis">
                <Kpi label={t("branch.usage.salesOrders")} value={f.number(usage.sales.orders)} hint={t("branch.usage.salesRange", { from: usage.sales.from, to: usage.sales.to })} to={branch.links.sales} />
                <Kpi label={t("branch.usage.salesTotal")} value={<Money iqd={usage.sales.totalIqd} />} />
              </div>
            ) : (
              <p className="type-caption text-ink-2">{t("branch.usage.needs", { permission: "orders.order.read" })}</p>
            )}
            <p className="type-caption text-ink-2">{t("branch.usage.delivery")}</p>
          </Section>
        </div>
      </div>
    </>
  );
}

function UsageList({ id, title, rows, link, permission, empty }: { id: string; title: string; rows: { id: string; label: string; tone: "ok" | "info" | "out"; state: string }[] | null; link: string | null; permission: string; empty: string }) {
  const t = useChT();
  return (
    <Section
      id={id}
      title={title}
      aside={
        link ? (
          <Link to={link} className="adm-link type-label">
            {t("branch.usage.open")}
          </Link>
        ) : null
      }
    >
      {rows === null ? (
        <p className="type-caption text-ink-2">{t("branch.usage.needs", { permission })}</p>
      ) : rows.length === 0 ? (
        <p className="type-caption text-ink-2">{empty}</p>
      ) : (
        <ul role="list" className="ch-list adm-card">
          {rows.map((row) => (
            <li key={row.id}>
              <span className="type-data min-w-0">{row.label}</span>
              <StatusText tone={row.tone}>{row.state}</StatusText>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
