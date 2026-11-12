/**
 * What module 08 needs from the Worker: DATA_KEY, which encrypts gift-card codes (as the devices module encrypts
 * digital codes). Read from "cloudflare:workers" in this server-only module so route modules never import it; the
 * services take it as a parameter (tests pass their own).
 */
import { env } from "cloudflare:workers";

export function promotionsDataKey(): string | undefined {
  return env.DATA_KEY || undefined;
}
