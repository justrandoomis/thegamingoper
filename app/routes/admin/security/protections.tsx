import { data, Link } from "react-router";

import type { Route } from "./+types/protections";
import { useFormat } from "~/i18n/react";
import { can } from "~/server/actor";
import { duplicatesView, encryptionStatus } from "~/server/services/admin/security/protections.server";
import { Status } from "~/ui/Tag";
import { Code, Money, Note, PageHead, Pair, Section, When, useModuleT } from "./components/ui";
import { securityMeta } from "./meta";
import { sec, securitySecrets } from "./security.server";

/**
 * /admin/security/protections — 20.04 (security.audit.verify) and 20.06 (security.fraud.review), each section only for
 * its permission:
 *   · encryption: what is encrypted, hashed, or plain on purpose, with live counts; DATA_KEY's self-test and how many
 *     stored authenticator secrets the key can open — booleans and counts only, never a key, a secret or a code;
 *   · duplicates: each idempotency rule checked live in the database, transfer proofs flagged as copies of an earlier
 *     one, top-ups that share a picture or a reference, and the inbound webhook log (no provider sends any yet).
 */
export async function loader({ context }: Route.LoaderArgs) {
  const { db, actor } = await sec.open(context);
  const [encryption, duplicates] = await Promise.all([
    can(actor, "security.audit.verify") ? encryptionStatus(db, actor, securitySecrets()) : Promise.resolve(null),
    can(actor, "security.fraud.review") ? duplicatesView(db, actor) : Promise.resolve(null),
  ]);
  if (!encryption && !duplicates) throw data({ error: "forbidden", permission: "security.audit.verify" }, { status: 403 });
  return { encryption, duplicates };
}

export const meta: Route.MetaFunction = (args) => securityMeta(args, "protections.title");

export default function ProtectionsPage({ loaderData }: Route.ComponentProps) {
  const t = useModuleT();
  const f = useFormat();
  const { encryption, duplicates } = loaderData;
  const yes = (value: boolean, good = t("common.yes"), bad = t("common.no")) => <Status tone={value ? "ok" : "bad"}>{value ? good : bad}</Status>;
  return (
    <>
      <PageHead title={t("protections.title")} lead={t("protections.lead")} />

      {encryption ? (
        <Section id="encryption" title={t("protections.encryption")}>
          <div className="sec-kpis">
            <div className="adm-card gap-1.5">
              <h3 className="adm-h3">{t("protections.dataKey")}</h3>
              <Pair label={t("protections.configured")}>{yes(encryption.dataKey.configured)}</Pair>
              <Pair label={t("protections.keyLength")}>{yes(encryption.dataKey.validLength)}</Pair>
              <Pair label={t("protections.selfTest")}>{yes(encryption.dataKey.selfTest, t("protections.passed"), t("protections.failed"))}</Pair>
            </div>
            <div className="adm-card gap-1.5">
              <h3 className="adm-h3">{t("protections.totp")}</h3>
              <Pair label={t("protections.totpOn")}>{f.number(encryption.totp.enabled)}</Pair>
              <Pair label={t("protections.totpStored")}>{f.number(encryption.totp.stored)}</Pair>
              <Pair label={t("protections.totpReadable")}>
                <Status tone={encryption.totp.unreadable === 0 ? "ok" : "bad"}>
                  <bdi className="nums">
                    {f.number(encryption.totp.readable)} / {f.number(encryption.totp.stored)}
                  </bdi>
                </Status>
              </Pair>
            </div>
            <div className="adm-card gap-1.5">
              <h3 className="adm-h3">{t("protections.codes")}</h3>
              <Pair label={t("protections.digitalCodes")}>{f.number(encryption.digitalCodes.total)}</Pair>
              <Pair label={t("protections.giftCodes")}>{f.number(encryption.giftCardCodes)}</Pair>
              <Pair label={t("protections.integrationSecrets")}>{f.number(encryption.integrations.withSecret)}</Pair>
              <Pair label={t("protections.webhookSecrets")}>{f.number(encryption.integrations.webhooks)}</Pair>
            </div>
            <div className="adm-card gap-1.5">
              <h3 className="adm-h3">{t("protections.hashed")}</h3>
              <Pair label={t("protections.passwords")}>{f.number(encryption.passwords.set)}</Pair>
              <Pair label={t("protections.iterations")}>{f.number(encryption.passwords.iterations)}</Pair>
              <Pair label={t("protections.weaker")}>{encryption.passwords.weaker ? <Status tone="warn">{f.number(encryption.passwords.weaker)}</Status> : "0"}</Pair>
              <Pair label={t("protections.sessions")}>{f.number(encryption.sessions.staff + encryption.sessions.customers)}</Pair>
            </div>
          </div>
          <div className="adm-card gap-1 mt-3">
            <h3 className="adm-h3">{t("protections.howStored")}</h3>
            <ul role="list" className="grid gap-1 type-body">
              <li>{t("protections.store.encrypted")}</li>
              <li>{t("protections.store.hashed")}</li>
              <li>{t("protections.store.plain")}</li>
              <li>{t("protections.store.never")}</li>
            </ul>
          </div>
          <Note tone={encryption.digitalCodes.total === 0 ? "info" : "ok"}>
            <p>{t("protections.codesNote")}</p>
            <p>{t("protections.rotationNote")}</p>
          </Note>
        </Section>
      ) : null}

      {duplicates ? (
        <Section id="duplicates" title={t("protections.duplicates")}>
          <div className="adm-card gap-1">
            <h3 className="adm-h3">{t("protections.rules")}</h3>
            <ul role="list" className="grid gap-1">
              {duplicates.rules.map((rule) => (
                <li key={rule.key} className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line py-1">
                  <span>{t(`protections.rule.${rule.key}`)}</span>
                  <span className="flex items-center gap-2">
                    <Code className="type-caption text-ink-2">{rule.index}</Code>
                    {yes(rule.present, t("protections.inPlace"), t("protections.missing"))}
                  </span>
                </li>
              ))}
              <li className="flex flex-wrap items-baseline justify-between gap-2 py-1">
                <span>{t("protections.rule.inbound")}</span>
                {yes(duplicates.inboundKey, t("protections.inPlace"), t("protections.missing"))}
              </li>
            </ul>
          </div>

          <div className="sec-split mt-3">
            <div className="adm-card gap-1.5 min-w-0">
              <h3 className="adm-h3">{t("protections.proofs", { count: duplicates.proofs.flagged })}</h3>
              {duplicates.proofs.recent.length === 0 ? (
                <p className="type-body text-ink-2">{t("protections.noDuplicates")}</p>
              ) : (
                <ul role="list" className="grid gap-1">
                  {duplicates.proofs.recent.map((proof) => (
                    <li key={proof.proofId} className="grid gap-0.5 border-b border-line py-1">
                      <span className="flex flex-wrap justify-between gap-2">
                        {proof.orderRef ? (
                          <Link to={`/admin/orders/${proof.orderRef}`} className="adm-link">
                            <Code>{proof.orderRef}</Code>
                          </Link>
                        ) : (
                          "—"
                        )}
                        <Money iqd={proof.declaredAmountIqd} />
                      </span>
                      <span className="type-caption text-ink-2">
                        {t(`protections.reason.${proof.reason}`)} · {proof.firstOrderRef ? <Code>{proof.firstOrderRef}</Code> : "—"} · <When at={proof.createdAt} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="type-caption text-ink-2">{t("protections.proofsNote")}</p>
              <Pair label={t("protections.topupsPicture")}>{f.number(duplicates.topups.samePicture)}</Pair>
              <Pair label={t("protections.topupsReference")}>{f.number(duplicates.topups.sameReference)}</Pair>
            </div>
            <div className="adm-card gap-1.5 min-w-0">
              <h3 className="adm-h3">{t("protections.webhooks")}</h3>
              <Pair label={t("protections.inboundTotal")}>{f.number(duplicates.inbound.total)}</Pair>
              {duplicates.inbound.total === 0 ? (
                <Note tone="warn" icon="plugs-connected">
                  <p>{t("protections.noProvider")}</p>
                </Note>
              ) : (
                <ul role="list" className="grid gap-1">
                  {duplicates.inbound.recent.map((event) => (
                    <li key={event.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-1">
                      <Code>{event.id}</Code>
                      <span className="type-caption">
                        {event.status} · <When at={event.receivedAt} />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>
      ) : null}
    </>
  );
}
