import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/reviews";
import { Icon } from "~/art/Icon";
import { throwAsResponse } from "~/server/errors";
import { listReviews, moderateReview, type ReviewRow } from "~/server/services/admin/marketing/reviews.server";
import { SECTION_READ } from "~/server/services/admin/marketing/shared.server";
import { REJECT_CODES, REVIEW_VIEWS, parseReviewFilters, reviewSearch } from "~/server/services/admin/marketing/types";
import { CustomerName } from "~/routes/admin/shell/CustomerName";
import { EmptyState } from "~/ui/EmptyState";
import { Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { marketingMeta } from "./meta";
import { openMarketing, respond, runIntent, text } from "./marketing.server";
import { Code, ConfirmAction, Kpis, Notice, Num, Section, Tag, ToneStatus, useMarketingT, When } from "./ui";

/**
 * /admin/marketing/reviews — 16.06: what customers wrote about products, waiting first. Approve (only a verified
 * purchase that still holds up: a delivered order of the same customer and product) or reject with a reason code —
 * never because a review is negative. The storefront shows approved reviews from verified purchases only; nothing
 * here creates or changes a rating. Views, rating, verified and search in the URL (works without JavaScript).
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openMarketing(context, SECTION_READ.reviews);
  const filters = parseReviewFilters(new URL(request.url).searchParams);
  try {
    return { page: await listReviews(db, actor, filters, locale), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { db, session, ctx } = await openMarketing(context, "marketing.review.moderate");
  const form = await request.formData();
  return respond(
    await runIntent(ctx, session, form, { moderate: ["marketing.review.moderate"] }, async (intent) => {
      const result = await moderateReview(db, session.actor, { reviewId: text(form, "reviewId"), decision: text(form, "decision"), expectedStatus: text(form, "expectedStatus"), code: text(form, "code"), note: text(form, "note") }, ctx.now);
      return { ok: true, intent, ...result };
    }),
  );
}

export const meta: Route.MetaFunction = (args) => marketingMeta(args, "reviews.title");

const STATUS_TONE = { pending: "warn", approved: "ok", rejected: "neutral" } as const;

function Stars({ rating }: { rating: number }) {
  const t = useMarketingT();
  return (
    <span className="inline-flex items-center gap-0.5" role="img" aria-label={t("reviews.stars", { n: rating })}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Icon key={n} name={n <= rating ? "star-fill" : "star"} size={14} className={n <= rating ? "text-ink" : "text-ink-3"} />
      ))}
    </span>
  );
}

export default function ReviewsPage({ loaderData }: Route.ComponentProps) {
  const t = useMarketingT();
  const navigation = useNavigation();
  const { page, filters } = loaderData;
  const busy = navigation.state === "loading";
  const filtered = Boolean(filters.q) || filters.rating !== null || filters.verified !== "all";
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("eyebrowFn", { id: "16.06" })}</p>
        <h1 className="adm-title">{t("reviews.title")}</h1>
        <p className="max-w-[75ch] type-body text-ink-2">{t("reviews.lead")}</p>
      </header>

      <Section id="mkt-review-shown" title={t("reviews.shownTitle")}>
        <Kpis
          items={[
            { label: t("reviews.shown"), value: <Num value={page.shown.count} />, note: t("reviews.shownNote") },
            { label: t("reviews.average"), value: page.shown.average === null ? <span className="text-ink-2">{t("common.notAvailable")}</span> : <Num value={page.shown.average} digits={1} />, note: page.shown.average === null ? t("reviews.averageNone") : t("reviews.averageNote", { count: page.shown.products }) },
            { label: t("reviews.waiting"), value: <Num value={page.counts.pending} />, note: t("reviews.waitingNote") },
          ]}
        />
        <Notice icon="info">{t("reviews.noForm")}</Notice>
      </Section>

      <Section id="mkt-reviews" title={t("reviews.listTitle")}>
        <nav aria-label={t("common.views")} className="flex flex-wrap gap-2">
          {REVIEW_VIEWS.map((view) => {
            const active = filters.view === view;
            return (
              <Key key={view} as={Link} to={`/admin/marketing/reviews${reviewSearch({ ...filters, view, page: 1 })}`} size="sm" held={active} aria-current={active ? "true" : undefined}>
                {t(`reviews.views.${view}`)} <bdi className="nums text-ink-2">{page.counts[view]}</bdi>
              </Key>
            );
          })}
        </nav>
        <Form method="get" action="/admin/marketing/reviews" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {filters.view !== "pending" ? <input type="hidden" name="view" value={filters.view} /> : null}
          <TextField name="q" label={t("reviews.search")} defaultValue={filters.q} type="search" maxLength={80} />
          <Select name="rating" label={t("reviews.rating")} defaultValue={filters.rating ? String(filters.rating) : ""} options={[{ value: "", label: t("common.all") }, ...[5, 4, 3, 2, 1].map((n) => ({ value: String(n), label: t("reviews.stars", { n }) }))]} />
          <Select name="verified" label={t("reviews.verified")} defaultValue={filters.verified} options={(["all", "yes", "no"] as const).map((value) => ({ value, label: t(`reviews.verifiedOption.${value}`) }))} />
          <div className="flex flex-wrap items-end gap-2">
            <Key type="submit" icon="funnel" loading={busy}>
              {t("common.apply")}
            </Key>
            <Key as={Link} to="/admin/marketing/reviews">
              {t("common.clear")}
            </Key>
          </div>
        </Form>
        <p className="type-caption text-ink-2" aria-live="polite">
          {t("common.count", { count: page.total })}
        </p>
        {page.rows.length === 0 ? (
          <EmptyState icon="star" title={filtered ? t("reviews.emptyFiltered") : t(`reviews.empty.${filters.view}`)} text={filtered ? t("common.emptyFilteredHint") : t("reviews.emptyHint")} />
        ) : (
          <>
            <ul className="mkt-cards">
              {page.rows.map((row) => (
                <ReviewCard key={row.id} row={row} />
              ))}
            </ul>
            <Pagination page={page.page} pageCount={page.pageCount} href={(n) => reviewSearch({ ...filters, page: n }) || "?"} />
          </>
        )}
        <Notice icon="shield-check">{t("reviews.rule")}</Notice>
      </Section>
    </>
  );
}

function ReviewCard({ row }: { row: ReviewRow }) {
  const t = useMarketingT();
  const approvable = row.verified && row.purchaseOk && row.status !== "approved";
  return (
    <li className="mkt-card">
      <span className="mkt-card__top">
        <span className="grid gap-0.5">
          <span className="type-strong">{row.productName}</span>
          <Stars rating={row.rating} />
        </span>
        <span className="inline-flex flex-wrap items-center gap-1">
          <ToneStatus tone={STATUS_TONE[row.status]}>{t(`reviews.status.${row.status}`)}</ToneStatus>
          {row.verified ? <Tag icon="seal-check" tone={row.purchaseOk ? "ok" : "warn"}>{row.purchaseOk ? t("reviews.verifiedTag") : t("reviews.verifiedBroken")}</Tag> : <Tag icon="warning" tone="warn">{t("reviews.notVerifiedTag")}</Tag>}
        </span>
      </span>
      {row.title ? (
        <p className="type-strong mkt-quote" lang={row.locale ?? undefined}>
          {row.title}
        </p>
      ) : null}
      {row.body ? (
        <p className="mkt-quote" lang={row.locale ?? undefined}>
          {row.body}
        </p>
      ) : (
        <p className="type-caption text-ink-2">{t("reviews.noText")}</p>
      )}
      <span className="flex flex-wrap items-center gap-x-3 gap-y-1 type-caption text-ink-2">
        <span>
          <CustomerName profileId={row.author.profileId}>{row.author.name ?? t("reviews.author")}</CustomerName>
        </span>
        {row.orderRef ? <Code value={row.orderRef} /> : null}
        <When at={row.createdAt} />
        {row.moderatedAt ? <span>{t("reviews.moderatedBy", { name: row.moderatedBy ?? t("common.someone") })}</span> : null}
        {row.rejectCode ? <span>{t(`reviews.rejectCodes.${row.rejectCode}`)}{row.rejectNote ? ` — ${row.rejectNote}` : ""}</span> : null}
      </span>
      <div className="mkt-actions">
        {approvable ? (
          <ConfirmAction
            intent="moderate"
            label={t("reviews.approve")}
            title={t("reviews.approveQ")}
            consequence={t("reviews.approveWhat")}
            confirmLabel={t("reviews.approve")}
            values={{ reviewId: row.id, decision: "approve", expectedStatus: row.status }}
            reason={{ label: t("reviews.note"), noteRequired: false, minLength: 0 }}
            reasonField="note"
            icon="check-circle"
            doneKey="done.reviewApproved"
          />
        ) : null}
        {row.status !== "rejected" ? (
          <ConfirmAction
            intent="moderate"
            label={t("reviews.reject")}
            title={t("reviews.rejectQ")}
            consequence={row.status === "approved" ? t("reviews.rejectApprovedWhat") : t("reviews.rejectWhat")}
            confirmLabel={t("reviews.reject")}
            values={{ reviewId: row.id, decision: "reject", expectedStatus: row.status }}
            reason={{ codes: REJECT_CODES.map((code) => ({ value: code, label: t(`reviews.rejectCodes.${code}`) })), codeLabel: t("reviews.rejectCode"), label: t("reviews.note"), noteRequired: false, minLength: 0 }}
            reasonField="note"
            tone="destructive"
            variant="ghost"
            icon="x-circle"
            doneKey="done.reviewRejected"
          />
        ) : null}
        {!row.verified && row.status === "pending" ? <span className="type-caption text-ink-2">{t("reviews.cannotApprove")}</span> : null}
      </div>
    </li>
  );
}
