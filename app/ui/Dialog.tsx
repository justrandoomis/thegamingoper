import {
  createContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ElementType,
  type FormEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";

import { Icon } from "~/art/Icon";
import { useT } from "~/i18n/react";
import { dematerialize, durations, easings, getMotionTier, materialize } from "~/motion";
import { cx } from "./cx";
import { Select, TextArea } from "./Field";
import { Glass } from "./Glass";
import { IconKey } from "./IconKey";
import { Key } from "./Key";

/**
 * Dialogs (docs/DESIGN.md §9.15) and the modal-layer machinery that <Sheet> shares.
 *
 *   <Dialog open={open} onClose={() => setOpen(false)} title={t("title")} description={t("oneSentence")}
 *           footer={<><Key onClick={close}>{t("back")}</Key><Key onClick={go}>{t("doIt")}</Key></>} />
 *
 *   <ConfirmDialog open={open} onClose={close} tone="destructive"
 *                  title={t("deleteAddressQ")} consequence={t("deleteAddressWhat")} confirmLabel={t("deleteAddress")}
 *                  onConfirm={() => fetcher.submit({ intent: "delete", id }, { method: "post" })} pending={busy} />
 *
 *   Admin, with the impact and a mandatory reason code (CONTRACTS §4: destructive or financial actions):
 *   <ConfirmDialog open … tone="destructive" title=… consequence=… confirmLabel={t("reject")}
 *                  impact={[{ label: t("stock"), value: "−2", negative: true }]}
 *                  reason={{ codes: REJECT_CODES, noteRequired: true, minLength: 10 }}
 *                  onConfirm={({ code, reason }) => fetcher.submit({ code, reason }, { method: "post" })} />
 *
 * Rules: centred, at most 420 wide on phones and 520 from 768, `--r-xl`, opaque paper, a scrim, an optional glass
 * header strip. One sentence that says what will happen, then at most two keys — a neutral key and the action. A
 * destructive action is a neutral key with a red-ink label that states the consequence; the commit (red) key appears
 * in a dialog only when the dialog itself confirms an order step (`tone="commit"`).
 *
 * Behaviour: rendered in a portal (client only — nothing on the server), focus moves in and is trapped, Escape and the
 * scrim close it (`dismissible`), focus returns to the opener, the page behind is `inert` and does not scroll (no
 * layout shift: the scrollbar's gutter is kept). It drops in with 8px of travel and opacity (materialize) and leaves
 * the same way; reduced motion fades. `open` is the state: closing sets it false at once and the panel animates out
 * afterwards — nothing waits for the animation.
 */

/* ───────────────────────────── modal layers (shared by <Dialog> and <Sheet>) ───────────────────────────── */

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

/** Elements Tab can reach inside `container`, in order (visible, not inert, one radio per checked group). */
export function focusablesIn(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => {
    if (element.closest("[inert]") || element.getClientRects().length === 0) return false;
    if (element instanceof HTMLInputElement && element.type === "radio" && !element.checked && element.name) {
      const group = element.form ?? container;
      const checked = group.querySelector(`input[type="radio"][name="${CSS.escape(element.name)}"]:checked`);
      if (checked) return false;
    }
    return true;
  });
}

type Layer = { root: HTMLElement; host: HTMLElement; escape: () => void };

/** Open modal layers, the top one last. Only the top one answers Escape and Tab; everything else is inert. */
const layers: Layer[] = [];
const depthListeners = new Set<() => void>();
/** Elements this module made inert (and only those are released again). */
let inerted: HTMLElement[] = [];
/** The last focusable thing pressed — the opener when the browser does not focus buttons on click (Safari). */
let lastPressed: HTMLElement | null = null;
let installed = false;

function syncInert(): void {
  for (const element of inerted) element.inert = false;
  inerted = [];
  const top = layers[layers.length - 1];
  if (top) {
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement) || child === top.root || child.contains(top.root)) continue;
      if (child.inert || child.hasAttribute("data-overlay-keep")) continue; // the toaster stays live above sheets
      if (child instanceof HTMLScriptElement || child instanceof HTMLStyleElement || child instanceof HTMLTemplateElement) continue;
      child.inert = true;
      inerted.push(child);
    }
  }
  for (const listener of depthListeners) listener();
}

function onLayerKeyDown(event: KeyboardEvent): void {
  const top = layers[layers.length - 1];
  if (!top || event.defaultPrevented) return;
  if (event.key === "Escape") {
    if (event.isComposing) return;
    event.preventDefault();
    top.escape();
    return;
  }
  if (event.key !== "Tab" || event.altKey || event.ctrlKey || event.metaKey) return;
  const items = focusablesIn(top.host);
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (items.length === 0) {
    event.preventDefault();
    (top.host.querySelector<HTMLElement>("[data-layer-panel]") ?? top.host).focus({ preventScroll: true });
    return;
  }
  const index = active ? items.indexOf(active) : -1;
  if (index === -1) {
    // On the panel itself (or somewhere it should not be): enter at the right end.
    event.preventDefault();
    (event.shiftKey ? items[items.length - 1] : items[0]).focus();
  } else if (event.shiftKey && index === 0) {
    event.preventDefault();
    items[items.length - 1].focus();
  } else if (!event.shiftKey && index === items.length - 1) {
    event.preventDefault();
    items[0].focus();
  }
}

function onAnyPointerDown(event: PointerEvent): void {
  lastPressed = event.target instanceof Element ? event.target.closest<HTMLElement>(FOCUSABLE) : null;
}

/** Install the document listeners once (also called by closed overlays, so the opener is known in Safari). */
function installLayers(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;
  document.addEventListener("keydown", onLayerKeyDown);
  document.addEventListener("pointerdown", onAnyPointerDown, { capture: true, passive: true });
}

/** Call in an overlay component that stays mounted while closed. */
export function usePrimeLayers(): void {
  useEffect(installLayers, []);
}

let locks = 0;
let savedRoot: { overflow: string; gutter: string } | null = null;

/** Page scroll off while a modal layer is up, without a layout shift: a classic scrollbar's gutter stays reserved. */
function lockScroll(): void {
  if (locks++ > 0) return;
  const root = document.documentElement;
  savedRoot = { overflow: root.style.getPropertyValue("overflow"), gutter: root.style.getPropertyValue("scrollbar-gutter") };
  if (window.innerWidth - root.clientWidth > 0) root.style.setProperty("scrollbar-gutter", "stable");
  root.style.setProperty("overflow", "hidden");
}

function unlockScroll(): void {
  if (locks === 0 || --locks > 0) return;
  const root = document.documentElement;
  const restore = (property: string, value: string | undefined) => (value ? root.style.setProperty(property, value) : root.style.removeProperty(property));
  restore("overflow", savedRoot?.overflow);
  restore("scrollbar-gutter", savedRoot?.gutter);
  savedRoot = null;
}

export type ModalLayerOptions = {
  /** The portal root (a direct child of <body>) — see useOverlayRoot. */
  root: HTMLElement | null;
  /** The element focus is kept inside (the layer's wrapper). */
  host: HTMLElement | null;
  /** False while the layer animates out: it no longer traps focus or blocks the page. */
  active: boolean;
  onEscape: () => void;
  /** What to focus when it opens. Default: [autofocus] / [data-autofocus], else [data-layer-panel], else the host. */
  initialFocus?: () => HTMLElement | null | undefined;
};

/**
 * One modal layer: pushes itself on the stack, makes everything else inert, locks page scroll, moves focus in, traps
 * Tab, routes Escape to the top layer only, and returns focus to the opener when it deactivates.
 */
export function useModalLayer(options: ModalLayerOptions): void {
  const latest = useRef(options);
  useLayoutEffect(() => {
    latest.current = options;
  });
  const { root, host, active } = options;
  useLayoutEffect(() => {
    if (!root || !host || !active) return;
    installLayers();
    const focused = document.activeElement;
    const opener =
      focused instanceof HTMLElement && focused !== document.body && !root.contains(focused)
        ? focused
        : lastPressed && lastPressed.isConnected && !root.contains(lastPressed)
          ? lastPressed
          : null;
    const layer: Layer = { root, host, escape: () => latest.current.onEscape() };
    layers.push(layer);
    lockScroll();
    syncInert();
    if (!host.contains(document.activeElement)) {
      const target =
        latest.current.initialFocus?.() ??
        host.querySelector<HTMLElement>("[autofocus], [data-autofocus]") ??
        host.querySelector<HTMLElement>("[data-layer-panel]") ??
        host;
      target.focus({ preventScroll: true });
    }
    return () => {
      const index = layers.lastIndexOf(layer);
      if (index >= 0) layers.splice(index, 1);
      unlockScroll();
      syncInert();
      const now = document.activeElement;
      if (opener?.isConnected && (!now || now === document.body || root.contains(now))) opener.focus({ preventScroll: true });
    };
  }, [root, host, active]);
}

function subscribeDepth(listener: () => void): () => void {
  depthListeners.add(listener);
  return () => {
    depthListeners.delete(listener);
  };
}

/** How many modal layers are open (the toaster turns solid above one: two live glass panes per viewport at most). */
export function useOverlayDepth(): number {
  return useSyncExternalStore(
    subscribeDepth,
    () => layers.length,
    () => 0,
  );
}

/**
 * A portal root appended to <body> after hydration (null on the server and during hydration, so nothing overlays
 * the server HTML). `keep` marks it as staying interactive above modal layers (the toaster).
 */
export function useOverlayRoot(keep = false): HTMLElement | null {
  const [element, setElement] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const div = document.createElement("div");
    div.setAttribute("data-overlay", "");
    if (keep) div.setAttribute("data-overlay-keep", "");
    document.body.appendChild(div);
    setElement(div);
    return () => {
      div.remove();
    };
  }, [keep]);
  return element;
}

/** The nearest modal layer's wrapper: menus opened inside a sheet or dialog render into it (same stacking context). */
export const OverlayHostContext = createContext<HTMLElement | null>(null);

const fades = new WeakMap<Element, Animation>();

/** Opacity only (the scrim). Resolves when done or interrupted. */
export function fadeElement(element: HTMLElement, to: 0 | 1): Promise<void> {
  fades.get(element)?.cancel();
  const reduced = getMotionTier() === "reduced";
  const from = Number(getComputedStyle(element).opacity) || 0;
  const animation = element.animate([{ opacity: to === 1 ? Math.min(from, 1) : from }, { opacity: to }], {
    duration: reduced ? 120 : to === 1 ? durations.base : durations.exit,
    easing: reduced ? "linear" : to === 1 ? easings.settle : easings.exit,
    fill: "forwards",
  });
  fades.set(element, animation);
  return animation.finished.then(
    () => undefined,
    () => undefined,
  );
}

/** Mount/unmount with an exit animation: `present` stays true while it leaves; call `exited` when it has gone. */
export function usePresence(open: boolean): [present: boolean, exited: () => void] {
  const [present, setPresent] = useState(open);
  if (open && !present) setPresent(true);
  return [present, () => setPresent(false)];
}

/* ───────────────────────────── <Dialog> ───────────────────────────── */

export type DialogProps = {
  open: boolean;
  /** Asked to close (Escape, scrim, close key): set `open` to false. */
  onClose: () => void;
  /** Names the dialog (h2). Say what it is about: "احذف العنوان؟". */
  title: ReactNode;
  /** The one sentence that says what will happen (aria-describedby). */
  description?: ReactNode;
  children?: ReactNode;
  /** The keys: at most two — a neutral key and the action (the action last). */
  footer?: ReactNode;
  /** "plain" (default): the title on the paper. "glass": a glass header strip with a close key (command palette). */
  header?: "plain" | "glass";
  /** "alertdialog" for confirmations that interrupt (ConfirmDialog uses it for destructive actions). */
  role?: "dialog" | "alertdialog";
  /** Where focus goes when it opens (a ref, or a function read at that moment). Default: [autofocus], else the panel. */
  initialFocus?: RefObject<HTMLElement | null> | (() => HTMLElement | null | undefined);
  /** Escape, the close key and the scrim close it. Default true; pass false while something is in flight. */
  dismissible?: boolean;
  /** The scrim closes it. Default: `dismissible`. */
  scrimDismiss?: boolean;
  /** A round close key in the header. Default: on with header="glass". */
  closeKey?: boolean;
  /** Render the panel as a <form>; the submit key is in `footer`. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  className?: string;
  bodyClassName?: string;
};

export function Dialog(props: DialogProps) {
  usePrimeLayers();
  const [present, exited] = usePresence(props.open);
  if (!present) return null;
  return <DialogLayer {...props} leaving={!props.open} onExited={exited} />;
}

function DialogLayer({
  onClose,
  title,
  description,
  children,
  footer,
  header = "plain",
  role = "dialog",
  initialFocus,
  dismissible = true,
  scrimDismiss,
  closeKey,
  onSubmit,
  className,
  bodyClassName,
  leaving,
  onExited,
}: DialogProps & { leaving: boolean; onExited: () => void }) {
  const t = useT("ui");
  const root = useOverlayRoot();
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  const panel = useRef<HTMLElement | null>(null);
  const scrim = useRef<HTMLDivElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();
  const exitedRef = useRef(onExited);
  useLayoutEffect(() => {
    exitedRef.current = onExited;
  });

  const close = () => {
    if (dismissible) onClose();
  };
  useModalLayer({
    root,
    host,
    active: !leaving,
    onEscape: close,
    initialFocus: () => (typeof initialFocus === "function" ? initialFocus() : initialFocus?.current),
  });

  // Motion: in on mount, out when `leaving`; the panel is unmounted only after it has gone.
  useLayoutEffect(() => {
    const element = panel.current;
    const backdrop = scrim.current;
    if (!host || !element || !backdrop) return;
    if (!leaving) {
      void materialize(element, { from: { x: window.innerWidth / 2, y: 0 } });
      void fadeElement(backdrop, 1);
      return;
    }
    let cancelled = false;
    void Promise.all([dematerialize(element), fadeElement(backdrop, 0)]).then(() => {
      if (!cancelled) exitedRef.current();
    });
    return () => {
      cancelled = true;
    };
  }, [host, leaving]);

  if (!root) return null;
  const showClose = closeKey ?? header === "glass";
  const Panel: ElementType = onSubmit ? "form" : "section";
  const heading = (
    <h2 id={titleId} className="type-sub min-w-0 flex-1 text-ink">
      {title}
    </h2>
  );
  const closeButton = showClose ? <IconKey icon="x" label={t("close")} size="sm" onClick={close} disabled={!dismissible} /> : null;

  return createPortal(
    <OverlayHostContext value={host}>
      <div ref={setHost} className="fixed inset-0 z-(--z-dialog) grid place-items-center overflow-y-auto p-(--gutter)" inert={leaving || undefined}>
        <div ref={scrim} className="fixed inset-0 bg-(--scrim) opacity-0" aria-hidden="true" onClick={(scrimDismiss ?? dismissible) ? close : undefined} />
        <Panel
          ref={(element: HTMLElement | null) => {
            panel.current = element;
          }}
          role={role}
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descriptionId : undefined}
          tabIndex={-1}
          data-layer-panel=""
          noValidate={onSubmit ? true : undefined}
          onSubmit={onSubmit}
          className={cx(
            "relative flex max-h-[calc(100dvh-2*var(--gutter))] w-full max-w-[420px] flex-col overflow-hidden rounded-xl bg-paper text-ink shadow-e5 outline-none md:max-w-[520px]",
            className,
          )}
        >
          {header === "glass" ? (
            <Glass className="relative z-[1] flex shrink-0 items-center gap-3 rounded-t-xl py-2 ps-5 pe-2 sm:ps-6">
              {heading}
              {closeButton}
            </Glass>
          ) : (
            <div className="flex shrink-0 items-start gap-3 ps-5 pe-3 pt-5 sm:ps-6 sm:pt-6">
              {heading}
              {closeButton}
            </div>
          )}
          <div className={cx("min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 pb-2 pt-2 sm:px-6", bodyClassName)}>
            {description ? (
              <p id={descriptionId} className="type-body text-ink">
                {description}
              </p>
            ) : null}
            {children}
          </div>
          {footer ? <div className="flex shrink-0 flex-wrap items-center justify-end gap-3 px-5 pb-5 pt-3 sm:px-6 sm:pb-6">{footer}</div> : null}
        </Panel>
      </div>
    </OverlayHostContext>,
    root,
  );
}

/* ───────────────────────────── <ConfirmDialog> ───────────────────────────── */

export type ImpactRow = {
  /** What changes ("المخزون في بغداد"). */
  label: ReactNode;
  /** By how much, with its unit ("−2 قطعة", "−445,000 د.ع"). Shown tabular and isolated. */
  value: ReactNode;
  /** A decrease or a refund: minus sign in the value and red-ink text. */
  negative?: boolean;
};

export type ReasonCode = { value: string; label: string };

export type ReasonOptions = {
  /** Label of the note field. Default "السبب" (or "ملاحظة" next to a code list). */
  label?: string;
  hint?: ReactNode;
  /** Shortest acceptable note, in characters. Default 3 (the services' minimum). */
  minLength?: number;
  maxLength?: number;
  /** A mandatory reason code (a native select). */
  codes?: readonly ReasonCode[];
  codeLabel?: string;
  /** The note is mandatory. Default: yes without codes, no with codes. */
  noteRequired?: boolean;
};

export type ConfirmValues = { reason: string; code: string | null };

export type ConfirmDialogProps = {
  open: boolean;
  onClose: () => void;
  /** The question ("احذف العنوان؟"). */
  title: ReactNode;
  /** One sentence: what will happen, plainly ("يُحذف العنوان من حسابك ولا يمكن استرجاعه."). */
  consequence: ReactNode;
  /** Says what the key does — the same words as the action that opened it ("احذف العنوان"). Never "موافق". */
  confirmLabel: string;
  /** Default "ارجع". */
  cancelLabel?: string;
  /** neutral (default) · destructive (neutral key, red-ink label) · commit (the red key — only for order steps). */
  tone?: "neutral" | "destructive" | "commit";
  /** The stock or money this changes, shown before confirming (admin). Rows or any node. */
  impact?: ReactNode | readonly ImpactRow[];
  /** Ask for a typed reason (true) or a reason code + note. */
  reason?: boolean | ReasonOptions;
  /** The confirm request is in flight: the key spins, nothing closes it. */
  pending?: boolean;
  /** What went wrong with the request, as a sentence (red-ink, announced). */
  error?: ReactNode;
  /** Validated values. The dialog stays open: close it when the request has succeeded. */
  onConfirm: (values: ConfirmValues) => void;
  /** More content between the consequence and the reason. */
  children?: ReactNode;
};

function isImpactRows(value: unknown): value is readonly ImpactRow[] {
  return Array.isArray(value) && value.length > 0 && value.every((row) => typeof row === "object" && row !== null && !("$$typeof" in row) && "label" in row && "value" in row);
}

export function ConfirmDialog({
  open,
  onClose,
  title,
  consequence,
  confirmLabel,
  cancelLabel,
  tone = "neutral",
  impact,
  reason,
  pending = false,
  error,
  onConfirm,
  children,
}: ConfirmDialogProps) {
  const t = useT("ui-overlays");
  const options: ReasonOptions | null = reason === true ? {} : reason ? reason : null;
  const codes = options?.codes && options.codes.length > 0 ? options.codes : null;
  const noteRequired = options ? (options.noteRequired ?? codes === null) : false;
  const min = options?.minLength ?? 3;

  const [note, setNote] = useState("");
  const [code, setCode] = useState("");
  const [tried, setTried] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setNote("");
      setCode("");
      setTried(false);
    }
  }

  const codeRef = useRef<HTMLSelectElement | null>(null);
  const noteRef = useRef<HTMLTextAreaElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  // The first field; without fields, the least destructive key for a destructive action (WAI-ARIA alertdialog).
  const focusTarget = () => (codes ? codeRef.current : options ? noteRef.current : tone === "destructive" ? cancelRef.current : confirmRef.current);

  const codeError = codes && !code ? t("dialog.codeMissing") : undefined;
  const noteError = noteRequired && note.trim().length < min ? t("dialog.reasonShort", { min }) : undefined;
  const dirty = note.trim() !== "" || code !== "";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    setTried(true);
    if (codeError || noteError) {
      (codeError ? codeRef.current : noteRef.current)?.focus();
      return;
    }
    onConfirm({ reason: note.trim(), code: codes ? code : null });
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      description={consequence}
      role={tone === "destructive" ? "alertdialog" : "dialog"}
      initialFocus={focusTarget}
      dismissible={!pending}
      scrimDismiss={!pending && !dirty}
      onSubmit={submit}
      footer={
        <>
          <Key ref={cancelRef} onClick={onClose} disabled={pending} className="flex-1 sm:flex-none">
            {cancelLabel ?? t("dialog.cancel")}
          </Key>
          <Key
            ref={confirmRef}
            type="submit"
            variant={tone === "commit" ? "commit" : "clay"}
            loading={pending}
            className={cx("flex-1 sm:flex-none", tone === "destructive" && "enabled:[--on:var(--red-ink)]")}
          >
            {confirmLabel}
          </Key>
        </>
      }
    >
      {children}
      {impact ? (
        isImpactRows(impact) ? (
          <div className="mt-4 rounded-lg bg-niche px-4 py-3">
            <p className="type-caption text-ink-2">{t("dialog.impact")}</p>
            <dl className="mt-1 grid gap-1">
              {impact.map((row, index) => (
                <div key={index} className="flex items-baseline justify-between gap-4">
                  <dt className="type-label text-ink">{row.label}</dt>
                  <dd className={cx("type-data whitespace-nowrap", row.negative ? "text-red-ink" : "text-ink")}>
                    <bdi>{row.value}</bdi>
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        ) : (
          <div className="mt-4">{impact}</div>
        )
      ) : null}
      {options ? (
        <div className="mt-4 grid gap-4">
          {codes ? (
            <Select
              ref={codeRef}
              name="reason_code"
              label={options.codeLabel ?? t("dialog.code")}
              required
              placeholder={t("dialog.codePick")}
              options={codes}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              error={tried ? codeError : undefined}
              disabled={pending}
            />
          ) : null}
          <TextArea
            ref={noteRef}
            name="reason"
            label={options.label ?? (codes ? t("dialog.note") : t("dialog.reason"))}
            required={noteRequired}
            optional={!noteRequired}
            hint={options.hint}
            value={note}
            maxLength={options.maxLength ?? 500}
            onChange={(event) => setNote(event.target.value)}
            error={tried ? noteError : undefined}
            readOnly={pending}
          />
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="mt-4 flex items-start gap-1.5 text-[12.5px] font-medium leading-[1.6] text-red-ink">
          <Icon name="warning-circle" size={16} className="mt-[2.5px]" />
          <span>{error}</span>
        </p>
      ) : null}
    </Dialog>
  );
}
