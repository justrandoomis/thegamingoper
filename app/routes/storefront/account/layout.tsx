import { Form, isRouteErrorResponse, Outlet, useNavigation, useRouteLoaderData } from "react-router";
import type { ReactNode } from "react";

import type { Route } from "./+types/layout";
import { messagesFor } from "~/i18n/i18n.server";
import { LocaleLink, useFormat, useLocalePath, useT } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getAccountCounts } from "~/server/services/account/session.server";
import { getPendingTopupTotal } from "~/server/services/account/topups.server";
import { getWalletBalance } from "~/server/services/wallet.server";
import { EmptyState } from "~/ui/EmptyState";
import { ErrorState } from "~/ui/ErrorState";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ShellError } from "../shell/ShellError";
import { requireSignedIn } from "./account.server";
import { AccountNav } from "./components/AccountNav";
import { navHints } from "./components/hints";

/**
 * The signed-in part of the account: a side column with the sections from 1024px (on phones the overview page is the
 * section list and every page has a back link), and the page. Every child loader checks the session itself as well
 * (loaders run in parallel; a parent cannot protect its children).
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
  const href = useLocalePath();
  const navigation = useNavigation();
  const signOut = href("/account/logout");
  const signingOut = navigation.state !== "idle" && navigation.formAction === signOut;
  return (
    <div className="page grid gap-8 pb-12 pt-4 sm:pt-6 lg:grid-cols-[17.5rem_minmax(0,1fr)] lg:gap-10 lg:pt-8">
      {data ? (
        // Stays in place while the pages beside it push sideways (docs/MOTION.md, persistent chrome).
        <aside className="hidden lg:block" data-motion-persist="float">
          <div className="sticky top-[calc(var(--shell-header-h)+1rem)] grid gap-4">
            <div className="grid gap-1 px-3">
              <p className="type-sub text-ink">{data.customer.name ?? t("overview.helloNoName")}</p>
              <p className="flex flex-wrap items-center gap-x-2 type-caption text-ink-2">
                <bdi dir="ltr" className="nums">
                  {data.customer.phoneMasked}
                </bdi>
                <Status tone={data.customer.phoneVerified ? "ok" : "neutral"}>{t(data.customer.phoneVerified ? "common.verified" : "common.unverified")}</Status>
              </p>
            </div>
            <AccountNav hints={navHints(t, f, data)} />
            <Form method="post" action={signOut} className="px-1">
              <Key type="submit" size="sm" variant="quiet" icon="sign-out" loading={signingOut}>
                {t("common.signOut")}
              </Key>
            </Form>
          </div>
        </aside>
      ) : null}
      <div className="grid min-w-0 content-start gap-8">{children}</div>
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

function AccountError({ error }: { error: unknown }) {
  const t = useT("account");
  if (isRouteErrorResponse(error) && error.status === 404) {
    return (
      <div className="grid gap-4">
        <h1 className="type-title text-ink">{t("common.notFoundTitle")}</h1>
        <EmptyState
          layout="stack"
          icon="magnifying-glass"
          title={t("common.notFoundText")}
          action={
            <Key as={LocaleLink} to="/account/orders">
              {t("nav.orders")}
            </Key>
          }
        />
      </div>
    );
  }
  return (
    <div className="grid gap-4">
      <h1 className="type-title text-ink">{t("common.errorTitle")}</h1>
      <ErrorState title={t("common.loadFailed")} text={t("common.errorText")} retryHref="." />
    </div>
  );
}
