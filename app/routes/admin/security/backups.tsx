import { useState } from "react";
import { useFetcher } from "react-router";

import type { Route } from "./+types/backups";
import { useFormat } from "~/i18n/react";
import { backupsView, recordRestoreTest } from "~/server/services/admin/security/backups.server";
import { RESTORE_METHODS, RESTORE_RESULTS, RESTORE_TEST_INTERVAL_DAYS, TIME_TRAVEL_DAYS, baghdadDay } from "~/server/services/admin/security/types";
import { invalid } from "~/server/errors";
import { FieldGroup, Radio, Select, TextArea, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { Code, FormError, Note, PageHead, Pair, Section, When, failureText, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { newKey, ok, optional, text } from "./route-kit.server";
import { sec } from "./security.server";

/**
 * /admin/security/backups — 20.05 (security.backup.manage): the recovery plan as it really is — D1 Time Travel keeps
 * a point-in-time history on Cloudflare, restored by the owner or the lead with wrangler (never from here: there is no
 * "back up now"), uploaded files in KV have no such history — and the evidence: each restore test recorded with what
 * was restored, into what, how long it took, the result and what was checked (append-only, in the audit trail).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, now } = await sec.open(context, "security.backup.manage");
  return { view: await sec.orRespond(() => backupsView(db, actor, now)), key: newKey(), today: baghdadDay(now) };
}

export async function action({ request, context }: Route.ActionArgs) {
  const req = await sec.open(context, "security.backup.manage");
  const form = await request.formData();
  const intent = text(form, "intent");
  try {
    if (intent !== "restore-test") throw invalid({ intent: "invalid" });
    return ok(
      intent,
      await recordRestoreTest(
        req.db,
        req.actor,
        { testedOn: text(form, "testedOn"), method: text(form, "method"), pointInTime: optional(form, "pointInTime"), restoredTo: text(form, "restoredTo"), durationMinutes: text(form, "durationMinutes"), result: text(form, "result"), checks: text(form, "checks"), notes: optional(form, "notes"), idempotencyKey: text(form, "key") },
        req.now,
      ),
    );
  } catch (error) {
    return sec.failed(error, req.locale, intent);
  }
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "backups.title");

const PLAN_STEPS = ["decide", "info", "copy", "check", "restore", "files", "record"] as const;

const COMMANDS: Partial<Record<(typeof PLAN_STEPS)[number], string>> = {
  info: "npx wrangler d1 time-travel info tamtam-db --timestamp=2026-11-10T09:00:00+03:00",
  copy: ["npx wrangler d1 create tamtam-db-restore-test", "npx wrangler d1 export tamtam-db --remote --output=tamtam.sql", "npx wrangler d1 execute tamtam-db-restore-test --remote --file=tamtam.sql"].join("\n"),
  restore: ["npx wrangler d1 time-travel info tamtam-db", "npx wrangler d1 time-travel restore tamtam-db --bookmark=<bookmark>"].join("\n"),
};

export default function BackupsPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { view, key, today } = loaderData;
  const fetcher = useFetcher<{ ok: boolean; replayed?: boolean } & Record<string, unknown>>();
  const [result, setResult] = useState<(typeof RESTORE_RESULTS)[number]>("passed");
  const fields = fetcher.data && !fetcher.data.ok ? ((fetcher.data as { fields?: Record<string, string> }).fields ?? {}) : {};
  return (
    <>
      <PageHead title={t("backups.title")} lead={t("backups.lead", { days: TIME_TRAVEL_DAYS })} />

      <Section id="state" title={t("backups.state")}>
        <div className="sec-kpis">
          <div className="adm-card gap-1">
            <p className="type-caption text-ink-2">{t("backups.lastTest")}</p>
            <p className="type-kpi nums">{view.lastPassed ? <When at={Date.parse(`${view.lastPassed.testedOn}T12:00:00Z`)} kind="date" /> : "—"}</p>
            <Status tone={view.due ? "warn" : "ok"}>{view.due ? t("backups.due", { days: RESTORE_TEST_INTERVAL_DAYS }) : t("backups.notDue", { count: view.ageDays ?? 0 })}</Status>
          </div>
          <div className="adm-card gap-1">
            <p className="type-caption text-ink-2">{t("backups.history")}</p>
            <p className="type-kpi nums">{t("common.days", { count: TIME_TRAVEL_DAYS })}</p>
            <p className="type-caption text-ink-2">{t("backups.historyHint")}</p>
          </div>
          <div className="adm-card gap-1">
            <p className="type-caption text-ink-2">{t("backups.seal")}</p>
            <p className="type-kpi nums">{view.lastSeal ? <When at={view.lastSeal.at} kind="date" /> : "—"}</p>
            <p className="type-caption text-ink-2">{t("backups.sealHint")}</p>
          </div>
        </div>
        <Note tone="warn" icon="warning">
          <p>{t("backups.noButton")}</p>
          <p>{t("backups.kv")}</p>
        </Note>
      </Section>

      <Section id="plan" title={t("backups.plan")}>
        <ol className="grid list-decimal gap-2 ps-5 type-body">
          {PLAN_STEPS.map((step) => (
            <li key={step}>
              <span className="type-strong">{t(`backups.step.${step}.title`)}</span> — {t(`backups.step.${step}.text`)}
              {COMMANDS[step] ? (
                <pre className="sec-pre mt-1" dir="ltr">
                  {COMMANDS[step]}
                </pre>
              ) : null}
            </li>
          ))}
        </ol>
      </Section>

      <div className="sec-split">
        <Section id="tests" title={t("backups.tests", { count: view.tests.length })}>
          {view.tests.length === 0 ? (
            <p className="type-body text-ink-2">{t("backups.noTests")}</p>
          ) : (
            <ul role="list" className="grid gap-2">
              {view.tests.map((test) => (
                <li key={test.id} className="adm-card gap-1">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <span className="type-strong">
                      <When at={Date.parse(`${test.testedOn}T12:00:00Z`)} kind="date" /> · {t(`backups.method.${test.method}`)}
                    </span>
                    <Status tone={test.result === "passed" ? "ok" : "bad"}>{t(`backups.result.${test.result}`)}</Status>
                  </div>
                  <Pair label={t("backups.restoredTo")}>
                    <Code>{test.restoredTo}</Code>
                  </Pair>
                  {test.pointInTime ? (
                    <Pair label={t("backups.pointInTime")}>
                      <Code>{test.pointInTime}</Code>
                    </Pair>
                  ) : null}
                  <Pair label={t("backups.duration")}>{test.durationMinutes === null ? "—" : t("backups.minutes", { count: test.durationMinutes })}</Pair>
                  <p className="type-caption">{test.checks}</p>
                  {test.notes ? <p className="type-caption text-ink-2">{test.notes}</p> : null}
                  <p className="type-caption text-ink-2">
                    {test.by ?? "—"} · <When at={test.at} />
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section id="record" title={t("backups.record")}>
          <fetcher.Form method="post" className="adm-card grid gap-3" noValidate>
            <input type="hidden" name="intent" value="restore-test" />
            <input type="hidden" name="key" value={key} />
            <TextField name="testedOn" type="date" label={t("backups.testedOn")} defaultValue={today} max={today} required error={fields.testedOn} />
            <Select name="method" label={t("backups.methodLabel")} defaultValue="time_travel_new_db" options={RESTORE_METHODS.map((method) => ({ value: method, label: t(`backups.method.${method}`) }))} error={fields.method} />
            <TextField name="pointInTime" label={t("backups.pointInTime")} hint={t("backups.pointHint")} ltr optional error={fields.pointInTime} />
            <TextField name="restoredTo" label={t("backups.restoredTo")} hint={t("backups.restoredHint")} ltr required error={fields.restoredTo} />
            <TextField name="durationMinutes" label={t("backups.duration")} inputMode="numeric" optional error={fields.durationMinutes} />
            <FieldGroup legend={t("backups.resultLabel")}>
              {RESTORE_RESULTS.map((value) => (
                <Radio key={value} row name="result" value={value} label={t(`backups.result.${value}`)} checked={result === value} onChange={() => setResult(value)} />
              ))}
            </FieldGroup>
            <TextArea name="checks" label={t("backups.checks")} hint={t("backups.checksHint")} required rows={4} error={fields.checks} />
            <TextArea name="notes" label={t("backups.notes")} optional rows={2} error={fields.notes} />
            <FormError message={fetcher.data && !fetcher.data.ok && !Object.keys(fields).length ? failureText(t, fetcher.data) : null} />
            {fetcher.data?.ok ? (
              <p role="status" className="type-label text-ok">
                {fetcher.data.replayed ? t("backups.recordedAgain") : t("backups.recorded")}
              </p>
            ) : null}
            <div>
              <Key type="submit" size="sm" variant="ink" icon="floppy-disk" loading={fetcher.state !== "idle"}>
                {t("backups.save")}
              </Key>
            </div>
            <p className="type-caption text-ink-2">{t("backups.saveNote", { count: f.number(RESTORE_TEST_INTERVAL_DAYS) })}</p>
          </fetcher.Form>
        </Section>
      </div>
    </>
  );
}
