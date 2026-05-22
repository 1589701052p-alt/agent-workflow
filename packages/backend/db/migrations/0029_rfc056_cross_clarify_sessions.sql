-- RFC-056 cross_clarify_sessions. One row per (cross-clarify node × loop_iter
-- × iteration) capturing a `<workflow-clarify>` envelope produced by a
-- downstream questioner agent. Mirrors RFC-023 clarify_sessions but with
-- additional FK columns linking back to the upstream designer (the agent
-- whose rerun is triggered on submit) and the cross-clarify node itself.
--
-- Notable columns:
-- * directive — null while awaiting_human; set to 'continue' on submit
--   (questions feed designer's rerun via External Feedback) or 'stop' on
--   reject (questioner gets STOP CLARIFYING + cross-clarify node never
--   re-enters awaiting_human in this task).
-- * status   — 'awaiting_human' (default) → 'answered' (submit/reject) or
--   'abandoned' (RFC-053 invariant CR-1 upgrades on parent task fail).
-- * loop_iter — wrapper-loop iteration index (0 outside loops). Lets the
--   cross-clarify reject-persistence carry across iterations while Q&A
--   history resets per loop iter (see RFC-056 design.md §9).
-- * target_designer_node_id — manual-edge resolved designer NodeId at
--   spawn time. NULL means runtime found no designer (the
--   `cross-clarify-manual-edge-missing` warning's runtime echo).
CREATE TABLE `cross_clarify_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`cross_clarify_node_id` text NOT NULL,
	`cross_clarify_node_run_id` text NOT NULL,
	`source_questioner_node_id` text NOT NULL,
	`source_questioner_node_run_id` text NOT NULL,
	`target_designer_node_id` text,
	`loop_iter` integer DEFAULT 0 NOT NULL,
	`iteration` integer DEFAULT 0 NOT NULL,
	`questions_json` text NOT NULL,
	`answers_json` text,
	`directive` text,
	`status` text DEFAULT 'awaiting_human' NOT NULL,
	`designer_run_triggered_at` integer,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`answered_at` integer,
	`abandoned_at` integer,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`cross_clarify_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_questioner_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_cross_clarify_sessions_task` ON `cross_clarify_sessions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_cross_clarify_sessions_node` ON `cross_clarify_sessions` (`cross_clarify_node_id`,`loop_iter`,`iteration`);--> statement-breakpoint
CREATE INDEX `idx_cross_clarify_sessions_designer` ON `cross_clarify_sessions` (`target_designer_node_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_cross_clarify_sessions_status` ON `cross_clarify_sessions` (`status`);--> statement-breakpoint
ALTER TABLE `node_runs` ADD `cross_clarify_iteration` integer DEFAULT 0 NOT NULL;
