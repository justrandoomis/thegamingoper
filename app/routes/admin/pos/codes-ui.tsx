import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "~/art/Icon";
import { Logo } from "~/art/Logo";
import { useFormat } from "~/i18n/react";
import type { SaleCodesView } from "~/server/services/admin/pos/codes.server";
import { Key } from "~/ui/Key";
import { PrintArea } from "./receipt-paper";
import { Failure, Notice, Ref, usePosT, When } from "./ui";

/**
 * The digital codes of a till sale (2026-11-13) — on the till right after the sale and on the receipt page. The code
 * lines with their states come from GET /admin/pos/api/codes (never a code); "show" asks the server for ONE code
 * (POST /admin/pos/api/code — the cashier while the shift is open, or a supervisor; every reveal is an audit event and
 * counts against the order's limit), shows it large for the customer to copy, and can print it on a slip of its own
 * (the receipt never carries a code). Printing again reveals again: it is recorded again.
 */
export function SaleCodes({ saleRef, initial = null }: { saleRef: string; initial?: SaleCodesView | null }) {
  const t = usePosT();
  const [view, setView] = useState<SaleCodesView | null>(initial);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [shown, setShown] = useState<{ codeId: string; code: string; name: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [slip, setSlip] = useState<{ code: string; name: string; at: number } | null>(null);

  useEffect(() => {
    if (initial) return;
    let gone = false;
    void (async () => {
      try {
        const response = await fetch(`/admin/pos/api/codes?ref=${encodeURIComponent(saleRef)}`, { headers: { Accept: "application/json" }, credentials: "same-origin" });
        const body = (await response.json().catch(() => null)) as (SaleCodesView & { ok?: boolean; message?: string; code?: string }) | null;
        if (gone) return;
        if (response.ok && body && Array.isArray(body.lines)) setView(body);
        else setLoadError(body?.message ?? t("codes.loadFailed"));
      } catch {
        if (!gone) setLoadError(t("codes.loadFailed"));
      }
    })();
    return () => {
      gone = true;
    };
  }, [saleRef, initial, t]);

  // A slip prints once React has drawn it; the receipt beside it stays off the paper (pos.css: data-slip-printing).
  useEffect(() => {
    if (!slip) return;
    const done = () => setSlip(null);
    window.addEventListener("afterprint", done);
    const timer = window.setTimeout(() => window.print(), 100);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("afterprint", done);
    };
  }, [slip]);

  const reveal = async (codeId: string, name: string, print: boolean) => {
    if (busy) return;
    setBusy(codeId);
    setError(null);
    try {
      const response = await fetch("/admin/pos/api/code", { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, credentials: "same-origin", body: JSON.stringify({ ref: saleRef, codeId }) });
      const body = (await response.json().catch(() => null)) as { ok?: boolean; code?: string; codeId?: string; message?: string } | null;
      if (response.ok && body?.ok && typeof body.code === "string") {
        setShown({ codeId, code: body.code, name });
        if (print) setSlip({ code: body.code, name, at: Date.now() });
      } else setError(body?.message ?? t(`errors.${body?.code ?? "invalid"}`));
    } catch {
      setError(t("codes.loadFailed"));
    } finally {
      setBusy(null);
    }
  };

  if (loadError) return <Failure message={loadError} />;
  if (!view || view.lines.length === 0) return null;
  return (
    <section className="pos-panel pos-noprint" aria-labelledby={`codes-${saleRef}`}>
      <h2 id={`codes-${saleRef}`} className="flex items-center gap-2 type-sub">
        <Icon name="key" size={20} />
        {t("codes.title")}
      </h2>
      <p className="type-caption text-ink-2">{t("codes.lead")}</p>
      {view.revealBlocked === "shift_closed" ? (
        <Notice tone="info" icon="lock">
          {t("codes.afterShift")}
        </Notice>
      ) : null}
      <ul className="grid gap-3">
        {view.lines.map((line) => (
          <li key={line.orderItemId} className="grid gap-2">
            <p className="type-strong">
              {line.name} <span className="type-caption text-ink-2">× {line.qty}</span>
            </p>
            <ul className="grid gap-2">
              {line.codes.map((code, index) => (
                <li key={code.id} className="pos-code">
                  <span className="grid min-w-0">
                    <span className="type-body">{t("codes.unit", { n: index + 1 })}</span>
                    <span className="type-caption text-ink-2">
                      {code.status === "revoked" ? (
                        t("codes.revoked")
                      ) : code.revealedAt ? (
                        <>
                          {t("codes.shownAt")} <When at={code.revealedAt} />
                        </>
                      ) : (
                        t("codes.notShown")
                      )}
                    </span>
                  </span>
                  {code.status === "delivered" && view.canReveal ? (
                    <span className="pos-actions">
                      <Key size="sm" icon="eye" loading={busy === code.id} onClick={() => void reveal(code.id, line.name, false)}>
                        {t("codes.show")}
                      </Key>
                      <Key size="sm" icon="printer" disabled={busy !== null} onClick={() => void reveal(code.id, line.name, true)}>
                        {t("codes.printSlip")}
                      </Key>
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
            {line.pending > 0 ? (
              <Notice tone="warn" icon="warning">
                {t("codes.pending", { count: line.pending })}
              </Notice>
            ) : null}
          </li>
        ))}
      </ul>
      <Failure message={error} />
      {shown ? (
        <div className="pos-code-shown" role="status" aria-live="polite">
          <p className="type-caption text-ink-2">{shown.name}</p>
          <p className="pos-code-shown__value" dir="ltr" translate="no">
            {shown.code}
          </p>
          <p className="type-caption text-ink-2">{t("codes.shownNote")}</p>
          <span className="pos-actions">
            <Key size="sm" icon="eye-slash" onClick={() => setShown(null)}>
              {t("codes.hide")}
            </Key>
          </span>
        </div>
      ) : null}
      {/* the slip goes to <body>: the till and this panel are pos-noprint, which never reaches the paper */}
      {slip && typeof document !== "undefined"
        ? createPortal(
            <div data-slip-printing="">
              <PrintArea>
                <CodeSlip saleRef={saleRef} name={slip.name} code={slip.code} at={slip.at} isDemo={view.isDemo} />
              </PrintArea>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

/** One code on its own 80 mm slip — never on the receipt. Ink on paper whatever the screen's theme. */
function CodeSlip({ saleRef, name, code, at, isDemo }: { saleRef: string; name: string; code: string; at: number; isDemo: boolean }) {
  const t = usePosT();
  const f = useFormat();
  return (
    <article className="pos-print pos-slip" data-theme="light" aria-label={t("codes.slipTitle")}>
      <div className="pos-print__head">
        <Logo className="h-8 w-auto text-logo" />
        <p className="pos-print__big">{t("codes.slipTitle")}</p>
        {isDemo ? <span className="pos-print__mark">{t("receipt.demo")}</span> : null}
      </div>
      <p className="type-strong">{name}</p>
      <p className="pos-slip__code" dir="ltr" translate="no">
        {code}
      </p>
      <hr className="pos-print__rule" />
      <p className="pos-print__muted">
        {t("codes.slipSale")} <Ref value={saleRef} /> · <span className="nums">{f.dateTime(at)}</span>
      </p>
      <p className="pos-print__muted">{t("codes.slipPrivate")}</p>
    </article>
  );
}
