/**
 * drizzle-kit configuration — used ONLY to generate SQL migrations from the schema:
 *
 *   npm run db:generate -- --name=<what_changed>          diff the schema, write drizzle/NNNN_<name>.sql
 *   npm run db:generate -- --custom --name=<what_changed> empty file for hand-written SQL (triggers, FTS, data fixes)
 *
 * Migrations are applied by wrangler (`npm run db:migrate`, `npm run db:migrate:remote`), never by
 * drizzle-kit: there are deliberately no database credentials here. Read drizzle/README.md before
 * changing a table — a generated table rebuild silently drops the hand-written triggers on it.
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./app/server/db/schema",
  out: "./drizzle",
});
