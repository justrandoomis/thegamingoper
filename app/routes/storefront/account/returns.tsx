import type { Route } from "./+types/returns";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { MotionLink, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listReturnableOrders, listReturnRequests } from "~/server/services/account/aftersales.server";
import { BidiText } from "~/ui/BidiText";
import { Key } from "~/ui/Key";
import { fillNodes } from "~/ui/PriceTag";
import { Status, type StatusTone } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { Notice } from "./components/FormBits";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { HANDOFF } from "./components/text";

/**
 * Returns, read-only: the store's general window and its policy, how to ask (a person, with the order number — the
 * site has no return form), the delivered orders still inside the window, and the return requests (RMAs) staff opened.
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
        lead={fillNodes(t("returns.lead", { count: loaderData.windowDays }), {
          // the policy's name is the link, inside the sentence (it was said twice: once in words, once as a link)
          policy: (
            <TextLink key="policy" as={LocaleLink} to="/policies/returns" inline>
              {t("returns.policy")}
            </TextLink>
          ),
        })}
      />

      <Notice title={t("returns.howTitle")}>
        <p>{t("returns.howText")}</p>
        <TextLink as={LocaleLink} to={HANDOFF} icon="chat-circle" arrow={false}>
          {t("common.talk")}
        </TextLink>
      </Notice>

      <Section id="eligible" title={t("returns.eligibleTitle")}>
        {loaderData.returnable.length === 0 ? (
          <p className="type-sm text-ink-2">{t("returns.eligibleEmpty")}</p>
        ) : (
          <ul className="acct-rows">
            {loaderData.returnable.map((order) => (
              <li key={order.ref} className="acct-row flex-wrap">
                <span className="acct-row__body">
                  <MotionLink to={`/account/orders/${order.ref}`} nav="rise" className="acct-row__title inline-flex min-h-11 items-center justify-self-start underline-offset-4 hover:underline">
                    <span>
                      <BidiText text={order.firstItemName || order.ref} />
                    </span>
                  </MotionLink>
                  <span className="acct-row__meta">
                    <bdi dir="ltr" className="nums">
                      {order.ref}
                    </bdi>{" "}
                    · {t("returns.until", { date: f.date(order.windowEndsAt, "long") })}
                  </span>
                </span>
                <Key as={LocaleLink} to={HANDOFF} size="sm" icon="arrow-counter-clockwise" aria-label={t("returns.ask", { ref: order.ref })}>
                  {t("order.askReturn")}
                </Key>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="requests" title={t("returns.requestsTitle")}>
        {loaderData.requests.length === 0 ? (
          <p className="type-sm text-ink-2">{t("returns.requestsEmpty")}</p>
        ) : (
          <ul className="acct-rows">
            {loaderData.requests.map((request) => (
              <li key={request.rma} className="acct-row items-start">
                <div className="acct-row__body">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <h3 className="acct-row__title">
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
                  <p className="acct-row__meta">
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
                    {t("returns.opened", { date: f.date(request.createdAt, "long") })}
                    {request.reasonCode ? <> · {t(`returns.reasons.${request.reasonCode === "other" ? "other_reason" : request.reasonCode}`)}</> : null}
                    {request.resolution ? <> · {t(`returns.resolutions.${request.resolution}`)}</> : null}
                  </p>
                  {request.rejectReason ? <p className="type-xs-strong text-danger">{t("returns.rejected", { reason: request.rejectReason })}</p> : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
