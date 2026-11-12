import { Form, Link } from "react-router";

import type { Route } from "./+types/schedule";
import { getSchedule, parseScheduleFilters, type ScheduleItem } from "~/server/services/admin/cms/schedule.server";
import { SCHEDULE_SPANS, baghdadLocal } from "~/server/services/admin/cms/rules";
import { useFormat } from "~/i18n/react";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { cmsMeta } from "./meta";
import { openCms, orRespond } from "./cms.server";
import { Code, DemoTag, Note, PageHead, Section, StateBadge, useCmsT } from "./ui";

/**
 * /admin/cms/schedule — 17.02: seasonal campaigns and new game releases on one calendar, Iraq days: banners, landing
 * pages and pinned heroes starting and ending, and the catalogue's own dates (products scheduled to publish,
 * pre-order releases, variants still to come). Problems are named on the day they happen.
 */
export async function loader({ context, request }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openCms(context, ["cms.banner.manage", "cms.home.manage", "cms.page.manage", "cms.page.publish"]);
  const filters = parseScheduleFilters(new URL(request.url).searchParams);
  return { schedule: await orRespond(() => getSchedule(db, actor, filters, locale, now)), filters };
}

export const meta: Route.MetaFunction = (args) => cmsMeta(args, "schedule.title");

function Item({ item, running = false }: { item: ScheduleItem; running?: boolean }) {
  const t = useCmsT();
  const f = useFormat();
  const time = running ? (item.since ? <bdi className="nums">{f.date(item.since)}</bdi> : "—") : item.edge === "release" && item.kind !== "product_publish" ? t("schedule.allDay") : <bdi className="nums">{baghdadLocal(item.at).slice(11)}</bdi>;
  return (
    <li className="cms-item">
      <span className="cms-item__time">{time}</span>
      <span className="grid min-w-0 gap-1">
        <span className="flex flex-wrap items-center gap-1.5 type-caption text-ink-2">
          <span>{t(`schedule.kind.${item.kind}`)}</span>
          <span aria-hidden="true">·</span>
          <span>{t(`schedule.edge.${item.edge}`)}</span>
          {item.kind === "pin" && item.detail ? (
            <>
              <span aria-hidden="true">·</span>
              <span>{t(`platform.${item.detail}`)}</span>
            </>
          ) : null}
          {item.kind === "variant_release" && item.detail ? <Code>{item.detail}</Code> : null}
        </span>
        <Link to={item.href} className="adm-link">
          {item.title || "—"}
        </Link>
        {item.draft || item.demo || item.problem ? (
          <span className="flex flex-wrap items-center gap-1.5">
            {/* a draft's dates are a plan: nothing starts until it is published or scheduled; a demo row never shows */}
            {item.draft ? <StateBadge state="draft" /> : null}
            <DemoTag show={item.demo} />
            {item.problem ? <Status tone="bad">{t(`schedule.problem.${item.problem}`)}</Status> : null}
          </span>
        ) : null}
      </span>
    </li>
  );
}

export default function SchedulePage({ loaderData }: Route.ComponentProps) {
  const t = useCmsT();
  const f = useFormat();
  const { schedule, filters } = loaderData;
  const dayLabel = (day: string) => f.date(Date.parse(`${day}T00:00:00+03:00`), "long");
  return (
    <>
      <PageHead title={t("schedule.title")} lead={t("schedule.lead")} />
      <Form method="get" className="cms-filters mb-5" preventScrollReset>
        <TextField name="from" type="date" ltr label={t("schedule.from")} defaultValue={filters.from ?? schedule.from} />
        <Select name="days" label={t("schedule.span")} defaultValue={String(filters.days)} options={SCHEDULE_SPANS.map((days) => ({ value: String(days), label: t("schedule.days", { count: days }) }))} />
        <Key type="submit" size="sm" icon="calendar">
          {t("common.apply")}
        </Key>
      </Form>
      <p className="mb-4 type-caption text-ink-2">
        {t("schedule.range", { from: dayLabel(schedule.from), to: dayLabel(schedule.to) })}
        {schedule.problems > 0 ? ` · ${t("schedule.problems", { count: schedule.problems })}` : ""}
      </p>

      {schedule.running.length > 0 ? (
        <Section id="running" title={t("schedule.running")}>
          <ul role="list" className="cms-day__items">
            {schedule.running.map((item) => (
              <Item key={item.key} item={item} running />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section id="days" title={t("schedule.calendar")}>
        {schedule.days.length === 0 ? (
          <EmptyState icon="calendar" title={t("schedule.empty")} text={t("schedule.emptyText")} />
        ) : (
          <div className="grid gap-5">
            {schedule.days.map((day) => (
              <section key={day.day} className="cms-day" aria-labelledby={`day-${day.day}`}>
                <div className="cms-day__head">
                  <h3 id={`day-${day.day}`} className="adm-h3">
                    {dayLabel(day.day)}
                  </h3>
                  <span className="type-caption text-ink-2">{t("schedule.count", { count: day.items.length })}</span>
                </div>
                <ul role="list" className="cms-day__items">
                  {day.items.map((item) => (
                    <Item key={item.key} item={item} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        )}
      </Section>
      <Note>
        <p>{schedule.can.catalog ? t("schedule.note") : t("schedule.noteNoCatalog")}</p>
      </Note>
    </>
  );
}
