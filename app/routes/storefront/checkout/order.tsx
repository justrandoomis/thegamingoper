import { useEffect } from "react";
import { data, useRouteLoaderData, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

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
import { clearStoredCheckout, orderStage, readStoredCheckout } from "./checkout-form";
import { codesNeedSignIn, findOrderForShopper, NO_STORE, orderShelves, revealCodeForShopper, storedProofPath } from "./checkout.server";
import { CopyKey } from "./components/CopyKey";
import { OrderDetails, When } from "./components/OrderDetails";
import { RecommendationsSlot } from "./components/RecommendationsSlot";
import "./checkout.css";

/**
 * /order/:ref — the order page (Design System v2 §6.11; brief §4, CONTRACTS §1): the guest's confirmation link
 * `/order/<ref>?t=<token>` (the token placeOrder returned; only its hash is stored) or the signed-in owner. Anyone else
 * — a wrong token, no token, someone else's order, an order that does not exist — gets the same "cannot open this
 * order" page with its two exits (look it up by reference and phone on /track, or sign in). Never indexed, never cached.
 *
 * A clear thank-you first: a 72px --ok-tint disc with the check (one scale-in, none under reduced motion), h1 «شكراً،
 * استلمنا طلبك», «رقم الطلب» and the code in Plex 600 20px with its copy key and «انسخ رابط الطلب», the «طلب تجريبي»
 * tag. Then the order status template (./components/OrderDetails: the stages, the next step by payment with the proof
 * uploader, one summary card). From 1024 the quiet aside holds «سؤال عن طلبك؟», how to follow the order later and the
 * optional account; the cross-sell is at most one rail of four. A cancelled or returned order keeps a plain header.
 */
export async function loader({ params, request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const token = new URL(request.url).searchParams.get("t");
  const session = await getCustomer(ctx, db);
  const customerId = session?.customer.id ?? null;
  const found = await findOrderForShopper(db, { ref: params.ref, token, customerId, locale: ctx.locale, now: ctx.now });
  const i18n = messagesFor(ctx.locale, "checkout", "errors");
  if (!found) return data({ found: null, ref: normalizeOrderRef(params.ref), signedIn: session !== null, recommendations: null, proofUrl: null, codesSignIn: false, i18n }, { status: 404, headers: NO_STORE });
  // what completes what was bought (devices area, "post_purchase") — only once the shopper may see the order; streamed
  const recommendations = orderShelves(db, ctx, customerId, found.order.ref);
  // the transfer photo the shopper sent, again after a reload (a private path the file route authorizes every time)
  const proofUrl = await storedProofPath(db, found.order, found.access === "token" ? token : null);
  // an account's order opened with its link: its codes open for its owner signed in, never for the link (the core's rule)
  const codesSignIn = await codesNeedSignIn(db, found);
  return data({ found, ref: found.order.ref, signedIn: session !== null, recommendations, proofUrl, codesSignIn, i18n }, { headers: NO_STORE });
}

/**
 * «اعرض الرمز» (a paid order's digital code): `intent=reveal`, `codeId`, and the signed-in owner's session — or, for a
 * guest's order, the confirmation token `t` (an account's order opened with its link shows «سجّل الدخول» instead:
 * `codesSignIn`). The commerce core decides (whose order, paid, not refunded, this order's code; audited; limited).
 */
export async function action({ request, params, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  const field = (name: string) => {
    const value = form.get(name);
    return typeof value === "string" ? value : "";
  };
  if (field("intent") !== "reveal") return data({ ok: false as const, code: "invalid" }, { status: 400, headers: NO_STORE });
  const session = await getCustomer(ctx, db);
  const result = await revealCodeForShopper(db, ctx, { ref: params.ref ?? "", token: field("t") || null, customerId: session?.customer.id ?? null, codeId: field("codeId") });
  return data(result, { status: result.ok ? 200 : result.status, headers: NO_STORE });
}

export function headers() {
  return NO_STORE;
}

/** A code shown on request changes nothing the page shows but that code: no reload of the order for it. */
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formData?.get("intent") === "reveal") return false;
  return defaultShouldRevalidate;
}

export const handle = { nav: "push", order: 10, group: "checkout" } satisfies MotionHandle;

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.checkout as { meta?: { order?: string; orderMissing?: string } } | undefined;
  const ref = args.loaderData?.found ? args.loaderData.ref : null;
  const title = ref && tree?.meta?.order ? tree.meta.order.replace("{ref}", ref) : (tree?.meta?.orderMissing ?? null);
  return shellMeta(args, { title, noindex: true });
};

/** The one place a person answers (Design System v2 §6.13): the assistant's hand-off form. */
const HANDOFF = "/support/assistant?handoff=1#handoff";

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
      <div className="page co-page co-narrow">
        <h1 className="type-h1 text-ink">{t("order.missing.title")}</h1>
        <div className="co-card grid gap-4">
          <p className="flex items-start gap-2 type-body text-ink">
            <Icon name="lock" size={20} className="mt-0.5 shrink-0 text-ink-2" />
            {t("order.missing.text")}
          </p>
          <div className="flex flex-wrap gap-2">
            <Key as={LocaleLink} to={trackTo} variant="primary" icon="magnifying-glass">
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
  const received = orderStage(order.status) !== null;
  const ref = "⁦" + order.ref + "⁩";
  // Nothing left for the shopper to do here (no proof to send): «تابع التسوّق» is the page's one primary.
  const proofDue = order.payment.canUploadProof && order.status === "awaiting_payment";

  return (
    <div className="page co-page co-split">
      <div className="co-main co-order">
        <header className="co-thanks">
          {received ? (
            <span className="co-thanks__disc" aria-hidden="true">
              <Icon name="check" size={32} />
            </span>
          ) : null}
          <h1 className="type-h1 text-ink">{received ? t("order.thanks") : t("order.closedTitle", { ref })}</h1>
          <div className="grid gap-1">
            <p className="type-xs text-ink-2">{t("order.number")}</p>
            <div className="co-thanks__code">
              <bdi dir="ltr" className="type-code nums text-ink">
                {order.ref}
              </bdi>
              <CopyKey value={order.ref} label={t("order.number")} />
              {link ? <CopyKey value={link} label={t("copy.link")} text={t("copy.link")} /> : null}
              {order.isDemo ? <DemoNote variant="tag" what="order" /> : null}
            </div>
          </div>
          <p className="type-xs text-ink-2">{fillNodes(t("order.placedAt"), { date: <When at={order.placedAt} f={f} /> })}</p>
          {/* the link's proof upload is said only where a proof is due (a cash order has none to send) */}
          {link ? <p className="type-xs text-ink-2">{t(proofDue ? "order.linkHintProof" : "order.linkHint")}</p> : null}
          {order.isDemo ? <DemoNote variant="line">{t("order.demo")}</DemoNote> : null}
          {params.get("address") === "0" ? (
            <p className="co-note">
              <Icon name="map-pin" size={16} className="shrink-0 text-ink-2" />
              <span className="min-w-0 flex-1">{t("order.addressNotSaved")}</span>
            </p>
          ) : null}
        </header>

        <OrderDetails order={order} mode="owner" access={{ ref: order.ref, token }} proofUrl={loaderData.proofUrl} codesSignIn={loaderData.codesSignIn} headingLevel={2} />
      </div>

      <aside className="co-aside" aria-label={t("order.help.heading")}>
        <section aria-labelledby="order-help" className="co-card grid gap-2">
          <h2 id="order-help" className="type-h3 text-ink">
            {t("order.help.heading")}
          </h2>
          <p className="type-sm text-ink-2">{t("order.help.text")}</p>
          <TextLink as={LocaleLink} to={HANDOFF} icon="chat-circle" arrow={false} className="justify-self-start">
            {t("order.help.contact")}
          </TextLink>
        </section>
        {token ? (
          <section aria-labelledby="order-later" className="co-card grid gap-2">
            <h2 id="order-later" className="type-h3 text-ink">
              {t("order.later.heading")}
            </h2>
            <p className="type-sm text-ink-2">{t("order.later.text")}</p>
            <TextLink as={LocaleLink} to={`/track?ref=${encodeURIComponent(order.ref)}`} className="justify-self-start">
              {t("order.later.track")}
            </TextLink>
          </section>
        ) : null}
        {!loaderData.signedIn ? (
          <section aria-labelledby="order-account" className="co-card grid gap-2">
            <h2 id="order-account" className="type-h3 text-ink">
              {t("order.account.heading")}
            </h2>
            {/* quiet and optional (§6.11): what an account keeps, and that this order needs none */}
            <p className="type-sm text-ink-2">
              {t("order.account.benefits")} {t("order.account.stays")}
            </p>
            <TextLink as={LocaleLink} to="/account/signup" className="justify-self-start">
              {t("order.account.action")}
            </TextLink>
          </section>
        ) : null}
        <Key as={LocaleLink} to="/" variant={proofDue ? "secondary" : "primary"} iconEnd="arrow-right" className="justify-self-start">
          {t("order.continue")}
        </Key>
      </aside>

      {/* At most one rail of four (devices area): after the order's own panels on phones, under the order from 1024. */}
      <RecommendationsSlot key={order.ref} context="post_purchase" result={loaderData.recommendations} className="co-rail" />
    </div>
  );
}
