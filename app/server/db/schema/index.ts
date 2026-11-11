/**
 * TamTam Games database schema (Cloudflare D1 / SQLite, Drizzle ORM).
 *
 *   import { orders, orderItems, type Order } from "~/server/db/schema";
 *
 * Conventions (docs/ARCHITECTURE.md §5.1 and §6):
 *   · table exports are camelCase of the SQL name (`order_items` → `orderItems`), column keys likewise
 *   · row types: `Order` / `NewOrder` (= $inferSelect / $inferInsert)
 *   · enums: `ORDER_STATUSES` (allowed values) + `OrderStatus` (union type)
 *   · [P] protected cost data and [A] append-only tables are marked in each file's comments
 *
 * Two objects are plain SQL and therefore not in this schema:
 *   _tx_guard      — see ~/server/db/tx.server
 *   search_index   — FTS5, see ~/server/db/search.server
 *
 * Changing a table? Read drizzle/README.md first: SQLite rebuilds drop the hand-written triggers.
 */
export { ACTOR_KINDS, type ActorKind, type LocalizedBlocks, type StoredBlock } from "../columns";
export * from "./core";
export * from "./catalog";
export * from "./inventory";
export * from "./customers";
export * from "./commerce";
export * from "./shipping";
export * from "./aftersales";
export * from "./used";
export * from "./support";
export * from "./purchasing";
export * from "./accounting";
export * from "./staff";
export * from "./pos";
export * from "./growth";
export * from "./cms";
export * from "./ops";
export * from "./relations";
