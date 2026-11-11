import { Form, Link } from "react-router";

import type { Route } from "./+types/changes";
import { listChanges, pendingChanges } from "~/server/services/admin/settings/changes.server";
import { parseChangeFilters } from "~/server/services/admin/settings/catalog";
import { SETTING_KEYS } from "~/server/settings.server";
import { Select } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { Status } from "~/ui/Tag";
import { Note, PageHead, Section, When, useModuleT } from "../security/components/ui";
import { settingsMeta } from "../security/meta";
import { ChangeLog } from "./components/log";
import { settingsKit } from "./settings.server";

/**
 * /admin/settings/changes — 22.06: the requests waiting for a second person (decided on each key's page) and the log
 * of every settings change — values, requests and decisions, custom fields, templates and policies — newest first,
 * filtered by key in the URL. It is the audit trail's "settings.*" part: nothing here can be edited or deleted.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await settingsKit.open(context, "settings.read");
  const filters = parseChangeFilters(new URL(request.url).searchParams);
  const [pending, log] = await Promise.all([settingsKit.orRespond(() => pendingChanges(db, actor, locale, now)), settingsKit.orRespond(() => listChanges(db, actor, filters, locale))]);
  return { pending, log, filters, keys: [...SETTING_KEYS] };
}

export const meta: Route.MetaFunction = (args) => settingsMeta(args, "changes.title");

export default function ChangesPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const { pending, log, filters, keys } = loaderData;
  return (
    <>
      <PageHead title={t("changes.title")} lead={t("changes.lead")} />

      <Section id="pending" title={t("changes.pending", { count: pending.length })}>
        {pending.length === 0 ? (
          <p className="type-body text-ink-2">{t("changes.noPending")}</p>
        ) : (
          <ul role="list" className="sec-decisions">
            {pending.map((change) => (
              <li key={change.id} className={change.canDecide ? "adm-card adm-card--act gap-1" : "adm-card gap-1"}>
                <Link to={`/admin/settings/keys/${encodeURIComponent(change.key)}#pending`} className="adm-link type-strong">
                  {change.label}
                </Link>
                <span className="type-caption">{t("key.pendingBy", { who: change.requestedBy.name ?? "—" })}</span>
                {change.reason ? <span className="type-caption text-ink-2">{t("key.because", { reason: change.reason })}</span> : null}
                <span className="flex flex-wrap items-center gap-2 type-caption text-ink-2">
                  <When at={change.requestedAt} />
                  {change.expired ? <Status tone="warn">{t("key.expired")}</Status> : change.canDecide ? <Status tone="info">{t("changes.yours")}</Status> : change.mine ? <Status tone="neutral">{t("changes.mine")}</Status> : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        <Note>
          <p>{t("changes.rules")}</p>
        </Note>
      </Section>

      <Section id="log" title={t("changes.log")} aside={<span className="type-caption text-ink-2">{t("changes.count", { count: log.total })}</span>}>
        <Form method="get" action="/admin/settings/changes" className="flex flex-wrap items-end gap-2">
          <Select name="key" label={t("changes.key")} defaultValue={filters.key ?? ""} options={[{ value: "", label: t("changes.allKeys") }, ...keys.map((key) => ({ value: key, label: key }))]} />
          <Key type="submit" size="sm" variant="ink" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
        <ChangeLog rows={log.rows} keyLinks />
        <Pagination page={log.page} pageCount={log.pageCount} href={(n) => `/admin/settings/changes?${new URLSearchParams({ ...(filters.key ? { key: filters.key } : {}), ...(n > 1 ? { page: String(n) } : {}) }).toString()}`} />
      </Section>
    </>
  );
}
