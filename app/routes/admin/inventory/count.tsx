import { useEffect, useState } from "react";
import { Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/count";
import { useFormat } from "~/i18n/react";
import { AppError, throwAsResponse } from "~/server/errors";
import { approveCount, cancelCount, getCount, recordCounts, sendBackCount, submitCount } from "~/server/services/admin/inventory/counts.server";
import { inventoryAccess } from "~/server/services/admin/inventory/shared.server";
import { Checkbox, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { toast } from "~/ui/toast-store";
import { ActionDialog } from "./components/ActionDialog";
import { Code, Kpi, Money, Note, Num, PageHead, Pair, ResponsiveList, Section, StateTag, When, digitsOnly, useInvT } from "./components/kit";
import { ScanField } from "./components/ScanField";
import { checked, failed, inventoryT, ok, openInventory, text, toInt } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/counts/:countId — one stock count (04.05). While counting: a scan field (each SKU scan adds one,
 * a serial scan lands on its SKU) and the lines to fill in, blind (expected quantities hidden from counters).
 * In review: expected against counted, the differences with their value [P] and any that would oversell, and the
 * supervisor's approval — refused to whoever started or counted it — which posts the differences through the
 * commerce core. Serial differences are listed, not posted.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "inventory.stock.read");
  try {
    return { count: await getCount(db, actor, params.countId, locale), access: inventoryAccess(actor) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const countId = params.countId;
  const permission = intent === "approve" || intent === "sendBack" ? "inventory.count.approve" : "inventory.count.perform";
  // Cancelling is open to counters and approvers alike: the service decides (inventory.count.perform or .approve).
  const { db, actor, locale, now } = await openInventory(context, intent === "cancel" ? "inventory.stock.read" : permission);
  try {
    if (intent === "record") {
      const variantIds = form.getAll("variantId").map(String);
      const counted = form.getAll("counted").map(String);
      const serials = form.getAll("serials").map(String);
      const notes = form.getAll("note").map(String);
      const tracked = form.getAll("tracked").map(String);
      const lines = variantIds
        .map((variantId, index) => {
          const isTracked = tracked[index] === "1";
          const serialList = (serials[index] ?? "").split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
          const raw = (counted[index] ?? "").trim();
          if (isTracked ? serialList.length === 0 && raw === "" : raw === "") return null;
          // toInt: Arabic-Indic digits are digits; "1e3", "0x10" or "7.5" are not whole numbers typed by a person (NaN → refused)
          return { variantId, countedQty: isTracked ? undefined : toInt(raw), serials: isTracked ? serialList : undefined, note: (notes[index] ?? "").trim() || undefined };
        })
        .filter((line): line is NonNullable<typeof line> => line !== null);
      if (lines.length === 0) return ok({ intent, saved: 0 });
      const result = await recordCounts(db, actor, { countId, lines }, now);
      return ok({ intent, saved: result.saved });
    }
    if (intent === "submit") {
      await submitCount(db, actor, { countId }, now);
      return ok({ intent });
    }
    if (intent === "approve") {
      const result = await approveCount(db, actor, { countId, reason: text(form, "reason"), allowOversell: checked(form, "allowOversell") }, now, locale);
      // The toast names what THIS approval posted (an approval that resumes a stopped one posts only the rest).
      return ok({ intent, posted: result.posted, message: inventoryT(locale)("count.approved", { count: result.posted }) });
    }
    if (intent === "sendBack") {
      await sendBackCount(db, actor, { countId, reason: text(form, "reason") }, now);
      return ok({ intent });
    }
    if (intent === "cancel") {
      await cancelCount(db, actor, { countId, reason: text(form, "reason") }, now);
      return ok({ intent });
    }
    return failed(new AppError("invalid", 400), locale, intent);
  } catch (error) {
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "count.title", { ref: args.loaderData?.count.ref ?? "" });

type Count = Route.ComponentProps["loaderData"]["count"];
type Line = Count["lines"][number];
type Draft = { counted: string; serials: string; note: string };
type Extra = { variantId: string; sku: string; name: string; tracked: boolean };

export default function CountPage({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const { count, access } = loaderData;
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const counting = count.status === "counting" && access.countPerform;
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [extra, setExtra] = useState<Extra[]>([]);
  const [dialog, setDialog] = useState<null | "submit" | "approve" | "sendBack" | "cancel">(null);
  const [allowOversell, setAllowOversell] = useState(false);

  useEffect(() => {
    const next: Record<string, Draft> = {};
    for (const line of count.lines) next[line.variant.id] = { counted: line.counted === null || line.tracked ? "" : String(line.counted), serials: (line.serials?.seen ?? []).join("\n"), note: line.note ?? "" };
    setDrafts(next);
    setExtra([]);
  }, [count]);
  useEffect(() => {
    if (result?.ok && result.intent === "record") toast.success(t("count.saved"));
  }, [result, t]);

  const draft = (variantId: string): Draft => drafts[variantId] ?? { counted: "", serials: "", note: "" };
  const patch = (variantId: string, change: Partial<Draft>) => setDrafts((current) => ({ ...current, [variantId]: { ...draft(variantId), ...current[variantId], ...change } }));
  const failure = result && !result.ok ? result : null;
  // Differences exist in the data only once the count is not blind for this employee (count.showExpected).
  const differences = count.summary.differences ?? 0;
  const unitsMissing = count.summary.unitsMissing ?? 0;
  const unitsFound = count.summary.unitsFound ?? 0;
  const oversellLines = count.summary.oversell ?? 0;
  const totalValue = count.lines.some((line) => line.valueIqd === null) ? null : count.lines.reduce((sum, line) => sum + (line.valueIqd ?? 0), 0);
  const hasValue = count.lines.some((line) => line.valueIqd !== undefined);
  // What an approval posts now: differences not posted yet (an approval that stopped half way posted the others).
  const pending = count.lines.filter((line) => !line.tracked && !line.posted && (line.difference ?? 0) !== 0);
  const pendingMissing = pending.reduce((sum, line) => sum + Math.max(0, -(line.difference ?? 0)), 0);
  const pendingFound = pending.reduce((sum, line) => sum + Math.max(0, line.difference ?? 0), 0);
  const pendingValue = pending.some((line) => line.valueIqd === null) ? null : pending.reduce((sum, line) => sum + (line.valueIqd ?? 0), 0);
  // Some differences are posted already: the count can only be finished (approved), never cancelled.
  const partiallyPosted = count.postedLines > 0;
  const editableLines: (Line | Extra)[] = [...count.lines, ...extra.filter((entry) => !count.lines.some((line) => line.variant.id === entry.variantId))];

  return (
    <>
      <p className="mb-2">
        <Link to="/admin/inventory/counts" className="adm-link type-label">
          {t("count.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={
          <>
            <Code>{count.location.path}</Code> · {count.location.name} · {count.scope === "full" ? t("counts.scopeFull") : t("counts.scopePartial")}
          </>
        }
        title={t("count.title", { ref: count.ref })}
        actions={<StateTag group="count" value={count.status} label={t(`countStatus.${count.status}`)} />}
      />
      <p className="mb-4 type-caption text-ink-2">
        {t("count.startedBy", { name: count.startedBy ?? "—", time: f.dateTime(count.createdAt) })}
        {count.approvedBy && count.approvedAt ? ` · ${t("count.approvedBy", { name: count.approvedBy, time: f.dateTime(count.approvedAt) })}` : ""}
      </p>
      {count.notes ? <p className="mb-4 type-body">{count.notes}</p> : null}
      {partiallyPosted && (count.status === "counting" || count.status === "review") ? (
        <Note tone="warn" className="mb-4">
          {t("count.partiallyPosted", { count: count.postedLines })}
        </Note>
      ) : null}

      <div className="inv-kpis mb-6">
        <Kpi label={t("counts.progress")} value={`${f.number(count.summary.counted)} / ${f.number(count.summary.lines)}`} />
        {count.showExpected ? <Kpi label={t("counts.differences")} value={f.number(differences)} /> : null}
        {count.showExpected ? <Kpi label={t("count.impactMissing")} value={f.number(unitsMissing)} /> : null}
        {count.showExpected ? <Kpi label={t("count.impactFound")} value={f.number(unitsFound)} /> : null}
        {hasValue && count.showExpected ? <Kpi wide label={t("count.impactValue")} value={<Money iqd={totalValue} />} /> : null}
      </div>

      {counting ? (
        <>
          <Note className="mb-4">{t("count.blind")}</Note>
          <ScanField
            name="scan"
            label={t("count.scan")}
            hint={t("count.scanHint")}
            autoFocus
            className="mb-4 max-w-xl"
            onHit={(hit) => {
              if (hit.kind === "variant") {
                const id = hit.variant.id;
                if (!count.lines.some((line) => line.variant.id === id) && !extra.some((entry) => entry.variantId === id)) setExtra((list) => [...list, { variantId: id, sku: hit.variant.sku, name: hit.variant.name, tracked: hit.variant.trackSerials }]);
                if (!hit.variant.trackSerials) patch(id, { counted: String((Number.parseInt(draft(id).counted, 10) || 0) + 1) });
                return t("count.scanAdded", { sku: hit.variant.sku });
              }
              if (hit.kind === "serial") {
                const id = hit.variant.id;
                if (!count.lines.some((line) => line.variant.id === id) && !extra.some((entry) => entry.variantId === id)) setExtra((list) => [...list, { variantId: id, sku: hit.variant.sku, name: hit.variant.name, tracked: true }]);
                const current = draft(id).serials.split(/\r?\n/).filter(Boolean);
                if (!current.map((value) => value.toUpperCase()).includes(hit.serial.toUpperCase())) patch(id, { serials: [...current, hit.serial].join("\n") });
                return t("count.scanAdded", { sku: `${hit.variant.sku} · ${hit.serial}` });
              }
              return t("count.scanUnknown");
            }}
          />
          <Form method="post" className="grid gap-3">
            <input type="hidden" name="intent" value="record" />
            {editableLines.length === 0 ? <p className="adm-card type-body text-ink-2">{t("count.noLines")}</p> : null}
            <ul role="list" className="grid gap-2">
              {editableLines.map((entry) => {
                const variantId = "variant" in entry ? entry.variant.id : entry.variantId;
                const tracked = "variant" in entry ? entry.tracked : entry.tracked;
                const sku = "variant" in entry ? entry.variant.sku : entry.sku;
                const name = "variant" in entry ? entry.variant.name : entry.name;
                const value = draft(variantId);
                return (
                  <li key={variantId} className="adm-card grid gap-3 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.5fr)] md:items-start">
                    <input type="hidden" name="variantId" value={variantId} />
                    <input type="hidden" name="tracked" value={tracked ? "1" : "0"} />
                    <div className="grid gap-0.5">
                      <p className="type-strong">{name}</p>
                      <p className="type-caption text-ink-2">
                        <Code>{sku}</Code>
                        {count.showExpected && "variant" in entry && entry.expected !== null ? (
                          <>
                            {" · "}
                            {t("count.expected")} <Num value={entry.expected} />
                          </>
                        ) : null}
                        {"variant" in entry && entry.countedBy ? ` · ${entry.countedBy}` : ""}
                      </p>
                    </div>
                    {tracked ? (
                      <>
                        <input type="hidden" name="counted" value="" />
                        <TextArea name="serials" label={t("count.serialsSeen")} hint={`${t("count.serialsHint")} ${f.number(value.serials.split(/\r?\n/).filter(Boolean).length)}`} rows={3} dir="ltr" spellCheck={false} value={value.serials} onChange={(event) => patch(variantId, { serials: event.target.value })} />
                      </>
                    ) : (
                      <>
                        <input type="hidden" name="serials" value="" />
                        <TextField name="counted" label={t("count.counted")} inputMode="numeric" value={value.counted} onChange={(event) => patch(variantId, { counted: digitsOnly(event.target.value) })} />
                      </>
                    )}
                    <TextField name="note" label={t("common.note")} optional maxLength={300} value={value.note} onChange={(event) => patch(variantId, { note: event.target.value })} />
                  </li>
                );
              })}
            </ul>
            {failure && failure.intent === "record" ? (
              <p role="alert" className="type-label text-red-ink">
                {failure.message ?? Object.values(failure.fields ?? {})[0]}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Key type="submit" variant="ink" icon="floppy-disk" loading={navigation.state === "submitting" && navigation.formData?.get("intent") === "record"}>
                {t("count.save")}
              </Key>
              <Key icon="paper-plane-tilt" onClick={() => setDialog("submit")} disabled={count.summary.counted === 0}>
                {t("count.submit")}
              </Key>
              {partiallyPosted ? null : (
                <Key onClick={() => setDialog("cancel")} className="[--on:var(--red-ink)]">
                  {t("count.cancel")}
                </Key>
              )}
            </div>
          </Form>
        </>
      ) : (
        <Section id="count-lines" title={count.status === "review" ? t("count.review") : t("count.linesTitle")}>
          {count.lines.some((line) => line.tracked) ? <Note icon="barcode">{t("count.serialNote")}</Note> : null}
          <ResponsiveList
            caption={t("count.linesTitle")}
            rows={count.lines}
            rowKey={(line) => line.id}
            columns={[
              { key: "sku", header: t("common.sku"), cell: (line) => <Code>{line.variant.sku}</Code> },
              { key: "name", header: t("common.product"), cell: (line) => <span className="line-clamp-2 min-w-[12rem]">{line.variant.name}</span> },
              { key: "expected", header: t("count.expected"), numeric: true, cell: (line) => <Num value={line.expected} /> },
              { key: "counted", header: t("count.counted"), numeric: true, cell: (line) => (line.counted === null ? t("count.notCounted") : <Num value={line.counted} />) },
              { key: "difference", header: t("count.difference"), numeric: true, cell: (line) => <Num value={line.difference} signed />, negative: (line) => (line.difference ?? 0) < 0 },
              ...(hasValue ? [{ key: "value", header: t("common.value"), numeric: true, cell: (line: Line) => <Money iqd={line.valueIqd} /> }] : []),
              { key: "flags", header: t("common.status"), cell: (line) => <LineFlags line={line} /> },
              { key: "note", header: t("common.note"), cell: (line) => <span className="line-clamp-2 min-w-[10rem]">{line.note ?? "—"}{line.countedBy ? ` · ${line.countedBy}` : ""}</span> },
            ]}
            card={(line) => (
              <>
                <p className="type-strong">{line.variant.name}</p>
                <p className="type-caption text-ink-2">
                  <Code>{line.variant.sku}</Code>
                </p>
                <Pair label={t("count.expected")}>
                  <Num value={line.expected} />
                </Pair>
                <Pair label={t("count.counted")}>{line.counted === null ? t("count.notCounted") : <Num value={line.counted} />}</Pair>
                <Pair label={t("count.difference")}>
                  <Num value={line.difference} signed />
                </Pair>
                <LineFlags line={line} />
              </>
            )}
          />

          {count.status === "review" ? (
            <div className="mt-4 grid gap-3">
              {count.selfInvolved ? <Note tone="warn">{t("count.selfInvolved")}</Note> : !count.canApprove ? <Note>{t("count.noApprove")}</Note> : null}
              {oversellLines > 0 ? <Note tone="warn">{t("count.oversellNeeded")}</Note> : null}
              <div className="flex flex-wrap gap-2">
                {count.canApprove ? (
                  <Key variant="commit" icon="seal-check" onClick={() => setDialog("approve")}>
                    {t("count.approve")}
                  </Key>
                ) : null}
                {access.countApprove ? (
                  <Key icon="arrow-counter-clockwise" onClick={() => setDialog("sendBack")}>
                    {t("count.sendBack")}
                  </Key>
                ) : null}
                {(access.countApprove || access.countPerform) && !partiallyPosted ? (
                  <Key onClick={() => setDialog("cancel")} className="[--on:var(--red-ink)]">
                    {t("count.cancel")}
                  </Key>
                ) : null}
              </div>
            </div>
          ) : null}
        </Section>
      )}

      <ActionDialog
        open={dialog === "submit"}
        onClose={() => setDialog(null)}
        title={t("count.submitConfirm")}
        consequence={t("count.submitConsequence")}
        confirmLabel={t("count.submit")}
        fields={{ intent: "submit" }}
        successMessage={t("count.submitted")}
      />
      <ActionDialog
        open={dialog === "cancel"}
        onClose={() => setDialog(null)}
        title={t("count.cancelConfirm")}
        consequence={t("count.cancelConsequence")}
        confirmLabel={t("count.cancel")}
        tone="destructive"
        reason
        fields={{ intent: "cancel" }}
        successMessage={t("count.cancelled")}
      />
      <ActionDialog
        open={dialog === "sendBack"}
        onClose={() => setDialog(null)}
        title={t("count.sendBackConfirm")}
        consequence={t("count.sendBackConsequence")}
        confirmLabel={t("count.sendBack")}
        reason
        fields={{ intent: "sendBack" }}
        successMessage={t("count.sentBack")}
      />
      <ActionDialog
        open={dialog === "approve"}
        onClose={() => setDialog(null)}
        title={t("count.approveConfirm")}
        consequence={t("count.approveConsequence")}
        confirmLabel={t("count.approve")}
        tone="commit"
        reason
        fields={{ intent: "approve", allowOversell: allowOversell ? "on" : "" }}
        impact={[
          { label: t("count.impactLines"), value: f.number(pending.length) },
          { label: t("count.impactMissing"), value: pendingMissing > 0 ? `−${f.number(pendingMissing)}` : f.number(0), negative: pendingMissing > 0 },
          { label: t("count.impactFound"), value: pendingFound > 0 ? `+${f.number(pendingFound)}` : f.number(0) },
          ...(hasValue ? [{ label: t("count.impactValue"), value: pendingValue === null ? t("common.valueUnknown") : pendingValue < 0 ? `−${f.iqd(-pendingValue)}` : f.iqd(pendingValue), negative: (pendingValue ?? 0) < 0 }] : []),
          ...(oversellLines > 0 ? [{ label: t("count.impactOversell"), value: f.number(oversellLines), negative: true }] : []),
        ]}
      >
        {oversellLines > 0 && access.oversell ? (
          <div className="mt-4">
            <Checkbox label={t("count.allowOversell")} hint={t("adjust.oversellConfirmHint")} checked={allowOversell} onChange={(event) => setAllowOversell(event.target.checked)} />
          </div>
        ) : oversellLines > 0 ? (
          <p className="mt-4 type-body text-red-ink">{t("adjust.oversellNeedsPermission")}</p>
        ) : null}
      </ActionDialog>
    </>
  );
}

function LineFlags({ line }: { line: Line }) {
  const t = useInvT();
  return (
    <span className="grid gap-1">
      {line.posted ? <StateTag group="count" value="approved" label={t("count.posted")} /> : null}
      {line.oversell ? <span className="type-caption text-red-ink">{t("count.oversellLine")}</span> : null}
      {line.serials && line.serials.missing.length > 0 ? (
        <span className="type-caption">
          {t("count.missing")}:{" "}
          {line.serials.missing.map((serial) => (
            <Code key={serial} className="me-1">
              {serial}
            </Code>
          ))}
        </span>
      ) : null}
      {line.serials && line.serials.unexpected.length > 0 ? (
        <span className="type-caption">
          {t("count.unexpected")}:{" "}
          {line.serials.unexpected.map((entry) => (
            <span key={entry.serial} className="me-1">
              <Code>{entry.serial}</Code> ({entry.status ? t("count.elsewhere", { location: entry.locationCode ?? "—", status: t(`serialStatus.${entry.status}`) }) : t("count.unknownSerial")})
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}
