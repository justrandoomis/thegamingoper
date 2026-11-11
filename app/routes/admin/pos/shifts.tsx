import { Form, Link } from "react-router";

import type { Route } from "./+types/shifts";
import { throwAsResponse } from "~/server/errors";
import { listShifts } from "~/server/services/admin/pos/shifts.server";
import { parseShiftFilters, shiftSearch, SHIFT_STATES } from "~/server/services/admin/pos/types";
import { Chip } from "~/ui/Chip";
import { EmptyState } from "~/ui/EmptyState";
import { Checkbox, Select, TextField } from "~/ui/Field";
import { Key } from "~/ui/Key";
import { Pagination } from "~/ui/Pagination";
import { posMeta } from "./meta";
import { openPos } from "./pos.server";
import { Money, Num, Ref, ShiftBadge, usePosT, When } from "./ui";

/**
 * /admin/pos/shifts — shifts and their counts (06.02), filters in the URL (state, register, Baghdad day, mine) so the
 * page works without JavaScript and links can be shared. "To review" = counted with a difference nobody approved yet;
 * a supervisor opens one to approve it (never their own). Employees without pos.shift.review see their own shifts and
 * never what the system expected (blind count). Table from 768px, cards on phones.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPos(context, ["pos.shift.review", "pos.shift.open", "pos.shift.close"]);
  const filters = parseShiftFilters(new URL(request.url).searchParams);
  try {
    return { page: await listShifts(db, actor, filters, locale), filters };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => posMeta(args, "shifts.title");

export default function Shifts({ loaderData }: Route.ComponentProps) {
  const t = usePosT();
  const { page, filters } = loaderData;
  const href = (patch: Partial<typeof filters>) => `/admin/pos/shifts${shiftSearch({ ...filters, page: 1, ...patch })}`;
  return (
    <>
      <header className="adm-page-head">
        <h1 className="adm-title">{t("shifts.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{page.reviewer ? t("shifts.leadReviewer") : t("shifts.leadOwn")}</p>
      </header>

      <div className="mb-4 grid gap-3">
        <div className="chips" role="group" aria-label={t("shifts.stateFilter")}>
          <Chip as={Link} to={href({ state: null })} selected={!filters.state}>
            {t("shifts.all")}
          </Chip>
          {SHIFT_STATES.map((state) => (
            <Chip key={state} as={Link} to={href({ state })} selected={filters.state === state}>
              {t(`state.${state}`)}
            </Chip>
          ))}
        </div>
        <Form method="get" className="flex flex-wrap items-end gap-3">
          {filters.state ? <input type="hidden" name="state" value={filters.state} /> : null}
          <Select name="register" label={t("shifts.register")} defaultValue={filters.register ?? ""} options={[{ value: "", label: t("shifts.anyRegister") }, ...page.registers.map((register) => ({ value: register.id, label: `${register.code} · ${register.name}` }))]} />
          <TextField name="day" type="date" label={t("shifts.day")} defaultValue={filters.day ?? ""} ltr />
          {page.reviewer ? <Checkbox name="mine" value="1" label={t("shifts.mine")} defaultChecked={filters.mine} /> : null}
          <Key type="submit" icon="funnel">
            {t("shifts.apply")}
          </Key>
        </Form>
      </div>

      {page.rows.length === 0 ? (
        <EmptyState title={t("shifts.empty")} text={t("shifts.emptyHint")} icon="clock" />
      ) : (
        <>
          <div className="pos-table overflow-x-auto">
            <table className="table">
              <caption className="sr-only">{t("shifts.title")}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("shifts.col.register")}</th>
                  <th scope="col">{t("shifts.col.by")}</th>
                  <th scope="col">{t("shifts.col.opened")}</th>
                  <th scope="col">{t("shifts.col.closed")}</th>
                  <th scope="col">{t("shifts.col.state")}</th>
                  <th scope="col" className="is-num">{t("shifts.col.sales")}</th>
                  <th scope="col" className="is-num">{t("shifts.col.counted")}</th>
                  {page.reviewer ? <th scope="col" className="is-num">{t("shifts.col.expected")}</th> : null}
                  {page.reviewer ? <th scope="col" className="is-num">{t("shifts.col.variance")}</th> : null}
                </tr>
              </thead>
              <tbody>
                {page.rows.map((row) => (
                  <tr key={row.id}>
                    <td>
                      <Link to={`/admin/pos/shifts/${row.id}`} className="adm-link">
                        <Ref value={row.register.code} />
                      </Link>
                    </td>
                    <td>{row.openedBy.name}</td>
                    <td>
                      <When at={row.openedAt} />
                    </td>
                    <td>
                      <When at={row.closedAt} />
                    </td>
                    <td>
                      <ShiftBadge state={row.state} />
                    </td>
                    <td className="is-num">
                      <Num value={row.sales.count} />
                    </td>
                    <td className="is-num">
                      <Money iqd={row.countedCashIqd} />
                    </td>
                    {page.reviewer ? (
                      <td className="is-num">
                        <Money iqd={row.expectedCashIqd} />
                      </td>
                    ) : null}
                    {page.reviewer ? (
                      <td className="is-num">
                        <Money iqd={row.varianceIqd} signed />
                      </td>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className="pos-cards pos-cards--phone" aria-label={t("shifts.title")}>
            {page.rows.map((row) => (
              <li key={row.id}>
                <Link to={`/admin/pos/shifts/${row.id}`} className={row.state === "review" && page.reviewer && !row.mine ? "pos-card adm-card--act" : "pos-card"}>
                  <div className="pos-card__row">
                    <span className="type-strong">
                      <Ref value={row.register.code} /> · {row.openedBy.name}
                    </span>
                    <ShiftBadge state={row.state} />
                  </div>
                  <p className="type-caption text-ink-2">
                    <When at={row.openedAt} /> · {t("shifts.salesCount", { count: row.sales.count })}
                  </p>
                  {page.reviewer && row.varianceIqd !== null ? (
                    <p className="type-body">
                      {t("shifts.col.variance")} <Money iqd={row.varianceIqd} signed />
                    </p>
                  ) : null}
                </Link>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <Pagination page={page.page} pageCount={page.pageCount} href={(n) => `/admin/pos/shifts${shiftSearch({ ...filters, page: n })}`} />
          </div>
        </>
      )}
    </>
  );
}
