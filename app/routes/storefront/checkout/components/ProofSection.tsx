import { useId, useRef, useState } from "react";
import { useRevalidator } from "react-router";

import { useFormat, useT } from "~/i18n/react";
import type { OrderView } from "~/server/services/orders/types";
import { TextArea, TextField } from "~/ui/Field";
import { fillNodes } from "~/ui/PriceTag";
import { ProofUploader, sendProof, type ProofUploadControls, type ProofUploadResult } from "~/ui/ProofUploader";
import { parseAmountInput } from "../checkout-form";

/** The picture the shopper just sent, kept for this visit (a local object URL — the stored file is private). */
export type JustSent = { previewUrl: string; name: string };

/** Codes after which the page reloads the order: it moved on (a proof arrived, the window closed, it is gone). */
const STALE = new Set(["proof_not_expected", "payment_window_closed", "not_found"]);

/**
 * The transfer proof (brief §4 C/D, DESIGN.md §9.18): the amount the shopper sent (required — typed, never filled
 * in for them), the transfer's reference and a note (optional), then the uploader. The uploader stays disabled until
 * the amount is a whole number of dinars, with the reason beside it; a different amount from the one due is allowed
 * but said plainly (staff decide). The file goes to POST /api/upload/proof with the order reference and the
 * confirmation token (or the signed-in owner's session); the answer is `{ ok }` only — the page then reloads the
 * order, which now says "بانتظار التحقق". After a rejection the same section comes back with the reviewer's reason.
 */
export function ProofSection({ order, access, onSent, headingLevel = 3 }: { order: OrderView; access: { ref: string; token: string | null }; onSent: (sent: JustSent) => void; headingLevel?: 2 | 3 }) {
  const t = useT("checkout");
  const f = useFormat();
  const revalidator = useRevalidator();
  const headingId = useId();
  const reasonId = useId();
  const H = `h${headingLevel}` as const;
  const due = order.payment.amountDueIqd;
  const [amount, setAmount] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");

  const parsed = parseAmountInput(amount);
  const amountIssue = amount.trim() === "" ? "required" : parsed === null ? "invalid" : parsed > 1_000_000_000 ? "too_big" : null;
  const latest = useRef({ parsed, reference, note });
  latest.current = { parsed, reference, note };

  const upload = async (file: File, controls: ProofUploadControls): Promise<ProofUploadResult> => {
    const { parsed: declared, reference: ref, note: text } = latest.current;
    if (declared === null) return { ok: false, code: "invalid" };
    const fields: Record<string, string> = { ref: access.ref, declaredAmountIqd: String(declared) };
    if (access.token) fields.t = access.token;
    if (ref.trim()) fields.reference = ref.trim();
    if (text.trim()) fields.note = text.trim();
    const result = await sendProof("/api/upload/proof", fields, file, controls);
    if (result.ok) onSent({ previewUrl: URL.createObjectURL(file), name: file.name });
    else if (STALE.has(result.code)) void revalidator.revalidate();
    return result;
  };

  const rejected = order.payment.proof.status === "rejected";
  const showAmountError = amountTouched && amountIssue !== null;

  return (
    <section aria-labelledby={headingId} className="co-card grid gap-4">
      <div className="grid gap-1">
        <H id={headingId} className="type-h3 text-ink">
          {rejected ? t("proof.headingAgain") : t("proof.heading")}
        </H>
        <p className="type-xs text-ink-2">{t("proof.lead")}</p>
      </div>
      <TextField
        id="proof-amount"
        name="declaredAmountIqd"
        label={t("proof.amount")}
        required
        inputMode="numeric"
        autoComplete="off"
        enterKeyHint="done"
        value={amount}
        onChange={(event) => setAmount(event.currentTarget.value)}
        onBlur={() => setAmountTouched(true)}
        end={<span className="type-xs text-ink-2">{t("proof.currency")}</span>}
        hint={fillNodes(t("proof.amountHint"), { due: <bdi className="nums font-semibold">{f.iqd(due)}</bdi> })}
        error={showAmountError ? t(`proof.amountErrors.${amountIssue}`) : undefined}
      />
      {parsed !== null && parsed !== due ? (
        <p className="-mt-2 type-xs-strong text-warn" aria-live="polite">
          {fillNodes(t("proof.amountDiffers"), { due: <bdi className="nums">{f.iqd(due)}</bdi> })}
        </p>
      ) : null}
      <TextField id="proof-reference" name="reference" label={t("proof.reference")} optional ltr maxLength={100} autoComplete="off" value={reference} onChange={(event) => setReference(event.currentTarget.value)} hint={t("proof.referenceHint")} />
      <TextArea id="proof-note" name="note" label={t("proof.note")} optional maxLength={500} rows={2} value={note} onChange={(event) => setNote(event.currentTarget.value)} />
      <div className="grid gap-2">
        <ProofUploader
          onUpload={upload}
          disabled={amountIssue !== null}
          status={rejected ? { state: "rejected", note: order.payment.proof.rejectReason } : null}
          onUploaded={() => void revalidator.revalidate()}
        />
        {amountIssue !== null ? (
          <p id={reasonId} className="type-xs text-ink-2">
            {t("proof.amountFirst")}
          </p>
        ) : null}
      </div>
    </section>
  );
}
