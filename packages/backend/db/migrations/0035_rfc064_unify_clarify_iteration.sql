-- RFC-064 — Unified Clarify Runtime. Merge `node_runs.cross_clarify_iteration`
-- into `clarify_iteration` (taking max per row) and DROP the cross column,
-- so the runtime has one counter for self + cross clarify rounds.
--
-- After RFC-058 unified the underlying `clarify_rounds` table and RFC-059
-- added per-question scope, two iteration counters remained on `node_runs`
-- (one per kind). 10 dated patches in 10 days kept fixing the same root
-- cause: any new codepath that touched only the clarify column missed its
-- mirror in the cross column (or vice versa), causing freshness / cutoff /
-- cascade / mint / dispatch / prompt-render gate drift. The fix is to
-- collapse the two counters into one — `kind` on `clarify_rounds` is the
-- only "self vs cross" discriminator the runtime needs.
--
-- Step 1: max-merge the two columns in place. SQLite `MAX(a, b)` returns the
-- larger of two scalar values inline (it is also valid as a scalar function
-- since SQLite 3.7.16). Only rows where the cross column actually exceeds
-- the self column need updating; the rest are no-ops.
--
-- Step 2: SQLite has no `DROP COLUMN` for pre-3.35 schemas in `bun:sqlite`'s
-- bundled runtime, so we rebuild the table with the column removed. The
-- order of operations is the standard SQLite rebuild pattern:
--   - disable foreign keys (so child tables don't fire cascade rules during
--     the swap),
--   - create the new table with the same shape minus `cross_clarify_iteration`,
--   - copy every row (column list explicit so we never accidentally
--     re-introduce the dropped column),
--   - drop the old table and rename the new one,
--   - re-create the two indices that the original schema defines,
--   - re-enable foreign keys.
--
-- See design/RFC-064-unified-clarify-runtime/design.md §6 for the rationale.
-- The platform is pre-prod (no live user data); hard-cut migration is safe.
UPDATE `node_runs`
SET `clarify_iteration` = MAX(`clarify_iteration`, `cross_clarify_iteration`)
WHERE `cross_clarify_iteration` > `clarify_iteration`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_node_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`node_id` text NOT NULL,
	`parent_node_run_id` text,
	`iteration` integer DEFAULT 0 NOT NULL,
	`shard_key` text,
	`retry_index` integer DEFAULT 0 NOT NULL,
	`review_iteration` integer DEFAULT 0 NOT NULL,
	`clarify_iteration` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	`pid` integer,
	`exit_code` integer,
	`error_message` text,
	`prompt_text` text,
	`tok_input` integer,
	`tok_output` integer,
	`tok_cache_create` integer,
	`tok_cache_read` integer,
	`tok_total` integer,
	`pre_snapshot` text,
	`opencode_session_id` text,
	`inventory_snapshot_json` text,
	`wrapper_progress_json` text,
	`injected_memories_json` text,
	`port_validation_failures_json` text,
	`pre_snapshot_repos_json` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_node_runs` (
	`id`, `task_id`, `node_id`, `parent_node_run_id`, `iteration`, `shard_key`,
	`retry_index`, `review_iteration`, `clarify_iteration`, `status`,
	`started_at`, `finished_at`, `pid`, `exit_code`, `error_message`,
	`prompt_text`, `tok_input`, `tok_output`, `tok_cache_create`, `tok_cache_read`,
	`tok_total`, `pre_snapshot`, `opencode_session_id`, `inventory_snapshot_json`,
	`wrapper_progress_json`, `injected_memories_json`, `port_validation_failures_json`,
	`pre_snapshot_repos_json`
)
SELECT
	`id`, `task_id`, `node_id`, `parent_node_run_id`, `iteration`, `shard_key`,
	`retry_index`, `review_iteration`, `clarify_iteration`, `status`,
	`started_at`, `finished_at`, `pid`, `exit_code`, `error_message`,
	`prompt_text`, `tok_input`, `tok_output`, `tok_cache_create`, `tok_cache_read`,
	`tok_total`, `pre_snapshot`, `opencode_session_id`, `inventory_snapshot_json`,
	`wrapper_progress_json`, `injected_memories_json`, `port_validation_failures_json`,
	`pre_snapshot_repos_json`
FROM `node_runs`;--> statement-breakpoint
DROP TABLE `node_runs`;--> statement-breakpoint
ALTER TABLE `__new_node_runs` RENAME TO `node_runs`;--> statement-breakpoint
CREATE INDEX `idx_node_runs_task` ON `node_runs` (`task_id`, `node_id`, `iteration`, `retry_index`);--> statement-breakpoint
CREATE INDEX `idx_node_runs_parent` ON `node_runs` (`parent_node_run_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
