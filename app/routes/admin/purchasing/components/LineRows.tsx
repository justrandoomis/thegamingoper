/**
 * Repeated line rows of a document form (order, request for quotation, claim): each row's inputs are named
 * `<prefix>.<i>.<field>`, so the form works without JavaScript (the server renders enough rows and reads them with
 * `rows()` in purchasing.server.ts). With JavaScript a key adds another empty row. The SKU field takes a typed code or
 * a scanner's keyboard input; Enter in it moves to the next field instead of sending the form.
 */
import { useState, type KeyboardEvent, type ReactNode } from "react";

import { TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { usePurT } from "./kit";

export type RowField = {
  name: string;
  label: string;
  /** Width class on wide screens (the code column is wider). */
  wide?: boolean;
  numeric?: boolean;
  ltr?: boolean;
  hint?: string;
};

export function LineRows({
  prefix = "lines",
  fields,
  initial,
  minRows = 3,
  max = 100,
  errors,
  legend,
  extra,
}: {
  prefix?: string;
  fields: readonly RowField[];
  /** Values of the rows already filled in. */
  initial: readonly Record<string, string>[];
  minRows?: number;
  max?: number;
  /** Field errors keyed `<prefix>.<i>.<field>` (translated sentences). */
  errors?: Record<string, string> | null;
  legend: string;
  /** Something after the rows (a running total). */
  extra?: ReactNode;
}) {
  const t = usePurT();
  const [count, setCount] = useState(Math.max(minRows, initial.length + 1));
  const onEnter = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const inputs = [...(event.currentTarget.form?.querySelectorAll<HTMLInputElement>("input[data-line-field]") ?? [])];
    const next = inputs[inputs.indexOf(event.currentTarget) + 1];
    next?.focus();
  };
  return (
    <fieldset className="grid gap-3">
      <legend className="type-label text-ink">{legend}</legend>
      <ol className="grid gap-3">
        {Array.from({ length: count }, (_, index) => (
          <li key={index} className={index > 0 ? "pur-line pur-line--more grid gap-2 rounded-xs p-2 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]" : "pur-line grid gap-2 rounded-xs p-2 sm:grid-cols-[repeat(auto-fit,minmax(9rem,1fr))]"}>
            <span className="type-caption text-ink-2 sm:hidden">{t("common.lineN", { n: index + 1 })}</span>
            {fields.map((field) => {
              const name = `${prefix}.${index}.${field.name}`;
              return (
                <TextField
                  key={field.name}
                  name={name}
                  label={field.label}
                  aria-label={`${field.label} · ${t("common.lineN", { n: index + 1 })}`}
                  defaultValue={initial[index]?.[field.name] ?? ""}
                  inputMode={field.numeric ? "decimal" : undefined}
                  ltr={field.ltr || field.numeric}
                  autoComplete="off"
                  spellCheck={false}
                  data-line-field=""
                  onKeyDown={onEnter}
                  error={errors?.[name]}
                  className={field.wide ? "sm:col-span-2" : undefined}
                />
              );
            })}
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-3">
        {count < max ? (
          <Key size="sm" icon="plus" onClick={() => setCount((value) => Math.min(max, value + 1))}>
            {t("common.addLine")}
          </Key>
        ) : null}
        {extra}
      </div>
    </fieldset>
  );
}
