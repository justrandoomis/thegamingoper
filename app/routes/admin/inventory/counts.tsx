import { useState } from "react";
import { Form, Link, redirect, useActionData, useLocation, useNavigation } from "react-router";

import type { Route } from "./+types/counts";
import { COUNT_STATUS_FILTERS, createCount, listCounts, parseCountFilters } from "~/server/services/admin/inventory/counts.server";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { inventoryAccess, locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import { EmptyState } from "~/ui/EmptyState";
import { FieldGroup, Radio, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Code, LinkChips, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, useInvT, withSearch } from "./components/kit";
import { failed, int, lines, newKey, openInventory, optionalText, text } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/counts — periodic and selective stock counts (04.05): start one (every SKU at a location, chosen
 * SKUs, or a random sample), and the list by status. Counting, submitting and the supervisor's approval happen on
 * the count's own page.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor } = await openInventory(context, "inventory.stock.read");
  const filters = parseCountFilters(new URL(request.url).searchParams);
  const [page, tree] = await Promise.all([listCounts(db, actor, filters), locationTree(db)]);
  const locations = locationOptions(tree);
  const defaultLocation = locations.some((option) => option.value === DEFAULT_LOCATION_ID) ? DEFAULT_LOCATION_ID : (locations[0]?.value ?? "");
  return { page, filters, statuses: [...COUNT_STATUS_FILTERS], locations, defaultLocation, access: inventoryAccess(actor), key: newKey() };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.count.perform");
  const form = await request.formData();
  try {
    const mode = text(form, "mode");
    const result = await createCount(
      db,
      actor,
      {
        locationId: text(form, "locationId"),
        mode: mode === "skus" || mode === "sample" ? mode : "all",
        skus: lines(form, "skus"),
        sampleSize: int(form, "sampleSize"),
        notes: optionalText(form, "notes"),
        idempotencyKey: text(form, "key"),
      },
      now,
    );
    throw redirect(`/admin/inventory/counts/${result.countId}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    return failed(error, locale, "start");
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "counts.title");

export default function Counts({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const { search } = useLocation();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { page, filters, statuses, locations, defaultLocation, access } = loaderData;
  const [mode, setMode] = useState("all");
  const failure = result && !result.ok ? result : null;

  return (
    <>
      <PageHead title={t("counts.title")} lead={t("counts.lead")} />

      {access.countPerform ? (
        <Section id="start" title={t("counts.startTitle")}>
          <Form method="post" className="adm-card grid gap-4 lg:grid-cols-2">
            <input type="hidden" name="key" value={loaderData.key} />
            <Select name="locationId" label={t("counts.location")} options={locations.map((option) => ({ value: option.value, label: option.label }))} defaultValue={defaultLocation} required error={failure?.fields?.locationId} />
            <FieldGroup legend={t("counts.mode")} error={failure?.fields?.mode}>
              <Radio name="mode" value="all" label={t("counts.modeAll")} checked={mode === "all"} onChange={() => setMode("all")} />
              <Radio name="mode" value="skus" label={t("counts.modeSkus")} checked={mode === "skus"} onChange={() => setMode("skus")} />
              <Radio name="mode" value="sample" label={t("counts.modeSample")} checked={mode === "sample"} onChange={() => setMode("sample")} />
            </FieldGroup>
            {mode === "skus" ? <TextArea name="skus" label={t("counts.skus")} hint={t("counts.skusHint")} rows={4} dir="ltr" spellCheck={false} error={failure?.fields?.skus ?? (failure?.code === "count_unknown_skus" ? failure.message : undefined)} /> : null}
            {mode === "sample" ? <TextField name="sampleSize" label={t("counts.sampleSize")} inputMode="numeric" defaultValue="10" error={failure?.fields?.sampleSize} /> : null}
            <TextField name="notes" label={t("counts.notes")} optional maxLength={500} className="lg:col-span-2" />
            {failure?.message && !failure.fields ? (
              <p role="alert" className="type-label text-red-ink lg:col-span-2">
                {failure.message}
              </p>
            ) : null}
            <div className="lg:col-span-2">
              <Key type="submit" variant="ink" icon="clipboard-text" loading={navigation.state === "submitting"}>
                {t("counts.submit")}
              </Key>
            </div>
          </Form>
        </Section>
      ) : null}

      <Section id="counts-list" title={t("counts.caption")}>
        <LinkChips
          label={t("common.status")}
          items={statuses.map((status) => ({ value: status, label: t(`counts.filters.${status}`), href: withSearch(search, { status }), selected: filters.status === status }))}
        />
        <ResponsiveList
          caption={t("counts.caption")}
          rows={page.rows}
          rowKey={(row) => row.id}
          columns={[
            { key: "ref", header: t("common.reference"), cell: (row) => <RowLink to={`/admin/inventory/counts/${row.id}`}><Code>{row.ref}</Code></RowLink> },
            { key: "location", header: t("common.location"), cell: (row) => <span><Code>{row.locationCode}</Code> · {row.locationName}</span> },
            { key: "scope", header: t("counts.scope"), cell: (row) => (row.scope === "full" ? t("counts.scopeFull") : t("counts.scopePartial")) },
            { key: "status", header: t("common.status"), cell: (row) => <StateTag group="count" value={row.status} label={t(`countStatus.${row.status}`)} /> },
            {
              key: "progress",
              header: t("counts.progress"),
              numeric: true,
              cell: (row) => (
                <>
                  <Num value={row.counted} /> / <Num value={row.lines} />
                </>
              ),
            },
            // null while the count is blind for this employee
            { key: "diff", header: t("counts.differences"), numeric: true, cell: (row) => <Num value={row.differences} /> },
            { key: "started", header: t("counts.startedBy"), cell: (row) => <span>{row.startedBy ?? "—"} · <When at={row.createdAt} /></span> },
            { key: "approved", header: t("counts.approvedBy"), cell: (row) => (row.approvedBy ? <span>{row.approvedBy} · <When at={row.approvedAt} /></span> : "—") },
          ]}
          card={(row) => (
            <>
              <div className="flex items-start justify-between gap-2">
                <Link to={`/admin/inventory/counts/${row.id}`} className="adm-link type-strong">
                  <Code>{row.ref}</Code>
                </Link>
                <StateTag group="count" value={row.status} label={t(`countStatus.${row.status}`)} />
              </div>
              <p className="type-caption text-ink-2">
                <Code>{row.locationCode}</Code> · {row.locationName}
              </p>
              <Pair label={t("counts.progress")}>
                <Num value={row.counted} /> / <Num value={row.lines} />
              </Pair>
              <Pair label={t("counts.differences")}>
                <Num value={row.differences} />
              </Pair>
            </>
          )}
          empty={<EmptyState icon="clipboard-text" title={t("counts.empty")} />}
          footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => withSearch(search, { page: n })} />}
        />
      </Section>
    </>
  );
}
