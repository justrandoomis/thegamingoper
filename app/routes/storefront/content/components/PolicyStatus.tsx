import { useFormat, useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { Status } from "~/ui/Tag";

/**
 * The one status line of a policy (Design System v2 §6.15, §9): «● نسخة أولى — قد تتغيّر قبل الإطلاق.» while the text is
 * the code draft (`approved` false: a warn dot and words, never colour alone), then «آخر تحديث 11 تشرين الثاني 2026»
 * (a long date, day first, Iraqi month names). Approved text shows the date alone.
 */
export function PolicyStatus({ approved, updatedAt, className }: { approved: boolean; updatedAt: number | null; className?: string }) {
  const t = useT("content");
  const f = useFormat();
  if (approved && !updatedAt) return null;
  // the sentence around the date, so the date can be a <time> wherever a language puts it
  const [before = "", after = ""] = t("common.updated", { date: "\u0000" }).split("\u0000");
  return (
    <p className={cx("cstatus", className)}>
      {approved ? null : <Status tone="warn">{t("common.statusDraft")}</Status>}
      {!approved && updatedAt ? (
        <span className="cstatus__sep" aria-hidden="true">
          ·
        </span>
      ) : null}
      {updatedAt ? (
        <span className="nums">
          {before}
          <time dateTime={iraqDay(updatedAt)}>{f.date(updatedAt, "long")}</time>
          {after}
        </span>
      ) : null}
    </p>
  );
}

/** "2026-11-11": the calendar day in Iraq (UTC+3, no daylight saving), the day the long date shows. */
function iraqDay(at: number): string {
  return new Date(at + 3 * 3_600_000).toISOString().slice(0, 10);
}
