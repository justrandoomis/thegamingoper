import { useEffect, useRef, useState } from "react";
import { Link, useFetcher, useSearchParams } from "react-router";

import type { Route } from "./+types/receipt";
import { throwAsResponse } from "~/server/errors";
import { getReceipt, printReceipt } from "~/server/services/admin/pos/sale.server";
import { posAccess } from "~/server/services/admin/pos/shared.server";
import { Key } from "~/ui/Key";
import { posMeta } from "./meta";
import { failed, openPos } from "./pos.server";
import { ReceiptPaper } from "./receipt-paper";
import { Failure, Notice, usePosT } from "./ui";

/**
 * /admin/pos/receipts/:ref — a POS receipt on 80 mm roll paper (06.01, 06.05), printed by the browser (no printer
 * integration exists or is needed): the receipt number, the sale's reference as a Code 128 barcode (the returns desk
 * scans it), lines with their serials and warranty, discounts, payments, cash tendered and change, the buyer (masked
 * phone). Every print goes through the server first (POST): the FIRST print is the original (recorded once), every
 * later one is a COPY — marked, numbered and recorded (pos.receipt.reprint, which it needs). `?print=1` prints at once.
 * A receipt whose original was printed shows the COPY mark even before "print a copy" (a browser print of it is a copy
 * too). The till prints the original in place (receipt-paper.tsx). Never cost data.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  const { db, actor, locale } = await openPos(context, ["pos.receipt.reprint", "pos.shift.review"]);
  try {
    const receipt = await getReceipt(db, actor, params.ref, locale);
    return { receipt, access: posAccess(actor) };
  } catch (error) {
    throwAsResponse(error);
  }
}

export async function action({ params, context }: Route.ActionArgs) {
  const { db, actor, locale, now } = await openPos(context, ["pos.receipt.reprint", "pos.shift.review"]);
  try {
    const result = await printReceipt(db, actor, params.ref, now, locale);
    return { ok: true as const, intent: "print", copy: result.copy };
  } catch (error) {
    return failed(error, locale, "print");
  }
}

export const meta: Route.MetaFunction = (args) => posMeta(args, "receipt.title", { ref: args.loaderData?.receipt.ref ?? "" });

export default function Receipt({ loaderData }: Route.ComponentProps) {
  const t = usePosT();
  const { receipt, access } = loaderData;
  const [params] = useSearchParams();
  const fetcher = useFetcher<{ ok: boolean; copy?: number; code?: string; message?: string }>();
  const [copy, setCopy] = useState<number | null>(null);
  const printedNow = useRef<unknown>(null);
  const arrived = useRef(false);
  // The original may be printed by anyone who may open the receipt; a copy needs pos.receipt.reprint.
  const canPrint = !receipt.printed || access.reprint;
  const print = () => fetcher.submit({ intent: "print" }, { method: "post" });

  useEffect(() => {
    // `?print=1`: print the original on arrival, once (never again on a later render, never a copy by itself).
    if (arrived.current) return;
    arrived.current = true;
    if (params.get("print") === "1" && !receipt.printed) print();
  }, [params, receipt.printed]);
  useEffect(() => {
    const data = fetcher.data;
    if (fetcher.state !== "idle" || !data?.ok || typeof data.copy !== "number" || printedNow.current === data) return;
    printedNow.current = data;
    setCopy(data.copy);
    // Print after React has drawn the mark this print got.
    const timer = window.setTimeout(() => window.print(), 150);
    return () => window.clearTimeout(timer);
  }, [fetcher.state, fetcher.data]);

  const copyNext = receipt.printed || copy !== null;
  return (
    <>
      <div className="pos-noprint pos-actions mb-4">
        <h1 className="adm-title sr-only">{t("receipt.title", { ref: receipt.ref })}</h1>
        {canPrint ? (
          <Key icon="printer" variant="ink" loading={fetcher.state !== "idle"} onClick={print}>
            {copyNext ? t("receipt.printCopy") : t("receipt.print")}
          </Key>
        ) : null}
        <Key as={Link} to="/admin/pos/sell" icon="barcode">
          {t("receipt.backTill")}
        </Key>
        {access.orders ? (
          <Key as={Link} to={`/admin/orders/${receipt.ref}`} icon="receipt">
            {t("receipt.order")}
          </Key>
        ) : null}
      </div>
      {!canPrint ? (
        <div className="pos-noprint mb-4">
          <Notice tone="info">{t("receipt.copyNeedsRight")}</Notice>
        </div>
      ) : null}
      {fetcher.data && !fetcher.data.ok ? (
        <div className="pos-noprint mb-4">
          <Failure message={fetcher.data.message ?? t(`errors.${fetcher.data.code ?? "invalid"}`)} />
        </div>
      ) : null}
      <ReceiptPaper receipt={receipt} copy={copy} />
    </>
  );
}
