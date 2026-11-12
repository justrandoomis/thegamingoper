/**
 * How a setting's value reads and how it is typed, from its editor spec (catalog.ts): whole numbers with their unit
 * (dinars figure-first, minutes, hours, days), a percentage stored as basis points, switches, texts (numbers and links
 * left to right), texts in three languages, and objects of those. Every typed number accepts Arabic-Indic and Persian
 * digits; a fraction or a stray mark is an error, never a different number.
 */
import type { TFunction } from "~/i18n/translate";
import { parsePercentBps, parseWhole, type FieldSpec, type ObjectField, type SettingEditor } from "~/server/services/admin/settings/catalog";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Status } from "~/ui/Tag";
import { Money, digitsOnly } from "../../security/components/ui";

type Bag = Record<string, unknown>;

/** locale.numbering is { ar, en, ckb }: shown under the field names its view uses. */
export const numberingBag = (value: unknown) => Object.fromEntries(Object.entries((value ?? {}) as Bag).map(([code, item]) => [`numbering_${code}`, item]));

export function unitText(t: TFunction, spec: FieldSpec, value: number): string {
  if (spec.kind === "bps") return `${(value / 100).toLocaleString("en", { maximumFractionDigits: 2 })}%`;
  if (spec.kind === "int" && spec.unit !== "iqd") return t(`unit.${spec.unit}`, { count: value });
  return String(value);
}

/** One scalar value as it reads. */
export function ScalarView({ spec, value, t }: { spec: FieldSpec; value: unknown; t: TFunction }) {
  if (value === undefined || value === null || value === "") return <span className="text-ink-2">{t("value.empty")}</span>;
  switch (spec.kind) {
    case "int":
      return spec.unit === "iqd" ? <Money iqd={Number(value)} /> : <bdi className="nums">{t(`unit.${spec.unit}`, { count: Number(value) })}</bdi>;
    case "bps":
      return <bdi className="nums" dir="ltr">{`${(Number(value) / 100).toLocaleString("en", { maximumFractionDigits: 2 })}%`}</bdi>;
    case "bool":
      return <Status tone={value ? "ok" : "neutral"}>{value ? t("value.on") : t("value.off")}</Status>;
    case "l10n": {
      const text = value as { ar?: string; en?: string; ckb?: string };
      return (
        <span className="grid">
          <span>{text.ar}</span>
          {text.en ? <bdi dir="ltr" className="type-caption text-ink-2">{text.en}</bdi> : null}
        </span>
      );
    }
    case "text":
      return spec.ltr ? <bdi dir="ltr" className="nums break-all">{String(value)}</bdi> : <span>{String(value)}</span>;
    case "select":
      return <span>{String(value)}</span>;
    default:
      return <span>{String(value)}</span>;
  }
}

/** A whole value (scalar or object) as rows of label → value. */
export function ValueView({ editor, value, t }: { editor: SettingEditor; value: unknown; t: TFunction }) {
  if (editor.kind === "value") return <ScalarView spec={editor.field} value={value} t={t} />;
  if (editor.kind === "object") {
    const bag = (value ?? {}) as Bag;
    return (
      <dl className="sec-kv type-data">
        {editor.fields.map((field) => (
          <div key={field.name} className="contents">
            <dt>{t(`prop.${field.name}`)}</dt>
            <dd>
              <ScalarView spec={field.field} value={bag[field.name]} t={t} />
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  return <span className="break-all">{typeof value === "object" ? JSON.stringify(value) : String(value)}</span>;
}

/** What the form holds while a person types: strings and booleans, per field name ("address.ar" for a language). */
export type Draft = Record<string, string | boolean>;

export function draftOf(editor: SettingEditor, value: unknown): Draft {
  const draft: Draft = {};
  const put = (name: string, spec: FieldSpec, item: unknown) => {
    if (spec.kind === "bool") draft[name] = Boolean(item);
    else if (spec.kind === "l10n") {
      const text = (item ?? {}) as { ar?: string; en?: string; ckb?: string };
      draft[`${name}.ar`] = text.ar ?? "";
      draft[`${name}.en`] = text.en ?? "";
      draft[`${name}.ckb`] = text.ckb ?? "";
    } else if (spec.kind === "bps") draft[name] = item === undefined || item === null ? "" : String(Number(item) / 100);
    else draft[name] = item === undefined || item === null ? "" : String(item);
  };
  if (editor.kind === "value") put("value", editor.field, value);
  if (editor.kind === "object") for (const field of editor.fields) put(field.name, field.field, ((value ?? {}) as Bag)[field.name]);
  return draft;
}

/** The value a draft makes, and the fields that cannot be read (shown under each field before anything is sent). */
export function valueOf(editor: SettingEditor, draft: Draft): { value: unknown; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const read = (name: string, spec: FieldSpec, optional: boolean): unknown => {
    if (spec.kind === "bool") return Boolean(draft[name]);
    if (spec.kind === "l10n") {
      const ar = String(draft[`${name}.ar`] ?? "").trim();
      const en = String(draft[`${name}.en`] ?? "").trim();
      const ckb = String(draft[`${name}.ckb`] ?? "").trim();
      if (!ar) {
        if (en || ckb) errors[`${name}.ar`] = "required";
        return undefined;
      }
      return { ar, ...(en ? { en } : {}), ...(ckb ? { ckb } : {}) };
    }
    const text = String(draft[name] ?? "").trim();
    if (spec.kind === "int") {
      const number = parseWhole(text);
      if (number === undefined) {
        if (!optional) errors[name] = "required";
        return undefined;
      }
      if (Number.isNaN(number)) errors[name] = "whole_number";
      else if (number < spec.min) errors[name] = "too_small";
      else if (number > spec.max) errors[name] = "too_big";
      else if (spec.step && number % spec.step !== 0) errors[name] = `step_${spec.step}`;
      return number;
    }
    if (spec.kind === "bps") {
      const bps = parsePercentBps(text);
      if (bps === undefined) {
        errors[name] = "required";
        return undefined;
      }
      if (Number.isNaN(bps)) errors[name] = "percent_invalid";
      else if (bps < spec.min) errors[name] = "too_small";
      else if (bps > spec.max) errors[name] = "too_big";
      return bps;
    }
    if (text === "") {
      if (!optional) errors[name] = "required";
      return undefined;
    }
    return text;
  };
  if (editor.kind === "value") return { value: read("value", editor.field, false), errors };
  if (editor.kind === "object") {
    const out: Bag = {};
    for (const field of editor.fields) {
      const item = read(field.name, field.field, Boolean(field.optional));
      if (item !== undefined) out[field.name] = item;
    }
    // the rules between fields (catalog ObjectChecks — the schema's own), on fields that read as numbers
    const numberOf = (name: string) => (errors[name] === undefined && typeof out[name] === "number" ? (out[name] as number) : null);
    for (const names of editor.checks?.ascending ?? []) {
      for (let index = 1; index < names.length; index++) {
        const before = numberOf(names[index - 1]);
        const current = numberOf(names[index]);
        if (before !== null && current !== null && current <= before) errors[names[index]] = "not_ascending";
      }
    }
    for (const [name, floor] of editor.checks?.notBelow ?? []) {
      const value = numberOf(name);
      const least = numberOf(floor);
      if (value !== null && least !== null && value < least) errors[name] = "below_paired";
    }
    return { value: out, errors };
  }
  return { value: undefined, errors };
}

function FieldInput({ name, spec, label, draft, setDraft, error, optional, t }: { name: string; spec: FieldSpec; label: string; draft: Draft; setDraft: (patch: Draft) => void; error?: string; optional?: boolean; t: TFunction }) {
  const errorText = (key: string | undefined) => (key ? t(`errors.${key}`) : undefined);
  switch (spec.kind) {
    case "bool":
      return <Checkbox label={label} checked={Boolean(draft[name])} onChange={(event) => setDraft({ [name]: event.currentTarget.checked })} />;
    case "l10n":
      return (
        <fieldset className="grid gap-2 sm:grid-cols-3">
          <legend className="type-label">{label}</legend>
          {(["ar", "en", "ckb"] as const).map((code) => (
            <TextField key={code} label={t(`lang.${code}`)} value={String(draft[`${name}.${code}`] ?? "")} onChange={(event) => setDraft({ [`${name}.${code}`]: event.currentTarget.value })} maxLength={spec.max} optional={code !== "ar" || optional} error={errorText(code === "ar" ? error : undefined)} />
          ))}
        </fieldset>
      );
    case "int":
      return (
        <TextField
          label={label}
          inputMode="numeric"
          value={String(draft[name] ?? "")}
          onChange={(event) => setDraft({ [name]: digitsOnly(event.currentTarget.value) })}
          hint={t("value.range", { min: spec.unit === "iqd" ? spec.min.toLocaleString("en") : spec.min, max: spec.unit === "iqd" ? spec.max.toLocaleString("en") : spec.max, unit: t(`unitName.${spec.unit}`) })}
          optional={optional}
          error={errorText(error)}
        />
      );
    case "bps":
      return <TextField label={label} inputMode="decimal" value={String(draft[name] ?? "")} onChange={(event) => setDraft({ [name]: event.currentTarget.value })} end={<span className="type-caption">%</span>} hint={t("value.percentRange", { max: spec.max / 100 })} error={errorText(error)} />;
    case "select":
      return <Select label={label} value={String(draft[name] ?? "")} onChange={(event) => setDraft({ [name]: event.currentTarget.value })} options={spec.options.map((option) => ({ value: option, label: option }))} />;
    default:
      return <TextField label={label} type={spec.input === "tel" ? "tel" : spec.input === "email" ? "email" : spec.input === "url" ? "url" : "text"} ltr={spec.ltr} value={String(draft[name] ?? "")} onChange={(event) => setDraft({ [name]: event.currentTarget.value })} maxLength={spec.max} optional={optional} error={errorText(error)} />;
  }
}

/** The form fields of a key's editor. */
export function EditorFields({ editor, draft, setDraft, errors, t }: { editor: SettingEditor; draft: Draft; setDraft: (patch: Draft) => void; errors: Record<string, string>; t: TFunction }) {
  if (editor.kind === "value") return <FieldInput name="value" spec={editor.field} label={t("value.new")} draft={draft} setDraft={setDraft} error={errors.value} t={t} />;
  if (editor.kind !== "object") return null;
  return (
    <div className="grid gap-3">
      {editor.fields.map((field: ObjectField) => (
        <FieldInput key={field.name} name={field.name} spec={field.field} label={t(`prop.${field.name}`)} draft={draft} setDraft={setDraft} error={errors[field.name] ?? errors[`${field.name}.ar`]} optional={field.optional} t={t} />
      ))}
    </div>
  );
}

/**
 * Before → after rows of what a change alters, for the confirm dialog. `beforeText` replaces every "before" (a stored
 * value that no longer fits is shown as broken, never as a value).
 */
export function changeRows(editor: SettingEditor, before: unknown, after: unknown, t: TFunction, arrow: string, options: { beforeText?: string } = {}): { label: string; value: string }[] {
  const text = (spec: FieldSpec, value: unknown): string => {
    if (value === undefined || value === null || value === "") return t("value.empty");
    if (spec.kind === "bool") return value ? t("value.on") : t("value.off");
    if (spec.kind === "int") return spec.unit === "iqd" ? `${Number(value).toLocaleString("en")} ${t("unitName.iqd")}` : t(`unit.${spec.unit}`, { count: Number(value) });
    if (spec.kind === "bps") return `${(Number(value) / 100).toLocaleString("en", { maximumFractionDigits: 2 })}%`;
    if (spec.kind === "l10n") return (value as { ar?: string }).ar ?? "";
    return String(value);
  };
  const was = (spec: FieldSpec, value: unknown) => options.beforeText ?? text(spec, value);
  if (editor.kind === "value") {
    // nothing changed: no row, so the form's key stays off (it used to offer "X → X", which the server refused)
    if (options.beforeText === undefined && JSON.stringify(before ?? null) === JSON.stringify(after ?? null)) return [];
    return [{ label: t("value.value"), value: `${was(editor.field, before)} ${arrow} ${text(editor.field, after)}` }];
  }
  if (editor.kind !== "object") return [];
  const a = (before ?? {}) as Bag;
  const b = (after ?? {}) as Bag;
  return editor.fields
    .filter((field) => options.beforeText !== undefined || JSON.stringify(a[field.name] ?? null) !== JSON.stringify(b[field.name] ?? null))
    .map((field) => ({ label: t(`prop.${field.name}`), value: `${was(field.field, a[field.name])} ${arrow} ${text(field.field, b[field.name])}` }));
}
