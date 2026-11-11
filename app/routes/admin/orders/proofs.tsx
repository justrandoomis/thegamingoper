import { Link } from "react-router";

import type { Route } from "./+types/proofs";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { requireEmployee } from "~/server/auth/admin.server";
import { getCtx } from "~/server/context.server";
import { getDb } from "~/server/db.server";
import { listProofQueue } from "~/server/services/admin/orders/queues.server";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { ordersMeta } from "./meta";
import { DemoNote, Money, Ref, useOrdersT } from "./ui";

/**
 * /admin/orders/proofs — transfer proofs (card / Zain Cash) awaiting a person's verification, oldest first. The
 * shell's bell and home card count the same rows (shell/queues.server.ts → link here). Mobile-first: one card per
 * payment, the amounts side by side, a duplicate warning when the same picture or reference was used before.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const ctx = getCtx(context);
  const db = getDb();
  const { actor } = await requireEmployee(ctx, db, "orders.payment.verify");
  const done = new URL(request.url).searchParams.get("done");
  return { rows: await listProofQueue(db, actor), now: ctx.now, done: done && /^[A-Z]{2,4}-[A-Z0-9]{4,16}$/.test(done) ? done : null };
}

export const meta: Route.MetaFunction = (args) => ordersMeta(args, "proofs.title");

export default function ProofQueue({ loaderData }: Route.ComponentProps) {
  const t = useOrdersT();
  const f = useFormat();
  const { rows, now, done } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("proofs.title")}</h1>
        <p className="max-w-[65ch] type-body text-ink-2">{t("proofs.lead")}</p>
      </header>
      {done ? (
        <p className="adm-notice adm-notice--ok mb-4" role="status">
          <Icon name="check-circle" size={18} />
          <span>{t("proofs.done", { ref: done })}</span>
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={t("proofs.empty")} text={t("proofs.emptyHint")} icon="seal-check" />
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" aria-label={t("proofs.title")}>
          {rows.map((row) => (
            <li key={row.paymentId}>
              <article className="adm-card adm-card--act">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="type-strong">
                    <Ref value={row.orderRef} /> <DemoNote show={row.isDemo} />
                  </p>
                  <span className="type-caption text-ink-2">{f.relative(row.submittedAt, now)}</span>
                </div>
                <p className="type-caption text-ink-2">{t(`method.${row.method}`)}</p>
                <dl className="ord-ledger">
                  <div>
                    <dt>{t("proof.due")}</dt>
                    <dd>
                      <Money iqd={row.dueIqd} />
                    </dd>
                  </div>
                  <div>
                    <dt>{t("proof.declared")}</dt>
                    <dd>
                      <Money iqd={row.declaredAmountIqd} />
                    </dd>
                  </div>
                </dl>
                <div className="flex flex-wrap gap-2">
                  {row.matches ? <Status tone="ok">{t("proof.matches")}</Status> : <Status tone="warn">{t("proof.mismatch")}</Status>}
                  {row.duplicate ? <Status tone="bad">{t("proof.duplicateShort")}</Status> : null}
                  {row.onHold ? <Status tone="bad">{t("reviewStatus.blocked")}</Status> : null}
                </div>
                <div>
                  <Key as={Link} to={`/admin/orders/proofs/${row.paymentId}`} size="sm" variant="ink" iconEnd="arrow-right">
                    {t("proof.review")}
                  </Key>
                </div>
              </article>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
