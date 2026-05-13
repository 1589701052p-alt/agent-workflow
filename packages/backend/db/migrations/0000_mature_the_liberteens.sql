CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`outputs` text DEFAULT '[]' NOT NULL,
	`readonly` integer DEFAULT false NOT NULL,
	`model` text,
	`variant` text,
	`temperature` real,
	`permission` text DEFAULT '{}' NOT NULL,
	`steps` integer,
	`max_steps` integer,
	`skills` text DEFAULT '[]' NOT NULL,
	`frontmatter_extra` text DEFAULT '{}' NOT NULL,
	`body_md` text DEFAULT '' NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
CREATE TABLE `node_run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`node_run_id` text NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_events_node` ON `node_run_events` (`node_run_id`,`id`);--> statement-breakpoint
CREATE TABLE `node_run_outputs` (
	`node_run_id` text NOT NULL,
	`port_name` text NOT NULL,
	`content` text NOT NULL,
	PRIMARY KEY(`node_run_id`, `port_name`),
	FOREIGN KEY (`node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `node_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`node_id` text NOT NULL,
	`parent_node_run_id` text,
	`iteration` integer DEFAULT 0 NOT NULL,
	`shard_key` text,
	`retry_index` integer DEFAULT 0 NOT NULL,
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
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_node_runs_task` ON `node_runs` (`task_id`,`node_id`,`iteration`,`retry_index`);--> statement-breakpoint
CREATE INDEX `idx_node_runs_parent` ON `node_runs` (`parent_node_run_id`);--> statement-breakpoint
CREATE TABLE `recent_repos` (
	`path` text PRIMARY KEY NOT NULL,
	`last_used_at` integer NOT NULL,
	`default_branch` text
);
--> statement-breakpoint
CREATE TABLE `skills` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`source_kind` text NOT NULL,
	`managed_path` text,
	`external_path` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skills_name_unique` ON `skills` (`name`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`workflow_snapshot` text NOT NULL,
	`repo_path` text NOT NULL,
	`worktree_path` text NOT NULL,
	`base_branch` text NOT NULL,
	`branch` text NOT NULL,
	`status` text NOT NULL,
	`inputs` text NOT NULL,
	`max_duration_ms` integer,
	`max_total_tokens` integer,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`error_summary` text,
	`error_message` text,
	`failed_node_id` text,
	`expires_at` integer,
	`deleted_at` integer,
	`schema_version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_tasks_workflow` ON `tasks` (`workflow_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`definition` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
