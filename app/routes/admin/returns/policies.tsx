import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/policies";
import { Icon } from "~/art/Icon";
import { throwAsResponse } from "~/server/errors";
import { listPolicies, savePolicy } from "~/server/services/admin/returns/policy.server";
import { parseWhole, PRODUCT_KIND_SCOPE_LIST, type PolicyView } from "~/server/services/admin/returns/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { returnsMeta } from "./meta";
import { checked, failed, openReturns, text } from "./returns.server";
import { Failure, Section, useReturnsT } from "./ui";

/**
 * /admin/returns/policies — return eligibility rules (12.02): by product kind, category (and its subcategories) and new
 * or used; the window from delivery (empty = the general setting `returns.window_days`), the seal requirement for
 * change-of-mind returns and a restocking fee. Rules are switched off, never deleted, so old verdicts stay explainable.
 * Editing is ?edit=<id> / ?new=1 (URL state, works without JavaScript); saving needs returns.policy.manage and a reason.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openReturns(context, ["returns.rma.read", "returns.rma.create", "returns.policy.manage"]);
  const url = new URL(request.url);
  try {
    const data = await listPolicies(db, actor, locale);
    const editId = url.searchParams.get("edit");
    const editing = data.canManage ? (editId ? (data.rules.find((rule) => rule.id === editId) ?? null) : null) : null;
    return { ...data, editing, creating: data.canManage && url.searchParams.get("new") === "1", saved: url.searchParams.get("saved") === "1" };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openReturns(context, "returns.policy.manage");
  const form = await request.formData();
  try {
    const window = parseWhole(text(form, "windowDays"));
    const fee = parseWhole(text(form, "feePct"));
    await savePolicy(
      db,
      actor,
      {
        id: text(form, "id") || undefined,
        productKind: (text(form, "productKind") || "*") as never,
        categoryId: text(form, "categoryId") || undefined,
        itemCondition: (text(form, "itemCondition") || "*") as never,
        isReturnable: checked(form, "isReturnable"),
        windowDays: window === undefined ? null : window,
        requiresSealed: checked(form, "requiresSealed"),
        restockingFeeBps: fee === undefined ? 0 : Number.isFinite(fee) ? fee * 100 : Number.NaN,
        note: { ar: text(form, "note.ar") || undefined, en: text(form, "note.en") || undefined, ckb: text(form, "note.ckb") || undefined },
        sort: parseWhole(text(form, "sort")) ?? 0,
        isActive: checked(form, "isActive"),
        reason: text(form, "reason"),
      },
      now,
    );
    throw redirect("/admin/returns/policies?saved=1");
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "save");
  }
}

export const meta: Route.MetaFunction = (args) => returnsMeta(args, "policies.title");

export default function Policies({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const { rules, windowDays, canManage, editing, creating, saved } = loaderData;
  const kindLabel = (kind: string) => t(`productKind.${kind === "*" ? "all" : kind}`);
  const scopeLabel = (scope: string) => t(`itemScope.${scope === "*" ? "all" : scope}`);
  const columns: DataColumn<PolicyView>[] = [
    { key: "kind", header: t("policies.col.kind"), cell: (rule) => kindLabel(rule.productKind) },
    { key: "category", header: t("policies.col.category"), cell: (rule) => rule.categoryName ?? t("policies.anyCategory") },
    { key: "condition", header: t("policies.col.condition"), cell: (rule) => scopeLabel(rule.itemCondition) },
    { key: "returnable", header: t("policies.col.returnable"), cell: (rule) => (rule.isReturnable ? t("yes") : t("no")) },
    { key: "window", header: t("policies.col.window"), cell: (rule) => (rule.windowDays === null ? t("policies.settingWindow") : t("policies.days", { count: rule.windowDays })) },
    { key: "sealed", header: t("policies.col.sealed"), cell: (rule) => (rule.requiresSealed ? t("yes") : t("no")) },
    { key: "fee", header: t("policies.col.fee"), numeric: true, cell: (rule) => <bdi className="nums">{`${rule.restockingFeeBps / 100}%`}</bdi> },
    { key: "state", header: t("policies.col.state"), cell: (rule) => <Status tone={rule.isActive ? "ok" : "neutral"}>{rule.isActive ? t("policies.active") : t("policies.inactive")}</Status> },
    ...(canManage
      ? [
          {
            key: "edit",
            header: <span className="sr-only">{t("policies.edit")}</span>,
            cell: (rule: PolicyView) => (
              <Link to={`/admin/returns/policies?edit=${encodeURIComponent(rule.id)}`} className="adm-link">
                {t("policies.edit")}
              </Link>
            ),
          } satisfies DataColumn<PolicyView>,
        ]
      : []),
  ];
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("policies.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("policies.lead")}</p>
      </header>

      <section className="adm-card" aria-labelledby="policy-window">
        <h2 id="policy-window" className="adm-h3">
          {t("policies.window", { days: windowDays })}
        </h2>
        <p className="type-caption text-ink-2">{t("policies.windowHint")}</p>
      </section>

      {saved ? (
        <p role="status" className="flex items-center gap-1 type-body">
          <Icon name="check-circle" size={18} className="text-ok" />
          {t("done.policy")}
        </p>
      ) : null}

      <Section
        id="policy-rules"
        title={t("policies.rules")}
        action={
          canManage && !creating && !editing ? (
            <Key as={Link} to="/admin/returns/policies?new=1" size="sm" icon="plus">
              {t("policies.new")}
            </Key>
          ) : undefined
        }
      >
        {rules.length === 0 ? (
          <EmptyState title={t("policies.empty")} text={t("policies.emptyHint")} icon="scales" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("policies.rules")} columns={columns} rows={rules} rowKey={(rule) => rule.id} maxHeight={null} />
            </div>
            <ul className="ret-cards md:hidden" aria-label={t("policies.rules")}>
              {rules.map((rule) => (
                <li key={rule.id} className="ret-card">
                  <span className="ret-card__top">
                    <span className="type-strong">
                      {kindLabel(rule.productKind)} · {rule.categoryName ?? t("policies.anyCategory")}
                    </span>
                    <Status tone={rule.isActive ? "ok" : "neutral"}>{rule.isActive ? t("policies.active") : t("policies.inactive")}</Status>
                  </span>
                  <span className="type-caption text-ink-2">
                    {scopeLabel(rule.itemCondition)} · {rule.isReturnable ? (rule.windowDays === null ? t("policies.settingWindow") : t("policies.days", { count: rule.windowDays })) : t("eligibility.problems.not_returnable")}
                    {rule.requiresSealed ? ` · ${t("policies.col.sealed")}` : ""}
                    {rule.restockingFeeBps ? ` · ${t("eligibility.fee", { percent: `${rule.restockingFeeBps / 100}%` })}` : ""}
                  </span>
                  {canManage ? (
                    <Link to={`/admin/returns/policies?edit=${encodeURIComponent(rule.id)}`} className="adm-link type-caption">
                      {t("policies.edit")}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          </>
        )}
        {!canManage ? (
          <p className="flex items-center gap-1 type-caption text-ink-2">
            <Icon name="lock" size={14} />
            {t("policies.readOnly")}
          </p>
        ) : null}
      </Section>

      {canManage && (creating || editing) ? <PolicyForm key={editing?.id ?? "new"} rule={editing} categories={loaderData.categories} /> : null}
    </>
  );
}

function PolicyForm({ rule, categories }: { rule: PolicyView | null; categories: { id: string; name: string }[] }) {
  const t = useReturnsT();
  const navigation = useNavigation();
  const result = useActionData<typeof action>();
  const failure = result && "ok" in result && !result.ok ? result : null;
  const f = failure?.fields ?? {};
  return (
    <section className="adm-section" aria-labelledby="policy-form">
      <h2 id="policy-form" className="adm-h2">
        {rule ? t("policies.form.editTitle") : t("policies.form.title")}
      </h2>
      <Form method="post" className="grid gap-3 md:grid-cols-2" noValidate>
        {rule ? <input type="hidden" name="id" value={rule.id} /> : null}
        <Select name="productKind" label={t("policies.form.kind")} defaultValue={rule?.productKind ?? "*"} options={PRODUCT_KIND_SCOPE_LIST.map((kind) => ({ value: kind, label: t(`productKind.${kind === "*" ? "all" : kind}`) }))} error={f.productKind} />
        <Select name="categoryId" label={t("policies.form.category")} hint={t("policies.form.categoryHint")} defaultValue={rule?.categoryId ?? ""} options={[{ value: "", label: t("policies.anyCategory") }, ...categories.map((cat) => ({ value: cat.id, label: cat.name }))]} error={f.categoryId} />
        <Select name="itemCondition" label={t("policies.form.condition")} defaultValue={rule?.itemCondition ?? "*"} options={(["*", "new", "used"] as const).map((scope) => ({ value: scope, label: t(`itemScope.${scope === "*" ? "all" : scope}`) }))} error={f.itemCondition} />
        <TextField name="windowDays" label={t("policies.form.window")} hint={t("policies.form.windowHint")} inputMode="numeric" defaultValue={rule?.windowDays === null || rule === null ? "" : String(rule.windowDays)} ltr error={f.windowDays} />
        <TextField name="feePct" label={t("policies.form.fee")} hint={t("policies.form.feeHint")} inputMode="numeric" defaultValue={rule ? String(rule.restockingFeeBps / 100) : "0"} ltr error={f.restockingFeeBps} />
        <TextField name="sort" label={t("policies.form.sort")} inputMode="numeric" defaultValue={rule ? String(rule.sort) : "0"} ltr error={f.sort} />
        <div className="grid gap-2 md:col-span-2">
          <Checkbox name="isReturnable" value="1" label={t("policies.form.returnable")} defaultChecked={rule?.isReturnable ?? true} />
          <Checkbox name="requiresSealed" value="1" label={t("policies.form.sealed")} hint={t("policies.form.sealedHint")} defaultChecked={rule?.requiresSealed ?? false} />
          <Checkbox name="isActive" value="1" label={t("policies.form.active")} defaultChecked={rule?.isActive ?? true} />
        </div>
        <TextField name="note.ar" label={t("policies.form.noteAr")} defaultValue={rule?.note?.ar ?? ""} error={f["note.ar"]} />
        <TextField name="note.en" label={t("policies.form.noteEn")} defaultValue={rule?.note?.en ?? ""} ltr error={f["note.en"]} />
        <TextField name="note.ckb" label={t("policies.form.noteCkb")} defaultValue={rule?.note?.ckb ?? ""} error={f["note.ckb"]} />
        <TextField name="reason" label={t("policies.form.reason")} hint={t("policies.form.reasonHint")} required error={f.reason} />
        <div className="grid gap-2 md:col-span-2">
          <Failure message={failure ? (failure.message ?? t(`errors.${failure.code}`)) : null} />
          <div className="ret-actions">
            <Key type="submit" variant="ink" icon="floppy-disk" loading={navigation.state === "submitting"}>
              {t("policies.form.save")}
            </Key>
            <Key as={Link} to="/admin/returns/policies">
              {t("policies.cancelEdit")}
            </Key>
          </div>
        </div>
      </Form>
    </section>
  );
}
