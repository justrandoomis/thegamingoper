import { Fragment } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/tickets";
import { KEYWORD_RULES } from "~/server/services/admin/automation/catalog";
import { ticketSuggestions, type TicketSuggestion } from "~/server/services/admin/automation/tickets.server";
import { parseTicketFilters, ticketSearch } from "~/server/services/admin/automation/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Pagination } from "~/ui/Pagination";
import { automation } from "./automation.server";
import { Ago, Code, DemoTag, LinkChips, Note, PageHead, Pair, ResponsiveList, Section, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/tickets — 19.03 as far as it can be honest: open tickets whose words point at another topic by
 * the KEYWORD RULES listed on the page (rules, not AI), the word that matched, and module 14's canned replies of that
 * topic. Nothing is changed here; the ticket's own page (14.02) changes the topic and sends a reply. Summaries need a
 * language model, which is not configured (boundary). The view and its page are in the URL; the counts are every open
 * ticket and the ones the rules read (the latest SCAN_LIMIT), said on the page when they differ.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.workflow.read");
  const filters = parseTicketFilters(new URL(args.request.url).searchParams);
  const result = await automation.orRespond(() => ticketSuggestions(req.db, req.actor, filters, req.now));
  return { result, view: filters.view, now: req.now };
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "tickets.title");

export default function TicketsPage({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const { result, view, now } = loaderData;
  const ticket = (row: TicketSuggestion) => (
    <span className="grid">
      {row.href ? (
        <Link to={row.href} className="adm-link">
          <Code>{row.ref}</Code>
        </Link>
      ) : (
        <Code>{row.ref}</Code>
      )}
      <span className="type-caption text-ink-2">
        <bdi>{row.subject}</bdi> {row.demo ? <DemoTag /> : null}
      </span>
    </span>
  );
  const suggested = (row: TicketSuggestion) =>
    row.suggested ? (
      <span className="grid">
        <span>{t(`choice.category.${row.suggested.category}`)}</span>
        <span className="type-caption text-ink-2">{t("tickets.matched", { word: row.suggested.keyword })}</span>
      </span>
    ) : (
      <span className="text-ink-2">{t("tickets.noMatch")}</span>
    );
  const replies = (row: TicketSuggestion) =>
    row.replies.length ? (
      <ul role="list" className="grid gap-0.5 type-caption">
        {row.replies.map((reply) => (
          <li key={reply.id}>{reply.title}</li>
        ))}
      </ul>
    ) : (
      <span className="type-caption text-ink-2">{t("tickets.noReplies")}</span>
    );
  const columns: DataColumn<TicketSuggestion>[] = [
    { key: "ticket", header: t("tickets.col.ticket"), cell: ticket },
    { key: "current", header: t("tickets.col.current"), cell: (row) => <span>{t(`choice.category.${row.category}`)}</span> },
    { key: "suggested", header: t("tickets.col.suggested"), cell: suggested },
    { key: "replies", header: t("tickets.col.replies"), cell: replies },
    { key: "last", header: t("tickets.col.last"), cell: (row) => <Ago at={row.lastMessageAt} now={now} /> },
  ];
  return (
    <>
      <PageHead title={t("tickets.title")} lead={t("tickets.lead")} />
      <Note tone="warn" icon="robot">
        <p>{t("tickets.boundary")}</p>
      </Note>
      <Section id="auto-tickets" title={t(`tickets.view.${view}`)} aside={<span className="type-caption text-ink-2">{t("tickets.counts", { open: result.open, differs: result.differs })}</span>}>
        <LinkChips
          label={t("tickets.views")}
          items={[
            { value: "differs", label: t("tickets.view.differs"), href: `/admin/automation/tickets${ticketSearch({ view: "differs" })}`, selected: view === "differs", count: result.differs },
            { value: "all", label: t("tickets.view.all"), href: `/admin/automation/tickets${ticketSearch({ view: "all" })}`, selected: view === "all", count: result.checked },
          ]}
        />
        {result.checked < result.open ? (
          <Note tone="warn" icon="info">
            <p>{t("tickets.capped", { checked: result.checked, open: result.open })}</p>
          </Note>
        ) : null}
        <ResponsiveList
          caption={t("tickets.title")}
          columns={columns}
          rows={result.rows}
          rowKey={(row) => row.id}
          footer={<Pagination page={result.page} pageCount={result.pageCount} href={(n) => `/admin/automation/tickets${ticketSearch({ view, page: n })}`} />}
          empty={<EmptyState title={view === "differs" ? t("tickets.emptyDiffers") : t("tickets.empty")} text={view === "differs" ? t("tickets.emptyDiffersText") : t("tickets.emptyText")} icon="chat-circle" />}
          card={(row) => (
            <>
              {ticket(row)}
              <Pair label={t("tickets.col.current")}>{t(`choice.category.${row.category}`)}</Pair>
              <Pair label={t("tickets.col.suggested")}>{suggested(row)}</Pair>
              {replies(row)}
            </>
          )}
        />
      </Section>
      <Section id="auto-keyword-rules" title={t("tickets.rules")}>
        <p className="type-body text-ink-2">{t("tickets.rulesLead")}</p>
        <ol className="auto-lines type-caption">
          {KEYWORD_RULES.map((rule) => (
            <li key={rule.category}>
              <span className="type-label">{t(`choice.category.${rule.category}`)}</span>:{" "}
              {/* each word isolated, so Arabic and English words keep the page order */}
              {rule.words.map((word, index) => (
                <Fragment key={word}>
                  {index ? t("common.listSep") : null}
                  <bdi>{word}</bdi>
                </Fragment>
              ))}
            </li>
          ))}
        </ol>
      </Section>
    </>
  );
}
