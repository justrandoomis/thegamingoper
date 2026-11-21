/**
 * The open game list and TamTam's data for it, in the browser (docs/switch-builder.md §4, §6.4).
 *
 *   const library = useLibrary(step === "games" || step === "review" ? "now" : "idle");
 *   library.status   "unbuilt" (no list file yet — LIBRARY_LIST_FILE is null) · "idle" · "loading" · "ready" · "error"
 *                    · "stale" (the list file this page was built with is gone: a newer list was published since —
 *                    the page must be reloaded to read it; never retried, a retry would ask for the same old file)
 *   library.payload  TamTam's data alone (GET /api/switch-library: sizes, prices and their dates, pictures…, the
 *                    planner's constants) as soon as it answered — the space bar and the review's dates need only this
 *   library.data     { list, payload } once both answered: public/library/switch/list.<hash>.json (immutable) too
 *   library.retry()  after an error (it also retries by itself when the connection comes back)
 *
 *   loadGameDetails(list, game)     the game's details chunk (public/library/switch/d/<n>.<hash>.json), each chunk
 *                                   fetched once per visit and kept
 *   isLibraryUpdated(error)         a 404 on the list or on a chunk: the files of an older build, deleted by a deploy
 *
 * The earlier steps start the download when the browser is idle, so the games step usually opens with the list in
 * hand. Both answers are kept for the visit (module scope): moving between steps never fetches them again. Nothing
 * here runs on the server — the server renders the loading state.
 */
import { useEffect, useState } from "react";

import { sanitizeCapacity } from "~/lib/switch-builder/storage";
import type { GameDetails, LibraryChunk, LibraryExtras, LibraryExtrasPayload, LibraryGame, LibraryList } from "~/lib/switch-builder/types";
import * as manifest from "../library.manifest";

export type LibraryStatus = "unbuilt" | "idle" | "loading" | "ready" | "error" | "stale";
export type LibraryData = { list: LibraryList; payload: LibraryExtrasPayload };

/** Where the static files live (public/library/switch/ → /library/switch/). */
export const LIBRARY_BASE = "/library/switch/";
export const EXTRAS_URL = "/api/switch-library";

/** Where the details chunks live: the manifest's LIBRARY_CHUNK_PATH when it has one, else public/library/switch/d/. */
function chunkBase(): string {
  const path = (manifest as { LIBRARY_CHUNK_PATH?: unknown }).LIBRARY_CHUNK_PATH;
  return typeof path === "string" && path !== "" ? (path.endsWith("/") ? path : `${path}/`) : `${LIBRARY_BASE}d/`;
}

/** The list file's address: the manifest names the file (a path is taken as it is); null while no list is built. */
export function libraryListUrl(file: string | null = manifest.LIBRARY_LIST_FILE): string | null {
  if (!file) return null;
  return file.startsWith("/") ? file : `${LIBRARY_BASE}${file}`;
}

/** A file or the API answered with an HTTP error (the status says which). */
export class LibraryHttpError extends Error {
  readonly url: string;
  readonly status: number;
  constructor(url: string, status: number) {
    super(`${url}: HTTP ${status}`);
    this.name = "LibraryHttpError";
    this.url = url;
    this.status = status;
  }
}

/**
 * The list and the details chunks are content-hashed files that a deploy replaces and deletes: a 404 (or 410) on one
 * of them means a newer library was published after this page was loaded — this page's copy of the manifest names
 * files that no longer exist, and only a reload reads the new one. Any other failure (the API, a 5xx, no connection)
 * is an ordinary error. Pure.
 */
export function isLibraryUpdated(error: unknown): boolean {
  if (!(error instanceof LibraryHttpError) || (error.status !== 404 && error.status !== 410)) return false;
  const path = error.url.split(/[?#]/)[0];
  return path !== EXTRAS_URL && (path.startsWith(LIBRARY_BASE) || path.startsWith(chunkBase()));
}

/**
 * Every file here is public and the same for everyone: no cookie goes with the request ("omit"), so a shopper with a
 * cart or a preference cookie is served GET /api/switch-library from the edge cache like an anonymous visitor (the
 * cache never keeps a request that carries a store cookie — workers/edge-cache.ts), instead of reading D1 each visit.
 */
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "omit", headers: { Accept: "application/json" } });
  if (!response.ok) throw new LibraryHttpError(url, response.status);
  return (await response.json()) as T;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/**
 * The list file, checked for its shape (a broken file is an error, never a half-drawn page; a game's malformed field
 * is left out — the search reads every title, alias and publisher as text while the page renders). Pure.
 */
export function readList(list: unknown): LibraryList {
  if (!isObject(list) || list.version !== 1 || !Array.isArray(list.games) || !Array.isArray(list.chunks)) throw new Error("the game list has an unknown shape");
  const games = (list.games as unknown[]).filter((game): game is LibraryGame => isObject(game) && typeof game.id === "string" && typeof game.title === "string").map((game) => ({
    ...game,
    titleAr: text(game.titleAr),
    titleCkb: text(game.titleCkb),
    publishers: strings(game.publishers),
    genres: strings(game.genres) as LibraryGame["genres"],
    modes: strings(game.modes) as LibraryGame["modes"],
    aliases: game.aliases === undefined ? undefined : strings(game.aliases),
    popularity: typeof game.popularity === "number" ? game.popularity : 0,
  }));
  return { ...(list as unknown as LibraryList), games };
}

/** GET /api/switch-library's answer, checked for its shape (the planner's constants sanitised). Pure. */
export function readPayload(payload: unknown): LibraryExtrasPayload {
  if (!isObject(payload) || !isObject(payload.extras)) throw new Error("the library data has an unknown shape");
  return { rev: typeof payload.rev === "string" ? payload.rev : "", extras: payload.extras as Record<string, LibraryExtras>, capacity: sanitizeCapacity(payload.capacity) };
}

/** Both answers, checked (readList + readPayload). Pure. */
export function readLibrary(list: unknown, payload: unknown): LibraryData {
  return { list: readList(list), payload: readPayload(payload) };
}

/** One answer of the visit: fetched once, kept; a failure is forgotten so a retry fetches again. */
type Kept<T> = { value: T | null; pending: Promise<T> | null };

function keep<T>(slot: Kept<T>, fetchIt: () => Promise<T>): Promise<T> {
  if (slot.value) return Promise.resolve(slot.value);
  if (slot.pending) return slot.pending;
  const pending = fetchIt().then(
    (value) => {
      slot.value = value;
      slot.pending = null;
      return value;
    },
    (error: unknown) => {
      slot.pending = null;
      throw error;
    },
  );
  slot.pending = pending;
  return pending;
}

const keptList: Kept<LibraryList> = { value: null, pending: null };
const keptPayload: Kept<LibraryExtrasPayload> = { value: null, pending: null };

/** TamTam's data for the visit (GET /api/switch-library). */
export function loadLibraryPayload(): Promise<LibraryExtrasPayload> {
  return keep(keptPayload, () => getJson<unknown>(EXTRAS_URL).then(readPayload));
}

/** The open list for the visit (the manifest's list file); refused while no list is built. */
export function loadLibraryList(): Promise<LibraryList> {
  const url = libraryListUrl();
  if (!url) return Promise.reject(new Error("the game list is not built yet"));
  return keep(keptList, () => getJson<unknown>(url).then(readList));
}

/** Both answers for this visit, fetched in parallel. */
export function loadLibrary(): Promise<LibraryData> {
  return Promise.all([loadLibraryList(), loadLibraryPayload()]).then(([list, payload]) => ({ list, payload }));
}

/** Runs `run` when the browser is idle (at the latest after 4 s); returns the cancel. */
function whenIdle(run: () => void): () => void {
  const host = window as Window & { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
  if (typeof host.requestIdleCallback === "function") {
    const id = host.requestIdleCallback(run, { timeout: 4000 });
    return () => host.cancelIdleCallback?.(id);
  }
  const id = window.setTimeout(run, 1200);
  return () => window.clearTimeout(id);
}

export type LibraryState = {
  status: LibraryStatus;
  data: LibraryData | null;
  /** TamTam's data alone, as soon as it answered (it may come before the list, or without it). */
  payload: LibraryExtrasPayload | null;
  /** TamTam's data did not load this time (the space bar cannot draw the games' sizes; a retry asks again). */
  payloadFailed: boolean;
  offline: boolean;
  retry: () => void;
};

/** `start`: "now" (the games and review steps), "idle" (the earlier steps: when the browser has nothing else to do). */
export function useLibrary(start: "now" | "idle"): LibraryState {
  const url = libraryListUrl();
  const [data, setData] = useState<LibraryData | null>(() => (keptList.value && keptPayload.value ? { list: keptList.value, payload: keptPayload.value } : null));
  const [payload, setPayload] = useState<LibraryExtrasPayload | null>(() => keptPayload.value);
  const [payloadFailed, setPayloadFailed] = useState(false);
  const [status, setStatus] = useState<LibraryStatus>(() => (!url ? "unbuilt" : keptList.value && keptPayload.value ? "ready" : "idle"));
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!url || data) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      setStatus("loading");
      setPayloadFailed(false);
      // TamTam's data is published on its own as soon as it answers: the space bar and the review's dates need no list
      const own = loadLibraryPayload().then(
        (value) => {
          if (!cancelled) setPayload(value);
          return value;
        },
        (error: unknown) => {
          if (!cancelled) setPayloadFailed(true);
          throw error;
        },
      );
      Promise.all([loadLibraryList(), own]).then(
        ([list, value]) => {
          if (cancelled) return;
          setData({ list, payload: value });
          setStatus("ready");
          setOffline(false);
        },
        (error: unknown) => {
          if (cancelled) return;
          // the list of an older build is gone (a deploy): only a reload helps — said so, never retried
          setStatus(isLibraryUpdated(error) ? "stale" : "error");
          setOffline(navigator.onLine === false);
        },
      );
    };
    if (start === "idle" && attempt === 0) {
      const cancel = whenIdle(run);
      return () => {
        cancelled = true;
        cancel();
      };
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [url, data, start, attempt]);

  // back online after a failure: try again by itself
  useEffect(() => {
    if (status !== "error") return;
    const again = () => setAttempt((count) => count + 1);
    window.addEventListener("online", again);
    return () => window.removeEventListener("online", again);
  }, [status]);

  return { status, data, payload, payloadFailed, offline, retry: () => setAttempt((count) => count + 1) };
}

const chunks = new Map<number, Promise<LibraryChunk>>();
const known = new Map<string, GameDetails | null>();

/** The game's details when its chunk is already here (no flash of "loading" for a chunk fetched before). */
export function cachedGameDetails(gameId: string): GameDetails | null | undefined {
  return known.get(gameId);
}

/**
 * The game's details (developers, series, Wikipedia extracts); null when its chunk has none. A chunk that is gone
 * (isLibraryUpdated) rejects like any failure — the page tells the two apart.
 */
export function loadGameDetails(list: LibraryList, game: LibraryGame): Promise<GameDetails | null> {
  if (known.has(game.id)) return Promise.resolve(known.get(game.id) ?? null);
  const name = list.chunks[game.chunk];
  if (typeof name !== "string" || name === "") return Promise.resolve(null);
  let chunk = chunks.get(game.chunk);
  if (!chunk) {
    chunk = getJson<LibraryChunk>(`${chunkBase()}${name}`);
    chunks.set(game.chunk, chunk);
    // a failed chunk is forgotten, so the sheet's retry fetches it again
    chunk.catch(() => chunks.delete(game.chunk));
  }
  return chunk.then((value) => {
    const details = isObject(value) && isObject(value.details) ? ((value.details as Record<string, GameDetails>)[game.id] ?? null) : null;
    known.set(game.id, details);
    return details;
  });
}
