-- TamTam Games — business invariants enforced by the database (docs/ARCHITECTURE.md §7).
--
-- Hand-written. Statements are separated by drizzle's statement-breakpoint marker line
-- (never write that marker inside a comment: migration runners split on it blindly).
-- Every rule aborts with a message of the form  TT:<CODE>:<detail>  which
-- mapDbError() in app/server/db/tx.server.ts turns into { code, detail }.
--
-- Conventions used below
--   * Validation triggers on INSERT are AFTER triggers, so "INSERT ... ON CONFLICT DO NOTHING /
--     DO UPDATE" behaves as written: they only fire for a row that was really inserted.
--   * A trigger is dropped together with its table. A later migration that rebuilds one of these
--     tables (drizzle-kit does that for most column changes) MUST re-create the triggers of that
--     table; tests/db-invariants.test.ts fails when one goes missing.
--   * SQLite does not fire DELETE triggers for rows removed by REPLACE conflict resolution
--     (recursive_triggers is off in D1). Never use INSERT OR REPLACE on an append-only table.
--
-- Contents
--   1. _tx_guard            batch guard used by expectChanged() / expectThat()
--   2. append-only tables   TT:IMMUTABLE:<table>
--   3. stock                TT:INSUFFICIENT_STOCK:<variant_id>
--   4. serials, used units  TT:SERIAL_NOT_AVAILABLE:<serial_id>, TT:USED_UNIT_NOT_AVAILABLE:<id>, TT:USED_UNIT_NOT_LISTABLE:<id>
--   5. wallet, loyalty      TT:WALLET_OVERDRAFT:<customer_id>, TT:LOYALTY_OVERDRAFT:<customer_id>
--   6. payments, refunds    TT:PAYMENT_NOT_VERIFIED:<payment_id>, TT:REFUND_PAYMENT_MISMATCH:<refund_id>,
--                           TT:REFUND_EXCEEDS_PAYMENT:<payment_id>, TT:REFUND_ITEM_MISMATCH:<order_item_id>,
--                           TT:REFUND_QTY_EXCEEDS:<order_item_id>, TT:ORDER_REFUND_EXCEEDS_PAID:<order_id>
--   7. trade-in             TT:TRADE_IN_OFFER_NOT_ALLOWED:<trade_in_id>
--   8. journal              TT:JOURNAL_SEALED:<entry_id>, TT:PERIOD_CLOSED:<period>, TT:JOURNAL_UNBALANCED:<entry_id>

-- ───────────────────────────────────────────────────────────── 1. batch guard
-- expectChanged(db, min, failure) runs
--   INSERT INTO _tx_guard (ok, code, detail) SELECT changes() >= :min, :code, :detail
-- directly after the statement it protects. The trigger aborts the whole batch when ok is not 1,
-- and otherwise skips the insert (RAISE(IGNORE)), so the table always stays empty.
CREATE TABLE `_tx_guard` (
	`ok` integer NOT NULL,
	`code` text,
	`detail` text
);
--> statement-breakpoint
CREATE TRIGGER `_tx_guard_check` BEFORE INSERT ON `_tx_guard`
BEGIN
	SELECT RAISE(ABORT, 'TT:' || coalesce(NEW.code, 'NO_ROWS_CHANGED') || ':' || coalesce(NEW.detail, ''))
	WHERE NEW.ok IS NOT 1;
	SELECT RAISE(IGNORE);
END;
--> statement-breakpoint

-- ───────────────────────────────────────────────────────────── 2. append-only tables [A]
-- History is corrected with new rows (reversals), never by editing or deleting.
CREATE TRIGGER `audit_events_no_update` BEFORE UPDATE ON `audit_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:audit_events');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_events_no_delete` BEFORE DELETE ON `audit_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:audit_events');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_seals_no_update` BEFORE UPDATE ON `audit_seals`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:audit_seals');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_seals_no_delete` BEFORE DELETE ON `audit_seals`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:audit_seals');
END;
--> statement-breakpoint
CREATE TRIGGER `product_versions_no_update` BEFORE UPDATE ON `product_versions`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:product_versions');
END;
--> statement-breakpoint
CREATE TRIGGER `product_versions_no_delete` BEFORE DELETE ON `product_versions`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:product_versions');
END;
--> statement-breakpoint
CREATE TRIGGER `price_changes_no_update` BEFORE UPDATE ON `price_changes`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:price_changes');
END;
--> statement-breakpoint
CREATE TRIGGER `price_changes_no_delete` BEFORE DELETE ON `price_changes`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:price_changes');
END;
--> statement-breakpoint
CREATE TRIGGER `stock_movements_no_update` BEFORE UPDATE ON `stock_movements`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:stock_movements');
END;
--> statement-breakpoint
CREATE TRIGGER `stock_movements_no_delete` BEFORE DELETE ON `stock_movements`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:stock_movements');
END;
--> statement-breakpoint
CREATE TRIGGER `consents_no_update` BEFORE UPDATE ON `consents`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:consents');
END;
--> statement-breakpoint
CREATE TRIGGER `consents_no_delete` BEFORE DELETE ON `consents`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:consents');
END;
--> statement-breakpoint
CREATE TRIGGER `order_events_no_update` BEFORE UPDATE ON `order_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:order_events');
END;
--> statement-breakpoint
CREATE TRIGGER `order_events_no_delete` BEFORE DELETE ON `order_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:order_events');
END;
--> statement-breakpoint
CREATE TRIGGER `wallet_ledger_no_update` BEFORE UPDATE ON `wallet_ledger`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:wallet_ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `wallet_ledger_no_delete` BEFORE DELETE ON `wallet_ledger`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:wallet_ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_ledger_no_update` BEFORE UPDATE ON `loyalty_ledger`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:loyalty_ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_ledger_no_delete` BEFORE DELETE ON `loyalty_ledger`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:loyalty_ledger');
END;
--> statement-breakpoint
CREATE TRIGGER `shipment_events_no_update` BEFORE UPDATE ON `shipment_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:shipment_events');
END;
--> statement-breakpoint
CREATE TRIGGER `shipment_events_no_delete` BEFORE DELETE ON `shipment_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:shipment_events');
END;
--> statement-breakpoint
CREATE TRIGGER `repair_events_no_update` BEFORE UPDATE ON `repair_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:repair_events');
END;
--> statement-breakpoint
CREATE TRIGGER `repair_events_no_delete` BEFORE DELETE ON `repair_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:repair_events');
END;
--> statement-breakpoint
CREATE TRIGGER `trade_in_events_no_update` BEFORE UPDATE ON `trade_in_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:trade_in_events');
END;
--> statement-breakpoint
CREATE TRIGGER `trade_in_events_no_delete` BEFORE DELETE ON `trade_in_events`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:trade_in_events');
END;
--> statement-breakpoint
CREATE TRIGGER `journal_entries_no_update` BEFORE UPDATE ON `journal_entries`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:journal_entries');
END;
--> statement-breakpoint
CREATE TRIGGER `journal_entries_no_delete` BEFORE DELETE ON `journal_entries`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:journal_entries');
END;
--> statement-breakpoint
CREATE TRIGGER `journal_lines_no_update` BEFORE UPDATE ON `journal_lines`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:journal_lines');
END;
--> statement-breakpoint
CREATE TRIGGER `journal_lines_no_delete` BEFORE DELETE ON `journal_lines`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:journal_lines');
END;
--> statement-breakpoint
CREATE TRIGGER `cash_movements_no_update` BEFORE UPDATE ON `cash_movements`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:cash_movements');
END;
--> statement-breakpoint
CREATE TRIGGER `cash_movements_no_delete` BEFORE DELETE ON `cash_movements`
BEGIN
	SELECT RAISE(ABORT, 'TT:IMMUTABLE:cash_movements');
END;
--> statement-breakpoint

-- ───────────────────────────────────────────────────────────── 3. stock never goes negative (§7.1)
-- available = on_hand - reserved may only drop below zero where allow_oversell = 1
-- (which needs the inventory.oversell.authorize permission and an audit reason).
CREATE TRIGGER `stock_levels_available_insert` AFTER INSERT ON `stock_levels`
WHEN NEW.allow_oversell = 0 AND NEW.on_hand - NEW.reserved < 0
BEGIN
	SELECT RAISE(ABORT, 'TT:INSUFFICIENT_STOCK:' || NEW.variant_id);
END;
--> statement-breakpoint
CREATE TRIGGER `stock_levels_available_update` AFTER UPDATE OF `on_hand`, `reserved`, `allow_oversell` ON `stock_levels`
WHEN NEW.allow_oversell = 0 AND NEW.on_hand - NEW.reserved < 0
BEGIN
	SELECT RAISE(ABORT, 'TT:INSUFFICIENT_STOCK:' || NEW.variant_id);
END;
--> statement-breakpoint

-- ───────────────────────────────────────────────────────────── 4. unique units are sold once (§7.2, §7.11)
-- A serial becomes 'sold' only from 'in_stock' or 'reserved', and 'reserved' only from 'in_stock'.
-- (Attaching it to two order items at once is prevented by the UNIQUE index on order_item_serials.)
-- Only put `status` in an UPDATE when you mean to change it: sold -> sold is refused as a second sale.
CREATE TRIGGER `serials_status_guard` BEFORE UPDATE OF `status` ON `serials`
WHEN (NEW.status = 'sold' AND OLD.status NOT IN ('in_stock', 'reserved'))
  OR (NEW.status = 'reserved' AND OLD.status <> 'in_stock')
BEGIN
	SELECT RAISE(ABORT, 'TT:SERIAL_NOT_AVAILABLE:' || OLD.id);
END;
--> statement-breakpoint
-- The same rule for used units, which are one-of-a-kind.
CREATE TRIGGER `used_units_status_guard` BEFORE UPDATE OF `status` ON `used_units`
WHEN (NEW.status = 'sold' AND OLD.status NOT IN ('ready', 'listed', 'reserved'))
  OR (NEW.status = 'reserved' AND OLD.status NOT IN ('ready', 'listed'))
BEGIN
	SELECT RAISE(ABORT, 'TT:USED_UNIT_NOT_AVAILABLE:' || OLD.id);
END;
--> statement-breakpoint
-- A real (is_demo = 0) used unit can only be listed with evidence: ownership check, data wipe,
-- a completed checklist and at least one actual photo of the unit.
CREATE TRIGGER `used_units_listable_insert` AFTER INSERT ON `used_units`
WHEN NEW.status = 'listed' AND NEW.is_demo = 0
BEGIN
	SELECT RAISE(ABORT, 'TT:USED_UNIT_NOT_LISTABLE:' || NEW.id)
	WHERE NEW.ownership_checked_at IS NULL
	   OR NEW.data_wiped_at IS NULL
	   OR NEW.checklist IS NULL
	   OR json_extract(NEW.checklist, '$.completedAt') IS NULL
	   OR coalesce(json_array_length(NEW.checklist, '$.items'), 0) = 0
	   OR NOT EXISTS (
			SELECT 1 FROM media m
			WHERE m.owner_type = 'used_unit' AND m.owner_id = NEW.id
			  AND m.kind = 'image' AND m.is_illustration = 0 AND m.file_id IS NOT NULL
	   );
END;
--> statement-breakpoint
CREATE TRIGGER `used_units_listable_update` AFTER UPDATE ON `used_units`
WHEN NEW.status = 'listed' AND NEW.is_demo = 0
BEGIN
	SELECT RAISE(ABORT, 'TT:USED_UNIT_NOT_LISTABLE:' || NEW.id)
	WHERE NEW.ownership_checked_at IS NULL
	   OR NEW.data_wiped_at IS NULL
	   OR NEW.checklist IS NULL
	   OR json_extract(NEW.checklist, '$.completedAt') IS NULL
	   OR coalesce(json_array_length(NEW.checklist, '$.items'), 0) = 0
	   OR NOT EXISTS (
			SELECT 1 FROM media m
			WHERE m.owner_type = 'used_unit' AND m.owner_id = NEW.id
			  AND m.kind = 'image' AND m.is_illustration = 0 AND m.file_id IS NOT NULL
	   );
END;
--> statement-breakpoint
-- ...and a listed unit cannot lose its last real photo.
CREATE TRIGGER `media_used_unit_evidence_delete` AFTER DELETE ON `media`
WHEN OLD.owner_type = 'used_unit'
BEGIN
	SELECT RAISE(ABORT, 'TT:USED_UNIT_NOT_LISTABLE:' || OLD.owner_id)
	WHERE EXISTS (SELECT 1 FROM used_units u WHERE u.id = OLD.owner_id AND u.status = 'listed' AND u.is_demo = 0)
	  AND NOT EXISTS (
			SELECT 1 FROM media m
			WHERE m.owner_type = 'used_unit' AND m.owner_id = OLD.owner_id
			  AND m.kind = 'image' AND m.is_illustration = 0 AND m.file_id IS NOT NULL
	  );
END;
--> statement-breakpoint
CREATE TRIGGER `media_used_unit_evidence_update` AFTER UPDATE ON `media`
WHEN OLD.owner_type = 'used_unit'
BEGIN
	SELECT RAISE(ABORT, 'TT:USED_UNIT_NOT_LISTABLE:' || OLD.owner_id)
	WHERE EXISTS (SELECT 1 FROM used_units u WHERE u.id = OLD.owner_id AND u.status = 'listed' AND u.is_demo = 0)
	  AND NOT EXISTS (
			SELECT 1 FROM media m
			WHERE m.owner_type = 'used_unit' AND m.owner_id = OLD.owner_id
			  AND m.kind = 'image' AND m.is_illustration = 0 AND m.file_id IS NOT NULL
	  );
END;
--> statement-breakpoint

-- ───────────────────────────────────────────────────────────── 5. ledgers cannot be overdrawn (§7.5)
-- The wallet balance is SUM(amount_iqd); there is no balance column to edit.
CREATE TRIGGER `wallet_ledger_no_overdraft` AFTER INSERT ON `wallet_ledger`
WHEN NEW.amount_iqd < 0
BEGIN
	SELECT RAISE(ABORT, 'TT:WALLET_OVERDRAFT:' || NEW.customer_id)
	WHERE (SELECT coalesce(sum(amount_iqd), 0) FROM wallet_ledger WHERE customer_id = NEW.customer_id) < 0;
END;
--> statement-breakpoint
CREATE TRIGGER `loyalty_ledger_no_overdraft` AFTER INSERT ON `loyalty_ledger`
WHEN NEW.points < 0
BEGIN
	SELECT RAISE(ABORT, 'TT:LOYALTY_OVERDRAFT:' || NEW.customer_id)
	WHERE (SELECT coalesce(sum(points), 0) FROM loyalty_ledger WHERE customer_id = NEW.customer_id) < 0;
END;
--> statement-breakpoint

-- ───────────────────────────────────────────────────────────── 6. payments and refunds (§7.4, §7.6)
-- A manual transfer is never paid without a named verifier.
CREATE TRIGGER `payments_transfer_verified_insert` AFTER INSERT ON `payments`
WHEN NEW.status = 'paid' AND NEW.method IN ('bank_transfer', 'zaincash')
 AND (NEW.verified_by IS NULL OR NEW.verified_at IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'TT:PAYMENT_NOT_VERIFIED:' || NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER `payments_transfer_verified_update` AFTER UPDATE OF `status`, `method`, `verified_by`, `verified_at` ON `payments`
WHEN NEW.status = 'paid' AND NEW.method IN ('bank_transfer', 'zaincash')
 AND (NEW.verified_by IS NULL OR NEW.verified_at IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'TT:PAYMENT_NOT_VERIFIED:' || NEW.id);
END;
--> statement-breakpoint
-- A payment cannot be reduced or un-paid below what was already refunded from it.
CREATE TRIGGER `payments_refund_floor` AFTER UPDATE OF `amount_iqd`, `status` ON `payments`
BEGIN
	SELECT RAISE(ABORT, 'TT:REFUND_EXCEEDS_PAYMENT:' || NEW.id)
	WHERE (SELECT coalesce(sum(amount_iqd), 0) FROM refunds WHERE payment_id = NEW.id AND status NOT IN ('rejected', 'cancelled'))
	    > iif(NEW.status = 'paid', NEW.amount_iqd, 0);
END;
--> statement-breakpoint
-- A refund points at a payment of the same order, and all refunds of a payment that are not
-- rejected or cancelled never add up to more than was paid (an unpaid payment has paid 0).
CREATE TRIGGER `refunds_bound_insert` AFTER INSERT ON `refunds`
BEGIN
	SELECT RAISE(ABORT, 'TT:REFUND_PAYMENT_MISMATCH:' || NEW.id)
	WHERE (SELECT order_id FROM payments WHERE id = NEW.payment_id) IS NOT NEW.order_id;
	SELECT RAISE(ABORT, 'TT:REFUND_EXCEEDS_PAYMENT:' || NEW.payment_id)
	WHERE NEW.status NOT IN ('rejected', 'cancelled')
	  AND (SELECT coalesce(sum(amount_iqd), 0) FROM refunds WHERE payment_id = NEW.payment_id AND status NOT IN ('rejected', 'cancelled'))
	    > coalesce((SELECT amount_iqd FROM payments WHERE id = NEW.payment_id AND status = 'paid'), 0);
END;
--> statement-breakpoint
CREATE TRIGGER `refunds_bound_update` AFTER UPDATE OF `amount_iqd`, `status`, `payment_id`, `order_id` ON `refunds`
BEGIN
	SELECT RAISE(ABORT, 'TT:REFUND_PAYMENT_MISMATCH:' || NEW.id)
	WHERE (SELECT order_id FROM payments WHERE id = NEW.payment_id) IS NOT NEW.order_id;
	SELECT RAISE(ABORT, 'TT:REFUND_EXCEEDS_PAYMENT:' || NEW.payment_id)
	WHERE NEW.status NOT IN ('rejected', 'cancelled')
	  AND (SELECT coalesce(sum(amount_iqd), 0) FROM refunds WHERE payment_id = NEW.payment_id AND status NOT IN ('rejected', 'cancelled'))
	    > coalesce((SELECT amount_iqd FROM payments WHERE id = NEW.payment_id AND status = 'paid'), 0);
	SELECT RAISE(ABORT, 'TT:REFUND_QTY_EXCEEDS:' || ri.order_item_id)
	FROM refund_items ri
	JOIN order_items oi ON oi.id = ri.order_item_id
	WHERE ri.refund_id = NEW.id
	  AND NEW.status NOT IN ('rejected', 'cancelled')
	  AND (SELECT coalesce(sum(ri2.qty), 0) FROM refund_items ri2 JOIN refunds r2 ON r2.id = ri2.refund_id
	       WHERE ri2.order_item_id = ri.order_item_id AND r2.status NOT IN ('rejected', 'cancelled')) > oi.qty;
END;
--> statement-breakpoint
-- Refunded quantity per order line never exceeds the quantity bought.
CREATE TRIGGER `refund_items_bound_insert` AFTER INSERT ON `refund_items`
BEGIN
	SELECT RAISE(ABORT, 'TT:REFUND_ITEM_MISMATCH:' || NEW.order_item_id)
	WHERE (SELECT order_id FROM order_items WHERE id = NEW.order_item_id) IS NOT (SELECT order_id FROM refunds WHERE id = NEW.refund_id);
	SELECT RAISE(ABORT, 'TT:REFUND_QTY_EXCEEDS:' || NEW.order_item_id)
	WHERE (SELECT status FROM refunds WHERE id = NEW.refund_id) NOT IN ('rejected', 'cancelled')
	  AND (SELECT coalesce(sum(ri.qty), 0) FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
	       WHERE ri.order_item_id = NEW.order_item_id AND r.status NOT IN ('rejected', 'cancelled'))
	    > (SELECT qty FROM order_items WHERE id = NEW.order_item_id);
END;
--> statement-breakpoint
CREATE TRIGGER `refund_items_bound_update` AFTER UPDATE ON `refund_items`
BEGIN
	SELECT RAISE(ABORT, 'TT:REFUND_ITEM_MISMATCH:' || NEW.order_item_id)
	WHERE (SELECT order_id FROM order_items WHERE id = NEW.order_item_id) IS NOT (SELECT order_id FROM refunds WHERE id = NEW.refund_id);
	SELECT RAISE(ABORT, 'TT:REFUND_QTY_EXCEEDS:' || NEW.order_item_id)
	WHERE (SELECT status FROM refunds WHERE id = NEW.refund_id) NOT IN ('rejected', 'cancelled')
	  AND (SELECT coalesce(sum(ri.qty), 0) FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
	       WHERE ri.order_item_id = NEW.order_item_id AND r.status NOT IN ('rejected', 'cancelled'))
	    > (SELECT qty FROM order_items WHERE id = NEW.order_item_id);
END;
--> statement-breakpoint
-- The denormalized mirrors obey the same bounds.
CREATE TRIGGER `order_items_refunded_qty_insert` AFTER INSERT ON `order_items`
WHEN NEW.refunded_qty > NEW.qty
BEGIN
	SELECT RAISE(ABORT, 'TT:REFUND_QTY_EXCEEDS:' || NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER `order_items_refunded_qty_update` BEFORE UPDATE OF `refunded_qty`, `qty` ON `order_items`
WHEN NEW.refunded_qty > NEW.qty
BEGIN
	SELECT RAISE(ABORT, 'TT:REFUND_QTY_EXCEEDS:' || NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER `orders_refund_bound_insert` AFTER INSERT ON `orders`
WHEN NEW.refunded_iqd > NEW.paid_iqd
BEGIN
	SELECT RAISE(ABORT, 'TT:ORDER_REFUND_EXCEEDS_PAID:' || NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER `orders_refund_bound_update` BEFORE UPDATE OF `refunded_iqd`, `paid_iqd` ON `orders`
WHEN NEW.refunded_iqd > NEW.paid_iqd
BEGIN
	SELECT RAISE(ABORT, 'TT:ORDER_REFUND_EXCEEDS_PAID:' || NEW.id);
END;
--> statement-breakpoint

-- ───────────────────────────────────────────────────────────── 7. trade-in estimates are not offers (§7.12)
-- A final offer exists only with the employee who made it, the time, and a recorded inspection;
-- the statuses that presuppose an offer cannot be reached without one.
CREATE TRIGGER `trade_ins_offer_guard_insert` AFTER INSERT ON `trade_ins`
WHEN (NEW.final_offer_iqd IS NOT NULL AND (NEW.offered_by IS NULL OR NEW.offered_at IS NULL OR NEW.inspection IS NULL))
  OR (NEW.status IN ('offered', 'accepted', 'paid') AND NEW.final_offer_iqd IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'TT:TRADE_IN_OFFER_NOT_ALLOWED:' || NEW.id);
END;
--> statement-breakpoint
CREATE TRIGGER `trade_ins_offer_guard_update` AFTER UPDATE OF `final_offer_iqd`, `offered_by`, `offered_at`, `inspection`, `status` ON `trade_ins`
WHEN (NEW.final_offer_iqd IS NOT NULL AND (NEW.offered_by IS NULL OR NEW.offered_at IS NULL OR NEW.inspection IS NULL))
  OR (NEW.status IN ('offered', 'accepted', 'paid') AND NEW.final_offer_iqd IS NULL)
BEGIN
	SELECT RAISE(ABORT, 'TT:TRADE_IN_OFFER_NOT_ALLOWED:' || NEW.id);
END;
--> statement-breakpoint

-- ───────────────────────────────────────────────────────────── 8. double-entry journal
-- Lines are inserted first and the header last, in one batch (journalEntryStatements() in
-- app/server/db/journal.server.ts). Inserting the header checks the period and the balance and seals the
-- entry: afterwards no line can be added, and both tables are append-only (section 2).
CREATE TRIGGER `journal_lines_sealed` AFTER INSERT ON `journal_lines`
BEGIN
	SELECT RAISE(ABORT, 'TT:JOURNAL_SEALED:' || NEW.entry_id)
	WHERE EXISTS (SELECT 1 FROM journal_entries WHERE id = NEW.entry_id);
END;
--> statement-breakpoint
CREATE TRIGGER `journal_entries_post` AFTER INSERT ON `journal_entries`
BEGIN
	SELECT RAISE(ABORT, 'TT:PERIOD_CLOSED:' || NEW.period)
	WHERE EXISTS (SELECT 1 FROM fiscal_periods WHERE period = NEW.period AND status = 'closed');
	SELECT RAISE(ABORT, 'TT:JOURNAL_UNBALANCED:' || NEW.id)
	WHERE (SELECT count(*) FROM journal_lines WHERE entry_id = NEW.id) < 2
	   OR (SELECT coalesce(sum(debit_iqd), 0) - coalesce(sum(credit_iqd), 0) FROM journal_lines WHERE entry_id = NEW.id) <> 0;
END;
