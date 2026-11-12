import type { Route } from "./+types/warranties";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { MotionLink, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listWarranties } from "~/server/services/account/aftersales.server";
import { BidiText } from "~/ui/BidiText";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { fillNodes } from "~/ui/PriceTag";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { PageHead } from "./components/PageHead";
import { accountMeta } from "./components/meta";

/**
 * Warranties the store recorded at delivery (commerce core). Read-only; a claim goes to the repair request of the
 * support area.
 */
export const handle = { nav: "push", order: sectionOrder("warranties") } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  return { warranties: await listWarranties(db, customer.id, ctx.locale, ctx.now) };
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "warranties");

export default function Warranties({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const f = useFormat();
  return (
    <>
      <PageHead
        title={t("warranties.title")}
        lead={
          <>
            {t("warranties.lead")}{" "}
            <TextLink as={LocaleLink} to="/policies/warranty" inline>
              {t("warranties.policy")}
            </TextLink>
          </>
        }
      />
      {loaderData.warranties.length === 0 ? (
        <EmptyState layout="stack" title={t("warranties.emptyTitle")} text={t("warranties.emptyText")} />
      ) : (
        <ul className="grid gap-card md:grid-cols-2">
          {loaderData.warranties.map((warranty) => (
            <li key={warranty.id} className="grid">
              <article className="acct-card flex flex-col">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <h2 className="acct-card__title">
                    <BidiText text={warranty.itemName} />
                  </h2>
                  <Status tone={warranty.state === "active" ? "ok" : warranty.state === "void" ? "bad" : "neutral"}>{t(`warranties.state.${warranty.state}`)}</Status>
                </div>
                <div className="grid gap-1">
                  <p className="type-sm text-ink">{t("warranties.period", { from: f.date(warranty.startsAt, "long"), to: f.date(warranty.endsAt, "long") })}</p>
                  {warranty.orderRef ? (
                    <MotionLink to={`/account/orders/${warranty.orderRef}`} nav="rise" className="inline-flex min-h-11 items-center justify-self-start type-sm text-ink-2 underline underline-offset-4">
                      <span>
                        {fillNodes(t("warranties.order"), {
                          ref: (
                            <bdi key="ref" dir="ltr" className="nums">
                              {warranty.orderRef}
                            </bdi>
                          ),
                        })}
                      </span>
                    </MotionLink>
                  ) : null}
                  {warranty.terms ? <p className="type-xs text-ink-2">{warranty.terms}</p> : null}
                </div>
                {warranty.state === "active" ? (
                  <Key as={LocaleLink} to="/support/repair" size="sm" icon="wrench" className="mt-auto justify-self-start self-start" aria-label={t("warranties.claimNamed", { name: warranty.itemName })}>
                    {t("warranties.claim")}
                  </Key>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
