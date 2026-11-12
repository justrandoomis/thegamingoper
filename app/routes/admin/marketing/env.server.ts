/**
 * What module 16 needs from the Worker: the store's public origin (PUBLIC_ORIGIN, "https://tamtamgames.com" in
 * production), for the tracked links (16.04) and the links inside held messages (16.01, 16.02). Read from
 * "cloudflare:workers" in this server-only module so route modules never import it; the services take the origin as a
 * parameter (tests pass their own). Falls back to the request's own origin.
 */
import { env } from "cloudflare:workers";

export function marketingOrigin(requestOrigin: string): string {
  const configured = typeof env.PUBLIC_ORIGIN === "string" ? env.PUBLIC_ORIGIN.trim() : "";
  return /^https?:\/\/[^/\s]+$/.test(configured) ? configured : requestOrigin;
}
