/**
 * The confirm-with-reason dialog of the purchasing module (blueprint uxRules: dangerous actions need a confirmation and
 * a reason, and show their stock and financial impact first). Posts to the page's action through a fetcher, stays open
 * while the request runs, shows the server's sentence on failure, and closes with a toast on success.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { useFetcher } from "react-router";

import { ConfirmDialog, type ImpactRow, type ReasonOptions } from "~/ui/Dialog";
import { toast } from "~/ui/toast-store";

export type ActionData = { ok: boolean; message?: string; code?: string; fields?: Record<string, string>; intent?: string };

export function ActionDialog({
  open,
  onClose,
  title,
  consequence,
  confirmLabel,
  tone = "neutral",
  impact,
  reason,
  fields,
  extra,
  action,
  successMessage,
  children,
  fetcherKey,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  consequence: ReactNode;
  confirmLabel: string;
  tone?: "neutral" | "destructive" | "commit";
  impact?: ReactNode | readonly ImpactRow[];
  reason?: boolean | ReasonOptions;
  /** Posted with the reason: intent, ids, idempotency key… */
  fields: Record<string, string>;
  /** Read at submit time (inputs rendered as children, e.g. a location or an amount). */
  extra?: () => Record<string, string>;
  action?: string;
  /** The toast after success (default: the server's message). */
  successMessage?: string;
  children?: ReactNode;
  fetcherKey?: string;
}) {
  const fetcher = useFetcher<ActionData>({ key: fetcherKey });
  const handled = useRef<ActionData | undefined>(undefined);
  useEffect(() => {
    const result = fetcher.data;
    if (!result || fetcher.state !== "idle" || handled.current === result) return;
    handled.current = result;
    if (result.ok) {
      toast.success(result.message ?? successMessage ?? "");
      onClose();
    }
  }, [fetcher.data, fetcher.state, onClose, successMessage]);
  const failed = fetcher.data && !fetcher.data.ok && fetcher.state === "idle" && handled.current === fetcher.data ? fetcher.data : null;
  const error = failed ? (failed.message ?? Object.values(failed.fields ?? {})[0] ?? failed.code) : undefined;

  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title={title}
      consequence={consequence}
      confirmLabel={confirmLabel}
      tone={tone}
      impact={impact}
      reason={reason}
      pending={fetcher.state !== "idle"}
      error={error}
      onConfirm={({ reason: note }) => {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key, value);
        for (const [key, value] of Object.entries(extra?.() ?? {})) form.set(key, value);
        if (reason) form.set("reason", note);
        fetcher.submit(form, { method: "post", action });
      }}
    >
      {children}
    </ConfirmDialog>
  );
}
