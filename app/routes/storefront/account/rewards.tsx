import { useEffect, useRef } from "react";
import { data, Link, useFetcher, useLocation, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/rewards";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { CountUp, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getRewards, issueOwnReferralCode, type RewardsView } from "~/server/services/account/rewards.server";
import { isolate } from "~/ui/BidiText";
import { Chip } from "~/ui/Chip";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { iqdText } from "~/ui/PriceTag";
import { revealFocusedItem, useKeepInView } from "~/ui/reveal";
import { toast } from "~/ui/toast-store";
import { accountFailure, requireSignedIn } from "./account.server";
import { ActivityList, MetaLine, orderRefText, type ActivityItem } from "./components/Activity";
import { sectionOrder } from "./components/AccountNav";
import { CopyKey, FormFailure, Notice, SubmitKey, type ActionAnswer } from "./components/FormBits";
import { MoneyCard } from "./components/MoneyCard";
import { PageHead, Section } from "./components/PageHead";
import { QuickTiles } from "./components/QuickTiles";
import { accountMeta } from "./components/meta";
import { inPointsFilter, POINTS_FILTERS, pointsFilter, pointsFilterCounts, pointsLook, signedText, type PointsFilter } from "./components/rewards-view";
import { amount } from "./components/text";

/**
 * Points and membership (`/account/rewards`; module 08's programme, read for its owner — account/rewards.server), Design
 * v2.1 (client note 12; the reference cards «محفظتي» and «حسابي»):
 *
 *   - the points card: the glossy wallet band, the balance in Kufam counted up once, what it is worth in IQD at the
 *     programme's point value, and the next date points really expire (or what expires within 30 days);
 *   - quick tiles: use them at checkout (the cart), the referral code, the membership (anchors on this page);
 *   - «كيف تكسب نقاطك وتستبدلها»: the programme's real rules as an icon strip — points per 1,000 IQD, a point's worth,
 *     the expiry and the referral reward, all from the settings in force (nothing invented);
 *   - the history (the newest 50): a disc tinted by kind, + green / − red, the order a row belongs to (one link into it),
 *     and filter chips «الكل · المكتسبة · المستخدمة · المنتهية» with their counts (`?show=`: links, so they work
 *     without script; changing one reads nothing again);
 *   - the membership as the checkout applies it (or a quiet note: the store grants memberships), and the referral
 *     code to copy and share (the Web Share sheet, or the invitation copied) — or «احصل على رمز إحالة» (module 08's
 *     issueReferralCode for the customer).
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

/**
 * A filter chip is a view of the same history: moving between them reads nothing again. Anything else — a post, an
 * explicit revalidation, the same address asked for again (a refresh) — reads as usual.
 */
export function shouldRevalidate({ currentUrl, nextUrl, formMethod, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (!formMethod && currentUrl.pathname === nextUrl.pathname && currentUrl.search !== nextUrl.search) {
    const before = new URLSearchParams(currentUrl.search);
    const after = new URLSearchParams(nextUrl.search);
    before.delete("show");
    after.delete("show");
    if (before.toString() === after.toString()) return false;
  }
  return defaultShouldRevalidate;
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "rewards");

export default function Rewards({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const f = useFormat();
  const [params] = useSearchParams();
  const { points, membership, referral, referralRewardPoints } = loaderData.rewards;
  const filter = pointsFilter(params.get("show"));
  const iqd = (value: number) => amount(iqdText(f, value));

  const expiry =
    points.expiringSoon > 0 ? (
      <>
        <Icon name="hourglass" size={18} />
        <span>
          {t("rewards.expiringSoon", { count: points.expiringSoon, n: f.number(points.expiringSoon) })}
          {points.nextExpiryAt !== null ? <> {t("rewards.nextExpiry", { date: f.date(points.nextExpiryAt, "long") })}</> : null}
        </span>
      </>
    ) : points.nextExpiryAt !== null ? (
      <>
        <Icon name="hourglass" size={18} />
        <span>{t("rewards.nextExpiry", { date: f.date(points.nextExpiryAt, "long") })}</span>
      </>
    ) : null;

  return (
    <>
      <PageHead title={t("rewards.title")} lead={t("rewards.lead")} />

      <div className="acct-hero glow glow--wide">
        <MoneyCard
          id="points-card"
          label={t("rewards.cardLabel")}
          icon="star"
          figure={
            <>
              <CountUp value={points.balance} format={f.number} className="acct-money__num" />
              <span className="acct-money__unit">{t("rewards.unit", { count: points.balance })}</span>
            </>
          }
          line={points.balance > 0 ? t("rewards.worth", { amount: iqd(points.valueIqd) }) : t("rewards.zeroHint")}
          foot={expiry}
        />
        <QuickTiles
          label={t("rewards.actions.label")}
          tiles={[
            // nothing to use yet: no tile that leads to the cart for it
            ...(points.balance > 0 ? [{ key: "use", icon: "shopping-cart-simple" as const, label: t("rewards.actions.use"), to: "/cart" }] : []),
            { key: "referral", icon: "share-network", label: t("rewards.actions.referral"), href: "#referral" },
            { key: "membership", icon: "seal-check", label: t("rewards.actions.membership"), href: "#membership" },
          ]}
        />
      </div>

      <Rules points={points} referralRewardPoints={referral?.rewardPoints ?? referralRewardPoints} />

      <div className="acct-pair">
        <History entries={points.entries} filter={filter} />
        <div className="acct-side-cards">
          <Section id="membership" anchor reveal title={t("rewards.membershipTitle")}>
            <Membership membership={membership} />
          </Section>
          <Section id="referral" anchor reveal title={t("rewards.referralTitle")}>
            <ReferralCode referral={referral} rewardPoints={referral?.rewardPoints ?? referralRewardPoints} />
          </Section>
        </div>
      </div>
    </>
  );
}

/**
 * «كيف تكسب نقاطك وتستبدلها»: the programme in force as (up to) four facts with their icons — what a purchase earns,
 * what a point is worth, how long points last, what a referral brings. Every number is the store's setting; a rule the
 * store set to 0 is left out.
 */
function Rules({ points, referralRewardPoints }: { points: RewardsView["points"]; referralRewardPoints: number }) {
  const t = useT("account");
  const f = useFormat();
  const count = (n: number) => t("rewards.pointsCount", { count: n, n: f.number(n) });
  // a rule the store set to 0 (a paused earn rate or referral reward) gives nothing: it is left out, never «لا نقاط لكل …»
  const all: { key: string; icon: IconName; title: string; text: string; on: boolean }[] = [
    { key: "earn", icon: "shopping-bag", title: t("rewards.rules.earnTitle", { points: count(points.pointsPerThousandIqd), amount: amount(iqdText(f, 1_000)) }), text: t("rewards.rules.earnText"), on: points.pointsPerThousandIqd > 0 },
    { key: "value", icon: "coins", title: t("rewards.rules.valueTitle", { amount: amount(iqdText(f, points.pointValueIqd)) }), text: t("rewards.rules.valueText"), on: points.pointValueIqd > 0 },
    { key: "expiry", icon: "hourglass", title: t("rewards.rules.expiryTitle", { count: points.expiryDays, n: f.number(points.expiryDays) }), text: t("rewards.rules.expiryText"), on: points.expiryDays > 0 },
    { key: "referral", icon: "users", title: t("rewards.rules.referralTitle", { points: count(referralRewardPoints) }), text: t("rewards.rules.referralText"), on: referralRewardPoints > 0 },
  ];
  const rules = all.filter((rule) => rule.on);
  return (
    <Section id="rules" title={t("rewards.rules.title")} reason={t("rewards.rules.reason")}>
      <ul className="acct-rules" data-reveal="stagger">
        {rules.map((rule) => (
          <li key={rule.key} className="acct-rule">
            <span className="clay-disc" aria-hidden="true">
              <Icon name={rule.icon} size={22} />
            </span>
            <p className="acct-rule__title">{rule.title}</p>
            <p className="acct-rule__text">{rule.text}</p>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The history with its filter chips (links to `?show=…`; the list settles in when a chip changes it). */
function History({ entries, filter }: { entries: RewardsView["points"]["entries"]; filter: PointsFilter }) {
  const t = useT("account");
  const f = useFormat();
  const location = useLocation();
  const counts = pointsFilterCounts(entries);
  const shown = entries.filter((entry) => inPointsFilter(entry, filter));
  // the chosen chip stays in view in the sideways rail (phones), and so does the one the keyboard moves to
  const row = useRef<HTMLDivElement>(null);
  useKeepInView(row, "[aria-current]", filter);
  // the list settles in only after a chip changed it — never on the first paint
  const first = useRef(filter);
  const moved = useRef(false);
  if (filter !== first.current) moved.current = true;

  const items: ActivityItem[] = shown.map((entry) => {
    const look = pointsLook(entry);
    const signed = signedText(entry.points, f.number);
    return {
      id: entry.id,
      icon: look.icon,
      tone: look.tone,
      title: t(`rewards.kinds.${look.key}`),
      // when and for which order (whole parts of one line — never a dot left at a line's end), then when these points expire
      meta: (
        <>
          <MetaLine parts={[<time key="at" dateTime={new Date(entry.at).toISOString()}>{f.date(entry.at, "medium")}</time>, entry.orderRef ? orderRefText(t, entry.orderRef) : null]} />
          {entry.points > 0 && entry.expiresAt !== null ? <span className="block">{t("rewards.expiresOn", { date: f.date(entry.expiresAt, "medium") })}</span> : null}
        </>
      ),
      amount: <bdi dir="ltr">{signed.text}</bdi>,
      sign: signed.sign,
      to: entry.orderRef ? `/account/orders/${entry.orderRef}` : undefined,
    };
  });

  return (
    <Section id="history" anchor title={t("rewards.historyTitle")}>
      {entries.length === 0 ? (
        <Note icon="star" title={t("rewards.historyEmptyTitle")}>
          {t("rewards.historyEmptyText")}
        </Note>
      ) : (
        <div className="grid gap-3">
          <div ref={row} className="chips chips--rail chips--bleed" onFocus={revealFocusedItem} role="group" aria-label={t("rewards.filters.label")}>
            {POINTS_FILTERS.map((key) => (
              <Chip
                key={key}
                as={Link}
                to={{ pathname: location.pathname, search: key === "all" ? "" : `?show=${key}` }}
                replace
                preventScrollReset
                selected={filter === key}
                count={counts[key]}
              >
                {t(`rewards.filters.${key}`)}
              </Chip>
            ))}
          </div>
          {items.length === 0 ? (
            <p key={filter} className={moved.current ? "acct-settle type-read text-ink-2" : "type-read text-ink-2"}>
              {t(`rewards.filterEmpty.${filter}`)}
            </p>
          ) : (
            <ActivityList key={filter} items={items} label={t("rewards.historyTitle")} className={moved.current ? "acct-settle" : undefined} />
          )}
          {entries.length >= 50 ? <p className="type-xs text-ink-2">{t("rewards.historyLimited")}</p> : null}
        </div>
      )}
    </Section>
  );
}

/** The active membership as the checkout applies it, or a quiet note (the store grants memberships). */
function Membership({ membership }: { membership: RewardsView["membership"] }) {
  const t = useT("account");
  const f = useFormat();
  if (!membership) {
    return (
      <Note icon="seal-check" title={t("rewards.membershipNoneTitle")}>
        {t("rewards.membershipNoneText")}
      </Note>
    );
  }
  const pct = (bps: number) => isolate(f.percent(bps / 10_000));
  const benefits: { key: string; icon: IconName; title: string; text?: string }[] = [];
  if (membership.discountBps !== null) {
    // the rate the checkout applies (never above the store's limits), and its per-order ceiling
    benefits.push({ key: "discount", icon: "percent", title: t("rewards.discount", { pct: pct(membership.appliedBps ?? membership.discountBps) }), text: t("rewards.discountCapped", { max: isolate(iqdText(f, membership.perOrderIqd)) }) });
  }
  if (membership.freeShipping) benefits.push({ key: "shipping", icon: "truck", title: t("rewards.freeShipping") });
  if (membership.multiplierBps !== null) benefits.push({ key: "multiplier", icon: "star", title: t("rewards.multiplier", { x: f.number(membership.multiplierBps / 10_000) }) });
  return (
    <div className="acct-card">
      <div className="acct-member__head">
        <span className="clay-disc" aria-hidden="true">
          <Icon name="seal-check-fill" size={24} />
        </span>
        <p className="acct-member__name">{t("rewards.tier", { name: isolate(membership.tier) })}</p>
        <p className="acct-member__until">{membership.endsAt !== null ? t("rewards.until", { date: f.date(membership.endsAt, "long") }) : t("rewards.noEnd")}</p>
      </div>
      {benefits.length > 0 ? (
        <div className="grid gap-3 border-t border-line pt-4">
          <p className="type-sm-strong text-ink-2">{t("rewards.benefitsTitle")}</p>
          <ul className="acct-facts">
            {benefits.map((benefit) => (
              <li key={benefit.key} className="acct-fact">
                <span className="clay-disc" aria-hidden="true">
                  <Icon name={benefit.icon} size={20} />
                </span>
                <span className="acct-fact__title">{benefit.title}</span>
                {benefit.text ? <span className="acct-fact__text">{benefit.text}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function ReferralCode({ referral, rewardPoints }: { referral: RewardsView["referral"]; rewardPoints: number }) {
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
  const lead = t("rewards.referralLead", { points: t("rewards.referralPoints", { count: rewardPoints, n: f.number(rewardPoints) }) });

  if (!referral) {
    return (
      <div className="acct-card">
        <p className="type-read text-ink-2">{lead}</p>
        <fetcher.Form method="post" className="grid gap-2 justify-items-start">
          <input type="hidden" name="intent" value="referral" />
          <FormFailure answer={answer && !answer.ok ? answer : null} />
          <SubmitKey pending={fetcher.state !== "idle"} icon="share-network">
            {t("rewards.get")}
          </SubmitKey>
        </fetcher.Form>
      </div>
    );
  }
  return (
    <div className="acct-card">
      <p className="type-read text-ink-2">{lead}</p>
      <div className="acct-code">
        <div className="grid min-w-0 gap-0.5">
          <span className="acct-code__label">{t("rewards.code")}</span>
          <bdi dir="ltr" className="acct-code__value">
            {referral.code}
          </bdi>
        </div>
        <div className="acct-code__keys">
          <CopyKey value={referral.code} label={t("rewards.copyCode")} />
          {referral.active ? <ShareKey code={referral.code} /> : null}
        </div>
      </div>
      <p className="type-sm text-ink-2">{referral.maxUses !== null ? t("rewards.uses", { uses: f.number(referral.uses), max: f.number(referral.maxUses) }) : t("rewards.usesOpen", { count: referral.uses, n: f.number(referral.uses) })}</p>
      {!referral.active ? (
        <Notice tone="warn" flat>
          {t("rewards.inactive")}
        </Notice>
      ) : null}
    </div>
  );
}

/**
 * «شارك الرمز»: the device's share sheet with the invitation (the code and the store's address) where there is one;
 * elsewhere the invitation is copied, and a toast says so. Closing the share sheet is not a failure.
 */
function ShareKey({ code }: { code: string }) {
  const t = useT("account");
  const share = async () => {
    const text = t("rewards.shareText", { code });
    const url = window.location.origin;
    if (typeof navigator.share === "function") {
      try {
        await navigator.share({ text, url });
        return;
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(`${text} ${url}`);
      toast.success(t("rewards.shared"));
    } catch {
      // nothing to share with and nothing copied: the code itself is on screen with its copy key
    }
  };
  return (
    <Key size="sm" icon="share-network" onClick={() => void share()}>
      {t("rewards.share")}
    </Key>
  );
}
