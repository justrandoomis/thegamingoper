/**
 * The settings change log as an audit timeline (DESIGN.md §10: flat, one sentence per event — who did what to which
 * key — the time in tabular type, the reason, and the values before and after). No edit or delete affordance: the
 * trail is immutable.
 */
import { Link } from "react-router";

import type { ChangeLogRow } from "~/server/services/admin/settings/changes.server";
import type { SettingEditor } from "~/server/services/admin/settings/catalog";
import { Code, When, tOr, useModuleT } from "../../security/components/ui";
import { ValueView } from "./values";

export function ChangeLog({ rows, editor, keyLinks = false }: { rows: readonly ChangeLogRow[]; editor?: SettingEditor; keyLinks?: boolean }) {
  const t = useModuleT();
  if (rows.length === 0) return <p className="type-body text-ink-2">{t("log.empty")}</p>;
  return (
    <ol className="grid gap-2">
      {rows.map((row) => {
        const plain = !editor || !row.action.startsWith("settings.setting.") && !row.action.startsWith("settings.change.");
        return (
          <li key={row.id} className="grid gap-1 border-b border-line pb-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="type-strong">
                {tOr(t, `log.action.${row.action.replace(/\./g, "_")}`, row.action)}
                {keyLinks && row.key && row.label ? (
                  <>
                    {" · "}
                    <Link to={`/admin/settings/keys/${encodeURIComponent(row.key)}`} className="adm-link">
                      {row.label}
                    </Link>
                  </>
                ) : keyLinks && row.key ? (
                  <>
                    {" · "}
                    <Code>{row.key}</Code>
                  </>
                ) : null}
              </span>
              <span className="type-caption text-ink-2">
                {row.actor ?? "—"} · <When at={row.at} />
              </span>
            </div>
            {row.reason ? <p className="type-caption">{t("log.reason", { reason: row.reason })}</p> : null}
            {!plain && editor && (row.before !== null || row.after !== null) ? (
              <div className="grid gap-1 sm:grid-cols-2">
                <div className="grid gap-0.5">
                  <span className="type-caption text-ink-2">{t("log.before")}</span>
                  <ValueView editor={editor} value={row.before} t={t} />
                </div>
                <div className="grid gap-0.5">
                  <span className="type-caption text-ink-2">{t("log.after")}</span>
                  <ValueView editor={editor} value={row.after} t={t} />
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
