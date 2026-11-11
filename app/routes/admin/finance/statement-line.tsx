import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/statement-line";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { ignoreStatementLine, matchStatementLine, restoreStatementLine, reviewStatementLine, unmatchStatementLine, type MatchCandidate } from "~/server/services/admin/finance/settlements.server";
import { queryText } from "~/server/services/admin/finance/types";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { failed, financeT, ok, openFinance, orRespond, text } from "./finance.server";
import { financeMeta } from "./meta";
import { ActionDialog, Code, DemoTag, Ledger, Money, Note, PageHead, Pair, Section, StateTag, useFinT, When } from "./ui";

/**
 * /admin/finance/settlements/:lineId — one statement line (10.02): what it says, the paid payments it may prove (same
 * amount, same reference, close in time — best first, searchable by order reference), and the decisions: match (a
 * different amount needs a note), set aside with a note, undo a match, bring a set-aside line back. Every decision is
 * guarded (the line must still be in the state the page showed) and audited.
 */
export async function loader({ context, params, request }: Route.LoaderArgs) {
  const { db, actor } = await openFinance(context, "finance.settlement.reconcile");
  const q = queryText(new URL(request.url).searchParams);
  const review = await orRespond(() => reviewStatementLine(db, actor, params.lineId, q));
  return { review, q };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const req = await openFinance(context, "finance.settlement.reconcile");
  const form = await request.formData();
  const intent = text(form, "intent");
  const t = financeT(req.locale);
  try {
    if (intent === "match") {
      await matchStatementLine(req.db, req.actor, { lineId: params.lineId, paymentId: text(form, "paymentId"), note: text(form, "reason") || undefined }, req.now);
      return ok({ intent, message: t("line.matched") });
    }
    const raw = { lineId: params.lineId, reason: text(form, "reason") };
    if (intent === "ignore") await ignoreStatementLine(req.db, req.actor, raw, req.now);
    else if (intent === "unmatch") await unmatchStatementLine(req.db, req.actor, raw, req.now);
    else if (intent === "restore") await restoreStatementLine(req.db, req.actor, raw, req.now);
    // a form this page never sends: refused like any invalid input (400), not a server error
    else return failed(invalid({ intent: "invalid" }), req.locale, intent);
    return ok({ intent, message: t(`line.done.${intent}`) });
  } catch (error) {
    return failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => financeMeta(args, "line.title");

export default function StatementLinePage({ loaderData }: Route.ComponentProps) {
  const t = useFinT();
  const f = useFormat();
  const { review, q } = loaderData;
  const { line, candidates } = review;
  const [dialog, setDialog] = useState<{ kind: "match"; candidate: MatchCandidate } | { kind: "ignore" | "unmatch" | "restore" } | null>(null);

  return (
    <div className="mx-auto max-w-4xl">
      <PageHead
        eyebrow={
          <Link to="/admin/finance/settlements" className="adm-link">
            {t("line.back")}
          </Link>
        }
        title={
          <span className="flex flex-wrap items-center gap-2">
            {t("line.title")} <Money iqd={line.amountIqd} />
          </span>
        }
        lead={t(`source.${line.source}`)}
      />

      <div className="grid items-start gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Section id="line-facts" title={t("line.says")}>
          <Ledger
            className="adm-card content-start"
            rows={[
              { label: t("settlements.col.date"), value: <When at={line.occurredAt} /> },
              { label: t("settlements.col.amount"), value: <Money iqd={line.amountIqd} /> },
              { label: t("settlements.col.reference"), value: line.reference ? <Code>{line.reference}</Code> : "—" },
              { label: t("settlements.col.counterparty"), value: line.counterparty ?? "—" },
              { label: t("line.description"), value: line.description ?? "—" },
            ]}
          />
        </Section>
        <Section id="line-state" title={t("line.state")}>
          <div className="adm-card gap-2">
            <StateTag group="statement" value={line.status} label={t(`lineStatus.${line.status}`)} />
            {line.payment ? (
              <Ledger
                rows={[
                  { label: t("settlements.matchedTo"), value: <Link to={`/admin/orders/${line.payment.orderRef}`} className="adm-link"><Code>{line.payment.orderRef}</Code></Link> },
                  { label: t("line.paymentAmount"), value: <Money iqd={line.payment.amountIqd} /> },
                  { label: t("line.method"), value: t(`method.${line.payment.method}`) },
                ]}
              />
            ) : null}
            {line.differs ? <Status tone="warn">{t("settlements.differs")}</Status> : null}
            {line.by ? (
              <p className="type-caption text-ink-2">
                {t("line.decidedBy", { name: line.by })} · <When at={line.at} />
              </p>
            ) : null}
            {line.note ? <p className="type-body">{t("line.note", { note: line.note })}</p> : null}
            <div className="flex flex-wrap gap-2">
              {line.status === "unmatched" ? (
                <Key size="sm" onClick={() => setDialog({ kind: "ignore" })}>
                  {t("line.ignore")}
                </Key>
              ) : null}
              {line.status === "matched" ? (
                <Key size="sm" className="enabled:[--on:var(--red-ink)]" onClick={() => setDialog({ kind: "unmatch" })}>
                  {t("line.unmatch")}
                </Key>
              ) : null}
              {line.status === "ignored" ? (
                <Key size="sm" onClick={() => setDialog({ kind: "restore" })}>
                  {t("line.restore")}
                </Key>
              ) : null}
            </div>
          </div>
        </Section>
      </div>

      {line.status === "unmatched" ? (
        <Section id="line-candidates" title={t("line.candidates")}>
          {line.amountIqd < 0 ? (
            <Note>
              <p>{t("line.moneyOut")}</p>
            </Note>
          ) : (
            <>
              <Form method="get" className="flex flex-wrap items-end gap-2">
                <TextField name="q" type="search" label={t("line.searchOrder")} hint={t("line.searchHint")} defaultValue={q} ltr className="w-64" />
                <Key type="submit" size="sm" variant="ink" icon="magnifying-glass">
                  {t("line.search")}
                </Key>
              </Form>
              {candidates.length === 0 ? (
                <EmptyState title={t("line.noCandidates")} text={t("line.noCandidatesHint")} icon="magnifying-glass" />
              ) : (
                <ul className="grid gap-2">
                  {candidates.map((candidate) => (
                    <li key={candidate.id} className={candidate.matchable ? "adm-card adm-card--act gap-1.5" : "adm-card gap-1.5"}>
                      <span className="flex flex-wrap items-baseline justify-between gap-2">
                        <Link to={`/admin/orders/${candidate.orderRef}`} className="adm-link">
                          <Code>{candidate.orderRef}</Code>
                        </Link>
                        <Money iqd={candidate.amountIqd} className="type-strong" />
                      </span>
                      <span className="flex flex-wrap gap-1">
                        {candidate.reasons.map((reason) => (
                          <Status key={reason} tone="ok">
                            {t(`line.reason.${reason}`)}
                          </Status>
                        ))}
                        {candidate.amountIqd !== line.amountIqd ? <Status tone="warn">{t("line.amountDiffers", { diff: f.iqd(Math.abs(line.amountIqd - candidate.amountIqd)) })}</Status> : null}
                        <DemoTag show={candidate.isDemo} />
                      </span>
                      <Pair label={t("line.paymentStatus")}>{t(`paymentStatus.${candidate.status}`)}</Pair>
                      {candidate.paidAt ? (
                        <Pair label={t("settlements.paidAt")}>
                          <When at={candidate.paidAt} />
                        </Pair>
                      ) : null}
                      {candidate.reference ? (
                        <Pair label={t("settlements.col.reference")}>
                          <Code>{candidate.reference}</Code>
                        </Pair>
                      ) : null}
                      {candidate.matchable ? (
                        <div>
                          <Key size="sm" variant="ink" icon="check" onClick={() => setDialog({ kind: "match", candidate })}>
                            {t("line.match")}
                          </Key>
                        </div>
                      ) : (
                        <p className="type-caption text-ink-2">{t("line.notPaidYet")}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Section>
      ) : null}

      {dialog?.kind === "match" ? (
        <ActionDialog
          open
          onClose={() => setDialog(null)}
          title={t("line.matchQ", { ref: dialog.candidate.orderRef })}
          consequence={t("line.matchWhat")}
          confirmLabel={t("line.match")}
          impact={[
            { label: t("line.lineAmount"), value: f.iqd(line.amountIqd) },
            { label: t("line.paymentAmount"), value: f.iqd(dialog.candidate.amountIqd) },
          ]}
          reason={dialog.candidate.amountIqd !== line.amountIqd ? { label: t("line.differenceNote"), hint: t("line.differenceHint"), minLength: 3 } : undefined}
          fields={{ intent: "match", paymentId: dialog.candidate.id }}
        />
      ) : dialog ? (
        <ActionDialog
          open
          onClose={() => setDialog(null)}
          tone={dialog.kind === "unmatch" ? "destructive" : "neutral"}
          title={t(`line.${dialog.kind}Q`)}
          consequence={t(`line.${dialog.kind}What`)}
          confirmLabel={t(`line.${dialog.kind}`)}
          reason={{ label: t("common.reason"), hint: t(`line.${dialog.kind}Hint`), minLength: 3 }}
          fields={{ intent: dialog.kind }}
        />
      ) : null}
    </div>
  );
}
