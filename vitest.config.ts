/**
 * Vitest — Node environment, tests in tests/**\/*.test.ts.
 *
 *   npm test                              run everything once
 *   npm test -- tests/db-invariants.test.ts   one file
 *   npm run test:watch
 *
 * Database tests use a real local D1 through tests/helpers/db.ts (createTestDb). Every test file
 * that calls it starts its own workerd runtime with in-memory state, so files are independent of
 * each other and of the dev database; the worker count is capped because each runtime is a process.
 *
 * Deliberately separate from vite.config.ts: the Cloudflare and React Router plugins are not
 * loaded here. "cloudflare:workers" resolves to a small stand-in (tests/helpers/cloudflare-workers.ts).
 */
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      { find: /^~\//, replacement: `${fromRoot("./app")}/` },
      { find: "cloudflare:workers", replacement: fromRoot("./tests/helpers/cloudflare-workers.ts") },
    ],
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["./tests/helpers/setup.ts"],
    // Starting workerd, applying ~750 migration statements and seeding takes a few seconds.
    hookTimeout: 120_000,
    testTimeout: 30_000,
    teardownTimeout: 30_000,
    pool: "forks",
    maxWorkers: 4,
  },
});
