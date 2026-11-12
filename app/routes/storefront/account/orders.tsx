import type { Route } from "./+types/orders";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listOrdersForCustomer } from "~/server/services/orders/manage.server";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { ShowMore } from "~/ui/Pagination";
import { TextLink } from "~/ui/TextLink";
import { requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { OrderRow } from "./components/OrderBits";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { usePagedList } from "./components/usePagedList";

/**
 * «طلباتي» (Design System v2 §6.12): rows with a 56px well, the order number, the date, the status in words and the
 * total — the commerce core's listOrdersForCustomer, newest first, 10 at a time («اعرض طلبات أقدم» appends).
 */
export const handle = { nav: "push", order: sectionOrder("orders") } satisfies MotionHandle;

const CURSOR = /^\d{1,16}:[A-Za-z0-9_.:-]{1,128}$/;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const cursor = new URL(request.url).searchParams.get("cursor");
  const orders = await listOrdersForCustomer(db, customer.id, ctx.locale, { cursor: cursor && CURSOR.test(cursor) ? cursor : null, limit: 10 });
  return { orders };
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "orders");

export default function Orders({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const list = usePagedList(loaderData.orders, (data: Awaited<ReturnType<typeof loader>>) => data.orders);
  return (
    <>
      <PageHead title={t("orders.title")} lead={list.items.length > 0 ? t("orders.lead") : undefined} />
      {list.items.length === 0 ? (
        <EmptyState
          layout="stack"
          title={t("orders.emptyTitle")}
          text={t("orders.emptyText")}
          action={
            <Key as={LocaleLink} to="/" variant="primary" icon="storefront">
              {t("orders.browse")}
            </Key>
          }
          recovery={
            <TextLink as={LocaleLink} to="/track">
              {t("orders.track")}
            </TextLink>
          }
        />
      ) : (
        <div className="grid gap-4">
          <ol className="acct-rows">
            {list.items.map((order) => (
              <li key={order.ref}>
                <OrderRow order={order} />
              </li>
            ))}
          </ol>
          {list.more || list.items.length > loaderData.orders.items.length ? <ShowMore shown={list.items.length} total={list.total} onMore={list.more} loading={list.loading} label={t("orders.showMore")} /> : null}
        </div>
      )}
    </>
  );
}
