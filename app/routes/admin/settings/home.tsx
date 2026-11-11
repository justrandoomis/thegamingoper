import { Link } from "react-router";

import type { Route } from "./+types/home";
import { listSettingItems, type SettingItem } from "~/server/services/admin/settings/changes.server";
import { SETTING_GROUP_ORDER, viewOf } from "~/server/services/admin/settings/catalog";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ModuleFunctions } from "../blueprint-status";
import { DecisionCard, Note, PageHead, Section, When, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { ValueView, numberingBag } from "./components/values";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings — the module's front page: every store setting by group with its value in force, who changed it last
 * and when, how this employee may change it (directly, as a request a second person decides, in another module, or not
 * at all), the requests waiting for a decision, and the status of the six blueprint functions.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await settingsKit.open(context, "settings.read");
  return { items: await settingsKit.orRespond(() => listSettingItems(db, actor, locale, now)) };
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, null);

function Item({ item }: { item: SettingItem }) {
  const t = useModuleT();
  const href = `/admin/settings/keys/${encodeURIComponent(item.key)}`;
  return (
    <li className="adm-card gap-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <Link to={href} className="adm-link type-strong min-w-0">
          {item.label}
        </Link>
        <span className="flex flex-wrap gap-1">
          {item.pending ? <Status tone="warn">{t("home.pending")}</Status> : null}
          {item.editor.kind === "linked" ? <Status tone="info">{t("home.elsewhere")}</Status> : null}
          {item.editor.kind === "unused" ? <Status tone="neutral">{t("home.unused")}</Status> : null}
          {item.approver ? <Status tone="info">{t("home.control")}</Status> : null}
          {item.isDefault ? <Status tone="neutral">{t("home.default")}</Status> : null}
        </span>
      </div>
      <div className="type-body">
        {/* a stored value that no longer fits is said so, never shown as an empty or default value */}
        {item.broken !== null ? <Status tone="bad">{t("home.broken")}</Status> : <ValueView editor={viewOf(item.key, item.editor)} value={item.key === "locale.numbering" ? numberingBag(item.value) : item.value} t={t} />}
      </div>
      <p className="type-caption text-ink-2">{t(`help.${item.key.replace(/\./g, "_")}`)}</p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="type-caption text-ink-2">{item.updatedAt ? t("home.changed", { who: item.updatedBy ?? t("home.someone") }) : t("home.neverChanged")} {item.updatedAt ? <When at={item.updatedAt} /> : null}</span>
        {item.editor.kind === "linked" ? (
          <Key as={Link} to={item.editor.href} size="sm" iconEnd="arrow-right">
            {t(`home.editIn.${item.editor.module}`)}
          </Key>
        ) : item.canEdit ? (
          <Key as={Link} to={href} size="sm" icon="pencil-simple">
            {item.needsApproval ? t("home.request") : t("home.change")}
          </Key>
        ) : (
          <Link to={href} className="adm-link type-label">
            {t("home.view")}
          </Link>
        )}
      </div>
    </li>
  );
}

export default function SettingsHome({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const { items } = loaderData;
  const pending = items.filter((item) => item.pending);
  const decidable = pending.filter((item) => item.pending?.canDecide);
  const groups = SETTING_GROUP_ORDER.map((group) => ({ group, items: items.filter((item) => item.group === group) })).filter((entry) => entry.items.length > 0);
  return (
    <>
      <PageHead eyebrow={t("home.eyebrow")} title={t("home.title")} lead={t("home.lead")} />

      <Section id="waiting" title={t("home.waiting")}>
        {decidable.length ? (
          <ul role="list" className="sec-decisions">
            <DecisionCard icon="scales" title={t("home.decide.title")} count={decidable.length} text={t("home.decide.text")} to="/admin/settings/changes" action={t("home.decide.action")} />
          </ul>
        ) : pending.length ? (
          <p className="type-body text-ink-2">{t("home.pendingOthers", { count: pending.length })}</p>
        ) : (
          <p className="type-body text-ink-2">{t("home.nothingWaiting")}</p>
        )}
      </Section>

      <Note>
        <p>{t("home.rules")}</p>
      </Note>

      {groups.map((entry) => (
        <Section key={entry.group} id={`group-${entry.group}`} title={t(`group.${entry.group}`)}>
          <ul role="list" className="grid gap-3 lg:grid-cols-2">
            {entry.items.map((item) => (
              <Item key={item.key} item={item} />
            ))}
          </ul>
        </Section>
      ))}

      <ModuleFunctions moduleId="22" />
    </>
  );
}
