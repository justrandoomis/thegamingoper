import { useEffect, type ReactNode } from "react";
import { data, useFetcher, useRevalidator } from "react-router";

import type { Route } from "./+types/overview";
import { Icon, type IconName } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { MotionLink, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getConsent } from "~/server/services/account/preferences.server";
import { getProfile } from "~/server/services/account/profile.server";
import { clearRecentlyViewed, listRecentlyViewed } from "~/server/services/account/recently-viewed.server";
import { listOrdersForCustomer } from "~/server/services/orders/manage.server";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { Price } from "~/ui/Price";
import { iqdText, isIqd } from "~/ui/PriceTag";
import { ProductCard } from "~/ui/ProductCard";
import { Rail } from "~/ui/Rail";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { VisuallyHidden } from "~/ui/VisuallyHidden";
import { accountFailure, deviceConsent, formFields, requireSignedIn } from "./account.server";
import { AccountNav, SignOut } from "./components/AccountNav";
import { rescueFocus } from "./components/FormBits";
import { navHints } from "./components/hints";
import { OrderRow } from "./components/OrderBits";
import { Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { amount } from "./components/text";
import { handDeviceListToAccount } from "../home/personal";
import { useAccountData } from "./layout";

/**
 * The account's home (Design System v2 §6.12): a header card (name, number, member since), four quick tiles with icons
 * and counts (طلباتي · المحفظة · العناوين · أجهزتي), a first-steps checklist while there is something to set up (the
 * account's empty state, §6.17), the latest order, recently viewed (with consent), and — on phones, where there is no
 * side column — the grouped section list with a quiet «سجّل الخروج» at its end.
 */
export const handle = { nav: "push", order: 0 } satisfies MotionHandle;

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const [profile, orders, accountConsent] = await Promise.all([
    getProfile(db, customer.id),
    listOrdersForCustomer(db, customer.id, ctx.locale, { limit: 1 }),
    getConsent(db, { subjectType: "customer", subjectId: customer.id }, "personalization"),
  ]);
  // The account's answer wins; a device that agreed while the account never answered counts too.
  const consent = (accountConsent ?? deviceConsent(ctx)) === true;
  const recent = consent ? await listRecentlyViewed(db, { customerId: customer.id, cartToken: null }, ctx.locale, ctx.now, 8) : [];
  return { memberSince: profile?.createdAt ?? null, lastOrder: orders.items[0] ?? null, consent, recent };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const fields = formFields(await request.formData());
  try {
    if (fields.intent === "clearHistory") {
      await clearRecentlyViewed(db, { customerId: customer.id, cartToken: null });
      return data({ ok: true as const, done: "cleared" as const });
    }
    return data({ ok: false as const, code: "invalid" }, { status: 400 });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    return data(failure, { status: failure.status });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "overview");

/** The first letter of a name, for the header disc (Latin or Arabic script alike); null without a name. */
function initialOf(name: string | null | undefined): string | null {
  const first = name?.trim().match(/\p{L}/u)?.[0];
  return first ? first.toLocaleUpperCase() : null;
}

export default function Overview({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const f = useFormat();
  const account = useAccountData();
  const clear = useFetcher<typeof action>();
  const online = useOnline();
  const revalidator = useRevalidator();
  // One recently-viewed store (home/personal): what this device remembers from before signing in joins the account
  // once, then leaves the device; the list below is read again when something joined.
  const consent = loaderData.consent;
  useEffect(() => {
    if (!consent) return;
    void handDeviceListToAccount().then((joined) => {
      if (joined) void revalidator.revalidate();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per visit of the overview
  }, [consent]);
  const cleared = clear.data?.ok === true;
  // «امسح السجل» goes with the list it cleared: focus lands on the sentence that says so, not on <body>.
  useEffect(() => {
    if (cleared) rescueFocus("recent-cleared");
  }, [cleared]);
  if (!account) return null;
  const { customer, counts, wallet, phoneCodes } = account;
  const recent = cleared ? [] : loaderData.recent;
  const initial = initialOf(customer.name);

  const tiles: { key: string; to: string; order: number; icon: IconName; name: string; value: ReactNode }[] = [
    { key: "orders", to: "/account/orders", order: 1, icon: "package", name: t("nav.orders"), value: counts.openOrders > 0 ? t("overview.openOrders", { count: counts.openOrders }) : t("overview.hintOrders", { count: counts.orders }) },
    {
      key: "wallet",
      to: "/account/wallet",
      order: 2,
      icon: "wallet",
      name: t("nav.wallet"),
      value: (
        <>
          <Price amountIqd={wallet.balanceIqd} size="md" approx="off" as="span" />
          {isIqd(wallet.pendingIqd) && wallet.pendingIqd > 0 ? <span className="block">{t("overview.walletPending", { amount: amount(iqdText(f, wallet.pendingIqd)) })}</span> : null}
        </>
      ),
    },
    { key: "addresses", to: "/account/addresses", order: 3, icon: "map-pin", name: t("nav.addresses"), value: t("overview.hintAddresses", { count: counts.addresses }) },
    { key: "devices", to: "/account/devices", order: 4, icon: "game-controller", name: t("nav.devices"), value: t("overview.hintDevices", { count: counts.savedDevices }) },
  ];

  const steps = [
    { key: "address", done: counts.addresses > 0, title: t("overview.stepAddress"), text: t("overview.stepAddressText"), go: t("overview.stepAddressGo"), to: "/account/addresses?new=1", order: 3 },
    { key: "device", done: counts.savedDevices > 0, title: t("overview.stepDevice"), text: t("overview.stepDeviceText"), go: t("overview.stepDeviceGo"), to: "/account/devices", order: 4 },
  ];
  const remaining = steps.filter((step) => !step.done).length;

  return (
    <>
      <header className="acct-card">
        <div className="acct-hello">
          <span className="acct-hello__mark" aria-hidden="true">
            {initial ?? <Icon name="user" size={28} />}
          </span>
          <div className="acct-hello__text">
            <h1 className="type-h1 text-ink">{customer.name ? t("overview.hello", { name: customer.name }) : t("overview.helloNoName")}</h1>
            <p className="acct-hello__line">
              <bdi dir="ltr" className="nums">
                {customer.phoneMasked}
              </bdi>
              {customer.phoneVerified ? (
                <Status tone="ok">{t("common.verified")}</Status>
              ) : phoneCodes ? (
                <TextLink as={LocaleLink} to="/account/settings#phone">
                  {t("overview.verifyPhone")}
                </TextLink>
              ) : null}
            </p>
            {loaderData.memberSince ? <p className="type-xs text-ink-2">{t("overview.memberSince", { date: f.date(loaderData.memberSince, "long") })}</p> : null}
          </div>
        </div>
      </header>

      <ul className="acct-tiles">
        {tiles.map((tile) => (
          <li key={tile.key} className="grid">
            <MotionLink to={tile.to} nav="push" order={tile.order} data-press="soft" className="acct-tile">
              <span className="acct-tile__icon" aria-hidden="true">
                <Icon name={tile.icon} size={22} />
              </span>
              <span className="acct-tile__name">{tile.name}</span>
              <span className="acct-tile__value">{tile.value}</span>
            </MotionLink>
          </li>
        ))}
      </ul>

      {remaining > 0 ? (
        <section aria-labelledby="first-steps-title" className="acct-card">
          <div className="grid gap-1">
            <h2 id="first-steps-title" className="acct-card__title">
              {t("overview.stepsTitle")}
            </h2>
            <p className="type-sm text-ink-2">{t("overview.stepsLead", { count: remaining })}</p>
          </div>
          <ol className="acct-steps">
            {steps.map((step) => (
              <li key={step.key} className="acct-step" data-done={step.done ? "" : undefined}>
                <span className="acct-step__mark" aria-hidden="true">
                  {step.done ? <Icon name="check" size={14} /> : null}
                </span>
                <span className="acct-step__title">
                  {step.title}
                  {step.done ? <VisuallyHidden>{` (${t("overview.stepDone")})`}</VisuallyHidden> : null}
                </span>
                <span className="acct-step__text">{step.text}</span>
                {step.done ? null : (
                  <TextLink as={MotionLink} nav="push" order={step.order} to={step.to}>
                    {step.go}
                  </TextLink>
                )}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {loaderData.lastOrder ? (
        <Section id="last-order" title={t("overview.lastOrder")} href="/account/orders" linkLabel={t("overview.allOrders")}>
          <div className="acct-rows">
            <OrderRow order={loaderData.lastOrder} />
          </div>
        </Section>
      ) : null}

      <Section id="sections" title={t("overview.sections")} className="lg:hidden">
        <AccountNav variant="list" hints={navHints(t, f, account)} />
        <SignOut className="acct-signout--list mt-2" />
      </Section>

      {loaderData.consent && (recent.length > 0 || cleared) ? (
        <Section
          id="recent"
          title={t("overview.recentTitle")}
          reason={cleared ? undefined : t("overview.recentReason")}
          action={
            recent.length > 0 ? (
              <clear.Form method="post">
                <input type="hidden" name="intent" value="clearHistory" />
                <Key type="submit" size="sm" variant="ghost" icon="trash" loading={clear.state !== "idle"} disabled={!online}>
                  {t("overview.recentClear")}
                </Key>
              </clear.Form>
            ) : null
          }
        >
          {recent.length > 0 ? (
            <Rail aria-labelledby="recent-title">
              {recent.map((card) => (
                <ProductCard key={card.id} card={card} slot="recent" />
              ))}
            </Rail>
          ) : (
            <p id="recent-cleared" tabIndex={-1} role="status" className="type-sm text-ink-2">
              {t("overview.recentCleared")}
            </p>
          )}
        </Section>
      ) : null}
    </>
  );
}
