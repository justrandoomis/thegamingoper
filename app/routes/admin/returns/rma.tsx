import { data, Link, useSearchParams } from "react-router";

import type { Route } from "./+types/rma";
import { throwAsResponse } from "~/server/errors";
import { getReturnDetail } from "~/server/services/admin/returns/rma.server";
import { Key } from "~/ui/Key";
import { returnsBlobStore } from "./env.server";
import { returnsMeta } from "./meta";
import { ActionsSection, FactsSection, HistorySection, ItemsSection, NoteSection, PhotosSection, RefundsSection, RepairsSection, SignalsSection } from "./rma-parts";
import { openReturns, urls } from "./returns.server";
import { rmaAction } from "./rma.server";
import { DemoNote, Due, Failure, Ref, RmaStatusBadge, useReturnsT } from "./ui";

/**
 * /admin/returns/:rma — one return (12.01–12.05): the units with the rules' verdict at the request, inspection and
 * grading with the goods moving through the core (12.03), the refund through createRefund / approveRefund with two
 * people (12.04, 12.05), photos, fraud signals, the next step with its due time, and the history. Every change is a POST
 * to this page's action (one intent each, rma.server.ts); money and stock open the confirm-with-reason dialog with the
 * impact first. An employee who may only open RMAs sees the ones they opened.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openReturns(context, ["returns.rma.read", "returns.rma.create"]);
  try {
    return { rma: await getReturnDetail(db, actor, params.rma, locale, now, { photo: urls.file }), now };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const req = await openReturns(context);
  const result = await rmaAction(req.ctx, req.db, req.session, params.rma, await request.formData(), returnsBlobStore);
  return result.ok ? result : data(result, { status: result.status });
}

export const meta: Route.MetaFunction = (args) => returnsMeta(args, null, undefined, args.loaderData?.rma.rma);

export default function ReturnPage({ loaderData }: Route.ComponentProps) {
  const t = useReturnsT();
  const [search] = useSearchParams();
  const { rma } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">
          <Link to="/admin/returns" className="adm-link">
            {t("detail.back")}
          </Link>
        </p>
        <h1 className="adm-title flex flex-wrap items-center gap-3">
          <Ref value={rma.rma} />
          <DemoNote show={rma.isDemo} />
        </h1>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
          <RmaStatusBadge status={rma.status} />
          <span className="type-caption text-ink-2">
            {t("detail.order")}{" "}
            <Link to={`/admin/orders/${rma.order.ref}`} className="adm-link">
              <Ref value={rma.order.ref} />
            </Link>
          </span>
          <Due dueAt={rma.dueAt} late={rma.late} dueKey="detail.dueBy" lateKey="detail.lateSince" />
          <Key as={Link} to={`/admin/returns/${rma.rma}/print`} size="sm" icon="printer">
            {t("detail.print")}
          </Key>
        </div>
        {search.get("photos") === "failed" ? <Failure message={t("new.photosFailed")} /> : null}
      </header>

      <ActionsSection rma={rma} />

      <div className="ret-layout">
        <div className="grid min-w-0 gap-6">
          <ItemsSection rma={rma} />
          <RefundsSection rma={rma} />
          <RepairsSection rma={rma} />
          <PhotosSection rma={rma} />
          <HistorySection rma={rma} />
        </div>
        <aside className="ret-side">
          <FactsSection rma={rma} />
          <SignalsSection rma={rma} />
          {rma.can.note ? <NoteSection rma={rma} /> : null}
        </aside>
      </div>
    </>
  );
}
