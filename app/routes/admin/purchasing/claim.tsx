import { useRef, useState } from "react";
import { Link } from "react-router";

import type { Route } from "./+types/claim";
import { useFormat } from "~/i18n/react";
import { AppError, throwAsResponse } from "~/server/errors";
import { locationOptions, locationTree } from "~/server/services/admin/inventory/shared.server";
import { getClaim, moveClaim, returnClaimGoods } from "~/server/services/admin/purchasing/claims.server";
import { purchasingAccess } from "~/server/services/admin/purchasing/shared.server";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { ActionDialog } from "./components/ActionDialog";
import { Code, Facts, History, Kpi, Minor, Money, Note, Num, PageHead, Pair, ResponsiveList, RowLink, Section, StateTag, When, usePurT } from "./components/kit";
import { purchasingMeta } from "./meta";
import { failed, ok, openPurchasing, text } from "./purchasing.server";

/**
 * /admin/purchasing/claims/:claimId — one supplier claim (09.06): its lines, amount (cost.read), where it stands and its
 * next steps (submitted to the supplier, accepted or rejected with the reason, credited with the credit note, closed),
 * and — for goods that go back — sending them back: the units leave stock through the core (adjustStock) at the chosen
 * location, with the stock impact shown first.
 */
export async function loader({ context, params }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPurchasing(context, "purchasing.claim.manage");
  try {
    const detail = await getClaim(db, actor, params.claimId, locale, now);
    const access = purchasingAccess(actor);
    const branch = actor.branchId ?? null;
    const locations = detail.returnable && access.adjust ? locationOptions((await locationTree(db)).filter((node) => node.isActive && (branch === null || node.branchId === branch))).map((option) => ({ value: option.value, label: option.label })) : [];
    return { detail, access, locations };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ context, request, params }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = text(form, "intent");
  const { db, actor, locale, now } = await openPurchasing(context, intent === "return" ? "inventory.stock.adjust" : "purchasing.claim.manage");
  const claimId = params.claimId;
  try {
    if (intent === "move") {
      const result = await moveClaim(db, actor, { claimId, to: text(form, "to"), note: text(form, "reason") || undefined, creditAmount: text(form, "creditAmount") || undefined, creditReference: text(form, "creditReference") || undefined }, now);
      return ok({ intent, status: result.status });
    }
    if (intent === "return") {
      const result = await returnClaimGoods(db, actor, { claimId, locationId: text(form, "locationId"), reason: text(form, "reason") }, now, locale);
      return ok({ intent, returned: result.returned });
    }
    return failed(new AppError("invalid", 400), locale, intent);
  } catch (error) {
    return failed(error, locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => purchasingMeta(args, "claim.title", { ref: args.loaderData?.detail.claim.ref ?? "" });

type Line = Route.ComponentProps["loaderData"]["detail"]["lines"][number];

export default function ClaimPage({ loaderData }: Route.ComponentProps) {
  const t = usePurT();
  const f = useFormat();
  const { detail, access, locations } = loaderData;
  const { claim, lines } = detail;
  const [move, setMove] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);
  const [location, setLocation] = useState(locations[0]?.value ?? "");
  const credit = useRef<{ amount: string; reference: string }>({ amount: "", reference: "" });
  const units = lines.reduce((sum, line) => sum + line.qty, 0);
  const pending = lines.filter((line) => !line.returned?.done);
  const pendingUnits = pending.reduce((sum, line) => sum + line.qty, 0);
  const pendingRefused = pending.reduce((sum, line) => sum + line.refused, 0);
  // Units refused at inspection never entered stock: only the others leave it (and only they need a serial operation).
  const tracked = pending.filter((line) => line.variant.trackSerials && line.fromStock > 0);
  const locationCode = locations.find((option) => option.value === location)?.label.split(" · ")[0] ?? "";

  return (
    <>
      <p className="mb-2">
        <Link to="/admin/purchasing/claims" className="adm-link type-label">
          {t("claim.back")}
        </Link>
      </p>
      <PageHead
        eyebrow={
          <>
            {access.supplierRead ? <RowLink to={`/admin/purchasing/suppliers/${claim.supplier.id}`}><bdi>{claim.supplier.name}</bdi></RowLink> : <bdi>{claim.supplier.name}</bdi>} · {t(`claimKind.${claim.kind}`)}
          </>
        }
        title={t("claim.title", { ref: claim.ref })}
        actions={<StateTag group="claim" value={claim.status} label={t(`claimStatus.${claim.status}`)} />}
      />

      <div className="pur-kpis mb-5">
        <Kpi label={t("claims.units")} value={f.number(units)} />
        <Kpi label={t("claims.returned")} value={f.number(units - pendingUnits)} />
        {claim.amountMinor !== undefined ? <Kpi wide label={t("claims.amount")} value={<Minor minor={claim.amountMinor} currency={claim.currency} />} hint={claim.currency !== "IQD" ? <Money iqd={claim.amountIqd} /> : undefined} /> : null}
      </div>

      <Section id="facts" title={t("claim.details")}>
        <Facts
          items={[
            { label: t("common.order"), value: claim.po ? <RowLink to={`/admin/purchasing/orders/${claim.po.id}`}><Code>{claim.po.ref}</Code></RowLink> : "—" },
            { label: t("claim.receipt"), value: claim.receipt ? <RowLink to={`/admin/purchasing/receipts/${claim.receipt.id}`}><Code>{claim.receipt.ref}</Code></RowLink> : "—" },
            { label: t("common.created"), value: <When at={claim.createdAt} /> },
            { label: t("claims.description"), value: claim.description ?? "—", wide: true },
            ...(claim.resolution ? [{ label: t("claim.resolution"), value: claim.resolution, wide: true }] : []),
          ]}
        />
      </Section>

      <Section id="lines" title={t("claims.lines")}>
        <ResponsiveList
          caption={t("claims.lines")}
          rows={lines}
          rowKey={(line) => String(line.index)}
          columns={[
            { key: "sku", header: t("common.sku"), cell: (line: Line) => <Code>{line.variant.sku}</Code> },
            { key: "name", header: t("common.product"), cell: (line: Line) => <span className="line-clamp-2 min-w-[10rem]">{line.variant.name}</span> },
            { key: "qty", header: t("common.qty"), numeric: true, cell: (line: Line) => <Num value={line.qty} /> },
            ...(lines.some((line) => line.refused > 0)
              ? [
                  { key: "refused", header: t("claim.refusedCol"), numeric: true, cell: (line: Line) => <Num value={line.refused} /> },
                  { key: "fromStock", header: t("claim.fromStock"), numeric: true, cell: (line: Line) => <Num value={line.fromStock} /> },
                ]
              : []),
            { key: "serial", header: t("claims.serial"), cell: (line: Line) => (line.serial ? <Code>{line.serial}</Code> : "—") },
            { key: "returned", header: t("claims.returned"), cell: (line: Line) => (line.returned ? (line.returned.done ? <span>{t("claim.returnedAt", { location: line.returned.location })} · <When at={line.returned.at} kind="date" /></span> : <span className="text-red-ink">{t("claim.returnStopped")}</span>) : <span className="text-ink-2">{t("receipt.notYet")}</span>) },
          ]}
          card={(line) => (
            <>
              <p className="type-strong">{line.variant.name}</p>
              <p className="type-caption text-ink-2">
                <Code>{line.variant.sku}</Code>
                {line.serial ? (
                  <>
                    {" · "}
                    <Code>{line.serial}</Code>
                  </>
                ) : null}
              </p>
              <Pair label={t("common.qty")}>
                <Num value={line.qty} />
              </Pair>
              {line.refused > 0 ? (
                <Pair label={t("claim.refusedCol")}>
                  <Num value={line.refused} />
                </Pair>
              ) : null}
              <Pair label={t("claims.returned")}>{line.returned ? (line.returned.done ? t("claim.returnedAt", { location: line.returned.location }) : t("claim.returnStopped")) : t("receipt.notYet")}</Pair>
            </>
          )}
        />
      </Section>

      {detail.next.length > 0 ? (
        <Section id="next" title={t("claim.next")}>
          <div className="flex flex-wrap gap-2">
            {detail.next.map((to) => (
              <Key key={to} icon={to === "closed" || to === "rejected" ? "x-circle" : to === "credited" ? "receipt" : "arrow-right"} className={to === "rejected" ? "[--on:var(--red-ink)]" : undefined} onClick={() => setMove(to)}>
                {t(`claim.moveTo.${to}`)}
              </Key>
            ))}
          </div>
        </Section>
      ) : null}

      {detail.returnable ? (
        <Section id="return" title={t("claim.returnTitle")}>
          <p className="type-body text-ink-2">{t("claim.returnLead")}</p>
          {pendingRefused > 0 ? <Note icon="info">{t("claim.refusedNote", { count: pendingRefused })}</Note> : null}
          {claim.receipt || claim.po ? <p className="type-caption text-ink-2">{t("claim.returnLimitNote")}</p> : null}
          {detail.returnState === "resumable" ? <Note tone="warn" icon="warning">{t("claim.returnResumable")}</Note> : null}
          {tracked.length > 0 ? (
            <Note tone="warn" icon="warning">
              {t("claim.trackedBlocked", { skus: tracked.map((line) => line.variant.sku).join(", ") })}
            </Note>
          ) : null}
          {!access.adjust ? (
            <Note icon="lock">{t("claim.needsAdjust")}</Note>
          ) : locations.length === 0 ? (
            <Note icon="info">{t("claim.noLocations")}</Note>
          ) : (
            <div className="adm-card flex flex-wrap items-end gap-3">
              <Select label={t("claim.returnFrom")} options={locations} value={location} onChange={(event) => setLocation(event.currentTarget.value)} className="min-w-[14rem]" />
              <Key variant="commit" icon="truck" disabled={tracked.length > 0} onClick={() => setReturning(true)}>
                {t("claim.returnKey")}
              </Key>
            </div>
          )}
        </Section>
      ) : detail.returnState === "done" ? (
        <Note icon="check-circle" className="mb-5">
          {t("claim.returnDone")}
        </Note>
      ) : null}

      <Section id="history" title={t("common.history")}>
        <History entries={detail.history} />
      </Section>

      <ActionDialog
        open={move !== null}
        onClose={() => setMove(null)}
        title={move ? t(`claim.moveTitle.${move}`) : ""}
        consequence={move ? t(`claim.moveConsequence.${move}`) : ""}
        confirmLabel={move ? t(`claim.moveTo.${move}`) : ""}
        tone={move === "rejected" || move === "closed" ? "destructive" : "neutral"}
        reason={move === "rejected" || move === "closed" ? true : { noteRequired: false, label: t("claim.note") }}
        fields={{ intent: "move", to: move ?? "" }}
        extra={(): Record<string, string> => (move === "credited" ? { creditReference: credit.current.reference, creditAmount: credit.current.amount } : {})}
        successMessage={t("claim.moved")}
      >
        {move === "credited" ? (
          <div className="grid gap-3">
            <TextField label={t("claim.creditReference")} required ltr maxLength={80} onChange={(event) => (credit.current.reference = event.currentTarget.value)} />
            {access.cost ? <TextField label={t("claim.creditAmount", { currency: claim.currency })} inputMode="decimal" ltr optional onChange={(event) => (credit.current.amount = event.currentTarget.value)} /> : null}
          </div>
        ) : null}
      </ActionDialog>
      <ActionDialog
        open={returning}
        onClose={() => setReturning(false)}
        title={t("claim.returnConfirm")}
        consequence={pending.some((line) => line.fromStock > 0) ? t("claim.returnConsequence", { location: locationCode, supplier: claim.supplier.name }) : t("claim.returnConsequenceRefused", { supplier: claim.supplier.name })}
        confirmLabel={t("claim.returnKey")}
        tone="commit"
        reason={{ hint: t("claim.returnReasonHint") }}
        impact={[
          ...pending.filter((line) => line.fromStock > 0).map((line) => ({ label: `${line.variant.sku} · ${locationCode}`, value: `−${f.number(line.fromStock)}`, negative: true })),
          ...(pendingRefused > 0 ? [{ label: t("claim.refusedImpact"), value: f.number(pendingRefused) }] : []),
        ]}
        fields={{ intent: "return", locationId: location }}
        successMessage={t("claim.returned", { count: pendingUnits })}
      />
    </>
  );
}
