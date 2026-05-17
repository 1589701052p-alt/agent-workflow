CREATE TABLE `cached_repos` (
	`id` text PRIMARY KEY NOT NULL,
	`url_hash` text NOT NULL,
	`url` text NOT NULL,
	`local_path` text NOT NULL,
	`default_branch` text,
	`last_fetched_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cached_repos_url_hash_unique` ON `cached_repos` (`url_hash`);--> statement-breakpoint
CREATE INDEX `idx_cached_repos_last_fetched` ON `cached_repos` (`last_fetched_at`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `repo_url` text;