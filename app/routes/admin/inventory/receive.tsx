import { useEffect, useRef, useState } from "react";
import { Form, Link, redirect, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/receive";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { invalid } from "~/server/errors";
import { SESSION_REF, getReceivingSession, listReceivingSessions, lookupCode, newReceivingSession, receiveLine } from "~/server/services/admin/inventory/receiving.server";
import { DEFAULT_LOCATION_ID } from "~/server/db/seed/reference";
import { inventoryAccess, locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import { Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Code, Note, Num, PageHead, Pair, ResponsiveList, RowLink, Section, When, digitsOnly, useInvT } from "./components/kit";
import { ScanField, type ScanHitView } from "./components/ScanField";
import { failed, int, lines, newKey, ok, openInventory, optionalText, text } from "./inventory.server";
import { inventoryMeta } from "./meta";

/**
 * /admin/inventory/receive?session=RCV-…&location=… — receiving with inspection, counting and scanning (04.03).
 * Each submitted line is counted, inspected (rejected units stay out, with a reason) and, for serial-tracked items,
 * scanned unit by unit; the accepted units enter stock through the commerce core's receiveStock. The lines of one
 * delivery share the session reference. Works without JavaScript (the server resolves the typed code); with it, a
 * keyboard-wedge scan looks the item up first and moves on to the count.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale } = await openInventory(context, "inventory.stock.read");
  const url = new URL(request.url);
  const session = url.searchParams.get("session") ?? "";
  if (!SESSION_REF.test(session)) {
    url.searchParams.set("session", newReceivingSession());
    throw redirect(`${url.pathname}?${url.searchParams.toString()}`);
  }
  const tree = await locationTree(db);
  const locations = locationOptions(tree);
  const wanted = url.searchParams.get("location");
  const locationId = locations.some((option) => option.value === wanted) ? (wanted as string) : locations.some((option) => option.value === DEFAULT_LOCATION_ID) ? DEFAULT_LOCATION_ID : (locations[0]?.value ?? "");
  const [current, recent] = await Promise.all([getReceivingSession(db, actor, session, locale), listReceivingSessions(db, actor, locale, 10)]);
  return { session, locationId, locations, current, recent: recent.filter((entry) => entry.ref !== session), access: inventoryAccess(actor), key: newKey() };
}

export async function action({ context, request }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openInventory(context, "inventory.stock.receive");
  const form = await request.formData();
  try {
    let variantId = text(form, "variantId");
    if (!variantId) {
      const code = text(form, "code");
      if (!code) throw invalid({ code: "required" });
      const hit = await lookupCode(db, actor, code, locale);
      if (hit.kind !== "variant") throw invalid({ code: "unknown_code" });
      variantId = hit.variant.id;
    }
    const result = await receiveLine(
      db,
      actor,
      {
        sessionRef: text(form, "session"),
        locationId: text(form, "locationId"),
        variantId,
        counted: int(form, "counted"),
        rejected: int(form, "rejected") ?? 0,
        rejectReason: optionalText(form, "rejectReason"),
        serials: lines(form, "serials"),
        unitCostIqd: can(actor, "cost.read") ? int(form, "unitCostIqd") : undefined,
        reference: optionalText(form, "reference"),
        note: optionalText(form, "note"),
        idempotencyKey: text(form, "key"),
      },
      now,
      locale,
    );
    return ok({ intent: "receive", accepted: result.accepted, rejected: result.rejected, replayed: result.replayed });
  } catch (error) {
    return failed(error, locale, "receive");
  }
}

export const meta: Route.MetaFunction = (args) => inventoryMeta(args, "receive.title");

export default function Receive({ loaderData }: Route.ComponentProps) {
  const t = useInvT();
  const f = useFormat();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const { session, locations, current, recent, access } = loaderData;
  const [hydrated, setHydrated] = useState(false);
  const [hit, setHit] = useState<Extract<ScanHitView, { kind: "variant" }> | null>(null);
  const [locationId, setLocationId] = useState(loaderData.locationId);
  const [counted, setCounted] = useState("");
  const [rejected, setRejected] = useState("");
  const [serialText, setSerialText] = useState("");
  const countedRef = useRef<HTMLInputElement | null>(null);
  const serialsRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => setHydrated(true), []);
  // A new key per successful line: the form starts empty for the next item.
  useEffect(() => {
    setHit(null);
    setCounted("");
    setRejected("");
    setSerialText("");
  }, [loaderData.key]);

  const failure = result && !result.ok ? result : null;
  const done = result && result.ok ? result : null;
  const accepted = Math.max(0, (Number.parseInt(counted, 10) || 0) - (Number.parseInt(rejected, 10) || 0));
  const scanned = serialText.split(/\r?\n/).filter((line) => line.trim()).length;
  const showSerials = !hydrated || hit?.variant.trackSerials === true;
  const showReject = !hydrated || (Number.parseInt(rejected, 10) || 0) > 0;
  const busy = navigation.state === "submitting";

  return (
    <>
      <PageHead
        eyebrow={
          <>
            {t("receive.session")} <Code>{session}</Code>
          </>
        }
        title={t("receive.title")}
        lead={t("receive.lead")}
        actions={
          <Key as={Link} to={`/admin/inventory/receive?location=${encodeURIComponent(locationId)}`} icon="plus">
            {t("receive.newSession")}
          </Key>
        }
      />
      <Note className="mb-5">{t("receive.notInBooks")}</Note>

      {access.receive ? (
        <Form method="post" key={loaderData.key} className="adm-card mb-6 grid gap-4 lg:grid-cols-2" aria-label={t("receive.title")}>
          <input type="hidden" name="session" value={session} />
          <input type="hidden" name="key" value={loaderData.key} />
          <input type="hidden" name="variantId" value={hit?.variant.id ?? ""} />
          <Select name="locationId" label={t("receive.location")} value={locationId} onChange={(event) => setLocationId(event.target.value)} options={locations.map((option) => ({ value: option.value, label: option.label }))} required />
          <div className="grid gap-1">
            <ScanField
              name="code"
              label={t("receive.code")}
              hint={t("receive.codeHint")}
              keepValue
              autoFocus
              error={failure?.fields?.code}
              onHit={(scan) => {
                if (scan.kind === "variant") {
                  setHit(scan);
                  window.setTimeout(() => (scan.variant.trackSerials ? serialsRef.current : countedRef.current)?.focus(), 0);
                  return t("receive.found", { name: `${scan.variant.name} (${scan.variant.sku})` });
                }
                setHit(null);
                if (scan.kind === "location") {
                  setLocationId(scan.location.id);
                  return t("receive.locationFound", { code: scan.location.code });
                }
                if (scan.kind === "serial" || scan.kind === "serial_hidden") return t("receive.serialFound");
                return t("receive.notFound");
              }}
            />
            {hit ? (
              <p className="type-strong text-ink">
                {hit.variant.name} · <Code>{hit.variant.sku}</Code>
                {hit.variant.trackSerials ? <span className="type-caption text-ink-2"> · {t("common.tracked")}</span> : null}
              </p>
            ) : null}
          </div>
          <TextField ref={countedRef} name="counted" label={t("receive.counted")} inputMode="numeric" value={counted} onChange={(event) => setCounted(digitsOnly(event.target.value))} required error={failure?.fields?.counted} />
          <TextField name="rejected" label={t("receive.rejected")} hint={t("receive.rejectedHint")} inputMode="numeric" placeholder="0" value={rejected} onChange={(event) => setRejected(digitsOnly(event.target.value))} error={failure?.fields?.rejected} />
          {showReject ? <TextField name="rejectReason" label={t("receive.rejectReason")} maxLength={300} error={failure?.fields?.rejectReason} className="lg:col-span-2" /> : null}
          {showSerials ? (
            <TextArea
              ref={serialsRef}
              name="serials"
              label={t("receive.serials")}
              hint={hydrated && hit ? t("receive.serialsProgress", { scanned: f.number(scanned), needed: f.number(accepted) }) : t("receive.serialsHint")}
              rows={5}
              dir="ltr"
              spellCheck={false}
              value={serialText}
              onChange={(event) => setSerialText(event.target.value)}
              error={failure?.fields?.serials}
              className="lg:col-span-2"
            />
          ) : null}
          {access.cost ? (
            <TextField
              name="unitCostIqd"
              label={t("receive.unitCost")}
              hint={hit && hit.standardCostIqd != null ? t("receive.unitCostHint", { cost: f.iqd(hit.standardCostIqd) }) : hit ? t("receive.unitCostNoStandard") : undefined}
              inputMode="numeric"
              optional={hit?.standardCostIqd != null}
              error={failure?.fields?.unitCostIqd}
            />
          ) : null}
          <TextField name="reference" label={t("receive.reference")} hint={t("receive.referenceHint")} maxLength={120} ltr optional />
          <TextField name="note" label={t("receive.note")} maxLength={300} optional className="lg:col-span-2" />
          {failure?.message && (!failure.fields || failure.code !== "invalid") ? (
            <p role="alert" className="type-label text-red-ink lg:col-span-2">
              {failure.message}
            </p>
          ) : null}
          {done ? (
            <p role="status" className="type-label text-ok lg:col-span-2">
              {done.replayed ? t("receive.replayed") : t("receive.done", { accepted: t("common.units", { count: done.accepted as number }), rejectedText: (done.rejected as number) > 0 ? t("receive.doneRejected", { rejected: t("common.units", { count: done.rejected as number }) }) : "" })}
            </p>
          ) : null}
          <div className="lg:col-span-2">
            <Key type="submit" variant="commit" icon="package" loading={busy}>
              {!hydrated || counted === "" ? t("receive.submitIdle") : accepted > 0 ? t("receive.submit", { count: t("common.units", { count: accepted }) }) : t("receive.submitNone")}
            </Key>
          </div>
        </Form>
      ) : null}

      <Section id="receive-lines" title={t("receive.lines")}>
        <ResponsiveList
          caption={t("receive.lines")}
          rows={current.lines}
          rowKey={(line) => `${line.variantId}-${line.at}`}
          columns={[
            { key: "sku", header: t("common.sku"), cell: (line) => (line.variant ? <RowLink to={`/admin/inventory/stock/${line.variantId}`}><Code>{line.variant.sku}</Code></RowLink> : "—") },
            { key: "name", header: t("common.product"), cell: (line) => line.variant?.name ?? "—" },
            { key: "location", header: t("common.location"), cell: (line) => <Code>{line.locationCode}</Code> },
            { key: "counted", header: t("receive.counted"), numeric: true, cell: (line) => <Num value={line.counted} /> },
            { key: "accepted", header: t("receive.accepted"), numeric: true, cell: (line) => <Num value={line.accepted} /> },
            { key: "rejected", header: t("receive.rejected"), cell: (line) => (line.rejected > 0 ? <span><Num value={line.rejected} /> · {line.rejectReason}</span> : "—") },
            { key: "reference", header: t("common.reference"), cell: (line) => (line.reference ? <Code>{line.reference}</Code> : "—") },
            { key: "at", header: t("common.when"), cell: (line) => <When at={line.at} /> },
            { key: "by", header: t("common.by"), cell: (line) => line.by ?? "—" },
          ]}
          card={(line) => (
            <>
              <p className="type-strong">{line.variant?.name ?? "—"}</p>
              <p className="type-caption text-ink-2">
                <Code>{line.variant?.sku ?? ""}</Code> · <Code>{line.locationCode}</Code>
              </p>
              <Pair label={t("receive.accepted")}>
                <Num value={line.accepted} />
              </Pair>
              {line.rejected > 0 ? (
                <Pair label={t("receive.rejected")}>
                  <Num value={line.rejected} /> · {line.rejectReason}
                </Pair>
              ) : null}
            </>
          )}
          empty={<p className="type-body text-ink-2">{t("receive.noLines")}</p>}
        />
      </Section>

      <Section id="receive-recent" title={t("receive.recent")}>
        {recent.length === 0 ? (
          <p className="type-body text-ink-2">{t("receive.noRecent")}</p>
        ) : (
          <ul role="list" className="grid gap-2">
            {recent.map((entry) => (
              <li key={entry.ref} className="adm-card flex flex-wrap items-center justify-between gap-2">
                <Link to={`/admin/inventory/receive?session=${entry.ref}`} className="adm-link">
                  <Code>{entry.ref}</Code>
                </Link>
                <span className="type-data">
                  {t("receive.linesCount", { count: entry.lines.length })} · {t("receive.accepted")} <Num value={entry.accepted} />
                  {entry.rejected > 0 ? (
                    <>
                      {" "}
                      · {t("receive.rejected")} <Num value={entry.rejected} />
                    </>
                  ) : null}
                </span>
                <span className="type-caption text-ink-2">
                  <When at={entry.startedAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="type-caption text-ink-2">{t("receive.poNote")}</p>
      </Section>
    </>
  );
}
