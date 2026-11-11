-- TamTam Games — append-only tables refuse INSERT OR REPLACE (docs/STATUS.md open item 14).
--
-- Hand-written. Statements are separated by drizzle's statement-breakpoint marker line (never write
-- that marker inside a comment: migration runners split on it blindly).
--
-- The gap
--   SQLite settles a PRIMARY KEY or UNIQUE conflict of INSERT OR REPLACE (also written REPLACE INTO)
--   by deleting the existing row and inserting the new one. DELETE triggers do not fire for that
--   delete (recursive_triggers is off in D1), so the <table>_no_update / <table>_no_delete triggers
--   of 0001_invariants.sql never see it: one statement could rewrite a wallet ledger entry, a
--   journal line or an audit event in place.
--
-- The guard
--   Every append-only table [A] gets a BEFORE INSERT trigger <table>_no_replace. It fires only when
--   the new row meets an existing row on the primary key or on any other UNIQUE key (an idempotency
--   key, a seal range, a reversal), and then runs one probe statement:
--       INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('<table>', NULL)
--   SQLite runs the statements of a trigger with the conflict clause of the statement that fired it
--   when that statement names one (INSERT OR REPLACE, INSERT OR IGNORE …), and with their own clause
--   otherwise (a plain INSERT, and an upsert: ON CONFLICT DO NOTHING / DO UPDATE). The probe breaks
--   NOT NULL on purpose, so:
--     · plain INSERT, ON CONFLICT DO NOTHING / DO UPDATE, INSERT OR IGNORE: the probe runs as
--       OR IGNORE, is skipped and writes nothing. The insert then meets SQLite's own conflict
--       handling exactly as before this migration:
--         plain INSERT            fails with "UNIQUE constraint failed: <table>.<column>"
--         DO NOTHING, OR IGNORE   skip the row (changes() = 0, D1 meta.changes = 0)
--         DO UPDATE               becomes an UPDATE and meets <table>_no_update (TT:IMMUTABLE:<table>)
--     · INSERT OR REPLACE / REPLACE INTO: the probe runs as OR REPLACE, which settles a NOT NULL
--       violation by writing the column default. A probe row is inserted, and its AFTER INSERT
--       trigger _replace_guard_check aborts the whole statement (and the batch around it) with
--       TT:IMMUTABLE:<table> before anything is replaced.
--   _replace_guard never keeps a row (like _tx_guard: a row written to it directly is refused the
--   same way). On every statement that succeeds the guard writes nothing. That matters on D1, which
--   counts rows written by triggers in meta.changes: the counts read by the demo seed and the row
--   counts of every batch stay what they were. A row that meets no existing key is not affected at
--   all (INSERT OR REPLACE of a new row is just an insert).
--   Side effect: INSERT OR ABORT / OR FAIL that meets an existing key is still refused, but SQLite
--   then names the probe ("NOT NULL constraint failed: _replace_guard.probe") instead of the UNIQUE
--   key. Nothing in this code base writes those clauses (and OR ROLLBACK is an internal error on D1).
--
-- Why not RAISE(ABORT) or RAISE(IGNORE) in the trigger itself
--   A BEFORE INSERT trigger fires before the conflict check and cannot see the conflict clause, so a
--   direct RAISE would change EVERY insert that meets an existing key:
--     RAISE(ABORT, 'TT:IMMUTABLE…')  a plain duplicate would report IMMUTABLE instead of UNIQUE, which
--                                    creditWallet, sealAudit and mapPostingError (already_posted) read,
--                                    and ON CONFLICT DO NOTHING would fail: the demo seed writes
--                                    stock_movements that way (its second run writes 0 rows, and its
--                                    --sql file is applied twice).
--     RAISE(IGNORE)                  a plain duplicate would be skipped in silence while the rest of
--                                    its batch commits: a replayed journal header would leave its
--                                    lines without a header, a replayed wallet credit would post its
--                                    journal entry twice, a raced audit seal would count as written.
--   The probe keeps all of that exactly as it was and refuses REPLACE only, with one rule for all
--   fifteen tables.
--
-- Per table: the keys its trigger checks, and how the code writes the table today
--   audit_events      seq, id                           auditStatement() / audit(): plain insert, new id
--   audit_seals       id, from_seq, to_seq              sealAudit(): plain insert; a concurrent run gets
--                                                       UNIQUE from_seq and continues from the new head
--   product_versions  id, (product_id, version)         no writer yet (an editor will rely on the UNIQUE version)
--   price_changes     id                                no writer yet
--   stock_movements   id                                stock and returns services: plain inserts, new ids;
--                                                       demo seed: ON CONFLICT (id) DO NOTHING (idempotent)
--   consents          id                                placeOrder(): plain insert, new id
--   order_events      id                                order, payment and refund services: plain inserts
--   wallet_ledger     id, idempotency_key               creditWallet(): plain insert, UNIQUE idempotency_key
--                                                       returns the first entry (replayed: true); debits and
--                                                       refund credits are plain inserts inside their batch
--   loyalty_ledger    id, idempotency_key               no writer yet
--   shipment_events   id                                no writer yet
--   repair_events     id                                no writer yet
--   trade_in_events   id                                no writer yet
--   journal_entries   id, idempotency_key, reverses_id  journalEntryStatements(): plain insert, last in the
--                                                       batch; UNIQUE idempotency_key is already_posted,
--                                                       UNIQUE reverses_id means an entry is reversed once
--   journal_lines     id                                journalEntryStatements(): plain inserts, ids <entry>.<n>
--   cash_movements    id, idempotency_key               no writer yet (point of sale)
--
-- A later migration that rebuilds one of these tables drops its _no_replace trigger with it: re-create
-- the trigger in that migration, and name every new UNIQUE key of an [A] table in its WHEN clause.
-- tests/db-invariants.test.ts fails when a trigger is missing or a UNIQUE key is not covered.

CREATE TABLE `_replace_guard` (
	`tbl` text NOT NULL,
	`probe` integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TRIGGER `_replace_guard_check` AFTER INSERT ON `_replace_guard`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:' || NEW.tbl);
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_replace` BEFORE INSERT ON `audit_events`
WHEN EXISTS (SELECT 1 FROM audit_events WHERE seq = NEW.seq)
  OR EXISTS (SELECT 1 FROM audit_events WHERE id = NEW.id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('audit_events', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `audit_seals_no_replace` BEFORE INSERT ON `audit_seals`
WHEN EXISTS (SELECT 1 FROM audit_seals WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM audit_seals WHERE from_seq = NEW.from_seq)
  OR EXISTS (SELECT 1 FROM audit_seals WHERE to_seq = NEW.to_seq)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('audit_seals', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `product_versions_no_replace` BEFORE INSERT ON `product_versions`
WHEN EXISTS (SELECT 1 FROM product_versions WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM product_versions WHERE product_id = NEW.product_id AND version = NEW.version)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('product_versions', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `price_changes_no_replace` BEFORE INSERT ON `price_changes`
WHEN EXISTS (SELECT 1 FROM price_changes WHERE id = NEW.id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('price_changes', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `stock_movements_no_replace` BEFORE INSERT ON `stock_movements`
WHEN EXISTS (SELECT 1 FROM stock_movements WHERE id = NEW.id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('stock_movements', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `consents_no_replace` BEFORE INSERT ON `consents`
WHEN EXISTS (SELECT 1 FROM consents WHERE id = NEW.id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('consents', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `order_events_no_replace` BEFORE INSERT ON `order_events`
WHEN EXISTS (SELECT 1 FROM order_events WHERE id = NEW.id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('order_events', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `wallet_ledger_no_replace` BEFORE INSERT ON `wallet_ledger`
WHEN EXISTS (SELECT 1 FROM wallet_ledger WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM wallet_ledger WHERE idempotency_key = NEW.idempotency_key)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('wallet_ledger', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_ledger_no_replace` BEFORE INSERT ON `loyalty_ledger`
WHEN EXISTS (SELECT 1 FROM loyalty_ledger WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM loyalty_ledger WHERE idempotency_key = NEW.idempotency_key)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('loyalty_ledger', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `shipment_events_no_replace` BEFORE INSERT ON `shipment_events`
WHEN EXISTS (SELECT 1 FROM shipment_events WHERE id = NEW.id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('shipment_events', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `repair_events_no_replace` BEFORE INSERT ON `repair_events`
WHEN EXISTS (SELECT 1 FROM repair_events WHERE id = NEW.id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('repair_events', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `trade_in_events_no_replace` BEFORE INSERT ON `trade_in_events`
WHEN EXISTS (SELECT 1 FROM trade_in_events WHERE id = NEW.id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('trade_in_events', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `journal_entries_no_replace` BEFORE INSERT ON `journal_entries`
WHEN EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM journal_entries WHERE idempotency_key = NEW.idempotency_key)
  OR EXISTS (SELECT 1 FROM journal_entries WHERE reverses_id = NEW.reverses_id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('journal_entries', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `journal_lines_no_replace` BEFORE INSERT ON `journal_lines`
WHEN EXISTS (SELECT 1 FROM journal_lines WHERE id = NEW.id)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('journal_lines', NULL);
END;
--> statement-breakpoint
CREATE TRIGGER `cash_movements_no_replace` BEFORE INSERT ON `cash_movements`
WHEN EXISTS (SELECT 1 FROM cash_movements WHERE id = NEW.id)
  OR EXISTS (SELECT 1 FROM cash_movements WHERE idempotency_key = NEW.idempotency_key)
BEGIN
	INSERT OR IGNORE INTO _replace_guard (tbl, probe) VALUES ('cash_movements', NULL);
END;
