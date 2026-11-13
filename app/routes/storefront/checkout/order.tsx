import { useEffect } from "react";
import { data, useRouteLoaderData, useSearchParams, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/order";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import { localePath } from "~/lib/locales";
import type { MotionHandle } from "~/motion";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { normalizeOrderRef } from "~/server/services/orders/manage.server";
import { DemoNote } from "~/ui/DemoNote";
import { EntryCard } from "~/ui/EntryCard";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { fillNodes } from "~/ui/PriceTag";
import { SuccessMark } from "~/ui/SuccessMark";
import { TextLink } from "~/ui/TextLink";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { clearStoredCheckout, orderStage, readStoredCheckout } from "./checkout-form";
import { codesNeedSignIn, findOrderForShopper, NO_STORE, orderShelves, revealCodeForShopper, storedProofPath } from "./checkout.server";
import { CopyKey } from "./components/CopyKey";
import { OrderDetails, When } from "./components/OrderDetails";
import { RecommendationsSlot } from "./components/RecommendationsSlot";
import "./checkout.css";

/**
 * /order/:ref — the order page (Design System v2 §6.11; brief §4, CONTRACTS §1; v2.1, client round 1: the new order
 * screen): the guest's confirmation link `/order/<ref>?t=<token>` (the token placeOrder returned; only its hash is
 * stored) or the signed-in owner. Anyone else — a wrong token, no token, someone else's order, an order that does not
 * exist — gets the same "cannot open this order" page with its two exits (look it up by reference and phone on /track,
 * or sign in). Never indexed, never cached.
 *
 * A clear thank-you first: the kit's SuccessMark (the disc inflates and the check draws itself, once; finished under
 * reduced motion), h1 «شكراً، استلمنا طلبك», then the order number on its own soft card — «رقم الطلب», the code in
 * Plex 600 20px with its copy key and «طلب تجريبي», the date, «انسخ رابط الطلب» — and the calm demo note. Then the order
 * status template (./components/OrderDetails: the status rail with its icons and the line that fills, the next step as a
 * Note with the proof uploader, one summary card with the pictures and the payment details). Help is two of the
 * before's rows (an icon in a clay circle, the words, an arrow): «تحدّث مع موظف» and «تتبّع طلبك»; the optional account
 * stays quiet; «تابع التسوّق» is the page's primary unless a proof is due; the cross-sell is at most one rail of four. A
 * cancelled or returned order keeps a plain header.
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
      <div className="page co-page">
        {/* one centred column of 640 from 768, as the checkout's (a sentence across the whole desktop page was ~140
            characters long); the `page` utility outranks a column class on the page element, so the column is a child */}
        <div className="co-lone">
          <h1 className="type-h1 text-ink">{t("order.missing.title")}</h1>
          {/* the two ways out sit under the sentence — across the card on phones — and a long label (Sorani «بەدوای
              داواکارییەکەتدا بگەڕێ») wraps inside its key instead of pushing the page sideways (QA 2026-11-13: 421px at 360) */}
          <Note
            icon="lock"
            className="co-missing"
            action={
              <span className="co-actions">
                <Key as={LocaleLink} to={trackTo} variant="primary" icon="magnifying-glass" wrap>
                  {t("order.missing.track")}
                </Key>
                {!loaderData.signedIn ? (
                  <Key as={LocaleLink} to={`/account/login?next=${encodeURIComponent(loaderData.ref ? `/order/${loaderData.ref}` : "/account")}`} icon="sign-in" wrap>
                    {t("order.missing.signIn")}
                  </Key>
                ) : null}
              </span>
            }
          >
            {t("order.missing.text")}
          </Note>
        </div>
      </div>
    );
  }

  const { order, access } = found;
  const token = access === "token" ? params.get("t") : null;
  const link = token && root?.origin ? `${root.origin}${localePath(`/order/${order.ref}?t=${encodeURIComponent(token)}`, locale)}` : null;
  const received = orderStage(order.status) !== null;
  // The number in the heading is in the text face, as on its card: Kufam's Latin V draws like Ʋ («TT-ƲBYBYQ9Q», QA
  // 2026-11-13) — a shopper copies it into /track or a message.
  const ref = (
    <bdi dir="ltr" className="font-plex nums">
      {order.ref}
    </bdi>
  );
  // Nothing left for the shopper to do here (no proof to send): «تابع التسوّق» is the page's one primary.
  const proofDue = order.payment.canUploadProof && order.status === "awaiting_payment";

  return (
    <div className="page co-page co-split">
      <div className="co-main co-order">
        <header className="co-thanks">
          {/* the success draws itself once (the kit: an inflating disc, a stroked check; finished under reduced motion) */}
          {received ? <SuccessMark size={72} className="co-thanks__mark" /> : null}
          <h1 className="type-h1 text-ink">{received ? t("order.thanks") : fillNodes(t("order.closedTitle"), { ref })}</h1>
          <div className="co-ref">
            <div className="co-ref__top">
              <p className="type-sm text-ink-2">{t("order.number")}</p>
              {order.isDemo ? <DemoNote variant="tag" what="order" /> : null}
            </div>
            <div className="co-ref__row">
              <bdi dir="ltr" className="type-code nums text-ink">
                {order.ref}
              </bdi>
              <CopyKey value={order.ref} label={t("order.number")} />
            </div>
            <p className="type-sm text-ink-2">{fillNodes(t("order.placedAt"), { date: <When at={order.placedAt} f={f} /> })}</p>
            {link ? (
              <div className="co-ref__link">
                <CopyKey value={link} label={t("copy.link")} text={t("copy.link")} />
                {/* the link's proof upload is said only where a proof is due (a cash order has none to send) */}
                <p className="type-sm text-ink-2">{t(proofDue ? "order.linkHintProof" : "order.linkHint")}</p>
              </div>
            ) : null}
          </div>
          {order.isDemo ? (
            // calm: the kit's note in its demo tone (only the circle is tinted)
            <Note tone="demo" variant="line">
              {t("order.demo")}
            </Note>
          ) : null}
          {params.get("address") === "0" ? (
            <Note variant="line" icon="map-pin">
              {t("order.addressNotSaved")}
            </Note>
          ) : null}
        </header>

        <OrderDetails order={order} mode="owner" access={{ ref: order.ref, token }} proofUrl={loaderData.proofUrl} codesSignIn={loaderData.codesSignIn} headingLevel={2} />
      </div>

      <aside className="co-aside" aria-label={t("order.help.heading")}>
        <section aria-labelledby="order-help" className="co-help">
          <h2 id="order-help" className="type-h3 text-ink">
            {t("order.help.heading")}
          </h2>
          {/* the before's rows (client note 9): the icon in a clay circle, the words, an arrow — help, and following the order later */}
          <EntryCard to={HANDOFF} icon="chat-circle" title={t("order.help.contact")} text={t("order.help.text")} />
          <EntryCard to={`/track?ref=${encodeURIComponent(order.ref)}`} icon="package" title={t("order.later.track")} text={t("order.later.text")} />
        </section>
        {!loaderData.signedIn ? (
          <section aria-labelledby="order-account" className="co-card grid gap-2">
            <h2 id="order-account" className="type-h3 text-ink">
              {t("order.account.heading")}
            </h2>
            {/* quiet and optional (§6.11): what an account keeps, and that this order needs none */}
            <p className="type-read text-ink-2">
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
