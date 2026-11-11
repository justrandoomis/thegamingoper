import { useEffect, useRef, useState } from "react";
import { Link, useFetcher } from "react-router";

import type { Route } from "./+types/review";
import { useFormat } from "~/i18n/react";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listReviewQueue, type ReviewQueueRow } from "~/server/services/admin/orders/risk.server";
import { RISK_RULE_IDS, RISK_THRESHOLDS } from "~/server/services/admin/orders/types";
import { ConfirmDialog } from "~/ui/Dialog";
import { Disclosure } from "~/ui/Disclosure";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { toast } from "~/ui/toast-store";
import { ordersMeta } from "./meta";
import type { OrderActionResult } from "./order.server";
import { DemoNote, FlagExplanations, Money, OrderStatusBadge, Ref, ReviewBadge, riskVars, useOrdersT, When } from "./ui";

/**
 * /admin/orders/review — 05.09: open orders a rule flags as late or suspicious (or that someone asked to be looked at),
 * each with the sentence that explains every flag, and the orders on hold. A person decides: clear (fine — a NEW flag
 * later brings it back), hold (the order is not moved forward until cleared) — always with a reason, recorded in the
 * order's history and the audit trail. The rules and their thresholds are listed at the bottom, plainly.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.risk.review");
  return { ...(await listReviewQueue(db, actor, ctx.now)), now: ctx.now };
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "reviewPage.title");

export default function ReviewPage({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const f = useFormat();
  const { needsReview, onHold } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("reviewPage.title")}</h1>
        <p className="max-w-[65ch] type-body text-ink-2">{t("reviewPage.lead")}</p>
        {onHold.length ? (
          // the module's "review" count is both lists: say at once where the rest is
          <p className="type-body">
            <a href="#review-hold" className="adm-link">
              {t("reviewPage.onHold", { count: onHold.length })}
            </a>
          </p>
        ) : null}
      </header>

      <section className="adm-section" aria-labelledby="review-needs">
        <h2 id="review-needs" className="adm-h2">
          {t("reviewPage.needs", { count: needsReview.length })}
        </h2>
        {needsReview.length === 0 ? (
          <EmptyState title={t("reviewPage.empty")} text={t("reviewPage.emptyHint")} icon="seal-check" />
        ) : (
          <ul className="grid gap-3 md:grid-cols-2">
            {needsReview.map((row) => (
              <li key={row.id}>
                <ReviewCard row={row} />
              </li>
            ))}
          </ul>
        )}
      </section>

      {onHold.length ? (
        <section className="adm-section" aria-labelledby="review-hold">
          <h2 id="review-hold" className="adm-h2">
            {t("reviewPage.onHold", { count: onHold.length })}
          </h2>
          <ul className="grid gap-3 md:grid-cols-2">
            {onHold.map((row) => (
              <li key={row.id}>
                <ReviewCard row={row} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <Disclosure summary={t("reviewPage.rules")} variant="panel">
        <ul className="grid gap-3">
          {RISK_RULE_IDS.map((id) => (
            <li key={id}>
              <p className="type-strong">{t(`risk.${id}.title`)}</p>
              <p className="type-caption text-ink-2">{t(`risk.${id}.why`, riskVars(id, f))}</p>
            </li>
          ))}
        </ul>
        <p className="mt-3 type-caption text-ink-2">{t("reviewPage.rulesNote", { hours: RISK_THRESHOLDS.proofWaitingHours })}</p>
      </Disclosure>
    </>
  );
}

function ReviewCard({ row }: { row: ReviewQueueRow }) {
  const t = useOrdersT();
  const fetcher = useFetcher<OrderActionResult>();
  const [decision, setDecision] = useState<"clear" | "hold" | null>(null);
  const handled = useRef<unknown>(null);
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data?.ok && handled.current !== fetcher.data) {
      handled.current = fetcher.data;
      setDecision(null);
      toast.success(t("done.review"));
    }
  }, [fetcher.state, fetcher.data, t]);
  const error = fetcher.data && !fetcher.data.ok ? (fetcher.data.message ?? t(`errors.${fetcher.data.code}`)) : null;
  return (
    <article className="adm-card adm-card--act">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link to={`/admin/orders/${row.ref}`} className="adm-link">
          <Ref value={row.ref} />
        </Link>
        <span className="flex flex-wrap items-center gap-2">
          <OrderStatusBadge status={row.status as never} />
          <ReviewBadge status={row.reviewStatus} />
          <DemoNote show={row.isDemo} />
        </span>
      </div>
      <p className="type-body">
        <Money iqd={row.totalIqd} /> · {row.paymentMethod ? t(`method.${row.paymentMethod}`) : "—"} · <When at={row.placedAt} />
      </p>
      <FlagExplanations flags={row.flags} />
      <div className="ord-actions">
        {row.reviewStatus !== "cleared" ? (
          <Key size="sm" icon="seal-check" onClick={() => setDecision("clear")}>
            {t("review.clear")}
          </Key>
        ) : null}
        {row.reviewStatus !== "blocked" ? (
          <Key size="sm" icon="lock" className="enabled:[--on:var(--red-ink)]" onClick={() => setDecision("hold")}>
            {t("review.hold")}
          </Key>
        ) : null}
      </div>
      {decision ? (
        <ConfirmDialog
          open
          onClose={() => setDecision(null)}
          tone={decision === "hold" ? "destructive" : "neutral"}
          title={t(`review.${decision}Q`, { ref: row.ref })}
          consequence={t(`review.${decision}What`)}
          confirmLabel={t(`review.${decision}`)}
          reason={{ label: t("dialog.reason") }}
          pending={fetcher.state !== "idle"}
          error={error}
          onConfirm={({ reason }) => fetcher.submit({ intent: "review", decision, reason }, { method: "post", action: `/admin/orders/${row.ref}` })}
        />
      ) : null}
    </article>
  );
}
