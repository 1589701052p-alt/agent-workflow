-- RFC-115 PR-E — drop the dead doc_versions.agent_snapshot column.
--
-- agent_snapshot (JSON {model,variant,temperature}) was reserved on the review
-- doc_version row but NEVER populated: review.ts always writes `?? null` and no
-- caller passes a non-null value, so every row's value is NULL. RFC-115 removes
-- the per-agent generation params entirely; this last reference is dead. Because
-- the column is provably always NULL there is NO data to lose — unlike the
-- agents params (0057) this rebuild needs NO pre-drop guard.
--
-- SQLite has no in-place DROP COLUMN in bun:sqlite's bundled runtime, so we use
-- the standard 12-step rebuild (cf. 0041 / 0057). The new table mirrors
-- doc_versions MINUS agent_snapshot; both FKs (task_id→tasks, review_node_run_id
-- →node_runs, ON DELETE cascade) and all three indexes (review_run / task /
-- review_item) are recreated. Column list is explicit on both sides of the copy.
-- The platform is pre-prod; hard-cut is safe.
--
-- See design/RFC-115-node-policy-global-cleanup/design.md §4.2.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_doc_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`review_node_id` text NOT NULL,
	`review_node_run_id` text NOT NULL,
	`source_node_id` text NOT NULL,
	`source_port_name` text NOT NULL,
	`version_index` integer NOT NULL,
	`review_iteration` integer NOT NULL,
	`body_path` text NOT NULL,
	`comments_json` text DEFAULT '[]' NOT NULL,
	`decision` text DEFAULT 'pending' NOT NULL,
	`decision_reason` text,
	`prompt_snapshot` text,
	`source_file_path` text,
	`item_index` integer,
	`selection` text,
	`item_path` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`decided_by_role` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_doc_versions` (
	`id`, `task_id`, `review_node_id`, `review_node_run_id`, `source_node_id`,
	`source_port_name`, `version_index`, `review_iteration`, `body_path`,
	`comments_json`, `decision`, `decision_reason`, `prompt_snapshot`,
	`source_file_path`, `item_index`, `selection`, `item_path`, `created_at`,
	`decided_at`, `decided_by`, `decided_by_role`
)
SELECT
	`id`, `task_id`, `review_node_id`, `review_node_run_id`, `source_node_id`,
	`source_port_name`, `version_index`, `review_iteration`, `body_path`,
	`comments_json`, `decision`, `decision_reason`, `prompt_snapshot`,
	`source_file_path`, `item_index`, `selection`, `item_path`, `created_at`,
	`decided_at`, `decided_by`, `decided_by_role`
FROM `doc_versions`;--> statement-breakpoint
DROP TABLE `doc_versions`;--> statement-breakpoint
ALTER TABLE `__new_doc_versions` RENAME TO `doc_versions`;--> statement-breakpoint
CREATE INDEX `idx_doc_versions_review_run` ON `doc_versions` (`review_node_run_id`, `version_index`);--> statement-breakpoint
CREATE INDEX `idx_doc_versions_task` ON `doc_versions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_doc_versions_review_item` ON `doc_versions` (`review_node_run_id`, `item_index`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
