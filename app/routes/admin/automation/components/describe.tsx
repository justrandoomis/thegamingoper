/**
 * A rule in words: its conditions and actions as the rule's page, the list, the dry run and the version history say
 * them. Pure rendering over the module's strings; nothing here is evaluated (the evaluator is catalog.ts's).
 */
import type { TFunction } from "~/i18n/translate";
import { useFormat } from "~/i18n/react";
import type { EventType, OrderMatch, PriceMatch, RuleAction, RuleMatch, StockMatch, TicketMatch } from "~/server/services/admin/automation/catalog";

export type RuleNames = { assignee?: string | null; governorate?: string | null; location?: string | null };

type Formatter = ReturnType<typeof useFormat>;

const listOf = (t: TFunction, items: readonly string[]) => items.join(t("common.listSep"));

/** One sentence per condition that narrows the event; "every event" when none does. */
export function conditionLines(t: TFunction, f: Formatter, event: EventType, match: RuleMatch, names: RuleNames = {}): string[] {
  const lines: string[] = [];
  switch (event) {
    case "order.placed": {
      const m = match as OrderMatch;
      if (m.channel !== "any") lines.push(t("cond.line.channel", { value: t(`choice.channel.${m.channel}`) }));
      if (m.paymentMethods.length) lines.push(t("cond.line.paymentMethods", { value: listOf(t, m.paymentMethods.map((method) => t(`choice.payment.${method}`))) }));
      if (m.minTotalIqd !== null) lines.push(t("cond.line.minTotal", { value: f.iqd(m.minTotalIqd) }));
      if (m.governorateId) lines.push(t("cond.line.governorate", { value: names.governorate ?? m.governorateId }));
      break;
    }
    case "stock.below_reorder": {
      const m = match as StockMatch;
      if (m.locationId) lines.push(t("cond.line.location", { value: names.location ?? m.locationId }));
      if (m.productKinds.length) lines.push(t("cond.line.productKinds", { value: listOf(t, m.productKinds.map((kind) => t(`choice.kind.${kind}`))) }));
      if (m.onlyNothingIncoming) lines.push(t("cond.line.incoming"));
      break;
    }
    case "ticket.waiting": {
      const m = match as TicketMatch;
      lines.push(t("cond.line.hours", { count: m.hours }));
      if (m.priorities.length) lines.push(t("cond.line.priorities", { value: listOf(t, m.priorities.map((priority) => t(`choice.priority.${priority}`))) }));
      if (m.categories.length) lines.push(t("cond.line.categories", { value: listOf(t, m.categories.map((category) => t(`choice.category.${category}`))) }));
      if (m.unassignedOnly) lines.push(t("cond.line.unassigned"));
      break;
    }
    case "price.changed": {
      const m = match as PriceMatch;
      if (m.direction !== "any") lines.push(t(`cond.line.direction.${m.direction}`));
      if (m.minChangeBps !== null) lines.push(t("cond.line.minChange", { value: f.number(m.minChangeBps / 100) }));
      break;
    }
  }
  if ((match as { includeDemo?: boolean }).includeDemo) lines.push(t("cond.line.includeDemo"));
  if (!lines.length || (lines.length === 1 && (match as { includeDemo?: boolean }).includeDemo)) lines.unshift(t("cond.line.every"));
  return lines;
}

/** What one action does, in one sentence. */
export function actionLine(t: TFunction, action: RuleAction, names: RuleNames = {}): string {
  switch (action.type) {
    case "staff_task": {
      const due = action.params.dueHours ? t("actionLine.due", { count: action.params.dueHours }) : t("actionLine.noDue");
      return t("actionLine.staff_task", { who: names.assignee ?? "—", priority: t(`choice.taskPriority.${action.params.priority}`), due });
    }
    case "notify":
      return t("actionLine.notify", { who: t(`audience.${action.params.audience}`) });
    case "flag_order":
      return t("actionLine.flag_order");
    case "suggest_purchase":
      return t("actionLine.suggest_purchase");
  }
}
