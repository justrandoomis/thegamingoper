import { Form, Link } from "react-router";

import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { useChT } from "./ui";

export type RangeView = { period: string | null; from: string; to: string; demo: boolean };

/**
 * The period of a report in the URL (?period=YYYY-MM or ?from=&to=, &demo=1): a month list, two Baghdad days, and
 * whether demo rows count (they never count by default — docs/metrics.md §1). Works without JavaScript.
 */
export function RangeForm({ range, months, path }: { range: RangeView; months: string[]; path: string }) {
  const t = useChT();
  return (
    <Form method="get" className="ch-filters ch-noprint" preventScrollReset>
      <Select name="period" label={t("range.month")} defaultValue={range.period ?? ""} options={[{ value: "", label: t("range.custom") }, ...months.map((month) => ({ value: month, label: month }))]} />
      <TextField name="from" type="date" label={t("range.from")} ltr defaultValue={range.from} />
      <TextField name="to" type="date" label={t("range.to")} ltr defaultValue={range.to} />
      <Checkbox name="demo" value="1" label={t("range.demo")} defaultChecked={range.demo} />
      <div>
        <Key type="submit" icon="funnel">
          {t("common.apply")}
        </Key>
        <Key as={Link} to={path} variant="ghost">
          {t("range.thisMonth")}
        </Key>
      </div>
    </Form>
  );
}

/** The last twelve months, newest first ("2026-11", "2026-10", …), from a Baghdad month. */
export function lastMonths(current: string, count = 12): string[] {
  const [year, month] = current.split("-").map(Number);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const date = new Date(Date.UTC(year, month - 1 - i, 1));
    out.push(date.toISOString().slice(0, 7));
  }
  return out;
}
