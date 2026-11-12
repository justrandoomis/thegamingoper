import { useEffect, useRef, useState } from "react";

import { useT } from "~/i18n/react";
import { Key } from "~/ui/Key";

/**
 * One-tap copy (brief §4 "one-tap copy", Design System v2 §4.24): a 40px secondary key that copies `value` and shows a
 * check and «نُسخ» for two seconds, said through a polite live region. Where the Clipboard API is missing or refused,
 * the text is copied through a temporary selection; if even that fails the key says so («انسخه يدوياً») — it never
 * claims a copy that did not happen. `text` replaces the idle word «انسخ» («انسخ رابط الطلب»).
 */
export function CopyKey({ value, label, text }: { value: string; /** What is copied, for the accessible name ("رقم البطاقة"). */ label: string; text?: string }) {
  const t = useT("checkout");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    let ok = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(value);
        ok = true;
      }
    } catch {
      ok = false;
    }
    if (!ok) ok = copyBySelection(value);
    setState(ok ? "copied" : "failed");
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState("idle"), 2000);
  };

  return (
    <span className="inline-flex shrink-0 items-center">
      <Key size="sm" icon={state === "copied" ? "check" : text ? "link" : "copy"} onClick={() => void copy()} aria-label={text ? undefined : t("copy.named", { what: label })}>
        {state === "copied" ? t("copy.done") : state === "failed" ? t("copy.failed") : (text ?? t("copy.key"))}
      </Key>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied" ? t("copy.announce", { what: label }) : state === "failed" ? t("copy.failed") : ""}
      </span>
    </span>
  );
}

/** The old way: a hidden textarea, selected and copied. True when the browser says it copied. */
function copyBySelection(value: string): boolean {
  if (typeof document === "undefined") return false;
  const area = document.createElement("textarea");
  area.value = value;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  area.style.insetBlockStart = "0";
  document.body.appendChild(area);
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  area.remove();
  return ok;
}
