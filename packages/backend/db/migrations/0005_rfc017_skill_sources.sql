CREATE TABLE `skill_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`label` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_scanned_at` integer,
	`last_scan_error` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skill_sources_path_unique` ON `skill_sources` (`path`);--> statement-breakpoint
ALTER TABLE `skills` ADD `source_id` text REFERENCES skill_sources(id);--> statement-breakpoint
CREATE INDEX `skills_source_id_idx` ON `skills` (`source_id`);