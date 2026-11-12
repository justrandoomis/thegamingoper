/**
 * Words for the things this module shows by key — jobs, crons, consistency checks, detail keys — with a readable
 * fallback for anything added later (a job or a check the integration adds shows its key until it has words).
 */
import type { TFunction } from "~/i18n/translate";
import { keyLabel, tOr } from "./ui";

export const CRON_FREQUENT = "*/5 * * * *";
export const CRON_DAILY = "30 0 * * *";

export function jobName(t: TFunction, job: string): string {
  return tOr(t, `job.${job}.name`, keyLabel(job));
}

export function jobAbout(t: TFunction, job: string): string {
  return tOr(t, `job.${job}.about`, t("jobs.unknownAbout"));
}

export function cronLabel(t: TFunction, cron: string | null): string {
  if (cron === null) return t("jobs.notScheduled");
  if (cron === CRON_FREQUENT) return t("jobs.cron.frequent");
  if (cron === CRON_DAILY) return t("jobs.cron.daily");
  return t("jobs.cron.other", { cron });
}

export function checkTitle(t: TFunction, checkKey: string): string {
  return tOr(t, `check.${checkKey}.title`, keyLabel(checkKey));
}

/** What a check compares, why it matters, how to look into it — or the generic words for a check added later. */
export function checkText(t: TFunction, checkKey: string, part: "what" | "why" | "how"): string {
  return tOr(t, `check.${checkKey}.${part}`, t(`check.generic.${part}`));
}

export function detailLabel(t: TFunction, key: string): string {
  return tOr(t, `detail.${key}`, keyLabel(key));
}

/** Detail keys that hold an amount in IQD (`…Iqd`). */
export const isMoneyKey = (key: string) => /Iqd$/.test(key);
