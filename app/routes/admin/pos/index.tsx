import { Link } from "react-router";

import type { Route } from "./+types/index";
import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { listRegisters } from "~/server/services/admin/pos/registers.server";
import { listSales } from "~/server/services/admin/pos/sale.server";
import { posAccess, POS_READERS } from "~/server/services/admin/pos/shared.server";
import { countReviewable, myShift } from "~/server/services/admin/pos/shifts.server";
import { baghdadDay, parseSaleFilters } from "~/server/services/admin/pos/types";
import { ModuleFunctions } from "../blueprint-status";
import { Key } from "~/ui/Key";
import { Status } from "~/ui/Tag";
import { posMeta } from "./meta";
import { openPos } from "./pos.server";
import { Money, Notice, Ref, Section, usePosT, When } from "./ui";

/**
 * /admin/pos — the module's home: the employee's drawer (open the till, count and close, or open a shift), the shifts
 * waiting for their review (raised: a decision), the registers and who works on them, today's sales for supervisors,
 * what the till honestly can and cannot do, and the status of the module's blueprint functions.
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openPos(context, POS_READERS);
  const access = posAccess(actor);
  const [shift, reviewable, registers, today] = await Promise.all([
    myShift(db, actor, locale),
    countReviewable(db, actor),
    listRegisters(db, actor, locale),
    access.review ? listSales(db, actor, parseSaleFilters(new URLSearchParams({ day: baghdadDay(now) })), locale) : Promise.resolve(null),
  ]);
  return { access, shift, reviewable, registers, today: today?.totals ?? null, day: baghdadDay(now), now };
}

export const meta: Route.MetaFunction = (args) => posMeta(args, "home.title");

export default function PosHome({ loaderData }: Route.ComponentProps) {
  const t = usePosT();
  const f = useFormat();
  const { access, shift, reviewable, registers, today, day, now } = loaderData;
  const tillReady = registers.some((register) => register.isActive && register.location?.kind === "store");
  return (
    <>
      <header className="adm-page-head">
        <p className="adm-eyebrow">{t("home.eyebrow")}</p>
        <h1 className="adm-title">{t("home.title")}</h1>
        <p className="max-w-[70ch] type-body text-ink-2">{t("home.lead")}</p>
      </header>

      <div className="adm-grid mb-8">
        {access.sell || access.open || access.close ? (
          <article className="adm-card">
            <div className="flex items-center gap-2">
              <Icon name="storefront" size={20} className="text-ink-2" />
              <h2 className="adm-h3">{t("home.drawer")}</h2>
            </div>
            {shift ? (
              <>
                <p className="type-body">{t("home.drawerOpen", { register: shift.register.code })}</p>
                <p className="type-caption text-ink-2">
                  {t("home.since")} <When at={shift.openedAt} /> · {t("home.salesCount", { count: shift.sales.count })}
                </p>
                <div className="pos-actions">
                  {access.sell ? (
                    <Key as={Link} to="/admin/pos/sell" variant="ink" icon="barcode">
                      {t("home.openTill")}
                    </Key>
                  ) : null}
                  <Key as={Link} to="/admin/pos/shift" icon="coins">
                    {t("home.drawerManage")}
                  </Key>
                </div>
              </>
            ) : (
              <>
                <p className="type-body text-ink-2">{tillReady ? t("home.noShift") : t("home.noRegister")}</p>
                {access.open && tillReady ? (
                  <div className="pos-actions">
                    <Key as={Link} to="/admin/pos/shift" variant="ink" icon="lock">
                      {t("home.openShift")}
                    </Key>
                  </div>
                ) : null}
              </>
            )}
          </article>
        ) : null}

        {reviewable !== null ? (
          <article className={reviewable > 0 ? "adm-card adm-card--act" : "adm-card"}>
            <div className="flex items-center gap-2">
              <Icon name="scales" size={20} className="text-ink-2" />
              <h2 className="adm-h3">{t("home.review")}</h2>
            </div>
            <p className="type-body">{reviewable > 0 ? t("home.reviewWaiting", { count: reviewable }) : t("home.reviewNone")}</p>
            {reviewable > 0 ? (
              <div className="pos-actions">
                <Key as={Link} to="/admin/pos/shifts?state=review" variant="ink" icon="arrow-left">
                  {t("home.reviewOpen")}
                </Key>
              </div>
            ) : null}
          </article>
        ) : null}

        {today ? (
          <article className="adm-card">
            <p className="type-caption text-ink-2">{t("home.today", { day: f.date(now) })}</p>
            <p className="type-kpi">
              <Money iqd={today.totalIqd} />
            </p>
            <p className="type-caption text-ink-2">{t("home.todaySales", { count: today.count })}</p>
            <div className="pos-actions">
              <Key as={Link} to={`/admin/pos/sales?day=${day}`} size="sm" icon="receipt">
                {t("home.todayOpen")}
              </Key>
            </div>
          </article>
        ) : null}
      </div>

      <Section id="pos-registers" title={t("home.registers")} action={<Link className="adm-link" to="/admin/pos/registers">{t("home.registersAll")}</Link>}>
        {registers.length === 0 ? (
          <Notice tone="warn">{access.registers ? t("home.registersEmptyManager") : t("home.registersEmpty")}</Notice>
        ) : (
          <ul className="pos-cards" aria-label={t("home.registers")}>
            {registers.map((register) => (
              <li key={register.id} className="pos-card">
                <div className="pos-card__row">
                  <span className="type-strong">
                    <Ref value={register.code} /> · {register.name}
                  </span>
                  {!register.isActive ? <Status tone="neutral">{t("registers.off")}</Status> : register.openShift ? <Status tone="ok">{t("registers.inUse")}</Status> : <Status tone="neutral">{t("registers.free")}</Status>}
                </div>
                <p className="type-caption text-ink-2">
                  {register.location ? (
                    <>
                      {t("registers.sellsFrom")} <Ref value={register.location.code} /> · {register.location.name}
                    </>
                  ) : (
                    t("registers.noLocation")
                  )}
                </p>
                {register.openShift ? (
                  <p className="type-caption text-ink-2">
                    {t("registers.openBy", { name: register.openShift.openedBy })} · <When at={register.openShift.openedAt} />
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section id="pos-limits" title={t("home.limits")}>
        <ul className="grid gap-2">
          {(["scanner", "printer", "card", "wallet", "offline", "stock"] as const).map((key) => (
            <li key={key} className="flex items-start gap-2 type-body">
              <Icon name={key === "offline" ? "wifi-slash" : key === "card" ? "credit-card" : key === "printer" ? "printer" : key === "scanner" ? "barcode" : key === "wallet" ? "wallet" : "package"} size={18} className="mt-0.5 flex-none text-ink-2" />
              <span>{t(`home.limit.${key}`)}</span>
            </li>
          ))}
        </ul>
      </Section>

      <ModuleFunctions moduleId="06" />
    </>
  );
}
