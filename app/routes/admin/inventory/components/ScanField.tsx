/**
 * The scan field of the inventory pages: a keyboard-wedge barcode / QR reader (or a person) types a code and
 * presses Enter. With JavaScript, Enter looks the code up (GET /admin/inventory/scan?code=…, the module's resource
 * route: a SKU, a barcode, a serial number for those who may see serials, or a location) and hands the result to
 * `onHit` instead of submitting the form; the field keeps focus for the next scan. Without JavaScript it is a
 * plain text field of its form and the server resolves the code on submit.
 */
import { useRef, useState, type KeyboardEvent } from "react";

import { TextField } from "~/ui/Field";
import { useInvT } from "./kit";

export type ScanHitView =
  | { kind: "variant"; variant: { id: string; sku: string; name: string; trackSerials: boolean; barcode: string | null }; matchedBy: "sku" | "barcode"; standardCostIqd?: number | null }
  | { kind: "serial"; serialId: string; serial: string; status: string; variant: { id: string; sku: string; name: string; trackSerials: boolean }; locationId: string | null; locationCode: string | null }
  | { kind: "serial_hidden" }
  | { kind: "location"; location: { id: string; code: string; name: string; path: string; level: string; isActive: boolean } }
  | { kind: "none" };

export async function lookupScan(code: string): Promise<ScanHitView> {
  const response = await fetch(`/admin/inventory/scan?code=${encodeURIComponent(code)}`, { headers: { Accept: "application/json" }, credentials: "same-origin" });
  // A failed lookup (signed out, refused, server error) is not "no such code": the field says the lookup failed.
  if (!response.ok) throw new Error(`scan lookup failed: ${response.status}`);
  return (await response.json()) as ScanHitView;
}

export function ScanField({
  name,
  label,
  hint,
  onHit,
  keepValue = false,
  autoFocus = false,
  defaultValue,
  error,
  className,
}: {
  name: string;
  label: string;
  hint?: string;
  /** Called with what the code is; return a message to show under the field (or nothing). */
  onHit: (hit: ScanHitView, code: string) => string | void | Promise<string | void>;
  /** Keep the code in the field after a scan (the receiving form submits it). */
  keepValue?: boolean;
  autoFocus?: boolean;
  defaultValue?: string;
  error?: string;
  className?: string;
}) {
  const t = useInvT();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  const onKeyDown = async (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    const code = event.currentTarget.value.trim();
    if (!code || busy) return;
    setBusy(true);
    try {
      const hit = await lookupScan(code);
      const said = await onHit(hit, code);
      setMessage(said || null);
      if (!keepValue && input.current) input.current.value = "";
    } catch {
      setMessage(t("common.loadFailed"));
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  return (
    <div className={className}>
      <TextField
        ref={input}
        name={name}
        label={label}
        hint={message ?? hint}
        error={error}
        ltr
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        enterKeyHint="search"
        autoFocus={autoFocus}
        defaultValue={defaultValue}
        aria-busy={busy || undefined}
        onKeyDown={onKeyDown}
      />
      <p className="sr-only" role="status" aria-live="polite">
        {busy ? t("scan.searching") : (message ?? "")}
      </p>
    </div>
  );
}
