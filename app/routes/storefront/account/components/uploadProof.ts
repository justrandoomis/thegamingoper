import type { ProofUploadControls } from "~/ui/ProofUploader";

export type TopupProofAnswer = { ok: true; fileId: string; previewUrl: string | null } | { ok: false; code: string };

/**
 * Sends one transfer photo to POST /account/wallet/proof with XMLHttpRequest (fetch cannot report upload progress) and
 * reads `{ ok: true, fileId, previewUrl }` or `{ ok: false, code }`. Never rejects; an abort answers code "aborted".
 * (`sendProof` from ~/ui/ProofUploader keeps only `previewUrl`; the top-up needs the stored file's id too.)
 */
export function uploadTopupProof(url: string, file: File, controls: ProofUploadControls): Promise<TopupProofAnswer> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file, file.name);
    const onAbort = () => xhr.abort();
    controls.signal.addEventListener("abort", onAbort, { once: true });
    const finish = (answer: TopupProofAnswer) => {
      controls.signal.removeEventListener("abort", onAbort);
      resolve(answer);
    };
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) controls.onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      type Answer = { ok?: unknown; code?: unknown; fileId?: unknown; previewUrl?: unknown };
      let json: Answer | null = null;
      try {
        const parsed: unknown = JSON.parse(xhr.responseText);
        json = parsed && typeof parsed === "object" ? (parsed as Answer) : null;
      } catch {
        json = null;
      }
      if (xhr.status >= 200 && xhr.status < 300 && json?.ok === true && typeof json.fileId === "string") {
        finish({ ok: true, fileId: json.fileId, previewUrl: typeof json.previewUrl === "string" ? json.previewUrl : null });
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
