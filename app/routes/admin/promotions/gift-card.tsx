import { useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/gift-card";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { getGiftCard, revealGiftCardCode, voidGiftCard } from "~/server/services/admin/promotions/giftcards.server";
import { SECTION_READ } from "~/server/services/admin/promotions/shared.server";
import { GIFT_CARD_STATUS_TONE } from "~/server/services/admin/promotions/types";
import { promotionsDataKey } from "./env.server";
import { promotionsMeta } from "./meta";
import { openPromotions, respond, runIntent, text } from "./promotions.server";
import { OnceCode } from "./gift-code";
import { ConfirmAction, DemoNote, Facts, History, Money, Notice, Section, ToneStatus, usePromotionsT, When, useProgram } from "./ui";

/**
 * /admin/promotions/gift-cards/:cardId — 08.07, one card: amount, balance, state, dates, who issued and redeemed it,
 * how often its code was revealed; revealing the code (promotions.gift_card.manage + digital_code.reveal, a reason,
 * audited, limited per employee) to print it again, and voiding an active card.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openPromotions(context, SECTION_READ.giftCards);
  try {
    return { card: await getGiftCard(db, actor, params.cardId, now, { dataKeyReady: Boolean(promotionsDataKey()) }) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openPromotions(context, "promotions.gift_card.manage");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { reveal: ["promotions.gift_card.manage", "digital_code.reveal"], void: ["promotions.gift_card.manage"] }, async (intent) => {
      if (intent === "reveal") return { ok: true, intent, ...(await revealGiftCardCode(db, session.actor, promotionsDataKey(), { cardId: params.cardId, reason: text(form, "reason") }, ctx.now)) };
      return { ok: true, intent, ...(await voidGiftCard(db, session.actor, { cardId: params.cardId, reason: text(form, "reason") }, ctx.now)) };
    }),
  );
}

export const meta: Route.MetaFunction = (args) => promotionsMeta(args, "gift.cardTitle", { hint: args.loaderData?.card.hint ?? "" });

export default function GiftCardPage({ loaderData }: Route.ComponentProps) {
  const program = useProgram();
  const t = usePromotionsT();
  const { card } = loaderData;
  const f = useFormat();
  const [code, setCode] = useState<string | null>(null);
  const active = card.status === "active" && card.balanceIqd > 0;
  return (
    <>
      <header className="adm-page-head prm-noprint">
        <p className="adm-eyebrow">
          <Link to="/admin/promotions/gift-cards" className="adm-link">
            {t("gift.title")}
          </Link>
        </p>
        <h1 className="adm-title">{t("gift.cardTitle", { hint: card.hint ?? "????" })}</h1>
        <div className="prm-actions">
          <ToneStatus tone={GIFT_CARD_STATUS_TONE[card.status]}>{t(`gift.status.${card.status}`)}</ToneStatus>
          <DemoNote show={card.isDemo} />
          <Money iqd={card.amountIqd} className="type-strong" />
        </div>
      </header>
      <div className="prm-layout">
        <div className="prm-main">
          {code ? <OnceCode code={code} amountIqd={card.amountIqd} /> : null}
          <Section id="prm-card-facts" title={t("gift.facts")} className="prm-noprint">
            <Facts
              rows={[
                { label: t("gift.col.amount"), value: <Money iqd={card.amountIqd} /> },
                { label: t("gift.col.balance"), value: <Money iqd={card.balanceIqd} /> },
                { label: t("gift.col.expires"), value: card.expiresAt ? <When at={card.expiresAt} /> : t("gift.noExpiry") },
                { label: t("gift.col.issued"), value: <>{card.createdBy ?? t("common.system")} · <When at={card.createdAt} /></> },
                {
                  label: t("gift.col.redeemed"),
                  value: card.redeemedAt ? (
                    <>
                      {card.can.seeProfile && card.redeemedByCustomerId ? (
                        <Link to={`/admin/customers/${card.redeemedByCustomerId}`} className="adm-link">
                          {card.redeemedBy ?? t("common.noName")}
                        </Link>
                      ) : (
                        (card.redeemedBy ?? t("common.noName"))
                      )}{" "}
                      · <When at={card.redeemedAt} />
                    </>
                  ) : (
                    t("gift.notRedeemed")
                  ),
                },
                { label: t("gift.col.note"), value: card.note ?? "—" },
                { label: t("gift.reveals"), value: t("gift.revealsValue", { count: card.reveals }) },
              ]}
            />
            {card.walletEntryId ? <Notice icon="wallet">{t("gift.inWallet")}</Notice> : null}
          </Section>
          <Section id="prm-card-history" title={t("common.history")} className="prm-noprint">
            <History rows={card.history} />
          </Section>
        </div>
        <aside className="prm-side prm-noprint" aria-label={t("common.side")}>
          <div className="prm-panel">
            <p className="adm-h3">{t("gift.code.title")}</p>
            <p className="type-body text-ink-2">{t("gift.code.what", { n: program.giftCard.revealLimit.limit })}</p>
            {!card.dataKeyReady ? <Notice tone="warn" icon="warning">{t("errors.data_key_missing")}</Notice> : null}
            {card.can.reveal ? (
              <ConfirmAction
                intent="reveal"
                label={t("gift.code.reveal")}
                title={t("gift.code.revealQ")}
                consequence={t("gift.code.revealWhat")}
                confirmLabel={t("gift.code.reveal")}
                disabled={!active || !card.dataKeyReady}
                icon="eye"
                doneKey="done.revealed"
                onDone={(result) => {
                  if (typeof result.code === "string") setCode(result.code);
                }}
              />
            ) : (
              <Notice icon="lock">{t("gift.code.noPermission")}</Notice>
            )}
            {!active ? <Notice>{t("gift.code.inactive")}</Notice> : null}
          </div>
          {card.can.manage && card.status === "active" ? (
            <div className="prm-panel">
              <p className="adm-h3">{t("gift.void.title")}</p>
              <ConfirmAction intent="void" label={t("gift.void.go")} title={t("gift.void.q")} consequence={t("gift.void.what")} confirmLabel={t("gift.void.go")} impact={[{ label: t("gift.settlement.outstanding"), value: `−${f.iqd(card.amountIqd)}`, negative: true }]} tone="destructive" icon="x-circle" doneKey="done.voided" />
            </div>
          ) : null}
        </aside>
      </div>
    </>
  );
}
