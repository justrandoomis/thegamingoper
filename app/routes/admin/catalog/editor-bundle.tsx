import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/editor-bundle";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import {
  getBundle,
  removeBundleComponent,
  setBundleComponent,
} from "~/server/services/admin/catalog/bundles.server";
import { MAX_COMPONENT_QTY } from "~/server/services/admin/catalog/rules";
import type { BundleComponentView } from "~/server/services/admin/catalog/bundles.server";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { answered, catalogRequest, formObject, runIntent } from "./catalog.server";
import {
  FailureNotice,
  StatusBadge,
  isFailure,
  useAnswerToast,
  useCatalogT,
  useFieldError,
} from "./components/ui";

/**
 * /admin/catalog/products/:id/bundle — bundle components (02.07, catalog.bundle.manage) with the stock of each
 * component from the stock core's getAvailability: the bundle is available only as far as every component is (the
 * scarcest one is marked). Components are typed or scanned (SKU or barcode). Nothing here moves stock.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(
    context,
    "catalog.product.read",
  );
  return {
    bundle: await answered(getBundle(db, actor, params.id, locale)),
    can: { manage: can(actor, "catalog.bundle.manage") },
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.bundle.manage");
  const form = formObject(await request.formData());
  return runIntent(req, form.intent, {
    set: async () =>
      setBundleComponent(
        req.db,
        req.actor,
        { ...form, productId: params.id },
        req.now,
      ),
    remove: async () =>
      removeBundleComponent(
        req.db,
        req.actor,
        { ...form, productId: params.id },
        req.now,
      ),
  });
}

export const meta: Route.MetaFunction = (args) =>
  adminMeta(args, (t) => t("modules.catalog"));

export default function ProductBundle({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const { bundle, can: allowed } = loaderData;
  const [removing, setRemoving] = useState<{
    bundleVariantId: string;
    component: BundleComponentView;
  } | null>(null);
  const remove = useFetcher<typeof action>({
    key: `catalog-bundle-remove-${bundle.productId}`,
  });
  useAnswerToast(remove, t("bundle.saved"));
  useEffect(() => {
    if (remove.state === "idle" && remove.data && !isFailure(remove.data))
      setRemoving(null);
  }, [remove.state, remove.data]);
  const hasComponents = bundle.variants.some(
    (variant) => variant.components.length > 0,
  );

  return (
    <section className="adm-section" aria-labelledby="bundle-title">
      <div className="grid gap-1">
        <h2 id="bundle-title" className="adm-h2">
          {t("bundle.title")}
        </h2>
        <p className="max-w-[70ch] type-caption text-ink-2">
          {t("bundle.lead")}
        </p>
        <p className="type-caption text-ink-2">{t("bundle.oneLevel")}</p>
      </div>
      {bundle.kind !== "bundle" && !hasComponents ? (
        <p className="adm-notice">{t("bundle.notBundle")}</p>
      ) : null}

      {bundle.variants.map((variant) => {
        const columns: DataColumn<BundleComponentView>[] = [
          {
            key: "component",
            header: t("bundle.colComponent"),
            cell: (row) => (
              <span className="grid gap-0.5 py-1.5">
                <Link
                  to={`/admin/catalog/products/${row.productId}`}
                  className="adm-link"
                >
                  {row.productName}
                </Link>
                <span className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
                  <bdi dir="ltr">{row.sku}</bdi>
                  {row.title ? <span>{row.title}</span> : null}
                  {!row.isActive ? (
                    <span className="text-warn">{t("bundle.inactive")}</span>
                  ) : null}
                  <StatusBadge status={row.productStatus} />
                </span>
              </span>
            ),
          },
          {
            key: "qty",
            header: t("bundle.colQty"),
            numeric: true,
            cell: (row) => <bdi className="nums">× {f.number(row.qty)}</bdi>,
          },
          {
            key: "available",
            header: t("bundle.colAvailable"),
            numeric: true,
            cell: (row) => (
              <bdi className="nums">{f.number(row.available)}</bdi>
            ),
          },
          {
            key: "sets",
            header: t("bundle.colSets"),
            numeric: true,
            cell: (row) => (
              <span className="inline-flex items-center gap-2">
                <bdi className="nums">{f.number(row.sets)}</bdi>
                {row.limiting ? (
                  <Status tone="warn">{t("bundle.limiting")}</Status>
                ) : null}
              </span>
            ),
          },
          ...(allowed.manage
            ? [
                {
                  key: "remove",
                  header: <span className="sr-only">{t("bundle.remove")}</span>,
                  cell: (row: BundleComponentView) => (
                    <IconKey
                      size="sm"
                      icon="trash"
                      label={`${t("bundle.remove")} ${row.sku}`}
                      onClick={() =>
                        setRemoving({
                          bundleVariantId: variant.id,
                          component: row,
                        })
                      }
                    />
                  ),
                },
              ]
            : []),
        ];
        return (
          <article
            key={variant.id}
            className="adm-card gap-4"
            aria-labelledby={`bundle-${variant.id}`}
          >
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 id={`bundle-${variant.id}`} className="adm-h3">
                {t("bundle.variant", { sku: variant.sku })}{" "}
                {variant.title ? (
                  <span className="type-caption text-ink-2">
                    · {variant.title}
                  </span>
                ) : null}
              </h3>
              <p className="type-label">
                {variant.components.length > 0 ? (
                  <Status tone={variant.available > 0 ? "ok" : "bad"}>
                    {t("bundle.available", {
                      count: f.number(variant.available),
                    })}
                  </Status>
                ) : (
                  <Status tone="warn">{t("bundle.empty")}</Status>
                )}
              </p>
            </div>
            {variant.components.length > 0 ? (
              <>
                <div className="hidden md:block">
                  <DataTable
                    caption={t("bundle.variant", { sku: variant.sku })}
                    columns={columns}
                    rows={variant.components}
                    rowKey={(row) => row.variantId}
                    maxHeight={null}
                  />
                </div>
                <ul
                  role="list"
                  className="grid gap-2 md:hidden"
                  aria-label={t("bundle.variant", { sku: variant.sku })}
                >
                  {variant.components.map((row) => (
                    <li
                      key={row.variantId}
                      className="grid gap-2 border-t border-line pt-3 first:border-t-0 first:pt-0"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <span className="grid min-w-0 gap-0.5">
                          <Link
                            to={`/admin/catalog/products/${row.productId}`}
                            className="adm-link"
                          >
                            {row.productName}
                          </Link>
                          <span className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
                            <bdi dir="ltr">{row.sku}</bdi>
                            {row.title ? <span>{row.title}</span> : null}
                            {!row.isActive ? (
                              <span className="text-warn">
                                {t("bundle.inactive")}
                              </span>
                            ) : null}
                            <StatusBadge status={row.productStatus} />
                          </span>
                        </span>
                        {allowed.manage ? (
                          <IconKey
                            size="sm"
                            icon="trash"
                            label={`${t("bundle.remove")} ${row.sku}`}
                            onClick={() =>
                              setRemoving({
                                bundleVariantId: variant.id,
                                component: row,
                              })
                            }
                          />
                        ) : null}
                      </div>
                      <dl className="grid grid-cols-3 gap-2 type-caption">
                        <div>
                          <dt className="text-ink-2">{t("bundle.colQty")}</dt>
                          <dd className="type-label nums">
                            × {f.number(row.qty)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-ink-2">
                            {t("bundle.colAvailable")}
                          </dt>
                          <dd className="type-label nums">
                            {f.number(row.available)}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-ink-2">{t("bundle.colSets")}</dt>
                          <dd className="flex flex-wrap items-center gap-1 type-label">
                            <bdi className="nums">{f.number(row.sets)}</bdi>
                            {row.limiting ? (
                              <Status tone="warn">
                                {t("bundle.limiting")}
                              </Status>
                            ) : null}
                          </dd>
                        </div>
                      </dl>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            {allowed.manage ? (
              <AddComponent
                productId={bundle.productId}
                bundleVariantId={variant.id}
              />
            ) : null}
          </article>
        );
      })}

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        tone="destructive"
        title={
          removing ? t("bundle.removeQ", { sku: removing.component.sku }) : ""
        }
        consequence={t("bundle.removeDo")}
        confirmLabel={t("bundle.remove")}
        cancelLabel={t("common.cancel")}
        impact={
          removing
            ? [
                {
                  label: t("impact.stock"),
                  value: t("impact.stockSame", {
                    count: f.number(removing.component.available),
                  }),
                },
              ]
            : undefined
        }
        reason={{ label: t("common.reason"), hint: t("common.reasonHint") }}
        pending={remove.state !== "idle"}
        error={
          isFailure(remove.data) ? (
            <FailureNotice result={remove.data} />
          ) : undefined
        }
        onConfirm={({ reason }) =>
          removing &&
          remove.submit(
            {
              intent: "remove",
              bundleVariantId: removing.bundleVariantId,
              componentVariantId: removing.component.variantId,
              reason,
            },
            { method: "post" },
          )
        }
      />
    </section>
  );
}

function AddComponent({
  productId,
  bundleVariantId,
}: {
  productId: string;
  bundleVariantId: string;
}) {
  const t = useCatalogT();
  const fetcher = useFetcher<typeof action>({
    key: `catalog-bundle-add-${productId}-${bundleVariantId}`,
  });
  const fieldError = useFieldError(fetcher.data);
  useAnswerToast(fetcher, t("bundle.saved"));
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && !isFailure(fetcher.data))
      setRound((value) => value + 1);
  }, [fetcher.state, fetcher.data]);
  return (
    <fetcher.Form
      key={round}
      method="post"
      className="grid items-end gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]"
    >
      <input type="hidden" name="intent" value="set" />
      <input type="hidden" name="bundleVariantId" value={bundleVariantId} />
      <TextField
        name="component"
        label={t("bundle.component")}
        ltr
        required
        autoComplete="off"
        maxLength={64}
        error={fieldError("component")}
      />
      <TextField
        name="qty"
        label={t("bundle.qty")}
        inputMode="numeric"
        defaultValue="1"
        required
        hint={`1–${MAX_COMPONENT_QTY}`}
        error={fieldError("qty")}
      />
      <Key
        type="submit"
        icon="plus"
        loading={fetcher.state !== "idle"}
        className="self-center"
      >
        {t("bundle.add")}
      </Key>
      {isFailure(fetcher.data) && !fetcher.data.fields ? (
        <div className="sm:col-span-3">
          <FailureNotice result={fetcher.data} />
        </div>
      ) : null}
    </fetcher.Form>
  );
}
