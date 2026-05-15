CREATE TABLE `doc_versions` (
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
	`agent_snapshot` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`review_node_run_id`) REFERENCES `node_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_doc_versions_review_run` ON `doc_versions` (`review_node_run_id`,`version_index`);--> statement-breakpoint
CREATE INDEX `idx_doc_versions_task` ON `doc_versions` (`task_id`);--> statement-breakpoint
CREATE TABLE `review_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`doc_version_id` text NOT NULL,
	`anchor_section_path` text NOT NULL,
	`anchor_paragraph_idx` integer NOT NULL,
	`anchor_offset_start` integer NOT NULL,
	`anchor_offset_end` integer NOT NULL,
	`selected_text` text NOT NULL,
	`context_before` text NOT NULL,
	`context_after` text NOT NULL,
	`occurrence_index` integer NOT NULL,
	`comment_text` text NOT NULL,
	`author` text DEFAULT 'local' NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`doc_version_id`) REFERENCES `doc_versions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_review_comments_version` ON `review_comments` (`doc_version_id`,`anchor_section_path`);--> statement-breakpoint
ALTER TABLE `node_runs` ADD `review_iteration` integer DEFAULT 0 NOT NULL;