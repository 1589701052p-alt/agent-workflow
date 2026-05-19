-- RFC-041: Platform long-term memory. Three new tables backing the
-- "distill clarify/review/feedback → admin-approve → silent inject"
-- pipeline (see design/RFC-041-platform-long-term-memory/design.md).
--
--   memories             — single source of truth for memory rows
--   memory_distill_jobs  — queue consumed by the 1Hz daemon worker
--   task_feedback        — per-task user notes; each row → distill_jobs row
--
-- Initial state is empty — no backfill needed. The CHECK constraint on
-- memories enforces "global scope_id IS NULL; non-global scope_id NOT
-- NULL" at the DB layer so a buggy writer cannot create an unrouteable row.
CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`title` text NOT NULL,
	`body_md` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`status` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_event_id` text,
	`source_task_id` text,
	`distill_job_id` text,
	`distill_action` text,
	`supersedes_id` text,
	`superseded_by_id` text,
	`approved_by_user_id` text,
	`approved_at` integer,
	`created_at` integer NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CHECK (`scope_type` IN ('agent','workflow','repo','global')),
	CHECK (`status` IN ('candidate','approved','archived','superseded','rejected')),
	CHECK (`source_kind` IN ('clarify','review','feedback','manual')),
	CHECK (`distill_action` IS NULL OR `distill_action` IN ('new','update_of','duplicate_of','conflict_with')),
	CHECK (
		(`scope_type` = 'global' AND `scope_id` IS NULL) OR
		(`scope_type` != 'global' AND `scope_id` IS NOT NULL)
	),
	FOREIGN KEY (`supersedes_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`superseded_by_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_memories_scope_status` ON `memories` (`scope_type`,`scope_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_memories_status_created` ON `memories` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_memories_supersedes` ON `memories` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `idx_memories_source` ON `memories` (`source_kind`,`source_event_id`);--> statement-breakpoint
CREATE TABLE `memory_distill_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`debounce_key` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_event_id` text NOT NULL,
	`task_id` text,
	`scope_resolved_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_run_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CHECK (`source_kind` IN ('clarify','review','feedback')),
	CHECK (`status` IN ('pending','running','done','failed','canceled'))
);
--> statement-breakpoint
CREATE INDEX `idx_distill_jobs_status_next` ON `memory_distill_jobs` (`status`,`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_distill_jobs_debounce` ON `memory_distill_jobs` (`debounce_key`,`status`);--> statement-breakpoint
CREATE INDEX `idx_distill_jobs_task` ON `memory_distill_jobs` (`task_id`,`source_kind`);--> statement-breakpoint
CREATE TABLE `task_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`author_user_id` text,
	`body_md` text NOT NULL,
	`created_at` integer NOT NULL,
	`distilled` integer DEFAULT 0 NOT NULL,
	`distill_job_id` text
);
--> statement-breakpoint
CREATE INDEX `idx_task_feedback_task` ON `task_feedback` (`task_id`,`created_at`);
