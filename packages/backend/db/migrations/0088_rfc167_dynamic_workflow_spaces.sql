-- RFC-167 — dynamic workflow spaces (动态 Workflow 空间), PR-1 migration
-- (hand-written; additive; registered in meta/_journal.json).
--
-- One new table: `dynamic_workflow_spaces` (SEVENTH ACL resource — a pinned
-- pool of agent names that a built-in orchestrator composes into a workflow
-- DAG, a human confirms, then the ordinary engine executes).
-- resource_grants.resource_type gains 'dynamic_workflow_space' at the app layer
-- only (the column has no CHECK constraint — drizzle text enums are type-level,
-- same as the other six resource tables).
--
-- Purely additive: no backfill, no existing-table changes. The tasks link
-- columns (dwspace_id + dwspace_config_json) + the builtin host workflow seed
-- land with the engine PR (PR-2 migration B). See
-- design/RFC-167-dynamic-workflow-space/design.md §1.1.
CREATE TABLE IF NOT EXISTS `dynamic_workflow_spaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`agent_pool_json` text DEFAULT '[]' NOT NULL,
	`owner_user_id` text,
	`visibility` text DEFAULT 'public' NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `dynamic_workflow_spaces_name_unique` ON `dynamic_workflow_spaces` (`name`);
