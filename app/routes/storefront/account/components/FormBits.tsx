import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";

import { Icon, type IconName } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { FormErrorSummary, TextField, type FormError } from "~/ui/Field";
import { IconKey } from "~/ui/IconKey";
import { Key, type KeyProps } from "~/ui/Key";
import { Note } from "~/ui/Note";
import { useOnline } from "~/ui/OfflineBanner";

/** What an account action answers: a failure with sentences, or a success with an optional message. */
export type ActionAnswer = { ok: false; code: string; message?: string; fields?: Record<string, string>; retryAfterSec?: number } | { ok: true; message?: string; [key: string]: unknown };

/** The field error sentence for `name`, when the answer is a failure. */
export function fieldError(answer: ActionAnswer | null | undefined, name: string): string | undefined {
  return answer && answer.ok === false ? answer.fields?.[name] : undefined;
}

/**
 * Gives focus a place to land after a control removed itself — a cancelled request's «ألغِ الطلب», a deleted card, a
 * «علّمه كمقروء» key, a signed-out device row. Without it focus falls to <body> and a keyboard or screen-reader user
 * starts again at the top of the page (WCAG 2.4.3). Only lost focus is moved: it waits (a few frames) while a closing
 * dialog still holds focus, moves it to `id` (an element with tabIndex -1 when it is not a control) once focus is on
 * <body>, and leaves it alone if the shopper has already put it somewhere else.
 */
export function rescueFocus(id: string, frames = 45): void {
  if (typeof window === "undefined") return;
  // The control that is about to go: while it still holds focus, wait for it to leave.
  const origin = document.activeElement;
  let left = frames;
  const step = () => {
    const active = document.activeElement;
    const lost = !active || active === document.body || !active.isConnected;
    const waiting = !lost && (active === origin || active?.closest("[role=dialog], [role=alertdialog]") !== null);
    const target = document.getElementById(id);
    if (lost && target) {
      target.focus();
      if (document.activeElement === target) return;
    } else if (!lost && !waiting) {
      return;
    }
    if (--left > 0) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/**
 * A sentence about a whole page or form, as the kit's note (v2.1 G5: a neutral soft card, the icon in a circle — tinted
 * only where the tone matters — a short bold title, muted text; an icon AND words, never a colour alone): what happened
 * (ok), what to know (info), what to watch (warn). `flat` inside another card. A status region: it is read out when it
 * appears after an action.
 */
export function Notice({
  tone = "info",
  title,
  icon,
  action,
  flat = false,
  children,
  className,
}: {
  tone?: "ok" | "info" | "warn";
  title?: ReactNode;
  icon?: IconName;
  action?: ReactNode;
  flat?: boolean;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div role="status" className={cx("grid min-w-0", className)}>
      <Note tone={tone === "ok" ? "success" : tone === "warn" ? "warning" : "neutral"} title={title} icon={icon} action={action} variant={flat ? "flat" : "card"}>
        {children}
      </Note>
    </div>
  );
}

/**
 * A failed submit (Design System v2 §4.9): the form's own sentence in the kit's error block (role="alert", danger, an
 * icon and words), and focus moves to it so keyboard and screen-reader users land on it. With field errors, the block
 * lists them as links to the fields (FormErrorSummary) and focus moves to the first invalid field instead.
 */
export function FormFailure({ answer, fields, className }: { answer: ActionAnswer | null | undefined; fields?: readonly { name: string; id: string; label: ReactNode }[]; className?: string }) {
  const t = useT("account");
  const ref = useRef<HTMLDivElement>(null);
  const failed = answer && answer.ok === false ? answer : null;
  // Only a validation failure lists fields; any other refusal (a wrong password, a limit) is its own sentence.
  const listed: FormError[] = failed?.code === "invalid" && fields ? fields.filter((field) => failed.fields?.[field.name]).map((field) => ({ id: field.id, label: field.label })) : [];
  useEffect(() => {
    if (!failed) return;
    if (listed.length > 0) document.getElementById(listed[0].id)?.focus();
    else ref.current?.focus();
    // once per answer
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed]);
  if (!failed) return null;
  if (listed.length > 0) return <FormErrorSummary errors={listed} className={className} />;
  const text = failed.code === "invalid" ? t("common.formError") : (failed.message ?? t("common.formError"));
  return (
    <div ref={ref} tabIndex={-1} role="alert" className={cx("form-alert outline-none", className)}>
      <p className="flex items-start gap-1.5">
        <Icon name="warning-circle" size={20} className="mt-0.5 shrink-0" />
        <span>{text}</span>
      </p>
    </div>
  );
}

/**
 * A key that sends a form. It spins while the request is out (keeping its width), and goes flat with the reason beside
 * it when the device is offline (§6.17: keys that need the network say why they cannot work). Secondary by default; the
 * page passes `variant="primary"` for its one forward action.
 */
export function SubmitKey({ pending, children, variant = "secondary", className, ...rest }: Omit<KeyProps<"button">, "type" | "loading"> & { pending: boolean }) {
  const t = useT("account");
  const online = useOnline();
  return (
    <span className={cx("inline-grid justify-items-start gap-1", className)}>
      <Key {...rest} type="submit" variant={variant} loading={pending} disabled={!online || rest.disabled}>
        {children}
      </Key>
      {!online ? (
        <span className="flex items-center gap-1.5 type-xs text-ink-2" role="status">
          <Icon name="wifi-slash" size={16} />
          {t("common.offline")}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Offline: the reason beside controls that save at once (switches, chips, row actions). A fetcher request that cannot
 * leave the device would end on the page's error panel, so those controls are disabled while offline and this says
 * why (the shell's banner says it for the whole page too).
 */
export function OfflineNote({ className }: { className?: string }) {
  const t = useT("account");
  const online = useOnline();
  if (online) return null;
  return (
    <p role="status" className={cx("flex items-center gap-1.5 type-xs text-ink-2", className)}>
      <Icon name="wifi-slash" size={16} />
      {t("common.offline")}
    </p>
  );
}

/** A password field with a show / hide icon button at its inline end (a held toggle: the eye fills). */
export function PasswordField(props: Omit<ComponentProps<typeof TextField>, "type" | "end" | "ltr">) {
  const t = useT("account");
  const [shown, setShown] = useState(false);
  return (
    <TextField
      {...props}
      type={shown ? "text" : "password"}
      ltr
      end={<IconKey icon={shown ? "eye-slash" : "eye"} label={shown ? t("common.hidePassword") : t("common.showPassword")} variant="plain" held={shown} onClick={() => setShown((value) => !value)} />}
    />
  );
}

/** A small key that copies a value and says «نُسخ» for a moment (order numbers, transfer details). */
export function CopyKey({ value, label, className }: { value: string; label: string; className?: string }) {
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
    <Key size="sm" icon={copied ? "check" : "copy"} onClick={copy} aria-label={label} className={className}>
      <span aria-live="polite">{copied ? t("common.copied") : t("common.copy")}</span>
    </Key>
  );
}
