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
import { shellMeta } from "~/routes/storefront/shell/meta";
import { TaskBar } from "~/routes/storefront/shell/TabBar";
import type { ShellHandle } from "~/routes/storefront/shell/types";
import { cartShelves, cartTokenOf, NO_STORE } from "./checkout.server";
import { CommitKey } from "./components/CommitKey";
import { CouponForm, type CartWithIssue } from "./components/CouponForm";
import { RecommendationsSlot } from "./components/RecommendationsSlot";

/**
 * /cart — the cart (brief §4, DESIGN.md §8.5): paper rows with a small stepper, remove with undo and the problem
 * states (out of stock, unavailable, quantity reduced, price changed — CartLineRow), the discount code with the
 * server's exact refusal, the order summary (every figure from the server's CartView; the delivery line is the flat
 * fee until a governorate is chosen at checkout), and one commit key "إتمام الطلب": in the glass task bar on phones
 * (the tab bar gives way), under the summary from 1024px. Edits go through ~/ui/cart-client (optimistic, rolled back
 * with a sentence when refused). An empty cart is the empty state with one key back to the shop.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  const customerId = session?.customer.id ?? null;
  const cart = await getCartView(db, { cartToken: cartTokenOf(ctx), customerId, locale: ctx.locale }, ctx.now);
  // what completes the cart (devices area) — streamed, never awaited: the cart never waits for its suggestions
  const recommendations = cartShelves(db, ctx, customerId, cart);
  return data({ cart, recommendations, i18n: messagesFor(ctx.locale, "checkout", "errors") }, { headers: NO_STORE });
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
  // A coupon answer replaces the editor's starting view (a newer loader view does the same).
  const [override, setOverride] = useState<{ base: CartWithIssue; cart: CartWithIssue } | null>(null);
  const base = override && override.base === loaderData.cart ? override.cart : (loaderData.cart as CartWithIssue);
  const editor = useCartEditor(base, { locale });
  const view = editor.view as CartWithIssue;

  if (editor.rows.length === 0) {
    return (
      <div className="page grid gap-6 pb-10 pt-6">
        <h1 className="type-title text-ink">{t("cart.title")}</h1>
        <EmptyState layout="stack" headingLevel={2} title={t("cart.emptyTitle")} text={t("cart.emptyText")} action={<Key as={LocaleLink} to="/" iconEnd="arrow-right">{t("cart.browse")}</Key>} />
        <p className="text-center">
          <LocaleLink to="/track" className="type-label text-ink underline underline-offset-4">
            {t("cart.trackLink")}
          </LocaleLink>
        </p>
      </div>
    );
  }

  const blocked = view.blocked;
  const reasonId = "cart-commit-reason";
  // Every line removed (their undo rows still show): nothing to check out.
  const reason = !online ? t("cart.offline") : blocked ? t("cart.blocked") : view.lines.length === 0 ? t("empty.title") : null;
  const commit = (describedBy: string) => (
    <CommitKey to="/checkout" disabled={reason !== null} aria-describedby={reason ? describedBy : undefined}>
      {t("cart.checkout")}
    </CommitKey>
  );

  return (
    <div className="page grid gap-6 pb-10 pt-6 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:items-start lg:gap-x-10">
      <div className="grid min-w-0 gap-4 lg:col-start-1 lg:row-start-1">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h1 className="type-title text-ink">{t("cart.title")}</h1>
          <p className="type-label text-ink-2" aria-live="polite">
            {t("cart.count", { count: view.count, n: f.number(view.count) })}
          </p>
        </div>
        {blocked ? (
          <p role="alert" className="flex items-start gap-2 rounded-md bg-paper px-3 py-2.5 type-label font-medium text-red-ink">
            <Icon name="warning-circle" size={18} className="mt-0.5 shrink-0" />
            {t("cart.blockedNotice")}
          </p>
        ) : null}
        <ul className="grid gap-3" aria-label={t("cart.linesLabel")}>
          {editor.rows.map((row) => (
            <CartLineRow
              key={row.removed ? `removed:${row.line.id}` : row.line.id}
              line={row.line}
              removed={row.removed}
              busy={row.busy}
              error={row.error}
              onQtyChange={(qty) => editor.setQty(row.line.id, qty)}
              onRemove={() => editor.remove(row.line.id)}
              onRestore={() => editor.restore(row.line.id)}
              onDismiss={() => editor.dismiss(row.line.id)}
            />
          ))}
        </ul>
      </div>

      <aside className="grid gap-4 lg:sticky lg:top-[calc(var(--shell-header-h)+var(--safe-top)+var(--s-4))] lg:col-start-2 lg:row-span-2 lg:row-start-1" aria-label={t("cart.summaryLabel")}>
        <OrderSummary {...view} count={view.count} pending={editor.pending} headingLevel={2}>
          <CouponForm cart={view} locale={locale} onCart={(cart) => setOverride({ base: loaderData.cart as CartWithIssue, cart })} />
        </OrderSummary>
        <p className="flex items-start gap-2 type-caption text-ink-2">
          <Icon name="truck" size={16} className="mt-0.5 shrink-0" />
          {t("cart.deliveryNote")}
        </p>
        <div className="hidden gap-2 lg:grid">
          {commit(reasonId)}
          {reason ? (
            <p id={reasonId} className="type-caption font-medium text-ink-2">
              {reason}
            </p>
          ) : null}
        </div>
      </aside>

      {/* What completes the cart (devices area): after the summary on phones (DESIGN.md §8.5), under the lines from 1024. */}
      <RecommendationsSlot context="cart" result={loaderData.recommendations} className="min-w-0 pt-4 lg:col-start-1 lg:row-start-2" />

      <TaskBar aria-label={t("cart.barLabel")} className="lg:hidden">
        <div className="flex items-center gap-3">
          <div className="grid shrink-0 gap-0.5">
            <span className="type-caption text-ink-2">{t("cart.total")}</span>
            <Price amountIqd={view.totalIqd} size="md" approx="off" as="span" />
          </div>
          <div className="min-w-0 flex-1">{commit(`${reasonId}-bar`)}</div>
        </div>
        {reason ? (
          <p id={`${reasonId}-bar`} className="mt-1.5 type-caption font-medium text-ink-2">
            {reason}
          </p>
        ) : null}
      </TaskBar>
    </div>
  );
}
