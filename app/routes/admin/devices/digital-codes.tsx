import { useState } from "react";
import { data, Link } from "react-router";

import type { Route } from "./+types/digital-codes";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { listCodes } from "~/server/services/admin/devices/codes.server";
import { CODE_STATUS_LIST, MAX_CODES_PER_IMPORT, parseWhole, type CodeRow } from "~/server/services/admin/devices/types";
import type { DigitalCodeStatus } from "~/server/db/schema";
import { ConfirmDialog } from "~/ui/Dialog";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { codesAction } from "./digital-codes.server";
import { devicesDataKey, devicesStoreMode } from "./env.server";
import { openDevices } from "./devices.server";
import { devicesMeta } from "./meta";
import { CodeBadge, Failure, Money, Name, Ref, Section, useDevicesT, useIntent, When } from "./ui";

/**
 * /admin/devices/digital/:variantId — the codes of one digital variant (13.07): how many in each status, the list
 * (never the code itself), import (one per line, stored encrypted, duplicates skipped), reveal (devices.digital_code
 * .manage + digital_code.reveal, a reason, audited, never for an unpaid order) and revoke. Unit cost [P] only for
 * cost.read.
 */
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openDevices(context, "devices.digital_code.manage");
  const search = new URL(request.url).searchParams;
  const status = (CODE_STATUS_LIST as readonly string[]).includes(search.get("status") ?? "") ? (search.get("status") as DigitalCodeStatus) : null;
  const page = parseWhole(search.get("page"));
  try {
    return { codes: await listCodes(db, actor, params.variantId, { status, page: typeof page === "number" && Number.isInteger(page) && page > 0 ? page : 1 }, locale) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openDevices(context, "devices.digital_code.manage");
  const result = await codesAction(req.ctx, req.db, req.session, params.variantId, await request.formData(), devicesDataKey(), { demo: devicesStoreMode() === "demo" });
  return result.ok ? result : data(result, { status: result.status });
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, "codes.title", undefined, args.loaderData?.codes.variant.sku);

export default function CodesPage({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const f = useFormat();
  const { codes } = loaderData;
  const [reveal, setReveal] = useState<CodeRow | null>(null);
  const [revoke, setRevoke] = useState<CodeRow | null>(null);
  const importing = useIntent("import", "done.imported");
  const revealing = useIntent("reveal", "done.revealed");
  const revoking = useIntent("revoke", "done.revoked", () => setRevoke(null));
  const shown = revealing.fetcher.data && revealing.fetcher.data.ok && revealing.fetcher.data.intent === "reveal" && reveal && revealing.fetcher.data.codeId === reveal.id ? String(revealing.fetcher.data.code ?? "") : null;
  const result = importing.fetcher.data && importing.fetcher.data.ok && importing.fetcher.data.intent === "import" ? importing.fetcher.data : null;
  const columns: DataColumn<CodeRow>[] = [
    { key: "id", header: t("codes.col.id"), cell: (row) => <Ref value={row.id.slice(-8)} /> },
    { key: "status", header: t("codes.col.status"), cell: (row) => <CodeBadge status={row.status} /> },
    { key: "created", header: t("codes.col.created"), cell: (row) => <span className="grid"><When at={row.createdAt} /><span className="type-caption text-ink-2">{row.createdBy ?? "—"}</span></span> },
    { key: "expires", header: t("codes.col.expires"), cell: (row) => <When at={row.expiresAt} style="date" /> },
    { key: "order", header: t("codes.col.order"), cell: (row) => (row.orderRef ? <span className="grid"><Ref value={row.orderRef} /><span className="type-caption text-ink-2">{row.orderPaid ? t("codes.paid") : t("codes.unpaid")}</span></span> : "—") },
    ...(codes.withCost ? [{ key: "cost", header: t("codes.col.cost"), numeric: true, cell: (row: CodeRow) => <Money iqd={row.costIqd ?? null} /> } satisfies DataColumn<CodeRow>] : []),
    {
      key: "actions",
      header: t("codes.col.actions"),
      cell: (row) => (
        <span className="inline-flex flex-wrap gap-1">
          {codes.canReveal && row.revealable ? (
            <Key size="sm" icon="eye" onClick={() => setReveal(row)}>
              {t("codes.reveal")}
            </Key>
          ) : null}
          {row.status === "available" ? (
            <Key size="sm" icon="x-circle" onClick={() => setRevoke(row)}>
              <span className="text-red-ink">{t("codes.revoke")}</span>
            </Key>
          ) : null}
        </span>
      ),
    },
  ];
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/devices/digital" className="adm-link">
            {t("codes.back")}
          </Link>
        </p>
        <h1 className="adm-title">
          <Name text={codes.variant.name} />
        </h1>
        <p className="type-caption text-ink-2">
          <Ref value={codes.variant.sku} /> · {codes.variant.licenseType ? t(`license.${codes.variant.licenseType}`) : t("codes.noLicense")}
        </p>
        <p className="max-w-[70ch] type-body text-ink-2">{t("codes.lead")}</p>
      </header>

      <Section id="codes-counts" title={t("codes.counts")}>
        <nav aria-label={t("codes.filter")} className="flex flex-wrap gap-2">
          <Key as={Link} to={`/admin/devices/digital/${codes.variant.id}`} size="sm" held={!codes.status} aria-current={!codes.status ? "true" : undefined}>
            {t("list.any")} · <bdi className="nums">{f.number(Object.values(codes.counts).reduce((sum, n) => sum + (n ?? 0), 0))}</bdi>
          </Key>
          {CODE_STATUS_LIST.map((status) => (
            <Key key={status} as={Link} to={`/admin/devices/digital/${codes.variant.id}?status=${status}`} size="sm" held={codes.status === status} aria-current={codes.status === status ? "true" : undefined}>
              {t(`codeStatus.${status}`)} · <bdi className="nums">{f.number(codes.counts[status] ?? 0)}</bdi>
            </Key>
          ))}
        </nav>
        {codes.rows.length === 0 ? (
          <EmptyState title={t("codes.empty")} text={t("codes.emptyHint")} icon="key" />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable caption={t("codes.title")} columns={columns} rows={codes.rows} rowKey={(row) => row.id} rowLabel={(row) => row.id} maxHeight={null} footer={<Pagination page={codes.page} pageCount={codes.pageCount} href={(n) => `?${codes.status ? `status=${codes.status}&` : ""}page=${n}`} />} />
            </div>
            <ul className="dev-cards md:hidden" aria-label={t("codes.title")}>
              {codes.rows.map((row) => (
                <li key={row.id} className="dev-card">
                  <span className="dev-card__top">
                    <Ref value={row.id.slice(-8)} />
                    <CodeBadge status={row.status} />
                  </span>
                  <span className="type-caption text-ink-2">
                    <When at={row.createdAt} /> {row.orderRef ? <>· <Ref value={row.orderRef} /></> : null}
                  </span>
                  <span className="inline-flex flex-wrap gap-1">{columns[columns.length - 1].cell(row, 0)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Section>

      <Section id="codes-import" title={t("codes.import")}>
        <importing.fetcher.Form method="post" className="grid max-w-[40rem] gap-3" noValidate>
          <input type="hidden" name="intent" value="import" />
          <TextArea name="codes" label={t("codes.codesField")} required rows={6} hint={t("codes.codesHint", { max: MAX_CODES_PER_IMPORT })} error={importing.fields.codes} dir="ltr" autoComplete="off" spellCheck={false} />
          <div className="dev-grid-2">
            <TextField name="expiresOn" type="date" label={t("codes.expiresOn")} optional ltr error={importing.fields.expiresOn} />
            {codes.withCost ? <TextField name="unitCostIqd" label={t("codes.unitCost")} optional inputMode="numeric" ltr error={importing.fields.unitCostIqd} end={<span className="type-caption">{t("iqd")}</span>} /> : null}
          </div>
          <p className="type-caption text-ink-2">{t("codes.encrypted")}</p>
          <Failure message={importing.message} />
          {result ? (
            <p className="type-body" role="status">
              {t("codes.imported", { added: Number(result.added ?? 0), duplicates: Number(result.duplicates ?? 0) })}
            </p>
          ) : null}
          <div>
            <Key type="submit" variant="ink" icon="upload-simple" loading={importing.pending}>
              {t("codes.importSubmit")}
            </Key>
          </div>
        </importing.fetcher.Form>
      </Section>

      <ConfirmDialog
        open={reveal !== null}
        onClose={() => setReveal(null)}
        title={t("codes.revealTitle")}
        consequence={t("codes.revealWhat")}
        confirmLabel={t("codes.reveal")}
        reason={{ label: t("codes.reason"), hint: t("codes.revealHint") }}
        pending={revealing.pending}
        error={revealing.message}
        onConfirm={({ reason }) => (reveal ? revealing.fetcher.submit({ intent: "reveal", codeId: reveal.id, reason }, { method: "post" }) : undefined)}
      >
        {shown ? (
          <div className="grid gap-1" role="status">
            <p className="type-label">{t("codes.theCode")}</p>
            <bdi dir="ltr" className="dev-code">
              {shown}
            </bdi>
            <p className="type-caption text-ink-2">{t("codes.shownOnce")}</p>
          </div>
        ) : null}
      </ConfirmDialog>

      <ConfirmDialog
        open={revoke !== null}
        onClose={() => setRevoke(null)}
        tone="destructive"
        title={t("codes.revokeTitle")}
        consequence={t("codes.revokeWhat")}
        confirmLabel={t("codes.revoke")}
        impact={[{ label: t("codes.available"), value: "−1", negative: true }]}
        reason={{ label: t("codes.reason") }}
        pending={revoking.pending}
        error={revoking.message}
        onConfirm={({ reason }) => (revoke ? revoking.fetcher.submit({ intent: "revoke", codeId: revoke.id, reason }, { method: "post" }) : undefined)}
      />
    </>
  );
}
