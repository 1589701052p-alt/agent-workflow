-- RFC-099 — resource-level ownership ACL (B1: additive only).
--
--   * agents / skills / mcps / plugins / workflows each gain:
--       - owner_user_id (nullable TEXT; FK enforced at the app layer so the
--         '__system__' sentinel and pre-multi-user DBs stay valid)
--       - visibility 'private'|'public' (TEXT, app-layer enum; DEFAULT
--         'public' per D18 — new resources are team-visible until the owner
--         tightens them)
--   * Backfill (D2): owner = earliest-created human admin, falling back to
--     '__system__' on pure daemon-token databases. Existing rows keep
--     visibility='public' (the column default), so post-upgrade behavior is
--     byte-for-byte what it was before this RFC: everyone sees everything.
--   * resource_grants — one generic grant table for all five resource types
--     instead of five twin tables. PK (resource_type, resource_id, user_id).
--   * skill_sources.created_by — imported external skills inherit the
--     source's creator as owner (D11).
--   * Attribution columns (D7/D8): review_comments.author_role,
--     doc_versions.decided_by_role, clarify_rounds.{submitted_by_role,
--     answer_attributions_json, draft_answers_json}. All nullable; historic
--     rows render as "local user (history)". These columns are NEVER read by
--     prompt builders (renderCommentsForPrompt / buildPromptContext) — locked
--     by rfc099 prompt-isolation tests.
--
-- The destructive half of RFC-099 (collapsing task_collaborators roles and
-- DROP TABLE node_assignments) ships in migration 0046 together with the code
-- that stops referencing them, so each commit batch compiles green.
ALTER TABLE `agents` ADD COLUMN `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `agents` ADD COLUMN `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `skills` ADD COLUMN `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `skills` ADD COLUMN `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `mcps` ADD COLUMN `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `mcps` ADD COLUMN `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `plugins` ADD COLUMN `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `plugins` ADD COLUMN `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE `workflows` ADD COLUMN `owner_user_id` text;--> statement-breakpoint
ALTER TABLE `workflows` ADD COLUMN `visibility` text DEFAULT 'public' NOT NULL;--> statement-breakpoint
UPDATE `agents` SET `owner_user_id` = COALESCE((SELECT `id` FROM `users` WHERE `role` = 'admin' AND `id` != '__system__' ORDER BY `created_at` ASC LIMIT 1), '__system__') WHERE `owner_user_id` IS NULL;--> statement-breakpoint
UPDATE `skills` SET `owner_user_id` = COALESCE((SELECT `id` FROM `users` WHERE `role` = 'admin' AND `id` != '__system__' ORDER BY `created_at` ASC LIMIT 1), '__system__') WHERE `owner_user_id` IS NULL;--> statement-breakpoint
UPDATE `mcps` SET `owner_user_id` = COALESCE((SELECT `id` FROM `users` WHERE `role` = 'admin' AND `id` != '__system__' ORDER BY `created_at` ASC LIMIT 1), '__system__') WHERE `owner_user_id` IS NULL;--> statement-breakpoint
UPDATE `plugins` SET `owner_user_id` = COALESCE((SELECT `id` FROM `users` WHERE `role` = 'admin' AND `id` != '__system__' ORDER BY `created_at` ASC LIMIT 1), '__system__') WHERE `owner_user_id` IS NULL;--> statement-breakpoint
UPDATE `workflows` SET `owner_user_id` = COALESCE((SELECT `id` FROM `users` WHERE `role` = 'admin' AND `id` != '__system__' ORDER BY `created_at` ASC LIMIT 1), '__system__') WHERE `owner_user_id` IS NULL;--> statement-breakpoint
CREATE TABLE `resource_grants` (
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`user_id` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`resource_type`, `resource_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE INDEX `idx_resource_grants_user` ON `resource_grants` (`user_id`);--> statement-breakpoint
ALTER TABLE `skill_sources` ADD COLUMN `created_by` text;--> statement-breakpoint
UPDATE `skill_sources` SET `created_by` = COALESCE((SELECT `id` FROM `users` WHERE `role` = 'admin' AND `id` != '__system__' ORDER BY `created_at` ASC LIMIT 1), '__system__') WHERE `created_by` IS NULL;--> statement-breakpoint
ALTER TABLE `review_comments` ADD COLUMN `author_role` text;--> statement-breakpoint
ALTER TABLE `doc_versions` ADD COLUMN `decided_by_role` text;--> statement-breakpoint
ALTER TABLE `clarify_rounds` ADD COLUMN `submitted_by_role` text;--> statement-breakpoint
ALTER TABLE `clarify_rounds` ADD COLUMN `answer_attributions_json` text;--> statement-breakpoint
ALTER TABLE `clarify_rounds` ADD COLUMN `draft_answers_json` text;
