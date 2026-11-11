/**
 * The POS receipt on 80 mm roll paper (06.01, 06.05) — shared by the receipt page (/admin/pos/receipts/:ref) and the
 * till, which prints it IN PLACE right after a sale (`<PrintArea>`: hidden on screen, the only thing on paper; the
 * admin answers X-Frame-Options: DENY, so a frame never loads a receipt). Always ink on paper (data-theme="light"),
 * also from a dark screen. Marks: COPY (any print after the original — recorded on the server), DEMO, REFUNDED.
 * Never cost data; serials only when the server sent them (inventory.serial.read).
 */
import type { ReactNode } from "react";

import { Logo } from "~/art/Logo";
import { useFormat } from "~/i18n/react";
import type { ReceiptView } from "~/server/services/admin/pos/types";
import { code128Modules } from "../orders/code128";
import { Money, Ref, usePosT } from "./ui";

/**
 * `copy`: the copy number this print got from the server (0 = the original), or null for a preview — a preview of a
 * receipt whose original was printed already carries the COPY mark (a browser print of it is a copy too).
 */
export function ReceiptPaper({ receipt, copy }: { receipt: ReceiptView; copy: number | null }) {
  const t = usePosT();
  const f = useFormat();
  const isCopy = copy !== null ? copy > 0 : receipt.printed;
  return (
    <article className="pos-print" data-theme="light" aria-label={t("receipt.title", { ref: receipt.ref })}>
      <div className="pos-print__head">
        <Logo className="h-8 w-auto text-logo" />
        {receipt.store.address ? <p className="pos-print__muted">{receipt.store.address}</p> : null}
        {receipt.store.phone ? (
          <p className="pos-print__muted">
            <Ref value={receipt.store.phone} />
          </p>
        ) : null}
        <p className="pos-print__big">{t("receipt.kind")}</p>
        <div className="pos-actions justify-center">
          {isCopy ? <span className="pos-print__mark">{copy !== null && copy > 0 ? t("receipt.copy", { n: copy }) : t("receipt.copyPlain")}</span> : null}
          {receipt.isDemo ? <span className="pos-print__mark">{t("receipt.demo")}</span> : null}
          {receipt.refundedIqd > 0 ? <span className="pos-print__mark">{t("receipt.refunded")}</span> : null}
        </div>
      </div>
      <Row label={t("receipt.number")} value={<Ref value={receipt.number ?? "—"} className="type-strong" />} />
      <Row label={t("receipt.sale")} value={<Ref value={receipt.ref} />} />
      <Row label={t("receipt.date")} value={<span className="nums">{f.dateTime(receipt.at)}</span>} />
      {receipt.offlineAt ? <Row label={t("receipt.offlineAt")} value={<span className="nums">{f.dateTime(receipt.offlineAt)}</span>} /> : null}
      <Row label={t("receipt.register")} value={<Ref value={receipt.register.code} />} />
      {receipt.cashier ? <Row label={t("receipt.cashier")} value={receipt.cashier} /> : null}
      {receipt.customer ? (
        <Row
          label={t("receipt.customer")}
          value={
            <>
              {receipt.customer.name ? `${receipt.customer.name} · ` : ""}
              {receipt.customer.phoneMasked ? <Ref value={receipt.customer.phoneMasked} /> : null}
            </>
          }
        />
      ) : null}
      <hr className="pos-print__rule" />
      {receipt.lines.map((line, index) => (
        <div key={index} className="pos-print__item">
          <span className="type-strong">{line.name}</span>
          <div className="pos-print__row">
            <span>
              <bdi className="nums">{f.number(line.qty)}</bdi> × <Money iqd={line.unitPriceIqd} />
            </span>
            <Money iqd={line.totalIqd} />
          </div>
          {line.discountIqd > 0 ? (
            <div className="pos-print__row pos-print__muted">
              <span>{t("receipt.lineDiscount")}</span>
              <Money iqd={-line.discountIqd} />
            </div>
          ) : null}
          <span className="pos-print__muted">
            <Ref value={line.sku} />
            {line.used ? ` · ${t("receipt.used")}` : ""}
          </span>
          {line.serials?.length ? (
            <span className="pos-print__muted">
              {t("receipt.serials")}{" "}
              {line.serials.map((serial, n) => (
                <span key={serial}>
                  {n > 0 ? "، " : ""}
                  <Ref value={serial} />
                </span>
              ))}
            </span>
          ) : null}
          {line.warrantyMonths ? <span className="pos-print__muted">{t("receipt.warrantyMonths", { count: line.warrantyMonths })}</span> : line.warrantyDays ? <span className="pos-print__muted">{t("receipt.warrantyDays", { count: line.warrantyDays })}</span> : null}
        </div>
      ))}
      <hr className="pos-print__rule" />
      {receipt.orderDiscountIqd > 0 ? <Row label={t("receipt.saleDiscount")} value={<Money iqd={-receipt.orderDiscountIqd} />} /> : null}
      <div className="pos-print__row pos-print__big">
        <span>{t("receipt.total")}</span>
        <Money iqd={receipt.totalIqd} />
      </div>
      {receipt.payments.map((payment) => (
        <Row
          key={payment.method}
          label={
            <>
              {t(`method.${payment.method}`)}
              {payment.reference ? (
                <>
                  {" · "}
                  <Ref value={payment.reference} />
                </>
              ) : null}
            </>
          }
          value={<Money iqd={payment.amountIqd} />}
        />
      ))}
      {receipt.tenderedIqd !== null && receipt.changeIqd > 0 ? (
        <>
          <Row label={t("receipt.tendered")} value={<Money iqd={receipt.tenderedIqd} />} />
          <div className="pos-print__row type-strong">
            <span>{t("receipt.change")}</span>
            <Money iqd={receipt.changeIqd} />
          </div>
        </>
      ) : null}
      {receipt.discountIqd > 0 ? <p className="pos-print__muted">{t("receipt.saved", { amount: f.iqd(receipt.discountIqd) })}</p> : null}
      <hr className="pos-print__rule" />
      <div className="grid justify-items-center gap-1">
        <Barcode text={receipt.ref} label={t("receipt.barcode", { ref: receipt.ref })} />
        <Ref value={receipt.ref} className="pos-print__muted" />
      </div>
      <p className="pos-print__muted text-center">{t("receipt.footer")}</p>
    </article>
  );
}

function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="pos-print__row">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/** A receipt printed in place: invisible on screen, the only thing on paper (pos.css `.pos-print-only`). */
export function PrintArea({ children }: { children: ReactNode }) {
  return (
    <div className="pos-print-only" aria-hidden="true">
      {children}
    </div>
  );
}

function Barcode({ text: value, label }: { text: string; label: string }) {
  const modules = code128Modules(value);
  if (!modules) return null;
  const quiet = 10;
  const total = modules.reduce((sum, width) => sum + width, 0) + quiet * 2;
  const bars: { x: number; w: number }[] = [];
  let x = quiet;
  modules.forEach((width, index) => {
    if (index % 2 === 0) bars.push({ x, w: width });
    x += width;
  });
  return (
    <svg className="pos-barcode" viewBox={`0 0 ${total} 40`} preserveAspectRatio="none" role="img" aria-label={label}>
      {bars.map((bar, index) => (
        <rect key={index} x={bar.x} y={0} width={bar.w} height={40} fill="currentColor" />
      ))}
    </svg>
  );
}
