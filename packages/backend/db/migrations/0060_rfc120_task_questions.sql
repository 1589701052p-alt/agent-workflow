-- RFC-120 PR-A — task question list / 任务中心 (hand-written; additive; registered
-- in meta/_journal.json). Statements are separated by the breakpoint marker below
-- — REQUIRED or only the first applies silently (RFC-108 0052/0053 incident; never
-- write that literal token inside a comment, or the migrator splits the comment
-- off as an empty statement).
--
-- task_questions : one tracked entry per (clarify question × handler role) for the
--   task's question ledger. Auto-collected from every clarify round (self + cross,
--   historical + new). Execution phases (待处理/处理中/已处理待确认) are DERIVED at
--   read time from the handler node_run — NOT stored; only the manual overlay
--   (confirmation + override target + audit) and the round/role identity persist.
--   role_kind ∈ {self, questioner, designer}; only designer is re-targetable
--   (override_target_node_id). reopen edits the answer in place + re-fires the
--   handler (prior_answer_snapshot_json keeps the pre-edit answer for audit).
-- Additive; touches no existing table.
CREATE TABLE IF NOT EXISTS `task_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`origin_node_run_id` text NOT NULL,
	`question_id` text NOT NULL,
	`question_title` text NOT NULL,
	`source_kind` text NOT NULL,
	`role_kind` text NOT NULL,
	`iteration` integer DEFAULT 0 NOT NULL,
	`loop_iter` integer DEFAULT 0 NOT NULL,
	`default_target_node_id` text,
	`override_target_node_id` text,
	`trigger_run_id` text,
	`confirmation` text DEFAULT 'open' NOT NULL,
	`confirmed_by` text,
	`confirmed_by_role` text,
	`confirmed_at` integer,
	`last_reassigned_by` text,
	`last_reassigned_at` integer,
	`reopen_count` integer DEFAULT 0 NOT NULL,
	`prior_answer_snapshot_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_questions_task` ON `task_questions` (`task_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_questions_origin` ON `task_questions` (`origin_node_run_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `uniq_task_questions_identity` ON `task_questions` (`origin_node_run_id`,`question_id`,`role_kind`);
