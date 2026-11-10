import { data, isRouteErrorResponse, Outlet } from "react-router";

import type { Route } from "./+types/_layout";
import { isLocale } from "~/lib/locales";

/**
 * Storefront layout: validates the optional locale segment and hosts the shopping shell
 * (header, navigation, footer, cart feedback) around every customer page.
 */
export function loader({ params }: Route.LoaderArgs) {
  // "/xyz" matches ":locale?" with locale = "xyz" — anything that is not a non-default locale code is a 404.
  if (params.locale !== undefined && (!isLocale(params.locale) || params.locale === "ar")) {
    throw data({ error: "not_found" }, { status: 404 });
  }
  return null;
}

export default function StorefrontLayout() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <main className="root-error">
      <p className="root-error__code" dir="ltr">{status}</p>
      <h1>{status === 404 ? "الصفحة غير موجودة" : "حدث خطأ غير متوقع"}</h1>
      <a href="/">العودة إلى الرئيسية</a>
    </main>
  );
}
