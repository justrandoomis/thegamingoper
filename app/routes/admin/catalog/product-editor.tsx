import { useEffect, useState, type ReactNode } from "react";
import { data, Link, Outlet, useFetcher, useLocation, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/product-editor";
import { Icon } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { pick } from "~/lib/locales";
import { can } from "~/server/actor";
import { getProductEditor } from "~/server/services/admin/catalog/product.server";
import { WORKFLOW, type WorkflowAction } from "~/server/services/admin/catalog/rules";
import { changeProductStatus } from "~/server/services/admin/catalog/workflow.server";
import { ConfirmDialog, Dialog } from "~/ui/Dialog";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { Tabs } from "~/ui/Tabs";
import { toast } from "~/ui/toast-store";
import { adminMeta } from "../shell/meta";
import { baghdadInputToEpoch, catalogRequest, formObject, runIntent } from "./catalog.server";
import { FailureNotice, StatusBadge, epochToBaghdadInput, isFailure, useCatalogT, useKindLabel } from "./components/ui";

/**
 * /admin/catalog/products/:id — the frame of one product's editor: name, status, readiness, the publishing actions
 * (02.05: each one checked again by the service — permission, status, completeness, reason) and the section tabs.
 * Plain tab changes do not reload this frame; any saved change does (readiness and version follow the data).
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await catalogRequest(context, "catalog.product.read");
  const editor = await getProductEditor(db, actor, params.id, locale, now).catch((error: unknown) => {
    if ((error as { code?: string })?.code === "not_found") throw data({ error: "not_found" }, { status: 404 });
    throw error;
  });
  const available = editor.variants.filter((variant) => variant.isActive).reduce((sum, variant) => sum + variant.available, 0);
  return {
    product: {
      id: editor.product.id,
      slug: editor.product.slug,
      kind: editor.product.kind,
      name: editor.product.name,
      status: editor.product.status,
      storedStatus: editor.product.storedStatus,
      live: editor.product.live,
      publishAt: editor.product.publishAt,
      version: editor.product.version,
      updatedAt: editor.product.updatedAt,
      isDemo: editor.product.isDemo,
    },
    completeness: editor.completeness,
    actions: editor.actions,
    available,
    activeVariants: editor.variants.filter((variant) => variant.isActive).length,
    now,
    can: { update: can(actor, "catalog.product.update") },
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.product.read");
  const form = formObject(await request.formData());
  return runIntent(req, form.intent, {
    status: async () => {
      const result = await changeProductStatus(req.db, req.actor, { productId: params.id, version: form.version, action: form.action, reason: form.reason, publishAt: baghdadInputToEpoch(form.publishAtLocal) ?? form.publishAt }, req.now);
      return { status: result.status, version: result.version };
    },
  });
}

/** Tab changes keep the frame's data; submissions and a different product reload it. */
export function shouldRevalidate({ formMethod, currentParams, nextParams, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentParams.id === nextParams.id) return false;
  return defaultShouldRevalidate;
}

export const meta: Route.MetaFunction = (args) => {
  const name = args.loaderData?.product.name;
  return adminMeta(args, name ? (t) => `${name.ar} · ${t("modules.catalog")}` : (t) => t("modules.catalog"));
};

const TABS = ["details", "variants", "media", "bundle", "related", "compatibility", "history"] as const;

export default function ProductEditor({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const locale = useLocale();
  const kindLabel = useKindLabel();
  const { pathname, search } = useLocation();
  const { product, completeness, actions, available, activeVariants, now } = loaderData;
  const base = `/admin/catalog/products/${product.id}`;
  const current = TABS.find((tab) => tab !== "details" && pathname.startsWith(`${base}/${tab}`)) ?? "details";
  const missing = completeness.missing.length + completeness.missingCustom.length;

  const scanned = new URLSearchParams(search).get("scanned");
  useEffect(() => {
    if (scanned) toast.info(t("list.scanned", { name: pick(product.name, locale) }));
  }, [scanned, product.name, locale, t]);

  return (
    <>
      <header className="adm-page-head">
        <Link to="/admin/catalog" className="adm-link inline-flex w-fit items-center gap-1 type-caption">
          <Icon name="arrow-left" size={16} />
          {t("editor.backToList")}
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            {/* the name in its own direction (a Latin «007 First Light» stays in order in the Arabic admin), the title still at the page's start */}
            <h1 className="adm-title">
              <bdi>{pick(product.name, locale)}</bdi>
            </h1>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-1 type-caption text-ink-2">
              <span>{kindLabel(product.kind)}</span>
              <bdi dir="ltr">{product.slug}</bdi>
              <span className="nums">{t("editor.version", { version: f.number(product.version) })}</span>
              <span className="nums">{t("editor.updated", { time: f.relative(product.updatedAt, now) })}</span>
              {product.isDemo ? <span className="rounded-xs border border-line px-1.5 type-caption">{t("common.demo")}</span> : null}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <StatusBadge status={product.status} publishAt={product.publishAt} live={product.live} />
            {missing === 0 ? <Status tone="ok">{t("editor.complete")}</Status> : <Status tone="warn">{t("list.missing", { count: missing })}</Status>}
            {product.storedStatus === "published" || product.live ? (
              <Key as="a" href={`/p/${product.slug}`} target="_blank" rel="noreferrer" size="sm" variant="quiet" iconEnd="arrow-square-out">
                {t("editor.viewStorefront")}
              </Key>
            ) : null}
          </div>
        </div>
        <Workflow productId={product.id} version={product.version} status={product.storedStatus} actions={actions} complete={missing === 0} available={available} activeVariants={activeVariants} publishAt={product.publishAt} now={now} />
      </header>
      <Tabs
        aria-label={t("editor.tabsLabel")}
        className="mb-5"
        value={current}
        items={TABS.filter((tab) => tab !== "bundle" || product.kind === "bundle" || current === "bundle").map((tab) => ({
          value: tab,
          label: t(`editor.tabs.${tab}`),
          href: tab === "details" ? base : `${base}/${tab}`,
          ...(tab === "details" && missing > 0 ? { count: missing } : {}),
        }))}
      />
      <Outlet />
    </>
  );
}

type WorkflowProps = {
  productId: string;
  version: number;
  status: string;
  actions: WorkflowAction[];
  complete: boolean;
  available: number;
  activeVariants: number;
  publishAt: number | null;
  now: number;
};

/** The publishing actions open to this employee from this status, each confirmed (with its reason and impact). */
function Workflow({ productId, version, status, actions, complete, available, activeVariants, publishAt, now }: WorkflowProps) {
  const t = useCatalogT();
  const f = useFormat();
  const fetcher = useFetcher<typeof action>({ key: `catalog-status-${productId}` });
  const [open, setOpen] = useState<WorkflowAction | null>(null);
  const answer = fetcher.data as unknown;
  const pending = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !isFailure(fetcher.data)) {
      setOpen(null);
      toast.success(t("common.saved"));
    }
  }, [fetcher.state, fetcher.data, t]);

  if (actions.length === 0) return null;
  const submit = (chosen: WorkflowAction, fields: Record<string, string>) => {
    const form = new FormData();
    form.set("intent", "status");
    form.set("action", chosen);
    form.set("version", String(version));
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    fetcher.submit(form, { method: "post", action: `/admin/catalog/products/${productId}` });
  };
  const error = isFailure(answer) ? <FailureNotice result={answer} /> : undefined;
  const impact = [
    { label: t("impact.storefront"), value: open === "publish" || open === "schedule" ? t("impact.shown") : t("impact.notShown") },
    { label: t("impact.stock"), value: t("impact.stockSame", { count: f.number(available) }) },
    { label: t("impact.prices"), value: t("impact.pricesSame") },
    { label: t("impact.variants"), value: f.number(activeVariants) },
  ];

  return (
    <div className="flex flex-wrap items-center gap-2 pt-2" aria-label={t("editor.workflow")} role="group">
      {actions.map((chosen) => {
        const blocked = WORKFLOW[chosen].needsComplete && !complete;
        return (
          <Key
            key={chosen}
            size="sm"
            variant={chosen === "publish" ? "ink" : "clay"}
            icon={chosen === "publish" ? "eye" : chosen === "schedule" ? "clock" : chosen === "hide" ? "eye-slash" : chosen === "archive" ? "trash" : chosen === "submit_review" ? "paper-plane-tilt" : "arrow-counter-clockwise"}
            disabled={blocked}
            aria-describedby={blocked ? "workflow-blocked" : undefined}
            className={chosen === "archive" ? "[--on:var(--red-ink)]" : undefined}
            onClick={() => setOpen(chosen)}
          >
            {t(`action.${chosen}`)}
          </Key>
        );
      })}
      {!complete && actions.some((chosen) => WORKFLOW[chosen].needsComplete) ? (
        <p id="workflow-blocked" className="type-caption text-ink-2">
          {t("editor.incomplete")}{" "}
          <Link to={`/admin/catalog/products/${productId}#readiness`} className="adm-link">
            {t("editor.readiness")}
          </Link>
        </p>
      ) : null}

      {actions
        .filter((chosen) => chosen !== "schedule")
        .map((chosen) => (
          <ConfirmDialog
            key={chosen}
            open={open === chosen}
            onClose={() => setOpen(null)}
            tone={chosen === "archive" ? "destructive" : "neutral"}
            title={t(`actionQ.${chosen}`)}
            consequence={t(`actionDo.${chosen}`)}
            confirmLabel={t(`action.${chosen}`)}
            cancelLabel={t("common.cancel")}
            impact={chosen === "submit_review" || chosen === "return_draft" ? undefined : impact}
            reason={WORKFLOW[chosen].needsReason ? { label: t("common.reason"), hint: t("common.reasonHint") } : undefined}
            pending={pending}
            error={open === chosen ? error : undefined}
            onConfirm={({ reason }) => submit(chosen, { reason })}
          />
        ))}
      {actions.includes("schedule") ? (
        <ScheduleDialog open={open === "schedule"} onClose={() => setOpen(null)} pending={pending} error={open === "schedule" ? error : undefined} initial={publishAt ?? now + 24 * 60 * 60 * 1000} onSubmit={(fields) => submit("schedule", fields)} />
      ) : null}
    </div>
  );
}

function ScheduleDialog({ open, onClose, pending, error, initial, onSubmit }: { open: boolean; onClose: () => void; pending: boolean; error?: ReactNode; initial: number; onSubmit: (fields: Record<string, string>) => void }) {
  const t = useCatalogT();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={t("actionQ.schedule")}
      description={t("actionDo.schedule")}
      dismissible={!pending}
      onSubmit={(event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        onSubmit({ publishAtLocal: String(form.get("publishAtLocal") ?? ""), reason: String(form.get("reason") ?? "") });
      }}
      footer={
        <>
          <Key onClick={onClose} disabled={pending} className="flex-1 sm:flex-none">
            {t("common.cancel")}
          </Key>
          <Key type="submit" variant="ink" loading={pending} className="flex-1 sm:flex-none">
            {t("action.schedule")}
          </Key>
        </>
      }
    >
      <div className="grid gap-3">
        <TextField name="publishAtLocal" type="datetime-local" label={t("editor.publishAt")} required defaultValue={epochToBaghdadInput(initial)} ltr />
        <TextArea name="reason" label={t("common.reasonOptional")} rows={2} maxLength={500} />
        {error}
      </div>
    </Dialog>
  );
}
