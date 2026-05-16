CREATE TABLE `clarify_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`source_agent_node_id` text NOT NULL,
	`source_agent_node_run_id` text NOT NULL,
	`source_shard_key` text,
	`clarify_node_id` text NOT NULL,
	`clarify_node_run_id` text NOT NULL,
	`iteration_index` integer NOT NULL,
	`questions_json` text NOT NULL,
	`answers_json` text,
	`status` text DEFAULT 'awaiting_human' NOT NULL,
	`truncation_warnings_json` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`answered_at` integer,
	`answered_by` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_clarify_sessions_task` ON `clarify_sessions` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_clarify_sessions_clarify_run` ON `clarify_sessions` (`clarify_node_run_id`,`iteration_index`);--> statement-breakpoint
CREATE INDEX `idx_clarify_sessions_source_run` ON `clarify_sessions` (`source_agent_node_run_id`);--> statement-breakpoint
CREATE INDEX `idx_clarify_sessions_node_shard` ON `clarify_sessions` (`clarify_node_id`,`source_shard_key`);--> statement-breakpoint
ALTER TABLE `node_runs` ADD `clarify_iteration` integer DEFAULT 0 NOT NULL;