/**
 * The trade-in wizard's photos (Design System v2 §6.14 "photos: the ProofUploader pattern", §4.24): the kit's paper drop
 * area with a dashed control line (.proof__drop), «اختر صوراً» and, on touch screens, «التقط صورة»; several photos, up
 * to the limit; each one is checked here first (JPEG, PNG or WebP within the size limit, then — like the server — by
 * its first bytes, whether the browser can draw it and its size in pixels: ~/routes/storefront/support/photo-check, so
 * a renamed text file is said at once and never sent to be refused), shown at once from the device, and sent one at
 * a time to POST /api/upload/tradein with an ink progress
 * bar and its %. A failure says why, beside that photo (danger callout), with a retry when retrying can help; a removed
 * photo is deleted on the server. The photos are private: only this browser's draft (httpOnly cookie) and, after
 * submission, store staff can see them.
 *
 * Uses `checkProofFile` / `proofFailure` from ~/ui/ProofUploader (the same rules as the transfer proof).
 */
import { useEffect, useId, useRef, useState, type CSSProperties, type DragEvent } from "react";

import { Icon } from "~/art/Icon";
import { useFormat } from "~/i18n/react";
import { cx } from "~/ui/cx";
import { IconKey } from "~/ui/IconKey";
import { Key } from "~/ui/Key";
import { checkProofFile, proofFailure, PROOF_TYPES } from "~/ui/ProofUploader";
import { TextLink } from "~/ui/TextLink";
import { checkPhotoFile } from "~/routes/storefront/support/photo-check";
import { useUsedT } from "../i18n";

const ENDPOINT = "/api/upload/tradein";

export type DraftPhoto = { id: string; name: string | null; previewUrl: string };

type Entry = {
  key: string;
  id: string | null;
  name: string;
  /** Object URL of the chosen file (this device) or the server's preview of a stored one. */
  src: string | null;
  local: boolean;
  state: "uploading" | "done" | "failed";
  progress: number;
  problem: string | null;
  retry: boolean;
};

type AddAnswer = { ok: true; photo: DraftPhoto } | { ok: false; code: string };

/** One photo up, with progress (XMLHttpRequest: fetch cannot report upload progress). Never rejects. */
function sendPhoto(file: File, onProgress: (fraction: number) => void, signal: AbortSignal): Promise<AddAnswer> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("intent", "add");
    form.append("file", file, file.name);
    const onAbort = () => xhr.abort();
    signal.addEventListener("abort", onAbort, { once: true });
    const finish = (answer: AddAnswer) => {
      signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let json: { ok?: unknown; code?: unknown; photo?: { id?: unknown; name?: unknown; previewUrl?: unknown } } | null = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        json = null;
      }
      const photo = json?.photo;
      if (xhr.status >= 200 && xhr.status < 300 && json?.ok === true && photo && typeof photo.id === "string" && typeof photo.previewUrl === "string") {
        finish({ ok: true, photo: { id: photo.id, name: typeof photo.name === "string" ? photo.name : null, previewUrl: photo.previewUrl } });
        return;
      }
      const code = typeof json?.code === "string" ? json.code : xhr.status === 429 ? "rate_limited" : xhr.status === 413 ? "upload_too_large" : "server";
      finish({ ok: false, code });
    };
    xhr.onerror = () => finish({ ok: false, code: "network" });
    xhr.ontimeout = () => finish({ ok: false, code: "network" });
    xhr.onabort = () => finish({ ok: false, code: "aborted" });
    xhr.open("POST", ENDPOINT);
    xhr.setRequestHeader("Accept", "application/json");
    xhr.send(form);
  });
}

async function deletePhoto(id: string): Promise<boolean> {
  try {
    const body = new FormData();
    body.append("intent", "remove");
    body.append("fileId", id);
    const response = await fetch(ENDPOINT, { method: "POST", body, headers: { Accept: "application/json" } });
    const json = (await response.json().catch(() => null)) as { ok?: unknown } | null;
    return response.ok && json?.ok === true;
  } catch {
    return false;
  }
}

let serial = 0;
const nextKey = () => `p${++serial}`;

/** A file name inside a sentence, first-strong isolated: «1-1200.jpg» keeps its order inside Arabic and Sorani. */
const FSI = String.fromCharCode(0x2068);
const PDI = String.fromCharCode(0x2069);
const named = (name: string) => `${FSI}${name}${PDI}`;

export type TradeInPhotosProps = { initial: DraftPhoto[]; limit: number; maxBytes: number; className?: string };

export function TradeInPhotos({ initial, limit, maxBytes, className }: TradeInPhotosProps) {
  const t = useUsedT();
  const f = useFormat();
  const [entries, setEntries] = useState<Entry[]>(() =>
    initial.map((photo) => ({ key: `s-${photo.id}`, id: photo.id, name: photo.name ?? "", src: photo.previewUrl, local: false, state: "done", progress: 1, problem: null, retry: false })),
  );
  const [said, setSaid] = useState("");
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const chooser = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const queue = useRef<string[]>([]);
  /** The chosen files by entry key, kept until they are stored (retry sends the same file again). */
  const files = useRef(new Map<string, { file: File; name: string }>());
  const running = useRef(false);
  const aborts = useRef(new Map<string, AbortController>());
  const latest = useRef(entries);
  latest.current = entries;
  const titleId = useId();

  // Object URLs are released when their photo goes (and when the step is left).
  useEffect(
    () => () => {
      for (const entry of latest.current) if (entry.local && entry.src) URL.revokeObjectURL(entry.src);
      for (const controller of aborts.current.values()) controller.abort();
    },
    [],
  );

  const mb = (bytes: number) => t("tradein.photos.mb", { n: f.number(bytes / 1048576, { maximumFractionDigits: 1 }) });
  const kept = entries.filter((entry) => entry.state !== "failed");
  const room = Math.max(0, limit - kept.length);
  const busy = entries.some((entry) => entry.state === "uploading");

  const update = (key: string, change: Partial<Entry>) => setEntries((list) => list.map((entry) => (entry.key === key ? { ...entry, ...change } : entry)));

  const problemOf = (code: string, name: string, progress: number) => {
    if (code === "trade_in_photo_limit") return { text: t("tradein.photos.errors.limit", { name: named(name) }), retry: false };
    const failure = proofFailure(code, progress);
    const problem = failure.phase === "interrupted" ? "network" : failure.problem;
    const key = problem === "rate_limited" ? "rate_limited" : problem;
    return { text: t(`tradein.photos.errors.${key}`, { name: named(name), size: "", max: mb(maxBytes) }), retry: failure.phase === "interrupted" || failure.retry };
  };

  const pump = async () => {
    if (running.current) return;
    running.current = true;
    try {
      while (queue.current.length > 0) {
        const key = queue.current.shift()!;
        const entry = files.current.get(key);
        if (!entry) continue;
        const controller = new AbortController();
        aborts.current.set(key, controller);
        setSaid(t("tradein.photos.uploading", { name: named(entry.name) }));
        let lastProgress = 0;
        const answer = await sendPhoto(
          entry.file,
          (fraction) => {
            lastProgress = fraction;
            update(key, { progress: fraction });
          },
          controller.signal,
        );
        aborts.current.delete(key);
        if (answer.ok) {
          files.current.delete(key);
          update(key, { id: answer.photo.id, state: "done", progress: 1 });
          setSaid(t("tradein.photos.uploaded"));
        } else if (answer.code !== "aborted") {
          const problem = problemOf(answer.code, entry.name, lastProgress);
          update(key, { state: "failed", problem: problem.text, retry: problem.retry });
          setSaid(problem.text);
        }
      }
    } finally {
      running.current = false;
    }
  };

  const take = async (chosen: FileList | File[] | null | undefined) => {
    if (!chosen) return;
    // read before anything else: the input is emptied (and a drop's files are gone) once this returns its promise
    const list = Array.from(chosen);
    // What each file really is — its first bytes, whether the browser can draw it, its size in pixels — before it shows
    // or is sent: a renamed text file is said here, never sent to be refused (QA 2026-11-12: a 415 in the console).
    // One file at a time: a phone decodes one photo, not six.
    const found = new Map<File, string>();
    for (const file of list) {
      if (checkProofFile({ name: file.name, size: file.size, type: file.type }, { maxBytes })) continue;
      const problem = await checkPhotoFile(file);
      if (problem) found.set(file, problem);
    }
    // the photos on screen now (a removal or another choice may have landed while the files were read)
    const keptNow = latest.current.filter((entry) => entry.state !== "failed").length;
    const added: Entry[] = [];
    let space = Math.max(0, limit - keptNow);
    for (const file of list) {
      const name = file.name || t("tradein.photos.photo", { n: f.number(keptNow + added.length + 1) });
      const problem = checkProofFile({ name: file.name, size: file.size, type: file.type }, { maxBytes });
      if (problem) {
        const text = t(`tradein.photos.errors.${problem}`, { name: named(name), size: mb(file.size), max: mb(maxBytes) });
        added.push({ key: nextKey(), id: null, name, src: null, local: false, state: "failed", progress: 0, problem: text, retry: false });
        continue;
      }
      const unreadable = found.get(file);
      if (unreadable) {
        added.push({ key: nextKey(), id: null, name, src: null, local: false, state: "failed", progress: 0, problem: problemOf(unreadable, name, 0).text, retry: false });
        continue;
      }
      if (space <= 0) {
        added.push({ key: nextKey(), id: null, name, src: null, local: false, state: "failed", progress: 0, problem: t("tradein.photos.errors.limit", { name: named(name) }), retry: false });
        continue;
      }
      space--;
      const key = nextKey();
      added.push({ key, id: null, name, src: URL.createObjectURL(file), local: true, state: "uploading", progress: 0, problem: null, retry: false });
      files.current.set(key, { file, name });
      queue.current.push(key);
    }
    if (added.length === 0) return;
    setEntries((list) => [...list, ...added]);
    const lastProblem = [...added].reverse().find((entry) => entry.problem);
    if (lastProblem?.problem) setSaid(lastProblem.problem);
    void pump();
  };

  const retry = (entry: Entry) => {
    if (!files.current.has(entry.key)) return;
    update(entry.key, { state: "uploading", progress: 0, problem: null, retry: false });
    queue.current.push(entry.key);
    void pump();
  };

  const remove = async (entry: Entry, position: number) => {
    aborts.current.get(entry.key)?.abort();
    queue.current = queue.current.filter((key) => key !== entry.key);
    files.current.delete(entry.key);
    if (entry.id) {
      update(entry.key, { state: "uploading", progress: 1 });
      const ok = await deletePhoto(entry.id);
      if (!ok) {
        update(entry.key, { state: "done", progress: 1 });
        setSaid(t("tradein.photos.removeFailed"));
        return;
      }
    }
    if (entry.local && entry.src) URL.revokeObjectURL(entry.src);
    setEntries((list) => list.filter((candidate) => candidate.key !== entry.key));
    setSaid(t("tradein.photos.removed"));
    // Focus goes to the next photo's remove key, else the choose key — never to the page.
    requestAnimationFrame(() => {
      const keys = document.querySelectorAll<HTMLElement>("[data-photo-remove]");
      (keys[position] ?? keys[position - 1] ?? chooser.current?.closest("[data-photos]")?.querySelector<HTMLElement>("[data-photo-choose]"))?.focus();
    });
  };

  const dismiss = (entry: Entry) => {
    files.current.delete(entry.key);
    setEntries((list) => list.filter((candidate) => candidate.key !== entry.key));
  };

  const hasFiles = (event: DragEvent<HTMLElement>) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
  const accept = PROOF_TYPES.join(",");
  let position = 0;

  return (
    <div className={cx("grid gap-4", className)} data-photos="">
      <div
        role="group"
        aria-labelledby={titleId}
        data-dragging={dragging ? "" : undefined}
        onDragEnter={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          depth.current++;
          setDragging(true);
        }}
        onDragOver={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          depth.current = Math.max(0, depth.current - 1);
          if (depth.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          if (!hasFiles(event)) return;
          event.preventDefault();
          depth.current = 0;
          setDragging(false);
          void take(event.dataTransfer.files);
        }}
        className="proof__drop used-photos__drop"
      >
        {/* v2.1: the before's raised circle, the brand's line icon */}
        <span className="clay-disc used-disc used-disc--lg" aria-hidden="true">
          <Icon name="camera" size={26} />
        </span>
        <p id={titleId} className="type-card text-ink">
          {dragging ? t("tradein.photos.dropHere") : t("tradein.photos.drop")}
        </p>
        <p className="type-xs text-ink-2">{t("tradein.photos.limits", { count: f.number(limit), size: mb(maxBytes) })}</p>
        <p className="type-xs-strong text-ink-2">
          <bdi className="nums">{t("tradein.photos.count", { n: f.number(kept.length), total: f.number(limit) })}</bdi>
        </p>
        {room > 0 ? (
          <div className="mt-1 flex flex-wrap justify-center gap-2">
            <Key size="sm" icon="image" onClick={() => chooser.current?.click()} data-photo-choose="">
              {t("tradein.photos.choose")}
            </Key>
            <Key size="sm" icon="camera" onClick={() => camera.current?.click()} className="hidden pointer-coarse:inline-flex">
              {t("tradein.photos.camera")}
            </Key>
          </div>
        ) : (
          <p className="type-xs text-ink-2">{t("tradein.photos.full")}</p>
        )}
        <input
          ref={chooser}
          type="file"
          accept={accept}
          multiple
          hidden
          onChange={(event) => {
            void take(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        <input
          ref={camera}
          type="file"
          accept={accept}
          capture="environment"
          hidden
          onChange={(event) => {
            void take(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
      </div>

      {entries.length > 0 ? (
        <ul aria-label={t("tradein.photos.list")} className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
          {entries.map((entry) => {
            const n = entry.state === "failed" ? null : ++position;
            const label = n ? t("tradein.photos.photo", { n: f.number(n) }) : entry.name;
            const at = (n ?? 1) - 1;
            const percent = Math.floor(entry.progress * 100);
            return (
              <li key={entry.key} className={cx("grid content-start gap-1.5", entry.state === "failed" && "col-span-full")}>
                {entry.state === "failed" ? (
                  <div className="callout callout--danger flex-wrap items-start" role="alert">
                    <Icon name="warning-circle" size={20} />
                    <p className="min-w-0 flex-1 type-sm-strong text-danger">{entry.problem}</p>
                    <div className="flex items-center gap-4">
                      {entry.retry && files.current.has(entry.key) ? (
                        <TextLink as="button" type="button" arrow={false} onClick={() => retry(entry)}>
                          {t("tradein.photos.retry")}
                        </TextLink>
                      ) : null}
                      <TextLink as="button" type="button" arrow={false} onClick={() => dismiss(entry)}>
                        {t("tradein.photos.dismiss")}
                      </TextLink>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="relative aspect-square overflow-hidden rounded-sm border border-line bg-niche">
                      {entry.src ? <img src={entry.src} width={160} height={160} alt={label} className="size-full object-cover" /> : null}
                      {entry.state === "uploading" ? (
                        <span className="absolute inset-x-2 bottom-2 grid gap-1 rounded-xs bg-paper px-2 py-1">
                          <span className="type-tag nums text-ink">{f.percent(entry.progress)}</span>
                          <span role="progressbar" aria-label={t("tradein.photos.progress")} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="proof__bar block">
                            <span className="proof__fill" style={{ "--progress": `${percent}%` } as CSSProperties} />
                          </span>
                        </span>
                      ) : (
                        <span className="absolute bottom-1.5 start-1.5 grid size-6 place-items-center rounded-full bg-paper text-ok" aria-hidden="true">
                          <Icon name="check" size={16} />
                        </span>
                      )}
                      <IconKey
                        icon="x"
                        size="xs"
                        variant="onImage"
                        label={t("tradein.photos.remove", { n: f.number(n ?? 1) })}
                        className="absolute end-1 top-1"
                        onClick={() => void remove(entry, at)}
                        disabled={entry.state === "uploading" && entry.id !== null}
                        data-photo-remove=""
                      />
                    </div>
                    <p className="truncate type-xs text-ink-2">
                      <bdi>{entry.name || label}</bdi>
                    </p>
                  </>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {said}
      </p>
      {busy ? <span className="sr-only">{t("tradein.photos.progress")}</span> : null}
    </div>
  );
}
