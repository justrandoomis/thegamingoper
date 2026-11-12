CREATE TABLE `incident_links` (
	`incident_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`incident_id`, `kind`, `target_id`),
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "incident_links_kind_check" CHECK("incident_links"."kind" IN ('finding', 'run', 'error'))
);
--> statement-breakpoint
CREATE INDEX `incident_links_target_idx` ON `incident_links` (`kind`,`target_id`);--> statement-breakpoint
CREATE TABLE `employee_password_links` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`employee_id` text NOT NULL,
	`purpose` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`employee_id`) REFERENCES `employees`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `employee_password_links_employee_idx` ON `employee_password_links` (`employee_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `employee_password_links_expires_idx` ON `employee_password_links` (`expires_at`);--> statement-breakpoint
ALTER TABLE `consistency_findings` ADD `assigned_to` text;--> statement-breakpoint
ALTER TABLE `consistency_findings` ADD `incident_id` text REFERENCES incidents(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `consistency_findings_assigned_idx` ON `consistency_findings` (`assigned_to`,`status`);--> statement-breakpoint
CREATE INDEX `consistency_findings_incident_idx` ON `consistency_findings` (`incident_id`);--> statement-breakpoint
ALTER TABLE `error_reports` ADD `is_demo` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `perf_rollups` ADD `is_demo` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `roles` ADD `requires_mfa` integer DEFAULT false NOT NULL;--> statement-breakpoint
-- Hand-written below (drizzle/README.md): the three system accounts of the chart (seed/reference.ts CHART_OF_ACCOUNTS)
-- for a database whose chart was seeded before this migration. A database without a chart yet (a new production
-- database before /admin/setup, a test database before seedReference) gets nothing here: seedReference installs the
-- whole chart, these included. An account already holding the key (or the id) is left alone; when an accountant has
-- already used the code, the account takes the code SYS-<key> instead, so the migration never fails on a renumbered
-- chart and the system key always exists afterwards (services find accounts by key, never by code).
INSERT INTO `accounts` (`id`, `code`, `name`, `type`, `system_key`, `is_contra`, `parent_id`, `description`, `is_system`, `is_active`)
SELECT 'acc_employee_advances', CASE WHEN EXISTS (SELECT 1 FROM `accounts` WHERE `code` = '1300') THEN 'SYS-employee_advances' ELSE '1300' END,
	'{"ar":"سلف الموظفين","en":"Employee advances","ckb":"پێشینەی کارمەندان"}', 'asset', 'employee_advances', 0, NULL, NULL, 1, 1
WHERE EXISTS (SELECT 1 FROM `accounts` WHERE `system_key` = 'cash')
	AND NOT EXISTS (SELECT 1 FROM `accounts` WHERE `system_key` = 'employee_advances' OR `id` = 'acc_employee_advances');--> statement-breakpoint
INSERT INTO `accounts` (`id`, `code`, `name`, `type`, `system_key`, `is_contra`, `parent_id`, `description`, `is_system`, `is_active`)
SELECT 'acc_gift_card_liability', CASE WHEN EXISTS (SELECT 1 FROM `accounts` WHERE `code` = '2150') THEN 'SYS-gift_card_liability' ELSE '2150' END,
	'{"ar":"بطاقات هدايا لم تُستخدم بعد","en":"Gift cards outstanding","ckb":"کارتی دیاری کە هێشتا بەکارنەهاتوون"}', 'liability', 'gift_card_liability', 0, NULL, NULL, 1, 1
WHERE EXISTS (SELECT 1 FROM `accounts` WHERE `system_key` = 'cash')
	AND NOT EXISTS (SELECT 1 FROM `accounts` WHERE `system_key` = 'gift_card_liability' OR `id` = 'acc_gift_card_liability');--> statement-breakpoint
INSERT INTO `accounts` (`id`, `code`, `name`, `type`, `system_key`, `is_contra`, `parent_id`, `description`, `is_system`, `is_active`)
SELECT 'acc_salaries_payable', CASE WHEN EXISTS (SELECT 1 FROM `accounts` WHERE `code` = '2200') THEN 'SYS-salaries_payable' ELSE '2200' END,
	'{"ar":"رواتب مستحقة الدفع","en":"Salaries payable","ckb":"مووچەی شایستەی پێدان"}', 'liability', 'salaries_payable', 0, NULL, NULL, 1, 1
WHERE EXISTS (SELECT 1 FROM `accounts` WHERE `system_key` = 'cash')
	AND NOT EXISTS (SELECT 1 FROM `accounts` WHERE `system_key` = 'salaries_payable' OR `id` = 'acc_salaries_payable');
