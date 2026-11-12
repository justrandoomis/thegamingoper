import { useState } from "react";
import { data } from "react-router";

import type { Route } from "./+types/cart";
import { Icon } from "~/art/Icon";
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
import { cartShelves, cartTokenOf, emptyCartShelves, loadCartFacts, NO_STORE } from "./checkout.server";
import { Adjustments, summaryCoupon, withFlash } from "./components/Adjustments";
import { withOptionValue } from "./components/CheckoutSteps";
import { CommitKey } from "./components/CommitKey";
import { CouponForm, type CartWithIssue } from "./components/CouponForm";
import { MoveToWishlist } from "./components/MoveToWishlist";
import { RecommendationsSlot } from "./components/RecommendationsSlot";
import "./checkout.css";

/**
 * /cart — the cart (Design System v2 §6.10, §4.13): h1 «السلة (3)», the lines (96px wells, 120 from 1024; the option
 * value only; availability; the stepper; the line total; «إزالة» with its undo row), and the order summary — every
 * figure from the server's CartView, «الإجمالي» the one red figure, the discount code behind «لديك رمز خصم؟», the
 * delivery rule («تختار المحافظة في الخطوة التالية. التوصيل 5,000 د.ع لكل المحافظات.» — the fee from settings, never a
 * time or a call), the trust line (cash on delivery when it is on, «اطلب بدون حساب», the returns policy) and the
 * demo-order line. The one primary «إتمام الطلب» is in the glass task bar below 1024 (with «الإجمالي» and the total)
 * and inside the sticky summary card from 1024 (7/5 columns). One recommendation rail after the summary (devices
 * area, verified add-ons, ≥3, streamed). Edits go through ~/ui/cart-client (optimistic, rolled back with a sentence).
 *
 * Empty: «سلتك فارغة» · «ابدأ من منصّتك: Nintendo أو PlayStation أو Xbox.» · the primary «تسوّق الأجهزة» · «تتبّع طلبك»
 * and four in-stock products (the store's picks); no task bar, so the shell's tab bar shows.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const customerId = session?.customer.id ?? null;
  const [cart, facts] = await Promise.all([getCartView(db, { cartToken: cartTokenOf(ctx), customerId, locale: ctx.locale }, ctx.now), loadCartFacts(db)]);
  // a cart with lines never waits for its suggestions (streamed under the summary, below the fold). The EMPTY cart's
  // four picks are awaited (emptyCartShelves never rejects): streamed in after the first paint they pushed the footer,
  // which is on the first screen of an empty cart, down by a whole shelf — CLS 0.16–0.22 at 390 px (acceptance run
  // 2026-11-12, docs/ACCEPTANCE.md); rendered on the server they are simply there.
  const recommendations = cart.lines.length > 0 ? cartShelves(db, ctx, customerId, cart) : await emptyCartShelves(db, ctx, customerId);
  return data({ cart, facts, demo: ctx.storeMode === "demo", recommendations, i18n: messagesFor(ctx.locale, "checkout", "errors") }, { headers: NO_STORE });
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
  const f = useFormat();
  const locale = useLocale();
  const online = useOnline();
  const { facts, demo } = loaderData;
  // A coupon answer replaces the editor's starting view (a newer loader view does the same).
  const [override, setOverride] = useState<{ base: CartWithIssue; cart: CartWithIssue } | null>(null);
  const base = override && override.base === loaderData.cart ? override.cart : (loaderData.cart as CartWithIssue);
  const editor = useCartEditor(base, { locale });
  const view = editor.view as CartWithIssue;

  if (editor.rows.length === 0) {
    // Emptied here (every line removed and its undo row closed): the shelf the loader sent completed lines that are
    // gone, so it is not shown — its reason line would no longer be true.
    const emptiedHere = loaderData.cart.lines.length > 0;
    return (
      <div className="page co-page">
        <h1 className="sr-only">{t("cart.title")}</h1>
        <EmptyState
          layout="stack"
          headingLevel={2}
          title={t("cart.emptyTitle")}
          text={t("cart.emptyText")}
          action={
            // «تسوّق الأجهزة» opens the consoles (§9: a key names where it goes)
            <Key as={LocaleLink} to="/c/consoles" variant="primary" iconEnd="arrow-right">
              {t("cart.browse")}
            </Key>
          }
          recovery={
            <TextLink as={LocaleLink} to="/track" icon="package" arrow={false}>
              {t("cart.trackLink")}
            </TextLink>
          }
          shelf={emptiedHere ? undefined : <RecommendationsSlot context="cart" result={loaderData.recommendations} />}
        />
      </div>
    );
  }

  const blocked = view.blocked;
  const reasonId = "cart-commit-reason";
  // Every line removed (their undo rows still show): nothing to check out.
  const reason = !online ? t("cart.offline") : blocked ? t("cart.blocked") : view.lines.length === 0 ? t("reasons.empty") : editor.pending ? t("reasons.editing") : null;
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
          {blocked ? (
            <div role="alert" className="callout callout--danger">
              <Icon name="warning-circle" size={20} />
              <p className="callout__text text-ink">{t("cart.blockedNotice")}</p>
            </div>
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
            count={view.count}
            shipping={facts.overridesEnabled ? "pending" : "flat"}
            pending={editor.pending}
            headingLevel={2}
            couponField={<CouponForm cart={view} locale={locale} onCart={(cart) => setOverride({ base: loaderData.cart as CartWithIssue, cart })} />}
            action={
              <div className="grid gap-2 max-lg:hidden">
                {commit(reasonId)}
                {why(reasonId)}
              </div>
            }
            trust={<TrustStrip variant="line" cod={facts.cod} guest returnsTo="/policies/returns" />}
            demo={demo}
          >
            <Adjustments discounts={view.discounts ?? []} waiver={view.shippingWaiver ?? null} />
            {/* the store's fee sentence, unless this cart's delivery is waived (the line above says so and from what) */}
            {view.shippingWaiver ? null : (
              <p className="flex items-start gap-2 type-xs text-ink-2">
                <Icon name="truck" size={16} className="mt-0.5 shrink-0" />
                <span>{note}</span>
              </p>
            )}
          </OrderSummary>
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
