/**
 * Runs in every test file (vitest `setupFiles`). Closes any test database the file left open, so a
 * forgotten dispose() — or a test that threw before reaching it — cannot leave a workerd process
 * behind. It reads a global registry instead of importing ./db, so files that do not use the
 * database do not pay for loading wrangler.
 */
import { afterAll } from "vitest";

afterAll(async () => {
  const open = (globalThis as { __tamtamTestDbs?: Set<() => Promise<void>> }).__tamtamTestDbs;
  if (!open) return;
  for (const dispose of [...open]) await dispose().catch(() => {});
});
