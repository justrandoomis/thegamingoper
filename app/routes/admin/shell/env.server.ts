/**
 * The Worker secrets the admin's auth screens need (DATA_KEY for authenticator secrets, SETUP_TOKEN for the
 * first-owner setup), read from "cloudflare:workers" in this server-only module so route modules never import it.
 * The auth services take them as parameters (tests pass their own).
 */
import { env } from "cloudflare:workers";
import type { AuthSecrets } from "~/server/auth/admin.server";

export function adminSecrets(): AuthSecrets {
  return { SESSION_SECRET: env.SESSION_SECRET, DATA_KEY: env.DATA_KEY, SETUP_TOKEN: env.SETUP_TOKEN };
}
