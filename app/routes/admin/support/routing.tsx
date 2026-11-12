import { useState } from "react";
import { data, Link } from "react-router";

import type { Route } from "./+types/routing";
import { useFormat } from "~/i18n/react";
import { forbidden, invalid, throwAsResponse } from "~/server/errors";
import { can } from "~/server/actor";
import { deleteRoutingRule, listRoutingRules, moveRoutingRule, previewRule, routeWaitingTickets, saveRoutingRule, type RoutingRuleRow } from "~/server/services/admin/support/routing.server";
import { DEFAULT_CAPACITY, TICKET_CATEGORIES, TICKET_CHANNELS, TICKET_PRIORITIES, type AgentLoad } from "~/server/services/admin/support/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { Checkbox, FieldGroup, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { supportMeta } from "./meta";
import { all, checked, failure, openSupport, text, whole } from "./support.server";
import { Failure, listOf, Num, Ref, Section, useIntent, useSupportT } from "./ui";

/**
 * /admin/support/routing — routing rules (14.03): by topic (category, channel, keywords), priority and agent capacity,
 * tried in order (the first match wins); the pool's agent with the fewest open tickets under the rule's capacity gets
 * the ticket, otherwise it waits in the rule's team queue — and the reason is recorded on the ticket. Every agent's
 * load; a dry run of a rule against the open tickets; routing the tickets that wait now. Reading needs
 * support.ticket.assign or support.routing.manage; changing the rules support.routing.manage.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await openSupport(context, ["support.ticket.assign", "support.routing.manage"]);
  try {
    return { page: await listRoutingRules(db, actor), canRoute: can(actor, "support.ticket.assign") };
  } catch (error) {
    throwAsResponse(error);
  }
}

function ruleInput(form: FormData) {
  return {
    id: text(form, "ruleId") || undefined,
    version: text(form, "version") || undefined,
    name: text(form, "name"),
    categories: all(form, "categories") as never[],
    channels: all(form, "channels") as never[],
    priorities: all(form, "priorities") as never[],
    keywords: text(form, "keywords"),
    agents: all(form, "agents"),
    capacity: whole(form, "capacity") ?? DEFAULT_CAPACITY,
    team: text(form, "team"),
    setPriority: (text(form, "setPriority") || null) as never,
    isActive: checked(form, "isActive"),
    reason: text(form, "reason"),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openSupport(context, ["support.ticket.assign", "support.routing.manage"]);
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    switch (intent) {
      case "save": {
        if (!can(actor, "support.routing.manage")) throw forbidden("support.routing.manage");
        const result = await saveRoutingRule(db, actor, ruleInput(form), now);
        return { ok: true as const, intent, created: result.created };
      }
      case "move":
        if (!can(actor, "support.routing.manage")) throw forbidden("support.routing.manage");
        await moveRoutingRule(db, actor, { ruleId: text(form, "ruleId"), direction: text(form, "direction") }, now);
        return { ok: true as const, intent };
      case "delete":
        if (!can(actor, "support.routing.manage")) throw forbidden("support.routing.manage");
        await deleteRoutingRule(db, actor, { ruleId: text(form, "ruleId"), reason: text(form, "reason"), version: text(form, "version") || undefined }, now);
        return { ok: true as const, intent };
      case "preview": {
        const { reason: _reason, id: _id, version: _version, ...rule } = ruleInput(form);
        return { ok: true as const, intent, preview: await previewRule(db, actor, rule) };
      }
      case "route_waiting": {
        if (!can(actor, "support.ticket.assign")) throw forbidden("support.ticket.assign");
        return { ok: true as const, intent, ...(await routeWaitingTickets(db, actor, now)) };
      }
      default:
        throw invalid({ intent: "invalid" });
    }
  } catch (error) {
    const result = failure(error, locale, intent || null);
    return data(result, { status: result.status });
  }
}

export const meta: Route.MetaFunction = (args) => supportMeta(args, "routing.title");

type Page = NonNullable<Route.ComponentProps["loaderData"]["page"]>;

export default function RoutingPage({ loaderData }: Route.ComponentProps) {
  const t = useSupportT();
  const { page, canRoute } = loaderData;
  const route = useIntent("route_waiting", (result) => (Number(result.routed ?? 0) > 0 ? "inbox.routed" : "inbox.routedNone"));
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("routing.title")}</h1>
        <p className="max-w-[72ch] type-body text-ink-2">{t("routing.lead")}</p>
      </header>

      {canRoute ? (
        <div className="sup-actions">
          <route.fetcher.Form method="post">
            <input type="hidden" name="intent" value="route_waiting" />
            <Key type="submit" size="sm" icon="swap" loading={route.pending} disabled={page.waiting === 0}>
              {page.waiting > 0 ? t("inbox.routeWaiting", { count: page.waiting }) : t("routing.noneWaiting")}
            </Key>
          </route.fetcher.Form>
          <span className="type-caption text-ink-2">{t("routing.jobNote")}</span>
          <Failure message={route.message} />
        </div>
      ) : null}

      <Section id="routing-rules" title={t("routing.rules")}>
        {page.rules.length === 0 ? <p className="type-body text-ink-2">{t("routing.empty")}</p> : null}
        <ol className="grid gap-3">
          {page.rules.map((rule, index) => (
            <li key={rule.id}>
              <RuleCard rule={rule} index={index} last={index === page.rules.length - 1} page={page} />
            </li>
          ))}
        </ol>
        {page.canManage ? (
          <Disclosure summary={t("routing.new")} variant="panel" defaultOpen={page.rules.length === 0}>
            <RuleForm page={page} rule={null} />
          </Disclosure>
        ) : (
          <p className="type-caption text-ink-2">{t("routing.readOnly")}</p>
        )}
      </Section>

      <Section id="routing-agents" title={t("routing.agents")}>
        <p className="type-caption text-ink-2">{t("routing.agentsLead")}</p>
        <AgentTable agents={page.agents} />
      </Section>
    </>
  );
}

function AgentTable({ agents }: { agents: AgentLoad[] }) {
  const t = useSupportT();
  if (agents.length === 0) return <p className="type-body text-ink-2">{t("routing.noAgents")}</p>;
  return (
    <div className="overflow-x-auto">
    <table className="table max-w-[36rem]" data-density="admin">
      <caption className="sr-only">{t("routing.agents")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("routing.agent")}</th>
          <th scope="col" className="is-num">
            {t("routing.openTickets")}
          </th>
          <th scope="col">{t("routing.see")}</th>
        </tr>
      </thead>
      <tbody>
        {agents.map((agent) => (
          <tr key={agent.id}>
            <td>{agent.name}</td>
            <td className="is-num">
              <Num value={agent.open} />
            </td>
            <td>
              <Link to={`/admin/support?view=open&assignee=${encodeURIComponent(agent.id)}`} className="adm-link">
                {t("routing.seeTickets")}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

function RuleCard({ rule, index, last, page }: { rule: RoutingRuleRow; index: number; last: boolean; page: Page }) {
  const t = useSupportT();
  const f = useFormat();
  const move = useIntent("move", "done.ruleMoved");
  const remove = useIntent("delete", "done.ruleDeleted", () => setDeleting(false));
  const [deleting, setDeleting] = useState(false);
  const or = t("routing.or");
  const conditions = [
    rule.categories.length ? t("routing.cond.categories", { list: rule.categories.map((category) => t(`category.${category}`)).join(` ${or} `) }) : null,
    rule.channels.length ? t("routing.cond.channels", { list: rule.channels.map((channel) => t(`channel.${channel}`)).join(` ${or} `) }) : null,
    rule.priorities.length ? t("routing.cond.priorities", { list: rule.priorities.map((priority) => t(`priority.${priority}`)).join(` ${or} `) }) : null,
    rule.keywords.length ? t("routing.cond.keywords", { list: listOf(rule.keywords.map((keyword) => `«${keyword}»`), t("listSep")) }) : null,
  ].filter((part): part is string => part !== null);
  return (
    <article className="sup-rule" data-active={rule.isActive ? "true" : "false"}>
      <div className="sup-rule__head">
        <span className="inline-flex flex-wrap items-center gap-2">
          <span className="sup-tag nums">{t("routing.position", { n: f.number(index + 1) })}</span>
          <span className="type-strong">{rule.name}</span>
          <Status tone={rule.isActive ? "ok" : "neutral"}>{t(rule.isActive ? "routing.active" : "routing.off")}</Status>
        </span>
        {page.canManage ? (
          <span className="sup-actions">
            <move.fetcher.Form method="post">
              <input type="hidden" name="intent" value="move" />
              <input type="hidden" name="ruleId" value={rule.id} />
              <input type="hidden" name="direction" value="up" />
              <Key type="submit" size="sm" icon="arrow-up" disabled={index === 0} loading={move.pending} aria-label={t("routing.up", { name: rule.name })}>
                {t("routing.upShort")}
              </Key>
            </move.fetcher.Form>
            <move.fetcher.Form method="post">
              <input type="hidden" name="intent" value="move" />
              <input type="hidden" name="ruleId" value={rule.id} />
              <input type="hidden" name="direction" value="down" />
              <Key type="submit" size="sm" icon="arrow-down" disabled={last} loading={move.pending} aria-label={t("routing.down", { name: rule.name })}>
                {t("routing.downShort")}
              </Key>
            </move.fetcher.Form>
            <Key size="sm" icon="trash" onClick={() => setDeleting(true)}>
              {t("routing.delete")}
            </Key>
          </span>
        ) : null}
      </div>
      <p className="type-body">
        <span className="text-ink-2">{t("routing.when")} </span>
        {conditions.length ? conditions.join(" · ") : t("routing.anyTicket")}
      </p>
      <p className="type-body">
        <span className="text-ink-2">{t("routing.then")} </span>
        {[
          rule.pool.length ? t("routing.toPool", { names: listOf(rule.pool.map((person) => person.name), t("listSep")), capacity: f.number(rule.capacity) }) : null,
          rule.team ? t("routing.toTeam", { team: rule.team }) : null,
          rule.setPriority ? t("routing.setPriority", { priority: t(`priority.${rule.setPriority}`) }) : null,
        ]
          .filter(Boolean)
          .join(" · ")}
      </p>
      {rule.inactive.length ? <p className="type-caption text-red-ink">{t("routing.inactivePool", { count: rule.inactive.length })}</p> : null}
      <Failure message={move.message} />
      {page.canManage ? (
        <Disclosure summary={t("routing.edit")} variant="row">
          <RuleForm page={page} rule={rule} />
        </Disclosure>
      ) : null}
      {deleting ? (
        <ConfirmDialog
          open
          onClose={() => setDeleting(false)}
          tone="destructive"
          title={t("routing.deleteQ", { name: rule.name })}
          consequence={t("routing.deleteWhat")}
          confirmLabel={t("routing.delete")}
          reason={{ label: t("dialog.reason"), hint: t("dialog.reasonHint") }}
          pending={remove.pending}
          error={remove.message}
          onConfirm={({ reason }) => remove.fetcher.submit({ intent: "delete", ruleId: rule.id, version: rule.version, reason }, { method: "post" })}
        />
      ) : null}
    </article>
  );
}

type Preview = { checked: number; count: number; matches: { ref: string; subject: string }[] };

function RuleForm({ page, rule }: { page: Page; rule: RoutingRuleRow | null }) {
  const t = useSupportT();
  const save = useIntent("save", (result) => (result.created ? "done.ruleCreated" : "done.ruleSaved"));
  const preview = useIntent("preview", null);
  const result = preview.fetcher.data;
  const tested = result && result.ok && result.intent === "preview" ? (result.preview as Preview) : null;
  const fields = save.fields;
  const id = rule?.id ?? "new";
  return (
    <save.fetcher.Form method="post" className="grid gap-4 pt-2" key={rule ? `${rule.id}-${rule.version}` : "new"}>
      <input type="hidden" name="intent" value="save" />
      {rule ? <input type="hidden" name="ruleId" value={rule.id} /> : null}
      {rule ? <input type="hidden" name="version" value={rule.version} /> : null}
      <div className="grid gap-3 md:grid-cols-2">
        <TextField name="name" label={t("routing.form.name")} defaultValue={rule?.name ?? ""} required error={fields.name} />
        <TextField name="team" label={t("routing.form.team")} hint={t("routing.form.teamHint")} defaultValue={rule?.team ?? ""} optional list={`teams-${id}`} error={fields.team} />
        <datalist id={`teams-${id}`}>
          {page.teams.map((team) => (
            <option key={team} value={team} />
          ))}
        </datalist>
      </div>
      <FieldGroup legend={t("routing.form.categories")} hint={t("routing.form.anyHint")} layout="row">
        {TICKET_CATEGORIES.map((category) => (
          <Checkbox key={category} name="categories" value={category} label={t(`category.${category}`)} defaultChecked={rule?.categories.includes(category)} />
        ))}
      </FieldGroup>
      <FieldGroup legend={t("routing.form.channels")} hint={t("routing.form.anyHint")} layout="row">
        {TICKET_CHANNELS.map((channel) => (
          <Checkbox key={channel} name="channels" value={channel} label={t(`channel.${channel}`)} defaultChecked={rule?.channels.includes(channel)} />
        ))}
      </FieldGroup>
      <FieldGroup legend={t("routing.form.priorities")} hint={t("routing.form.anyHint")} layout="row">
        {TICKET_PRIORITIES.map((priority) => (
          <Checkbox key={priority} name="priorities" value={priority} label={t(`priority.${priority}`)} defaultChecked={rule?.priorities.includes(priority)} />
        ))}
      </FieldGroup>
      <TextArea name="keywords" label={t("routing.form.keywords")} hint={t("routing.form.keywordsHint")} defaultValue={rule?.keywords.join(t("listSep")) ?? ""} rows={2} optional error={fields.keywords} />
      <FieldGroup legend={t("routing.form.pool")} hint={t("routing.form.poolHint")} layout="row" error={fields.agents}>
        {page.agents.map((agent) => (
          <Checkbox key={agent.id} name="agents" value={agent.id} label={t("ticket.agentLoad", { name: agent.name, count: agent.open })} defaultChecked={rule?.pool.some((person) => person.id === agent.id)} />
        ))}
      </FieldGroup>
      <div className="grid gap-3 md:grid-cols-3">
        <TextField name="capacity" label={t("routing.form.capacity")} hint={t("routing.form.capacityHint")} inputMode="numeric" defaultValue={String(rule?.capacity ?? DEFAULT_CAPACITY)} ltr error={fields.capacity} />
        <Select name="setPriority" label={t("routing.form.setPriority")} defaultValue={rule?.setPriority ?? ""} options={[{ value: "", label: t("routing.form.keepPriority") }, ...TICKET_PRIORITIES.map((priority) => ({ value: priority, label: t(`priority.${priority}`) }))]} error={fields.setPriority} />
        <Checkbox name="isActive" label={t("routing.form.active")} defaultChecked={rule ? rule.isActive : true} />
      </div>
      <TextField name="reason" label={t("dialog.reason")} hint={t("routing.form.reasonHint")} required error={fields.reason} />
      <Failure message={save.message} />
      <div className="sup-actions">
        <Key type="submit" variant="ink" icon="floppy-disk" loading={save.pending}>
          {t("routing.form.save")}
        </Key>
        <Key
          size="sm"
          icon="magnifying-glass"
          loading={preview.pending}
          onClick={(event) => {
            const formEl = (event.currentTarget as HTMLElement).closest("form");
            if (!formEl) return;
            const values = new FormData(formEl);
            values.set("intent", "preview");
            preview.fetcher.submit(values, { method: "post" });
          }}
        >
          {t("routing.form.test")}
        </Key>
      </div>
      {tested ? (
        <div className="grid gap-1" role="status">
          <p className="type-caption text-ink-2">{t("routing.form.tested", { count: tested.count, checked: tested.checked })}</p>
          {tested.count > 0 && tested.matches.length === 0 ? <p className="type-caption text-ink-2">{t("routing.form.testedHidden")}</p> : null}
          {tested.matches.length ? (
            <ul className="grid gap-1">
              {tested.matches.map((match) => (
                <li key={match.ref} className="type-caption">
                  <Ref value={match.ref} /> · <span className="sup-card__title">{match.subject}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <Failure message={preview.message} />
    </save.fetcher.Form>
  );
}
