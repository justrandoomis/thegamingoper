import { Form, Link } from "react-router";

import type { Route } from "./+types/device-compare";
import { useFormat } from "~/i18n/react";
import { compareDevices } from "~/server/services/admin/catalog/compatibility.server";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { adminMeta } from "../shell/meta";
import { catalogRequest } from "./catalog.server";
import { COMPAT_TONE, useCatalogT, useKindLabel } from "./components/ui";

/**
 * /admin/catalog/compare?m=<slug>&m=<slug>… — device spec comparison (02.10): the spec sheets of 2–4 device models
 * side by side by spec key (differences marked, "differences only" in the URL), then compatibility across
 * generations: every product with a rule on one of them, and its status per device (the most specific rule wins).
 * A GET form: shareable, works without JavaScript.
 */
export async function loader({ context, url }: Route.LoaderArgs) {
  const { db, actor, locale } = await catalogRequest(context, "catalog.product.read");
  const slugs = url.searchParams
    .getAll("m")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim().toLowerCase())
    .filter((value) => /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(value))
    .slice(0, 4);
  return { comparison: await compareDevices(db, actor, slugs, locale), slugs, differencesOnly: url.searchParams.get("diff") === "1" };
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("devices.title"));

export default function DeviceCompare({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const f = useFormat();
  const kindLabel = useKindLabel();
  const { comparison, slugs, differencesOnly } = loaderData;
  const { models } = comparison;
  const rows = differencesOnly ? comparison.specs.filter((row) => row.differs) : comparison.specs;
  const options = [{ value: "", label: "—" }, ...comparison.all.map((entry) => ({ value: entry.slug, label: entry.label }))];

  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("compare.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("compare.lead")}</p>
      </header>

      <Form method="get" className="adm-section grid items-end gap-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto]" preventScrollReset>
        {[0, 1, 2, 3].map((index) => (
          <Select key={index} name="m" label={t("compare.device", { n: f.number(index + 1) })} defaultValue={slugs[index] ?? ""} options={options} />
        ))}
        <div className="grid gap-2">
          <Checkbox name="diff" value="1" label={t("compare.onlyDifferent")} defaultChecked={differencesOnly} />
          <Key type="submit" variant="ink" icon="scales">
            {t("compare.run")}
          </Key>
        </div>
      </Form>

      {models.length < 2 ? (
        <EmptyState icon="scales" title={t("compare.empty")} />
      ) : (
        <>
          <section className="adm-section" aria-labelledby="compare-specs">
            <h2 id="compare-specs" className="adm-h2">
              {t("editor.specs")}
            </h2>
            {rows.length === 0 ? (
              <p className="type-caption text-ink-2">{t("compare.noSpecs")}</p>
            ) : (
              <div className="overflow-x-auto rounded-sm border border-line" role="region" aria-labelledby="compare-specs" tabIndex={0}>
                <table className="table min-w-[40rem]">
                  <thead>
                    <tr>
                      <th scope="col" className="w-48">
                        {t("compare.spec")}
                      </th>
                      {models.map((model) => (
                        <th key={model.id} scope="col">
                          <Link to={`/admin/catalog/devices/${model.id}`} className="adm-link">
                            {model.name}
                          </Link>
                          <span className="block type-caption font-normal text-ink-2">
                            {model.platform}
                            {model.generation ? ` › ${model.generation}` : ""}
                            {model.releasedOn ? ` · ${model.releasedOn}` : ""}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr key={row.key} aria-selected={row.differs || undefined}>
                        <th scope="row" className="align-top font-semibold">
                          <span className="grid gap-0.5 py-2">
                            <span>{row.label}</span>
                            <span className="type-caption font-normal text-ink-2">{row.differs ? t("compare.differs") : t("compare.same")}</span>
                          </span>
                        </th>
                        {row.values.map((value, index) => (
                          <td key={index} className="max-w-[18rem] py-2 align-top">
                            {value ?? <span className="text-ink-2">{t("compare.missing")}</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="adm-section" aria-labelledby="compare-compat">
            <div className="grid gap-1">
              <h2 id="compare-compat" className="adm-h2">
                {t("compare.compat")}
              </h2>
              <p className="type-caption text-ink-2">{t("compare.compatLead")}</p>
            </div>
            {comparison.compatibility.length === 0 ? (
              <p className="type-caption text-ink-2">{t("compare.noCompat")}</p>
            ) : (
              <div className="overflow-x-auto rounded-sm border border-line" role="region" aria-labelledby="compare-compat" tabIndex={0} style={{ maxBlockSize: "min(70dvh, 720px)" }}>
                <table className="table min-w-[40rem]">
                  <thead>
                    <tr>
                      <th scope="col">{t("compare.product")}</th>
                      {models.map((model) => (
                        <th key={model.id} scope="col">
                          {model.name}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th scope="row" className="font-semibold">
                        {t("compare.totals")}
                      </th>
                      {comparison.totals.map((total, index) => (
                        <td key={index} className="py-2 type-caption">
                          <span className="grid gap-0.5">
                            <span className="text-ok">
                              {t("compat.statuses.verified")}: <bdi className="nums">{f.number(total.verified)}</bdi>
                            </span>
                            <span>
                              {t("compat.statuses.partial")}: <bdi className="nums">{f.number(total.partial)}</bdi>
                            </span>
                            <span className="text-red-ink">
                              {t("compat.statuses.incompatible")}: <bdi className="nums">{f.number(total.incompatible)}</bdi>
                            </span>
                            <span className="text-ink-2">
                              {t("compat.statuses.unverified")}: <bdi className="nums">{f.number(total.unverified + total.none)}</bdi>
                            </span>
                          </span>
                        </td>
                      ))}
                    </tr>
                    {comparison.compatibility.map((row) => (
                      <tr key={row.productId}>
                        <th scope="row" className="font-normal">
                          <span className="grid gap-0.5 py-1.5">
                            <Link to={`/admin/catalog/products/${row.productId}/compatibility`} className="adm-link">
                              {row.name}
                            </Link>
                            <span className="type-caption text-ink-2">{kindLabel(row.kind)}</span>
                          </span>
                        </th>
                        {row.statuses.map((status, index) => (
                          <td key={index}>{status ? <Status tone={COMPAT_TONE[status]}>{t(`compat.statuses.${status}`)}</Status> : <span className="text-ink-2" title={t("compat.statuses.unverified")}>{t("compare.noRule")}</span>}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </>
  );
}
