import type { Route } from "./+types/oversell";
import { listOversell } from "~/server/services/admin/inventory/stock.server";
import { Code, Note, Num, PageHead, Pair, ResponsiveList, RowLink, Section, When, useInvT } from "./components/kit";
import { openInventory } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/oversell — selling into negative stock (04.09): the rules (checkout never oversells, the database
 * refuses it, only an explicit and authorised exception with a reason allows it, and it closes itself when the stock
 * is whole), the levels that are negative now, and the history of every authorised exception with who and why.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "inventory.stock.read");
  return await listOversell(db, actor, locale);
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "oversell.title");

export default function Oversell({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const { levels, authorizations } = loaderData;
  return (
    <>
      <PageHead title={t("oversell.title")} lead={t("oversell.lead")} />
      <Note icon="shield-check" className="mb-6">
        <strong className="type-strong">{t("oversell.rules")}</strong>
        <ul className="grid list-disc gap-1 ps-5">
          <li>{t("oversell.rule1")}</li>
          <li>{t("oversell.rule2")}</li>
          <li>{t("oversell.rule3")}</li>
          <li>{t("oversell.rule4")}</li>
        </ul>
      </Note>

      <Section id="oversell-now" title={t("oversell.current")}>
        <ResponsiveList
          caption={t("oversell.current")}
          rows={levels}
          rowKey={(row) => `${row.variant.id}@${row.location.id}`}
          columns={[
            { key: "sku", header: t("common.sku"), cell: (row) => <RowLink to={`/admin/inventory/stock/${row.variant.id}`}><Code>{row.variant.sku}</Code></RowLink> },
            { key: "name", header: t("common.product"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.variant.name}</span> },
            { key: "location", header: t("common.location"), cell: (row) => <Code>{row.location.path}</Code> },
            { key: "onHand", header: t("common.onHand"), numeric: true, cell: (row) => <Num value={row.onHand} /> },
            { key: "reserved", header: t("common.reserved"), numeric: true, cell: (row) => <Num value={row.reserved} /> },
            { key: "free", header: t("common.free"), numeric: true, cell: (row) => <Num value={row.free} />, negative: (row) => row.free < 0 },
            { key: "flag", header: t("common.status"), cell: (row) => (row.allowOversell ? t("oversell.flag") : "—") },
          ]}
          card={(row) => (
            <>
              <p className="type-strong">{row.variant.name}</p>
              <p className="type-caption text-ink-2">
                <Code>{row.variant.sku}</Code> · <Code>{row.location.path}</Code>
              </p>
              <Pair label={t("common.free")}>
                <Num value={row.free} />
              </Pair>
            </>
          )}
          empty={<p className="adm-card type-body text-ink-2">{t("oversell.noCurrent")}</p>}
        />
      </Section>

      <Section id="oversell-history" title={t("oversell.history")}>
        <ResponsiveList
          caption={t("oversell.history")}
          rows={authorizations}
          rowKey={(row) => row.id}
          columns={[
            { key: "at", header: t("common.when"), cell: (row) => <When at={row.at} /> },
            { key: "sku", header: t("common.sku"), cell: (row) => <RowLink to={`/admin/inventory/stock/${row.variantId}`}><Code>{row.sku}</Code></RowLink> },
            { key: "location", header: t("common.location"), cell: (row) => <Code>{row.locationCode}</Code> },
            { key: "change", header: t("oversell.change"), numeric: true, cell: (row) => <Num value={row.delta} signed />, negative: (row) => row.delta < 0 },
            { key: "after", header: t("common.status"), cell: (row) => t("oversell.after", { onHand: row.onHandAfter ?? "—", reserved: row.reservedAfter ?? "—" }) },
            { key: "reason", header: t("common.reason"), cell: (row) => <span className="line-clamp-3 min-w-[14rem]">{row.reason ?? "—"}</span> },
            { key: "by", header: t("common.by"), cell: (row) => row.actor ?? "—" },
          ]}
          card={(row) => (
            <>
              <p className="type-strong">
                <Code>{row.sku}</Code> · <Num value={row.delta} signed />
              </p>
              <p className="type-body">{row.reason ?? "—"}</p>
              <Pair label={t("common.by")}>{row.actor ?? "—"}</Pair>
              <Pair label={t("common.when")}>
                <When at={row.at} />
              </Pair>
            </>
          )}
          empty={<p className="adm-card type-body text-ink-2">{t("oversell.noHistory")}</p>}
        />
      </Section>
    </>
  );
}
