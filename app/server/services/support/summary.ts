/**
 * The assistant conversation as plain text — client-safe and pure. The same function builds the preview the shopper
 * reads before handing the conversation to staff (with useT("support")) and the internal note staff receive (with
 * serverT("ar", "support") on a server replay, so it is built from approved content, never from posted text).
 */
import type { TFunction } from "~/i18n/translate";
import type { AssistantBotTurn, AssistantView } from "./types";

/** "Device: … / Problem: … / What we tried: … / Result: …" — one line each, the steps as "- … → …". */
export function summarizeConversation(view: AssistantView, t: TFunction): string {
  const lines: string[] = [];
  const device = view.device?.name ?? (view.deviceOther ? t("assistant.deviceOther") : view.platform?.name ?? null);
  if (device) lines.push(t("summary.device", { device }));

  // Only words the shopper typed are quoted as theirs — a reply they picked is not.
  const said = view.turns.find((turn) => turn.role === "user" && turn.typed && turn.text !== "");
  if (said && said.role === "user") lines.push(t("summary.said", { text: said.text }));
  if (view.symptom) lines.push(t("summary.problem", { problem: view.symptom.title }));

  const code = view.turns.find((turn): turn is AssistantBotTurn => turn.role === "assistant" && (turn.kind === "code" || turn.kind === "code_found"));
  if (code) lines.push(t("summary.code", { code: code.params.code ?? "" }));
  if (view.turns.some((turn) => turn.role === "assistant" && turn.kind === "danger")) lines.push(t("summary.danger"));

  const steps: string[] = [];
  view.turns.forEach((turn, index) => {
    if (turn.role !== "assistant" || (turn.kind !== "question" && turn.kind !== "step")) return;
    const answer = view.turns[index + 1];
    if (answer?.role === "user") steps.push(`- ${turn.text} → ${answer.text}`);
  });
  if (steps.length > 0) lines.push(t("summary.steps"), ...steps);

  if (view.outcome) {
    const last = [...view.turns].reverse().find((turn): turn is AssistantBotTurn => turn.role === "assistant" && turn.kind === "outcome");
    lines.push(t(`summary.outcome.${view.outcome.type}`));
    if (last?.text) lines.push(last.text);
    if (view.outcome.article) lines.push(t("summary.guide", { title: view.outcome.article.title }));
  } else if (view.stage !== "done") {
    lines.push(t("summary.unfinished"));
  }
  return lines.join("\n");
}
