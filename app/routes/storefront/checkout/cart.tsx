import { useState } from "react";
import { data, type ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/cart";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocale, useT } from "~/i18n/react";
import type { MotionHandle } from "~/motion";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getCartView } from "~/server/services/cart.server";
import { CartLineRow } from "~/ui/CartLineRow";
import { useCartEditor } from "~/ui/cart-client";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { useOnline } from "~/ui/OfflineBanner";
import { OrderSummary } from "~/ui/OrderSummary";
import { Price } from "~/ui/Price";
import { fillNodes, isIqd } from "~/ui/PriceTag";
import { TextLink } from "~/ui/TextLink";
import { TrustStrip } from "~/ui/TrustStrip";
import { shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import type { CartLineData } from "~/server/services/cart.server";
import { BLOCKING_PROBLEMS, cartReadiness, COUPON_MINIMUM_INTENT, stockChanges } from "./checkout-form";
import { answerCouponMinimum, cartShelves, cartTokenOf, couponShortfall, emptyCartShelves, loadCartFacts, NO_STORE } from "./checkout.server";
import { Adjustments, summaryCoupon, withFlash } from "./components/Adjustments";
import { withOptionValue } from "./components/CheckoutSteps";
import { CommitKey } from "./components/CommitKey";
import { CouponForm, type CartWithIssue } from "./components/CouponForm";
import { MoveToWishlist } from "./components/MoveToWishlist";
import { RecommendationsSlot } from "./components/RecommendationsSlot";
import { StockNotice } from "./components/StockNotice";
import { useRemoveUnbuyable } from "./components/useRemoveUnbuyable";
import "./checkout.css";

/**
 * /cart — the cart (Design System v2 §6.10, §4.13; v2.1 «Clay & Glass»): h1 «السلة (3)», the lines (96px wells, 120
 * from 1024; the option value only; availability; the clay quantity tray; the line total; «إزالة» with its undo row),
 * and the order summary — every figure from the server's CartView, «الإجمالي» the one red figure, the discount code
 * behind «لديك رمز خصم؟» (a code below its minimum says how much more is needed — client round 1, QA), the trust line
 * (cash on delivery when it is on, «اطلب بدون حساب», the returns policy). The side notes are the kit's Note (G5): the
 * delivery rule under the card («تختار المحافظة في الخطوة التالية. التوصيل 5,000 د.ع لكل المحافظات.» — the fee from
 * settings, never a time or a call) and the calm demo-order line. The one primary «إتمام الطلب» is in the glass task bar
 * below 1024 (with «الإجمالي» and the total) and inside the sticky summary card from 1024 (7/5 columns). One
 * recommendation rail after the summary (devices area, verified add-ons, ≥3, streamed). Edits go through
 * ~/ui/cart-client (optimistic, rolled back with a sentence). Lines that can no longer be bought are named in one
 * warning note with «أزل غير المتوفر» (client round 1, QA): the key waits until they are out.
 *
 * Empty (client note 7 — the before's arrangement and font): the page title «السلة»; the soft card with the mascot in
 * its circle, «سلتك فارغة» in Kufam, one muted line and the centred key «تسوّق الأجهزة ←»; «طلبت من قبل؟ تتبّع طلبك»
 * under the card; then v2's «مختارات المتجر» shelf (four in-stock products). No task bar, so the shell's tab bar shows.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const customerId = session?.customer.id ?? null;
  const request = { cartToken: cartTokenOf(ctx), customerId, locale: ctx.locale };
  const [cart, facts] = await Promise.all([getCartView(db, request, ctx.now), loadCartFacts(db)]);
  // a cart with lines never waits for its suggestions (streamed under the summary, below the fold). The EMPTY cart's
  // four picks are awaited (emptyCartShelves never rejects): streamed in after the first paint they pushed the footer,
  // which is on the first screen of an empty cart, down by a whole shelf — CLS 0.16–0.22 at 390 px (acceptance run
  // 2026-11-12, docs/ACCEPTANCE.md); rendered on the server they are simply there.
  const recommendations = cart.lines.length > 0 ? cartShelves(db, ctx, customerId, cart) : await emptyCartShelves(db, ctx, customerId);
  // a stored code under its minimum says how much more is needed (client round 1, QA)
  const shortfall = cart.couponIssue?.reason === "min_subtotal" ? await couponShortfall(db, request, cart.couponIssue.code, ctx.now, cart) : null;
  return data({ cart, facts, demo: ctx.storeMode === "demo", recommendations, couponShortfall: shortfall, i18n: messagesFor(ctx.locale, "checkout", "errors") }, { headers: NO_STORE });
}

/**
 * One small read (client round 1, QA): `intent=coupon-minimum code=…` — after /api/cart refused a code for its minimum,
 * how much more this cart needs (checkout.server answerCouponMinimum: the core's verdict and count; rate-limited). The
 * coupon itself is applied by /api/cart only.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  if (form.get("intent") !== COUPON_MINIMUM_INTENT) return data({ ok: false as const, code: "invalid", status: 400 }, { status: 400, headers: NO_STORE });
  const session = await getCustomer(ctx, db);
  const answer = await answerCouponMinimum(db, ctx, session?.customer.id ?? null, form);
  const headers = new Headers(NO_STORE);
  if (!answer.ok && answer.retryAfterSec !== undefined) headers.set("Retry-After", String(answer.retryAfterSec));
  return data(answer, { status: answer.ok ? 200 : answer.status, headers });
}

/**
 * The coupon-minimum read from the browser — the cart's AND the checkout's coupon field post it here (CouponForm). A
 * request that fails (no connection, a server error) answers `{ ok: false, code: "network" }` instead of throwing: the
 * read only completes a refusal's sentence, and a fetcher's failed action would put the route's error boundary in place
 * of the whole page (review 2026-11-13: one dropped request after a refusal showed «لا يوجد اتصال بالإنترنت» over the
 * checkout). The field keeps the refusal's own words then.
 */
export async function clientAction({ serverAction }: Route.ClientActionArgs) {
  try {
    return await serverAction();
  } catch {
    return { ok: false as const, code: "network", status: 0 };
  }
}

/** The coupon-minimum read changes nothing: no reload of the cart for it. */
export function shouldRevalidate({ formData, defaultShouldRevalidate }: ShouldRevalidateFunctionArgs) {
  if (formData?.get("intent") === COUPON_MINIMUM_INTENT) return false;
  return defaultShouldRevalidate;
}

export function headers() {
  return NO_STORE;
}

export const handle = { shell: { tabBar: false }, nav: "push", order: 0, group: "checkout" } satisfies ShellHandle & MotionHandle;

export const meta: Route.MetaFunction = (args) => {
  const tree = args.loaderData?.i18n.checkout as { meta?: { cart?: string } } | undefined;
  return shellMeta(args, { title: tree?.meta?.cart ?? null, noindex: true });
};

export default function CartPage({ loaderData }: Route.ComponentProps) {
  const t = useT("checkout");
  const shopT = useT("ui-shop");
  const f = useFormat();
  const locale = useLocale();
  const online = useOnline();
  const { facts, demo } = loaderData;
  // A coupon answer replaces the editor's starting view (a newer loader view does the same).
  const [override, setOverride] = useState<{ base: CartWithIssue; cart: CartWithIssue } | null>(null);
  const base = override && override.base === loaderData.cart ? override.cart : (loaderData.cart as CartWithIssue);
  const editor = useCartEditor(base, { locale });
  const view = editor.view as CartWithIssue;
  const unbuyable = useRemoveUnbuyable(editor);

  if (editor.rows.length === 0) {
    // Emptied here (every line removed and its undo row closed): the shelf the loader sent completed lines that are
    // gone, so it is not shown — its reason line would no longer be true.
    const emptiedHere = loaderData.cart.lines.length > 0;
    return (
      <div className="page co-page co-empty">
        <h1 className="type-h1 text-ink">{t("cart.title")}</h1>
        <EmptyState
          layout="stack"
          panel
          headingLevel={2}
          title={t("cart.emptyTitle")}
          text={t("cart.emptyText")}
          action={
            // «تسوّق الأجهزة» opens the consoles (§9: a key names where it goes)
            <Key as={LocaleLink} to="/c/consoles" variant="primary" iconEnd="arrow-right">
              {t("cart.browse")}
            </Key>
          }
        />
        {/* the before's line under the card (client note 7) */}
        <p className="co-empty__track">
          <TextLink as={LocaleLink} to="/track" icon="package" arrow={false}>
            {t("cart.trackAsk")}
          </TextLink>
        </p>
        {emptiedHere ? null : <RecommendationsSlot context="cart" result={loaderData.recommendations} className="co-empty__shelf" />}
      </div>
    );
  }

  const readiness = cartReadiness(view.lines);
  const blockedIds = view.lines.filter((line) => line.problem !== null && BLOCKING_PROBLEMS.has(line.problem)).map((line) => line.id);
  const reasonId = "cart-commit-reason";
  // Every line removed (their undo rows still show): nothing to check out.
  const reason = !online ? t("cart.offline") : view.lines.length === 0 ? t("reasons.empty") : readiness !== "ready" ? t("cart.blocked") : editor.pending ? t("reasons.editing") : null;
  const commit = (describedBy: string) => (
    <CommitKey to="/checkout" disabled={reason !== null} aria-describedby={reason ? describedBy : undefined}>
      {t("cart.checkout")}
    </CommitKey>
  );
  const why = (id: string) =>
    reason ? (
      <p id={id} className="type-xs-strong text-ink-2">
        {reason}
      </p>
    ) : null;
  const note = facts.overridesEnabled ? t("cart.deliveryNoteVaries") : fillNodes(t("cart.deliveryNote"), { fee: <bdi className="nums">{f.iqd(facts.deliveryFeeIqd)}</bdi> });

  return (
    <>
      <div className="page co-page co-split">
        <div className="co-main">
          <h1 className="type-h1 text-ink">{t("cart.titleCount", { n: f.number(view.count) })}</h1>
          {blockedIds.length > 0 ? (
            // what can no longer be bought, by name, and the one thing to do about it (client round 1, QA)
            <StockNotice
              title={readiness === "empty" ? t("stock.titleEmpty") : t("stock.titleBlocked")}
              changes={stockChanges(null, view.lines)}
              totalIqd={readiness === "empty" ? null : view.totalIqd}
              action={
                // a script key (the cart editor): without script it would be a key that does nothing
                <Key size="sm" icon="trash" className="co-js" loading={unbuyable.removing} disabled={!online} onClick={() => unbuyable.remove(blockedIds)}>
                  {t("stock.remove")}
                </Key>
              }
            />
          ) : null}
          <ul className="co-lines" aria-label={t("cart.linesLabel")}>
            {editor.rows.map((row) => {
              const extra = row.line as Partial<CartLineData>;
              return (
                <CartLineRow
                  // One key per line through removal: the row itself turns into its undo row, so the kit can move the
                  // focus from «إزالة» to «تراجع» (a new key would remount it and drop the focus to the page).
                  key={row.line.id}
                  line={withFlash(withOptionValue(row.line), extra.flash, t, f)}
                  removed={row.removed}
                  busy={row.busy}
                  error={row.error}
                  onQtyChange={(qty) => editor.setQty(row.line.id, qty)}
                  onRemove={() => editor.remove(row.line.id)}
                  onRestore={() => editor.restore(row.line.id)}
                  onDismiss={() => editor.dismiss(row.line.id)}
                  // «نقل إلى المفضلة» (§4.13): the product to the favourites, the line out of the cart with its undo row
                  actions={row.line.kind === "variant" && extra.productId ? <MoveToWishlist productId={extra.productId} name={row.line.name} onMoved={() => editor.remove(row.line.id)} /> : undefined}
                />
              );
            })}
          </ul>
        </div>

        <aside className="co-aside" aria-label={t("cart.summaryLabel")}>
          <OrderSummary
            {...view}
            coupon={summaryCoupon(view.discounts, view.coupon)}
            lines={null}
            count={view.payableCount ?? view.count}
            shipping={facts.overridesEnabled ? "pending" : "flat"}
            pending={editor.pending}
            headingLevel={2}
            couponField={<CouponForm cart={view} locale={locale} shortfall={loaderData.couponShortfall} onCart={(cart) => setOverride({ base: loaderData.cart as CartWithIssue, cart })} />}
            action={
              <div className="grid gap-2 max-lg:hidden">
                {commit(reasonId)}
                {why(reasonId)}
              </div>
            }
            trust={<TrustStrip variant="line" cod={facts.cod} guest returnsTo="/policies/returns" />}
          >
            <Adjustments discounts={view.discounts ?? []} waiver={view.shippingWaiver ?? null} />
          </OrderSummary>
          {/* the side notes (G5): the delivery rule — unless this cart's delivery is waived (the summary says so and
              from what) — and the calm demo-order line */}
          {view.shippingWaiver ? null : (
            <Note variant="line" icon="truck">
              {note}
            </Note>
          )}
          {demo ? (
            <Note variant="line" tone="demo">
              {shopT("demo.orderLine")}
            </Note>
          ) : null}
        </aside>

        {/* One rail that completes the cart (devices area): after the summary on phones, under the lines from 1024. */}
        <RecommendationsSlot context="cart" result={loaderData.recommendations} className="co-rail" />
      </div>

      <TaskBar aria-label={t("cart.barLabel")} className="lg:hidden">
        <div className="co-taskbar">
          <div className="co-taskbar__total">
            <span className="type-xs text-ink-2">{t("cart.total")}</span>
            {isIqd(view.totalIqd) ? <Price amountIqd={view.totalIqd} size="lg" tone="total" approx="off" as="span" /> : null}
          </div>
          <div className="min-w-0 flex-1">{commit(`${reasonId}-bar`)}</div>
        </div>
        {why(`${reasonId}-bar`)}
      </TaskBar>
    </>
  );
}
