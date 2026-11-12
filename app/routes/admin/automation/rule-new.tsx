import { redirect } from "react-router";

import type { Route } from "./+types/rule-new";
import { isEventType } from "~/server/services/admin/automation/catalog";
import { looseValues, ruleRawFromForm, type RuleRaw } from "~/server/services/admin/automation/definition";
import { ruleFormOptions, saveRule } from "~/server/services/admin/automation/rules.server";
import { branchLimited } from "~/server/services/admin/automation/shared.server";
import { automation, newKey } from "./automation.server";
import { RuleForm } from "./components/RuleForm";
import { Note, PageHead, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/rules/new — 19.01's builder for a new rule (automation.workflow.manage): an event from the
 * catalogue (?event=), its conditions, its actions, a name. Saved as a DRAFT (version 1), which does nothing until a
 * dry run and someone else switches it on. The form's key makes a resubmission open the same rule.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.workflow.manage");
  const event = new URL(args.request.url).searchParams.get("event");
  const options = await automation.orRespond(() => ruleFormOptions(req.db, req.actor, req.locale));
  return { event: isEventType(event) ? event : null, options, key: newKey(), limited: branchLimited(req.actor) };
}

export async function action(args: Route.ActionArgs) {
  const req = await automation.open(args, "automation.workflow.manage");
  let raw: RuleRaw = {};
  try {
    // a body that is not a form is the request's mistake (400), never a crash
    const form = await automation.form(args.request);
    raw = ruleRawFromForm(form);
    const key = form.get("idempotencyKey");
    const saved = await saveRule(req.db, req.actor, { definition: raw, idempotencyKey: typeof key === "string" ? key : "" }, req.now);
    return redirect(`/admin/automation/rules/${saved.ruleId}`);
  } catch (error) {
    return automation.failed(error, req, "save", { values: looseValues(raw) });
  }
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "builder.titleNew");

export default function RuleNewPage({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAutoT();
  const { event, options, key, limited } = loaderData;
  const failure = actionData && "ok" in actionData && actionData.ok === false ? actionData : null;
  return (
    <>
      <PageHead title={t("builder.titleNew")} lead={t("builder.lead")} />
      {limited ? (
        <Note tone="warn" icon="warning">
          <p>{t("rules.branchLimited")}</p>
        </Note>
      ) : null}
      <RuleForm
        mode="new"
        event={event}
        eventHref={(type) => `/admin/automation/rules/new?event=${encodeURIComponent(type)}`}
        values={failure?.values ?? null}
        options={options}
        fields={failure?.fields ?? {}}
        message={failure?.message ?? null}
        idempotencyKey={key}
        cancelHref="/admin/automation/rules"
      />
    </>
  );
}
