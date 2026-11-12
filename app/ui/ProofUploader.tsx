import { useEffect, useId, useReducer, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from "react";

import { Icon } from "~/art/Icon";
import { useFormat, useT } from "~/i18n/react";
import { isolate } from "./BidiText";
import { cx } from "./cx";
import { Key } from "./Key";
import { Status } from "./Tag";
import { TextLink } from "./TextLink";

/**
 * The transfer-proof uploader (Design System v2 §4.24; brief §4 C/D). A paper drop area (--r-lg, a 1.5px dashed
 * control line) — drag a
 * photo onto it, choose one, or take one with the camera. The file is checked here first (type and size, the same
 * limits as the server: JPEG, PNG or WebP up to 8 MB — the server decides again from the bytes), previewed, then
 * handed to `onUpload` — the ONLY way this component talks to anything:
 *
 *   <ProofUploader
 *     onUpload={(file, { signal, onProgress }) => sendProof("/api/upload/proof", { ref, token }, file, { signal, onProgress })}
 *     status={order.proof && { state: order.proof.status, note: order.proof.reviewNote }} />
 *
 * States: empty · dragging · uploading (file name, an ink progress bar, the percentage, "ألغِ") · interrupted
 * ("توقّف الرفع عند 60%." + "أكمل الرفع": the same file is sent again — from where it stopped only if your
 * `onUpload` can resume) · failed (the reason in red-ink words + a retry key when retrying can help) · uploaded
 * (thumbnail, file name, "استبدل الصورة"). `status` adds the review state: submitted (warn "بانتظار التحقق" and
 * "استلمنا صورة الحوالة. نراجعها ثم نؤكد طلبك."), approved (ok, nothing to replace) or rejected (bad, the reviewer's
 * reason, and the uploader ready again). The order is never shown as paid here: that is a person's decision.
 */
export const PROOF_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** The server's limit (MAX_IMAGE_BYTES in ~/server/uploads.server). */
export const PROOF_MAX_BYTES = 8 * 1024 * 1024;

export type ProofFileInfo = { name: string; size: number; type: string };
export type ProofProblem = "empty" | "type" | "size" | "corrupt" | "dimensions" | "network" | "rate_limited" | "server";
export type ProofStatus = { state: "submitted" | "approved" | "rejected"; note?: string | null };

export type ProofUploadResult = { ok: true; previewUrl?: string | null } | { ok: false; code: string };
export type ProofUploadControls = { signal: AbortSignal; onProgress: (fraction: number) => void };

export type ProofState =
  | { phase: "idle"; problem: "empty" | "type" | "size" | null; file: ProofFileInfo | null; cancelled: boolean }
  | { phase: "uploading"; file: ProofFileInfo; progress: number }
  | { phase: "interrupted"; file: ProofFileInfo; progress: number }
  | { phase: "failed"; file: ProofFileInfo; problem: ProofProblem; retry: boolean }
  | { phase: "uploaded"; file: ProofFileInfo; previewUrl: string | null };

export type ProofAction =
  | { type: "rejected"; file: ProofFileInfo; problem: "empty" | "type" | "size" }
  | { type: "start"; file: ProofFileInfo }
  | { type: "progress"; fraction: number }
  | { type: "done"; previewUrl: string | null }
  | { type: "fail"; code: string }
  | { type: "cancel" }
  | { type: "reset" };

export const PROOF_IDLE: Extract<ProofState, { phase: "idle" }> = { phase: "idle", problem: null, file: null, cancelled: false };

const EXTENSION_TYPES: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };

/** Check a chosen file before anything is sent. Pure. Some browsers give no type: the extension stands in. */
export function checkProofFile(file: ProofFileInfo, options: { maxBytes?: number; types?: readonly string[] } = {}): "empty" | "type" | "size" | null {
  if (!(file.size > 0)) return "empty";
  const declared = file.type.toLowerCase() === "image/jpg" ? "image/jpeg" : file.type.toLowerCase();
  const extension = /\.([a-z0-9]+)$/i.exec(file.name)?.[1]?.toLowerCase() ?? "";
  const type = declared || EXTENSION_TYPES[extension] || "";
  if (!(options.types ?? PROOF_TYPES).includes(type)) return "type";
  if (file.size > (options.maxBytes ?? PROOF_MAX_BYTES)) return "size";
  return null;
}

/**
 * A failed upload as a state: a dropped connection after some bytes is "interrupted" (finish it); anything else is
 * "failed", with `retry` true only when sending the same file again can work. Codes are the server's upload codes
 * (~/server/uploads.server) or "network" / "timeout" / "rate_limited". Pure.
 */
export function proofFailure(code: string, progress: number): { phase: "interrupted" } | { phase: "failed"; problem: ProofProblem; retry: boolean } {
  const network = code === "network" || code === "timeout";
  if (network && progress > 0 && progress < 1) return { phase: "interrupted" };
  if (network) return { phase: "failed", problem: "network", retry: true };
  switch (code) {
    case "upload_too_large":
    case "size":
      return { phase: "failed", problem: "size", retry: false };
    case "upload_type":
    case "type":
      return { phase: "failed", problem: "type", retry: false };
    case "upload_corrupt":
      return { phase: "failed", problem: "corrupt", retry: false };
    case "upload_dimensions":
      return { phase: "failed", problem: "dimensions", retry: false };
    case "upload_missing":
    case "empty":
      return { phase: "failed", problem: "empty", retry: false };
    case "rate_limited":
      return { phase: "failed", problem: "rate_limited", retry: true };
    default:
      return { phase: "failed", problem: "server", retry: true };
  }
}

const unit = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);

/** The uploader's state machine. Pure. */
export function proofReducer(state: ProofState, action: ProofAction): ProofState {
  switch (action.type) {
    case "rejected":
      return { phase: "idle", problem: action.problem, file: action.file, cancelled: false };
    case "start":
      return { phase: "uploading", file: action.file, progress: 0 };
    case "progress":
      return state.phase === "uploading" ? { ...state, progress: unit(action.fraction) } : state;
    case "done":
      return state.phase === "uploading" ? { phase: "uploaded", file: state.file, previewUrl: action.previewUrl } : state;
    case "fail": {
      if (state.phase !== "uploading") return state;
      const failure = proofFailure(action.code, state.progress);
      return failure.phase === "interrupted"
        ? { phase: "interrupted", file: state.file, progress: state.progress }
        : { phase: "failed", file: state.file, problem: failure.problem, retry: failure.retry };
    }
    case "cancel":
      return state.phase === "uploading" ? { ...PROOF_IDLE, cancelled: true } : state;
    case "reset":
      return PROOF_IDLE;
  }
}

const PROBLEM_KEY: Record<ProofProblem, string> = {
  empty: "proof.errors.empty",
  type: "proof.errors.type",
  size: "proof.errors.size",
  corrupt: "proof.errors.corrupt",
  dimensions: "proof.errors.dimensions",
  network: "proof.errors.network",
  rate_limited: "errors.rate_limited",
  server: "proof.errors.server",
};

export type ProofUploaderProps = {
  /** Sends the file. Report progress (0–1) through `onProgress`; stop when `signal` aborts. Must not throw — return `{ ok: false, code }`. */
  onUpload: (file: File, controls: ProofUploadControls) => Promise<ProofUploadResult>;
  /** The review state of the proof on file (from the order). */
  status?: ProofStatus | null;
  /** The proof already on file: its thumbnail (a signed, private URL) and name. */
  current?: { previewUrl?: string | null; fileName?: string | null } | null;
  /** Called after a successful upload. */
  onUploaded?: (result: Extract<ProofUploadResult, { ok: true }>) => void;
  /** Default "ارفع صورة الحوالة" (the trade-in wizard passes its own). */
  title?: ReactNode;
  /**
   * The upload is the view's one forward action (an order waiting for its transfer photo): «اختر صورة» — and «أكمل
   * الرفع» / «أعد المحاولة» when a send stopped — is the red primary. Default: secondary keys.
   */
  primary?: boolean;
  maxBytes?: number;
  disabled?: boolean;
  /** Start in a given state — previews and the /design-system page show every state this way. */
  defaultState?: ProofState;
  className?: string;
};

export function ProofUploader({ onUpload, status = null, current = null, onUploaded, title, primary = false, maxBytes = PROOF_MAX_BYTES, disabled = false, defaultState, className }: ProofUploaderProps) {
  const t = useT("ui-shop");
  const f = useFormat();
  const [state, dispatch] = useReducer(proofReducer, defaultState ?? PROOF_IDLE);
  const [dragging, setDragging] = useState(false);
  const [localPreview, setLocalPreview] = useState<string | null>(null);
  const [said, setSaid] = useState("");
  const depth = useRef(0);
  const file = useRef<File | null>(null);
  const progress = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const chooser = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const latest = useRef({ onUpload, onUploaded });
  latest.current = { onUpload, onUploaded };

  // Stop a running upload and release the local preview when the uploader goes away.
  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!localPreview) return;
    return () => URL.revokeObjectURL(localPreview);
  }, [localPreview]);

  const mb = (bytes: number) => t("proof.mb", { n: f.number(bytes / 1048576, { maximumFractionDigits: 1 }) });
  const pct = (fraction: number) => f.percent(Math.floor(unit(fraction) * 100) / 100);

  const send = async (chosen: File) => {
    controller.current?.abort();
    const abort = new AbortController();
    controller.current = abort;
    progress.current = 0;
    dispatch({ type: "start", file: infoOf(chosen) });
    setSaid(t("proof.uploading", { name: chosen.name }));
    const onProgress = (fraction: number) => {
      if (abort.signal.aborted) return;
      progress.current = unit(fraction);
      dispatch({ type: "progress", fraction });
    };
    let result: ProofUploadResult;
    try {
      result = await latest.current.onUpload(chosen, { signal: abort.signal, onProgress });
    } catch {
      result = { ok: false, code: "network" };
    }
    if (abort.signal.aborted || controller.current !== abort) return; // cancelled, or replaced by a newer file
    controller.current = null;
    if (result.ok) {
      dispatch({ type: "done", previewUrl: result.previewUrl ?? null });
      setSaid(t("proof.uploaded"));
      latest.current.onUploaded?.(result);
      return;
    }
    dispatch({ type: "fail", code: result.code });
    const failure = proofFailure(result.code, progress.current);
    setSaid(failure.phase === "interrupted" ? t("proof.interrupted", { pct: pct(progress.current) }) : problemText(failure.problem, infoOf(chosen)));
  };

  const take = (chosen: File | null | undefined) => {
    if (!chosen || disabled) return;
    const problem = checkProofFile(infoOf(chosen), { maxBytes });
    if (problem) {
      dispatch({ type: "rejected", file: infoOf(chosen), problem });
      setSaid(problemText(problem, infoOf(chosen)));
      return;
    }
    file.current = chosen;
    setLocalPreview(URL.createObjectURL(chosen));
    void send(chosen);
  };
  const onFile = (input: HTMLInputElement) => {
    take(input.files?.[0]);
    input.value = ""; // the same photo can be chosen again
  };

  const cancel = () => {
    controller.current?.abort();
    controller.current = null;
    file.current = null;
    setLocalPreview(null);
    dispatch({ type: "cancel" });
    setSaid(t("proof.cancelled"));
  };
  const again = () => (file.current ? void send(file.current) : chooser.current?.click());
  const choose = () => chooser.current?.click();
  const shoot = () => camera.current?.click();

  function problemText(problem: ProofProblem, about: ProofFileInfo | null = state.file): string {
    return t(PROBLEM_KEY[problem], { size: about ? mb(about.size) : "", max: mb(maxBytes) });
  }

  const onDragEnter = (event: DragEvent<HTMLElement>) => {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    depth.current++;
    setDragging(true);
  };
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = () => {
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (disabled || !hasFiles(event)) return;
    event.preventDefault();
    depth.current = 0;
    setDragging(false);
    if (state.phase === "uploading") return;
    take(event.dataTransfer.files?.[0]);
  };

  const accept = PROOF_TYPES.join(",");
  // Hidden inputs, opened by the keys (a hidden input can still be clicked from script in every current browser).
  const inputs = (
    <>
      <input ref={chooser} type="file" accept={accept} hidden onChange={(event) => onFile(event.currentTarget)} />
      <input ref={camera} type="file" accept={accept} capture="environment" hidden onChange={(event) => onFile(event.currentTarget)} />
    </>
  );

  /* ── the review state (from the order) ── */
  const review = status ? <ReviewLine status={status} /> : null;
  const thumb = state.phase === "uploaded" ? (state.previewUrl ?? localPreview) : (current?.previewUrl ?? null);

  if (status?.state === "approved" && state.phase !== "uploading") {
    return (
      <div className={cx("grid gap-3 rounded-lg bg-paper p-4", className)}>
        {review}
        {current ? <ProofThumb src={current.previewUrl ?? null} name={current.fileName ?? null} alt={t("proof.preview")} /> : null}
      </div>
    );
  }

  // `lead`: this key is the step forward here (the first photo, or another one when nothing can be retried); replacing
  // a photo that was sent is not
  const keys = (kind: "choose" | "replace" | "another", lead = kind === "choose") => (
    <div className="flex flex-wrap items-center gap-2">
      <Key size="sm" variant={primary && lead ? "primary" : "secondary"} icon={kind === "replace" ? "arrow-counter-clockwise" : "image"} onClick={choose} disabled={disabled}>
        {t(kind === "replace" ? "proof.replace" : kind === "another" ? "proof.chooseAnother" : "proof.choose")}
      </Key>
      <Key size="sm" icon="camera" onClick={shoot} disabled={disabled} className="hidden pointer-coarse:inline-flex">
        {t("proof.camera")}
      </Key>
    </div>
  );

  let body: ReactNode;
  switch (state.phase) {
    case "uploading": {
      const percent = Math.floor(unit(state.progress) * 100);
      body = (
        <div className="grid gap-2">
          <p className="flex items-baseline justify-between gap-3 type-sm text-ink">
            <span className="min-w-0 truncate">{t("proof.uploading", { name: isolate(state.file.name) })}</span>
            <bdi className="nums shrink-0 font-semibold">{pct(state.progress)}</bdi>
          </p>
          <div role="progressbar" aria-label={t("proof.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="proof__bar">
            <div className="proof__fill" style={{ "--progress": `${percent}%` } as CSSProperties} />
          </div>
          {/* a one-word button: padding widens the target to 44px without moving the word */}
          <TextLink as="button" type="button" arrow={false} onClick={cancel} className="-mx-3.5 justify-self-start px-3.5">
            {t("proof.cancel")}
          </TextLink>
        </div>
      );
      break;
    }
    case "interrupted":
      body = (
        <div className="grid gap-3">
          <p className="flex items-start gap-2 type-sm-strong text-warn">
            <Icon name="warning" size={20} className="shrink-0" />
            <span>
              {t("proof.interrupted", { pct: "⁦" + pct(state.progress) + "⁩" })} <bdi className="font-normal text-ink-2">{state.file.name}</bdi>
            </span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Key size="sm" variant={primary ? "primary" : "secondary"} icon="arrow-counter-clockwise" onClick={again}>
              {t("proof.resume")}
            </Key>
            <TextLink as="button" type="button" arrow={false} onClick={choose}>
              {t("proof.chooseAnother")}
            </TextLink>
          </div>
        </div>
      );
      break;
    case "failed":
      body = (
        <div className="grid gap-3">
          <p className="flex items-start gap-2 type-sm-strong text-danger">
            <Icon name="warning-circle" size={20} className="shrink-0" />
            <span>{problemText(state.problem)}</span>
          </p>
          <div className="flex flex-wrap items-center gap-2">
            {state.retry ? (
              <Key size="sm" variant={primary ? "primary" : "secondary"} icon="arrow-counter-clockwise" onClick={again}>
                {t("proof.retry")}
              </Key>
            ) : null}
            {keys("another", !state.retry)}
          </div>
        </div>
      );
      break;
    case "uploaded":
      body = (
        <div className="grid gap-3">
          <ProofThumb src={thumb} name={state.file.name} alt={t("proof.preview")} done={t("proof.uploaded")} />
          {keys("replace")}
        </div>
      );
      break;
    default: {
      const problem = state.phase === "idle" ? state.problem : null;
      // A proof is already under review: show it and offer to replace it (the server decides whether it may be).
      const onFileNow = !problem && status?.state === "submitted";
      body = onFileNow ? (
        <div className="grid gap-3">
          {current ? <ProofThumb src={current.previewUrl ?? null} name={current.fileName ?? null} alt={t("proof.preview")} /> : null}
          {keys("replace")}
        </div>
      ) : (
        <div className="grid justify-items-center gap-2 py-2 text-center">
          <span className="grid size-11 place-items-center rounded-full bg-niche text-ink-2" aria-hidden="true">
            <Icon name="upload-simple" size={24} />
          </span>
          <p id={titleId} className="type-card text-ink">
            {dragging ? t("proof.dropHere") : (title ?? t("proof.drop"))}
          </p>
          <p className="type-xs text-ink-2">{t("proof.limits", { size: mb(maxBytes) })}</p>
          {problem ? (
            <p className="flex items-start gap-1.5 text-start type-xs-strong text-danger">
              <Icon name="warning-circle" size={16} className="mt-0.5 shrink-0" />
              {problemText(problem)}
            </p>
          ) : state.phase === "idle" && state.cancelled ? (
            <p className="type-xs text-ink-2">{t("proof.cancelled")}</p>
          ) : null}
          <div className="mt-1">{keys(problem ? "another" : "choose", true)}</div>
        </div>
      );
    }
  }

  return (
    <div className={cx("grid gap-3", className)}>
      {review}
      <div
        role="group"
        aria-labelledby={state.phase === "idle" ? titleId : undefined}
        aria-label={state.phase === "idle" ? undefined : t("proof.drop")}
        aria-disabled={disabled || undefined}
        data-phase={state.phase}
        data-dragging={dragging ? "" : undefined}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-state={state.phase === "failed" || (state.phase === "idle" && state.problem) ? "failed" : state.phase}
        className={cx("proof__drop justify-items-stretch text-start", dragging && "border-ink bg-niche", disabled && "opacity-60")}
      >
        {body}
        {inputs}
      </div>
      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
    </div>
  );
}

function ReviewLine({ status }: { status: ProofStatus }) {
  const t = useT("ui-shop");
  const tone = status.state === "approved" ? "ok" : status.state === "rejected" ? "bad" : "warn";
  const text = status.state === "approved" ? t("proof.approvedText") : status.state === "rejected" ? t("proof.rejectedText") : t("proof.submittedText");
  return (
    <div className="grid gap-1" data-review={status.state}>
      <Status tone={tone} size="lg">
        {t(`proof.status.${status.state}`)}
      </Status>
      {status.state === "rejected" && status.note ? <p className="type-sm-strong text-ink">{t("proof.reviewerNote", { note: status.note })}</p> : null}
      <p className="type-xs text-ink-2">{text}</p>
    </div>
  );
}

function ProofThumb({ src, name, alt, done }: { src: string | null; name: string | null; alt: string; done?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="grid size-16 shrink-0 place-items-center overflow-hidden rounded-sm bg-niche text-ink-2">
        {src ? <img src={src} width={64} height={64} alt={alt} className="size-full object-cover" /> : <Icon name="receipt" size={24} />}
      </span>
      <span className="grid min-w-0 gap-0.5">
        {done ? (
          <span className="flex items-center gap-1.5 type-sm-strong text-ok">
            <Icon name="check-circle" size={16} filled />
            {done}
          </span>
        ) : null}
        {name ? <bdi className="truncate type-xs text-ink-2">{name}</bdi> : null}
      </span>
    </div>
  );
}

const infoOf = (file: File): ProofFileInfo => ({ name: file.name, size: file.size, type: file.type });

function hasFiles(event: DragEvent<HTMLElement>): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Send one proof with XMLHttpRequest — `fetch` cannot report upload progress. Posts multipart form data (`fields` +
 * the file as `file`) to a same-origin endpoint and reads its JSON ActionResult: `{ ok: true, previewUrl? }` or
 * `{ ok: false, code }`. Resolves (never rejects) with a ProofUploadResult; an abort resolves `{ ok:false, code:"aborted" }`.
 * The endpoint (POST /api/upload/proof) belongs to the checkout area.
 */
export function sendProof(url: string, fields: Record<string, string>, file: File, controls: ProofUploadControls, fileField = "file"): Promise<ProofUploadResult> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, value);
    form.append(fileField, file, file.name);
    const onAbort = () => xhr.abort();
    controls.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (result: ProofUploadResult) => {
      controls.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) controls.onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      type Answer = { ok?: unknown; code?: unknown; previewUrl?: unknown };
      let json: Answer | null;
      try {
        const parsed: unknown = JSON.parse(xhr.responseText);
        json = parsed && typeof parsed === "object" ? (parsed as Answer) : null;
      } catch {
        json = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && json?.ok === true) {
        finish({ ok: true, previewUrl: typeof json.previewUrl === "string" ? json.previewUrl : null });
        return;
      }
      const code = typeof json?.code === "string" ? json.code : xhr.status === 429 ? "rate_limited" : xhr.status === 413 ? "upload_too_large" : "server";
      finish({ ok: false, code });
    };
    xhr.onerror = () => finish({ ok: false, code: "network" });
    xhr.ontimeout = () => finish({ ok: false, code: "timeout" });
    xhr.onabort = () => finish({ ok: false, code: "aborted" });
    xhr.open("POST", url);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.send(form);
    if (controls.signal.aborted) xhr.abort();
  });
}
