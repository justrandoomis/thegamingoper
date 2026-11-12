/**
 * Form pieces shared by more than one page of module 15 (kept out of the route modules, so a page never imports another
 * page's loader or action).
 */
import { LEAVE_KIND_LIST } from "~/server/services/admin/staff/types";
import { Select, TextArea, TextField } from "~/ui/Field";
import { useStaffT } from "./ui";

/** The fields of a leave request (shared with /admin/staff/me). */
export function LeaveFields({ fields, today }: { fields: Record<string, string>; today: string }) {
  const t = useStaffT();
  return (
    <>
      <Select name="kind" label={t("leave.col.kind")} required defaultValue="annual" error={fields.kind} options={LEAVE_KIND_LIST.map((kind) => ({ value: kind, label: t(`leaveKind.${kind}`) }))} />
      <div className="grid grid-cols-2 gap-3">
        <TextField name="startsOn" type="date" label={t("leave.startsOn")} required defaultValue={today} ltr error={fields.startsOn} />
        <TextField name="endsOn" type="date" label={t("leave.endsOn")} required defaultValue={today} ltr error={fields.endsOn} />
      </div>
      <TextArea name="reason" label={t("leave.col.reason")} hint={t("leave.reasonHint")} maxLength={500} rows={2} error={fields.reason} />
    </>
  );
}
