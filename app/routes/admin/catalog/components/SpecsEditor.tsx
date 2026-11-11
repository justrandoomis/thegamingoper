/**
 * The spec-sheet editor shared by products and device models: one compact row per spec (key, Arabic label and value)
 * with the English and Sorani translations folded into a native disclosure (still submitted with the form). Field
 * names follow the services' shape: specs.<i>.key, specs.<i>.label.<locale>, specs.<i>.value.<locale>.
 */
import { useEffect, useState } from "react";

import { Icon } from "~/art/Icon";
import type { L10n } from "~/lib/locales";
import { TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { useCatalogT } from "./ui";

export type SpecRowValue = { key: string; label: L10n; value: L10n };

let counter = 0;
const withKeys = (rows: readonly SpecRowValue[]) => rows.map((row) => ({ ...row, uid: `spec-${++counter}` }));

export function SpecsEditor({ rows, error, resetKey }: { rows: readonly SpecRowValue[]; error: (name: string) => string | undefined; resetKey?: string | number }) {
  const t = useCatalogT();
  const [specs, setSpecs] = useState(() => withKeys(rows));
  // A new version came back from the server: edit what it holds now.
  useEffect(() => {
    setSpecs(withKeys(rows));
  }, [resetKey]);
  return (
    <div className="grid gap-3">
      {specs.length === 0 ? <p className="type-caption text-ink-2">{t("editor.noSpecs")}</p> : null}
      <ol className="grid gap-3">
        {specs.map((spec, index) => (
          <li key={spec.uid} className="grid gap-2 border-b border-line pb-3">
            <div className="grid items-end gap-2 md:grid-cols-[10rem_minmax(0,1fr)_minmax(0,2fr)_auto]">
              <TextField name={`specs.${index}.key`} label={t("editor.specKey")} defaultValue={spec.key} ltr maxLength={48} error={error(`specs.${index}.key`)} />
              <TextField name={`specs.${index}.label.ar`} label={`${t("editor.specLabel")} · ${t("common.ar")}`} defaultValue={spec.label.ar} dir="rtl" error={error(`specs.${index}.label.ar`)} />
              <TextField name={`specs.${index}.value.ar`} label={`${t("editor.specValue")} · ${t("common.ar")}`} defaultValue={spec.value.ar} dir="rtl" maxLength={500} error={error(`specs.${index}.value.ar`)} />
              <IconKey icon="trash" label={`${t("editor.removeSpec")} ${spec.key}`} variant="quiet" onClick={() => setSpecs((current) => current.filter((row) => row.uid !== spec.uid))} />
            </div>
            <details className="group">
              <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1.5 type-caption text-ink-2 [&::-webkit-details-marker]:hidden">
                <Icon name="translate" size={16} />
                <span>
                  {t("common.en")} · {t("common.ckb")}
                </span>
                {!spec.label.en || !spec.value.en ? <span className="text-warn">•</span> : null}
                <Icon name="caret-down" size={14} className="group-open:rotate-180" />
              </summary>
              <div className="grid gap-2 pt-1 md:grid-cols-2">
                <TextField name={`specs.${index}.label.en`} label={`${t("editor.specLabel")} · ${t("common.en")}`} defaultValue={spec.label.en ?? ""} dir="ltr" />
                <TextField name={`specs.${index}.value.en`} label={`${t("editor.specValue")} · ${t("common.en")}`} defaultValue={spec.value.en ?? ""} dir="ltr" maxLength={500} />
                <TextField name={`specs.${index}.label.ckb`} label={`${t("editor.specLabel")} · ${t("common.ckb")}`} defaultValue={spec.label.ckb ?? ""} dir="rtl" />
                <TextField name={`specs.${index}.value.ckb`} label={`${t("editor.specValue")} · ${t("common.ckb")}`} defaultValue={spec.value.ckb ?? ""} dir="rtl" maxLength={500} />
              </div>
            </details>
          </li>
        ))}
      </ol>
      <div>
        <Key size="sm" icon="plus" onClick={() => setSpecs((current) => [...current, ...withKeys([{ key: "", label: { ar: "" }, value: { ar: "" } }])])}>
          {t("editor.addSpec")}
        </Key>
      </div>
    </div>
  );
}
