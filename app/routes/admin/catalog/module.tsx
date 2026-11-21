import { useEffect, useRef } from "react";
import { Outlet, useLocation, useMatches } from "react-router";

import type { Route } from "./+types/module";
import { messagesFor, serverT } from "~/i18n/i18n.server";
import { Tabs } from "~/ui/Tabs";
import { catalogRequest } from "./catalog.server";
import { useCatalogT } from "./components/ui";

/**
 * /admin/catalog/* — the module's frame: its strings for every page below, and the section tabs (products,
 * categories, devices, compatibility, import, Switch library) on the module's own pages. A product's editor has its own tabs, so
 * the section tabs step aside there. Needs catalog.product.read (every role with a catalogue permission holds it).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { locale } = await catalogRequest(context, "catalog.product.read");
  // The Switch library tab's one word comes from its own namespace (the rest of its strings load on its pages).
  return { i18n: messagesFor(locale, "admin-catalog", "errors"), switchLibraryTab: serverT(locale, "admin-switch-library")("nav.tab") };
}

const SECTIONS = [
  { value: "products", href: "/admin/catalog", match: (path: string) => path === "/admin/catalog" || path === "/admin/catalog/new" },
  { value: "categories", href: "/admin/catalog/categories", match: (path: string) => path.startsWith("/admin/catalog/categories") },
  { value: "devices", href: "/admin/catalog/devices", match: (path: string) => path.startsWith("/admin/catalog/devices") || path.startsWith("/admin/catalog/compare") },
  { value: "compatibility", href: "/admin/catalog/compatibility", match: (path: string) => path.startsWith("/admin/catalog/compatibility") },
  { value: "import", href: "/admin/catalog/import", match: (path: string) => path.startsWith("/admin/catalog/import") },
  { value: "switch-library", href: "/admin/catalog/switch-library", match: (path: string) => path.startsWith("/admin/catalog/switch-library") },
] as const;

export default function CatalogModule({ loaderData }: Route.ComponentProps) {
  const t = useCatalogT();
  const { pathname } = useLocation();
  const matches = useMatches();
  const inEditor = matches.some((match) => match.id === "routes/admin/catalog/product-editor");
  const path = pathname.replace(/\/+$/, "") || "/";
  const current = SECTIONS.find((section) => section.match(path))?.value ?? "products";
  // On a phone the six section tabs scroll sideways: bring the current one into view (Import and Switch library sit off-screen).
  const nav = useRef<HTMLDivElement>(null);
  useEffect(() => {
    nav.current?.querySelector<HTMLElement>('[aria-current="page"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [current, inEditor]);
  return (
    <>
      {inEditor ? null : (
        <div ref={nav}>
          <Tabs
            aria-label={t("nav.label")}
            className="mb-5"
            value={current}
            items={SECTIONS.map((section) => ({ value: section.value, label: section.value === "switch-library" ? loaderData.switchLibraryTab : t(`nav.${section.value}`), href: section.href }))}
          />
        </div>
      )}
      <Outlet />
    </>
  );
}
