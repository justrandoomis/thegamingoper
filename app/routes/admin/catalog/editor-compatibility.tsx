import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/editor-compatibility";
import { useFormat } from "~/i18n/react";
import { deleteCompatibilityRule, getProductCompatibility, saveCompatibilityRule } from "~/server/services/admin/catalog/compatibility.server";
import type { RuleView, TargetOption } from "~/server/services/admin/catalog/compatibility.server";
import { COMPAT_STATUS_LIST } from "~/server/services/admin/catalog/rules";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Sheet } from "~/ui/Sheet";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { answered, catalogRequest, formObject, runIntent } from "./catalog.server";
import { COMPAT_TONE, FailureNotice, L10nFields, isFailure, useAnswerToast, useCatalogT, useFieldError } from "./components/ui";

/**
 * /admin/catalog/products/:id/compatibility — the product's compatibility rules (02.10, catalog.compatibility.manage):
 * verified (source + catalog.compatibility.verify, the verifier recorded), partial (written condition), incompatible
 * (written reason), unverified. One rule per product/variant and device, generation or platform. A live product that
 * must show compatibility keeps at least one verified or partial rule.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(context, "catalog.product.read");
  return { view: await answered(getProductCompatibility(db, actor, params.id, locale)) };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.compatibility.manage");
  const form = formObject(await request.formData());
  const base = { ...form, productId: params.id };
  return runIntent(req, form.intent, {
    save: async () => saveCompatibilityRule(req.db, req.actor, base, req.now),
    delete: async () => deleteCompatibilityRule(req.db, req.actor, base, req.now),
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.catalog"));

export default function ProductCompatibility({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const { view } = loaderData;
  const [editing, setEditing] = useState<RuleView | "new" | null>(null);
  const [removing, setRemoving] = useState<RuleView | null>(null);
  const remove = useFetcher<typeof action>({ key: `catalog-compat-remove-${view.productId}` });
  useAnswerToast(remove, t("compat.saved"));
  useEffect(() => {
    if (remove.state === "idle" && remove.data && !isFailure(remove.data)) setRemoving(null);
  }, [remove.state, remove.data]);

  return (
    <section className="adm-section" aria-labelledby="compat-title">
      <div className="adm-section__head">
        <div className="grid gap-1">
          <h2 id="compat-title" className="adm-h2">
            {t("compat.title")}
          </h2>
          <p className="max-w-[70ch] type-caption text-ink-2">{t("compat.lead")}</p>
          {view.canManage && !view.canVerify ? <p className="type-caption text-ink-2">{t("compat.cannotVerify")}</p> : null}
        </div>
        <span className="flex flex-wrap gap-2">
          <Key as={Link} to="/admin/catalog/compare" variant="quiet" icon="scales">
            {t("compat.compareLink")}
          </Key>
          {view.canManage ? (
            <Key variant="ink" icon="plus" onClick={() => setEditing("new")}>
              {t("compat.add")}
            </Key>
          ) : null}
        </span>
      </div>

      {view.rules.length === 0 ? (
        <EmptyState icon="question" title={t("compat.empty")} />
      ) : (
        <ul className="grid gap-2">
          {view.rules.map((rule) => (
            <li key={rule.id} className="adm-card gap-1.5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="grid min-w-0 gap-0.5">
                  <span className="type-strong text-ink">{rule.targetLabel}</span>
                  <span className="type-caption text-ink-2">
                    {t("compat.subject")}: {rule.subjectType === "product" ? t("compat.subjectProduct") : <bdi dir="ltr">{rule.subjectLabel}</bdi>}
                  </span>
                </div>
                <Status tone={COMPAT_TONE[rule.status]}>{t(`compat.statuses.${rule.status}`)}</Status>
              </div>
              {rule.noteText ? <p className="type-body text-ink">{rule.noteText}</p> : null}
              <p className="flex flex-wrap gap-x-3 gap-y-1 type-caption text-ink-2">
                {rule.source ? (
                  <span>
                    {t("compat.source")}: <bdi dir="auto">{rule.source}</bdi>
                  </span>
                ) : null}
                {rule.status === "verified" && rule.verifiedAt ? <span>{rule.verifiedBy ? t("compat.verifiedBy", { name: rule.verifiedBy, time: f.date(rule.verifiedAt) }) : t("compat.verifiedImported", { time: f.date(rule.verifiedAt) })}</span> : null}
              </p>
              {view.canManage ? (
                <div className="flex gap-2">
                  <Key size="sm" icon="pencil-simple" onClick={() => setEditing(rule)}>
                    {t("common.edit")}
                  </Key>
                  <Key size="sm" icon="trash" className="[--on:var(--red-ink)]" onClick={() => setRemoving(rule)}>
                    {t("compat.remove")}
                  </Key>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <RuleSheet key={editing === "new" ? "new" : (editing?.id ?? "none")} productId={view.productId} rule={editing} variants={view.variants} targets={view.targets} canVerify={view.canVerify} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="destructive"
        title={removing ? t("compat.removeQ", { target: removing.targetLabel }) : ""}
        consequence={t("compat.removeDo")}
        confirmLabel={t("compat.remove")}
        cancelLabel={t("common.cancel")}
        reason={{ label: t("common.reason"), hint: t("common.reasonHint") }}
        pending={remove.state !== "idle"}
        error={isFailure(remove.data) ? <FailureNotice result={remove.data} /> : undefined}
        onConfirm={({ reason }) => removing && remove.submit({ intent: "delete", id: removing.id, reason }, { method: "post" })}
      />
    </section>
  );
}

type RuleSheetProps = { productId: string; rule: RuleView | "new" | null; variants: { id: string; sku: string }[]; targets: TargetOption[]; canVerify: boolean; onClose: () => void };

function RuleSheet({ productId, rule, variants, targets, canVerify, onClose }: RuleSheetProps) {
  const t = useCatalogT();
  const fetcher = useFetcher<typeof action>({ key: `catalog-compat-save-${productId}` });
  const fieldError = useFieldError(fetcher.data);
  useAnswerToast(fetcher, t("compat.saved"));
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !isFailure(fetcher.data)) onClose();
  }, [fetcher.state, fetcher.data, onClose]);
  const current = rule === "new" ? null : rule;
  const formId = `compat-form-${current?.id ?? "new"}`;
  return (
    <Sheet
      open={rule !== null}
      onClose={onClose}
      presentation="side"
      title={current ? current.targetLabel : t("compat.add")}
      footer={
        <>
          <Key onClick={onClose} disabled={fetcher.state !== "idle"}>
            {t("common.cancel")}
          </Key>
          <Key type="submit" form={formId} variant="ink" icon="floppy-disk" loading={fetcher.state !== "idle"}>
            {t("compat.save")}
          </Key>
        </>
      }
    >
      <fetcher.Form id={formId} method="post" noValidate className="grid gap-4">
        <input type="hidden" name="intent" value="save" />
        {current ? <input type="hidden" name="id" value={current.id} /> : null}
        <Select name="subject" label={t("compat.subject")} defaultValue={current?.subjectType === "variant" ? current.subjectId : "product"} options={[{ value: "product", label: t("compat.subjectProduct") }, ...variants.map((variant) => ({ value: variant.id, label: variant.sku }))]} error={fieldError("subject")} />
        <Select
          name="target"
          label={t("compat.target")}
          required
          defaultValue={current ? `${current.targetType}:${current.targetId}` : ""}
          options={[{ value: "", label: t("compat.targetPick") }, ...targets.map((target) => ({ value: `${target.type}:${target.id}`, label: target.label }))]}
          error={fieldError("target")}
        />
        <Select
          name="status"
          label={t("compat.statusField")}
          defaultValue={current?.status ?? (canVerify ? "verified" : "partial")}
          options={COMPAT_STATUS_LIST.map((status) => ({ value: status, label: t(`compat.statuses.${status}`), disabled: status === "verified" && !canVerify }))}
          error={fieldError("status")}
        />
        <L10nFields name="note" label={t("compat.note")} value={current?.note ?? null} hint={t("compat.noteHint")} maxLength={500} multiline rows={2} error={fieldError} />
        <TextField name="source" label={t("compat.source")} hint={t("compat.sourceHint")} defaultValue={current?.source ?? ""} maxLength={500} error={fieldError("source")} />
        <TextField name="reason" label={t("common.reasonOptional")} maxLength={500} />
        {isFailure(fetcher.data) ? <FailureNotice result={fetcher.data} /> : null}
      </fetcher.Form>
    </Sheet>
  );
}
