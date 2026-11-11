/**
 * Admin module 20 (security) — the route kit bound to its namespace, and DATA_KEY for the encryption self-test (read
 * from "cloudflare:workers" in this server-only module, so route modules never import it).
 */
import { env } from "cloudflare:workers";
import { SECURITY_NS } from "./meta";
import { routeKit } from "./route-kit.server";

export const sec = routeKit(SECURITY_NS);

/** The secret the encryption self-test needs. Its value never leaves the server (only booleans and counts do). */
export function securitySecrets(): { DATA_KEY?: string } {
  return { DATA_KEY: (env as { DATA_KEY?: string }).DATA_KEY };
}
