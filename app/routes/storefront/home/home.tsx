import type { Route } from "./+types/home";
import { useT } from "~/i18n/react";

export function meta({ matches }: Route.MetaArgs) {
  const root = matches.find((m) => m?.id === "root")?.loaderData as { i18n?: { common?: { brand?: { title?: string; tagline?: string } } } } | undefined;
  const brand = root?.i18n?.common?.brand;
  return [{ title: brand?.title ?? "TamTam Games" }, { name: "description", content: brand?.tagline ?? "" }];
}

export default function Home() {
  const t = useT("common");
  return (
    <main className="root-error">
      <h1>{t("brand.name")}</h1>
      <p>{t("brand.tagline")}</p>
    </main>
  );
}
