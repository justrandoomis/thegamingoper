import { useEffect, useRef } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/rewards";
import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getRewards, issueOwnReferralCode, type PointsEntryView } from "~/server/services/account/rewards.server";
import { isolate } from "~/ui/BidiText";
import { iqdText } from "~/ui/PriceTag";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { accountFailure, requireSignedIn } from "./account.server";
import { sectionOrder } from "./components/AccountNav";
import { CopyKey, FormFailure, Notice, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { ltr } from "./components/text";

/**
 * Points and membership (`/account/rewards`; module 08's programme, read for its owner — account/rewards.server):
 * the points balance and its worth, what expires within 30 days and the next expiry, the earn and expiry rules in
 * words (from the programme in force), the history; the active membership and what its tier gives at checkout (a
 * discount within the store's limits, free delivery, a points multiplier); the customer's referral code to share, or
 * «احصل على رمز إحالة» (module 08's issueReferralCode for the customer). Points are redeemed at the payment step.
 */
export const handle = { nav: "push", order: sectionOrder("rewards") } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  return { rewards: await getRewards(db, customer.id, ctx.locale, ctx.now) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireSignedIn(request, ctx, db);
  const form = await request.formData();
  if (form.get("intent") !== "referral") return data({ ok: false as const, code: "invalid" }, { status: 400 });
  try {
    const issued = await issueOwnReferralCode(db, actor, ctx.now);
    return data({ ok: true as const, done: "referral" as const, code: issued.code });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data(failure, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "rewards");

export default function Rewards({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const f = useFormat();
  const { points, membership, referral, referralRewardPoints } = loaderData.rewards;
  const pointsWord = (n: number) => t("rewards.referralPoints", { count: n, n: f.number(n) });
  const pct = (bps: number) => isolate(f.percent(bps / 10_000));

  return (
    <>
      <PageHead title={t("rewards.title")} lead={t("rewards.lead")} />

      <Section id="points" title={t("rewards.pointsTitle")}>
        <div className="acct-card grid gap-3">
          <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="type-h2 nums text-ink">{t("rewards.balance", { count: points.balance, n: f.number(points.balance) })}</span>
            {points.balance > 0 ? <span className="type-sm text-ink-2">{t("rewards.worth", { amount: isolate(iqdText(f, points.valueIqd)) })}</span> : null}
          </p>
          {points.expiringSoon > 0 ? (
            <p className="flex items-start gap-2 type-sm-strong text-warn">
              <Icon name="hourglass" size={16} className="mt-0.5 shrink-0" />
              <span>
                {t("rewards.expiringSoon", { count: points.expiringSoon, n: f.number(points.expiringSoon) })}
                {points.nextExpiryAt !== null ? <> {t("rewards.nextExpiry", { date: f.date(points.nextExpiryAt, "long") })}</> : null}
              </span>
            </p>
          ) : points.nextExpiryAt !== null ? (
            <p className="type-sm text-ink-2">{t("rewards.nextExpiry", { date: f.date(points.nextExpiryAt, "long") })}</p>
          ) : null}
          <p className="type-sm text-ink-2">{t("rewards.earn", { points: pointsWord(points.pointsPerThousandIqd) })}</p>
          <p className="type-sm text-ink-2">{t("rewards.expiry", { days: f.number(points.expiryDays) })}</p>
          {points.balance > 0 ? (
            <TextLink as={LocaleLink} to="/cart" className="justify-self-start">
              {t("rewards.use")}
            </TextLink>
          ) : null}
        </div>
        <h3 className="type-h3 text-ink pt-4">{t("rewards.historyTitle")}</h3>
        {points.entries.length === 0 ? (
          <p className="type-sm text-ink-2">{t("rewards.historyEmpty")}</p>
        ) : (
          <ul className="acct-rows">
            {points.entries.map((entry) => (
              <li key={entry.id} className="acct-row">
                <div className="acct-row__body">
                  <p className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="acct-row__title">{entryLabel(entry, t)}</span>
                    <span className={entry.points < 0 ? "type-sm-strong nums text-red-ink" : "type-sm-strong nums text-ink"} dir="ltr">
                      {entry.points > 0 ? "+" : "−"}
                      {f.number(Math.abs(entry.points))}
                    </span>
                  </p>
                  <p className="acct-row__meta">
                    {f.date(entry.at, "medium")}
                    {entry.orderRef ? <> · {t("rewards.order", { ref: ltr(entry.orderRef) })}</> : null}
                    {entry.points > 0 && entry.expiresAt !== null ? <> · {t("rewards.expiresOn", { date: f.date(entry.expiresAt, "medium") })}</> : null}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="membership" title={t("rewards.membershipTitle")}>
        {membership ? (
          <div className="acct-card grid gap-2">
            <p className="flex flex-wrap items-center gap-2">
              <Icon name="seal-check" size={20} className="text-ink" />
              <span className="type-card text-ink">{t("rewards.tier", { name: isolate(membership.tier) })}</span>
            </p>
            <p className="type-sm text-ink-2">{membership.endsAt !== null ? t("rewards.until", { date: f.date(membership.endsAt, "long") }) : t("rewards.noEnd")}</p>
            <ul className="grid gap-1 type-sm text-ink">
              {membership.discountBps !== null ? (
                <li className="flex items-start gap-2">
                  <Icon name="percent" size={16} className="mt-0.5 shrink-0" />
                  <span>
                    {/* the rate the checkout applies (never above the store's limits), and its per-order ceiling */}
                    {t("rewards.discount", { pct: pct(membership.appliedBps ?? membership.discountBps) })}
                    <span className="block type-xs text-ink-2">{t("rewards.discountCapped", { max: isolate(iqdText(f, membership.perOrderIqd)) })}</span>
                  </span>
                </li>
              ) : null}
              {membership.freeShipping ? (
                <li className="flex items-start gap-2">
                  <Icon name="truck" size={16} className="mt-0.5 shrink-0" />
                  <span>{t("rewards.freeShipping")}</span>
                </li>
              ) : null}
              {membership.multiplierBps !== null ? (
                <li className="flex items-start gap-2">
                  <Icon name="star" size={16} className="mt-0.5 shrink-0" />
                  <span>{t("rewards.multiplier", { x: f.number(membership.multiplierBps / 10_000) })}</span>
                </li>
              ) : null}
            </ul>
          </div>
        ) : (
          <p className="type-sm text-ink-2">{t("rewards.membershipNone")}</p>
        )}
      </Section>

      <Section id="referral" title={t("rewards.referralTitle")} reason={t("rewards.referralLead", { points: pointsWord(referral?.rewardPoints ?? referralRewardPoints) })}>
        <ReferralCode referral={referral} />
      </Section>
    </>
  );
}

function entryLabel(entry: PointsEntryView, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (entry.kind === "earn" && entry.refType === "referral") return t("rewards.kinds.earnReferral");
  // a redemption given back (a cancelled order, a refund) — module 08's reversal rows of ref "redeem"
  if (entry.kind === "reversal" && entry.refType === "redeem") return t("rewards.kinds.returned");
  return t(`rewards.kinds.${entry.kind}`);
}

function ReferralCode({ referral }: { referral: { code: string; uses: number; maxUses: number | null; active: boolean } | null }) {
  const t = useT("account");
  const f = useFormat();
  const fetcher = useFetcher<typeof action>();
  const handled = useRef<unknown>(null);
  const answer = (fetcher.data ?? null) as (ActionAnswer & { done?: string; code?: string }) | null;
  useEffect(() => {
    if (fetcher.state !== "idle" || !answer || handled.current === answer) return;
    handled.current = answer;
    if (answer.ok) toast.success(t("rewards.got"));
  }, [fetcher.state, answer, t]);

  if (!referral) {
    return (
      <fetcher.Form method="post" className="grid gap-2 justify-items-start">
        <input type="hidden" name="intent" value="referral" />
        <FormFailure answer={answer && !answer.ok ? answer : null} />
        <SubmitKey pending={fetcher.state !== "idle"} icon="share-network">
          {t("rewards.get")}
        </SubmitKey>
      </fetcher.Form>
    );
  }
  return (
    <div className="acct-card grid gap-2">
      <div className="acct-copy">
        <div className="grid min-w-0 gap-0.5">
          <span className="acct-copy__label">{t("rewards.code")}</span>
          <bdi dir="ltr" className="type-code text-ink">
            {referral.code}
          </bdi>
        </div>
        <CopyKey value={referral.code} label={t("rewards.copyCode")} />
      </div>
      <p className="type-sm text-ink-2">{referral.maxUses !== null ? t("rewards.uses", { uses: f.number(referral.uses), max: f.number(referral.maxUses) }) : t("rewards.usesOpen", { count: referral.uses, n: f.number(referral.uses) })}</p>
      {!referral.active ? (
        <Notice tone="warn">
          <Status tone="warn">{t("rewards.inactive")}</Status>
        </Notice>
      ) : null}
    </div>
  );
}
