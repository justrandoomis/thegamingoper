import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { TextField } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key, type KeyProps } from "~/ui/Key";
import { useOnline } from "~/ui/OfflineBanner";

/** What an account action answers: a failure with sentences, or a success with an optional message. */
export type ActionAnswer = { ok: false; code: string; message?: string; fields?: Record<string, string>; retryAfterSec?: number } | { ok: true; message?: string; [key: string]: unknown };

/** The field error sentence for `name`, when the answer is a failure. */
export function fieldError(answer: ActionAnswer | null | undefined, name: string): string | undefined {
  return answer && answer.ok === false ? answer.fields?.[name] : undefined;
}

/**
 * A sentence about a whole form: what went wrong (red-ink, announced at once) or what happened (ok). Never a colour
 * alone — an icon and words. Focus moves to a failure so keyboard and screen-reader users land on it.
 */
export function FormNotice({ tone, children, focus = false, className }: { tone: "bad" | "ok" | "info" | "warn"; children: ReactNode; focus?: boolean; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus) ref.current?.focus();
  }, [focus, children]);
  const icon = tone === "bad" ? "warning-circle" : tone === "ok" ? "check-circle" : tone === "warn" ? "warning" : "info";
  return (
    <div
      ref={ref}
      tabIndex={focus ? -1 : undefined}
      role={tone === "bad" ? "alert" : "status"}
      className={cx(
        "flex items-start gap-2 rounded-md p-3 type-label outline-none",
        tone === "bad" ? "border-[1.5px] border-red-ink bg-paper text-red-ink" : "panel--paper text-ink",
        className,
      )}
    >
      <Icon name={icon} size={20} className={cx("mt-0.5 shrink-0", tone === "ok" ? "text-ok" : tone === "warn" ? "text-warn" : tone === "info" ? "text-info" : undefined)} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/** The failure sentence of an answer (the form-level one), or the generic "check the marked fields". */
export function AnswerNotice({ answer, className }: { answer: ActionAnswer | null | undefined; className?: string }) {
  const t = useT("account");
  if (!answer || answer.ok !== false) return null;
  const hasFields = answer.fields && Object.keys(answer.fields).length > 0;
  const text = answer.code === "invalid" && hasFields ? t("common.formError") : (answer.message ?? t("common.formError"));
  return (
    <FormNotice tone="bad" focus className={className}>
      {text}
    </FormNotice>
  );
}

/**
 * A key that sends a form. It spins while the request is out, and goes flat with the reason beside it when the device
 * is offline (§9.16: keys that need the network say why they cannot work).
 */
export function SubmitKey({ pending, children, variant = "ink", className, ...rest }: Omit<KeyProps<"button">, "type" | "loading"> & { pending: boolean }) {
  const t = useT("account");
  const online = useOnline();
  return (
    <span className={cx("inline-grid justify-items-start gap-1", className)}>
      <Key {...rest} type="submit" variant={variant} loading={pending} disabled={!online || rest.disabled}>
        {children}
      </Key>
      {!online ? (
        <span className="flex items-center gap-1.5 type-caption text-ink-2" role="status">
          <Icon name="wifi-slash" size={16} />
          {t("common.offline")}
        </span>
      ) : null}
    </span>
  );
}

/** A password field with a show / hide key at its inline end. */
export function PasswordField(props: Omit<ComponentProps<typeof TextField>, "type" | "end" | "ltr">) {
  const t = useT("account");
  const [shown, setShown] = useState(false);
  return (
    <TextField
      {...props}
      type={shown ? "text" : "password"}
      ltr
      end={<IconKey icon={shown ? "eye-slash" : "eye"} label={shown ? t("common.hidePassword") : t("common.showPassword")} size="sm" variant="quiet" held={shown} onClick={() => setShown((value) => !value)} />}
    />
  );
}

/** A small key that copies a value and says "copied" for a moment (transfer details). */
export function CopyKey({ value, label }: { value: string; label: string }) {
  const t = useT("account");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <Key size="sm" icon={copied ? "check" : "copy"} onClick={copy} aria-label={label} aria-live="polite">
      {copied ? t("common.copied") : t("common.copy")}
    </Key>
  );
}
