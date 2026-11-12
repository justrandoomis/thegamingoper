import { Link } from "react-router";

import type { Route } from "./+types/assistant";
import { automationAccess } from "~/server/services/admin/automation/shared.server";
import { automation } from "./automation.server";
import { Note, PageHead, Section, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/assistant — 19.06, a boundary: an admin assistant that asks the data needs a language model, and
 * none is configured (no provider, no key, no contract on what data may leave). The page says so, says what such an
 * assistant would have to respect (every answer through the same permission-checked services, cost and profit only
 * with cost.read / profit.read, never a change), and points at what answers questions today.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.assistant.use");
  return { access: automationAccess(req.actor) };
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "assistant.title");

export default function AssistantPage({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const { access } = loaderData;
  return (
    <>
      <PageHead title={t("assistant.title")} lead={t("assistant.lead")} />
      <Note tone="warn" icon="robot">
        <p>{t("assistant.boundary")}</p>
      </Note>
      <Section id="auto-assistant-needs" title={t("assistant.needsTitle")}>
        <ul className="auto-lines type-body">
          <li>{t("assistant.need.provider")}</li>
          <li>{t("assistant.need.data")}</li>
          <li>{t("assistant.need.permissions")}</li>
          <li>{t("assistant.need.readOnly")}</li>
        </ul>
      </Section>
      <Section id="auto-assistant-today" title={t("assistant.todayTitle")}>
        <ul className="auto-lines type-body">
          <li>{t("assistant.today.palette")}</li>
          {access.rules ? (
            <li>
              <Link to="/admin/automation/rules" className="adm-link">
                {t("assistant.today.rules")}
              </Link>
            </li>
          ) : null}
          {access.anomalies ? (
            <li>
              <Link to="/admin/automation/anomalies" className="adm-link">
                {t("assistant.today.anomalies")}
              </Link>
            </li>
          ) : null}
        </ul>
      </Section>
    </>
  );
}
