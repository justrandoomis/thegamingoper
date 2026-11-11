import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/category-tree";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { deleteCategory, getCategoryTree, moveCategory, saveCategory } from "~/server/services/admin/catalog/taxonomy.server";
import type { CategoryNodeAdmin } from "~/server/services/admin/catalog/taxonomy.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Sheet } from "~/ui/Sheet";
import { adminMeta } from "../shell/meta";
import { catalogRequest, formObject, runIntent } from "./catalog.server";
import { FailureNotice, L10nFields, isFailure, useAnswerToast, useCatalogT, useFieldError } from "./components/ui";

/**
 * /admin/catalog/categories — the category tree (02.02, catalog.category.manage): up to four levels, order among
 * siblings, names in three languages, the navigation group, switching a category off (its published products stay
 * published — the page says how many), deleting only an empty category. Everyone with catalog.product.read sees it.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(context, "catalog.product.read");
  return { tree: await getCategoryTree(db, actor, locale), can: { manage: can(actor, "catalog.category.manage") } };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.category.manage");
  const form = formObject(await request.formData());
  return runIntent(req, form.intent, {
    save: async () => saveCategory(req.db, req.actor, form, req.now),
    move: async () => {
      await moveCategory(req.db, req.actor, form, req.now);
      return {};
    },
    delete: async () => {
      await deleteCategory(req.db, req.actor, form, req.now);
      return {};
    },
  });
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("categories.title"));

type Editing = { node: CategoryNodeAdmin | null; parentId: string | null } | null;

export default function Categories({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const { tree, can: allowed } = loaderData;
  const [editing, setEditing] = useState<Editing>(null);
  const [removing, setRemoving] = useState<CategoryNodeAdmin | null>(null);
  const remove = useFetcher<typeof action>({ key: "catalog-category-remove" });
  useAnswerToast(remove, t("categories.saved"));
  useEffect(() => {
    if (remove.state === "idle" && remove.data && !isFailure(remove.data)) setRemoving(null);
  }, [remove.state, remove.data]);

  return (
    <>
      <header className="adm-page-head">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="adm-title">{t("categories.title")}</h1>
          {allowed.manage ? (
            <Key variant="ink" icon="plus" onClick={() => setEditing({ node: null, parentId: null })}>
              {t("categories.add")}
            </Key>
          ) : null}
        </div>
        <p className="max-w-[70ch] type-body text-ink-2">{t("categories.lead")}</p>
        {!allowed.manage ? <p className="adm-notice">{t("categories.cannotManage")}</p> : null}
      </header>

      {tree.roots.length === 0 ? (
        <EmptyState icon="stack" title={t("categories.empty")} />
      ) : (
        <ul aria-label={t("categories.title")} className="grid gap-1">
          {tree.roots.map((node, index) => (
            <CategoryNode key={node.id} node={node} first={index === 0} last={index === tree.roots.length - 1} canManage={allowed.manage} onEdit={(target, parentId) => setEditing({ node: target, parentId })} onRemove={setRemoving} />
          ))}
        </ul>
      )}

      <CategorySheet key={editing ? (editing.node?.id ?? `new-${editing.parentId ?? "root"}`) : "none"} editing={editing} flat={tree.flat} onClose={() => setEditing(null)} />

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="destructive"
        title={removing ? t("categories.removeQ", { name: removing.label }) : ""}
        consequence={t("categories.removeDo")}
        confirmLabel={t("categories.remove")}
        cancelLabel={t("common.cancel")}
        reason={{ label: t("common.reason"), hint: t("common.reasonHint") }}
        pending={remove.state !== "idle"}
        error={isFailure(remove.data) ? <FailureNotice result={remove.data} /> : undefined}
        onConfirm={({ reason }) => removing && remove.submit({ intent: "delete", id: removing.id, reason }, { method: "post" })}
      />
    </>
  );
}

type NodeProps = {
  node: CategoryNodeAdmin;
  first: boolean;
  last: boolean;
  canManage: boolean;
  onEdit: (node: CategoryNodeAdmin | null, parentId: string | null) => void;
  onRemove: (node: CategoryNodeAdmin) => void;
};

function CategoryNode({ node, first, last, canManage, onEdit, onRemove }: NodeProps) {
  const t = useCatalogT();
  const f = useFormat();
  const move = useFetcher<typeof action>({ key: `catalog-category-move-${node.id}` });
  const empty = node.subtreeProducts === 0 && node.children.length === 0;
  return (
    <li className="grid gap-1">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xs border border-line bg-paper px-3 py-2" style={{ marginInlineStart: `${node.depth * 1.5}rem` }}>
        <div className="grid min-w-0 gap-0.5">
          <span className="flex flex-wrap items-center gap-2">
            <span className="type-strong text-ink">{node.label}</span>
            {!node.isActive ? <span className="rounded-xs border border-line px-1.5 type-caption text-warn">{t("categories.inactiveTag")}</span> : null}
          </span>
          <span className="flex flex-wrap gap-x-3 gap-y-0.5 type-caption text-ink-2">
            <bdi dir="ltr">{node.slug}</bdi>
            <span>
              {t("categories.kindField")}: <bdi dir="ltr">{node.kind}</bdi>
            </span>
            <Link to={`/admin/catalog?category=${node.id}`} className="adm-link">
              {t("categories.products", { count: node.products })}
            </Link>
            {node.children.length > 0 ? <span className="nums">{t("categories.subtree", { count: f.number(node.subtreeProducts) })}</span> : null}
          </span>
        </div>
        {canManage ? (
          <span className="flex flex-wrap items-center gap-1" aria-busy={move.state !== "idle" || undefined}>
            {node.depth < 3 ? (
              <Key size="sm" icon="plus" onClick={() => onEdit(null, node.id)}>
                {t("categories.addChild")}
              </Key>
            ) : null}
            <IconKey size="sm" icon="pencil-simple" label={`${t("categories.edit")} ${node.label}`} onClick={() => onEdit(node, node.parentId)} />
            <IconKey size="sm" icon="arrow-up" label={t("common.moveUp")} disabled={first || move.state !== "idle"} onClick={() => move.submit({ intent: "move", id: node.id, direction: "up" }, { method: "post" })} />
            <IconKey size="sm" icon="arrow-down" label={t("common.moveDown")} disabled={last || move.state !== "idle"} onClick={() => move.submit({ intent: "move", id: node.id, direction: "down" }, { method: "post" })} />
            <IconKey size="sm" icon="trash" label={`${t("categories.remove")} ${node.label}`} disabled={!empty} onClick={() => onRemove(node)} />
          </span>
        ) : null}
      </div>
      {node.children.length > 0 ? (
        <ul className="grid gap-1">
          {node.children.map((child, index) => (
            <CategoryNode key={child.id} node={child} first={index === 0} last={index === node.children.length - 1} canManage={canManage} onEdit={onEdit} onRemove={onRemove} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** Active categories below a node (they leave the store's menus with it). */
function activeBelow(node: CategoryNodeAdmin): number {
  return node.children.reduce((sum, child) => sum + (child.isActive ? 1 : 0) + activeBelow(child), 0);
}

function CategorySheet({ editing, flat, onClose }: { editing: Editing; flat: CategoryNodeAdmin[]; onClose: () => void }) {
  const t = useCatalogT();
  const f = useFormat();
  const fetcher = useFetcher<typeof action>({ key: "catalog-category-save" });
  const fieldError = useFieldError(fetcher.data);
  useAnswerToast(fetcher, t("categories.saved"));
  const node = editing?.node ?? null;
  const [active, setActive] = useState(node?.isActive ?? true);
  // Switching off a category with products on sale or scheduled under it needs a reason: the save asks for it in a
  // confirmation that shows what leaves the store (the service refuses it without one: reason_required).
  const deactivating = Boolean(node?.isActive) && !active && (node?.subtreeLive ?? 0) > 0;
  const [confirming, setConfirming] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  // Each answer is handled once (an answer kept from an earlier sheet is not this sheet's): success closes the sheet; a
  // failure closes the confirmation, so the sheet's field errors are in view.
  const handled = useRef<unknown>(fetcher.data);
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || handled.current === fetcher.data) return;
    handled.current = fetcher.data;
    setConfirming(false);
    if (!isFailure(fetcher.data)) onClose();
  }, [fetcher.state, fetcher.data, onClose]);
  // A category cannot move under itself or its own branch.
  const branch = new Set<string>();
  if (node) {
    const walk = (entry: CategoryNodeAdmin) => {
      branch.add(entry.id);
      entry.children.forEach(walk);
    };
    walk(node);
  }
  const kinds = [...new Set(flat.map((entry) => entry.kind))];
  const formId = `category-form-${node?.id ?? "new"}`;
  return (
    <Sheet
      open={editing !== null}
      onClose={onClose}
      presentation="side"
      title={node ? t("categories.edit") : t("categories.add")}
      description={node ? node.label : undefined}
      footer={
        <>
          <Key onClick={onClose} disabled={fetcher.state !== "idle"}>
            {t("common.cancel")}
          </Key>
          <Key type="submit" form={formId} variant="ink" icon="floppy-disk" loading={fetcher.state !== "idle"}>
            {t("common.saveShort")}
          </Key>
        </>
      }
    >
      <fetcher.Form
        ref={formRef}
        id={formId}
        method="post"
        noValidate
        className="grid gap-4"
        onSubmit={(event) => {
          if (!deactivating) return;
          event.preventDefault();
          setConfirming(true);
        }}
      >
        <input type="hidden" name="intent" value="save" />
        {node ? <input type="hidden" name="id" value={node.id} /> : null}
        <L10nFields name="name" label={t("categories.name")} value={node?.name ?? null} required maxLength={120} error={fieldError} />
        <TextField name="slug" label={t("categories.slug")} defaultValue={node?.slug ?? ""} required ltr maxLength={80} hint={t("newProduct.slugHint")} error={fieldError("slug")} />
        <Select
          name="parentId"
          label={t("categories.parent")}
          defaultValue={editing?.parentId ?? ""}
          options={[{ value: "", label: t("categories.root") }, ...flat.filter((entry) => !branch.has(entry.id)).map((entry) => ({ value: entry.id, label: `${"— ".repeat(entry.depth)}${entry.label}` }))]}
          error={fieldError("parentId")}
        />
        <TextField name="kind" label={t("categories.kindField")} hint={t("categories.kindHint")} defaultValue={node?.kind ?? ""} list="catalog-category-kinds" ltr maxLength={40} error={fieldError("kind")} />
        <datalist id="catalog-category-kinds">
          {kinds.map((kind) => (
            <option key={kind} value={kind} />
          ))}
        </datalist>
        <L10nFields name="description" label={t("categories.description")} value={node?.description ?? null} multiline rows={3} maxLength={1000} error={fieldError} />
        <Checkbox name="isActive" label={t("categories.active")} checked={active} onChange={(event) => setActive(event.target.checked)} />
        {node && !active && node.subtreeLive > 0 ? <p className="adm-notice adm-notice--warn">{t("categories.deactivateHint", { count: f.number(node.subtreeLive) })}</p> : null}
        {deactivating ? null : <TextField name="reason" label={t("common.reasonOptional")} maxLength={500} error={fieldError("reason")} />}
        {isFailure(fetcher.data) && !fetcher.data.fields ? <FailureNotice result={fetcher.data} /> : null}
      </fetcher.Form>
      {node ? (
        <ConfirmDialog
          open={confirming}
          onClose={() => setConfirming(false)}
          tone="destructive"
          title={t("categories.deactivateQ", { name: node.label })}
          consequence={t("categories.deactivateDo")}
          confirmLabel={t("categories.deactivate")}
          cancelLabel={t("common.cancel")}
          impact={[
            { label: t("categories.impactLive"), value: f.number(node.subtreeLive) },
            ...(activeBelow(node) > 0 ? [{ label: t("categories.impactBranch"), value: f.number(activeBelow(node)) }] : []),
            { label: t("categories.impactMoney"), value: t("categories.impactMoneySame") },
          ]}
          reason={{ label: t("common.reason"), hint: t("common.reasonHint") }}
          pending={fetcher.state !== "idle"}
          onConfirm={({ reason }) => {
            if (!formRef.current) return;
            const body = new FormData(formRef.current);
            body.set("reason", reason);
            fetcher.submit(body, { method: "post" });
          }}
        />
      ) : null}
    </Sheet>
  );
}
