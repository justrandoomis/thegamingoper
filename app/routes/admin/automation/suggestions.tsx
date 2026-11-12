import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/suggestions";
import { useFormat } from "~/i18n/react";
import { invalid } from "~/server/errors";
import { SUGGESTION_STATUS_TONE } from "~/server/services/admin/automation/catalog";
import { automationAccess } from "~/server/services/admin/automation/shared.server";
import { dismissSuggestion, listSuggestions, scanStockOuts } from "~/server/services/admin/automation/suggestions.server";
import { SUGGESTION_VIEWS, parseSuggestionFilters, suggestionSearch, type SuggestionRow } from "~/server/services/admin/automation/types";
import type { DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { automation, ok, text } from "./automation.server";
import { ActionDialog, Ago, Code, DemoTag, LinkChips, Note, PageHead, Pair, Person, ResponsiveList, Section, StatusText, useAutoT } from "./components/ui";
import { automationMeta } from "./meta";

/**
 * /admin/automation/suggestions — 19.02: stock-out alerts with a suggested purchase quantity, from module 04's numbers
 * (available, on the way, reorder point and quantity, sales rate, days of cover). "Check now" runs the scan the
 * scheduled run makes; a suggestion is dismissed with a reason, or one or more become a DRAFT purchase order of
 * module 09 (the order form) — nothing here orders, moves stock or money.
 */
export async function loader(args: Route.LoaderArgs) {
  const req = await automation.open(args, "automation.suggestion.read");
  const filters = parseSuggestionFilters(new URL(args.request.url).searchParams);
  const page = await automation.orRespond(() => listSuggestions(req.db, req.actor, filters, req.locale, req.now));
  return { page, filters, access: automationAccess(req.actor), now: req.now };
}

export async function action(args: Route.ActionArgs) {
  const req = await automation.open(args, "automation.suggestion.approve");
  let intent: string | null = null;
  try {
    const form = await automation.form(args.request);
    intent = text(form, "intent");
    if (intent === "scan") return ok(intent, await scanStockOuts(req.db, req.actor, req.now));
    if (intent === "dismiss") return ok(intent, await dismissSuggestion(req.db, req.actor, { suggestionId: text(form, "suggestionId"), reason: text(form, "reason") }, req.now));
    throw invalid({ intent: "invalid" });
  } catch (error) {
    return automation.failed(error, req, intent);
  }
}

export const meta: Route.MetaFunction = (args) => automationMeta(args, "suggestions.title");

export default function SuggestionsPage({ loaderData }: Route.ComponentProps) {
  const t = useAutoT();
  const f = useFormat();
  const { page, filters, access, now } = loaderData;
  const [selected, setSelected] = useState<string[]>([]);
  const [scanning, setScanning] = useState(false);
  const [dismissing, setDismissing] = useState<SuggestionRow | null>(null);
  const href = (next: Partial<typeof filters>) => `/admin/automation/suggestions${suggestionSearch({ ...filters, page: 1, ...next })}`;
  const orderHref = (ids: readonly string[]) => `/admin/automation/suggestions/order?${ids.map((id) => `ids=${encodeURIComponent(id)}`).join("&")}`;

  const sku = (row: SuggestionRow) => (
    <span className="grid">
      <bdi className="type-strong">{row.variant.name}</bdi>
      <span className="type-caption text-ink-2">
        <Code>{row.variant.sku}</Code> {row.demo ? <DemoTag /> : null}
      </span>
    </span>
  );
  const need = (row: SuggestionRow) =>
    row.basis ? (
      <span className="grid">
        <span>{t(`suggestions.need.${row.basis.status}`)}</span>
        <span className="type-caption text-ink-2">{row.basis.daysOfCover === null ? t("suggestions.noRate") : t("suggestions.cover", { count: row.basis.daysOfCover })}</span>
      </span>
    ) : (
      <span>—</span>
    );
  const basis = (row: SuggestionRow) =>
    row.basis ? (
      <span className="grid type-caption">
        <span>{t("suggestions.basisStock", { available: f.number(row.basis.available), incoming: f.number(row.basis.incoming) })}</span>
        <span className="text-ink-2">{row.basis.rate.perDay === null ? t(`suggestions.rate.${row.basis.rate.basis}`) : t("suggestions.rateLine", { rate: f.number(Math.round(row.basis.rate.perDay * 10) / 10), days: row.basis.rate.days })}</span>
        {row.basis.reorderPoint !== null ? <span className="text-ink-2">{t("suggestions.reorderPoint", { point: f.number(row.basis.reorderPoint) })}</span> : null}
      </span>
    ) : (
      <span>—</span>
    );
  const state = (row: SuggestionRow) => {
    const ordered = row.status === "approved" && row.order?.status && row.order.status !== "draft" && row.order.status !== "cancelled";
    return (
      <span className="grid">
        <StatusText tone={SUGGESTION_STATUS_TONE[ordered ? "ordered" : row.status]}>{t(`status.suggestion.${ordered ? "ordered" : row.status}`)}</StatusText>
        {row.order ? (
          <span className="type-caption text-ink-2">
            {row.order.href ? (
              <Link to={row.order.href} className="adm-link">
                <Code>{row.order.ref ?? "—"}</Code>
              </Link>
            ) : (
              <Code>{row.order.ref ?? "—"}</Code>
            )}
            {row.order.status ? ` · ${t(`poStatus.${row.order.status}`)}` : ""}
          </span>
        ) : null}
        {row.status === "dismissed" && row.dismissReason ? <bdi className="type-caption text-ink-2">{row.dismissReason}</bdi> : null}
        {row.decidedBy ? (
          <span className="type-caption text-ink-2">
            <Person who={row.decidedBy} />
          </span>
        ) : null}
      </span>
    );
  };
  const rowActions = (row: SuggestionRow) =>
    row.status === "open" && access.approve ? (
      <span className="flex flex-wrap gap-2">
        {access.draftOrders ? (
          <Key as={Link} to={orderHref([row.id])} size="sm">
            {t("suggestions.draftOne")}
          </Key>
        ) : null}
        <Key size="sm" variant="ghost" onClick={() => setDismissing(row)}>
          {t("suggestions.dismiss")}
        </Key>
      </span>
    ) : null;
  const columns: DataColumn<SuggestionRow>[] = [
    { key: "sku", header: t("suggestions.col.sku"), cell: sku },
    { key: "need", header: t("suggestions.col.need"), cell: need },
    { key: "qty", header: t("suggestions.col.qty"), numeric: true, cell: (row) => f.number(row.qty) },
    { key: "basis", header: t("suggestions.col.basis"), cell: basis },
    { key: "supplier", header: t("suggestions.col.supplier"), cell: (row) => <span>{row.supplier?.name ?? t("suggestions.noSupplier")}</span> },
    { key: "state", header: t("suggestions.col.state"), cell: state },
    ...(access.approve ? [{ key: "act", header: t("suggestions.col.act"), cell: rowActions } as DataColumn<SuggestionRow>] : []),
  ];
  const selectable = filters.view === "open" && access.draftOrders;

  return (
    <>
      <PageHead
        title={t("suggestions.title")}
        lead={t("suggestions.lead")}
        actions={
          access.approve ? (
            <Key onClick={() => setScanning(true)} icon="arrows-clockwise">
              {t("suggestions.scan")}
            </Key>
          ) : null
        }
      />
      <Note icon="info">
        <p>{t("suggestions.how")}</p>
        <p className="type-caption text-ink-2">{page.lastScanAt ? t("suggestions.lastScan", { at: f.relative(page.lastScanAt, now) }) : t("suggestions.neverScanned")}</p>
      </Note>
      {page.withoutQuantity ? (
        <Note tone="warn" icon="warning">
          <p>{t("suggestions.withoutQuantity", { count: page.withoutQuantity })}</p>
          <p>
            <Link to="/admin/inventory/reorder" className="adm-link">
              {t("suggestions.openReorder")}
            </Link>
          </p>
        </Note>
      ) : null}
      {access.approve && !access.draftOrders ? (
        <Note tone="warn" icon="lock">
          <p>{t("suggestions.needPurchasing")}</p>
        </Note>
      ) : null}

      <Section id="auto-suggestions" title={t(`suggestions.view.${filters.view}`)} aside={<span className="type-caption text-ink-2">{t("suggestions.count", { count: page.total })}</span>}>
        <LinkChips label={t("suggestions.views")} items={SUGGESTION_VIEWS.map((view) => ({ value: view, label: t(`suggestions.view.${view}`), href: href({ view }), selected: filters.view === view, count: page.counts[view] }))} />
        <Form method="get" className="auto-filters" preventScrollReset>
          {filters.view !== "open" ? <input type="hidden" name="view" value={filters.view} /> : null}
          <TextField name="q" label={t("suggestions.filter.q")} defaultValue={filters.q} maxLength={80} />
          <div>
            <Key type="submit" icon="funnel">
              {t("common.apply")}
            </Key>
            {filters.q ? (
              <Key as={Link} to={href({ q: "" })} variant="ghost">
                {t("common.clear")}
              </Key>
            ) : null}
          </div>
        </Form>
        <ResponsiveList
          caption={t("suggestions.title")}
          columns={columns}
          rows={page.rows}
          rowKey={(row) => row.id}
          rowLabel={(row) => row.variant.sku}
          selected={selectable ? selected : undefined}
          onSelectedChange={selectable ? setSelected : undefined}
          bulkActions={
            selectable
              ? (ids) => (
                  <Key as={Link} to={orderHref(ids)} size="sm" variant="primary">
                    {t("suggestions.draftMany", { count: ids.length })}
                  </Key>
                )
              : undefined
          }
          empty={<EmptyState title={filters.view === "open" ? t("suggestions.emptyOpen") : t("suggestions.empty")} text={filters.view === "open" ? t("suggestions.emptyOpenText") : t("suggestions.emptyText")} icon="package" />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/automation/suggestions${suggestionSearch({ ...filters, page: n })}`} />}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                {sku(row)}
                {state(row)}
              </div>
              <Pair label={t("suggestions.col.need")}>{need(row)}</Pair>
              <Pair label={t("suggestions.col.qty")}>
                <bdi className="nums">{f.number(row.qty)}</bdi>
              </Pair>
              <Pair label={t("suggestions.col.supplier")}>{row.supplier?.name ?? t("suggestions.noSupplier")}</Pair>
              {basis(row)}
              <span className="type-caption text-ink-2">
                <Ago at={row.createdAt} now={now} />
              </span>
              {rowActions(row)}
            </>
          )}
        />
      </Section>

      <ActionDialog
        open={scanning}
        onClose={() => setScanning(false)}
        title={t("suggestions.scanTitle")}
        consequence={t("suggestions.scanConsequence")}
        confirmLabel={t("confirm.scan")}
        impact={[
          { label: t("suggestions.scanCreates"), value: t("suggestions.scanCreatesValue") },
          { label: t("rules.runMoves"), value: t("rules.runMovesNothing") },
        ]}
        fields={{ intent: "scan" }}
        successMessage={(result) => t("suggestions.scanned", { created: Number(result.created ?? 0), reopened: Number(result.reopened ?? 0) })}
      />
      <ActionDialog
        open={dismissing !== null}
        onClose={() => setDismissing(null)}
        title={t("suggestions.dismissTitle", { sku: dismissing?.variant.sku ?? "" })}
        consequence={t("suggestions.dismissConsequence")}
        confirmLabel={t("confirm.dismiss")}
        tone="destructive"
        impact={dismissing ? [{ label: t("suggestions.col.qty"), value: f.number(dismissing.qty) }] : undefined}
        reason={{ label: t("common.reason"), hint: t("suggestions.dismissReasonHint") }}
        fields={{ intent: "dismiss", suggestionId: dismissing?.id ?? "" }}
        successMessage={t("suggestions.dismissed")}
      />
    </>
  );
}
