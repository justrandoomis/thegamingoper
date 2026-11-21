CREATE TABLE `switch_library_entries` (
	`game_id` text PRIMARY KEY NOT NULL,
	`size_bytes` integer,
	`cartridge_bytes` integer,
	`size_as_of` text,
	`price_usd_cents` integer,
	`price_as_of` text,
	`trailer_youtube_id` text,
	`image_file_id` text,
	`description` text,
	`metacritic_score` integer,
	`metacritic_reviews` integer,
	`metacritic_as_of` text,
	`is_hidden` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`image_file_id`) REFERENCES `files`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "switch_library_entries_size_ck" CHECK("switch_library_entries"."size_bytes" IS NULL OR "switch_library_entries"."size_bytes" > 0),
	CONSTRAINT "switch_library_entries_cartridge_ck" CHECK("switch_library_entries"."cartridge_bytes" IS NULL OR "switch_library_entries"."cartridge_bytes" >= 0),
	CONSTRAINT "switch_library_entries_price_ck" CHECK("switch_library_entries"."price_usd_cents" IS NULL OR "switch_library_entries"."price_usd_cents" >= 0),
	CONSTRAINT "switch_library_entries_score_ck" CHECK("switch_library_entries"."metacritic_score" IS NULL OR ("switch_library_entries"."metacritic_score" BETWEEN 0 AND 100)),
	CONSTRAINT "switch_library_entries_reviews_ck" CHECK("switch_library_entries"."metacritic_reviews" IS NULL OR "switch_library_entries"."metacritic_reviews" >= 0)
);
--> statement-breakpoint
CREATE INDEX `switch_library_entries_updated_idx` ON `switch_library_entries` (`updated_at`);--> statement-breakpoint
CREATE INDEX `switch_library_entries_image_idx` ON `switch_library_entries` (`image_file_id`);