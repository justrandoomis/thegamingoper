import { useEffect, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/editor-history";
import { Icon } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { pick, type L10n } from "~/lib/locales";
import { canSeeModule } from "../shell/access.server";
import {
  compareVersion,
  getHistory,
  referenceNames,
  restoreVersion,
} from "~/server/services/admin/catalog/versions.server";
import type { VersionComparison } from "~/server/services/admin/catalog/versions.server";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { answered, catalogRequest, formObject, runIntent } from "./catalog.server";
import {
  FailureNotice,
  Iqd,
  isFailure,
  useAnswerToast,
  useCatalogT,
} from "./components/ui";

/**
 * /admin/catalog/products/:id/history — the version history (02.09): every save as a full version (who, when, why,
 * what changed), a comparison of any version with the product now, and the safe restore (catalog.version.restore):
 * texts and facts come back as a NEW version; prices, costs, stock, status and identifiers never do. The price
 * history is module 03's and shown read-only.
 */
export async function loader({ context, params, url }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(
    context,
    "catalog.product.read",
  );
  const history = await answered(getHistory(db, actor, params.id));
  const wanted = Number.parseInt(url.searchParams.get("compare") ?? "", 10);
  let comparison: VersionComparison | null = null;
  let names: Record<string, string> = {};
  if (
    Number.isSafeInteger(wanted) &&
    wanted > 0 &&
    history.versions.some((version) => version.version === wanted)
  ) {
    comparison = await answered(compareVersion(db, actor, params.id, wanted));
    const ids = comparison.fields
      .filter((field) => field.field.endsWith("Id"))
      .flatMap((field) => [field.then, field.now])
      .filter((value): value is string => typeof value === "string");
    names = await referenceNames(db, ids, locale);
  }
  return {
    history,
    comparison,
    names,
    pricing: canSeeModule(actor, "pricing"),
  };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await catalogRequest(context, "catalog.version.restore");
  const form = formObject(await request.formData());
  return runIntent(req, form.intent, {
    restore: async () =>
      restoreVersion(
        req.db,
        req.actor,
        { ...form, productId: params.id },
        req.now,
      ),
  });
}

export const meta: Route.MetaFunction = (args) =>
  adminMeta(args, (t) => t("modules.catalog"));

type VersionRow =
  Route.ComponentProps["loaderData"]["history"]["versions"][number];

/** "variants.SKU-1.title" → "SKU-1 · Title"; plain fields by their label. */
function useFieldLabel() {
  const t = useCatalogT();
  return (field: string) => {
    if (field === "created" || field === "baseline")
      return t(field === "created" ? "history.created" : "history.baseline");
    const variant = /^variants\.([^.]+)(?:\.(.+))?$/.exec(field);
    if (variant) {
      const [, sku, rest] = variant;
      return `${sku}${rest ? ` · ${t(`history.fields.${rest}`)}` : ""}`;
    }
    return t(`history.fields.${field}`);
  };
}

export default function ProductHistory({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const label = useFieldLabel();
  const { history, comparison, names, pricing } = loaderData;
  const [restoring, setRestoring] = useState<number | null>(null);
  const restore = useFetcher<typeof action>({
    key: `catalog-restore-${history.productId}`,
  });
  useAnswerToast(restore, t("history.restored"));
  useEffect(() => {
    if (restore.state === "idle" && restore.data && !isFailure(restore.data))
      setRestoring(null);
  }, [restore.state, restore.data]);

  const columns: DataColumn<VersionRow>[] = [
    {
      key: "version",
      header: t("history.colVersion"),
      cell: (row) => (
        <span className="inline-flex items-center gap-2 py-1.5">
          <bdi className="nums font-semibold">{f.number(row.version)}</bdi>
          {row.version === history.current ? (
            <Status tone="info">{t("history.current")}</Status>
          ) : null}
        </span>
      ),
    },
    {
      key: "when",
      header: t("history.colWhen"),
      cell: (row) => (
        <span className="whitespace-nowrap nums">
          {f.dateTime(row.createdAt)}
        </span>
      ),
    },
    {
      key: "who",
      header: t("history.colWho"),
      cell: (row) => <span>{row.by ?? t("common.system")}</span>,
    },
    {
      key: "what",
      header: t("history.colWhat"),
      cell: (row) => (
        <span className="grid gap-0.5 py-1.5">
          <span className="type-caption text-ink-2">
            {t("history.changes", { count: row.changes.length })}
          </span>
          <span className="type-caption">
            {row.changes.slice(0, 5).map(label).join("، ")}
            {row.changes.length > 5 ? " …" : ""}
          </span>
        </span>
      ),
    },
    {
      key: "reason",
      header: t("history.colReason"),
      cell: (row) => (
        <span className="type-caption">
          {row.reason === "baseline"
            ? t("history.baseline")
            : row.reason === "created"
              ? t("history.created")
              : (row.reason ?? "—")}
        </span>
      ),
    },
    {
      key: "actions",
      header: <span className="sr-only">{t("history.compare")}</span>,
      cell: (row) =>
        row.version === history.current ? null : (
          <span className="flex gap-1.5">
            <Key
              as={Link}
              to={`?compare=${row.version}#compare`}
              size="sm"
              preventScrollReset
            >
              {t("history.compare")}
            </Key>
            {history.canRestore ? (
              <Key
                size="sm"
                icon="arrow-counter-clockwise"
                onClick={() => setRestoring(row.version)}
              >
                {t("history.restore")}
              </Key>
            ) : null}
          </span>
        ),
    },
  ];

  return (
    <div className="grid gap-8">
      <section className="adm-section mb-0" aria-labelledby="history-title">
        <div className="grid gap-1">
          <h2 id="history-title" className="adm-h2">
            {t("history.title")}
          </h2>
          <p className="max-w-[75ch] type-caption text-ink-2">
            {t("history.lead")}
          </p>
        </div>
        {history.versions.length === 0 ? (
          <EmptyState icon="clock" title={t("history.empty")} />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("history.title")}
                columns={columns}
                rows={history.versions}
                rowKey={(row) => String(row.version)}
                maxHeight={null}
              />
            </div>
            <ul
              role="list"
              className="grid gap-2 md:hidden"
              aria-label={t("history.title")}
            >
              {history.versions.map((row) => (
                <li key={row.version} className="adm-card gap-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2">
                      <span className="type-strong">
                        {t("editor.version", {
                          version: f.number(row.version),
                        })}
                      </span>
                      {row.version === history.current ? (
                        <Status tone="info">{t("history.current")}</Status>
                      ) : null}
                    </span>
                    <span className="type-caption text-ink-2 nums">
                      {f.dateTime(row.createdAt)}
                    </span>
                  </div>
                  <p className="type-caption text-ink-2">
                    {row.by ?? t("common.system")}
                  </p>
                  <p className="type-caption">
                    <span className="text-ink-2">
                      {t("history.changes", { count: row.changes.length })}
                      :{" "}
                    </span>
                    {row.changes.slice(0, 5).map(label).join("، ")}
                    {row.changes.length > 5 ? " …" : ""}
                  </p>
                  {row.reason ? (
                    <p className="type-caption">
                      {row.reason === "baseline"
                        ? t("history.baseline")
                        : row.reason === "created"
                          ? t("history.created")
                          : row.reason}
                    </p>
                  ) : null}
                  {row.version === history.current ? null : (
                    <div className="flex flex-wrap gap-1.5">
                      <Key
                        as={Link}
                        to={`?compare=${row.version}#compare`}
                        size="sm"
                        preventScrollReset
                      >
                        {t("history.compare")}
                      </Key>
                      {history.canRestore ? (
                        <Key
                          size="sm"
                          icon="arrow-counter-clockwise"
                          onClick={() => setRestoring(row.version)}
                        >
                          {t("history.restore")}
                        </Key>
                      ) : null}
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {history.versions.length >= 100 ? (
              <p className="type-caption text-ink-2">
                {t("history.truncated")}
              </p>
            ) : null}
          </>
        )}
      </section>

      {comparison ? (
        <Comparison
          comparison={comparison}
          names={names}
          canRestore={history.canRestore}
          onRestore={() => setRestoring(comparison.version)}
        />
      ) : null}

      <section className="adm-section mb-0" aria-labelledby="price-history">
        <div className="grid gap-1">
          <h2 id="price-history" className="adm-h2">
            {t("history.prices")}
          </h2>
          <p className="type-caption text-ink-2">{t("history.pricesLead")}</p>
        </div>
        {history.prices.length === 0 ? (
          <p className="type-caption text-ink-2">{t("history.noPrices")}</p>
        ) : (
          <ul className="grid gap-1">
            {history.prices.map((entry, index) => (
              <li
                key={index}
                className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-line py-1.5 type-caption"
              >
                <span className="nums text-ink-2">{f.dateTime(entry.at)}</span>
                <bdi dir="ltr">{entry.sku}</bdi>
                <span>
                  <Iqd amount={entry.oldPriceIqd} />{" "}
                  <Icon
                    name="arrow-right"
                    size={12}
                    className="inline align-middle text-ink-2"
                  />{" "}
                  <Iqd amount={entry.newPriceIqd} />
                </span>
                {entry.reason ? (
                  <span className="text-ink-2">{entry.reason}</span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {pricing ? (
          <Link to="/admin/pricing" className="adm-link type-caption">
            {t("common.openPricing")}
          </Link>
        ) : null}
      </section>

      <ConfirmDialog
        open={restoring !== null}
        onClose={() => setRestoring(null)}
        title={
          restoring !== null
            ? t("history.restoreQ", { version: f.number(restoring) })
            : ""
        }
        consequence={t("history.restoreDo")}
        confirmLabel={t("history.restore")}
        cancelLabel={t("common.cancel")}
        impact={[
          { label: t("impact.prices"), value: t("impact.pricesSame") },
          { label: t("impact.stock"), value: t("history.notRestored") },
        ]}
        reason={{ label: t("common.reason"), hint: t("common.reasonHint") }}
        pending={restore.state !== "idle"}
        error={
          isFailure(restore.data) ? (
            <FailureNotice result={restore.data} />
          ) : undefined
        }
        onConfirm={({ reason }) =>
          restoring !== null &&
          restore.submit(
            {
              intent: "restore",
              version: String(restoring),
              expectedVersion: String(history.current),
              reason,
            },
            { method: "post" },
          )
        }
      />
    </div>
  );
}

function Comparison({
  comparison,
  names,
  canRestore,
  onRestore,
}: {
  comparison: VersionComparison;
  names: Record<string, string>;
  canRestore: boolean;
  onRestore: () => void;
}) {
  const t = useCatalogT();
  const f = useFormat();
  const locale = useLocale();
  const label = useFieldLabel();
  const show = (field: string, value: unknown) => {
    if (value === null || value === undefined || value === "")
      return <span className="text-ink-2">—</span>;
    if (field.endsWith("priceIqd") || field.endsWith("compareAtIqd"))
      return <Iqd amount={value as number} />;
    if (field.endsWith("Id") && typeof value === "string")
      return <span>{names[value] ?? value}</span>;
    if (
      typeof value === "object" &&
      value !== null &&
      "ar" in (value as object)
    )
      return (
        <span className="line-clamp-3">{pick(value as L10n, locale)}</span>
      );
    if (typeof value === "object")
      return (
        <span className="text-ink-2">
          {t("history.fields.structured", {
            count: Object.keys(value as object).length,
          })}
        </span>
      );
    if (
      typeof value === "number" &&
      (field === "publishAt" || field === "publishedAt")
    )
      return <span className="nums">{f.dateTime(value)}</span>;
    if (field === "status" && typeof value === "string")
      return <span>{t(`status.${value}`)}</span>;
    if (field === "kind" && typeof value === "string")
      return <span>{t(`kind.${value}`)}</span>;
    return <bdi>{String(value)}</bdi>;
  };
  return (
    <section
      className="adm-section mb-0"
      aria-labelledby="compare-title"
      id="compare"
    >
      <div className="adm-section__head">
        <h2 id="compare-title" className="adm-h2">
          {t("history.compare")} —{" "}
          {t("editor.version", { version: f.number(comparison.version) })}
        </h2>
        {canRestore && comparison.restorable > 0 ? (
          <Key icon="arrow-counter-clockwise" onClick={onRestore}>
            {t("history.restore")}
          </Key>
        ) : null}
      </div>
      {comparison.fields.length === 0 ? (
        <p className="type-caption text-ink-2">{t("history.noDiff")}</p>
      ) : (
        <>
          <dl className="grid gap-2 md:hidden">
            {comparison.fields.map((field) => (
              <div key={field.field} className="adm-card gap-1.5">
                <dt className="type-strong">{label(field.field)}</dt>
                <dd className="grid gap-1 type-caption">
                  <span className="flex flex-wrap gap-1">
                    <span className="text-ink-2">{t("history.then")}:</span>{" "}
                    {show(field.field, field.then)}
                  </span>
                  <span className="flex flex-wrap gap-1">
                    <span className="text-ink-2">{t("history.now")}:</span>{" "}
                    {show(field.field, field.now)}
                  </span>
                  {field.restorable ? null : (
                    <span className="text-ink-2">
                      {t("history.notRestored")}:{" "}
                      {t(`history.reasons.${field.reasonKey ?? "identifier"}`)}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
          <div className="hidden overflow-x-auto rounded-sm border border-line md:block">
            <table className="table">
              <caption className="sr-only">{t("history.compare")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("history.field")}</th>
                  <th scope="col">{t("history.then")}</th>
                  <th scope="col">{t("history.now")}</th>
                </tr>
              </thead>
              <tbody>
                {comparison.fields.map((field) => (
                  <tr key={field.field}>
                    <th scope="row" className="py-2 align-top font-semibold">
                      <span className="grid gap-0.5">
                        <span>{label(field.field)}</span>
                        {field.restorable ? null : (
                          <span className="type-caption font-normal text-ink-2">
                            {t("history.notRestored")}:{" "}
                            {t(
                              `history.reasons.${field.reasonKey ?? "identifier"}`,
                            )}
                          </span>
                        )}
                      </span>
                    </th>
                    <td className="max-w-[24rem] py-2 align-top">
                      {show(field.field, field.then)}
                    </td>
                    <td className="max-w-[24rem] py-2 align-top">
                      {show(field.field, field.now)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
