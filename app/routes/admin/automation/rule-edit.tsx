import { Link, redirect } from "react-router";

import type { Route } from "./+types/rule-edit";
import { isEventType } from "~/server/services/admin/automation/catalog";
import { looseValues, ruleRawFromForm, type RuleRaw } from "~/server/services/admin/automation/definition";
import { ruleForEdit, ruleFormOptions, saveRule } from "~/server/services/admin/automation/rules.server";
import { automation, text } from "./automation.server";
import { RuleForm } from "./components/RuleForm";
import { PageHead, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/rules/:ruleId/edit — a new version of a rule (automation.workflow.manage): the builder with the
 * rule's current definition, a reason for the change, and — for a rule that is switched on — a confirmation that it
 * stops until the new version passes a dry run and someone else switches it on.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.workflow.manage");
  const [rule, options] = await automation.orRespond(() => Promise.all([ruleForEdit(req.db, req.actor, args.params.ruleId), ruleFormOptions(req.db, req.actor, req.locale)]));
  const asked = new URL(args.request.url).searchParams.get("event");
  return { rule, options, event: isEventType(asked) ? asked : rule.event };
}

export async function action(args: Route.ActionArgs) {
  const req = await automation.open(args, "automation.workflow.manage");
  let raw: RuleRaw = {};
  try {
    // a body that is not a form is the request's mistake (400), never a crash
    const form = await automation.form(args.request);
    raw = ruleRawFromForm(form);
    const saved = await saveRule(req.db, req.actor, { ruleId: args.params.ruleId, expectedUpdatedAt: text(form, "expectedUpdatedAt"), definition: raw, reason: text(form, "reason") }, req.now);
    return redirect(`/admin/automation/rules/${saved.ruleId}`);
  } catch (error) {
    return automation.failed(error, req, "save", { values: looseValues(raw) });
  }
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "builder.titleEdit");

export default function RuleEditPage({ loaderData, actionData }: Route.ComponentProps) {
  const t = useAutoT();
  const { rule, options, event } = loaderData;
  const failure = actionData && actionData.ok === false ? actionData : null;
  return (
    <>
      <PageHead
        eyebrow={
          <Link to={`/admin/automation/rules/${rule.id}`} className="adm-link">
            <bdi>{rule.name}</bdi>
          </Link>
        }
        title={t("builder.titleEdit")}
        lead={t("builder.leadEdit", { version: rule.version, next: rule.version + 1 })}
      />
      <RuleForm
        mode="edit"
        event={event}
        eventHref={(type) => `/admin/automation/rules/${rule.id}/edit?event=${encodeURIComponent(type)}`}
        values={failure?.values ?? { name: rule.name, description: rule.description, event: rule.event, match: rule.match, actions: rule.actions }}
        options={options}
        fields={failure?.fields ?? {}}
        message={failure?.message ?? null}
        expectedUpdatedAt={rule.updatedAt}
        stopsActive={rule.status === "active"}
        cancelHref={`/admin/automation/rules/${rule.id}`}
      />
    </>
  );
}
