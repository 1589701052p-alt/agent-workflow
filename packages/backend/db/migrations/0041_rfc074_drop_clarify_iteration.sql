-- RFC-074 PR-C — retire the `node_runs.clarify_iteration` (cci) counter.
--
-- PR-A/PR-B replaced freshness with pure ULID id-order (`isFresherNodeRun`) and
-- provenance (`consumed_upstream_runs_json`). The scalar clarify counter is no
-- longer read OR written by any code path: the clarify "generation" is derived
-- from prior-done id-order at dispatch time, clarify-round aging is the RFC-070
-- consumed-by stamp, and the D11 identity keys (memoryInject generation anchor,
-- lifecycleRepair T2/S3, sessionView prompt sort, lifecycleInvariants U1) all
-- switched to id-order. This migration drops the now-dead column.
--
-- SQLite has no in-place DROP COLUMN in `bun:sqlite`'s bundled runtime for this
-- schema, so we rebuild the table without `clarify_iteration` using the
-- standard 12-step rebuild pattern (cf. migration 0035 which dropped
-- `cross_clarify_iteration` the same way). The new table shape mirrors the
-- current `node_runs` MINUS `clarify_iteration` and INCLUDING
-- `consumed_upstream_runs_json` (added by migration 0040). Column list is
-- explicit on both sides of the copy so the dropped column can never be
-- re-introduced. The platform is pre-prod (no live user data); hard-cut is safe.
--
-- See design/RFC-074-provenance-node-freshness/design.md §6.4 / §9.2.
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
	`commit_push_json` text,
	`pre_snapshot_repos_json` text,
	`consumed_upstream_runs_json` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
INSERT INTO `__new_node_runs` (
	`id`, `task_id`, `node_id`, `parent_node_run_id`, `iteration`, `shard_key`,
	`retry_index`, `review_iteration`, `status`,
	`started_at`, `finished_at`, `pid`, `exit_code`, `error_message`,
	`prompt_text`, `tok_input`, `tok_output`, `tok_cache_create`, `tok_cache_read`,
	`tok_total`, `pre_snapshot`, `opencode_session_id`, `inventory_snapshot_json`,
	`wrapper_progress_json`, `injected_memories_json`, `port_validation_failures_json`,
	`commit_push_json`, `pre_snapshot_repos_json`, `consumed_upstream_runs_json`
)
SELECT
	`id`, `task_id`, `node_id`, `parent_node_run_id`, `iteration`, `shard_key`,
	`retry_index`, `review_iteration`, `status`,
	`started_at`, `finished_at`, `pid`, `exit_code`, `error_message`,
	`prompt_text`, `tok_input`, `tok_output`, `tok_cache_create`, `tok_cache_read`,
	`tok_total`, `pre_snapshot`, `opencode_session_id`, `inventory_snapshot_json`,
	`wrapper_progress_json`, `injected_memories_json`, `port_validation_failures_json`,
	`commit_push_json`, `pre_snapshot_repos_json`, `consumed_upstream_runs_json`
FROM `node_runs`;--> statement-breakpoint
DROP TABLE `node_runs`;--> statement-breakpoint
ALTER TABLE `__new_node_runs` RENAME TO `node_runs`;--> statement-breakpoint
CREATE INDEX `idx_node_runs_task` ON `node_runs` (`task_id`, `node_id`, `iteration`, `retry_index`);--> statement-breakpoint
CREATE INDEX `idx_node_runs_parent` ON `node_runs` (`parent_node_run_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
