CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`system_key` text,
	`is_contra` integer DEFAULT false NOT NULL,
	`parent_id` text,
	`description` text,
	`is_system` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_code_uq` ON `accounts` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_system_key_uq` ON `accounts` (`system_key`);--> statement-breakpoint
CREATE INDEX `accounts_parent_idx` ON `accounts` (`parent_id`);--> statement-breakpoint
CREATE INDEX `accounts_type_idx` ON `accounts` (`type`);--> statement-breakpoint
CREATE TABLE `cost_centers` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cost_centers_code_uq` ON `cost_centers` (`code`);--> statement-breakpoint
CREATE TABLE `expenses` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`paid_from_account_id` text,
	`cost_center` text,
	`amount_iqd` integer NOT NULL,
	`vendor` text,
	`description` text NOT NULL,
	`incurred_on` text NOT NULL,
	`period` text NOT NULL,
	`receipt_file_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`journal_entry_id` text,
	`ref_type` text,
	`ref_id` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`paid_from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "expenses_amount_check" CHECK("expenses"."amount_iqd" > 0)
);
--> statement-breakpoint
CREATE INDEX `expenses_account_idx` ON `expenses` (`account_id`);--> statement-breakpoint
CREATE INDEX `expenses_paid_from_idx` ON `expenses` (`paid_from_account_id`);--> statement-breakpoint
CREATE INDEX `expenses_period_idx` ON `expenses` (`period`,`status`);--> statement-breakpoint
CREATE INDEX `expenses_cost_center_idx` ON `expenses` (`cost_center`);--> statement-breakpoint
CREATE INDEX `expenses_ref_idx` ON `expenses` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `expenses_receipt_file_idx` ON `expenses` (`receipt_file_id`);--> statement-breakpoint
CREATE INDEX `expenses_created_at_idx` ON `expenses` (`created_at`);--> statement-breakpoint
CREATE TABLE `fiscal_periods` (
	`period` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`closed_by` text,
	`closed_at` integer,
	`note` text
);
--> statement-breakpoint
CREATE TABLE `fx_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`quote` text NOT NULL,
	`iqd_per_unit` integer NOT NULL,
	`source` text NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`effective_at` integer NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "fx_rates_rate_check" CHECK("fx_rates"."iqd_per_unit" > 0)
);
--> statement-breakpoint
CREATE INDEX `fx_rates_quote_idx` ON `fx_rates` (`quote`,`effective_at`);--> statement-breakpoint
CREATE TABLE `journal_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`period` text NOT NULL,
	`memo` text,
	`ref_type` text,
	`ref_id` text,
	`created_by` text,
	`reverses_id` text,
	`idempotency_key` text,
	`is_demo` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`reverses_id`) REFERENCES `journal_entries`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "journal_entries_period_check" CHECK("journal_entries"."period" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `journal_entries_idempotency_key_uq` ON `journal_entries` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `journal_entries_reverses_uq` ON `journal_entries` (`reverses_id`);--> statement-breakpoint
CREATE INDEX `journal_entries_period_idx` ON `journal_entries` (`period`,`at`);--> statement-breakpoint
CREATE INDEX `journal_entries_ref_idx` ON `journal_entries` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `journal_entries_at_idx` ON `journal_entries` (`at`);--> statement-breakpoint
CREATE TABLE `journal_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`account_id` text NOT NULL,
	`debit_iqd` integer DEFAULT 0 NOT NULL,
	`credit_iqd` integer DEFAULT 0 NOT NULL,
	`cost_center` text,
	`memo` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "journal_lines_side_check" CHECK(("journal_lines"."debit_iqd" > 0 AND "journal_lines"."credit_iqd" = 0) OR ("journal_lines"."debit_iqd" = 0 AND "journal_lines"."credit_iqd" > 0))
);
--> statement-breakpoint
CREATE INDEX `journal_lines_entry_idx` ON `journal_lines` (`entry_id`);--> statement-breakpoint
CREATE INDEX `journal_lines_account_idx` ON `journal_lines` (`account_id`);--> statement-breakpoint
CREATE INDEX `journal_lines_cost_center_idx` ON `journal_lines` (`cost_center`);--> statement-breakpoint
CREATE TABLE `statement_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`amount_iqd` integer NOT NULL,
	`reference` text,
	`counterparty` text,
	`description` text,
	`raw` text,
	`dedupe_hash` text NOT NULL,
	`status` text DEFAULT 'unmatched' NOT NULL,
	`matched_payment_id` text,
	`matched_by` text,
	`matched_at` integer,
	`import_job_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`matched_payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `statement_lines_dedupe_uq` ON `statement_lines` (`dedupe_hash`);--> statement-breakpoint
CREATE INDEX `statement_lines_status_idx` ON `statement_lines` (`status`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `statement_lines_reference_idx` ON `statement_lines` (`reference`);--> statement-breakpoint
CREATE INDEX `statement_lines_payment_idx` ON `statement_lines` (`matched_payment_id`);--> statement-breakpoint
CREATE TABLE `tax_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`rate_bps` integer NOT NULL,
	`is_inclusive` integer DEFAULT true NOT NULL,
	`applies_to` text,
	`is_active` integer DEFAULT false NOT NULL,
	`effective_at` integer,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "tax_rates_rate_check" CHECK("tax_rates"."rate_bps" >= 0 AND "tax_rates"."rate_bps" <= 10000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tax_rates_code_uq` ON `tax_rates` (`code`);--> statement-breakpoint
CREATE TABLE `repair_events` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`data` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `repair_tickets`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `repair_events_ticket_idx` ON `repair_events` (`ticket_id`,`at`);--> statement-breakpoint
CREATE TABLE `repair_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`customer_id` text,
	`phone_e164` text NOT NULL,
	`device_model_id` text,
	`serial_id` text,
	`warranty_id` text,
	`issue` text NOT NULL,
	`status` text DEFAULT 'submitted' NOT NULL,
	`sla_due_at` integer,
	`assigned_to` text,
	`parts` text,
	`cost_iqd` integer,
	`created_at` integer NOT NULL,
	`contact_name` text,
	`serial_text` text,
	`device_text` text,
	`source` text DEFAULT 'storefront' NOT NULL,
	`assistant_session_id` text,
	`return_id` text,
	`is_warranty` integer DEFAULT false NOT NULL,
	`diagnosis` text,
	`resolution` text,
	`quote_iqd` integer,
	`quote_approved_at` integer,
	`received_at` integer,
	`completed_at` integer,
	`delivered_at` integer,
	`access_token_hash` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_model_id`) REFERENCES `device_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`serial_id`) REFERENCES `serials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warranty_id`) REFERENCES `warranties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_id`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repair_tickets_ref_uq` ON `repair_tickets` (`ref`);--> statement-breakpoint
CREATE INDEX `repair_tickets_customer_idx` ON `repair_tickets` (`customer_id`);--> statement-breakpoint
CREATE INDEX `repair_tickets_phone_idx` ON `repair_tickets` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `repair_tickets_device_model_idx` ON `repair_tickets` (`device_model_id`);--> statement-breakpoint
CREATE INDEX `repair_tickets_serial_idx` ON `repair_tickets` (`serial_id`);--> statement-breakpoint
CREATE INDEX `repair_tickets_warranty_idx` ON `repair_tickets` (`warranty_id`);--> statement-breakpoint
CREATE INDEX `repair_tickets_return_idx` ON `repair_tickets` (`return_id`);--> statement-breakpoint
CREATE INDEX `repair_tickets_status_idx` ON `repair_tickets` (`status`,`sla_due_at`);--> statement-breakpoint
CREATE INDEX `repair_tickets_assigned_idx` ON `repair_tickets` (`assigned_to`,`status`);--> statement-breakpoint
CREATE INDEX `repair_tickets_created_at_idx` ON `repair_tickets` (`created_at`);--> statement-breakpoint
CREATE TABLE `return_items` (
	`id` text PRIMARY KEY NOT NULL,
	`return_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`qty` integer DEFAULT 1 NOT NULL,
	`serial_id` text,
	`condition` text,
	`inspected_by` text,
	`notes` text,
	`restock_action` text,
	`restocked_at` integer,
	FOREIGN KEY (`return_id`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`serial_id`) REFERENCES `serials`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "return_items_qty_check" CHECK("return_items"."qty" > 0)
);
--> statement-breakpoint
CREATE INDEX `return_items_return_idx` ON `return_items` (`return_id`);--> statement-breakpoint
CREATE INDEX `return_items_order_item_idx` ON `return_items` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `return_items_serial_idx` ON `return_items` (`serial_id`);--> statement-breakpoint
CREATE TABLE `return_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`product_kind` text DEFAULT '*' NOT NULL,
	`category_id` text,
	`item_condition` text DEFAULT '*' NOT NULL,
	`is_returnable` integer DEFAULT true NOT NULL,
	`window_days` integer,
	`requires_sealed` integer DEFAULT false NOT NULL,
	`restocking_fee_bps` integer DEFAULT 0 NOT NULL,
	`note` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `return_policies_kind_idx` ON `return_policies` (`product_kind`,`is_active`);--> statement-breakpoint
CREATE INDEX `return_policies_category_idx` ON `return_policies` (`category_id`);--> statement-breakpoint
CREATE TABLE `returns` (
	`id` text PRIMARY KEY NOT NULL,
	`rma` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text,
	`status` text DEFAULT 'requested' NOT NULL,
	`reason` text,
	`resolution` text,
	`created_at` integer NOT NULL,
	`reason_code` text,
	`phone_e164` text,
	`requested_resolution` text,
	`staff_note` text,
	`reject_reason` text,
	`approved_by` text,
	`approved_at` integer,
	`received_at` integer,
	`inspected_at` integer,
	`closed_at` integer,
	`access_token_hash` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `returns_rma_uq` ON `returns` (`rma`);--> statement-breakpoint
CREATE INDEX `returns_order_idx` ON `returns` (`order_id`);--> statement-breakpoint
CREATE INDEX `returns_customer_idx` ON `returns` (`customer_id`);--> statement-breakpoint
CREATE INDEX `returns_phone_idx` ON `returns` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `returns_status_idx` ON `returns` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `warranties` (
	`id` text PRIMARY KEY NOT NULL,
	`order_item_id` text NOT NULL,
	`serial_id` text,
	`customer_id` text,
	`phone_e164` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`terms` text,
	`status` text DEFAULT 'active' NOT NULL,
	`used_unit_id` text,
	`void_reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`serial_id`) REFERENCES `serials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`used_unit_id`) REFERENCES `used_units`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "warranties_dates_check" CHECK("warranties"."ends_at" >= "warranties"."starts_at")
);
--> statement-breakpoint
CREATE INDEX `warranties_order_item_idx` ON `warranties` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `warranties_serial_idx` ON `warranties` (`serial_id`);--> statement-breakpoint
CREATE INDEX `warranties_customer_idx` ON `warranties` (`customer_id`);--> statement-breakpoint
CREATE INDEX `warranties_phone_idx` ON `warranties` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `warranties_used_unit_idx` ON `warranties` (`used_unit_id`);--> statement-breakpoint
CREATE INDEX `warranties_status_idx` ON `warranties` (`status`,`ends_at`);--> statement-breakpoint
CREATE TABLE `bundle_items` (
	`bundle_variant_id` text NOT NULL,
	`component_variant_id` text NOT NULL,
	`qty` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`bundle_variant_id`, `component_variant_id`),
	FOREIGN KEY (`bundle_variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`component_variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "bundle_items_qty_check" CHECK("bundle_items"."qty" > 0 AND "bundle_items"."bundle_variant_id" <> "bundle_items"."component_variant_id")
);
--> statement-breakpoint
CREATE INDEX `bundle_items_component_idx` ON `bundle_items` (`component_variant_id`);--> statement-breakpoint
CREATE TABLE `categories` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'standard' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`description` text,
	`art_key` text,
	`seo` text,
	FOREIGN KEY (`parent_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `categories_slug_uq` ON `categories` (`slug`);--> statement-breakpoint
CREATE INDEX `categories_parent_idx` ON `categories` (`parent_id`,`sort`);--> statement-breakpoint
CREATE TABLE `compatibility_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text DEFAULT 'unverified' NOT NULL,
	`note` text,
	`source` text,
	`verified_by` text,
	`verified_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compatibility_rules_edge_uq` ON `compatibility_rules` (`subject_type`,`subject_id`,`target_type`,`target_id`);--> statement-breakpoint
CREATE INDEX `compatibility_rules_target_idx` ON `compatibility_rules` (`target_type`,`target_id`,`status`);--> statement-breakpoint
CREATE TABLE `custom_fields` (
	`id` text PRIMARY KEY NOT NULL,
	`entity` text DEFAULT 'product' NOT NULL,
	`product_kind` text DEFAULT '*' NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`type` text DEFAULT 'text' NOT NULL,
	`options` text,
	`required` integer DEFAULT false NOT NULL,
	`validation` text,
	`filterable` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `custom_fields_key_uq` ON `custom_fields` (`entity`,`product_kind`,`key`);--> statement-breakpoint
CREATE TABLE `device_generations` (
	`id` text PRIMARY KEY NOT NULL,
	`platform_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_generations_slug_uq` ON `device_generations` (`slug`);--> statement-breakpoint
CREATE INDEX `device_generations_platform_idx` ON `device_generations` (`platform_id`,`sort`);--> statement-breakpoint
CREATE TABLE `device_models` (
	`id` text PRIMARY KEY NOT NULL,
	`platform_id` text NOT NULL,
	`generation_id` text,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`summary` text,
	`specs` text,
	`released_on` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`device_kind` text DEFAULT 'console' NOT NULL,
	`art_key` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`generation_id`) REFERENCES `device_generations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `device_models_slug_uq` ON `device_models` (`slug`);--> statement-breakpoint
CREATE INDEX `device_models_platform_idx` ON `device_models` (`platform_id`,`sort`);--> statement-breakpoint
CREATE INDEX `device_models_generation_idx` ON `device_models` (`generation_id`);--> statement-breakpoint
CREATE INDEX `device_models_status_idx` ON `device_models` (`status`);--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_type` text NOT NULL,
	`owner_id` text NOT NULL,
	`file_id` text,
	`art_key` text,
	`kind` text DEFAULT 'image' NOT NULL,
	`alt` text,
	`is_illustration` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `media_owner_idx` ON `media` (`owner_type`,`owner_id`,`sort`);--> statement-breakpoint
CREATE INDEX `media_file_idx` ON `media` (`file_id`);--> statement-breakpoint
CREATE TABLE `platforms` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`accent` text DEFAULT 'brand' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`art_key` text,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `platforms_slug_uq` ON `platforms` (`slug`);--> statement-breakpoint
CREATE INDEX `platforms_sort_idx` ON `platforms` (`sort`);--> statement-breakpoint
CREATE TABLE `price_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`old_price_iqd` integer,
	`new_price_iqd` integer NOT NULL,
	`reason` text,
	`requested_by` text,
	`approved_by` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`old_compare_at_iqd` integer,
	`new_compare_at_iqd` integer,
	`source` text DEFAULT 'manual' NOT NULL,
	`request_id` text,
	`approval_id` text,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `price_changes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `price_changes_variant_idx` ON `price_changes` (`variant_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `price_changes_status_idx` ON `price_changes` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `price_changes_request_idx` ON `price_changes` (`request_id`);--> statement-breakpoint
CREATE TABLE `price_list_items` (
	`price_list_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`min_qty` integer DEFAULT 1 NOT NULL,
	`price_iqd` integer NOT NULL,
	`compare_at_iqd` integer,
	PRIMARY KEY(`price_list_id`, `variant_id`, `min_qty`),
	FOREIGN KEY (`price_list_id`) REFERENCES `price_lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "price_list_items_price_check" CHECK("price_list_items"."price_iqd" >= 0 AND "price_list_items"."min_qty" >= 1)
);
--> statement-breakpoint
CREATE INDEX `price_list_items_variant_idx` ON `price_list_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `price_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`channel` text,
	`branch_id` text,
	`segment_id` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `price_lists_code_uq` ON `price_lists` (`code`);--> statement-breakpoint
CREATE INDEX `price_lists_active_idx` ON `price_lists` (`is_active`,`priority`);--> statement-breakpoint
CREATE TABLE `product_relations` (
	`product_id` text NOT NULL,
	`related_product_id` text NOT NULL,
	`kind` text NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`product_id`, `related_product_id`, `kind`),
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "product_relations_self_check" CHECK("product_relations"."product_id" <> "product_relations"."related_product_id")
);
--> statement-breakpoint
CREATE INDEX `product_relations_related_idx` ON `product_relations` (`related_product_id`);--> statement-breakpoint
CREATE TABLE `product_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`changed_by` text,
	`reason` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `product_versions_product_version_uq` ON `product_versions` (`product_id`,`version`);--> statement-breakpoint
CREATE TABLE `products` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`short` text,
	`description` text,
	`brand` text,
	`platform_id` text,
	`device_model_id` text,
	`category_id` text,
	`specs` text,
	`attributes` text,
	`warranty_months` integer,
	`age_rating` text,
	`region` text,
	`license_type` text,
	`media_format` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`publish_at` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`seo` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`search_keywords` text,
	`preorder_release_at` integer,
	`preorder_deposit_iqd` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`published_at` integer,
	`created_by` text,
	`updated_by` text,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_model_id`) REFERENCES `device_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `products_slug_uq` ON `products` (`slug`);--> statement-breakpoint
CREATE INDEX `products_status_idx` ON `products` (`status`,`publish_at`);--> statement-breakpoint
CREATE INDEX `products_kind_idx` ON `products` (`kind`,`status`);--> statement-breakpoint
CREATE INDEX `products_platform_idx` ON `products` (`platform_id`,`status`);--> statement-breakpoint
CREATE INDEX `products_device_model_idx` ON `products` (`device_model_id`);--> statement-breakpoint
CREATE INDEX `products_category_idx` ON `products` (`category_id`,`status`);--> statement-breakpoint
CREATE INDEX `products_brand_idx` ON `products` (`brand`);--> statement-breakpoint
CREATE INDEX `products_created_at_idx` ON `products` (`created_at`);--> statement-breakpoint
CREATE TABLE `reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`order_item_id` text,
	`rating` integer NOT NULL,
	`title` text,
	`body` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`is_verified_purchase` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`locale` text,
	`moderated_by` text,
	`moderated_at` integer,
	`reject_reason` text,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reviews_rating_check" CHECK("reviews"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reviews_product_customer_uq` ON `reviews` (`product_id`,`customer_id`);--> statement-breakpoint
CREATE INDEX `reviews_product_idx` ON `reviews` (`product_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reviews_customer_idx` ON `reviews` (`customer_id`);--> statement-breakpoint
CREATE INDEX `reviews_order_item_idx` ON `reviews` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `reviews_status_idx` ON `reviews` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `search_query_stats` (
	`day` text NOT NULL,
	`locale` text NOT NULL,
	`query` text NOT NULL,
	`searches` integer DEFAULT 0 NOT NULL,
	`zero_results` integer DEFAULT 0 NOT NULL,
	`last_at` integer NOT NULL,
	PRIMARY KEY(`day`, `locale`, `query`)
);
--> statement-breakpoint
CREATE INDEX `search_query_stats_zero_idx` ON `search_query_stats` (`zero_results`,`day`);--> statement-breakpoint
CREATE TABLE `search_synonyms` (
	`id` text PRIMARY KEY NOT NULL,
	`locale` text NOT NULL,
	`term` text NOT NULL,
	`synonyms` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `search_synonyms_term_uq` ON `search_synonyms` (`locale`,`term`);--> statement-breakpoint
CREATE TABLE `variant_costs` (
	`variant_id` text PRIMARY KEY NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`unit_cost_minor` integer NOT NULL,
	`fx_rate_micros` integer,
	`fx_date` text,
	`landed_cost_iqd` integer NOT NULL,
	`avg_cost_iqd` integer,
	`min_margin_bps` integer,
	`target_margin_bps` integer,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `variants` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`sku` text NOT NULL,
	`barcode` text,
	`title` text,
	`options` text,
	`price_iqd` integer NOT NULL,
	`compare_at_iqd` integer,
	`is_default` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`track_serials` integer DEFAULT false NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`weight_grams` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "variants_price_check" CHECK("variants"."price_iqd" >= 0 AND ("variants"."compare_at_iqd" IS NULL OR "variants"."compare_at_iqd" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `variants_sku_uq` ON `variants` (`sku`);--> statement-breakpoint
CREATE INDEX `variants_product_idx` ON `variants` (`product_id`,`sort`);--> statement-breakpoint
CREATE INDEX `variants_barcode_idx` ON `variants` (`barcode`);--> statement-breakpoint
CREATE TABLE `banners` (
	`id` text PRIMARY KEY NOT NULL,
	`placement` text NOT NULL,
	`title` text NOT NULL,
	`subtitle` text,
	`cta_label` text,
	`link` text,
	`art_key` text,
	`file_id` text,
	`accent` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `banners_placement_idx` ON `banners` (`placement`,`status`,`sort`);--> statement-breakpoint
CREATE INDEX `banners_file_idx` ON `banners` (`file_id`);--> statement-breakpoint
CREATE TABLE `catalog_filters` (
	`id` text PRIMARY KEY NOT NULL,
	`category_id` text,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`source` text NOT NULL,
	`widget` text DEFAULT 'checkbox' NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `catalog_filters_category_idx` ON `catalog_filters` (`category_id`,`is_active`,`sort`);--> statement-breakpoint
CREATE TABLE `home_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`title` text,
	`config` text,
	`draft_config` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `home_sections_sort_idx` ON `home_sections` (`is_active`,`sort`);--> statement-breakpoint
CREATE TABLE `nav_menus` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`items` text NOT NULL,
	`draft_items` text,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `nav_menus_key_uq` ON `nav_menus` (`key`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`kind` text DEFAULT 'custom' NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`draft` text,
	`seo` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`published_at` integer,
	`starts_at` integer,
	`ends_at` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`updated_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pages_slug_uq` ON `pages` (`slug`);--> statement-breakpoint
CREATE INDEX `pages_kind_idx` ON `pages` (`kind`,`status`);--> statement-breakpoint
CREATE TABLE `redirects` (
	`id` text PRIMARY KEY NOT NULL,
	`from_path` text NOT NULL,
	`to_path` text NOT NULL,
	`code` integer DEFAULT 301 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "redirects_code_check" CHECK("redirects"."code" IN (301, 302, 307, 308) AND "redirects"."from_path" <> "redirects"."to_path")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `redirects_from_path_uq` ON `redirects` (`from_path`);--> statement-breakpoint
CREATE TABLE `translation_overrides` (
	`namespace` text NOT NULL,
	`key` text NOT NULL,
	`locale` text NOT NULL,
	`value` text NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`namespace`, `key`, `locale`)
);
--> statement-breakpoint
CREATE TABLE `cart_items` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`used_unit_id` text,
	`qty` integer DEFAULT 1 NOT NULL,
	`added_at` integer NOT NULL,
	`price_snapshot_iqd` integer,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`used_unit_id`) REFERENCES `used_units`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cart_items_qty_check" CHECK("cart_items"."qty" > 0 AND ("cart_items"."used_unit_id" IS NULL OR "cart_items"."qty" = 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cart_items_cart_variant_uq` ON `cart_items` (`cart_id`,`variant_id`) WHERE "cart_items"."used_unit_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `cart_items_cart_used_unit_uq` ON `cart_items` (`cart_id`,`used_unit_id`) WHERE "cart_items"."used_unit_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `cart_items_variant_idx` ON `cart_items` (`variant_id`);--> statement-breakpoint
CREATE INDEX `cart_items_used_unit_idx` ON `cart_items` (`used_unit_id`);--> statement-breakpoint
CREATE TABLE `carts` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`customer_id` text,
	`coupon_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`locale` text,
	`converted_order_id` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `carts_token_hash_uq` ON `carts` (`token_hash`);--> statement-breakpoint
CREATE INDEX `carts_customer_idx` ON `carts` (`customer_id`);--> statement-breakpoint
CREATE INDEX `carts_updated_at_idx` ON `carts` (`updated_at`);--> statement-breakpoint
CREATE TABLE `coupon_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`coupon_id` text NOT NULL,
	`order_id` text NOT NULL,
	`customer_id` text,
	`phone_e164` text,
	`amount_iqd` integer NOT NULL,
	`at` integer NOT NULL,
	`voided_at` integer,
	FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupon_redemptions_coupon_order_uq` ON `coupon_redemptions` (`coupon_id`,`order_id`);--> statement-breakpoint
CREATE INDEX `coupon_redemptions_order_idx` ON `coupon_redemptions` (`order_id`);--> statement-breakpoint
CREATE INDEX `coupon_redemptions_customer_idx` ON `coupon_redemptions` (`customer_id`,`coupon_id`);--> statement-breakpoint
CREATE INDEX `coupon_redemptions_phone_idx` ON `coupon_redemptions` (`phone_e164`,`coupon_id`);--> statement-breakpoint
CREATE TABLE `coupons` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`kind` text NOT NULL,
	`value` integer NOT NULL,
	`min_subtotal_iqd` integer,
	`max_discount_iqd` integer,
	`usage_limit` integer,
	`per_customer_limit` integer,
	`starts_at` integer,
	`ends_at` integer,
	`conditions` text,
	`is_active` integer DEFAULT true NOT NULL,
	`description` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	CONSTRAINT "coupons_value_check" CHECK("coupons"."value" > 0 AND ("coupons"."kind" <> 'percent' OR "coupons"."value" <= 10000))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `coupons_code_uq` ON `coupons` (`code`);--> statement-breakpoint
CREATE INDEX `coupons_active_idx` ON `coupons` (`is_active`,`ends_at`);--> statement-breakpoint
CREATE TABLE `gift_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`code_hint` text,
	`code_enc` text,
	`amount_iqd` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`order_item_id` text,
	`redeemed_by` text,
	`redeemed_at` integer,
	`wallet_ledger_id` text,
	`expires_at` integer,
	`note` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`redeemed_by`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "gift_cards_amount_check" CHECK("gift_cards"."amount_iqd" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `gift_cards_code_hash_uq` ON `gift_cards` (`code_hash`);--> statement-breakpoint
CREATE INDEX `gift_cards_status_idx` ON `gift_cards` (`status`);--> statement-breakpoint
CREATE INDEX `gift_cards_order_item_idx` ON `gift_cards` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `gift_cards_redeemed_by_idx` ON `gift_cards` (`redeemed_by`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`number` text NOT NULL,
	`kind` text DEFAULT 'invoice' NOT NULL,
	`order_id` text NOT NULL,
	`refund_id` text,
	`total_iqd` integer NOT NULL,
	`data` text NOT NULL,
	`issued_at` integer NOT NULL,
	`issued_by` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_number_uq` ON `invoices` (`number`);--> statement-breakpoint
CREATE INDEX `invoices_order_idx` ON `invoices` (`order_id`);--> statement-breakpoint
CREATE INDEX `invoices_refund_idx` ON `invoices` (`refund_id`);--> statement-breakpoint
CREATE INDEX `invoices_issued_at_idx` ON `invoices` (`issued_at`);--> statement-breakpoint
CREATE TABLE `loyalty_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`points` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`reason` text,
	`expires_at` integer,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`idempotency_key` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "loyalty_ledger_points_check" CHECK("loyalty_ledger"."points" <> 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `loyalty_ledger_idempotency_key_uq` ON `loyalty_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `loyalty_ledger_customer_idx` ON `loyalty_ledger` (`customer_id`,`at`);--> statement-breakpoint
CREATE INDEX `loyalty_ledger_ref_idx` ON `loyalty_ledger` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `loyalty_ledger_expiry_idx` ON `loyalty_ledger` (`expires_at`);--> statement-breakpoint
CREATE TABLE `order_events` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`kind` text NOT NULL,
	`data` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `order_events_order_idx` ON `order_events` (`order_id`,`at`);--> statement-breakpoint
CREATE INDEX `order_events_kind_idx` ON `order_events` (`kind`,`at`);--> statement-breakpoint
CREATE TABLE `order_item_serials` (
	`order_item_id` text NOT NULL,
	`serial_id` text NOT NULL,
	`attached_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`attached_by` text,
	`released_at` integer,
	PRIMARY KEY(`order_item_id`, `serial_id`),
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`serial_id`) REFERENCES `serials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `order_item_serials_serial_uq` ON `order_item_serials` (`serial_id`) WHERE "order_item_serials"."released_at" IS NULL;--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`used_unit_id` text,
	`sku` text NOT NULL,
	`name_snapshot` text NOT NULL,
	`options_snapshot` text,
	`unit_price_iqd` integer NOT NULL,
	`qty` integer NOT NULL,
	`discount_iqd` integer DEFAULT 0 NOT NULL,
	`total_iqd` integer NOT NULL,
	`cost_snapshot_iqd` integer,
	`refunded_qty` integer DEFAULT 0 NOT NULL,
	`warranty_months` integer,
	`warranty_days` integer,
	`is_preorder` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`used_unit_id`) REFERENCES `used_units`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "order_items_qty_check" CHECK("order_items"."qty" > 0 AND "order_items"."refunded_qty" >= 0 AND ("order_items"."used_unit_id" IS NULL OR "order_items"."qty" = 1)),
	CONSTRAINT "order_items_amounts_check" CHECK("order_items"."unit_price_iqd" >= 0 AND "order_items"."discount_iqd" >= 0 AND "order_items"."total_iqd" >= 0),
	CONSTRAINT "order_items_total_check" CHECK("order_items"."total_iqd" = "order_items"."unit_price_iqd" * "order_items"."qty" - "order_items"."discount_iqd")
);
--> statement-breakpoint
CREATE INDEX `order_items_order_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_variant_idx` ON `order_items` (`variant_id`);--> statement-breakpoint
CREATE INDEX `order_items_used_unit_idx` ON `order_items` (`used_unit_id`);--> statement-breakpoint
CREATE TABLE `orders` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`channel` text DEFAULT 'web' NOT NULL,
	`customer_id` text,
	`guest_contact_id` text,
	`status` text DEFAULT 'new' NOT NULL,
	`payment_status` text DEFAULT 'unpaid' NOT NULL,
	`payment_method` text,
	`subtotal_iqd` integer NOT NULL,
	`discount_iqd` integer DEFAULT 0 NOT NULL,
	`shipping_iqd` integer DEFAULT 0 NOT NULL,
	`total_iqd` integer NOT NULL,
	`paid_iqd` integer DEFAULT 0 NOT NULL,
	`refunded_iqd` integer DEFAULT 0 NOT NULL,
	`coupon_id` text,
	`contact_name` text,
	`contact_phone_e164` text,
	`governorate_id` text,
	`district_id` text,
	`area_text` text,
	`address_text` text,
	`notes` text,
	`preferred_day` text,
	`preferred_window` text,
	`marketing_consent` integer DEFAULT false NOT NULL,
	`locale` text DEFAULT 'ar' NOT NULL,
	`access_token_hash` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`risk_flags` text,
	`placed_at` integer NOT NULL,
	`confirmed_at` integer,
	`cancelled_at` integer,
	`cancel_reason` text,
	`tax_iqd` integer DEFAULT 0 NOT NULL,
	`coupon_code` text,
	`review_status` text DEFAULT 'none' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`internal_notes` text,
	`assigned_to` text,
	`payment_due_at` integer,
	`phone_verified_at` integer,
	`is_preorder` integer DEFAULT false NOT NULL,
	`expected_at` integer,
	`shipped_at` integer,
	`delivered_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`branch_id` text,
	`register_id` text,
	`pos_shift_id` text,
	`cashier_id` text,
	`offline_created_at` integer,
	`utm_link_id` text,
	`attribution` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`guest_contact_id`) REFERENCES `guest_contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`coupon_id`) REFERENCES `coupons`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`governorate_id`) REFERENCES `governorates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`district_id`) REFERENCES `districts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`register_id`) REFERENCES `pos_registers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pos_shift_id`) REFERENCES `pos_shifts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "orders_amounts_check" CHECK("orders"."subtotal_iqd" >= 0 AND "orders"."discount_iqd" >= 0 AND "orders"."shipping_iqd" >= 0 AND "orders"."tax_iqd" >= 0 AND "orders"."total_iqd" >= 0 AND "orders"."paid_iqd" >= 0 AND "orders"."refunded_iqd" >= 0),
	CONSTRAINT "orders_total_check" CHECK("orders"."total_iqd" = "orders"."subtotal_iqd" - "orders"."discount_iqd" + "orders"."shipping_iqd" + "orders"."tax_iqd"),
	CONSTRAINT "orders_web_phone_check" CHECK("orders"."channel" <> 'web' OR "orders"."contact_phone_e164" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `orders_ref_uq` ON `orders` (`ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `orders_idempotency_key_uq` ON `orders` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `orders_customer_idx` ON `orders` (`customer_id`,`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_guest_contact_idx` ON `orders` (`guest_contact_id`);--> statement-breakpoint
CREATE INDEX `orders_phone_idx` ON `orders` (`contact_phone_e164`,`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_status_idx` ON `orders` (`status`,`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_payment_status_idx` ON `orders` (`payment_status`,`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_placed_at_idx` ON `orders` (`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_channel_idx` ON `orders` (`channel`,`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_governorate_idx` ON `orders` (`governorate_id`);--> statement-breakpoint
CREATE INDEX `orders_district_idx` ON `orders` (`district_id`);--> statement-breakpoint
CREATE INDEX `orders_coupon_idx` ON `orders` (`coupon_id`);--> statement-breakpoint
CREATE INDEX `orders_review_idx` ON `orders` (`review_status`,`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_assigned_idx` ON `orders` (`assigned_to`,`status`);--> statement-breakpoint
CREATE INDEX `orders_branch_idx` ON `orders` (`branch_id`,`placed_at`);--> statement-breakpoint
CREATE INDEX `orders_register_idx` ON `orders` (`register_id`);--> statement-breakpoint
CREATE INDEX `orders_pos_shift_idx` ON `orders` (`pos_shift_id`);--> statement-breakpoint
CREATE INDEX `orders_utm_link_idx` ON `orders` (`utm_link_id`);--> statement-breakpoint
CREATE TABLE `payment_proofs` (
	`id` text PRIMARY KEY NOT NULL,
	`payment_id` text NOT NULL,
	`file_id` text NOT NULL,
	`declared_amount_iqd` integer NOT NULL,
	`note` text,
	`status` text DEFAULT 'submitted' NOT NULL,
	`duplicate_of` text,
	`sha256` text NOT NULL,
	`reviewed_by` text,
	`reviewed_at` integer,
	`review_note` text,
	`created_at` integer NOT NULL,
	`reference` text,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`duplicate_of`) REFERENCES `payment_proofs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payment_proofs_amount_check" CHECK("payment_proofs"."declared_amount_iqd" > 0)
);
--> statement-breakpoint
CREATE INDEX `payment_proofs_payment_idx` ON `payment_proofs` (`payment_id`);--> statement-breakpoint
CREATE INDEX `payment_proofs_file_idx` ON `payment_proofs` (`file_id`);--> statement-breakpoint
CREATE INDEX `payment_proofs_sha256_idx` ON `payment_proofs` (`sha256`);--> statement-breakpoint
CREATE INDEX `payment_proofs_reference_idx` ON `payment_proofs` (`reference`);--> statement-breakpoint
CREATE INDEX `payment_proofs_status_idx` ON `payment_proofs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `payment_proofs_duplicate_idx` ON `payment_proofs` (`duplicate_of`);--> statement-breakpoint
CREATE TABLE `payments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`method` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`amount_iqd` integer NOT NULL,
	`declared_amount_iqd` integer,
	`reference` text,
	`idempotency_key` text NOT NULL,
	`verified_by` text,
	`verified_at` integer,
	`reject_reason` text,
	`created_at` integer NOT NULL,
	`paid_at` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`pos_shift_id` text,
	`wallet_ledger_id` text,
	`notes` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pos_shift_id`) REFERENCES `pos_shifts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payments_amount_check" CHECK("payments"."amount_iqd" >= 0 AND ("payments"."declared_amount_iqd" IS NULL OR "payments"."declared_amount_iqd" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payments_idempotency_key_uq` ON `payments` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `payments_order_idx` ON `payments` (`order_id`);--> statement-breakpoint
CREATE INDEX `payments_status_idx` ON `payments` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `payments_method_idx` ON `payments` (`method`,`status`);--> statement-breakpoint
CREATE INDEX `payments_reference_idx` ON `payments` (`reference`);--> statement-breakpoint
CREATE INDEX `payments_pos_shift_idx` ON `payments` (`pos_shift_id`);--> statement-breakpoint
CREATE TABLE `refund_items` (
	`refund_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`qty` integer NOT NULL,
	PRIMARY KEY(`refund_id`, `order_item_id`),
	FOREIGN KEY (`refund_id`) REFERENCES `refunds`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refund_items_qty_check" CHECK("refund_items"."qty" > 0)
);
--> statement-breakpoint
CREATE INDEX `refund_items_order_item_idx` ON `refund_items` (`order_item_id`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`payment_id` text NOT NULL,
	`amount_iqd` integer NOT NULL,
	`method` text NOT NULL,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`return_id` text,
	`approved_at` integer,
	`paid_at` integer,
	`wallet_ledger_id` text,
	`reference` text,
	`idempotency_key` text,
	`reject_reason` text,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_id`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "refunds_amount_check" CHECK("refunds"."amount_iqd" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_idempotency_key_uq` ON `refunds` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `refunds_order_idx` ON `refunds` (`order_id`);--> statement-breakpoint
CREATE INDEX `refunds_payment_idx` ON `refunds` (`payment_id`,`status`);--> statement-breakpoint
CREATE INDEX `refunds_return_idx` ON `refunds` (`return_id`);--> statement-breakpoint
CREATE INDEX `refunds_status_idx` ON `refunds` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `wallet_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`amount_iqd` integer NOT NULL,
	`kind` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`reason` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`idempotency_key` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wallet_ledger_amount_check" CHECK("wallet_ledger"."amount_iqd" <> 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_ledger_idempotency_key_uq` ON `wallet_ledger` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `wallet_ledger_customer_idx` ON `wallet_ledger` (`customer_id`,`at`);--> statement-breakpoint
CREATE INDEX `wallet_ledger_ref_idx` ON `wallet_ledger` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `wallet_topups` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`customer_id` text NOT NULL,
	`method` text NOT NULL,
	`amount_iqd` integer NOT NULL,
	`declared_amount_iqd` integer,
	`reference` text,
	`proof_file_id` text,
	`sha256` text,
	`status` text DEFAULT 'pending_verification' NOT NULL,
	`verified_by` text,
	`verified_at` integer,
	`reject_reason` text,
	`wallet_ledger_id` text,
	`idempotency_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proof_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "wallet_topups_amount_check" CHECK("wallet_topups"."amount_iqd" > 0),
	CONSTRAINT "wallet_topups_verified_check" CHECK("wallet_topups"."status" <> 'approved' OR ("wallet_topups"."verified_by" IS NOT NULL AND "wallet_topups"."verified_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_topups_ref_uq` ON `wallet_topups` (`ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `wallet_topups_idempotency_key_uq` ON `wallet_topups` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `wallet_topups_customer_idx` ON `wallet_topups` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `wallet_topups_status_idx` ON `wallet_topups` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `wallet_topups_proof_file_idx` ON `wallet_topups` (`proof_file_id`);--> statement-breakpoint
CREATE INDEX `wallet_topups_sha256_idx` ON `wallet_topups` (`sha256`);--> statement-breakpoint
CREATE INDEX `wallet_topups_reference_idx` ON `wallet_topups` (`reference`);--> statement-breakpoint
CREATE TABLE `audit_events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`id` text NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`actor_label` text,
	`action` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`summary` text,
	`before` text,
	`after` text,
	`reason` text,
	`ip` text,
	`request_id` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_events_id_uq` ON `audit_events` (`id`);--> statement-breakpoint
CREATE INDEX `audit_events_entity_idx` ON `audit_events` (`entity_type`,`entity_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_actor_idx` ON `audit_events` (`actor_kind`,`actor_id`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_action_idx` ON `audit_events` (`action`,`seq`);--> statement-breakpoint
CREATE INDEX `audit_events_at_idx` ON `audit_events` (`at`);--> statement-breakpoint
CREATE INDEX `audit_events_request_idx` ON `audit_events` (`request_id`);--> statement-breakpoint
CREATE TABLE `audit_seals` (
	`id` text PRIMARY KEY NOT NULL,
	`from_seq` integer NOT NULL,
	`to_seq` integer NOT NULL,
	`hash` text NOT NULL,
	`prev_hash` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_seals_from_seq_uq` ON `audit_seals` (`from_seq`);--> statement-breakpoint
CREATE UNIQUE INDEX `audit_seals_to_seq_uq` ON `audit_seals` (`to_seq`);--> statement-breakpoint
CREATE TABLE `auth_events` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text,
	`identifier` text,
	`kind` text NOT NULL,
	`success` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`details` text,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_events_subject_idx` ON `auth_events` (`subject_kind`,`subject_id`,`at`);--> statement-breakpoint
CREATE INDEX `auth_events_identifier_idx` ON `auth_events` (`identifier`,`at`);--> statement-breakpoint
CREATE INDEX `auth_events_ip_idx` ON `auth_events` (`ip`,`at`);--> statement-breakpoint
CREATE INDEX `auth_events_at_idx` ON `auth_events` (`at`);--> statement-breakpoint
CREATE TABLE `consistency_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`check_key` text NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`message` text NOT NULL,
	`details` text,
	`status` text DEFAULT 'open' NOT NULL,
	`occurrences` integer DEFAULT 1 NOT NULL,
	`detected_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`run_id` text,
	`resolved_by` text,
	`resolved_at` integer,
	`resolution_note` text,
	FOREIGN KEY (`run_id`) REFERENCES `job_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `consistency_findings_fingerprint_uq` ON `consistency_findings` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `consistency_findings_status_idx` ON `consistency_findings` (`status`,`severity`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `consistency_findings_check_idx` ON `consistency_findings` (`check_key`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `consistency_findings_entity_idx` ON `consistency_findings` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `consistency_findings_run_idx` ON `consistency_findings` (`run_id`);--> statement-breakpoint
CREATE TABLE `error_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`source` text NOT NULL,
	`level` text DEFAULT 'error' NOT NULL,
	`message` text NOT NULL,
	`stack` text,
	`route` text,
	`url` text,
	`release` text,
	`sample` text,
	`count` integer DEFAULT 1 NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`incident_id` text,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `error_reports_fingerprint_uq` ON `error_reports` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `error_reports_status_idx` ON `error_reports` (`status`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `error_reports_source_idx` ON `error_reports` (`source`,`last_seen_at`);--> statement-breakpoint
CREATE INDEX `error_reports_incident_idx` ON `error_reports` (`incident_id`);--> statement-breakpoint
CREATE TABLE `files` (
	`id` text PRIMARY KEY NOT NULL,
	`storage_key` text NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`kind` text NOT NULL,
	`mime` text NOT NULL,
	`bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`owner_type` text,
	`owner_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`created_by_kind` text,
	`original_name` text,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `files_storage_key_uq` ON `files` (`storage_key`);--> statement-breakpoint
CREATE INDEX `files_sha256_idx` ON `files` (`sha256`);--> statement-breakpoint
CREATE INDEX `files_owner_idx` ON `files` (`owner_type`,`owner_id`);--> statement-breakpoint
CREATE INDEX `files_kind_idx` ON `files` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `incident_updates` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`status` text,
	`note` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `incident_updates_incident_idx` ON `incident_updates` (`incident_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`title` text NOT NULL,
	`severity` text DEFAULT 'sev3' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`summary` text,
	`impact` text,
	`root_cause` text,
	`owner_id` text,
	`started_at` integer NOT NULL,
	`detected_at` integer,
	`mitigated_at` integer,
	`resolved_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `incidents_ref_uq` ON `incidents` (`ref`);--> statement-breakpoint
CREATE INDEX `incidents_status_idx` ON `incidents` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `incidents_owner_idx` ON `incidents` (`owner_id`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`origin` text DEFAULT 'cron' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`duration_ms` integer,
	`stats` text,
	`error` text,
	`triggered_by` text
);
--> statement-breakpoint
CREATE INDEX `job_runs_job_idx` ON `job_runs` (`job`,`started_at`);--> statement-breakpoint
CREATE INDEX `job_runs_status_idx` ON `job_runs` (`status`,`started_at`);--> statement-breakpoint
CREATE TABLE `message_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`channel` text NOT NULL,
	`locale` text NOT NULL,
	`subject` text,
	`body` text NOT NULL,
	`variables` text,
	`is_active` integer DEFAULT true NOT NULL,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_templates_key_uq` ON `message_templates` (`key`,`channel`,`locale`);--> statement-breakpoint
CREATE TABLE `outbox` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`recipient` text NOT NULL,
	`template` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'held' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	`locale` text,
	`customer_id` text,
	`ref_type` text,
	`ref_id` text,
	`dedupe_key` text,
	`next_attempt_at` integer,
	`provider_message_id` text
);
--> statement-breakpoint
CREATE INDEX `outbox_status_idx` ON `outbox` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `outbox_recipient_idx` ON `outbox` (`recipient`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_customer_idx` ON `outbox` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `outbox_ref_idx` ON `outbox` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `outbox_created_at_idx` ON `outbox` (`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `outbox_dedupe_key_uq` ON `outbox` (`dedupe_key`);--> statement-breakpoint
CREATE TABLE `perf_rollups` (
	`day` text NOT NULL,
	`area` text NOT NULL,
	`route` text NOT NULL,
	`metric` text NOT NULL,
	`device` text DEFAULT 'unknown' NOT NULL,
	`samples` integer DEFAULT 0 NOT NULL,
	`sum_value` integer DEFAULT 0 NOT NULL,
	`max_value` integer DEFAULT 0 NOT NULL,
	`good` integer DEFAULT 0 NOT NULL,
	`needs_improvement` integer DEFAULT 0 NOT NULL,
	`poor` integer DEFAULT 0 NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`day`, `area`, `route`, `metric`, `device`)
);
--> statement-breakpoint
CREATE INDEX `perf_rollups_metric_idx` ON `perf_rollups` (`metric`,`day`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text NOT NULL,
	`window_start` integer NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `rate_limits_window_idx` ON `rate_limits` (`window_start`);--> statement-breakpoint
CREATE TABLE `sequences` (
	`name` text PRIMARY KEY NOT NULL,
	`value` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text
);
--> statement-breakpoint
CREATE TABLE `addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`label` text,
	`recipient_name` text,
	`phone_e164` text,
	`governorate_id` text NOT NULL,
	`district_id` text,
	`area_text` text,
	`address_text` text NOT NULL,
	`notes` text,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`governorate_id`) REFERENCES `governorates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`district_id`) REFERENCES `districts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `addresses_customer_idx` ON `addresses` (`customer_id`);--> statement-breakpoint
CREATE INDEX `addresses_governorate_idx` ON `addresses` (`governorate_id`);--> statement-breakpoint
CREATE INDEX `addresses_district_idx` ON `addresses` (`district_id`);--> statement-breakpoint
CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`kind` text NOT NULL,
	`granted` integer NOT NULL,
	`source` text,
	`at` integer NOT NULL,
	`ip` text,
	`policy_version` text
);
--> statement-breakpoint
CREATE INDEX `consents_subject_idx` ON `consents` (`subject_type`,`subject_id`,`kind`,`at`);--> statement-breakpoint
CREATE TABLE `customer_segment_members` (
	`segment_id` text NOT NULL,
	`customer_id` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`segment_id`, `customer_id`),
	FOREIGN KEY (`segment_id`) REFERENCES `customer_segments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_segment_members_customer_idx` ON `customer_segment_members` (`customer_id`);--> statement-breakpoint
CREATE TABLE `customer_segments` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`rules` text,
	`is_dynamic` integer DEFAULT true NOT NULL,
	`member_count` integer DEFAULT 0 NOT NULL,
	`computed_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customer_segments_key_uq` ON `customer_segments` (`key`);--> statement-breakpoint
CREATE TABLE `customer_sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`revoked_at` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `customer_sessions_customer_idx` ON `customer_sessions` (`customer_id`);--> statement-breakpoint
CREATE INDEX `customer_sessions_expires_idx` ON `customer_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `customers` (
	`id` text PRIMARY KEY NOT NULL,
	`phone_e164` text NOT NULL,
	`name` text,
	`email` text,
	`password_hash` text,
	`password_iters` integer,
	`status` text DEFAULT 'active' NOT NULL,
	`locale` text DEFAULT 'ar' NOT NULL,
	`vip_tier` text,
	`fraud_flag` integer DEFAULT false NOT NULL,
	`notes` text,
	`created_at` integer NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`phone_verified_at` integer,
	`last_login_at` integer,
	`fraud_reason` text,
	`notification_prefs` text,
	`merged_into_id` text,
	`anonymized_at` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`merged_into_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `customers_phone_uq` ON `customers` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `customers_email_idx` ON `customers` (`email`);--> statement-breakpoint
CREATE INDEX `customers_status_idx` ON `customers` (`status`);--> statement-breakpoint
CREATE INDEX `customers_created_at_idx` ON `customers` (`created_at`);--> statement-breakpoint
CREATE INDEX `customers_merged_into_idx` ON `customers` (`merged_into_id`);--> statement-breakpoint
CREATE TABLE `guest_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`phone_e164` text NOT NULL,
	`name` text,
	`created_at` integer NOT NULL,
	`customer_id` text,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `guest_contacts_phone_idx` ON `guest_contacts` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `guest_contacts_customer_idx` ON `guest_contacts` (`customer_id`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`link` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_customer_idx` ON `notifications` (`customer_id`,`read_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `otp_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`phone_e164` text NOT NULL,
	`purpose` text NOT NULL,
	`code_hash` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`ip` text,
	`ref` text
);
--> statement-breakpoint
CREATE INDEX `otp_codes_phone_idx` ON `otp_codes` (`phone_e164`,`purpose`,`expires_at`);--> statement-breakpoint
CREATE INDEX `otp_codes_expires_idx` ON `otp_codes` (`expires_at`);--> statement-breakpoint
CREATE TABLE `privacy_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`customer_id` text,
	`phone_e164` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`details` text,
	`verified_at` integer,
	`handled_by` text,
	`due_at` integer,
	`completed_at` integer,
	`result_file_id` text,
	`resolution_note` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`result_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `privacy_requests_ref_uq` ON `privacy_requests` (`ref`);--> statement-breakpoint
CREATE INDEX `privacy_requests_customer_idx` ON `privacy_requests` (`customer_id`);--> statement-breakpoint
CREATE INDEX `privacy_requests_phone_idx` ON `privacy_requests` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `privacy_requests_status_idx` ON `privacy_requests` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `privacy_requests_result_file_idx` ON `privacy_requests` (`result_file_id`);--> statement-breakpoint
CREATE TABLE `recently_viewed` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`cart_token_hash` text,
	`product_id` text NOT NULL,
	`viewed_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "recently_viewed_owner_check" CHECK("recently_viewed"."customer_id" IS NOT NULL OR "recently_viewed"."cart_token_hash" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recently_viewed_customer_product_uq` ON `recently_viewed` (`customer_id`,`product_id`) WHERE "recently_viewed"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `recently_viewed_token_product_uq` ON `recently_viewed` (`cart_token_hash`,`product_id`) WHERE "recently_viewed"."cart_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `recently_viewed_customer_idx` ON `recently_viewed` (`customer_id`,`viewed_at`);--> statement-breakpoint
CREATE INDEX `recently_viewed_token_idx` ON `recently_viewed` (`cart_token_hash`,`viewed_at`);--> statement-breakpoint
CREATE INDEX `recently_viewed_product_idx` ON `recently_viewed` (`product_id`);--> statement-breakpoint
CREATE TABLE `saved_devices` (
	`customer_id` text NOT NULL,
	`device_model_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`customer_id`, `device_model_id`),
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`device_model_id`) REFERENCES `device_models`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_devices_model_idx` ON `saved_devices` (`device_model_id`);--> statement-breakpoint
CREATE TABLE `wishlist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text,
	`cart_token_hash` text,
	`product_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "wishlist_items_owner_check" CHECK("wishlist_items"."customer_id" IS NOT NULL OR "wishlist_items"."cart_token_hash" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `wishlist_items_customer_product_uq` ON `wishlist_items` (`customer_id`,`product_id`) WHERE "wishlist_items"."customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `wishlist_items_token_product_uq` ON `wishlist_items` (`cart_token_hash`,`product_id`) WHERE "wishlist_items"."cart_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `wishlist_items_product_idx` ON `wishlist_items` (`product_id`);--> statement-breakpoint
CREATE TABLE `campaign_recipients` (
	`id` text PRIMARY KEY NOT NULL,
	`campaign_id` text NOT NULL,
	`customer_id` text,
	`recipient` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`outbox_id` text,
	`sent_at` integer,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `campaign_recipients_campaign_recipient_uq` ON `campaign_recipients` (`campaign_id`,`recipient`);--> statement-breakpoint
CREATE INDEX `campaign_recipients_customer_idx` ON `campaign_recipients` (`customer_id`);--> statement-breakpoint
CREATE INDEX `campaign_recipients_status_idx` ON `campaign_recipients` (`campaign_id`,`status`);--> statement-breakpoint
CREATE TABLE `campaigns` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`segment_id` text,
	`template_key` text,
	`content` text,
	`scheduled_at` integer,
	`sent_at` integer,
	`budget_iqd` integer,
	`spend_iqd` integer DEFAULT 0 NOT NULL,
	`utm_campaign` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`segment_id`) REFERENCES `customer_segments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `campaigns_status_idx` ON `campaigns` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `campaigns_segment_idx` ON `campaigns` (`segment_id`);--> statement-breakpoint
CREATE INDEX `campaigns_utm_idx` ON `campaigns` (`utm_campaign`);--> statement-breakpoint
CREATE TABLE `cart_reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`cart_id` text NOT NULL,
	`customer_id` text,
	`phone_e164` text,
	`channel` text NOT NULL,
	`step` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`scheduled_at` integer NOT NULL,
	`sent_at` integer,
	`outbox_id` text,
	`recovered_order_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`cart_id`) REFERENCES `carts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recovered_order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cart_reminders_cart_step_uq` ON `cart_reminders` (`cart_id`,`step`);--> statement-breakpoint
CREATE INDEX `cart_reminders_due_idx` ON `cart_reminders` (`status`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `cart_reminders_customer_idx` ON `cart_reminders` (`customer_id`);--> statement-breakpoint
CREATE INDEX `cart_reminders_order_idx` ON `cart_reminders` (`recovered_order_id`);--> statement-breakpoint
CREATE TABLE `experiment_assignments` (
	`experiment_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`variant_key` text NOT NULL,
	`assigned_at` integer NOT NULL,
	PRIMARY KEY(`experiment_id`, `subject_hash`),
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `experiment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`experiment_id` text NOT NULL,
	`subject_hash` text NOT NULL,
	`variant_key` text NOT NULL,
	`kind` text NOT NULL,
	`value_iqd` integer,
	`at` integer NOT NULL,
	FOREIGN KEY (`experiment_id`) REFERENCES `experiments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `experiment_events_experiment_idx` ON `experiment_events` (`experiment_id`,`variant_key`,`kind`);--> statement-breakpoint
CREATE INDEX `experiment_events_at_idx` ON `experiment_events` (`at`);--> statement-breakpoint
CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`area` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`variants` text NOT NULL,
	`primary_metric` text NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`winner_variant` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `experiments_key_uq` ON `experiments` (`key`);--> statement-breakpoint
CREATE INDEX `experiments_status_idx` ON `experiments` (`status`);--> statement-breakpoint
CREATE TABLE `flash_sale_items` (
	`id` text PRIMARY KEY NOT NULL,
	`flash_sale_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`sale_price_iqd` integer NOT NULL,
	`qty_limit` integer,
	`qty_sold` integer DEFAULT 0 NOT NULL,
	`per_customer_limit` integer,
	FOREIGN KEY (`flash_sale_id`) REFERENCES `flash_sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "flash_sale_items_qty_check" CHECK("flash_sale_items"."sale_price_iqd" >= 0 AND "flash_sale_items"."qty_sold" >= 0 AND ("flash_sale_items"."qty_limit" IS NULL OR "flash_sale_items"."qty_sold" <= "flash_sale_items"."qty_limit"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flash_sale_items_sale_variant_uq` ON `flash_sale_items` (`flash_sale_id`,`variant_id`);--> statement-breakpoint
CREATE INDEX `flash_sale_items_variant_idx` ON `flash_sale_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `flash_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "flash_sales_window_check" CHECK("flash_sales"."ends_at" > "flash_sales"."starts_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flash_sales_slug_uq` ON `flash_sales` (`slug`);--> statement-breakpoint
CREATE INDEX `flash_sales_window_idx` ON `flash_sales` (`status`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE TABLE `membership_tiers` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`benefits` text,
	`price_iqd` integer,
	`duration_days` integer,
	`min_spend_iqd` integer,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `membership_tiers_key_uq` ON `membership_tiers` (`key`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`customer_id` text NOT NULL,
	`tier_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`starts_at` integer NOT NULL,
	`ends_at` integer,
	`source` text DEFAULT 'grant' NOT NULL,
	`order_id` text,
	`granted_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tier_id`) REFERENCES `membership_tiers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `memberships_customer_idx` ON `memberships` (`customer_id`,`status`);--> statement-breakpoint
CREATE INDEX `memberships_tier_idx` ON `memberships` (`tier_id`);--> statement-breakpoint
CREATE INDEX `memberships_order_idx` ON `memberships` (`order_id`);--> statement-breakpoint
CREATE INDEX `memberships_expiry_idx` ON `memberships` (`status`,`ends_at`);--> statement-breakpoint
CREATE TABLE `promotions` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`kind` text NOT NULL,
	`value` integer,
	`config` text,
	`scope` text,
	`max_discount_iqd` integer,
	`priority` integer DEFAULT 0 NOT NULL,
	`stackable` integer DEFAULT false NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`is_active` integer DEFAULT false NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `promotions_active_idx` ON `promotions` (`is_active`,`starts_at`,`ends_at`);--> statement-breakpoint
CREATE TABLE `recommendation_events` (
	`id` text PRIMARY KEY NOT NULL,
	`session_hash` text,
	`customer_id` text,
	`kind` text NOT NULL,
	`product_id` text NOT NULL,
	`source` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recommendation_events_product_idx` ON `recommendation_events` (`product_id`,`kind`,`at`);--> statement-breakpoint
CREATE INDEX `recommendation_events_customer_idx` ON `recommendation_events` (`customer_id`,`at`);--> statement-breakpoint
CREATE INDEX `recommendation_events_session_idx` ON `recommendation_events` (`session_hash`,`at`);--> statement-breakpoint
CREATE INDEX `recommendation_events_source_idx` ON `recommendation_events` (`source`,`kind`,`at`);--> statement-breakpoint
CREATE INDEX `recommendation_events_at_idx` ON `recommendation_events` (`at`);--> statement-breakpoint
CREATE TABLE `recommendation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`context` text,
	`product_id` text NOT NULL,
	`weight` integer DEFAULT 0 NOT NULL,
	`reason` text,
	`created_by` text,
	`is_active` integer DEFAULT true NOT NULL,
	`starts_at` integer,
	`ends_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recommendation_rules_product_idx` ON `recommendation_rules` (`product_id`);--> statement-breakpoint
CREATE INDEX `recommendation_rules_kind_idx` ON `recommendation_rules` (`kind`,`is_active`);--> statement-breakpoint
CREATE TABLE `referral_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`customer_id` text NOT NULL,
	`max_uses` integer,
	`uses` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "referral_codes_uses_check" CHECK("referral_codes"."uses" >= 0 AND ("referral_codes"."max_uses" IS NULL OR "referral_codes"."uses" <= "referral_codes"."max_uses"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_codes_code_uq` ON `referral_codes` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `referral_codes_customer_uq` ON `referral_codes` (`customer_id`);--> statement-breakpoint
CREATE TABLE `referral_redemptions` (
	`id` text PRIMARY KEY NOT NULL,
	`referral_code_id` text NOT NULL,
	`referred_customer_id` text,
	`referred_phone_e164` text NOT NULL,
	`order_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`reject_reason` text,
	`rewarded_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`referral_code_id`) REFERENCES `referral_codes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`referred_customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `referral_redemptions_phone_uq` ON `referral_redemptions` (`referred_phone_e164`);--> statement-breakpoint
CREATE INDEX `referral_redemptions_code_idx` ON `referral_redemptions` (`referral_code_id`,`status`);--> statement-breakpoint
CREATE INDEX `referral_redemptions_customer_idx` ON `referral_redemptions` (`referred_customer_id`);--> statement-breakpoint
CREATE INDEX `referral_redemptions_order_idx` ON `referral_redemptions` (`order_id`);--> statement-breakpoint
CREATE TABLE `utm_links` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`campaign_id` text,
	`target_path` text NOT NULL,
	`utm_source` text NOT NULL,
	`utm_medium` text NOT NULL,
	`utm_campaign` text,
	`utm_content` text,
	`utm_term` text,
	`clicks` integer DEFAULT 0 NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`campaign_id`) REFERENCES `campaigns`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `utm_links_code_uq` ON `utm_links` (`code`);--> statement-breakpoint
CREATE INDEX `utm_links_campaign_idx` ON `utm_links` (`campaign_id`);--> statement-breakpoint
CREATE TABLE `cost_layers` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`qty_remaining` integer NOT NULL,
	`unit_cost_iqd` integer NOT NULL,
	`received_at` integer NOT NULL,
	`receipt_item_id` text,
	`qty_received` integer NOT NULL,
	`source` text DEFAULT 'purchase' NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_item_id`) REFERENCES `receipt_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cost_layers_qty_check" CHECK("cost_layers"."qty_remaining" >= 0 AND "cost_layers"."qty_remaining" <= "cost_layers"."qty_received" AND "cost_layers"."unit_cost_iqd" >= 0)
);
--> statement-breakpoint
CREATE INDEX `cost_layers_fifo_idx` ON `cost_layers` (`variant_id`,`location_id`,`received_at`);--> statement-breakpoint
CREATE INDEX `cost_layers_location_idx` ON `cost_layers` (`location_id`);--> statement-breakpoint
CREATE INDEX `cost_layers_receipt_item_idx` ON `cost_layers` (`receipt_item_id`);--> statement-breakpoint
CREATE TABLE `cycle_count_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`count_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`expected_qty` integer NOT NULL,
	`counted_qty` integer,
	`reason` text,
	`serials_seen` text,
	`counted_by` text,
	`counted_at` integer,
	FOREIGN KEY (`count_id`) REFERENCES `cycle_counts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cycle_count_lines_count_variant_uq` ON `cycle_count_lines` (`count_id`,`variant_id`);--> statement-breakpoint
CREATE INDEX `cycle_count_lines_variant_idx` ON `cycle_count_lines` (`variant_id`);--> statement-breakpoint
CREATE TABLE `cycle_counts` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`location_id` text NOT NULL,
	`scope` text DEFAULT 'partial' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`notes` text,
	`started_by` text,
	`approved_by` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`submitted_at` integer,
	`approved_at` integer,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cycle_counts_ref_uq` ON `cycle_counts` (`ref`);--> statement-breakpoint
CREATE INDEX `cycle_counts_location_idx` ON `cycle_counts` (`location_id`);--> statement-breakpoint
CREATE INDEX `cycle_counts_status_idx` ON `cycle_counts` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `demand_forecasts` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`period` text NOT NULL,
	`qty_forecast` integer NOT NULL,
	`method` text NOT NULL,
	`inputs` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `demand_forecasts_variant_period_uq` ON `demand_forecasts` (`variant_id`,`period`,`method`);--> statement-breakpoint
CREATE TABLE `digital_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`code_enc` text NOT NULL,
	`code_hash` text NOT NULL,
	`status` text DEFAULT 'available' NOT NULL,
	`order_item_id` text,
	`receipt_item_id` text,
	`cost_iqd` integer,
	`expires_at` integer,
	`reserved_at` integer,
	`delivered_at` integer,
	`revealed_at` integer,
	`reveal_count` integer DEFAULT 0 NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_item_id`) REFERENCES `receipt_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `digital_codes_code_hash_uq` ON `digital_codes` (`code_hash`);--> statement-breakpoint
CREATE INDEX `digital_codes_variant_idx` ON `digital_codes` (`variant_id`,`status`);--> statement-breakpoint
CREATE INDEX `digital_codes_order_item_idx` ON `digital_codes` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `digital_codes_receipt_item_idx` ON `digital_codes` (`receipt_item_id`);--> statement-breakpoint
CREATE TABLE `inventory_locations` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'warehouse' NOT NULL,
	`parent_id` text,
	`barcode` text,
	`is_sellable` integer DEFAULT true NOT NULL,
	`branch_id` text,
	`is_active` integer DEFAULT true NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_locations_code_uq` ON `inventory_locations` (`code`);--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_locations_barcode_uq` ON `inventory_locations` (`barcode`);--> statement-breakpoint
CREATE INDEX `inventory_locations_parent_idx` ON `inventory_locations` (`parent_id`);--> statement-breakpoint
CREATE INDEX `inventory_locations_branch_idx` ON `inventory_locations` (`branch_id`);--> statement-breakpoint
CREATE TABLE `reorder_suggestions` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`location_id` text,
	`supplier_id` text,
	`suggested_qty` integer NOT NULL,
	`days_of_cover` integer,
	`basis` text,
	`status` text DEFAULT 'open' NOT NULL,
	`purchase_order_id` text,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reorder_suggestions_qty_check" CHECK("reorder_suggestions"."suggested_qty" > 0)
);
--> statement-breakpoint
CREATE INDEX `reorder_suggestions_status_idx` ON `reorder_suggestions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `reorder_suggestions_variant_idx` ON `reorder_suggestions` (`variant_id`);--> statement-breakpoint
CREATE INDEX `reorder_suggestions_location_idx` ON `reorder_suggestions` (`location_id`);--> statement-breakpoint
CREATE INDEX `reorder_suggestions_supplier_idx` ON `reorder_suggestions` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `serials` (
	`id` text PRIMARY KEY NOT NULL,
	`serial` text NOT NULL,
	`variant_id` text NOT NULL,
	`status` text DEFAULT 'in_stock' NOT NULL,
	`location_id` text,
	`cost_iqd` integer,
	`source` text DEFAULT 'purchase' NOT NULL,
	`source_ref` text,
	`notes` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `serials_serial_uq` ON `serials` (`serial`);--> statement-breakpoint
CREATE INDEX `serials_variant_idx` ON `serials` (`variant_id`,`status`);--> statement-breakpoint
CREATE INDEX `serials_location_idx` ON `serials` (`location_id`);--> statement-breakpoint
CREATE INDEX `serials_status_idx` ON `serials` (`status`);--> statement-breakpoint
CREATE TABLE `stock_levels` (
	`variant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`on_hand` integer DEFAULT 0 NOT NULL,
	`reserved` integer DEFAULT 0 NOT NULL,
	`incoming` integer DEFAULT 0 NOT NULL,
	`reorder_point` integer,
	`allow_oversell` integer DEFAULT false NOT NULL,
	`reorder_qty` integer,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`variant_id`, `location_id`),
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_levels_counts_check" CHECK("stock_levels"."reserved" >= 0 AND "stock_levels"."incoming" >= 0)
);
--> statement-breakpoint
CREATE INDEX `stock_levels_location_idx` ON `stock_levels` (`location_id`);--> statement-breakpoint
CREATE TABLE `stock_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`variant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`serial_id` text,
	`kind` text NOT NULL,
	`qty_delta` integer DEFAULT 0 NOT NULL,
	`reserved_delta` integer DEFAULT 0 NOT NULL,
	`unit_cost_iqd` integer,
	`ref_type` text,
	`ref_id` text,
	`reason` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`serial_id`) REFERENCES `serials`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stock_movements_variant_idx` ON `stock_movements` (`variant_id`,`at`);--> statement-breakpoint
CREATE INDEX `stock_movements_location_idx` ON `stock_movements` (`location_id`,`at`);--> statement-breakpoint
CREATE INDEX `stock_movements_serial_idx` ON `stock_movements` (`serial_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_ref_idx` ON `stock_movements` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE INDEX `stock_movements_kind_idx` ON `stock_movements` (`kind`,`at`);--> statement-breakpoint
CREATE TABLE `stock_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`location_id` text NOT NULL,
	`qty` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`order_item_id` text,
	`released_at` integer,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_reservations_qty_check" CHECK("stock_reservations"."qty" > 0)
);
--> statement-breakpoint
CREATE INDEX `stock_reservations_order_idx` ON `stock_reservations` (`order_id`);--> statement-breakpoint
CREATE INDEX `stock_reservations_variant_idx` ON `stock_reservations` (`variant_id`,`location_id`,`status`);--> statement-breakpoint
CREATE INDEX `stock_reservations_location_idx` ON `stock_reservations` (`location_id`);--> statement-breakpoint
CREATE INDEX `stock_reservations_order_item_idx` ON `stock_reservations` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `stock_reservations_expiry_idx` ON `stock_reservations` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `stock_transfer_items` (
	`id` text PRIMARY KEY NOT NULL,
	`transfer_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`serial_id` text,
	`qty` integer NOT NULL,
	`qty_received` integer DEFAULT 0 NOT NULL,
	`notes` text,
	FOREIGN KEY (`transfer_id`) REFERENCES `stock_transfers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`serial_id`) REFERENCES `serials`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_transfer_items_qty_check" CHECK("stock_transfer_items"."qty" > 0 AND "stock_transfer_items"."qty_received" >= 0 AND "stock_transfer_items"."qty_received" <= "stock_transfer_items"."qty")
);
--> statement-breakpoint
CREATE INDEX `stock_transfer_items_transfer_idx` ON `stock_transfer_items` (`transfer_id`);--> statement-breakpoint
CREATE INDEX `stock_transfer_items_variant_idx` ON `stock_transfer_items` (`variant_id`);--> statement-breakpoint
CREATE INDEX `stock_transfer_items_serial_idx` ON `stock_transfer_items` (`serial_id`);--> statement-breakpoint
CREATE TABLE `stock_transfers` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`from_location_id` text NOT NULL,
	`to_location_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`notes` text,
	`requested_by` text,
	`shipped_by` text,
	`received_by` text,
	`created_at` integer NOT NULL,
	`shipped_at` integer,
	`received_at` integer,
	`cancelled_at` integer,
	FOREIGN KEY (`from_location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`to_location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "stock_transfers_locations_check" CHECK("stock_transfers"."from_location_id" <> "stock_transfers"."to_location_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `stock_transfers_ref_uq` ON `stock_transfers` (`ref`);--> statement-breakpoint
CREATE INDEX `stock_transfers_from_idx` ON `stock_transfers` (`from_location_id`);--> statement-breakpoint
CREATE INDEX `stock_transfers_to_idx` ON `stock_transfers` (`to_location_id`);--> statement-breakpoint
CREATE INDEX `stock_transfers_status_idx` ON `stock_transfers` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `carrier_zones` (
	`id` text PRIMARY KEY NOT NULL,
	`carrier_id` text NOT NULL,
	`governorate_id` text NOT NULL,
	`service_level` text DEFAULT 'standard' NOT NULL,
	`cost_iqd` integer NOT NULL,
	`eta_days_min` integer,
	`eta_days_max` integer,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`carrier_id`) REFERENCES `carriers`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`governorate_id`) REFERENCES `governorates`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "carrier_zones_cost_check" CHECK("carrier_zones"."cost_iqd" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `carrier_zones_zone_uq` ON `carrier_zones` (`carrier_id`,`governorate_id`,`service_level`);--> statement-breakpoint
CREATE INDEX `carrier_zones_governorate_idx` ON `carrier_zones` (`governorate_id`);--> statement-breakpoint
CREATE TABLE `carriers` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'third_party' NOT NULL,
	`contact_name` text,
	`phone` text,
	`tracking_url_template` text,
	`cod_supported` integer DEFAULT true NOT NULL,
	`cod_fee_iqd` integer,
	`cod_fee_bps` integer,
	`notes` text,
	`is_active` integer DEFAULT true NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `carriers_code_uq` ON `carriers` (`code`);--> statement-breakpoint
CREATE TABLE `cod_settlement_items` (
	`settlement_id` text NOT NULL,
	`shipment_id` text NOT NULL,
	`amount_iqd` integer NOT NULL,
	`fee_iqd` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`settlement_id`, `shipment_id`),
	FOREIGN KEY (`settlement_id`) REFERENCES `cod_settlements`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cod_settlement_items_shipment_uq` ON `cod_settlement_items` (`shipment_id`);--> statement-breakpoint
CREATE TABLE `cod_settlements` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`carrier_id` text NOT NULL,
	`period_from` integer,
	`period_to` integer,
	`expected_iqd` integer DEFAULT 0 NOT NULL,
	`fees_iqd` integer DEFAULT 0 NOT NULL,
	`received_iqd` integer DEFAULT 0 NOT NULL,
	`variance_iqd` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`statement_file_id` text,
	`notes` text,
	`reconciled_by` text,
	`reconciled_at` integer,
	`journal_entry_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`carrier_id`) REFERENCES `carriers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`statement_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cod_settlements_ref_uq` ON `cod_settlements` (`ref`);--> statement-breakpoint
CREATE INDEX `cod_settlements_carrier_idx` ON `cod_settlements` (`carrier_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `cod_settlements_status_idx` ON `cod_settlements` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `cod_settlements_statement_file_idx` ON `cod_settlements` (`statement_file_id`);--> statement-breakpoint
CREATE TABLE `delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`shipment_id` text NOT NULL,
	`attempt_no` integer NOT NULL,
	`outcome` text NOT NULL,
	`reason` text,
	`notes` text,
	`next_attempt_at` integer,
	`proof_file_id` text,
	`attempted_at` integer NOT NULL,
	`recorded_by` text,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`proof_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_attempts_shipment_no_uq` ON `delivery_attempts` (`shipment_id`,`attempt_no`);--> statement-breakpoint
CREATE INDEX `delivery_attempts_proof_file_idx` ON `delivery_attempts` (`proof_file_id`);--> statement-breakpoint
CREATE TABLE `districts` (
	`id` text PRIMARY KEY NOT NULL,
	`governorate_id` text NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`slug` text,
	FOREIGN KEY (`governorate_id`) REFERENCES `governorates`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `districts_governorate_idx` ON `districts` (`governorate_id`,`sort`);--> statement-breakpoint
CREATE UNIQUE INDEX `districts_governorate_slug_uq` ON `districts` (`governorate_id`,`slug`);--> statement-breakpoint
CREATE TABLE `governorates` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`eta_days_min` integer,
	`eta_days_max` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `governorates_slug_uq` ON `governorates` (`slug`);--> statement-breakpoint
CREATE INDEX `governorates_sort_idx` ON `governorates` (`sort`);--> statement-breakpoint
CREATE TABLE `shipment_events` (
	`id` text PRIMARY KEY NOT NULL,
	`shipment_id` text NOT NULL,
	`kind` text NOT NULL,
	`note` text,
	`data` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shipment_events_shipment_idx` ON `shipment_events` (`shipment_id`,`at`);--> statement-breakpoint
CREATE TABLE `shipment_items` (
	`shipment_id` text NOT NULL,
	`order_item_id` text NOT NULL,
	`qty` integer NOT NULL,
	`picked_by` text,
	`picked_at` integer,
	`verified_at` integer,
	PRIMARY KEY(`shipment_id`, `order_item_id`),
	FOREIGN KEY (`shipment_id`) REFERENCES `shipments`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shipment_items_qty_check" CHECK("shipment_items"."qty" > 0)
);
--> statement-breakpoint
CREATE INDEX `shipment_items_order_item_idx` ON `shipment_items` (`order_item_id`);--> statement-breakpoint
CREATE TABLE `shipments` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`carrier_id` text,
	`tracking_no` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`cod_amount_iqd` integer DEFAULT 0 NOT NULL,
	`cod_settled_at` integer,
	`packed_by` text,
	`proof_file_id` text,
	`shipped_at` integer,
	`delivered_at` integer,
	`packing_file_id` text,
	`received_by_name` text,
	`cost_iqd` integer,
	`location_id` text,
	`failure_reason` text,
	`returned_at` integer,
	`label_printed_at` integer,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`carrier_id`) REFERENCES `carriers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proof_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`packing_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shipments_cod_check" CHECK("shipments"."cod_amount_iqd" >= 0)
);
--> statement-breakpoint
CREATE INDEX `shipments_order_idx` ON `shipments` (`order_id`);--> statement-breakpoint
CREATE INDEX `shipments_carrier_idx` ON `shipments` (`carrier_id`,`status`);--> statement-breakpoint
CREATE INDEX `shipments_tracking_idx` ON `shipments` (`tracking_no`);--> statement-breakpoint
CREATE INDEX `shipments_status_idx` ON `shipments` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `shipments_cod_idx` ON `shipments` (`cod_settled_at`,`status`);--> statement-breakpoint
CREATE INDEX `shipments_proof_file_idx` ON `shipments` (`proof_file_id`);--> statement-breakpoint
CREATE INDEX `shipments_packing_file_idx` ON `shipments` (`packing_file_id`);--> statement-breakpoint
CREATE INDEX `shipments_location_idx` ON `shipments` (`location_id`);--> statement-breakpoint
CREATE TABLE `shipping_rates` (
	`id` text PRIMARY KEY NOT NULL,
	`governorate_id` text,
	`fee_iqd` integer NOT NULL,
	`is_override` integer DEFAULT false NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`district_id` text,
	`note` text,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`governorate_id`) REFERENCES `governorates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`district_id`) REFERENCES `districts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shipping_rates_fee_check" CHECK("shipping_rates"."fee_iqd" >= 0)
);
--> statement-breakpoint
CREATE INDEX `shipping_rates_governorate_idx` ON `shipping_rates` (`governorate_id`,`is_active`);--> statement-breakpoint
CREATE INDEX `shipping_rates_district_idx` ON `shipping_rates` (`district_id`);--> statement-breakpoint
CREATE TABLE `inspection_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`device_kind` text NOT NULL,
	`items` text NOT NULL,
	`name` text,
	`version` integer DEFAULT 1 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`updated_by` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inspection_templates_kind_version_uq` ON `inspection_templates` (`device_kind`,`version`);--> statement-breakpoint
CREATE TABLE `trade_in_events` (
	`id` text PRIMARY KEY NOT NULL,
	`trade_in_id` text NOT NULL,
	`kind` text NOT NULL,
	`data` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`trade_in_id`) REFERENCES `trade_ins`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `trade_in_events_trade_in_idx` ON `trade_in_events` (`trade_in_id`,`at`);--> statement-breakpoint
CREATE TABLE `trade_in_price_guides` (
	`id` text PRIMARY KEY NOT NULL,
	`device_model_id` text NOT NULL,
	`variant_id` text,
	`base_iqd` integer NOT NULL,
	`grade_multipliers` text,
	`updated_by` text,
	`updated_at` integer NOT NULL,
	`deductions` text,
	`is_active` integer DEFAULT true NOT NULL,
	FOREIGN KEY (`device_model_id`) REFERENCES `device_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "trade_in_price_guides_base_check" CHECK("trade_in_price_guides"."base_iqd" >= 0)
);
--> statement-breakpoint
CREATE INDEX `trade_in_price_guides_model_idx` ON `trade_in_price_guides` (`device_model_id`,`variant_id`);--> statement-breakpoint
CREATE INDEX `trade_in_price_guides_variant_idx` ON `trade_in_price_guides` (`variant_id`);--> statement-breakpoint
CREATE TABLE `trade_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`customer_id` text,
	`phone_e164` text NOT NULL,
	`device_model_id` text,
	`variant_id` text,
	`answers` text,
	`estimate_min_iqd` integer,
	`estimate_max_iqd` integer,
	`estimate_expires_at` integer,
	`status` text DEFAULT 'submitted' NOT NULL,
	`final_offer_iqd` integer,
	`offered_by` text,
	`offered_at` integer,
	`offer_expires_at` integer,
	`payout_method` text,
	`serial_id` text,
	`ownership_ok` integer,
	`account_lock_ok` integer,
	`data_wiped` integer,
	`inspection` text,
	`access_token_hash` text,
	`created_at` integer NOT NULL,
	`contact_name` text,
	`device_text` text,
	`locale` text,
	`inspection_scheduled_at` integer,
	`accepted_at` integer,
	`declined_at` integer,
	`decline_reason` text,
	`paid_at` integer,
	`payout_ref` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_model_id`) REFERENCES `device_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`serial_id`) REFERENCES `serials`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "trade_ins_amounts_check" CHECK(("trade_ins"."estimate_min_iqd" IS NULL OR "trade_ins"."estimate_min_iqd" >= 0) AND ("trade_ins"."estimate_max_iqd" IS NULL OR "trade_ins"."estimate_max_iqd" >= coalesce("trade_ins"."estimate_min_iqd", 0)) AND ("trade_ins"."final_offer_iqd" IS NULL OR "trade_ins"."final_offer_iqd" >= 0))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trade_ins_ref_uq` ON `trade_ins` (`ref`);--> statement-breakpoint
CREATE INDEX `trade_ins_customer_idx` ON `trade_ins` (`customer_id`);--> statement-breakpoint
CREATE INDEX `trade_ins_phone_idx` ON `trade_ins` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `trade_ins_device_model_idx` ON `trade_ins` (`device_model_id`);--> statement-breakpoint
CREATE INDEX `trade_ins_variant_idx` ON `trade_ins` (`variant_id`);--> statement-breakpoint
CREATE INDEX `trade_ins_serial_idx` ON `trade_ins` (`serial_id`);--> statement-breakpoint
CREATE INDEX `trade_ins_status_idx` ON `trade_ins` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `used_units` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`variant_id` text NOT NULL,
	`serial_id` text,
	`grade` text NOT NULL,
	`battery_health_pct` integer,
	`cosmetic_notes` text,
	`defects` text,
	`included` text,
	`checklist` text,
	`price_iqd` integer NOT NULL,
	`acquisition_cost_iqd` integer,
	`warranty_days` integer DEFAULT 0 NOT NULL,
	`location_id` text,
	`status` text DEFAULT 'intake' NOT NULL,
	`ownership_checked_at` integer,
	`data_wiped_at` integer,
	`listed_at` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`source` text DEFAULT 'trade_in' NOT NULL,
	`trade_in_id` text,
	`ownership_checked_by` text,
	`data_wiped_by` text,
	`sold_order_item_id` text,
	`sold_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`serial_id`) REFERENCES `serials`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`trade_in_id`) REFERENCES `trade_ins`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sold_order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "used_units_price_check" CHECK("used_units"."price_iqd" >= 0 AND "used_units"."warranty_days" >= 0),
	CONSTRAINT "used_units_battery_check" CHECK("used_units"."battery_health_pct" IS NULL OR "used_units"."battery_health_pct" BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `used_units_slug_uq` ON `used_units` (`slug`);--> statement-breakpoint
CREATE INDEX `used_units_variant_idx` ON `used_units` (`variant_id`,`status`);--> statement-breakpoint
CREATE INDEX `used_units_serial_idx` ON `used_units` (`serial_id`);--> statement-breakpoint
CREATE INDEX `used_units_status_idx` ON `used_units` (`status`,`listed_at`);--> statement-breakpoint
CREATE INDEX `used_units_location_idx` ON `used_units` (`location_id`);--> statement-breakpoint
CREATE INDEX `used_units_trade_in_idx` ON `used_units` (`trade_in_id`);--> statement-breakpoint
CREATE INDEX `used_units_sold_item_idx` ON `used_units` (`sold_order_item_id`);--> statement-breakpoint
CREATE TABLE `assistant_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`role` text NOT NULL,
	`content` text NOT NULL,
	`attachments` text,
	`sources` text,
	`confidence` text,
	`safety_flags` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `assistant_sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `assistant_messages_session_idx` ON `assistant_messages` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `assistant_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text DEFAULT 'maintenance' NOT NULL,
	`customer_id` text,
	`session_hash` text,
	`employee_id` text,
	`device_model_id` text,
	`symptom_key` text,
	`status` text DEFAULT 'active' NOT NULL,
	`summary` text,
	`log_consent` integer DEFAULT false NOT NULL,
	`locale` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`device_model_id`) REFERENCES `device_models`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assistant_sessions_customer_idx` ON `assistant_sessions` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `assistant_sessions_session_idx` ON `assistant_sessions` (`session_hash`);--> statement-breakpoint
CREATE INDEX `assistant_sessions_employee_idx` ON `assistant_sessions` (`employee_id`);--> statement-breakpoint
CREATE INDEX `assistant_sessions_device_idx` ON `assistant_sessions` (`device_model_id`);--> statement-breakpoint
CREATE INDEX `assistant_sessions_status_idx` ON `assistant_sessions` (`status`,`updated_at`);--> statement-breakpoint
CREATE INDEX `assistant_sessions_expires_idx` ON `assistant_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `canned_replies` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`category` text,
	`variables` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `canned_replies_key_uq` ON `canned_replies` (`key`);--> statement-breakpoint
CREATE TABLE `knowledge_articles` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`device_model_id` text,
	`platform_id` text,
	`tags` text,
	`audience` text DEFAULT 'public' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`updated_at` integer NOT NULL,
	`summary` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_model_id`) REFERENCES `device_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_articles_slug_uq` ON `knowledge_articles` (`slug`);--> statement-breakpoint
CREATE INDEX `knowledge_articles_device_idx` ON `knowledge_articles` (`device_model_id`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_articles_platform_idx` ON `knowledge_articles` (`platform_id`,`status`);--> statement-breakpoint
CREATE INDEX `knowledge_articles_kind_idx` ON `knowledge_articles` (`kind`,`audience`,`status`);--> statement-breakpoint
CREATE TABLE `sla_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`priority` text NOT NULL,
	`category` text,
	`first_response_minutes` integer NOT NULL,
	`resolution_minutes` integer NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sla_policies_priority_idx` ON `sla_policies` (`priority`,`category`);--> statement-breakpoint
CREATE TABLE `support_tickets` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`customer_id` text,
	`contact_name` text,
	`phone_e164` text,
	`email` text,
	`channel` text DEFAULT 'web' NOT NULL,
	`subject` text NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assigned_to` text,
	`team` text,
	`order_id` text,
	`product_id` text,
	`warranty_id` text,
	`repair_ticket_id` text,
	`return_id` text,
	`assistant_session_id` text,
	`first_response_due_at` integer,
	`resolution_due_at` integer,
	`first_responded_at` integer,
	`resolved_at` integer,
	`closed_at` integer,
	`escalated_at` integer,
	`escalated_to` text,
	`escalation_reason` text,
	`csat_rating` integer,
	`csat_comment` text,
	`tags` text,
	`ai_summary` text,
	`locale` text,
	`access_token_hash` text,
	`last_message_at` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`customer_id`) REFERENCES `customers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `products`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`warranty_id`) REFERENCES `warranties`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`repair_ticket_id`) REFERENCES `repair_tickets`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`return_id`) REFERENCES `returns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assistant_session_id`) REFERENCES `assistant_sessions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "support_tickets_csat_check" CHECK("support_tickets"."csat_rating" IS NULL OR "support_tickets"."csat_rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_tickets_ref_uq` ON `support_tickets` (`ref`);--> statement-breakpoint
CREATE INDEX `support_tickets_customer_idx` ON `support_tickets` (`customer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `support_tickets_phone_idx` ON `support_tickets` (`phone_e164`);--> statement-breakpoint
CREATE INDEX `support_tickets_status_idx` ON `support_tickets` (`status`,`priority`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `support_tickets_assigned_idx` ON `support_tickets` (`assigned_to`,`status`);--> statement-breakpoint
CREATE INDEX `support_tickets_order_idx` ON `support_tickets` (`order_id`);--> statement-breakpoint
CREATE INDEX `support_tickets_product_idx` ON `support_tickets` (`product_id`);--> statement-breakpoint
CREATE INDEX `support_tickets_warranty_idx` ON `support_tickets` (`warranty_id`);--> statement-breakpoint
CREATE INDEX `support_tickets_repair_idx` ON `support_tickets` (`repair_ticket_id`);--> statement-breakpoint
CREATE INDEX `support_tickets_return_idx` ON `support_tickets` (`return_id`);--> statement-breakpoint
CREATE INDEX `support_tickets_assistant_idx` ON `support_tickets` (`assistant_session_id`);--> statement-breakpoint
CREATE INDEX `support_tickets_sla_idx` ON `support_tickets` (`status`,`resolution_due_at`);--> statement-breakpoint
CREATE INDEX `support_tickets_created_at_idx` ON `support_tickets` (`created_at`);--> statement-breakpoint
CREATE TABLE `ticket_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`ticket_id` text NOT NULL,
	`author_kind` text NOT NULL,
	`author_id` text,
	`body` text NOT NULL,
	`attachments` text,
	`is_internal` integer DEFAULT false NOT NULL,
	`outbox_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`ticket_id`) REFERENCES `support_tickets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_messages_ticket_idx` ON `ticket_messages` (`ticket_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `ticket_routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`conditions` text NOT NULL,
	`assign_to` text,
	`team` text,
	`set_priority` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ticket_routing_rules_sort_idx` ON `ticket_routing_rules` (`is_active`,`sort`);--> statement-breakpoint
CREATE TABLE `troubleshooting_trees` (
	`id` text PRIMARY KEY NOT NULL,
	`device_model_id` text,
	`symptom_key` text NOT NULL,
	`title` text NOT NULL,
	`tree` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`approved_by` text,
	`platform_id` text,
	`approved_at` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`device_model_id`) REFERENCES `device_models`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`platform_id`) REFERENCES `platforms`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `troubleshooting_trees_device_idx` ON `troubleshooting_trees` (`device_model_id`,`symptom_key`);--> statement-breakpoint
CREATE INDEX `troubleshooting_trees_platform_idx` ON `troubleshooting_trees` (`platform_id`,`symptom_key`);--> statement-breakpoint
CREATE INDEX `troubleshooting_trees_status_idx` ON `troubleshooting_trees` (`status`);--> statement-breakpoint
CREATE TABLE `landed_cost_allocations` (
	`id` text PRIMARY KEY NOT NULL,
	`landed_cost_id` text NOT NULL,
	`receipt_item_id` text NOT NULL,
	`amount_iqd` integer NOT NULL,
	`per_unit_iqd` integer NOT NULL,
	FOREIGN KEY (`landed_cost_id`) REFERENCES `landed_costs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`receipt_item_id`) REFERENCES `receipt_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "landed_cost_allocations_amount_check" CHECK("landed_cost_allocations"."amount_iqd" >= 0 AND "landed_cost_allocations"."per_unit_iqd" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `landed_cost_allocations_cost_item_uq` ON `landed_cost_allocations` (`landed_cost_id`,`receipt_item_id`);--> statement-breakpoint
CREATE INDEX `landed_cost_allocations_receipt_item_idx` ON `landed_cost_allocations` (`receipt_item_id`);--> statement-breakpoint
CREATE TABLE `landed_costs` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`kind` text NOT NULL,
	`description` text,
	`currency` text DEFAULT 'IQD' NOT NULL,
	`amount_minor` integer NOT NULL,
	`fx_rate_micros` integer,
	`amount_iqd` integer NOT NULL,
	`method` text DEFAULT 'by_value' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`supplier_invoice_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_invoice_id`) REFERENCES `supplier_invoices`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "landed_costs_amount_check" CHECK("landed_costs"."amount_iqd" >= 0)
);
--> statement-breakpoint
CREATE INDEX `landed_costs_receipt_idx` ON `landed_costs` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `landed_costs_invoice_idx` ON `landed_costs` (`supplier_invoice_id`);--> statement-breakpoint
CREATE TABLE `po_items` (
	`id` text PRIMARY KEY NOT NULL,
	`po_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`qty_ordered` integer NOT NULL,
	`qty_received` integer DEFAULT 0 NOT NULL,
	`unit_cost_minor` integer NOT NULL,
	`notes` text,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "po_items_qty_check" CHECK("po_items"."qty_ordered" > 0 AND "po_items"."qty_received" >= 0 AND "po_items"."unit_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `po_items_po_variant_uq` ON `po_items` (`po_id`,`variant_id`);--> statement-breakpoint
CREATE INDEX `po_items_variant_idx` ON `po_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `purchase_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`supplier_id` text NOT NULL,
	`rfq_quote_id` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`fx_rate_micros` integer,
	`fx_date` text,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`shipping_minor` integer DEFAULT 0 NOT NULL,
	`other_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer DEFAULT 0 NOT NULL,
	`total_iqd` integer,
	`location_id` text,
	`expected_at` integer,
	`payment_terms` text,
	`notes` text,
	`approval_id` text,
	`approved_by` text,
	`approved_at` integer,
	`sent_at` integer,
	`cancelled_at` integer,
	`cancel_reason` text,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rfq_quote_id`) REFERENCES `rfq_quotes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "purchase_orders_total_check" CHECK("purchase_orders"."total_minor" = "purchase_orders"."subtotal_minor" + "purchase_orders"."shipping_minor" + "purchase_orders"."other_minor")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `purchase_orders_ref_uq` ON `purchase_orders` (`ref`);--> statement-breakpoint
CREATE INDEX `purchase_orders_supplier_idx` ON `purchase_orders` (`supplier_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchase_orders_status_idx` ON `purchase_orders` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `purchase_orders_rfq_quote_idx` ON `purchase_orders` (`rfq_quote_id`);--> statement-breakpoint
CREATE INDEX `purchase_orders_location_idx` ON `purchase_orders` (`location_id`);--> statement-breakpoint
CREATE TABLE `receipt_items` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`po_item_id` text,
	`variant_id` text NOT NULL,
	`qty_received` integer NOT NULL,
	`qty_accepted` integer DEFAULT 0 NOT NULL,
	`qty_rejected` integer DEFAULT 0 NOT NULL,
	`reject_reason` text,
	`unit_cost_minor` integer,
	`unit_cost_iqd` integer,
	`landed_unit_cost_iqd` integer,
	`serials_scanned` text,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`po_item_id`) REFERENCES `po_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "receipt_items_qty_check" CHECK("receipt_items"."qty_received" >= 0 AND "receipt_items"."qty_accepted" >= 0 AND "receipt_items"."qty_rejected" >= 0 AND "receipt_items"."qty_accepted" + "receipt_items"."qty_rejected" <= "receipt_items"."qty_received")
);
--> statement-breakpoint
CREATE INDEX `receipt_items_receipt_idx` ON `receipt_items` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `receipt_items_po_item_idx` ON `receipt_items` (`po_item_id`);--> statement-breakpoint
CREATE INDEX `receipt_items_variant_idx` ON `receipt_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`po_id` text,
	`supplier_id` text,
	`location_id` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`supplier_doc_no` text,
	`notes` text,
	`received_by` text,
	`received_at` integer,
	`posted_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `receipts_ref_uq` ON `receipts` (`ref`);--> statement-breakpoint
CREATE INDEX `receipts_po_idx` ON `receipts` (`po_id`);--> statement-breakpoint
CREATE INDEX `receipts_supplier_idx` ON `receipts` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `receipts_location_idx` ON `receipts` (`location_id`);--> statement-breakpoint
CREATE INDEX `receipts_status_idx` ON `receipts` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `rfq_items` (
	`id` text PRIMARY KEY NOT NULL,
	`rfq_id` text NOT NULL,
	`variant_id` text NOT NULL,
	`qty` integer NOT NULL,
	`notes` text,
	FOREIGN KEY (`rfq_id`) REFERENCES `rfqs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rfq_items_qty_check" CHECK("rfq_items"."qty" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rfq_items_rfq_variant_uq` ON `rfq_items` (`rfq_id`,`variant_id`);--> statement-breakpoint
CREATE INDEX `rfq_items_variant_idx` ON `rfq_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `rfq_quote_items` (
	`id` text PRIMARY KEY NOT NULL,
	`quote_id` text NOT NULL,
	`rfq_item_id` text NOT NULL,
	`unit_cost_minor` integer NOT NULL,
	`qty_available` integer,
	`lead_time_days` integer,
	`warranty_months` integer,
	FOREIGN KEY (`quote_id`) REFERENCES `rfq_quotes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rfq_item_id`) REFERENCES `rfq_items`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rfq_quote_items_cost_check" CHECK("rfq_quote_items"."unit_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rfq_quote_items_quote_item_uq` ON `rfq_quote_items` (`quote_id`,`rfq_item_id`);--> statement-breakpoint
CREATE INDEX `rfq_quote_items_rfq_item_idx` ON `rfq_quote_items` (`rfq_item_id`);--> statement-breakpoint
CREATE TABLE `rfq_quotes` (
	`id` text PRIMARY KEY NOT NULL,
	`rfq_id` text NOT NULL,
	`supplier_id` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`total_minor` integer,
	`lead_time_days` integer,
	`warranty_months` integer,
	`valid_until` integer,
	`notes` text,
	`file_id` text,
	`status` text DEFAULT 'received' NOT NULL,
	`received_at` integer NOT NULL,
	`created_by` text,
	FOREIGN KEY (`rfq_id`) REFERENCES `rfqs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rfq_quotes_rfq_supplier_uq` ON `rfq_quotes` (`rfq_id`,`supplier_id`);--> statement-breakpoint
CREATE INDEX `rfq_quotes_supplier_idx` ON `rfq_quotes` (`supplier_id`);--> statement-breakpoint
CREATE INDEX `rfq_quotes_file_idx` ON `rfq_quotes` (`file_id`);--> statement-breakpoint
CREATE TABLE `rfqs` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`needed_by` integer,
	`notes` text,
	`awarded_quote_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	FOREIGN KEY (`awarded_quote_id`) REFERENCES `rfq_quotes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rfqs_ref_uq` ON `rfqs` (`ref`);--> statement-breakpoint
CREATE INDEX `rfqs_status_idx` ON `rfqs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `rfqs_awarded_quote_idx` ON `rfqs` (`awarded_quote_id`);--> statement-breakpoint
CREATE TABLE `supplier_claims` (
	`id` text PRIMARY KEY NOT NULL,
	`ref` text NOT NULL,
	`supplier_id` text NOT NULL,
	`po_id` text,
	`receipt_id` text,
	`kind` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`description` text,
	`items` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`amount_minor` integer,
	`amount_iqd` integer,
	`resolution` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_id`) REFERENCES `receipts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_claims_ref_uq` ON `supplier_claims` (`ref`);--> statement-breakpoint
CREATE INDEX `supplier_claims_supplier_idx` ON `supplier_claims` (`supplier_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `supplier_claims_po_idx` ON `supplier_claims` (`po_id`);--> statement-breakpoint
CREATE INDEX `supplier_claims_receipt_idx` ON `supplier_claims` (`receipt_id`);--> statement-breakpoint
CREATE INDEX `supplier_claims_status_idx` ON `supplier_claims` (`status`);--> statement-breakpoint
CREATE TABLE `supplier_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text,
	`phone` text,
	`email` text,
	`is_primary` integer DEFAULT false NOT NULL,
	`notes` text,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `supplier_contacts_supplier_idx` ON `supplier_contacts` (`supplier_id`);--> statement-breakpoint
CREATE TABLE `supplier_invoice_items` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`po_item_id` text,
	`receipt_item_id` text,
	`variant_id` text NOT NULL,
	`qty` integer NOT NULL,
	`unit_cost_minor` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `supplier_invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`po_item_id`) REFERENCES `po_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`receipt_item_id`) REFERENCES `receipt_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`variant_id`) REFERENCES `variants`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "supplier_invoice_items_qty_check" CHECK("supplier_invoice_items"."qty" > 0 AND "supplier_invoice_items"."unit_cost_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `supplier_invoice_items_invoice_idx` ON `supplier_invoice_items` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `supplier_invoice_items_po_item_idx` ON `supplier_invoice_items` (`po_item_id`);--> statement-breakpoint
CREATE INDEX `supplier_invoice_items_receipt_item_idx` ON `supplier_invoice_items` (`receipt_item_id`);--> statement-breakpoint
CREATE INDEX `supplier_invoice_items_variant_idx` ON `supplier_invoice_items` (`variant_id`);--> statement-breakpoint
CREATE TABLE `supplier_invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`supplier_id` text NOT NULL,
	`po_id` text,
	`invoice_no` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`subtotal_minor` integer DEFAULT 0 NOT NULL,
	`shipping_minor` integer DEFAULT 0 NOT NULL,
	`other_minor` integer DEFAULT 0 NOT NULL,
	`total_minor` integer NOT NULL,
	`fx_rate_micros` integer,
	`total_iqd` integer,
	`issued_on` text,
	`due_on` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`discrepancies` text,
	`paid_at` integer,
	`payment_ref` text,
	`file_id` text,
	`journal_entry_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`supplier_id`) REFERENCES `suppliers`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `supplier_invoices_supplier_no_uq` ON `supplier_invoices` (`supplier_id`,`invoice_no`);--> statement-breakpoint
CREATE INDEX `supplier_invoices_po_idx` ON `supplier_invoices` (`po_id`);--> statement-breakpoint
CREATE INDEX `supplier_invoices_status_idx` ON `supplier_invoices` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `supplier_invoices_file_idx` ON `supplier_invoices` (`file_id`);--> statement-breakpoint
CREATE TABLE `suppliers` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`legal_name` text,
	`country` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`payment_terms` text,
	`lead_time_days` integer,
	`phone` text,
	`email` text,
	`address` text,
	`notes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`is_demo` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `suppliers_code_uq` ON `suppliers` (`code`);--> statement-breakpoint
CREATE INDEX `suppliers_status_idx` ON `suppliers` (`status`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`entity_type` text,
	`entity_id` text,
	`requested_by` text NOT NULL,
	`payload` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`reason` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`decision_note` text,
	`required_permission` text,
	`expires_at` integer
);
--> statement-breakpoint
CREATE INDEX `approvals_status_idx` ON `approvals` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `approvals_entity_idx` ON `approvals` (`entity_type`,`entity_id`);--> statement-breakpoint
CREATE INDEX `approvals_requested_by_idx` ON `approvals` (`requested_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `approvals_kind_idx` ON `approvals` (`kind`,`status`);--> statement-breakpoint
CREATE TABLE `attendance` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`shift_id` text,
	`branch_id` text,
	`clock_in_at` integer NOT NULL,
	`clock_out_at` integer,
	`method` text DEFAULT 'self' NOT NULL,
	`note` text,
	`approved_by` text,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`shift_id`) REFERENCES `shifts`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attendance_employee_idx` ON `attendance` (`employee_id`,`clock_in_at`);--> statement-breakpoint
CREATE INDEX `attendance_shift_idx` ON `attendance` (`shift_id`);--> statement-breakpoint
CREATE INDEX `attendance_branch_idx` ON `attendance` (`branch_id`,`clock_in_at`);--> statement-breakpoint
CREATE TABLE `commission_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`basis` text DEFAULT 'sales' NOT NULL,
	`rate_bps` integer NOT NULL,
	`employee_id` text,
	`role_id` text,
	`product_kind` text DEFAULT '*' NOT NULL,
	`category_id` text,
	`channel` text,
	`starts_at` integer,
	`ends_at` integer,
	`is_active` integer DEFAULT true NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`category_id`) REFERENCES `categories`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "commission_rules_rate_check" CHECK("commission_rules"."rate_bps" >= 0 AND "commission_rules"."rate_bps" <= 10000)
);
--> statement-breakpoint
CREATE INDEX `commission_rules_employee_idx` ON `commission_rules` (`employee_id`);--> statement-breakpoint
CREATE INDEX `commission_rules_role_idx` ON `commission_rules` (`role_id`);--> statement-breakpoint
CREATE INDEX `commission_rules_category_idx` ON `commission_rules` (`category_id`);--> statement-breakpoint
CREATE TABLE `commissions` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`order_id` text NOT NULL,
	`order_item_id` text,
	`rule_id` text,
	`kind` text DEFAULT 'earn' NOT NULL,
	`basis` text NOT NULL,
	`base_amount_iqd` integer NOT NULL,
	`rate_bps` integer NOT NULL,
	`amount_iqd` integer NOT NULL,
	`status` text DEFAULT 'accrued' NOT NULL,
	`payroll_run_id` text,
	`period` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rule_id`) REFERENCES `commission_rules`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`payroll_run_id`) REFERENCES `payroll_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `commissions_employee_idx` ON `commissions` (`employee_id`,`period`);--> statement-breakpoint
CREATE INDEX `commissions_order_idx` ON `commissions` (`order_id`);--> statement-breakpoint
CREATE INDEX `commissions_order_item_idx` ON `commissions` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `commissions_rule_idx` ON `commissions` (`rule_id`);--> statement-breakpoint
CREATE INDEX `commissions_payroll_run_idx` ON `commissions` (`payroll_run_id`);--> statement-breakpoint
CREATE INDEX `commissions_status_idx` ON `commissions` (`status`,`period`);--> statement-breakpoint
CREATE TABLE `employee_advances` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`amount_iqd` integer NOT NULL,
	`reason` text,
	`status` text DEFAULT 'open' NOT NULL,
	`given_by` text,
	`given_at` integer NOT NULL,
	`settled_run_id` text,
	`settled_at` integer,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`settled_run_id`) REFERENCES `payroll_runs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "employee_advances_amount_check" CHECK("employee_advances"."amount_iqd" > 0)
);
--> statement-breakpoint
CREATE INDEX `employee_advances_employee_idx` ON `employee_advances` (`employee_id`,`status`);--> statement-breakpoint
CREATE INDEX `employee_advances_run_idx` ON `employee_advances` (`settled_run_id`);--> statement-breakpoint
CREATE TABLE `employee_roles` (
	`employee_id` text NOT NULL,
	`role_id` text NOT NULL,
	`granted_by` text,
	`granted_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`employee_id`, `role_id`),
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `employee_roles_role_idx` ON `employee_roles` (`role_id`);--> statement-breakpoint
CREATE TABLE `employee_sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`mfa_ok` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ip` text,
	`user_agent` text,
	`revoked_at` integer,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `employee_sessions_employee_idx` ON `employee_sessions` (`employee_id`);--> statement-breakpoint
CREATE INDEX `employee_sessions_expires_idx` ON `employee_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `employee_trusted_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`label` text,
	`user_agent` text,
	`ip` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employee_trusted_devices_token_uq` ON `employee_trusted_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `employee_trusted_devices_employee_idx` ON `employee_trusted_devices` (`employee_id`);--> statement-breakpoint
CREATE TABLE `employees` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`name` text NOT NULL,
	`phone` text,
	`password_hash` text,
	`password_iters` integer,
	`totp_secret_enc` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`recovery_codes` text,
	`status` text DEFAULT 'active' NOT NULL,
	`branch_id` text,
	`locale` text DEFAULT 'ar' NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	`job_title` text,
	`last_login_at` integer,
	`password_changed_at` integer,
	`base_salary_iqd` integer,
	`is_demo` integer DEFAULT false NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `employees_email_uq` ON `employees` (`email`);--> statement-breakpoint
CREATE INDEX `employees_status_idx` ON `employees` (`status`);--> statement-breakpoint
CREATE INDEX `employees_branch_idx` ON `employees` (`branch_id`);--> statement-breakpoint
CREATE TABLE `leave_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`kind` text NOT NULL,
	`starts_on` text NOT NULL,
	`ends_on` text NOT NULL,
	`reason` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `leave_requests_employee_idx` ON `leave_requests` (`employee_id`,`starts_on`);--> statement-breakpoint
CREATE INDEX `leave_requests_status_idx` ON `leave_requests` (`status`);--> statement-breakpoint
CREATE TABLE `payroll_items` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`employee_id` text NOT NULL,
	`base_iqd` integer DEFAULT 0 NOT NULL,
	`commission_iqd` integer DEFAULT 0 NOT NULL,
	`bonus_iqd` integer DEFAULT 0 NOT NULL,
	`advance_deduction_iqd` integer DEFAULT 0 NOT NULL,
	`other_deduction_iqd` integer DEFAULT 0 NOT NULL,
	`net_iqd` integer NOT NULL,
	`notes` text,
	FOREIGN KEY (`run_id`) REFERENCES `payroll_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "payroll_items_net_check" CHECK("payroll_items"."net_iqd" = "payroll_items"."base_iqd" + "payroll_items"."commission_iqd" + "payroll_items"."bonus_iqd" - "payroll_items"."advance_deduction_iqd" - "payroll_items"."other_deduction_iqd")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `payroll_items_run_employee_uq` ON `payroll_items` (`run_id`,`employee_id`);--> statement-breakpoint
CREATE INDEX `payroll_items_employee_idx` ON `payroll_items` (`employee_id`);--> statement-breakpoint
CREATE TABLE `payroll_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`period` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`total_gross_iqd` integer DEFAULT 0 NOT NULL,
	`total_net_iqd` integer DEFAULT 0 NOT NULL,
	`notes` text,
	`approved_by` text,
	`approved_at` integer,
	`paid_at` integer,
	`journal_entry_id` text,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `payroll_runs_period_idx` ON `payroll_runs` (`period`,`status`);--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `role_permissions_permission_idx` ON `role_permissions` (`permission`);--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`description` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_key_uq` ON `roles` (`key`);--> statement-breakpoint
CREATE TABLE `saved_views` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`scope` text NOT NULL,
	`name` text NOT NULL,
	`config` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`is_shared` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `saved_views_employee_idx` ON `saved_views` (`employee_id`,`scope`);--> statement-breakpoint
CREATE INDEX `saved_views_shared_idx` ON `saved_views` (`scope`,`is_shared`);--> statement-breakpoint
CREATE TABLE `shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`branch_id` text,
	`starts_at` integer NOT NULL,
	`ends_at` integer NOT NULL,
	`status` text DEFAULT 'scheduled' NOT NULL,
	`note` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shifts_times_check" CHECK("shifts"."ends_at" > "shifts"."starts_at")
);
--> statement-breakpoint
CREATE INDEX `shifts_employee_idx` ON `shifts` (`employee_id`,`starts_at`);--> statement-breakpoint
CREATE INDEX `shifts_branch_idx` ON `shifts` (`branch_id`,`starts_at`);--> statement-breakpoint
CREATE TABLE `staff_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`assigned_to` text,
	`priority` text DEFAULT 'normal' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`due_at` integer,
	`ref_type` text,
	`ref_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
CREATE INDEX `staff_tasks_assigned_idx` ON `staff_tasks` (`assigned_to`,`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `staff_tasks_ref_idx` ON `staff_tasks` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `cash_movements` (
	`id` text PRIMARY KEY NOT NULL,
	`shift_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_iqd` integer NOT NULL,
	`order_id` text,
	`payment_id` text,
	`reason` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`idempotency_key` text,
	`at` integer NOT NULL,
	FOREIGN KEY (`shift_id`) REFERENCES `pos_shifts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`payment_id`) REFERENCES `payments`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cash_movements_amount_check" CHECK("cash_movements"."amount_iqd" <> 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cash_movements_idempotency_key_uq` ON `cash_movements` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `cash_movements_shift_idx` ON `cash_movements` (`shift_id`,`at`);--> statement-breakpoint
CREATE INDEX `cash_movements_order_idx` ON `cash_movements` (`order_id`);--> statement-breakpoint
CREATE INDEX `cash_movements_payment_idx` ON `cash_movements` (`payment_id`);--> statement-breakpoint
CREATE TABLE `pos_registers` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`branch_id` text,
	`location_id` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`branch_id`) REFERENCES `branches`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`location_id`) REFERENCES `inventory_locations`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pos_registers_code_uq` ON `pos_registers` (`code`);--> statement-breakpoint
CREATE INDEX `pos_registers_branch_idx` ON `pos_registers` (`branch_id`);--> statement-breakpoint
CREATE INDEX `pos_registers_location_idx` ON `pos_registers` (`location_id`);--> statement-breakpoint
CREATE TABLE `pos_shifts` (
	`id` text PRIMARY KEY NOT NULL,
	`register_id` text NOT NULL,
	`opened_by` text NOT NULL,
	`opened_at` integer NOT NULL,
	`opening_float_iqd` integer DEFAULT 0 NOT NULL,
	`closed_by` text,
	`closed_at` integer,
	`counted_cash_iqd` integer,
	`expected_cash_iqd` integer,
	`variance_iqd` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`variance_reason` text,
	`denominations` text,
	`notes` text,
	`approved_by` text,
	FOREIGN KEY (`register_id`) REFERENCES `pos_registers`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pos_shifts_float_check" CHECK("pos_shifts"."opening_float_iqd" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pos_shifts_open_register_uq` ON `pos_shifts` (`register_id`) WHERE "pos_shifts"."status" = 'open';--> statement-breakpoint
CREATE INDEX `pos_shifts_register_idx` ON `pos_shifts` (`register_id`,`opened_at`);--> statement-breakpoint
CREATE INDEX `pos_shifts_opened_by_idx` ON `pos_shifts` (`opened_by`,`opened_at`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`key_hash` text NOT NULL,
	`prefix` text NOT NULL,
	`scopes` text NOT NULL,
	`rate_limit_per_min` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	`revoked_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_hash_uq` ON `api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `api_keys_prefix_idx` ON `api_keys` (`prefix`);--> statement-breakpoint
CREATE TABLE `branches` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`governorate_id` text,
	`district_id` text,
	`address_text` text,
	`phone` text,
	`hours` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`governorate_id`) REFERENCES `governorates`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`district_id`) REFERENCES `districts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `branches_code_uq` ON `branches` (`code`);--> statement-breakpoint
CREATE INDEX `branches_governorate_idx` ON `branches` (`governorate_id`);--> statement-breakpoint
CREATE INDEX `branches_district_idx` ON `branches` (`district_id`);--> statement-breakpoint
CREATE TABLE `channels` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`kind` text DEFAULT 'online' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`config` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `channels_key_uq` ON `channels` (`key`);--> statement-breakpoint
CREATE TABLE `export_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`report_key` text NOT NULL,
	`saved_report_id` text,
	`params` text,
	`format` text DEFAULT 'csv' NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`included_protected` integer DEFAULT false NOT NULL,
	`file_id` text,
	`row_count` integer,
	`error` text,
	`requested_by` text,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`saved_report_id`) REFERENCES `saved_reports`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `export_jobs_requested_by_idx` ON `export_jobs` (`requested_by`,`created_at`);--> statement-breakpoint
CREATE INDEX `export_jobs_status_idx` ON `export_jobs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `export_jobs_saved_report_idx` ON `export_jobs` (`saved_report_id`);--> statement-breakpoint
CREATE INDEX `export_jobs_file_idx` ON `export_jobs` (`file_id`);--> statement-breakpoint
CREATE TABLE `import_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`file_id` text,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`total_rows` integer,
	`valid_rows` integer,
	`applied_rows` integer,
	`errors` text,
	`rollback` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`applied_at` integer,
	`rolled_back_at` integer,
	FOREIGN KEY (`file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `import_jobs_kind_idx` ON `import_jobs` (`kind`,`created_at`);--> statement-breakpoint
CREATE INDEX `import_jobs_file_idx` ON `import_jobs` (`file_id`);--> statement-breakpoint
CREATE TABLE `inbound_events` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`event_type` text,
	`payload` text,
	`signature_ok` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`error` text,
	`received_at` integer NOT NULL,
	`processed_at` integer
);
--> statement-breakpoint
CREATE INDEX `inbound_events_provider_idx` ON `inbound_events` (`provider`,`received_at`);--> statement-breakpoint
CREATE INDEX `inbound_events_status_idx` ON `inbound_events` (`status`,`received_at`);--> statement-breakpoint
CREATE TABLE `integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`provider` text NOT NULL,
	`name` text NOT NULL,
	`status` text DEFAULT 'disabled' NOT NULL,
	`config` text,
	`secret_enc` text,
	`last_ok_at` integer,
	`last_error` text,
	`last_error_at` integer,
	`updated_by` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integrations_provider_uq` ON `integrations` (`kind`,`provider`);--> statement-breakpoint
CREATE TABLE `saved_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`report_key` text NOT NULL,
	`name` text NOT NULL,
	`params` text,
	`schedule` text,
	`recipients` text,
	`format` text DEFAULT 'csv' NOT NULL,
	`owner_id` text,
	`is_shared` integer DEFAULT false NOT NULL,
	`last_run_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `saved_reports_owner_idx` ON `saved_reports` (`owner_id`);--> statement-breakpoint
CREATE INDEX `saved_reports_key_idx` ON `saved_reports` (`report_key`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`webhook_id` text NOT NULL,
	`event` text NOT NULL,
	`event_id` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`response_status` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`webhook_id`) REFERENCES `webhooks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_deliveries_event_uq` ON `webhook_deliveries` (`webhook_id`,`event_id`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `webhook_deliveries_created_at_idx` ON `webhook_deliveries` (`created_at`);--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`secret_enc` text NOT NULL,
	`events` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`failure_count` integer DEFAULT 0 NOT NULL,
	`last_success_at` integer,
	`last_failure_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `webhooks_active_idx` ON `webhooks` (`is_active`);--> statement-breakpoint
CREATE TABLE `workflow_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`ref_type` text,
	`ref_id` text,
	`event` text,
	`is_dry_run` integer DEFAULT false NOT NULL,
	`status` text NOT NULL,
	`actions_log` text,
	`error` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `workflow_runs_workflow_idx` ON `workflow_runs` (`workflow_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `workflow_runs_ref_idx` ON `workflow_runs` (`ref_type`,`ref_id`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`trigger_event` text NOT NULL,
	`conditions` text,
	`actions` text NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`requires_approval` integer DEFAULT false NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_run_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `workflows_trigger_idx` ON `workflows` (`trigger_event`,`status`);