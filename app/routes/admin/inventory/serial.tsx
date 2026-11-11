import { Link } from "react-router";

import type { Route } from "./+types/serial";
import { throwAsResponse } from "~/server/errors";
import { getSerialHistory } from "~/server/services/admin/inventory/serials.server";
import { Status } from "~/ui/Tag";
import { Code, Money, Note, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, useInvT } from "./components/kit";
import { openInventory } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/serials/:serialId — one physical unit (inventory.serial.read): its variant, status and place, the
 * order lines it was ever attached to (at most one open — a serial is never sold twice), its every movement, and its
 * cost [P] for cost.read only.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "inventory.serial.read");
  try {
    return await getSerialHistory(db, actor, params.serialId, locale);
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "serials.title");

export default function SerialPage({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const { serial, attachments, movements } = loaderData;
  return (
    <>
      <p className="mb-2">
        <Link to="/admin/inventory/serials" className="adm-link type-label">
          {t("serial.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={
          <RowLink to={`/admin/inventory/stock/${serial.variant.id}`}>
            <Code>{serial.variant.sku}</Code> · {serial.variant.name}
          </RowLink>
        }
        title={
          <>
            {t("serial.title", { serial: "" })}
            <Code>{serial.serial}</Code>
          </>
        }
        actions={<StateTag group="serial" value={serial.status} label={t(`serialStatus.${serial.status}`)} />}
      />
      <div className="adm-card mb-6 grid gap-3 sm:grid-cols-3">
        <Pair label={t("common.location")}>{serial.locationCode ? <Code>{serial.locationCode}</Code> : serial.transferRef ? t("serial.inTransfer", { ref: serial.transferRef }) : "—"}</Pair>
        <Pair label={t("serial.registered")}>
          <When at={serial.createdAt} />
        </Pair>
        <Pair label={t("serial.source")}>
          {t(`sources.${serial.source}`)}
          {serial.usedUnit ? (
            <>
              {" "}
              <Status tone="neutral">{t("serials.usedDevice")}</Status>
            </>
          ) : null}
        </Pair>
        {serial.sourceRef ? (
          <Pair label={t("serial.sourceRef")}>
            <Code>{serial.sourceRef}</Code>
          </Pair>
        ) : null}
        {loaderData.costIqd !== undefined ? (
          <Pair label={t("serial.cost")}>
            <Money iqd={loaderData.costIqd} />
          </Pair>
        ) : null}
        {serial.notes ? <Pair label={t("serial.notes")}>{serial.notes}</Pair> : null}
      </div>

      <Section id="serial-orders" title={t("serial.orders")}>
        <Note icon="seal-check">{t("serial.soldOnce")}</Note>
        {attachments.length === 0 ? (
          <p className="type-body text-ink-2">{t("serial.noOrders")}</p>
        ) : (
          <ul role="list" className="grid gap-2">
            {attachments.map((entry) => (
              <li key={`${entry.orderRef}-${entry.attachedAt}`} className="adm-card flex flex-wrap items-center justify-between gap-2">
                <span className="type-strong">
                  <Code>{entry.orderRef}</Code> · {t(`orderStatus.${entry.orderStatus}`)}
                </span>
                <span className="type-caption text-ink-2">
                  {t("serial.attached", { time: "" })}
                  <When at={entry.attachedAt} />
                  {entry.releasedAt ? (
                    <>
                      {" · "}
                      {t("serial.releasedAt", { time: "" })}
                      <When at={entry.releasedAt} />
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="serial-history" title={t("serial.history")}>
        {/* the unit's rows of the movement log reach only holders of inventory.movement.read */}
        {movements === undefined ? (
          <Note>{t("serial.historyHidden")}</Note>
        ) : (
          <ResponsiveList
            caption={t("serial.history")}
            rows={movements}
            rowKey={(row) => row.id}
            columns={[
              { key: "at", header: t("common.when"), cell: (row) => <When at={row.at} /> },
              { key: "kind", header: t("movements.kind"), cell: (row) => t(`kinds.${row.kind}`) },
              { key: "location", header: t("common.location"), cell: (row) => <Code>{row.locationCode}</Code> },
              { key: "qty", header: t("movements.change"), numeric: true, cell: (row) => <Num value={row.qtyDelta} signed />, negative: (row) => row.qtyDelta < 0 },
              { key: "ref", header: t("common.reference"), cell: (row) => (row.refType ? <span>{t(`refTypes.${row.refType}`)} {row.refLabel ? <Code>{row.refLabel}</Code> : null}</span> : "—") },
              { key: "reason", header: t("common.reason"), cell: (row) => <span className="line-clamp-2 min-w-[12rem]">{row.reason ?? "—"}</span> },
              { key: "by", header: t("common.by"), cell: (row) => row.actor.name ?? t(`actorKinds.${row.actor.kind}`) },
              ...(movements.some((row) => row.unitCostIqd !== undefined) ? [{ key: "cost", header: t("movements.unitCost"), numeric: true, cell: (row: (typeof movements)[number]) => <Num value={row.unitCostIqd ?? null} /> }] : []),
            ]}
            card={(row) => (
              <>
                <p className="type-strong">
                  {t(`kinds.${row.kind}`)} · <Num value={row.qtyDelta} signed /> · <Code>{row.locationCode}</Code>
                </p>
                <p className="type-caption text-ink-2">{row.reason ?? "—"}</p>
                <Pair label={t("common.when")}>
                  <When at={row.at} />
                </Pair>
              </>
            )}
            empty={<p className="type-body text-ink-2">{t("serial.noHistory")}</p>}
          />
        )}
      </Section>
    </>
  );
}
