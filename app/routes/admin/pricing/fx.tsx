import { useEffect, useState } from "react";
import { data, useFetcher } from "react-router";

import type { Route } from "./+types/fx";
import { useFormat } from "~/i18n/react";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { getFxOverview, setFxRate } from "~/server/services/admin/pricing/fx.server";
import { ConfirmDialog } from "~/ui/Dialog";
import { EmptyState } from "~/ui/EmptyState";
import { FieldGroup, Radio, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { toast } from "~/ui/toast-store";
import { failure, formKey, formObject, requirePricing } from "./route.server";
import { ByLine, failureOf, iqdText, PageHead, pctText, pricingMeta, typedIqd, useArrow, usePricingT } from "./shared";

/**
 * /admin/pricing/fx — the store's USD rate (settings 22.01 links here): the rate shoppers' converted prices use now,
 * rates scheduled for later, and every rate ever set (rates are added, never edited). Payable amounts stay IQD.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requirePricing(ctx, db);
  return { overview: await getFxOverview(db, actor, ctx.now), formKey: formKey(), now: ctx.now };
}

export async function action({ request, context }: Route.ActionArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const form = await request.formData();
  if (form.get("intent") !== "set") throw data({ error: "not_found" }, { status: 404 });
  const { actor } = await requirePricing(ctx, db, "pricing.fx_rate.manage");
  try {
    return { ok: true as const, intent: "set", result: await setFxRate(db, actor, formObject(form), ctx.now) };
  } catch (error) {
    return failure(error, ctx.locale, "set");
  }
}

export const meta: Route.MetaFunction = (args) => pricingMeta(args, "fx.title");

/** What a shopper sees for a 100,000 IQD price at a rate (dollars, two decimals). */
const SAMPLE_IQD = 100_000;

export default function FxRate({ loaderData }: Route.ComponentProps) {
  const t = usePricingT();
  const f = useFormat();
  const { overview } = loaderData;
  const arrow = useArrow();
  const fetcher = useFetcher<typeof action>();
  const [rate, setRate] = useState("");
  const [source, setSource] = useState(overview.current && !overview.current.isDemo ? overview.current.source : "");
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [open, setOpen] = useState(false);
  const failed = failureOf(fetcher.data);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data && "ok" in fetcher.data && fetcher.data.ok) {
      setOpen(false);
      setRate("");
      toast.success(fetcher.data.result.replayed ? t("fx.replayed") : t("fx.saved"));
    }
  }, [fetcher.state, fetcher.data, t]);

  // The server's own parser: Arabic-Indic digits work; "1310.5" is refused, not read as 13,105.
  const typed = typedIqd(rate) ?? Number.NaN;
  const current = overview.current?.iqdPerUnit ?? null;
  const changeBps = current && typed > 0 ? Math.trunc(((typed - current) * 10_000) / current) : null;
  const usd = (iqdPerUnit: number | null) => (iqdPerUnit ? `$${f.number(SAMPLE_IQD / iqdPerUnit, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");

  return (
    <>
      <PageHead title={t("fx.title")} lead={t("fx.lead")} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section className="adm-card content-start" aria-labelledby="fx-current">
          <h2 id="fx-current" className="adm-h2">
            {t("fx.current")}
          </h2>
          {overview.current ? (
            <>
              <p className="type-kpi">{t("fx.perDollar", { amount: f.iqd(overview.current.iqdPerUnit) })}</p>
              <p className="type-caption text-ink-2">{t("fx.source", { source: overview.current.source })}</p>
              <ByLine name={overview.current.createdBy?.name} at={overview.current.effectiveAt} />
              {overview.current.isDemo ? <Status tone="warn">{t("fx.demo")}</Status> : null}
            </>
          ) : (
            <EmptyState title={t("fx.noneTitle")} text={t("fx.noneText")} />
          )}
          {overview.scheduled.length > 0 ? (
            <div className="grid gap-1 border-t border-line pt-3">
              <h3 className="adm-h3">{t("fx.scheduled")}</h3>
              {overview.scheduled.map((row) => (
                <p key={row.id} className="type-body">
                  <bdi dir="ltr" className="nums">
                    {f.iqd(row.iqdPerUnit)}
                  </bdi>{" "}
                  · {t("fx.from", { date: f.dateTime(row.effectiveAt) })}
                </p>
              ))}
            </div>
          ) : null}
          <p className="type-caption text-ink-2">{t("fx.note")}</p>
        </section>

        {overview.canManage ? (
          <section className="adm-card content-start" aria-labelledby="fx-set">
            <h2 id="fx-set" className="adm-h2">
              {t("fx.setTitle")}
            </h2>
            <form
              className="grid gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                setOpen(true);
              }}
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label={t("fx.rate")} inputMode="numeric" ltr value={rate} onChange={(event) => setRate(event.currentTarget.value)} end={t("common.iqd")} required hint={t("fx.rateHint")} error={failed?.fields?.iqdPerUnit} />
                <TextField label={t("fx.sourceLabel")} value={source} onChange={(event) => setSource(event.currentTarget.value)} required hint={t("fx.sourceHint")} error={failed?.fields?.source} />
              </div>
              <FieldGroup legend={t("fx.when")} error={failed?.fields?.effective}>
                <Radio row name="when" value="now" label={t("fx.now")} checked={when === "now"} onChange={() => setWhen("now")} />
                <Radio row name="when" value="later" label={t("fx.later")} hint={t("fx.laterHint")} checked={when === "later"} onChange={() => setWhen("later")} />
              </FieldGroup>
              {when === "later" ? <TextField label={t("fx.at")} type="datetime-local" ltr value={at} onChange={(event) => setAt(event.currentTarget.value)} required /> : null}
              <div>
                <Key type="submit" variant="ink" disabled={!(typed > 0) || source.trim().length < 2}>
                  {t("fx.review")}
                </Key>
              </div>
            </form>
          </section>
        ) : (
          <p className="type-body text-ink-2">{t("fx.readOnly")}</p>
        )}
      </div>

      <section className="adm-section mt-8" aria-labelledby="fx-history">
        <h2 id="fx-history" className="adm-h2">
          {t("fx.history")}
        </h2>
        {overview.history.length === 0 ? (
          <p className="type-body text-ink-2">{t("fx.historyEmpty")}</p>
        ) : (
          <ol className="grid gap-0 rounded-sm bg-paper shadow-[inset_0_0_0_1px_var(--line)]">
            {overview.history.map((row) => (
              <li key={row.id} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
                <span className="type-body">
                  <bdi dir="ltr" className="nums">
                    {f.iqd(row.iqdPerUnit)}
                  </bdi>{" "}
                  <span className="type-caption text-ink-2">· {row.source}</span>
                  {row.isDemo ? <span className="type-caption text-ink-2"> · {t("fx.demo")}</span> : null}
                </span>
                <ByLine name={row.createdBy?.name ?? t("fx.system")} at={row.effectiveAt} />
              </li>
            ))}
          </ol>
        )}
      </section>

      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title={t("fx.confirmTitle")}
        consequence={when === "now" ? t("fx.confirmNow") : t("fx.confirmLater", { at: at || "—" })}
        confirmLabel={t("fx.save")}
        impact={[
          { label: t("fx.rate"), value: `${iqdText(f, current)} ${arrow} ${iqdText(f, typed > 0 ? typed : null)}` },
          { label: t("impact.change"), value: pctText(f, changeBps, true), negative: (changeBps ?? 0) < 0 },
          { label: t("fx.sample", { amount: iqdText(f, SAMPLE_IQD) }), value: `${usd(current)} ${arrow} ${usd(typed > 0 ? typed : null)}` },
        ]}
        reason={{ minLength: 3, label: t("common.reason"), hint: t("fx.reasonHint") }}
        pending={fetcher.state !== "idle"}
        error={failed ? (failed.message ?? Object.values(failed.fields ?? {}).join(" ")) : undefined}
        onConfirm={({ reason }) => fetcher.submit({ intent: "set", iqdPerUnit: rate, source, effective: when === "now" ? "now" : at, reason, idempotencyKey: loaderData.formKey }, { method: "post" })}
      />
    </>
  );
}
