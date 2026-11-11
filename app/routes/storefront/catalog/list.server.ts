/**
 * Server helpers shared by the catalog pages' loaders (thin: parse, call the service, shape).
 */
import { redirect } from "react-router";

import { isAppError } from "~/server/errors";

/** A category or platform slug as the URL may carry it (anything else is a 404 without touching the database). */
export const PAGE_SLUG = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

/**
 * Runs a list request; a cursor the service refuses (an old link made for another sort, or for a list that has
 * changed since) sends the shopper to the same list without it — the first page — instead of an error.
 */
export async function withCursorFallback<T>(url: URL, hasCursor: boolean, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (hasCursor && isAppError(error, "invalid")) {
      const next = new URL(url);
      next.searchParams.delete("cursor");
      throw redirect(`${next.pathname}${next.search}`);
    }
    throw error;
  }
}

/** The list part of a ListingResult, for the page (the hub travels separately). */
export function listOf<T extends { hub?: unknown }>(result: T): Omit<T, "hub"> {
  const { hub: _hub, ...rest } = result;
  return rest;
}
