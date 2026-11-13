import { useRef } from "react";
import { Link, useLocation } from "react-router";

import type { Route } from "./+types/orders";
import { LocaleLink, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listOwnOrders } from "~/server/services/account/orders.server";
import { ORDER_GROUPS, orderShow, type OrderShow } from "~/server/services/account/types";
import { Chip } from "~/ui/Chip";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { ShowMore } from "~/ui/Pagination";
import { revealFocusedItem, useKeepInView } from "~/ui/reveal";
import { TextLink } from "~/ui/TextLink";
import { requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { OrderRow } from "./components/OrderBits";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { usePagedList } from "./components/usePagedList";

/**
 * «طلباتي» (Design System v2 §6.12; v2.1 — the client's reference «طلباتي»): filter chips by the order's state — «الكل
 * · قيد التنفيذ · سُلّمت · ملغاة ومُرجعة» with their counts (`?show=`, links: they work without script) — and each
 * order as a soft card that rises into it (its picture, number, state pill, what was bought, date and total). Newest
 * first, 10 at a time («اعرض طلبات أقدم» appends) — account/orders.server over the commerce core's rows.
 */
export const handle = { nav: "push", order: sectionOrder("orders") } satisfies MotionHandle;

const CURSOR = /^\d{1,16}:[A-Za-z0-9_.:-]{1,128}$/;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const url = new URL(request.url);
  const cursor = url.searchParams.get("cursor");
  const orders = await listOwnOrders(db, customer.id, ctx.locale, { show: orderShow(url.searchParams.get("show")), cursor: cursor && CURSOR.test(cursor) ? cursor : null, limit: 10 });
  return { orders };
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "orders");

const SHOWS: readonly OrderShow[] = ["all", ...ORDER_GROUPS];

export default function Orders({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const location = useLocation();
  const { orders } = loaderData;
  const list = usePagedList(orders, (data: Awaited<ReturnType<typeof loader>>) => data.orders);
  const show = orders.show;
  const none = orders.counts.all === 0;
  // the chosen chip stays in view in the sideways rail (phones), and so does the one the keyboard moves to
  const row = useRef<HTMLDivElement>(null);
  useKeepInView(row, "[aria-current]", show);
  return (
    <>
      <PageHead title={t("orders.title")} lead={none ? undefined : t("orders.lead")} />
      {none ? (
        <EmptyState
          layout="stack"
          panel
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
          <div ref={row} className="chips chips--rail chips--bleed" onFocus={revealFocusedItem} role="group" aria-label={t("orders.filters.label")}>
            {SHOWS.map((key) => (
              <Chip
                key={key}
                as={Link}
                to={{ pathname: location.pathname, search: key === "all" ? "" : `?show=${key}` }}
                replace
                preventScrollReset
                selected={show === key}
                count={orders.counts[key]}
              >
                {t(`orders.filters.${key}`)}
              </Chip>
            ))}
          </div>
          {list.items.length === 0 ? (
            <Note
              icon="package"
              action={
                <TextLink as={Link} to={{ pathname: location.pathname, search: "" }} replace preventScrollReset>
                  {t("orders.showAll")}
                </TextLink>
              }
            >
              {show === "all" ? t("orders.emptyTitle") : t(`orders.filterEmpty.${show}`)}
            </Note>
          ) : (
            <ol className="acct-orders">
              {list.items.map((order) => (
                <li key={order.ref} className="grid">
                  <OrderRow order={order} />
                </li>
              ))}
            </ol>
          )}
          {list.more || list.items.length > orders.items.length ? <ShowMore shown={list.items.length} total={list.total} onMore={list.more} loading={list.loading} label={t("orders.showMore")} /> : null}
        </div>
      )}
    </>
  );
}
