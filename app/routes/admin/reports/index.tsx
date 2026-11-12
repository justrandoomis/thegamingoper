import { Link } from "react-router";

import type { Route } from "./+types/index";
import { Icon, type IconName } from "~/art/Icon";
import { listSavedReports } from "~/server/services/admin/reports/saved.server";
import { reportsAccess } from "~/server/services/admin/reports/shared.server";
import { REPORT_FUNCTION, REPORT_KEYS, REPORT_PATH, type ReportKey } from "~/server/services/admin/reports/types";
import { EmptyState } from "~/ui/EmptyState";
import { TextLink } from "~/ui/TextLink";
import { ModuleFunctions } from "../blueprint-status";
import { reportsMeta } from "./meta";
import { openReports } from "./reports.server";
import { Code, isolated, Name, Note, PageHead, Section, When, useRepT } from "./ui";

/**
 * /admin/reports — the module's front page: the reports this employee may open (each with the blueprint function it
 * implements), their saved reports and those shared with them, the metrics dictionary, the honest limits (scheduled
 * delivery needs an e-mail provider), and the status of the module's functions. Nothing is computed here.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await openReports(context);
  const access = reportsAccess(actor);
  const saved = await listSavedReports(db, actor, { limit: 8 });
  return { access, saved };
}

export const meta: Route.MetaFunction = (args) => reportsMeta(args, null);

const ICONS: Record<ReportKey, IconName> = { sales: "chart-line", margin: "coins", inventory: "package", customers: "users", performance: "pulse" };

export default function ReportsHome({ loaderData }: Route.ComponentProps) {
  const t = useRepT();
  const { access, saved } = loaderData;
  const open = REPORT_KEYS.filter((key) => access.reports[key]);
  return (
    <>
      <PageHead eyebrow={t("home.eyebrow")} title={t("home.title")} lead={t("home.lead")} />
      {!access.wholeCompany ? (
        <Note icon="lock" tone="warn">
          <p>{t("common.branchLimited")}</p>
        </Note>
      ) : null}

      <Section id="reports-list" title={t("home.reports")}>
        {/* an employee limited to a branch reads the note above (they hold the permission: asking for it changes nothing) */}
        {open.length === 0 && access.wholeCompany ? <EmptyState icon="lock" title={t("home.noReports")} text={t("home.noReportsText")} /> : null}
        <ul role="list" className="rep-cards-grid">
          {open.map((key) => (
            <li key={key}>
              <Link to={REPORT_PATH(key)} prefetch="intent" className="rep-entry">
                <span className="rep-entry__head">
                  <Icon name={ICONS[key]} size={20} />
                  <span>{t(`${key}.title`)}</span>
                  <span className="ms-auto type-caption text-ink-2">
                    <Code>{REPORT_FUNCTION[key]}</Code>
                  </span>
                </span>
                <span className="type-body text-ink-2">{t(`${key}.card`)}</span>
              </Link>
            </li>
          ))}
          <li>
            <Link to="/admin/reports/dictionary" prefetch="intent" className="rep-entry">
              <span className="rep-entry__head">
                <Icon name="book-open" size={20} />
                <span>{t("dictionary.title")}</span>
                <span className="ms-auto type-caption text-ink-2">
                  <Code>18.07</Code>
                </span>
              </span>
              <span className="type-body text-ink-2">{t("dictionary.card")}</span>
            </Link>
          </li>
        </ul>
      </Section>

      <Section
        id="reports-saved"
        title={t("home.saved")}
        aside={
          <TextLink as={Link} to="/admin/reports/saved" prefetch="intent">
            {t("home.allSaved")}
          </TextLink>
        }
      >
        {saved.length === 0 ? (
          <EmptyState icon="floppy-disk" title={t("saved.none")} text={access.saved ? t("saved.noneHint") : access.wholeCompany ? t("saved.noneReadOnly") : undefined} />
        ) : (
          <ul role="list" className="grid gap-2">
            {saved.map((report) => (
              <li key={report.id} className="adm-card flex flex-wrap items-center justify-between gap-2">
                <Link to={report.href} prefetch="intent" className="adm-link type-label">
                  <Name text={report.name} />
                </Link>
                <span className="type-caption text-ink-2">
                  {/* the owner's name isolated inside the sentence: an Arabic name in brackets stays whole on an English page */}
                  {t(`${report.reportKey}.title`)} · {report.mine ? t("saved.mine") : t("saved.sharedBy", { name: isolated(report.owner.name ?? "—") })} · <When at={report.updatedAt} />
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="reports-limits" title={t("home.limits")}>
        <Note icon="info">
          <p>{t("home.oneDefinition")}</p>
        </Note>
        <Note icon="envelope-simple">
          <p>{t("saved.scheduleBoundary")}</p>
        </Note>
      </Section>

      <ModuleFunctions moduleId="18" />
    </>
  );
}
