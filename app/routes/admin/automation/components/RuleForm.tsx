/**
 * The rule builder (19.01): one event from the fixed catalogue (links: the choice lives in the URL, so the builder
 * works without JavaScript), the conditions that event offers, the actions it allows, a name — no code, no free
 * expressions. Editing a rule that is switched on asks for a confirmation that names what happens: it stops until the
 * new version passes a dry run and someone else switches it on. Field errors come back from the server all at once.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Form, Link, useNavigation } from "react-router";

import {
  EVENT_ACTIONS,
  EVENT_TYPES,
  LIMITS,
  NOTICE_AUDIENCES,
  ORDER_CHANNEL_CHOICES,
  PAYMENT_METHODS,
  PRICE_DIRECTIONS,
  PRODUCT_KINDS,
  STAFF_TASK_PRIORITIES,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  defaultMatch,
  type ActionType,
  type EventType,
  type OrderMatch,
  type PriceMatch,
  type RuleAction,
  type RuleMatch,
  type StockMatch,
  type TicketMatch,
} from "~/server/services/admin/automation/catalog";
import type { RuleFormOptions } from "~/server/services/admin/automation/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Checkbox, FieldGroup, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { FormError, Note, useAutoT } from "./ui";

export type RuleFormValues = { name: string; description: string | null; event: EventType; match: RuleMatch; actions: RuleAction[] };

type Props = {
  mode: "new" | "edit";
  event: EventType | null;
  /** The event links: "/admin/automation/rules/new" or ".../:id/edit". */
  eventHref: (event: EventType) => string;
  values: RuleFormValues | null;
  options: RuleFormOptions;
  fields?: Record<string, string>;
  message?: string | null;
  idempotencyKey?: string;
  expectedUpdatedAt?: number;
  /** Editing a rule that is switched on. */
  stopsActive?: boolean;
  cancelHref: string;
};

const paramsOf = (actions: readonly RuleAction[], type: ActionType) => actions.find((action) => action.type === type);

export function RuleForm({ mode, event, eventHref, values, options, fields = {}, message, idempotencyKey, expectedUpdatedAt, stopsActive, cancelHref }: Props) {
  const t = useAutoT();
  const navigation = useNavigation();
  const formRef = useRef<HTMLFormElement | null>(null);
  const confirmed = useRef(false);
  const [confirming, setConfirming] = useState(false);
  const pending = navigation.state === "submitting";
  // a refused form: the first field the server named, in page order, takes the focus (its message is read with it);
  // "choose at least one action" belongs to the actions group, so its first checkbox stands for it
  useEffect(() => {
    const form = formRef.current;
    if (!form || !Object.keys(fields).length) return;
    const candidates = [...form.querySelectorAll<HTMLElement>('[aria-invalid="true"]')];
    const firstAction = fields.actions ? form.querySelector<HTMLElement>('input[name^="act_"]') : null;
    if (firstAction) candidates.push(firstAction);
    candidates.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    candidates[0]?.focus();
  }, [fields]);

  const chosen: EventType | null = event;
  const match = chosen ? (values && values.event === chosen ? values.match : defaultMatch(chosen)) : null;
  const actions = values && values.event === chosen ? values.actions : [];
  const allowed = chosen ? EVENT_ACTIONS[chosen] : [];
  const task = paramsOf(actions, "staff_task");
  const notify = paramsOf(actions, "notify");
  const error = (name: string) => fields[name];

  const onSubmit = (submit: FormEvent<HTMLFormElement>) => {
    if (stopsActive && !confirmed.current) {
      submit.preventDefault();
      setConfirming(true);
    }
  };

  return (
    <div className="grid gap-5">
      <section aria-labelledby="auto-event-head" className="grid gap-3">
        <h2 id="auto-event-head" className="adm-h2">
          {t("builder.step.event")}
        </h2>
        <p className="type-body text-ink-2">{t("builder.eventHint")}</p>
        <ul role="list" className="auto-events">
          {EVENT_TYPES.map((type) => (
            <li key={type} className="grid">
              <Link to={eventHref(type)} className="auto-event" aria-current={chosen === type ? "true" : undefined} preventScrollReset>
                <span className="type-strong">{t(`event.${type}.title`)}</span>
                <span className="type-caption text-ink-2">{t(`event.${type}.text`)}</span>
              </Link>
            </li>
          ))}
        </ul>
        {error("event") ? <FormError message={error("event")} /> : null}
      </section>

      {chosen && match ? (
        <Form method="post" ref={formRef} onSubmit={onSubmit} className="auto-form" noValidate>
          <input type="hidden" name="intent" value="save" />
          <input type="hidden" name="event" value={chosen} />
          {idempotencyKey ? <input type="hidden" name="idempotencyKey" value={idempotencyKey} /> : null}
          {expectedUpdatedAt ? <input type="hidden" name="expectedUpdatedAt" value={String(expectedUpdatedAt)} /> : null}

          <fieldset className="auto-fieldset">
            <legend className="adm-h3">{t("builder.step.conditions")}</legend>
            <p className="type-caption text-ink-2">{t(`event.${chosen}.when`)}</p>
            <Conditions event={chosen} match={match} options={options} error={error} />
            <Checkbox name="includeDemo" defaultChecked={(match as { includeDemo?: boolean }).includeDemo} label={t("cond.includeDemo")} hint={t("cond.includeDemoHint")} />
          </fieldset>

          <fieldset className="auto-fieldset">
            <legend className="adm-h3">{t("builder.step.actions")}</legend>
            <p className="type-caption text-ink-2">{t("builder.actionsHint")}</p>
            {error("actions") ? <FormError message={error("actions")} /> : null}
            {allowed.includes("staff_task") ? (
              <div className="auto-action">
                <Checkbox name="act_staff_task" defaultChecked={Boolean(task)} label={t("action.staff_task.title")} hint={t("action.staff_task.text")} />
                <div className="auto-action__fields">
                  <Select
                    name="taskAssignee"
                    label={t("builder.task.assignee")}
                    defaultValue={task?.type === "staff_task" ? task.params.assigneeId : ""}
                    placeholder={t("builder.task.choose")}
                    options={options.employees}
                    error={error("taskAssignee")}
                  />
                  <Select
                    name="taskPriority"
                    label={t("builder.task.priority")}
                    defaultValue={task?.type === "staff_task" ? task.params.priority : "normal"}
                    options={STAFF_TASK_PRIORITIES.map((value) => ({ value, label: t(`choice.taskPriority.${value}`) }))}
                    error={error("taskPriority")}
                  />
                  <TextField
                    name="taskDueHours"
                    label={t("builder.task.dueHours")}
                    hint={t("builder.task.dueHoursHint", { max: LIMITS.dueHoursMax })}
                    inputMode="numeric"
                    defaultValue={task?.type === "staff_task" && task.params.dueHours ? String(task.params.dueHours) : ""}
                    error={error("taskDueHours")}
                    optional
                  />
                  <TextArea dir="auto" name="taskNote" label={t("builder.task.note")} hint={t("builder.task.noteHint", { max: LIMITS.note })} maxLength={LIMITS.note} rows={2} defaultValue={task?.type === "staff_task" ? (task.params.note ?? "") : ""} error={error("taskNote")} optional />
                </div>
              </div>
            ) : null}
            {allowed.includes("notify") ? (
              <div className="auto-action">
                <Checkbox name="act_notify" defaultChecked={Boolean(notify)} label={t("action.notify.title")} hint={t("action.notify.text")} />
                <div className="auto-action__fields">
                  <Select
                    name="notifyAudience"
                    label={t("builder.notify.audience")}
                    defaultValue={notify?.type === "notify" ? notify.params.audience : NOTICE_AUDIENCES[0]}
                    options={NOTICE_AUDIENCES.map((value) => ({ value, label: t(`audience.${value}`) }))}
                    error={error("notifyAudience")}
                  />
                </div>
              </div>
            ) : null}
            {allowed.includes("flag_order") ? (
              <div className="auto-action">
                <Checkbox name="act_flag_order" defaultChecked={Boolean(paramsOf(actions, "flag_order"))} label={t("action.flag_order.title")} hint={t("action.flag_order.text")} />
              </div>
            ) : null}
            {allowed.includes("suggest_purchase") ? (
              <div className="auto-action">
                <Checkbox name="act_suggest_purchase" defaultChecked={Boolean(paramsOf(actions, "suggest_purchase"))} label={t("action.suggest_purchase.title")} hint={t("action.suggest_purchase.text")} />
              </div>
            ) : null}
            <Note icon="shield-check" tone="ok">
              <p>{t("builder.safeguard")}</p>
            </Note>
          </fieldset>

          <fieldset className="auto-fieldset">
            <legend className="adm-h3">{t("builder.step.name")}</legend>
            <TextField dir="auto" name="name" label={t("builder.name")} maxLength={LIMITS.name} defaultValue={values?.name ?? ""} error={error("name")} required />
            <TextArea dir="auto" name="description" label={t("builder.description")} maxLength={LIMITS.description} rows={2} defaultValue={values?.description ?? ""} error={error("description")} optional />
            {mode === "edit" ? <TextArea dir="auto" name="reason" label={t("builder.reason")} hint={t("builder.reasonHint")} maxLength={LIMITS.reason} rows={2} error={error("reason")} required /> : null}
          </fieldset>

          {stopsActive ? (
            <Note tone="warn" icon="warning">
              <p>{t("builder.stopsActive")}</p>
            </Note>
          ) : null}
          <Note icon="info">
            <p>{t("builder.afterSave")}</p>
          </Note>
          <FormError message={message ?? (error("_") ? error("_") : null)} />
          <div className="auto-actions">
            <Key type="submit" variant="primary" loading={pending}>
              {mode === "new" ? t("builder.saveNew") : t("builder.saveVersion")}
            </Key>
            <Key as={Link} to={cancelHref} variant="ghost">
              {t("common.back")}
            </Key>
          </div>
        </Form>
      ) : (
        <p className="type-body text-ink-2">{t("builder.pickFirst")}</p>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={t("builder.confirmTitle")}
        consequence={t("builder.confirmConsequence")}
        confirmLabel={t("confirm.save")}
        cancelLabel={t("common.back")}
        impact={[
          { label: t("builder.confirmNow"), value: t("status.rule.draft") },
          { label: t("builder.confirmMoves"), value: t("rules.runMovesNothing") },
        ]}
        onConfirm={() => {
          confirmed.current = true;
          setConfirming(false);
          formRef.current?.requestSubmit();
        }}
      />
    </div>
  );
}

function Conditions({ event, match, options, error }: { event: EventType; match: RuleMatch; options: RuleFormOptions; error: (name: string) => string | undefined }) {
  const t = useAutoT();
  switch (event) {
    case "order.placed": {
      const m = match as OrderMatch;
      return (
        <div className="grid gap-4">
          <div className="auto-grid">
            <Select name="channel" label={t("cond.channel")} defaultValue={m.channel} options={ORDER_CHANNEL_CHOICES.map((value) => ({ value, label: t(`choice.channel.${value}`) }))} error={error("channel")} />
            <TextField name="minTotal" label={t("cond.minTotal")} hint={t("cond.minTotalHint")} inputMode="numeric" defaultValue={m.minTotalIqd === null ? "" : String(m.minTotalIqd)} error={error("minTotal")} optional />
            <Select name="governorateId" label={t("cond.governorate")} defaultValue={m.governorateId ?? ""} options={[{ value: "", label: t("cond.anyGovernorate") }, ...options.governorates]} error={error("governorateId")} />
          </div>
          <FieldGroup legend={t("cond.paymentMethods")} hint={t("cond.noneMeansAll")} error={error("paymentMethods")} optional>
            <div className="auto-options">
              {PAYMENT_METHODS.map((method) => (
                <Checkbox key={method} name="paymentMethods" value={method} defaultChecked={m.paymentMethods.includes(method)} label={t(`choice.payment.${method}`)} />
              ))}
            </div>
          </FieldGroup>
        </div>
      );
    }
    case "stock.below_reorder": {
      const m = match as StockMatch;
      return (
        <div className="grid gap-4">
          <div className="auto-grid">
            <Select name="locationId" label={t("cond.location")} defaultValue={m.locationId ?? ""} options={[{ value: "", label: t("cond.anyLocation") }, ...options.locations]} error={error("locationId")} />
          </div>
          <FieldGroup legend={t("cond.productKinds")} hint={t("cond.noneMeansAll")} error={error("productKinds")} optional>
            <div className="auto-options">
              {PRODUCT_KINDS.filter((kind) => kind !== "bundle").map((kind) => (
                <Checkbox key={kind} name="productKinds" value={kind} defaultChecked={m.productKinds.includes(kind)} label={t(`choice.kind.${kind}`)} />
              ))}
            </div>
          </FieldGroup>
          <Checkbox name="onlyNothingIncoming" defaultChecked={m.onlyNothingIncoming} label={t("cond.onlyNothingIncoming")} hint={t("cond.onlyNothingIncomingHint")} />
        </div>
      );
    }
    case "ticket.waiting": {
      const m = match as TicketMatch;
      return (
        <div className="grid gap-4">
          <div className="auto-grid">
            <TextField name="hours" label={t("cond.hours")} hint={t("cond.hoursHint", { min: LIMITS.hoursMin, max: LIMITS.hoursMax })} inputMode="numeric" defaultValue={String(m.hours)} error={error("hours")} required />
          </div>
          <FieldGroup legend={t("cond.priorities")} hint={t("cond.noneMeansAll")} error={error("priorities")} optional>
            <div className="auto-options">
              {TICKET_PRIORITIES.map((priority) => (
                <Checkbox key={priority} name="priorities" value={priority} defaultChecked={m.priorities.includes(priority)} label={t(`choice.priority.${priority}`)} />
              ))}
            </div>
          </FieldGroup>
          <FieldGroup legend={t("cond.categories")} hint={t("cond.noneMeansAll")} error={error("categories")} optional>
            <div className="auto-options">
              {TICKET_CATEGORIES.map((category) => (
                <Checkbox key={category} name="categories" value={category} defaultChecked={m.categories.includes(category)} label={t(`choice.category.${category}`)} />
              ))}
            </div>
          </FieldGroup>
          <Checkbox name="unassignedOnly" defaultChecked={m.unassignedOnly} label={t("cond.unassignedOnly")} />
        </div>
      );
    }
    case "price.changed": {
      const m = match as PriceMatch;
      return (
        <div className="auto-grid">
          <Select name="direction" label={t("cond.direction")} defaultValue={m.direction} options={PRICE_DIRECTIONS.map((value) => ({ value, label: t(`choice.direction.${value}`) }))} error={error("direction")} />
          <TextField
            name="minChangePercent"
            label={t("cond.minChange")}
            hint={t("cond.minChangeHint", { min: LIMITS.changePercentMin, max: LIMITS.changePercentMax })}
            inputMode="numeric"
            defaultValue={m.minChangeBps === null ? "" : String(Math.round(m.minChangeBps / 100))}
            error={error("minChangePercent")}
            optional
          />
        </div>
      );
    }
  }
}
