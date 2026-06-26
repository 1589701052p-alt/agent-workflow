-- RFC-108 T3 (AR-11) recovery_events audit (hand-written, append-only).
CREATE TABLE IF NOT EXISTS `recovery_events` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text,
  `node_run_id` text,
  `actor` text NOT NULL,
  `kind` text NOT NULL,
  `reason` text,
  `before_json` text,
  `after_json` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_recovery_events_task` ON `recovery_events` (`task_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_recovery_events_kind` ON `recovery_events` (`kind`, `created_at`);
