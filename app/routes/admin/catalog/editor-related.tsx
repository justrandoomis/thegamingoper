import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/editor-related";
import { can } from "~/server/actor";
import { addRelation, getRelations, removeRelation, updateRelation } from "~/server/services/admin/catalog/relations.server";
import type { RelationView } from "~/server/services/admin/catalog/relations.server";
import { RELATION_KIND_LIST } from "~/server/services/admin/catalog/rules";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { answered, catalogRequest, formObject, runIntent } from "./catalog.server";
import { FailureNotice, StatusBadge, isFailure, useAnswerToast, useCatalogT, useFieldError, useKindLabel } from "./components/ui";

/**
 * /admin/catalog/products/:id/related — editorial links (02.08, catalog.relation.manage): accessories, step-up
 * (upsell), alternatives, upgrades and "complete your setup", pinned and ordered; the products that point here; and
 * compatible accessories not linked yet, from the compatibility rules on this product's device. Links hold product
 * ids (typed or scanned as slug, SKU or barcode), never names.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(context, "catalog.product.read");
  return { view: await answered(getRelations(db, actor, params.id, locale)), can: { manage: can(actor, "catalog.relation.manage") } };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.relation.manage");
  const form = formObject(await request.formData());
  const base = { ...form, productId: params.id };
  return runIntent(req, form.intent, {
    add: async () => addRelation(req.db, req.actor, base, req.now),
    update: async () => {
      await updateRelation(req.db, req.actor, base, req.now);
      return {};
    },
    remove: async () => removeRelation(req.db, req.actor, base, req.now),
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.catalog"));

export default function ProductRelated({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const kindLabel = useKindLabel();
  const { view, can: allowed } = loaderData;
  const [removing, setRemoving] = useState<RelationView | null>(null);
  const remove = useFetcher<typeof action>({ key: `catalog-relation-remove-${view.productId}` });
  const add = useFetcher<typeof action>({ key: `catalog-relation-add-${view.productId}` });
  const addError = useFieldError(add.data);
  useAnswerToast(remove, t("related.saved"));
  useAnswerToast(add, t("related.saved"));
  useEffect(() => {
    if (remove.state === "idle" && remove.data && !isFailure(remove.data)) setRemoving(null);
  }, [remove.state, remove.data]);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (add.state === "idle" && add.data && !isFailure(add.data)) setRound((value) => value + 1);
  }, [add.state, add.data]);

  return (
    <div className="grid gap-8">
      <section className="adm-section mb-0" aria-labelledby="related-title">
        <div className="grid gap-1">
          <h2 id="related-title" className="adm-h2">
            {t("related.title")}
          </h2>
          <p className="max-w-[70ch] type-caption text-ink-2">{t("related.lead")}</p>
        </div>
        {view.outgoing.length === 0 ? <EmptyState icon="link" title={t("related.empty")} /> : null}
        {RELATION_KIND_LIST.map((kind) => {
          const rows = view.outgoing.filter((row) => row.kind === kind);
          if (rows.length === 0) return null;
          return (
            <div key={kind} className="grid gap-2">
              <h3 className="adm-h3">{t(`related.kinds.${kind}`)}</h3>
              <ol className="grid gap-1.5">
                {rows.map((row, index) => (
                  <RelationRow key={row.relatedProductId} row={row} first={index === 0} last={index === rows.length - 1} canManage={allowed.manage} onRemove={() => setRemoving(row)} />
                ))}
              </ol>
            </div>
          );
        })}
      </section>

      {allowed.manage ? (
        <section className="adm-card" aria-labelledby="related-add">
          <h2 id="related-add" className="adm-h3">
            {t("related.add")}
          </h2>
          <add.Form key={round} method="post" className="grid items-end gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto_auto]">
            <input type="hidden" name="intent" value="add" />
            <TextField name="related" label={t("related.target")} ltr required autoComplete="off" maxLength={128} error={addError("related")} />
            <Select name="kind" label={t("related.kind")} defaultValue="accessory" options={RELATION_KIND_LIST.map((value) => ({ value, label: t(`related.kinds.${value}`) }))} />
            <Checkbox name="pinned" label={t("related.pinned")} className="self-center" />
            <Key type="submit" icon="link" loading={add.state !== "idle"} className="self-center">
              {t("related.add")}
            </Key>
          </add.Form>
          {isFailure(add.data) && !add.data.fields ? <FailureNotice result={add.data} /> : null}
        </section>
      ) : null}

      <section className="adm-section mb-0" aria-labelledby="related-suggestions">
        <div className="grid gap-1">
          <h2 id="related-suggestions" className="adm-h2">
            {t("related.suggestions")}
          </h2>
          <p className="type-caption text-ink-2">{t("related.suggestionsLead")}</p>
        </div>
        {view.suggestions.length === 0 ? (
          <p className="type-caption text-ink-2">{t("related.noSuggestions")}</p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {view.suggestions.map((suggestion) => (
              <li key={suggestion.productId} className="adm-card flex flex-row items-center justify-between gap-3 py-2">
                <span className="grid min-w-0 gap-0.5">
                  <Link to={`/admin/catalog/products/${suggestion.productId}`} className="adm-link truncate">
                    {suggestion.name}
                  </Link>
                  <span className="type-caption text-ink-2">
                    {kindLabel(suggestion.kind)} · <Status tone={suggestion.status === "verified" ? "ok" : "warn"}>{t(`compat.statuses.${suggestion.status}`)}</Status>
                  </span>
                </span>
                {allowed.manage ? (
                  <add.Form method="post">
                    <input type="hidden" name="intent" value="add" />
                    <input type="hidden" name="related" value={suggestion.slug} />
                    <input type="hidden" name="kind" value="accessory" />
                    <Key type="submit" size="sm" icon="plus" disabled={add.state !== "idle"}>
                      {t("related.link")}
                    </Key>
                  </add.Form>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="adm-section mb-0" aria-labelledby="related-incoming">
        <h2 id="related-incoming" className="adm-h2">
          {t("related.incoming")}
        </h2>
        {view.incoming.length === 0 ? (
          <p className="type-caption text-ink-2">{t("related.incomingEmpty")}</p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {view.incoming.map((row) => (
              <li key={`${row.relatedProductId}-${row.kind}`} className="flex flex-wrap items-center gap-2">
                <Link to={`/admin/catalog/products/${row.relatedProductId}/related`} className="adm-link">
                  {row.name}
                </Link>
                <span className="type-caption text-ink-2">· {t(`related.kinds.${row.kind}`)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="destructive"
        title={removing ? t("related.removeQ", { name: removing.name }) : ""}
        consequence={t("related.removeDo")}
        confirmLabel={t("related.remove")}
        cancelLabel={t("common.cancel")}
        reason={{ label: t("common.reason"), hint: t("common.reasonHint") }}
        pending={remove.state !== "idle"}
        error={isFailure(remove.data) ? <FailureNotice result={remove.data} /> : undefined}
        onConfirm={({ reason }) => removing && remove.submit({ intent: "remove", relatedProductId: removing.relatedProductId, kind: removing.kind, reason }, { method: "post" })}
      />
    </div>
  );
}

function RelationRow({ row, first, last, canManage, onRemove }: { row: RelationView; first: boolean; last: boolean; canManage: boolean; onRemove: () => void }) {
  const t = useCatalogT();
  const fetcher = useFetcher<typeof action>({ key: `catalog-relation-${row.relatedProductId}-${row.kind}` });
  const send = (fields: Record<string, string>) => fetcher.submit({ intent: "update", relatedProductId: row.relatedProductId, kind: row.kind, pinned: String(row.pinned), ...fields }, { method: "post" });
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-1.5" aria-busy={fetcher.state !== "idle" || undefined}>
      <span className="flex min-w-0 flex-wrap items-center gap-2">
        <Link to={`/admin/catalog/products/${row.relatedProductId}`} className="adm-link">
          {row.name}
        </Link>
        <StatusBadge status={row.status} />
        {row.pinned ? <span className="rounded-xs border border-line px-1.5 type-caption">{t("related.pinned")}</span> : null}
      </span>
      {canManage ? (
        <span className="flex items-center gap-1">
          <Key size="sm" held={row.pinned} onClick={() => send({ pinned: String(!row.pinned) })}>
            {t("related.pinned")}
          </Key>
          <IconKey size="sm" icon="arrow-up" label={t("common.moveUp")} disabled={first} onClick={() => send({ direction: "up" })} />
          <IconKey size="sm" icon="arrow-down" label={t("common.moveDown")} disabled={last} onClick={() => send({ direction: "down" })} />
          <IconKey size="sm" icon="trash" label={t("related.remove")} onClick={onRemove} />
        </span>
      ) : null}
    </li>
  );
}
