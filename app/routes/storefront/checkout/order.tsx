import { useEffect } from "react";
import { data, useRouteLoaderData, useSearchParams } from "react-router";

import type { Route } from "./+types/order";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import { localePath } from "~/lib/locales";
import type { MotionHandle } from "~/motion";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { normalizeOrderRef } from "~/server/services/orders/manage.server";
import { DemoNote } from "~/ui/DemoNote";
import { Key } from "~/ui/Key";
import { fillNodes } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { clearStoredCheckout, readStoredCheckout } from "./checkout-form";
import { findOrderForShopper, NO_STORE } from "./checkout.server";
import { CopyKey } from "./components/CopyKey";
import { OrderDetails, When } from "./components/OrderDetails";
import { RecommendationsSlot } from "./components/RecommendationsSlot";

/**
 * /order/:ref — the order page (brief §4, CONTRACTS §1): the guest's confirmation link `/order/<ref>?t=<token>` (the
 * token placeOrder returned; only its hash is stored) or the signed-in owner. Anyone else — a wrong token, no token,
 * someone else's order, an order that does not exist — gets the same "cannot open this order" page with a way to
 * look it up by reference and phone (/track). Never indexed, never cached.
 *
 * What it shows: the status and the next step for its payment method; for a transfer the instructions from settings,
 * the deadline and the proof upload (amount required) — then "بانتظار التحقق" until a person approves it, or the
 * reviewer's reason and the uploader again after a rejection; the steps so far, items and totals, delivery details
 * (the requested time is a preference), shipments and refunds. Guests are offered an account — honestly: attaching
 * this order to it needs a code by SMS, and no SMS provider is configured.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const token = new URL(request.url).searchParams.get("t");
  const session = await getCustomer(ctx, db);
  const found = await findOrderForShopper(db, { ref: params.ref, token, customerId: session?.customer.id ?? null, locale: ctx.locale, now: ctx.now });
  const i18n = messagesFor(ctx.locale, "checkout", "errors");
  if (!found) return data({ found: null, ref: normalizeOrderRef(params.ref), signedIn: session !== null, i18n }, { status: 404, headers: NO_STORE });
  return data({ found, ref: found.order.ref, signedIn: session !== null, i18n }, { headers: NO_STORE });
}

export function headers() {
  return NO_STORE;
}

export const handle = { nav: "push", order: 10, group: "checkout" } satisfies MotionHandle;

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.checkout as { meta?: { order?: string; orderMissing?: string } } | undefined;
  const ref = args.loaderData?.found ? args.loaderData.ref : null;
  const title = ref && tree?.meta?.order ? tree.meta.order.replace("{ref}", ref) : (tree?.meta?.orderMissing ?? null);
  return shellMeta(args, { title, noindex: true });
};

export default function OrderPage({ loaderData }: Route.ComponentProps) {
  const t = useT("checkout");
  const f = useFormat();
  const locale = useLocale();
  const [params] = useSearchParams();
  const root = useRouteLoaderData("root") as { origin?: string } | undefined;
  const found = loaderData.found;

  // The checkout that led here is done: forget its draft (it held the phone and the address) in this tab.
  useEffect(() => {
    if (found && readStoredCheckout()?.submittedKey) clearStoredCheckout();
  }, [found]);

  if (!found) {
    const trackTo = loaderData.ref ? `/track?ref=${encodeURIComponent(loaderData.ref)}` : "/track";
    return (
      <div className="gutter mx-auto grid w-full max-w-[calc(640px+2*var(--gutter))] gap-5 pb-10 pt-6">
        <h1 className="type-title text-ink">{t("order.missing.title")}</h1>
        <div className="grid gap-3 rounded-lg bg-paper p-4">
          <p className="flex items-start gap-2 type-body text-ink">
            <Icon name="lock" size={20} className="mt-0.5 shrink-0 text-ink-2" />
            {t("order.missing.text")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Key as={LocaleLink} to={trackTo} variant="ink" icon="magnifying-glass">
              {t("order.missing.track")}
            </Key>
            {!loaderData.signedIn ? (
              <Key as={LocaleLink} to={`/account/login?next=${encodeURIComponent(loaderData.ref ? `/order/${loaderData.ref}` : "/account")}`} icon="sign-in">
                {t("order.missing.signIn")}
              </Key>
            ) : null}
          </div>
        </div>
      </div>
    );
  }

  const { order, access } = found;
  const token = access === "token" ? params.get("t") : null;
  const link = token && root?.origin ? `${root.origin}${localePath(`/order/${order.ref}?t=${encodeURIComponent(token)}`, locale)}` : null;

  return (
    <div className="page grid gap-6 pb-10 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)] lg:items-start lg:gap-x-10">
      <div className="grid min-w-0 max-w-[720px] gap-5">
        <header className="grid gap-2">
          <p className="type-label text-ink-2">{t("order.number")}</p>
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="type-title text-ink">
              <bdi dir="ltr" className="nums">
                {order.ref}
              </bdi>
            </h1>
            <CopyKey value={order.ref} label={t("order.number")} />
          </div>
          <p className="type-caption text-ink-2">{fillNodes(t("order.placedAt"), { date: <When at={order.placedAt} f={f} /> })}</p>
          {order.isDemo ? <DemoNote>{t("order.demo")}</DemoNote> : null}
        </header>

        <OrderDetails order={order} mode="owner" access={{ ref: order.ref, token }} />
        <RecommendationsSlot context="post_purchase" variantIds={[]} />
      </div>

      <aside className="grid gap-4 lg:sticky lg:top-[calc(var(--shell-header-h)+var(--safe-top)+var(--s-4))]">
        {link ? (
          <section aria-labelledby="order-save" className="grid gap-2 rounded-lg bg-paper p-4">
            <h2 id="order-save" className="type-sub text-ink">
              {t("order.save.heading")}
            </h2>
            <p className="type-caption text-ink-2">{t("order.save.text")}</p>
            <div className="justify-self-start">
              <CopyKey value={link} label={t("order.save.what")} />
            </div>
            <TextLink as={LocaleLink} to={`/track?ref=${encodeURIComponent(order.ref)}`} className="justify-self-start">
              {t("order.save.track")}
            </TextLink>
          </section>
        ) : null}
        {!loaderData.signedIn ? (
          <section aria-labelledby="order-account" className="grid gap-2 rounded-lg bg-paper p-4">
            <h2 id="order-account" className="type-sub text-ink">
              {t("order.account.heading")}
            </h2>
            <p className="type-caption text-ink-2">{t("order.account.benefits")}</p>
            <p className="flex items-start gap-2 type-caption text-ink">
              <Icon name="info" size={16} className="mt-0.5 shrink-0 text-info" />
              {t("order.account.otp")}
            </p>
            <TextLink as={LocaleLink} to="/account" className="justify-self-start">
              {t("order.account.action")}
            </TextLink>
          </section>
        ) : null}
        <section className="grid gap-2 rounded-lg bg-paper p-4">
          <p className="type-caption text-ink-2">{t("order.help")}</p>
          <TextLink as={LocaleLink} to="/contact" className="justify-self-start">
            {t("order.contact")}
          </TextLink>
        </section>
      </aside>
    </div>
  );
}
