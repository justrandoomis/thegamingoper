/**
 * What module 06 needs from the Worker: DATA_KEY, which decrypts a digital code shown at the till (module 13 encrypts
 * them with it). Read from "cloudflare:workers" in this server-only module so route modules never import it; the
 * services take it as a parameter (tests pass their own).
 */
import { env } from "cloudflare:workers";

export function posDataKey(): string | undefined {
  return (env as { DATA_KEY?: string }).DATA_KEY || undefined;
}
