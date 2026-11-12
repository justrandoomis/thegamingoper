import { Link } from "react-router";

import type { Route } from "./+types/trade-in-print";
import { useFormat } from "~/i18n/react";
import { throwAsResponse } from "~/server/errors";
import { tradeInDocument } from "~/server/services/admin/devices/tradeins.server";
import { Key } from "~/ui/Key";
import { openDevices, urls } from "./devices.server";
import { devicesMeta } from "./meta";
import { Money, Name, PhoneText, Ref, useDevicesT, When } from "./ui";

/**
 * /admin/devices/trade-ins/:ref/print — the offer and receipt the customer signs (13.04, 13.09): the device, its serial,
 * the grade and the checklist result the offer was made on, what came with it, the amount and how long it is open,
 * the payout once made, and two signature lines. Printed by the browser, always ink on paper (data-theme="light").
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale, now } = await openDevices(context, ["devices.tradein.read", "devices.tradein.inspect", "devices.tradein.offer", "devices.tradein.payout"]);
  try {
    return { doc: await tradeInDocument(db, actor, params.ref, locale, now, { file: urls.file }) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export const meta: Route.MetaFunction = (args) => devicesMeta(args, "printDoc.title", undefined, args.loaderData ? `${args.loaderData.doc.ref}` : null);

export default function TradeInPrint({ loaderData }: Route.ComponentProps) {
  const t = useDevicesT();
  const f = useFormat();
  const { doc } = loaderData;
  const insp = doc.inspection;
  return (
    <>
      <div className="dev-noprint dev-actions">
        <Key as={Link} to={`/admin/devices/trade-ins/${doc.ref}`} size="sm" icon="arrow-left">
          {t("detail.back")}
        </Key>
        <Key size="sm" variant="ink" icon="printer" onClick={() => window.print()}>
          {t("printDoc.print")}
        </Key>
      </div>
      <article className="dev-doc" data-theme="light" aria-labelledby="doc-title">
        <header className="grid gap-1">
          <p className="type-caption text-ink-2">{t("printDoc.store")}</p>
          <h1 id="doc-title" className="adm-title">
            {doc.offer ? t("printDoc.titleOffer") : t("printDoc.titleValuation")}
          </h1>
          <p className="type-body">
            <Ref value={doc.ref} /> · {t("printDoc.printed")} <When at={doc.printedAt} />
          </p>
          {doc.isDemo ? <p className="type-caption">{t("printDoc.demo")}</p> : null}
        </header>

        <table>
          <tbody>
            <tr>
              <th scope="row">{t("detail.customer")}</th>
              <td>
                {doc.customer.name ?? t("noName")} · <PhoneText phone={doc.customer.phone} />
              </td>
            </tr>
            <tr>
              <th scope="row">{t("detail.device")}</th>
              <td>
                <Name text={doc.device.variant?.label ?? doc.device.modelName ?? doc.device.text ?? "—"} />
                {doc.device.variant ? (
                  <>
                    {" "}
                    · <Ref value={doc.device.variant.sku} />
                  </>
                ) : null}
              </td>
            </tr>
            <tr>
              <th scope="row">{t("inspect.serial")}</th>
              <td>{insp?.serial ? <Ref value={insp.serial} /> : "—"}</td>
            </tr>
            <tr>
              <th scope="row">{t("inspect.grade")}</th>
              <td>{insp?.grade ? `${insp.grade} · ${t(`gradeWord.${insp.grade}`)}` : "—"}</td>
            </tr>
            <tr>
              <th scope="row">{t("inspect.included")}</th>
              <td>{insp && insp.included.length > 0 ? insp.included.map((key) => t(`accessory.${key}`)).join("، ") : t("inspect.nothingIncluded")}</td>
            </tr>
            <tr>
              <th scope="row">{t("inspect.ownership")}</th>
              <td>{doc.ownershipOk === true ? t("inspect.ownershipYes") : doc.ownershipOk === false ? t("inspect.ownershipNo") : t("inspect.notChecked")}</td>
            </tr>
            <tr>
              <th scope="row">{t("inspect.lock")}</th>
              <td>{doc.accountLockOk === true ? t("inspect.lockYes") : doc.accountLockOk === false ? t("inspect.lockNo") : t("inspect.notChecked")}</td>
            </tr>
          </tbody>
        </table>

        {insp ? (
          <section aria-labelledby="doc-checklist" className="grid gap-2">
            <h2 id="doc-checklist" className="adm-h3">
              {t("printDoc.checklist", { passed: insp.checklist.passed, failed: insp.checklist.failed })}
            </h2>
            <table>
              <thead>
                <tr>
                  <th scope="col">{t("printDoc.item")}</th>
                  <th scope="col">{t("printDoc.result")}</th>
                </tr>
              </thead>
              <tbody>
                {insp.checklist.lines.map((line) => (
                  <tr key={line.key}>
                    <td>{line.label}</td>
                    <td>
                      {line.input === "percent" && typeof line.value === "number" ? `${f.number(line.value)} %` : typeof line.value === "string" && line.value ? line.value : line.result ? t(`result.${line.result}`) : t("result.none")}
                      {line.note ? ` — ${line.note}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        <section aria-labelledby="doc-money" className="grid gap-2">
          <h2 id="doc-money" className="adm-h3">
            {t("printDoc.money")}
          </h2>
          <dl className="dev-ledger">
            {doc.offer ? (
              <>
                <div className="is-total">
                  <dt>{t("offer.amount")}</dt>
                  <dd>{doc.offer.amountIqd !== null ? <Money iqd={doc.offer.amountIqd} /> : t("money.hidden")}</dd>
                </div>
                <div>
                  <dt>{t("offer.validUntil")}</dt>
                  <dd>
                    <When at={doc.offer.expiresAt} />
                  </dd>
                </div>
              </>
            ) : (
              <div>
                <dt>{t("valuation.suggested")}</dt>
                <dd>{doc.valuation?.suggestedIqd != null ? <Money iqd={doc.valuation.suggestedIqd} /> : "—"}</dd>
              </div>
            )}
            {doc.payout.method ? (
              <div>
                <dt>{t("payout.method")}</dt>
                <dd>{t(`payout.${doc.payout.method}`)}</dd>
              </div>
            ) : null}
            {doc.payout.paidAt ? (
              <div>
                <dt>{t("payout.paidAt")}</dt>
                <dd>
                  <When at={doc.payout.paidAt} />
                </dd>
              </div>
            ) : null}
          </dl>
          <p className="type-caption">{doc.offer ? t("printDoc.offerTerms") : t("printDoc.valuationTerms")}</p>
          <p className="type-caption">{t("printDoc.track", { ref: doc.ref })}</p>
        </section>

        <div className="dev-sign">
          <div>{t("printDoc.signCustomer")}</div>
          <div>{t("printDoc.signStaff")}</div>
        </div>
      </article>
    </>
  );
}
