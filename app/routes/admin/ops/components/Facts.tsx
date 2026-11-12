/**
 * A free-form record (the counters a job reported, the numbers a check found) as a definition list: known keys get
 * their words, amounts (`…Iqd`) are money with the figure first, numbers are tabular, nested values are listed inside,
 * anything else is shown as written (left to right).
 */
import type { ReactNode } from "react";

import { useFormat } from "~/i18n/react";
import { detailLabel, isMoneyKey } from "./labels";
import { Code, Money, useOpsT } from "./ui";

function Value({ name, value, depth }: { name: string; value: unknown; depth: number }): ReactNode {
  const f = useFormat();
  const t = useOpsT();
  if (value === null || value === undefined) return <span className="text-ink-2">—</span>;
  if (typeof value === "number") return isMoneyKey(name) ? <Money iqd={value} /> : <bdi className="nums">{f.number(value)}</bdi>;
  if (typeof value === "boolean") return <span>{value ? t("common.yes") : t("common.no")}</span>;
  if (typeof value === "string") return <Code>{value}</Code>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-ink-2">—</span>;
    return <Code>{value.slice(0, 20).map((item) => (typeof item === "object" ? JSON.stringify(item) : String(item))).join(", ")}</Code>;
  }
  if (typeof value === "object" && depth < 3) return <Facts value={value as Record<string, unknown>} depth={depth + 1} />;
  return <Code>{JSON.stringify(value)}</Code>;
}

export function Facts({ value, depth = 0 }: { value: Record<string, unknown>; depth?: number }) {
  const t = useOpsT();
  const entries = Object.entries(value);
  if (entries.length === 0) return <span className="text-ink-2">—</span>;
  return (
    <dl className={depth === 0 ? "ops-facts adm-card type-data" : "ops-facts type-data"}>
      {entries.map(([name, item]) => (
        <div key={name} className="contents">
          <dt>{detailLabel(t, name)}</dt>
          <dd>
            <Value name={name} value={item} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
