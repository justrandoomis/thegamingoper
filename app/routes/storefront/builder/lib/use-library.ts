/**
 * The open game list and TamTam's data for it, in the browser (docs/switch-builder.md §4, §6.4).
 *
 *   const library = useLibrary(step === "games" || step === "review" ? "now" : "idle");
 *   library.status   "unbuilt" (no list file yet — LIBRARY_LIST_FILE is null) · "idle" · "loading" · "ready" · "error"
 *   library.data     { list, payload } once both answered: public/library/switch/list.<hash>.json (immutable) and
 *                    GET /api/switch-library (sizes, prices, pictures…, the planner's constants)
 *   library.retry()  after an error (it also retries by itself when the connection comes back)
 *
 *   loadGameDetails(list, game)     the game's details chunk (public/library/switch/d/<n>.<hash>.json), each chunk
 *                                   fetched once per visit and kept
 *
 * The earlier steps start the download when the browser is idle, so the games step usually opens with the list in
 * hand. Both answers are kept for the visit (module scope): moving between steps never fetches them again. Nothing
 * here runs on the server — the server renders the loading state.
 */
import { useEffect, useState } from "react";

import { sanitizeCapacity } from "~/lib/switch-builder/storage";
import type { GameDetails, LibraryChunk, LibraryExtras, LibraryExtrasPayload, LibraryGame, LibraryList } from "~/lib/switch-builder/types";
import * as manifest from "../library.manifest";

export type LibraryStatus = "unbuilt" | "idle" | "loading" | "ready" | "error";
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

/**
 * Every file here is public and the same for everyone: no cookie goes with the request ("omit"), so a shopper with a
 * cart or a preference cookie is served GET /api/switch-library from the edge cache like an anonymous visitor (the
 * cache never keeps a request that carries a store cookie — workers/edge-cache.ts), instead of reading D1 each visit.
 */
async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "omit", headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return (await response.json()) as T;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
const text = (value: unknown): string | undefined => (typeof value === "string" && value.trim() !== "" ? value : undefined);

/**
 * The two answers, checked for their shape (a broken file is an error, never a half-drawn page; a game's malformed
 * field is left out — the search reads every title, alias and publisher as text while the page renders). Pure.
 */
export function readLibrary(list: unknown, payload: unknown): LibraryData {
  if (!isObject(list) || list.version !== 1 || !Array.isArray(list.games) || !Array.isArray(list.chunks)) throw new Error("the game list has an unknown shape");
  if (!isObject(payload) || !isObject(payload.extras)) throw new Error("the library data has an unknown shape");
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
  return {
    list: { ...(list as unknown as LibraryList), games },
    payload: { rev: typeof payload.rev === "string" ? payload.rev : "", extras: payload.extras as Record<string, LibraryExtras>, capacity: sanitizeCapacity(payload.capacity) },
  };
}

let loaded: LibraryData | null = null;
let pending: Promise<LibraryData> | null = null;

/** Both answers for this visit: fetched once (in parallel), kept; a failure is forgotten so a retry fetches again. */
export function loadLibrary(): Promise<LibraryData> {
  if (loaded) return Promise.resolve(loaded);
  if (pending) return pending;
  const url = libraryListUrl();
  if (!url) return Promise.reject(new Error("the game list is not built yet"));
  pending = Promise.all([getJson<unknown>(url), getJson<unknown>(EXTRAS_URL)]).then(
    ([list, payload]) => {
      loaded = readLibrary(list, payload);
      pending = null;
      return loaded;
    },
    (error: unknown) => {
      pending = null;
      throw error;
    },
  );
  return pending;
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

export type LibraryState = { status: LibraryStatus; data: LibraryData | null; offline: boolean; retry: () => void };

/** `start`: "now" (the games and review steps), "idle" (the earlier steps: when the browser has nothing else to do). */
export function useLibrary(start: "now" | "idle"): LibraryState {
  const url = libraryListUrl();
  const [data, setData] = useState<LibraryData | null>(() => loaded);
  const [status, setStatus] = useState<LibraryStatus>(() => (!url ? "unbuilt" : loaded ? "ready" : "idle"));
  const [offline, setOffline] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!url || data) return;
    let cancelled = false;
    const run = () => {
      if (cancelled) return;
      setStatus("loading");
      loadLibrary().then(
        (result) => {
          if (cancelled) return;
          setData(result);
          setStatus("ready");
          setOffline(false);
        },
        () => {
          if (cancelled) return;
          setStatus("error");
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

  return { status, data, offline, retry: () => setAttempt((count) => count + 1) };
}

const chunks = new Map<number, Promise<LibraryChunk>>();
const known = new Map<string, GameDetails | null>();

/** The game's details when its chunk is already here (no flash of "loading" for a chunk fetched before). */
export function cachedGameDetails(gameId: string): GameDetails | null | undefined {
  return known.get(gameId);
}

/** The game's details (developers, series, Wikipedia extracts); null when its chunk has none. */
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
