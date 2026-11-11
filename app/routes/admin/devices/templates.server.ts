/**
 * The checklist editor's form reader (/admin/devices/templates?kind=…), kept apart from the route module so tests can
 * call it. Rows are i.<n>.* fields; a row is dropped when "keep" is unticked or it is a blank new row; the position
 * orders them — typed with Latin, Arabic-Indic or Persian digits (an Arabic keyboard types "٣").
 */
import { MAX_TEMPLATE_ITEMS, NEW_TEMPLATE_ROWS, parseWhole } from "~/server/services/admin/devices/types";
import { text } from "./devices.server";

export type TemplateRow = { key: string; label: { ar: string; en: string; ckb: string }; hint: { ar: string; en: string; ckb: string }; input: string; required: boolean; critical: boolean };

export function templateItemsFrom(form: FormData): TemplateRow[] {
  const rows: (TemplateRow & { position: number; index: number })[] = [];
  for (let index = 0; index < MAX_TEMPLATE_ITEMS + NEW_TEMPLATE_ROWS; index++) {
    const key = text(form, `i.${index}.key`);
    const ar = text(form, `i.${index}.ar`);
    const en = text(form, `i.${index}.en`);
    const present = form.has(`i.${index}.key`);
    if (!present) continue;
    const isNew = text(form, `i.${index}.new`) === "1";
    const keep = form.get(`i.${index}.keep`) === "on";
    if (!isNew && !keep) continue;
    if (isNew && !key && !ar && !en) continue;
    const typed = parseWhole(text(form, `i.${index}.position`));
    const position = typeof typed === "number" && Number.isSafeInteger(typed) && typed > 0 ? typed : index + 1;
    rows.push({
      key,
      label: { ar, en, ckb: text(form, `i.${index}.ckb`) },
      hint: { ar: text(form, `i.${index}.hintAr`), en: text(form, `i.${index}.hintEn`), ckb: "" },
      input: text(form, `i.${index}.input`) || "pass_fail",
      required: form.get(`i.${index}.required`) === "on",
      critical: form.get(`i.${index}.critical`) === "on",
      position,
      index,
    });
  }
  // Equal positions keep the form's order.
  return rows.sort((a, b) => a.position - b.position || a.index - b.index).map(({ position: _position, index: _index, ...row }) => row);
}
