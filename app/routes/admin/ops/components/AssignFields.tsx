/**
 * The fields of "give it to a person" (findings): who — only employees who may read the findings — and an optional
 * day it should be looked at by (from today; the task is due at the end of that day, Iraq time).
 */
import type { Person } from "~/server/services/admin/ops/types";
import { Select, TextField } from "~/ui/Field";
import { useOpsT } from "./ui";

export function AssignFields({ people, assignee, onAssignee, dueDay, onDueDay, today }: { people: readonly Person[]; assignee: string; onAssignee: (id: string) => void; dueDay: string; onDueDay: (day: string) => void; today: string }) {
  const t = useOpsT();
  return (
    <div className="grid gap-3">
      <Select
        label={t("assign.person")}
        hint={t("assign.personHint")}
        required
        value={assignee}
        onChange={(event) => onAssignee(event.target.value)}
        options={[{ value: "", label: t("assign.pick") }, ...people.map((person) => ({ value: person.id, label: person.name }))]}
      />
      <TextField type="date" label={t("assign.due")} hint={t("assign.dueHint")} optional ltr min={today} value={dueDay} onChange={(event) => onDueDay(event.target.value)} />
    </div>
  );
}
