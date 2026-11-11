/**
 * Test stand-in for the "cloudflare:workers" module (aliased in vitest.config.ts).
 *
 * Services never import "cloudflare:workers" — they receive `db` as an argument — but a test may
 * pull in a module that does (getDb(), code reading env.SESSION_SECRET). Those imports resolve
 * here. `env` starts empty and is filled with the local bindings (DB, KV, vars) and the fixed TEST_VARS
 * (APP_ENV, PUBLIC_ORIGIN, fake secrets — never .dev.vars) by createTestDb(); with several test databases alive, it
 * points at the newest one.
 */
export const env: Record<string, unknown> = {};

/** Replace the bindings seen by code that reads `env` from "cloudflare:workers". */
export function setTestEnv(bindings: Record<string, unknown>): void {
  for (const key of Object.keys(env)) delete env[key];
  Object.assign(env, bindings);
}

/** Minimal base classes so modules that extend them can be imported in Node. */
export class WorkerEntrypoint {}
export class DurableObject {}
