import { Link, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/index";
import { Icon, type IconName } from "~/art/Icon";
import { useFormat, useLocale } from "~/i18n/react";
import { PIPELINE_STEPS, type QueueCounts } from "~/server/services/admin/devices/types";
import type { DevicesAccess } from "~/server/services/admin/devices/shared.server";
import { Key } from "~/ui/Key";
import { ModuleFunctions } from "../blueprint-status";
import { blueprintModule } from "../shell/blueprint-catalog";
import { adminMeta } from "../shell/meta";
import { openDevices } from "./devices.server";
import { DEVICES_LAYOUT_ID } from "./meta";
import { useDevicesT } from "./ui";

/**
 * /admin/devices — the module's front page: what waits for this employee (raised clay only where a person decides),
 * the trade-in workflow of the blueprint in seven steps with where each one happens, the module's sections, and the
 * status of its blueprint functions.
 */
export async function loader({ context }: Route.LoaderArgs) {
  await openDevices(context);
  return null;
}

export const meta: Route.MetaFunction = (args) => adminMeta(args, (t) => t("modules.devices"));

type LayoutData = { counts: QueueCounts; access: DevicesAccess };

const QUEUES: { id: keyof QueueCounts; to: string; icon: IconName; decide: boolean }[] = [
  { id: "toInspect", to: "/admin/devices/trade-ins?view=new", icon: "magnifying-glass", decide: true },
  { id: "toOffer", to: "/admin/devices/trade-ins?view=inspected", icon: "scales", decide: true },
  { id: "awaitingAnswer", to: "/admin/devices/trade-ins?view=offered", icon: "hourglass", decide: false },
  { id: "toPay", to: "/admin/devices/trade-ins?view=accepted", icon: "hand-coins", decide: true },
  { id: "unitsToInspect", to: "/admin/devices/used?view=todo", icon: "clipboard-text", decide: true },
  { id: "toList", to: "/admin/devices/used?view=ready", icon: "storefront", decide: true },
];

const SECTIONS: { id: string; to: string; icon: IconName; show: (access: DevicesAccess) => boolean }[] = [
  { id: "tradeIns", to: "/admin/devices/trade-ins", icon: "swap", show: (access) => access.tradeRead },
  { id: "used", to: "/admin/devices/used", icon: "game-controller", show: (access) => access.usedRead },
  { id: "registry", to: "/admin/devices/registry", icon: "barcode", show: (access) => access.registry },
  { id: "digital", to: "/admin/devices/digital", icon: "key", show: (access) => access.any },
  { id: "templates", to: "/admin/devices/templates", icon: "clipboard-text", show: (access) => access.any },
  { id: "guides", to: "/admin/devices/guides", icon: "coins", show: (access) => access.guidesRead },
];

export default function DevicesHome() {
  const t = useDevicesT();
  const f = useFormat();
  const locale = useLocale();
  const layout = useRouteLoaderData(DEVICES_LAYOUT_ID) as LayoutData | undefined;
  const blueprint = blueprintModule("13");
  const counts = layout?.counts ?? null;
  const access = layout?.access;
  const cards = counts ? QUEUES.filter((queue) => counts[queue.id] !== null) : [];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrow", { id: "13", priority: blueprint?.priority ?? "P0" })}</p>
        {/* the blueprint names the module in ar and en only: Sorani uses the module's own title */}
        <h1 className="adm-title">{blueprint && locale !== "ckb" ? blueprint[locale === "en" ? "en" : "ar"] : t("title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("lead")}</p>
      </header>

      {cards.length > 0 ? (
        <section className="adm-section" aria-labelledby="devices-waiting">
          <h2 id="devices-waiting" className="adm-h2">
            {t("queues.title")}
          </h2>
          <div className="adm-grid">
            {cards.map((card) => {
              const count = counts?.[card.id] ?? 0;
              return (
                <article key={card.id} className={card.decide && count > 0 ? "adm-card adm-card--act" : "adm-card"}>
                  <p className="flex items-center gap-2 type-caption text-ink-2">
                    <Icon name={card.icon} size={16} />
                    {t(`queues.${card.id}.label`)}
                  </p>
                  <p className="type-kpi nums">
                    <bdi>{f.number(count)}</bdi>
                  </p>
                  <p className="type-caption text-ink-2">{count > 0 ? t(`queues.${card.id}.some`, { count }) : t(`queues.${card.id}.none`)}</p>
                  <div>
                    <Key as={Link} to={card.to} size="sm" iconEnd="arrow-right">
                      {t(`queues.${card.id}.open`)}
                    </Key>
                  </div>
                </article>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="adm-section" aria-labelledby="devices-workflow">
        <h2 id="devices-workflow" className="adm-h2">
          {t("home.workflow")}
        </h2>
        <p className="max-w-[70ch] type-body text-ink-2">{t("home.workflowLead")}</p>
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {PIPELINE_STEPS.map((step, index) => (
            <li key={step} className="adm-card">
              <p className="type-caption text-ink-2">
                <bdi className="nums">{f.number(index + 1)}</bdi> · {t(`step.${step}`)}
              </p>
              <p className="type-body">{t(`home.steps.${step}`)}</p>
            </li>
          ))}
        </ol>
      </section>

      {access ? (
        <section className="adm-section" aria-labelledby="devices-sections">
          <h2 id="devices-sections" className="adm-h2">
            {t("home.sections")}
          </h2>
          <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {SECTIONS.filter((section) => section.show(access)).map((section) => (
              <li key={section.id}>
                <Link to={section.to} className="dev-card">
                  <span className="flex items-center gap-2 type-strong">
                    <Icon name={section.icon} size={18} />
                    {t(`nav.${section.id}`)}
                  </span>
                  <span className="type-caption text-ink-2">{t(`home.about.${section.id}`)}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <ModuleFunctions moduleId="13" />
    </>
  );
}
