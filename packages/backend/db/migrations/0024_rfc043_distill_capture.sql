-- RFC-043: Distill job detail page support.
--
-- Extends memory_distill_jobs with 5 new columns to retain the artefacts
-- of each distill subprocess run (opencode session id, user prompt, exit
-- code, stderr excerpt, dedup snapshot) and adds memory_distill_events to
-- mirror node_run_events for the distiller subprocess, so the admin
-- /memory/distill-jobs/$jobId detail page can replay the conversation
-- using the same RFC-027 ConversationFlow component used for worker nodes.
--
-- All new columns on memory_distill_jobs are nullable so pre-migration
-- rows survive untouched (detail page renders empty Section placeholders
-- for legacy jobs).
ALTER TABLE `memory_distill_jobs` ADD COLUMN `opencode_session_id` text;--> statement-breakpoint
ALTER TABLE `memory_distill_jobs` ADD COLUMN `user_prompt_md` text;--> statement-breakpoint
ALTER TABLE `memory_distill_jobs` ADD COLUMN `exit_code` integer;--> statement-breakpoint
ALTER TABLE `memory_distill_jobs` ADD COLUMN `stderr_excerpt` text;--> statement-breakpoint
ALTER TABLE `memory_distill_jobs` ADD COLUMN `dedup_snapshot_ids_json` text;--> statement-breakpoint
CREATE TABLE `memory_distill_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`distill_job_id` text NOT NULL,
	`attempt_index` integer NOT NULL,
	`session_id` text NOT NULL,
	`parent_session_id` text,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	FOREIGN KEY (`distill_job_id`) REFERENCES `memory_distill_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_distill_events_job_attempt` ON `memory_distill_events` (`distill_job_id`,`attempt_index`,`ts`);--> statement-breakpoint
CREATE INDEX `idx_distill_events_session` ON `memory_distill_events` (`distill_job_id`,`session_id`,`ts`);
