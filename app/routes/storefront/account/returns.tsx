import type { Route } from "./+types/returns";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { MotionLink, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listReturnableOrders, listReturnRequests } from "~/server/services/account/aftersales.server";
import { Key } from "~/ui/Key";
import { fillNodes } from "~/ui/PriceTag";
import { BidiText } from "~/ui/ProductCard";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";

/**
 * Returns, read-only: the store's general window, the delivered orders still inside it, and return requests (RMAs)
 * staff opened. There is no storefront return form yet, so the way to ask is support, with the order reference.
 */
export const handle = { nav: "push", order: sectionOrder("returns") } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const [returnable, requests] = await Promise.all([listReturnableOrders(db, customer.id, ctx.locale, ctx.now), listReturnRequests(db, customer.id)]);
  return { windowDays: returnable.windowDays, returnable: returnable.orders, requests };
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "returns");

const RMA_TONE: Record<string, StatusTone> = { requested: "warn", approved: "info", rejected: "bad", in_transit: "info", received: "info", inspected: "info", refunded: "ok", exchanged: "ok", repaired: "ok", closed: "neutral", cancelled: "neutral" };

export default function Returns({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const f = useFormat();
  return (
    <>
      <PageHead
        title={t("returns.title")}
        lead={
          <>
            {t("returns.lead", { count: loaderData.windowDays })}{" "}
            <TextLink as={LocaleLink} to="/policies/returns" inline>
              {t("returns.policy")}
            </TextLink>
          </>
        }
      />

      <section aria-labelledby="returns-how" className="panel grid gap-2 p-4">
        <h2 id="returns-how" className="type-sub text-ink">
          {t("returns.howTitle")}
        </h2>
        <p className="type-body text-ink-2">{t("returns.howText")}</p>
        <Key as={LocaleLink} to="/support" size="sm" icon="lifebuoy" className="justify-self-start">
          {t("returns.support")}
        </Key>
      </section>

      <Section id="eligible" title={t("returns.eligibleTitle")}>
        {loaderData.returnable.length === 0 ? (
          <p className="rounded-lg bg-niche p-4 type-body text-ink-2">{t("returns.eligibleEmpty")}</p>
        ) : (
          <ul className="grid gap-2">
            {loaderData.returnable.map((order) => (
              <li key={order.ref} className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-paper p-4">
                <div className="grid min-w-0 gap-0.5">
                  <MotionLink to={`/account/orders/${order.ref}`} nav="rise" className="type-strong text-ink underline-offset-4 hover:underline">
                    <BidiText text={order.firstItemName || order.ref} />
                  </MotionLink>
                  <span className="type-caption text-ink-2">
                    <bdi dir="ltr" className="nums">
                      {order.ref}
                    </bdi>{" "}
                    · {t("returns.until", { date: f.date(order.windowEndsAt) })}
                  </span>
                </div>
                <Key as={LocaleLink} to={`/support?order=${encodeURIComponent(order.ref)}&topic=return`} size="sm" icon="arrow-counter-clockwise" aria-label={t("returns.ask", { ref: order.ref })}>
                  {t("order.askReturn")}
                </Key>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="requests" title={t("returns.requestsTitle")}>
        {loaderData.requests.length === 0 ? (
          <p className="rounded-lg bg-niche p-4 type-body text-ink-2">{t("returns.requestsEmpty")}</p>
        ) : (
          <ul className="grid gap-2">
            {loaderData.requests.map((request) => (
              <li key={request.rma} className="grid gap-1 rounded-lg bg-paper p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="type-strong text-ink">
                    {fillNodes(t("returns.rma"), {
                      rma: (
                        <bdi key="rma" dir="ltr" className="nums">
                          {request.rma}
                        </bdi>
                      ),
                    })}
                  </h3>
                  <Status tone={RMA_TONE[request.status] ?? "neutral"}>{t(`returns.state.${request.status}`)}</Status>
                </div>
                <p className="type-caption text-ink-2">
                  {request.orderRef ? (
                    <>
                      {fillNodes(t("returns.forOrder"), {
                        ref: (
                          <bdi key="ref" dir="ltr" className="nums">
                            {request.orderRef}
                          </bdi>
                        ),
                      })}{" "}
                      ·{" "}
                    </>
                  ) : null}
                  {t("returns.opened", { date: f.date(request.createdAt) })}
                  {request.reasonCode ? <> · {t(`returns.reasons.${request.reasonCode === "other" ? "other_reason" : request.reasonCode}`)}</> : null}
                  {request.resolution ? <> · {t(`returns.resolutions.${request.resolution}`)}</> : null}
                </p>
                {request.rejectReason ? <p className="type-caption text-red-ink">{t("returns.rejected", { reason: request.rejectReason })}</p> : null}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
