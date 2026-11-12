import { isRouteErrorResponse, Outlet, useRevalidator, useRouteLoaderData } from "react-router";
import type { ReactNode } from "react";

import type { Route } from "./+types/layout";
import { Icon } from "~/art/Icon";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { codeDelivery } from "~/server/services/account/codes.server";
import { getAccountCounts } from "~/server/services/account/session.server";
import { getPendingTopupTotal } from "~/server/services/account/topups.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { ErrorState } from "~/ui/ErrorState";
import { Key } from "~/ui/Key";
import { TextLink } from "~/ui/TextLink";
import { ShellError } from "../shell/ShellError";
import { requireSignedIn } from "./account.server";
import { AccountNav, SignOut } from "./components/AccountNav";
import { navHints } from "./components/hints";
import "./account.css";

/**
 * The signed-in part of the account (Design System v2 §6.12): from 1024px a 264px side column with the grouped section
 * list (الطلبات والمرتجعات · المال · الحساب) and a quiet «سجّل الخروج» at its end; below 1024 the overview page is the
 * section list and every page has a back link. Every child loader checks the session itself as well (loaders run in
 * parallel; a parent cannot protect its children).
 */
export const ACCOUNT_LAYOUT_ID = "routes/storefront/account/layout";

export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { customer } = await requireSignedIn(request, ctx, db);
  const [counts, balanceIqd, pendingIqd] = await Promise.all([getAccountCounts(db, customer.id), getWalletBalance(db, customer.id), getPendingTopupTotal(db, customer.id)]);
  return {
    customer: { name: customer.name, phoneMasked: customer.phoneMasked, phoneVerified: customer.phoneVerified },
    counts,
    wallet: { balanceIqd, pendingIqd },
    // A number can be confirmed only when a text-message provider is configured; until then nothing offers it (§6.12).
    phoneCodes: codeDelivery(ctx.isDev) === "provider",
    i18n: messagesFor(ctx.locale, "account"),
  };
}

export type AccountLayoutData = Awaited<ReturnType<typeof loader>>;

/** The layout's data from any account page (counts, wallet, who is signed in). */
export function useAccountData(): AccountLayoutData | undefined {
  return useRouteLoaderData(ACCOUNT_LAYOUT_ID) as AccountLayoutData | undefined;
}

export default function AccountLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AccountFrame data={loaderData}>
      <Outlet />
    </AccountFrame>
  );
}

function AccountFrame({ data, children }: { data: AccountLayoutData | undefined; children: ReactNode }) {
  const t = useT("account");
  const f = useFormat();
  return (
    <div className="page">
      <div className="acct-frame">
        {data ? (
          // Stays in place while the pages beside it push sideways (docs/MOTION.md, persistent chrome).
          <div className="acct-side" data-motion-persist="float">
            <AccountNav hints={navHints(t, f, data)} />
            <SignOut />
          </div>
        ) : null}
        <div className="acct-main">{children}</div>
      </div>
    </div>
  );
}

export function ErrorBoundary({ error, loaderData }: Route.ErrorBoundaryProps) {
  const data = loaderData as AccountLayoutData | undefined;
  // The layout's own data failed: its strings are missing too, so the shell's panel (in the visitor's language) speaks.
  if (!data) return <ShellError error={error} platforms={[]} />;
  return (
    <AccountFrame data={data}>
      <AccountError error={error} />
    </AccountFrame>
  );
}

/** A page of the account failed: say so inside the account frame, with one way on (§6.16). */
function AccountError({ error }: { error: unknown }) {
  const t = useT("account");
  const revalidator = useRevalidator();
  if (isRouteErrorResponse(error) && error.status === 404) {
    // The kit's empty-state anatomy, with the page's h1 (nothing else on the page names it).
    return (
      <div className="empty">
        <span className="empty__art" aria-hidden="true">
          <Icon name="magnifying-glass" size={24} className="text-red-ink" />
        </span>
        <h1 className="empty__title">{t("common.notFoundTitle")}</h1>
        <p className="empty__text">{t("common.notFoundText")}</p>
        <div className="empty__actions">
          <Key as={LocaleLink} to="/account/orders" variant="primary">
            {t("nav.orders")}
          </Key>
          <TextLink as={LocaleLink} to="/account">
            {t("nav.back")}
          </TextLink>
        </div>
      </div>
    );
  }
  return (
    <>
      <h1 className="sr-only">{t("common.errorTitle")}</h1>
      <ErrorState layout="stack" title={t("common.errorTitle")} text={t("common.errorText")} onRetry={() => void revalidator.revalidate()} retrying={revalidator.state === "loading"} />
    </>
  );
}
