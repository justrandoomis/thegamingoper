import { Link } from "react-router";

import type { Route } from "./+types/digital";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { digitalOverview } from "~/server/services/admin/devices/codes.server";
import { CODE_STATUS_LIST, type DigitalVariantRow } from "~/server/services/admin/devices/types";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { openDevices } from "./devices.server";
import { devicesMeta } from "./meta";
import { Name, Ref, Section, useDevicesT } from "./ui";

/**
 * /admin/devices/digital — physical games vs digital products (13.06): every game and digital product of the
 * catalogue in one delivery class (disc, cartridge, code, DLC, subscription, wallet top-up, account), the products whose
 * facts disagree (edited in the catalogue, module 02), and the digital variants with how many codes each holds by
 * status (13.07; the codes themselves on the variant's page, devices.digital_code.manage).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openDevices(context);
  try {
    return { overview: await digitalOverview(db, actor, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, "digital.title");

export default function DigitalPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const f = useFormat();
  const { overview } = loaderData;
  const columns: DataColumn<DigitalVariantRow>[] = [
    {
      key: "variant",
      header: t("digital.col.variant"),
      cell: (row) => (
        <span className="grid py-1">
          {overview.canManage ? (
            <Link to={`/admin/devices/digital/${row.variantId}`} className="adm-link">
              <Name text={row.name} />
            </Link>
          ) : (
            <Name text={row.name} />
          )}
          <span className="type-caption text-ink-2">
            <Ref value={row.sku} />
          </span>
        </span>
      ),
    },
    { key: "class", header: t("digital.col.class"), cell: (row) => <span className="dev-tag">{t(`cls.${row.cls}`)}</span> },
    ...CODE_STATUS_LIST.map(
      (status): DataColumn<DigitalVariantRow> => ({
        key: status,
        header: t(`codeStatus.${status}`),
        numeric: true,
        cell: (row) => <bdi className="nums">{f.number(row.codes[status] ?? 0)}</bdi>,
      }),
    ),
  ];
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("digital.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("digital.lead")}</p>
      </header>

      <Section id="digital-classes" title={t("digital.classes")}>
        <div className="adm-grid">
          {overview.classes.map((entry) => (
            <article key={entry.cls} className="adm-card">
              <p className="type-caption text-ink-2">{t(`cls.${entry.cls}`)}</p>
              <p className="type-kpi nums">
                <bdi>{f.number(entry.products)}</bdi>
              </p>
              <p className="type-caption text-ink-2">{t("digital.variants", { count: entry.variants })}</p>
              <p className="type-caption">{t(`clsHint.${entry.cls}`)}</p>
            </article>
          ))}
        </div>
      </Section>

      <Section id="digital-problems" title={t("digital.problems")}>
        {overview.problems.length === 0 ? (
          <p className="type-body text-ink-2">{t("digital.noProblems")}</p>
        ) : (
          <ul className="dev-blockers">
            {overview.problems.map((problem) => (
              <li key={problem.productId}>
                <span className="dev-tag">{t(`problem.${problem.problem}`)}</span>
                {overview.canEditCatalog ? (
                  <Link to={`/admin/catalog/products/${problem.productId}`} className="adm-link">
                    <Name text={problem.name} />
                  </Link>
                ) : (
                  <Name text={problem.name} />
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="type-caption text-ink-2">{t("digital.problemsNote")}</p>
      </Section>

      <Section id="digital-codes" title={t("digital.codes")}>
        <p className="type-caption text-ink-2">{t("digital.codesLead")}</p>
        {overview.variants.length === 0 ? (
          <EmptyState title={t("digital.noVariants")} icon="key" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("digital.codes")} columns={columns} rows={overview.variants} rowKey={(row) => row.variantId} rowLabel={(row) => row.sku} maxHeight={null} />
            </div>
            <ul className="dev-cards md:hidden" aria-label={t("digital.codes")}>
              {overview.variants.map((row) => (
                <li key={row.variantId}>
                  {overview.canManage ? (
                    <Link to={`/admin/devices/digital/${row.variantId}`} className="dev-card">
                      <VariantCard row={row} />
                    </Link>
                  ) : (
                    <div className="dev-card">
                      <VariantCard row={row} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
        {!overview.canManage ? <p className="type-caption text-ink-2">{t("digital.manageNeeded")}</p> : null}
      </Section>
    </>
  );
}

function VariantCard({ row }: { row: DigitalVariantRow }) {
  const t = useDevicesT();
  const f = useFormat();
  return (
    <>
      <span className="dev-card__top">
        <span className="type-strong">
          <Name text={row.name} />
        </span>
        <span className="dev-tag">{t(`cls.${row.cls}`)}</span>
      </span>
      <span className="type-caption text-ink-2">
        <Ref value={row.sku} />
      </span>
      <span className="type-caption">
        {CODE_STATUS_LIST.filter((status) => (row.codes[status] ?? 0) > 0)
          .map((status) => `${t(`codeStatus.${status}`)}: ${f.number(row.codes[status] ?? 0)}`)
          .join(" · ") || t("digital.noCodes")}
      </span>
    </>
  );
}
