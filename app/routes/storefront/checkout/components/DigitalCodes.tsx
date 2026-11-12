import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";

import { Icon } from "~/art/Icon";
import { LocaleLink, useFormat, useT } from "~/i18n/react";
import type { OrderDigitalLineView } from "~/server/services/orders/types";
import { Key } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";
import { Status } from "~/ui/Tag";
import { TextLink } from "~/ui/TextLink";
import { CopyKey } from "./CopyKey";
// its look (.co-codes) travels with it: the account's order page shows it too
import "../checkout.css";

/**
 * The digital codes of a paid order (commerce core orders/digital.server): per line its codes — never sent with the
 * page; each one is shown on request («اعرض الرمز» posts `intent=reveal` to the page's own route, which asks the core
 * with the confirmation token or the owner's session; every reveal is audited) and then stays on screen for this visit
 * with its copy key. A revoked code says why in words that are true for the order (`closed`: the order was cancelled
 * or came back — its refund may still wait, or there was nothing to refund; otherwise a refund revoked it — security
 * review 2026-11-12: every revoked code said «مع الاسترداد»); units the store has no code for yet are counted, without
 * a time promise. `mode="tracked"` (found on /track by reference and number): no reveal — the codes open from the
 * order's own page. `signInRef` (an ACCOUNT's order opened with its link, nobody signed in as its owner — the core's
 * rule: the link opens the order, never an account's codes): no reveal either, a sign-in link back to this order.
 */
export function DigitalCodes({
  lines,
  mode,
  token,
  signInRef = null,
  closed = false,
  headingLevel = 2,
}: {
  lines: readonly OrderDigitalLineView[];
  mode: "owner" | "tracked";
  token: string | null;
  signInRef?: string | null;
  closed?: boolean;
  headingLevel?: 2 | 3;
}) {
  const t = useT("checkout");
  const errorsT = useT("errors");
  const f = useFormat();
  const online = useOnline();
  const fetcher = useFetcher<{ ok: boolean; codeId?: string; code?: string }>();
  const [shown, setShown] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<{ codeId: string; code: string } | null>(null);
  const asked = useRef<string | null>(null);
  const H = `h${headingLevel}` as const;

  useEffect(() => {
    const answer = fetcher.data as { ok: boolean; codeId?: string; code?: string } | undefined;
    if (fetcher.state !== "idle" || !answer || !asked.current) return;
    const codeId = asked.current;
    asked.current = null;
    if (answer.ok && answer.codeId && typeof answer.code === "string") {
      const text = answer.code;
      setShown((current) => ({ ...current, [answer.codeId as string]: text }));
      setFailure(null);
    } else setFailure({ codeId, code: typeof answer.code === "string" ? answer.code : "unexpected" });
  }, [fetcher.state, fetcher.data]);

  if (lines.length === 0) return null;
  const canReveal = mode === "owner" && !signInRef;
  const reveal = (codeId: string) => {
    asked.current = codeId;
    const fields: Record<string, string> = { intent: "reveal", codeId };
    if (token) fields.t = token;
    void fetcher.submit(fields, { method: "post" });
  };

  return (
    <section aria-labelledby="order-codes" className="grid gap-3">
      <H id="order-codes" className="type-h3 text-ink">
        {t("codes.title")}
      </H>
      {/* /track opens none, nor an account's order opened with its link: they say where the codes open */}
      <p className="type-sm text-ink-2">{mode === "tracked" ? t("codes.tracked") : signInRef ? t("codes.signIn") : t("codes.lead")}</p>
      {mode === "owner" && signInRef ? (
        <TextLink as={LocaleLink} to={`/account/login?next=${encodeURIComponent(`/order/${signInRef}`)}`} icon="sign-in" arrow={false} className="justify-self-start">
          {t("codes.signInAction")}
        </TextLink>
      ) : null}
      {lines.map((line) => (
        <div key={line.orderItemId} className="co-card grid gap-2">
          <p className="type-sm-strong text-ink">{line.name}</p>
          <ul className="co-codes">
            {line.codes.map((code, index) => {
              const text = shown[code.id];
              return (
                <li key={code.id}>
                  <span className="grid min-w-0 gap-0.5">
                    <span className="type-xs text-ink-2">{t("codes.code", { n: f.number(index + 1) })}</span>
                    {code.status === "revoked" ? (
                      <span className="type-sm text-ink-2">{t(closed ? "codes.revokedClosed" : "codes.revoked")}</span>
                    ) : text ? (
                      <bdi dir="ltr" className="type-code break-all text-ink">
                        {text}
                      </bdi>
                    ) : code.revealedAt ? (
                      <span className="type-xs text-ink-2">{t("codes.shownOnce")}</span>
                    ) : null}
                    {failure?.codeId === code.id ? (
                      <span className="flex items-center gap-1 type-xs-strong text-danger" role="alert">
                        <Icon name="warning-circle" size={16} />
                        {failure.code === "unexpected" ? t("codes.failed") : errorsT(`errors.${failure.code}`)}
                      </span>
                    ) : null}
                  </span>
                  {code.status === "revoked" ? (
                    <Status tone="neutral">{t("codes.revokedTag")}</Status>
                  ) : text ? (
                    <CopyKey value={text} label={t("codes.copy")} />
                  ) : canReveal ? (
                    <Key size="sm" icon="eye" loading={fetcher.state !== "idle" && asked.current === code.id} disabled={!online} aria-label={t("codes.revealNamed", { name: `${line.name} ${index + 1}` })} onClick={() => reveal(code.id)}>
                      {t("codes.reveal")}
                    </Key>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {line.pending > 0 ? <p className="type-xs text-ink-2">{t("codes.pending", { count: line.pending, n: f.number(line.pending) })}</p> : null}
        </div>
      ))}
    </section>
  );
}
