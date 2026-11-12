import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/carts";
import { throwAsResponse } from "~/server/errors";
import { listAbandonedCarts, prepareCartReminders } from "~/server/services/admin/marketing/carts.server";
import { SECTION_READ } from "~/server/services/admin/marketing/shared.server";
import { CART_RECOVERY, CART_VIEWS, SEND_LIMITS, cartSearch, parseCartFilters, type CartRow, type CartVerdict } from "~/server/services/admin/marketing/types";
import { CustomerName } from "~/routes/admin/shell/CustomerName";
import { DataTable, type DataColumn } from "~/ui/DataTable";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { marketingMeta } from "./meta";
import { list, openMarketing, respond, runIntent, text } from "./marketing.server";
import { Boundary, ConfirmAction, DemoTag, Facts, Kpis, Money, Notice, Num, PhoneText, Section, ToneStatus, useFormKey, useMarketingT, When } from "./ui";

/**
 * /admin/marketing/carts — 16.02: carts left with lines in them by a known customer, the verdict for each (a
 * reminder may be prepared, or why not: guest cart, no consent, ordered since, nothing buyable, a reminder already,
 * the person's or the marketing limit…), preparing held reminders for the chosen carts, the reminded carts and what
 * became of them. Views and demo in the URL (works without JavaScript); a table from 768px, cards below.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, now } = await openMarketing(context, SECTION_READ.carts);
  const filters = parseCartFilters(new URL(request.url).searchParams);
  try {
    return { page: await listAbandonedCarts(db, actor, filters, now), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx, origin } = await openMarketing(context, "marketing.cart_recovery.manage");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { prepare: ["marketing.cart_recovery.manage"] }, async (intent) => {
      const result = await prepareCartReminders(db, session.actor, { cartIds: list(form, "cartIds"), idempotencyKey: text(form, "idempotencyKey"), includeDemo: text(form, "includeDemo") }, ctx.now, origin);
      return { ok: true, intent, ...result };
    }),
  );
}

export const meta: Route.MetaFunction = (args) => marketingMeta(args, "carts.title");

const VERDICT_TONE: Record<CartVerdict, "ok" | "warn" | "info" | "neutral"> = {
  eligible: "ok",
  reminded: "info",
  guest_cart: "neutral",
  account_closed: "neutral",
  blocked: "neutral",
  no_consent: "neutral",
  consent_withdrawn: "neutral",
  channel_off: "neutral",
  no_address: "neutral",
  recent_order: "neutral",
  nothing_available: "warn",
  person_limit: "neutral",
  frequency_cap: "neutral",
};

export default function CartsPage({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const navigation = useNavigation();
  const key = useFormKey();
  const [runKey, setRunKey] = useState(key);
  const { page, filters } = loaderData;
  const [selected, setSelected] = useState<string[]>([]);
  const busy = navigation.state === "loading" && navigation.location?.pathname === "/admin/marketing/carts";
  const eligibleHere = page.rows.filter((row) => row.verdict === "eligible").map((row) => row.id);
  const reset = () => {
    setSelected([]);
    setRunKey(`${key}${Date.now()}`);
  };

  const columns: DataColumn<CartRow>[] = [
    {
      key: "customer",
      header: t("carts.col.customer"),
      cell: (row) =>
        row.customer ? (
          <span className="grid justify-items-start py-1">
            <CustomerName profileId={row.customer.profileId}>{row.customer.name ?? t("audience.noName")}</CustomerName>
            <PhoneText phone={row.customer.phone} />
            <DemoTag show={row.customer.isDemo} />
          </span>
        ) : (
          <span className="text-ink-2">{t("carts.guest")}</span>
        ),
    },
    { key: "units", header: t("carts.col.units"), numeric: true, cell: (row) => <Num value={row.units} /> },
    { key: "value", header: t("carts.col.value"), numeric: true, cell: (row) => <Money iqd={row.valueIqd} /> },
    { key: "updated", header: t("carts.col.updated"), cell: (row) => <span className="whitespace-nowrap"><When at={row.updatedAt} /></span> },
    { key: "verdict", header: t("carts.col.verdict"), cell: (row) => <ToneStatus tone={VERDICT_TONE[row.verdict]}>{t(`carts.verdict.${row.verdict}`)}</ToneStatus> },
    {
      key: "reminder",
      header: t("carts.col.reminder"),
      cell: (row) =>
        row.reminder ? (
          <span className="grid">
            <span>{t(`carts.reminder.${row.reminder.converted ? "converted" : row.reminder.status}`)}</span>
            <span className="type-caption text-ink-2">
              <When at={row.reminder.createdAt} />
            </span>
          </span>
        ) : (
          <span className="text-ink-2">—</span>
        ),
    },
  ];

  const prepare = (ids: readonly string[]) => (
    <ConfirmAction
      intent="prepare"
      label={ids.length > 0 ? t("carts.prepareSelected", { count: ids.length }) : t("carts.prepareAll", { count: page.counts.eligible })}
      title={t("carts.prepareQ")}
      consequence={t("carts.prepareWhat")}
      confirmLabel={t("carts.prepare")}
      values={{ cartIds: [...ids], idempotencyKey: runKey, includeDemo: filters.demo ? "1" : "" }}
      impact={[
        { label: t("carts.impact.reminders"), value: t("carts.impact.remindersValue", { count: ids.length > 0 ? ids.length : Math.min(page.counts.eligible, CART_RECOVERY.maxPerRun) }) },
        { label: t("actions.sent"), value: t("actions.sentValue") },
      ]}
      reason={false}
      icon="paper-plane-tilt"
      doneKey={(result) => (Number(result.prepared) > 0 ? "done.prepared" : "done.preparedNone")}
      onDone={reset}
    />
  );

  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "16.02" })}</p>
        <h1 className="adm-title">{t("carts.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("carts.lead")}</p>
      </header>

      <Boundary>{t("carts.boundary")}</Boundary>

      <Section id="mkt-cart-limits" title={t("carts.limitsTitle")} lead={t("carts.limitsLead")}>
        <Facts
          rows={[
            { label: t("carts.limit.idle"), value: t("carts.limit.idleValue", { count: CART_RECOVERY.idleHours }) },
            { label: t("carts.limit.age"), value: t("carts.limit.ageValue", { count: CART_RECOVERY.maxAgeDays }) },
            { label: t("carts.limit.perCart"), value: t("carts.limit.perCartValue") },
            { label: t("carts.limit.perPerson"), value: t("carts.limit.perPersonValue", { count: CART_RECOVERY.perPersonDays }) },
            { label: t("carts.limit.marketing"), value: t("carts.limit.marketingValue", { max: SEND_LIMITS.maxPerWindow, count: SEND_LIMITS.windowDays }) },
            { label: t("carts.limit.quiet"), value: t("carts.limit.quietValue", { from: CART_RECOVERY.quietFrom, to: CART_RECOVERY.quietTo }) },
          ]}
        />
      </Section>

      <Section id="mkt-cart-stats" title={t("carts.statsTitle", { count: page.stats.windowDays })}>
        <Kpis
          items={[
            { label: t("carts.stats.reminded"), value: <Num value={page.stats.reminded} />, note: t("carts.stats.remindedNote") },
            { label: t("carts.stats.converted"), value: <Num value={page.stats.convertedAfter} />, note: t("carts.stats.convertedNote") },
            { label: t("carts.stats.value"), value: <Money iqd={page.stats.recoveredIqd} />, note: t("carts.stats.valueNote") },
          ]}
        />
        <Notice icon="warning" tone="warn">
          {t("carts.stats.honest")}
        </Notice>
      </Section>

      <Section id="mkt-carts" title={t("carts.listTitle")}>
        <nav aria-label={t("common.views")} className="flex flex-wrap gap-2">
          {CART_VIEWS.map((view) => {
            const active = filters.view === view;
            return (
              <Key key={view} as={Link} to={`/admin/marketing/carts${cartSearch({ ...filters, view, page: 1 })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`carts.views.${view}`)} <bdi className="nums text-ink-2">{page.counts[view]}</bdi>
              </Key>
            );
          })}
        </nav>
        <Form method="get" action="/admin/marketing/carts" className="flex flex-wrap items-end gap-3">
          {filters.view !== "eligible" ? <input type="hidden" name="view" value={filters.view} /> : null}
          <Checkbox name="demo" value="1" label={t("common.demoPeople")} defaultChecked={filters.demo} />
          <Key type="submit" size="sm" icon="funnel">
            {t("common.apply")}
          </Key>
        </Form>
        {filters.view === "eligible" && page.counts.eligible > 0 ? <div className="mkt-actions">{prepare([])}</div> : null}
        <p className="type-caption text-ink-2" aria-live="polite">
          {t("common.count", { count: page.total })}
        </p>
        {page.rows.length === 0 ? (
          <EmptyState icon="shopping-cart-simple" title={t(`carts.empty.${filters.view}`)} text={t(`carts.emptyHint.${filters.view}`)} />
        ) : (
          <>
            <div className="hidden md:block">
              <DataTable
                caption={t("carts.listTitle")}
                columns={columns}
                rows={page.rows}
                rowKey={(row) => row.id}
                rowLabel={(row) => row.customer?.name ?? row.id}
                busy={busy}
                maxHeight={null}
                {...(filters.view === "eligible" && eligibleHere.length > 0 ? { selected, onSelectedChange: setSelected, bulkActions: (ids: readonly string[]) => prepare(ids) } : {})}
                footer={<Pagination page={page.page} pageCount={page.pageCount} href={(n) => cartSearch({ ...filters, page: n }) || "?"} />}
              />
            </div>
            <div className="md:hidden">
              <ul className="mkt-cards" aria-label={t("carts.listTitle")}>
                {page.rows.map((row) => (
                  <li key={row.id} className="mkt-card">
                    <span className="mkt-card__top">
                      <span className="type-strong">{row.customer ? (row.customer.name ?? t("audience.noName")) : t("carts.guest")}</span>
                      <ToneStatus tone={VERDICT_TONE[row.verdict]}>{t(`carts.verdict.${row.verdict}`)}</ToneStatus>
                    </span>
                    <span className="mkt-card__top type-body">
                      <span>{t("carts.unitsLine", { count: row.units })}</span>
                      <Money iqd={row.valueIqd} />
                    </span>
                    <span className="type-caption text-ink-2">
                      <When at={row.updatedAt} />
                    </span>
                  </li>
                ))}
              </ul>
              <div className="mt-4">
                <Pagination page={page.page} pageCount={page.pageCount} href={(n) => cartSearch({ ...filters, page: n }) || "?"} />
              </div>
            </div>
          </>
        )}
        <Notice icon="info">{t("carts.guestNote")}</Notice>
      </Section>
    </>
  );
}
