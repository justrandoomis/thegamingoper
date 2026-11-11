/**
 * A module's page while the module is not built: its blueprint number, priority and title, one sentence that says
 * the screens do not exist yet, and the status of each of its functions (<ModuleFunctions>). The shell serves it at
 * /admin/<slug> for every module the employee may see (routes/admin/shell/module.tsx); a module owner may also render
 * it from their own index route until their first screen lands.
 *
 *   import { ModuleLanding } from "~/routes/admin/shell/ModuleLanding";
 *   export default function OrdersHome() { return <ModuleLanding moduleId="05" />; }
 */
import type { ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useLocale } from "~/i18n/react";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "./blueprint-catalog";
import { useAdminT } from "./i18n";
import { moduleById } from "./modules";

export type ModuleLandingProps = {
  /** Blueprint module id, "01" … "23". */
  moduleId: string;
  /** Replaces the default sentence ("This section's screens are not built yet…"). */
  lead?: ReactNode;
  children?: ReactNode;
};

export function ModuleLanding({ moduleId, lead, children }: ModuleLandingProps) {
  const t = useAdminT();
  const locale = useLocale();
  const blueprint = blueprintModule(moduleId);
  const module = moduleById(moduleId);
  if (!blueprint || !module) return null;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("module.eyebrow", { id: blueprint.id, priority: t(`priority.${blueprint.priority}`) })}</p>
        <h1 className="adm-title flex items-center gap-3">
          <Icon name={module.icon} size={28} className="text-ink-2" />
          <span>{blueprint[locale === "en" ? "en" : "ar"]}</span>
        </h1>
        <p className="max-w-[60ch] type-body text-ink-2">{lead ?? t("module.lead")}</p>
      </header>
      {children}
      <ModuleFunctions moduleId={moduleId} />
    </>
  );
}
