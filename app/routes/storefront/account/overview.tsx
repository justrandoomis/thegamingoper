import { useEffect } from "react";
import { data, Form, useFetcher, useNavigation, useRevalidator } from "react-router";

import type { Route } from "./+types/overview";
import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useLocalePath, useT } from "~/i18n/react";
import { MotionLink, type MotionHandle } from "~/motion";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getConsent } from "~/server/services/account/preferences.server";
import { getProfile } from "~/server/services/account/profile.server";
import { clearRecentlyViewed, listRecentlyViewed } from "~/server/services/account/recently-viewed.server";
import { listOrdersForCustomer } from "~/server/services/orders/manage.server";
import { Key } from "~/ui/Key";
import { Price } from "~/ui/Price";
import { ProductCard } from "~/ui/ProductCard";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { accountFailure, deviceConsent, formFields, requireSignedIn } from "./account.server";
import { AccountNav } from "./components/AccountNav";
import { navHints } from "./components/hints";
import { OrderRow } from "./components/OrderBits";
import { PageHead, Section } from "./components/PageHead";
import { accountMeta } from "./components/meta";
import { handDeviceListToAccount } from "../home/personal";
import { useAccountData } from "./layout";

/** The account's home: who is signed in, the wallet and the latest order at a glance, the sections, recent views. */
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

export default function Overview({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const f = useFormat();
  const href = useLocalePath();
  const account = useAccountData();
  const navigation = useNavigation();
  const clear = useFetcher<typeof action>();
  const revalidator = useRevalidator();
  const signingOut = navigation.state !== "idle" && navigation.formAction === href("/account/logout");
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
  if (!account) return null;
  const { customer, counts, wallet } = account;
  const cleared = clear.data?.ok === true;
  const recent = cleared ? [] : loaderData.recent;

  return (
    <>
      <PageHead
        back={false}
        title={customer.name ? t("overview.hello", { name: customer.name }) : t("overview.helloNoName")}
        lead={loaderData.memberSince ? t("overview.memberSince", { date: f.date(loaderData.memberSince, "long") }) : undefined}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <MotionLink to="/account/wallet" nav="push" order={2} data-press="soft" className="grid content-start gap-1 rounded-lg bg-paper p-4 shadow-e1">
          <span className="flex items-center gap-2 type-label text-ink-2">
            <Icon name="wallet" size={20} />
            {t("overview.walletLabel")}
          </span>
          <Price amountIqd={wallet.balanceIqd} size="lg" approx="off" />
          {wallet.pendingIqd > 0 ? <Status tone="warn">{t("overview.hintTopups", { count: counts.pendingTopups })}</Status> : null}
        </MotionLink>
        <MotionLink to="/account/orders" nav="push" order={1} data-press="soft" className="grid content-start gap-1 rounded-lg bg-paper p-4 shadow-e1">
          <span className="flex items-center gap-2 type-label text-ink-2">
            <Icon name="package" size={20} />
            {t("nav.orders")}
          </span>
          <span className="type-sub text-ink">{counts.openOrders > 0 ? t("overview.openOrders", { count: counts.openOrders }) : t("overview.hintOrders", { count: counts.orders })}</span>
        </MotionLink>
      </div>

      {!customer.phoneVerified ? (
        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md bg-niche px-4 py-2 type-caption text-ink-2">
          <Status tone="neutral">{t("common.unverified")}</Status>
          <TextLink as={LocaleLink} to="/account/settings#phone">
            {t("overview.verifyPhone")}
          </TextLink>
        </p>
      ) : null}

      <Section
        id="last-order"
        title={t("overview.lastOrder")}
        aside={
          loaderData.lastOrder ? (
            <TextLink as={MotionLink} nav="push" order={1} to="/account/orders">
              {t("overview.allOrders")}
            </TextLink>
          ) : null
        }
      >
        {loaderData.lastOrder ? <OrderRow order={loaderData.lastOrder} /> : <p className="rounded-lg bg-niche p-4 type-body text-ink-2">{t("overview.noOrders")}</p>}
      </Section>

      <Section id="sections" title={t("overview.sections")} className="lg:hidden">
        <div className="rounded-lg bg-paper p-1">
          <AccountNav include="sections" hints={navHints(t, f, account)} />
        </div>
        <Form method="post" action={href("/account/logout")}>
          <Key type="submit" icon="sign-out" loading={signingOut}>
            {t("common.signOut")}
          </Key>
        </Form>
      </Section>

      <Section
        id="recent"
        title={t("overview.recentTitle")}
        aside={
          loaderData.consent && recent.length > 0 ? (
            <clear.Form method="post">
              <input type="hidden" name="intent" value="clearHistory" />
              <Key type="submit" size="sm" variant="quiet" icon="trash" loading={clear.state !== "idle"}>
                {t("overview.recentClear")}
              </Key>
            </clear.Form>
          ) : null
        }
      >
        {!loaderData.consent ? (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-niche p-4 type-body text-ink-2">
            <span>{t("overview.recentOff")}</span>
            <TextLink as={LocaleLink} to="/account/settings#privacy">
              {t("overview.recentTurnOn")}
            </TextLink>
          </p>
        ) : recent.length === 0 ? (
          <p className="rounded-lg bg-niche p-4 type-body text-ink-2" role={cleared ? "status" : undefined}>
            {cleared ? t("overview.recentCleared") : t("overview.recentEmpty")}
          </p>
        ) : (
          <ul className="grid grid-cols-2 gap-card sm:grid-cols-3 xl:grid-cols-4">
            {recent.map((card) => (
              <li key={card.id}>
                <ProductCard card={card} headingLevel={3} slot="recent" />
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
