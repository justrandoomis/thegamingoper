/**
 * The price-list form (create and edit): code, names, the three scopes (channel, branch, customer segment — empty
 * means "everyone"), priority, an optional window in Baghdad time and the active switch. The confirmation and the
 * reason come from the page's ConfirmDialog.
 */
import type { ListOptions } from "~/server/services/admin/pricing/lists.server";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { usePricingT } from "./shared";

export type ListFormValues = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  channel: string;
  branchId: string;
  segmentId: string;
  priority: string;
  startsOn: string;
  endsOn: string;
  isActive: boolean;
  expectedUpdatedAt: string;
};

export const emptyListForm: ListFormValues = { id: "", code: "", nameAr: "", nameEn: "", channel: "", branchId: "", segmentId: "", priority: "0", startsOn: "", endsOn: "", isActive: true, expectedUpdatedAt: "" };

export const LIST_STATE_TONE = { active: "ok", scheduled: "info", ended: "neutral", inactive: "neutral" } as const;

/** "YYYY-MM-DDTHH:mm" in Baghdad for a datetime-local input. */
export function baghdadInput(at: number | null): string {
  if (at === null) return "";
  return new Date(at + 3 * 3600_000).toISOString().slice(0, 16);
}

export function ListForm({
  values,
  onChange,
  options,
  errors,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  values: ListFormValues;
  onChange: (values: ListFormValues) => void;
  options: ListOptions;
  errors?: Record<string, string>;
  onSubmit: () => void;
  onCancel?: () => void;
  submitLabel: string;
}) {
  const t = usePricingT();
  const set = (key: keyof ListFormValues) => (event: { currentTarget: { value: string } }) => onChange({ ...values, [key]: event.currentTarget.value });
  const any = { value: "", label: t("lists.any") };
  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label={t("lists.code")} ltr value={values.code} onChange={set("code")} required hint={t("lists.codeHint")} error={errors?.code} maxLength={32} />
        <TextField label={t("lists.nameAr")} value={values.nameAr} onChange={set("nameAr")} required error={errors?.nameAr} maxLength={80} />
        <TextField label={t("lists.nameEn")} ltr value={values.nameEn} onChange={set("nameEn")} optional error={errors?.nameEn} maxLength={80} />
        <Select label={t("lists.channel")} value={values.channel} onChange={set("channel")} options={[any, ...options.channels]} error={errors?.channel} />
        <Select label={t("lists.branch")} value={values.branchId} onChange={set("branchId")} options={[any, ...options.branches]} error={errors?.branchId} hint={options.branches.length === 0 ? t("lists.noBranches") : undefined} />
        <Select label={t("lists.segment")} value={values.segmentId} onChange={set("segmentId")} options={[any, ...options.segments]} error={errors?.segmentId} hint={options.segments.length === 0 ? t("lists.noSegments") : undefined} />
        <TextField label={t("lists.priority")} inputMode="numeric" ltr value={values.priority} onChange={set("priority")} hint={t("lists.priorityHint")} error={errors?.priority} />
        <TextField label={t("lists.startsOn")} type="datetime-local" ltr value={values.startsOn} onChange={set("startsOn")} optional error={errors?.startsOn} />
        <TextField label={t("lists.endsOn")} type="datetime-local" ltr value={values.endsOn} onChange={set("endsOn")} optional error={errors?.endsOn} />
      </div>
      <Checkbox label={t("lists.active")} checked={values.isActive} onChange={(event) => onChange({ ...values, isActive: event.currentTarget.checked })} />
      <div className="flex flex-wrap gap-2">
        <Key type="submit" variant="ink" disabled={values.code.trim().length < 2 || values.nameAr.trim().length < 2}>
          {submitLabel}
        </Key>
        {onCancel ? (
          <Key variant="quiet" onClick={onCancel}>
            {t("common.cancel")}
          </Key>
        ) : null}
      </div>
    </form>
  );
}
