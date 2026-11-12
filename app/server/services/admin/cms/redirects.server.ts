/**
 * Admin 17.04 — 301/302 redirects (`redirects`), and the storefront's read of them.
 *
 *   listRedirects(db, actor, parseRedirectFilters(url.searchParams), now)
 *   saveRedirect(db, actor, raw, now)                       → { id, created }
 *   setRedirectsActive(db, actor, { ids, active, reason }, now)   (one or many — the bulk action)
 *   resolveRedirect(db, pathname) · recordRedirectHit(db, id)       ← the storefront's reads (see below)
 *
 * Rules (rules.ts, checked here and AGAIN inside the write batch, so two people saving at once cannot build one):
 *   · both ends are locale-less storefront paths, normalized (lower case, no trailing slash, no locale prefix); the
 *     target may carry a query or be an https URL of another site; the source is a bare path. A full address of the
 *     store itself (tamtamgames.com, www., the request's origin) is the path it names (ownStorePath) — so it meets
 *     every rule below like the path does
 *   · never the admin, the API, built assets or the files crawlers ask for (`path_reserved`), and never the home page
 *     as a source (`path_home`)
 *   · never a loop (A → A, or A → B while B → A) and never a CHAIN: the target may not itself be redirected, and no
 *     other redirect may point at the source — one hop, always
 *   · an internal target must open something today (a live product, category, platform, device hub, policy…:
 *     checkStoreLink); a target the check cannot judge is allowed and marked "not checked"
 * Redirects are switched off, never deleted (their hit counts stay readable). Every change is audited with a reason
 * where it changes what shoppers get. Permission: cms.redirect.manage.
 *
 * The storefront calls resolveRedirect ONLY where it would answer 404 (the catch-all route, and the product /
 * category loaders before they throw their 404): a redirect can never hide a page that exists.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { newId } from "~/lib/ids";
import { assertCan, type Actor } from "~/server/actor";
import { auditStatement } from "~/server/audit.server";
import type { BatchStatement, Db } from "~/server/db/drizzle.server";
import { redirects, type Redirect } from "~/server/db/schema";
import { expectChanged, expectThat, mapDbError, runBatch } from "~/server/db/tx.server";
import { invalid, notFound } from "~/server/errors";
import { PAGE_SIZE, REDIRECT_CODES, isSafeExternalUrl, normalizeStorePath, oneOf, ownStorePath, pageOf, queryText, redirectConflict, targetPathOf, type RedirectConflict } from "./rules";
import { actorIdOf, checkStoreLink, cmsError, parseInput, zReason, type LinkCheck } from "./shared.server";

export const REDIRECT_STATES = ["all", "active", "inactive"] as const;
export type RedirectFilters = { q: string; state: (typeof REDIRECT_STATES)[number]; page: number };

export function parseRedirectFilters(params: URLSearchParams): RedirectFilters {
  return { q: queryText(params.get("q")), state: oneOf(params.get("state"), REDIRECT_STATES, "all"), page: pageOf(params.get("page")) };
}

export type RedirectRow = { id: string; fromPath: string; toPath: string; code: number; isActive: boolean; hits: number; createdAt: number; createdBy: string | null; target: LinkCheck; external: boolean };
/** `counts`: per state among the rows the words filter keeps (each chip's count is the list it opens); `stored`: every redirect. */
export type RedirectList = { rows: RedirectRow[]; total: number; page: number; pageCount: number; counts: Record<(typeof REDIRECT_STATES)[number], number>; stored: number };

export async function listRedirects(db: Db, actor: Actor, filters: RedirectFilters, now: number): Promise<RedirectList> {
  assertCan(actor, "cms.redirect.manage");
  const all = await db.select().from(redirects).orderBy(desc(redirects.createdAt), asc(redirects.id));
  const needle = filters.q.toLowerCase();
  const matching = all.filter((row) => !needle || row.fromPath.includes(needle) || row.toPath.toLowerCase().includes(needle));
  const counts = { all: matching.length, active: matching.filter((row) => row.isActive).length, inactive: matching.filter((row) => !row.isActive).length };
  const filtered = matching.filter((row) => (filters.state === "active" ? row.isActive : filters.state === "inactive" ? !row.isActive : true));
  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const page = Math.min(filters.page, pageCount);
  const slice = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const rows: RedirectRow[] = [];
  for (const row of slice) {
    rows.push({ id: row.id, fromPath: row.fromPath, toPath: row.toPath, code: row.code, isActive: row.isActive, hits: row.hits, createdAt: row.createdAt, createdBy: row.createdBy, target: await checkStoreLink(db, row.toPath, now), external: targetPathOf(row.toPath) === null });
  }
  return { rows, total: filtered.length, page, pageCount, counts, stored: all.length };
}

export const RedirectInput = z.object({
  id: z.string().trim().min(1).max(128).optional(),
  /** What the edit form showed (fromPath | toPath | code | active): the guard (the table has no version column). */
  version: z.string().max(1000).optional(),
  fromPath: z.string({ error: "required" }).trim().min(1, "required").max(300, "too_long"),
  toPath: z.string({ error: "required" }).trim().min(1, "required").max(500, "too_long"),
  code: z.coerce.number().refine((value) => (REDIRECT_CODES as readonly number[]).includes(value), "invalid").default(301),
  reason: zReason(false),
});

const versionOf = (row: Pick<Redirect, "fromPath" | "toPath" | "code" | "isActive">) => `${row.fromPath}|${row.toPath}|${row.code}|${row.isActive ? 1 : 0}`;

/**
 * Both ends normalized, or field errors. A full address of the store's own host (or of `origins`) is the path it names
 * (ownStorePath), so the rules below hold for it too — only another site's https address stays external.
 */
function endsOf(input: { fromPath: string; toPath: string }, origins: readonly string[]): { fromPath: string; toPath: string } {
  const fields: Record<string, string> = {};
  const from = normalizeStorePath(ownStorePath(input.fromPath, origins) ?? input.fromPath, { query: false });
  let toPath = "";
  if (!from.ok) fields.fromPath = from.code === "path_external" ? "path_external" : from.code;
  else if (from.path === "/") fields.fromPath = "path_home";
  const own = ownStorePath(input.toPath, origins);
  if (own === null && /^https?:\/\//i.test(input.toPath.trim())) {
    if (isSafeExternalUrl(input.toPath)) toPath = input.toPath.trim();
    else fields.toPath = "link_invalid";
  } else {
    const to = normalizeStorePath(own ?? input.toPath, { query: true });
    if (to.ok) toPath = `${to.path}${to.query}`;
    else fields.toPath = to.code;
  }
  if (Object.keys(fields).length > 0) throw invalid(fields);
  return { fromPath: (from as { path: string }).path, toPath };
}

const CONFLICT_FIELD: Record<RedirectConflict, "fromPath" | "toPath"> = {
  redirect_self: "toPath",
  redirect_from_taken: "fromPath",
  redirect_loop: "toPath",
  redirect_chain_target: "toPath",
  redirect_chain_source: "fromPath",
};

/** The batch guards that keep the rules true at the moment of writing (an active rule may not chain with another). */
function chainGuards(db: Db, id: string, fromPath: string, toPath: string): BatchStatement[] {
  const target = targetPathOf(toPath);
  const guards: BatchStatement[] = [
    // (substr, not LIKE: "_" and "%" in a path are not wildcards)
    expectThat(db, sql`NOT EXISTS (SELECT 1 FROM redirects WHERE is_active = 1 AND id <> ${id} AND (to_path = ${fromPath} OR substr(to_path, 1, ${[...fromPath].length + 1}) = ${`${fromPath}?`}))`, { code: "REDIRECT_CHAIN_SOURCE", detail: fromPath }),
  ];
  if (target !== null) guards.unshift(expectThat(db, sql`NOT EXISTS (SELECT 1 FROM redirects WHERE is_active = 1 AND id <> ${id} AND from_path = ${target})`, { code: "REDIRECT_CHAIN_TARGET", detail: target }));
  return guards;
}

function mapRedirectError(error: unknown): never {
  const info = mapDbError(error);
  if (info?.code === "REDIRECT_CHAIN_SOURCE") throw cmsError("redirect_chain_source", 409, { fields: { fromPath: "redirect_chain_source" } });
  if (info?.code === "REDIRECT_CHAIN_TARGET") throw cmsError("redirect_chain_target", 409, { fields: { toPath: "redirect_chain_target" } });
  if (info?.code === "CONTENT_CHANGED") throw cmsError("content_changed", 409);
  if (info?.kind === "unique") throw cmsError("redirect_from_taken", 409, { fields: { fromPath: "redirect_from_taken" } });
  if (info?.kind === "check") throw cmsError("redirect_self", 409, { fields: { toPath: "redirect_self" } });
  throw error;
}

/**
 * Creates an active redirect, or changes one's target or code (its source stays: make a new one for another path).
 * `origins`: the request's own origin (the route passes ctx.origin) — a full address on it is a store path, like one on
 * tamtamgames.com.
 */
export async function saveRedirect(db: Db, actor: Actor, raw: unknown, now: number, options: { origins?: readonly string[] } = {}): Promise<{ id: string; created: boolean }> {
  assertCan(actor, "cms.redirect.manage");
  const input = parseInput(RedirectInput, raw);
  const ends = endsOf(input, options.origins ?? []);
  const existing = input.id ? await db.select().from(redirects).where(eq(redirects.id, input.id)).get() : undefined;
  if (input.id && !existing) throw notFound("redirect");
  if (existing && input.version !== versionOf(existing)) throw cmsError("content_changed", 409);
  const fromPath = existing ? existing.fromPath : ends.fromPath;
  const all = await db.select({ id: redirects.id, fromPath: redirects.fromPath, toPath: redirects.toPath, isActive: redirects.isActive }).from(redirects);
  const conflict = redirectConflict(all, { id: existing?.id ?? null, fromPath, toPath: ends.toPath, isActive: existing ? existing.isActive : true });
  if (conflict) throw cmsError(conflict, 409, { fields: { [CONFLICT_FIELD[conflict]]: conflict } });
  const target = await checkStoreLink(db, ends.toPath, now);
  if (target.state === "missing" || target.state === "not_live") throw cmsError("redirect_target_missing", 409, { fields: { toPath: "redirect_target_missing" } });
  if (!existing) {
    const id = newId("rdr");
    await runBatch(db, [
      ...chainGuards(db, id, fromPath, ends.toPath),
      db.insert(redirects).values({ id, fromPath, toPath: ends.toPath, code: input.code, isActive: true, createdBy: actorIdOf(actor), createdAt: now }),
      auditStatement(db, { actor, action: "cms.redirect.create", entityType: "redirect", entityId: id, after: { fromPath, toPath: ends.toPath, code: input.code }, reason: input.reason ?? null, at: now }),
    ]).catch(mapRedirectError);
    return { id, created: true };
  }
  if (existing.toPath === ends.toPath && existing.code === input.code) return { id: existing.id, created: false };
  await runBatch(db, [
    expectThat(db, sql`EXISTS (SELECT 1 FROM redirects WHERE id = ${existing.id} AND to_path = ${existing.toPath} AND code = ${existing.code} AND is_active = ${existing.isActive ? 1 : 0})`, { code: "CONTENT_CHANGED", detail: existing.id }),
    ...(existing.isActive ? chainGuards(db, existing.id, fromPath, ends.toPath) : []),
    db.update(redirects).set({ toPath: ends.toPath, code: input.code }).where(eq(redirects.id, existing.id)),
    auditStatement(db, { actor, action: "cms.redirect.update", entityType: "redirect", entityId: existing.id, before: { toPath: existing.toPath, code: existing.code }, after: { toPath: ends.toPath, code: input.code }, reason: input.reason ?? null, at: now }),
  ]).catch(mapRedirectError);
  return { id: existing.id, created: false };
}

const ActiveInput = z.object({ ids: z.array(z.string().trim().min(1).max(128)).min(1, "required").max(100, "too_long"), active: z.boolean(), reason: zReason(true) });

export type ActiveOutcome = { changed: string[]; skipped: { id: string; code: string }[] };

/**
 * Switches redirects on or off — one or many (the bulk action). Switching on checks each one against the rules with
 * the others already on (and those switched on just before it in the same request); the ones that would chain or
 * loop are skipped with their reason. One batch, guarded.
 */
export async function setRedirectsActive(db: Db, actor: Actor, raw: unknown, now: number): Promise<ActiveOutcome> {
  assertCan(actor, "cms.redirect.manage");
  const input = parseInput(ActiveInput, raw);
  const ids = [...new Set(input.ids)];
  const all = await db.select().from(redirects);
  const working = all.map((row) => ({ id: row.id, fromPath: row.fromPath, toPath: row.toPath, isActive: row.isActive }));
  const outcome: ActiveOutcome = { changed: [], skipped: [] };
  const statements: BatchStatement[] = [];
  for (const id of ids) {
    const row = all.find((entry) => entry.id === id);
    if (!row) {
      outcome.skipped.push({ id, code: "not_found" });
      continue;
    }
    if (row.isActive === input.active) {
      outcome.skipped.push({ id, code: "nothing_changed" });
      continue;
    }
    if (input.active) {
      const conflict = redirectConflict(working, { id: row.id, fromPath: row.fromPath, toPath: row.toPath, isActive: true });
      if (conflict) {
        outcome.skipped.push({ id, code: conflict });
        continue;
      }
      statements.push(...chainGuards(db, row.id, row.fromPath, row.toPath));
    }
    const entry = working.find((other) => other.id === row.id);
    if (entry) entry.isActive = input.active;
    statements.push(
      db.update(redirects).set({ isActive: input.active }).where(and(eq(redirects.id, row.id), eq(redirects.isActive, row.isActive))),
      // someone switched it a moment ago: no second event, no change reported that did not happen (review 2026-11-12)
      expectChanged(db, 1, { code: "CONTENT_CHANGED", detail: row.id }),
      auditStatement(db, { actor, action: input.active ? "cms.redirect.activate" : "cms.redirect.deactivate", entityType: "redirect", entityId: row.id, before: { active: row.isActive, fromPath: row.fromPath, toPath: row.toPath }, after: { active: input.active }, reason: input.reason, at: now }),
    );
    outcome.changed.push(row.id);
  }
  if (statements.length > 0) await runBatch(db, statements).catch(mapRedirectError);
  return outcome;
}

// ───────────────────────────────────────────────────────────────── the storefront's read

export type RedirectHit = { id: string; to: string; code: 301 | 302 | 307 | 308; external: boolean };

/**
 * The redirect for a requested path (any locale: "/en/old-name" finds "/old-name"; the caller adds the visitor's
 * locale to an internal target with localePath). Null when there is none, it is switched off, or the path is reserved.
 * Call it only where the storefront would answer 404.
 */
export async function resolveRedirect(db: Db, pathname: string): Promise<RedirectHit | null> {
  const parsed = normalizeStorePath(pathname, { query: true });
  if (!parsed.ok || parsed.path === "/") return null;
  const row = await db.select({ id: redirects.id, toPath: redirects.toPath, code: redirects.code }).from(redirects).where(and(eq(redirects.fromPath, parsed.path), eq(redirects.isActive, true))).get();
  if (!row) return null;
  const external = targetPathOf(row.toPath) === null;
  return { id: row.id, to: row.toPath, code: (REDIRECT_CODES as readonly number[]).includes(row.code) ? (row.code as 301 | 302) : 301, external };
}

/** Counts one use of a redirect (fire and forget from the storefront: `ctx.waitUntil(recordRedirectHit(db, hit.id))`). */
export async function recordRedirectHit(db: Db, id: string): Promise<void> {
  await db.update(redirects).set({ hits: sql`${redirects.hits} + 1` }).where(eq(redirects.id, id));
}

export async function countActiveRedirects(db: Db): Promise<number> {
  const rows = await db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM redirects WHERE is_active = 1`);
  return Number(rows[0]?.n ?? 0);
}

export { versionOf as redirectVersion };
