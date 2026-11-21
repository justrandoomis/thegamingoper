/**
 * Polite HTTP for the Switch library scripts (docs/switch-builder.md §1, §4.1).
 *
 * Only two open-data services are ever contacted, and the allowlist below refuses everything else — including a
 * redirect that would leave them:
 *   - the Wikidata Query Service, https://query.wikidata.org/sparql (CC0 data);
 *   - the Wikimedia REST summary endpoint of the English, Arabic and Sorani Wikipedias (CC BY-SA 4.0 text).
 * Nothing from Nintendo's or Metacritic's sites, ever.
 *
 * Etiquette: one request at a time per client, at least `minIntervalMs` apart; gzip; a generic descriptive
 * User-Agent with no names, contact data or project data; on 429 / 5xx the client waits (Retry-After when sent,
 * else exponential back-off) and tries again a few times, then gives up with an error.
 */

/** Generic and descriptive, as the Wikimedia User-Agent policy asks — and nothing that identifies a person or a project. */
export const USER_AGENT = "SwitchLibraryBuild/1.0 (open-data catalogue script)";

export const ALLOWED_HOSTS = Object.freeze(["query.wikidata.org", "en.wikipedia.org", "ar.wikipedia.org", "ckb.wikipedia.org"]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Throws unless `url` is https on one of ALLOWED_HOSTS. */
export function assertAllowed(url) {
  const parsed = url instanceof URL ? url : new URL(url);
  if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.includes(parsed.hostname)) {
    throw new Error(`refusing to contact ${parsed.protocol}//${parsed.hostname}: only ${ALLOWED_HOSTS.join(", ")} are allowed`);
  }
  return parsed;
}

/**
 * A sequential client: `request(url, init)` resolves with the final Response (2xx, 3xx without Location, or a 4xx
 * other than 429 — the caller decides what a 404 means). Redirects are followed by hand (at most 3), each hop checked
 * against the allowlist.
 *
 * With `adaptive`, the spacing starts at `startMs`, doubles after every 429 (up to `ceilingMs`) and eases back by 2 %
 * after every answer that is not one (never below `minIntervalMs`): the client settles at whatever rate the service
 * grants a client that does not identify itself, instead of asking again and again.
 *
 * @param {{ minIntervalMs: number, adaptive?: { startMs: number, ceilingMs: number }, maxAttempts?: number, timeoutMs?: number, log?: (line: string) => void }} options
 */
export function createClient({ minIntervalMs, adaptive, maxAttempts = 5, timeoutMs = 90_000, log = (line) => process.stderr.write(`${line}\n`) }) {
  let last = 0;
  let count = 0;
  let interval = adaptive ? Math.max(minIntervalMs, adaptive.startMs) : minIntervalMs;
  const backoff = (attempt) => Math.min(120_000, 5_000 * 3 ** (attempt - 1));
  const eased = () => {
    if (adaptive) interval = Math.max(minIntervalMs, Math.round(interval * 0.98));
  };
  const throttled = () => {
    if (adaptive) interval = Math.min(adaptive.ceilingMs, interval * 2);
  };

  async function once(url, init) {
    const wait = last + interval - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    count += 1;
    return fetch(url, {
      ...init,
      redirect: "manual",
      headers: { "User-Agent": USER_AGENT, "Accept-Encoding": "gzip", ...(init?.headers ?? {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  async function request(input, init = {}) {
    let url = assertAllowed(input);
    for (let hop = 0; ; hop++) {
      let response;
      for (let attempt = 1; ; attempt++) {
        try {
          response = await once(url, init);
        } catch (error) {
          if (attempt >= maxAttempts) throw new Error(`${url.hostname}: ${error instanceof Error ? error.message : String(error)} (gave up after ${attempt} attempts)`);
          const pause = backoff(attempt);
          log(`  ${url.hostname}: ${error instanceof Error ? error.message : String(error)}; retrying in ${Math.round(pause / 1000)} s`);
          await sleep(pause);
          continue;
        }
        if (response.status !== 429 && response.status < 500) {
          eased();
          break;
        }
        await response.body?.cancel().catch(() => {});
        if (response.status === 429) throttled();
        if (attempt >= maxAttempts) throw new Error(`${url.hostname}: HTTP ${response.status} (gave up after ${attempt} attempts)`);
        const retryAfter = Number(response.headers.get("retry-after"));
        const pause = Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 300_000) : backoff(attempt);
        log(`  ${url.hostname}: HTTP ${response.status}; waiting ${Math.round(pause / 1000)} s, then one request every ${(interval / 1000).toFixed(2)} s`);
        await sleep(pause);
      }
      const location = response.status >= 300 && response.status < 400 ? response.headers.get("location") : null;
      if (!location) return response;
      await response.body?.cancel().catch(() => {});
      if (hop >= 3) throw new Error(`${url.hostname}: too many redirects`);
      url = assertAllowed(new URL(location, url));
    }
  }

  return { request, get count() { return count; }, get intervalMs() { return interval; } };
}
