/**
 * Switch game library (admin) — what its pages share on the client: the namespace's strings, error sentences (this
 * namespace first, then the catalogue's), the toast after a fetcher answers, and the OPEN game list (Wikidata, CC0)
 * fetched from the static file named by library.manifest.ts and kept for the session (the file is content-hashed and
 * served immutable, so the list, the edit page and the import share one download).
 */
import { useEffect, useMemo, useState } from "react";
import type { FetcherWithComponents } from "react-router";

import { Icon } from "~/art/Icon";
import { useDir, useT } from "~/i18n/react";
import type { TFunction } from "~/i18n/translate";
import type { LibraryGame, LibraryList } from "~/lib/switch-builder/types";
import { LIBRARY_LIST_FILE } from "~/routes/storefront/builder/library.manifest";
import { latinName } from "~/ui/BidiText";
import { toast } from "~/ui/toast-store";
import { cx } from "~/ui/cx";
import { libraryListUrl } from "./switch-library-input";

export const LIBRARY_NAMESPACE = "admin-switch-library";
export const LIBRARY_PATH = "/admin/catalog/switch-library";
export const libraryGamePath = (gameId: string) => `${LIBRARY_PATH}/${encodeURIComponent(gameId)}`;

export const useLibraryT = () => useT(LIBRARY_NAMESPACE);

/** What an action of these pages answers (catalog.server.ts runIntent / failed). */
export type LibraryAnswer = { ok: true; intent: string; [key: string]: unknown } | { ok: false; intent?: string; code: string; message?: string; fields?: Record<string, string> };

export const isLibraryFailure = (value: unknown): value is Extract<LibraryAnswer, { ok: false }> => typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;

const ERROR_KEY = /^[a-z][a-z0-9_]*$/;

/** An error key or sentence as the sentence to show: this namespace's `errors.<key>`, else the catalogue's, else as it is. */
function errorSentence(mine: TFunction, catalog: TFunction, value: string): string {
  if (!ERROR_KEY.test(value)) return value;
  const own = mine(`errors.${value}`);
  if (own !== `errors.${value}`) return own;
  const shared = catalog(`errors.${value}`);
  return shared === `errors.${value}` ? value : shared;
}

/** `const error = useLibraryErrors(); error("size_format")` — also for the import plan's row errors. */
export function useLibraryErrors() {
  const mine = useLibraryT();
  const catalog = useT("admin-catalog");
  return useMemo(() => (value: string) => errorSentence(mine, catalog, value), [mine, catalog]);
}

/** The field errors of a failed answer: `fieldError("size")`. */
export function useLibraryFieldError(answer: unknown) {
  const sentence = useLibraryErrors();
  return (name: string): string | undefined => {
    if (!isLibraryFailure(answer) || !answer.fields) return undefined;
    const value = answer.fields[name];
    return value ? sentence(value) : undefined;
  };
}

/** The whole failure as one sentence: this namespace's words for the code first (the server's are the catalogue's). */
export function useLibraryFailureText() {
  const mine = useLibraryT();
  const sentence = useLibraryErrors();
  return (answer: unknown): string | null => {
    if (!isLibraryFailure(answer)) return null;
    const own = mine(`errors.${answer.code}`);
    if (own !== `errors.${answer.code}`) return own;
    return answer.message ?? sentence(answer.code);
  };
}

/** The failure beside a form (fields with their own error say so under the field). */
export function LibraryFailure({ answer, className }: { answer: unknown; className?: string }) {
  const text = useLibraryFailureText()(answer);
  if (!text) return null;
  return (
    <div className={cx("adm-notice adm-notice--bad", className)} role="alert">
      <Icon name="warning-circle" size={18} />
      <p>{text}</p>
    </div>
  );
}

/**
 * Answers already toasted, across remounts: a keyed fetcher keeps its last answer, and the edit form remounts after
 * every change of its row (a picture upload included) — the save's "Changes saved." must not come back with it.
 */
const toasted = new WeakSet<object>();

/** Toasts a fetcher's answer once: the success text, or the failure's sentence. */
export function useLibraryToast(fetcher: Pick<FetcherWithComponents<unknown>, "state" | "data">, okText: (data: Record<string, unknown>) => string | null) {
  const failure = useLibraryFailureText();
  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || typeof fetcher.data !== "object" || toasted.has(fetcher.data)) return;
    toasted.add(fetcher.data);
    const answer = fetcher.data as LibraryAnswer;
    if (answer.ok) {
      const text = okText(answer as Record<string, unknown>);
      if (text) toast.success(text);
    } else toast.error(failure(answer) ?? "");
  }, [fetcher.state, fetcher.data, okText, failure]);
}

// ───────────────────────────────────────────────────────────────── the open list

export type LibraryListStatus = "missing" | "loading" | "ready" | "error";

let memo: { url: string; promise: Promise<LibraryList> } | null = null;

function loadList(url: string): Promise<LibraryList> {
  if (memo?.url === url) return memo.promise;
  const promise = fetch(url, { credentials: "same-origin" }).then(async (response) => {
    if (!response.ok) throw new Error(`library list: ${response.status}`);
    const data = (await response.json()) as LibraryList;
    if (!data || typeof data !== "object" || !Array.isArray(data.games)) throw new Error("library list: unexpected shape");
    return data;
  });
  memo = { url, promise };
  // A failed download is not kept: "retry" fetches again.
  promise.catch(() => {
    if (memo?.promise === promise) memo = null;
  });
  return promise;
}

/**
 * The open list on the client: "missing" while the list has not been built (LIBRARY_LIST_FILE is null), "loading"
 * (also on the server and during hydration), "ready" or "error" (with `retry`).
 */
export function useLibraryList(): { status: LibraryListStatus; list: LibraryList | null; byId: ReadonlyMap<string, LibraryGame>; retry: () => void } {
  const url = libraryListUrl(LIBRARY_LIST_FILE);
  const [state, setState] = useState<{ status: LibraryListStatus; list: LibraryList | null }>({ status: url ? "loading" : "missing", list: null });
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!url) {
      setState({ status: "missing", list: null });
      return;
    }
    let live = true;
    setState((current) => (current.status === "ready" ? current : { status: "loading", list: null }));
    loadList(url).then(
      (list) => live && setState({ status: "ready", list }),
      () => live && setState({ status: "error", list: null }),
    );
    return () => {
      live = false;
    };
  }, [url, round]);
  const byId = useMemo(() => new Map((state.list?.games ?? []).map((game) => [game.id, game])), [state.list]);
  return { ...state, byId, retry: () => setRound((value) => value + 1) };
}

/**
 * A game's name for staff: the official (Latin) title, with the Arabic one when Wikidata has it. Each line starts at
 * the page's start edge, and a line too long for its box loses its END, never its beginning: a Latin title on an
 * Arabic or Sorani page is laid out left to right and aligned to the right (latinName), and the Arabic title on the
 * English page right to left and aligned to the left («…end of Zelda: Breath of the Wild» was the bug). `wrap`: the
 * lines wrap instead (a page's heading, where the whole name must show on a phone).
 */
export function GameName({ game, gameId, className, wrap = false }: { game: LibraryGame | null | undefined; gameId: string; className?: string; wrap?: boolean }) {
  const page = useDir();
  const title = game?.title ?? gameId;
  const latin = latinName(title, page);
  const line = wrap ? "break-words" : "truncate";
  return (
    <span className={cx("grid min-w-0 gap-0.5", className)}>
      <span dir={latin.dir} className={cx(line, latin.className)}>
        <bdi dir="ltr" lang="en">
          {title}
        </bdi>
      </span>
      {game?.titleAr ? (
        <span dir={page === "ltr" ? "rtl" : undefined} className={cx(line, "type-caption text-ink-2", page === "ltr" && "text-end")}>
          <bdi dir="rtl" lang="ar">
            {game.titleAr}
          </bdi>
        </span>
      ) : null}
    </span>
  );
}
