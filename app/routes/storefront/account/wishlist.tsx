import { useEffect, useState } from "react";
import { data, Form, useRevalidator } from "react-router";

import type { Route } from "./+types/wishlist";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useT } from "~/i18n/react";
import { getCustomer } from "~/server/auth/customer.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { enforceRateLimit, limitKey } from "~/server/ratelimit.server";
import { listWishlist, reconcileGuestWishlist, setWished, WISHLIST_CHANGES_PER_IP, wishlistWho } from "~/server/services/wishlist.server";
import type { ProductCardData } from "~/lib/dto";
import { cartErrorKey, postForm, readFailure, type PostOutcome } from "~/ui/cart-client";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { ProductCard } from "~/ui/ProductCard";
import { TextLink } from "~/ui/TextLink";
import { toast } from "~/ui/toast-store";
import { accountFailure, formFields, setWishCookie } from "./account.server";
import { Notice, rescueFocus } from "./components/FormBits";
import { accountMeta } from "./components/meta";
import "./account.css";

/**
 * Favourites (brief §3.10, Design System v2 §6.12) for everyone: a signed-in customer's list lives in the account; a
 * guest's on the cart cookie (wishlist.server explains the bridge cookie), and joins the account at sign-in. The cards
 * are the catalogue's own (prices, availability and the add button come from the read layer; the pinned foot keeps
 * their baselines aligned); products no longer sold are counted, not invented. «أزل» under each card can be undone.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const session = await getCustomer(ctx, db);
  let who = wishlistWho(ctx.cookie, session?.customer.id ?? null);
  if (!session) {
    // The cart's token changed since the favourites were saved: move them to it before reading.
    const token = await reconcileGuestWishlist(db, who);
    if (token && token !== who.wishToken && who.wishToken) setWishCookie(ctx, token);
    who = { customerId: null, cartToken: token, wishToken: null };
  }
  const page = await listWishlist(db, who, ctx.locale, ctx.now);
  return data(
    { signedIn: session !== null, items: page.items, unavailable: page.unavailable, i18n: messagesFor(ctx.locale, "account") },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export function headers({ loaderHeaders }: Route.HeadersArgs) {
  return { "Cache-Control": loaderHeaders.get("Cache-Control") ?? "private, no-store" };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const fields = formFields(await request.formData());
  const session = await getCustomer(ctx, db);
  try {
    // The same per-IP budget as POST /api/wishlist (security review 2026-11).
    await enforceRateLimit(db, await limitKey("wishlist", "ip", ctx.ip), WISHLIST_CHANGES_PER_IP, ctx.now);
    const change = await setWished(db, wishlistWho(ctx.cookie, session?.customer.id ?? null), fields.productId, fields.intent === "add", ctx.now);
    if (!session && change.guestToken) setWishCookie(ctx, change.guestToken);
    return data({ ok: true as const, intent: fields.intent ?? null, productId: fields.productId ?? "", wished: change.wished });
  } catch (error) {
    const failure = accountFailure(error, ctx.locale);
    const headers = failure.retryAfterSec === undefined ? undefined : { "Retry-After": String(failure.retryAfterSec) };
    return data({ ...failure, intent: fields.intent ?? null, productId: fields.productId ?? "" }, { status: failure.status, headers });
  }
}

export const meta: Route.MetaFunction = (args) => accountMeta(args, "wishlist");

export default function Wishlist({ loaderData }: Route.ComponentProps) {
  const t = useT("account");
  const ui = useT("ui-shop");
  const revalidator = useRevalidator();
  const [removed, setRemoved] = useState<Set<string>>(() => new Set());
  const items = loaderData.items.filter((card) => !removed.has(card.id));
  const signIn = "/account/login?next=%2Fwishlist";

  // A fresh read of the page (after a removal, an undo, any revalidation) is the truth again.
  useEffect(() => setRemoved(new Set()), [loaderData.items]);

  const failed = (code: string) => toast.error(t("wishlist.failed"), { detail: ui(cartErrorKey(code)) });
  const answerOf = (outcome: PostOutcome) => {
    const json = outcome.kind === "answer" && outcome.json && typeof outcome.json === "object" ? (outcome.json as Record<string, unknown>) : null;
    return { ok: outcome.kind === "answer" && json?.ok === true, code: outcome.kind === "answer" ? readFailure(outcome.status, json).code : outcome.kind };
  };

  /** Undo: the product goes back on the list (the endpoint the favourite key uses), then the page reloads its data. */
  const restore = async (card: ProductCardData) => {
    const answer = answerOf(await postForm("/api/wishlist", { intent: "add", productId: card.id }));
    if (answer.ok) revalidator.revalidate();
    else failed(answer.code);
  };

  /**
   * Remove: the card goes at once and the toast offers to undo; if the server says no, the card comes back with the
   * reason (a failed action rolls back and says why).
   */
  const remove = async (card: ProductCardData) => {
    // The card and its «أزل» key leave at once: focus lands on the card that takes its place (or the one before it,
    // or the page's title when it was the last), never on <body>. The toast below says what happened (role="status")
    // once the server agreed — one announcement, not two.
    const at = items.findIndex((item) => item.id === card.id);
    const neighbour = items[at + 1] ?? items[at - 1];
    setRemoved((set) => new Set(set).add(card.id));
    rescueFocus(neighbour ? `wish-${neighbour.id}` : "wishlist-title");
    const answer = answerOf(await postForm("/api/wishlist", { intent: "remove", productId: card.id }));
    if (answer.ok) {
      toast.success(t("wishlist.removed", { name: card.name }), { action: { label: t("wishlist.undo"), onAction: () => void restore(card) } });
      revalidator.revalidate();
      return;
    }
    setRemoved((set) => {
      const next = new Set(set);
      next.delete(card.id);
      return next;
    });
    failed(answer.code);
  };

  return (
    <div className="page">
      <div className="grid gap-6 pb-12 pt-4 md:pt-6 lg:pt-8">
        <header className="acct-head">
          <h1 id="wishlist-title" tabIndex={-1} className="type-h1 text-ink">
            {t("wishlist.title")}
          </h1>
          {items.length > 0 ? <p className="acct-head__lead">{t("wishlist.count", { count: items.length })}</p> : null}
        </header>
        {!loaderData.signedIn ? (
          <Notice>
            <p>{t("wishlist.guest")}</p>
            <TextLink as={LocaleLink} to={signIn}>
              {t("wishlist.signIn")}
            </TextLink>
          </Notice>
        ) : null}
        {loaderData.unavailable > 0 ? <Notice>{t("wishlist.unavailable", { count: loaderData.unavailable })}</Notice> : null}
        {items.length === 0 ? (
          <EmptyState
            layout="stack"
            panel
            title={t("wishlist.emptyTitle")}
            text={t("wishlist.emptyText")}
            action={
              <Key as={LocaleLink} to="/" variant="primary" icon="storefront">
                {t("wishlist.browse")}
              </Key>
            }
          />
        ) : (
          <ul className="cards cards--5">
            {items.map((card, index) => (
              <li key={card.id} id={`wish-${card.id}`} tabIndex={-1} className="flex min-w-0 flex-col gap-1">
                <ProductCard card={card} headingLevel={2} priority={index === 0} className="flex-1" />
                {/* A plain form (works before script loads); with script the removal is optimistic and can be undone. */}
                <Form
                  method="post"
                  className="justify-self-start"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void remove(card);
                  }}
                >
                  <input type="hidden" name="intent" value="remove" />
                  <input type="hidden" name="productId" value={card.id} />
                  <Key type="submit" size="sm" variant="ghost" icon="trash" aria-label={t("wishlist.removeNamed", { name: card.name })}>
                    {t("wishlist.remove")}
                  </Key>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
