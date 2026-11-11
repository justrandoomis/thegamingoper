import { Link } from "react-router";

import type { Route } from "./+types/duplicates";
import { throwAsResponse } from "~/server/errors";
import { recentMerges, storeDuplicates } from "~/server/services/admin/customers/merge.server";
import { EmptyState } from "~/ui/EmptyState";
import { Key } from "~/ui/Key";
import { openCustomers } from "./customers.server";
import { customersMeta } from "./meta";
import { DemoNote, Notice, PhoneText, Section, useCustomersT, When } from "./ui";

/**
 * /admin/customers/duplicates — 07.05: accounts that look like the same person (the same e-mail, or one account's
 * number on the other's orders or addresses), each pair with its reason and a way into the merge plan, and the latest
 * merges from the audit trail (who, when, why, how many orders moved).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await openCustomers(context, "customers.customer.merge");
  try {
    const [pairs, merges] = await Promise.all([storeDuplicates(db, actor), recentMerges(db, actor)]);
    return { pairs, merges };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => customersMeta(args, "duplicates.title");

export default function DuplicatesPage({ loaderData }: Route.ComponentProps) {
  const t = useCustomersT();
  const { pairs, merges } = loaderData;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("duplicates.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("duplicates.lead")}</p>
      </header>
      <Section id="duplicates-pairs" title={t("duplicates.pairs", { count: pairs.length })}>
        {pairs.length === 0 ? (
          <EmptyState title={t("duplicates.none")} text={t("duplicates.noneHint")} icon="users" />
        ) : (
          <ul className="cus-rows">
            {pairs.map((pair) => (
              <li key={`${pair.a.id}-${pair.b.id}`} className="cus-row">
                <span className="grid min-w-0 gap-0.5">
                  <span className="flex flex-wrap items-center gap-2 type-strong">
                    <Link to={`/admin/customers/${encodeURIComponent(pair.a.id)}`} className="adm-link">
                      {pair.a.name ?? t("list.noName")}
                    </Link>
                    <span aria-hidden="true">·</span>
                    <Link to={`/admin/customers/${encodeURIComponent(pair.b.id)}`} className="adm-link">
                      {pair.b.name ?? t("list.noName")}
                    </Link>
                    <DemoNote show={pair.a.isDemo || pair.b.isDemo} />
                  </span>
                  <span className="type-caption text-ink-2">
                    <PhoneText phone={pair.a.phone} /> · <PhoneText phone={pair.b.phone} /> · {t(`duplicateReason.${pair.reason}`)}
                  </span>
                </span>
                <Key as={Link} to={`/admin/customers/${encodeURIComponent(pair.a.id)}/merge?with=${encodeURIComponent(pair.b.id)}`} size="sm" iconEnd="arrow-right">
                  {t("merge.review")}
                </Key>
              </li>
            ))}
          </ul>
        )}
        <Notice>{t("duplicates.rule")}</Notice>
      </Section>
      <Section id="duplicates-merges" title={t("duplicates.merges")}>
        {merges.length === 0 ? (
          <p className="type-body text-ink-2">{t("duplicates.noMerges")}</p>
        ) : (
          <ol className="cus-timeline">
            {merges.map((merge) => (
              <li key={`${merge.mergedId}-${merge.at}`} data-actor="employee">
                <span className="type-body">
                  <Link to={`/admin/customers/${encodeURIComponent(merge.mergedId)}`} className="adm-link">
                    {merge.mergedName ?? t("list.noName")}
                  </Link>{" "}
                  {t("duplicates.into")}{" "}
                  <Link to={`/admin/customers/${encodeURIComponent(merge.keepId)}`} className="adm-link">
                    {merge.keepName ?? t("list.noName")}
                  </Link>
                </span>
                <span className="type-caption text-ink-2">
                  {merge.by ?? t("actor.employee")} · <When at={merge.at} /> · {t("duplicates.ordersMoved", { count: merge.orders })}
                </span>
                {merge.reason ? <span className="cus-quote type-caption">{merge.reason}</span> : null}
              </li>
            ))}
          </ol>
        )}
      </Section>
    </>
  );
}
