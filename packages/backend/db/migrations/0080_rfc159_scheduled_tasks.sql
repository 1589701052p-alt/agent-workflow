-- RFC-159 — scheduled tasks (hand-written; additive; registered in meta/_journal.json).
--
-- New `scheduled_tasks` table: a saved task-launcher the daemon re-fires on a
-- schedule (interval / friendly preset). Stores the full StartTask launch body as
-- JSON so fires replay identical parameters. Plus a nullable `scheduled_task_id`
-- link column on `tasks` (stamped atomically inside the task INSERT) so a
-- schedule's run history + count derive durably from the tasks themselves.
--
-- Purely additive: no backfill. Existing task rows keep scheduled_task_id = NULL
-- (= manually launched), which is the correct semantics. See
-- design/RFC-159-scheduled-tasks/design.md §1/§10.
CREATE TABLE IF NOT EXISTS `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`launch_payload` text NOT NULL,
	`schedule_spec` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`next_run_at` integer,
	`last_run_at` integer,
	`last_status` text,
	`last_error` text,
	`last_task_id` text,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scheduled_tasks_due` ON `scheduled_tasks` (`enabled`,`next_run_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_scheduled_tasks_owner` ON `scheduled_tasks` (`owner_user_id`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `scheduled_task_id` text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_tasks_scheduled_task` ON `tasks` (`scheduled_task_id`);
