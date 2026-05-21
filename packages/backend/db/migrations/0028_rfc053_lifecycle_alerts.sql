-- RFC-053 P-3 lifecycle_alerts. One row per (task_id, rule, detection round)
-- captures a violation of one of the seven double-layer invariants (R1/R2/C1/
-- T1/T2/T3/U1) found by services/lifecycleInvariants.ts. Service-side upsert
-- treats rows with resolved_at IS NULL as "open": new findings on the same
-- (task, rule) update the existing open row instead of inserting; a later
-- scan that no longer sees the violation flips resolved_at to now.
--
-- severity is 'warning' for the first 24h after detected_at (grace period
-- for historic stuck tasks), then upgraded to 'error' on the next scan.
-- detail is a JSON blob naming the row ids involved (varies per rule).
CREATE TABLE `lifecycle_alerts` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `rule` text NOT NULL,
  `severity` text NOT NULL,
  `detail` text NOT NULL,
  `detected_at` integer NOT NULL,
  `resolved_at` integer
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_alerts_task` ON `lifecycle_alerts` (`task_id`, `detected_at`);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_alerts_open` ON `lifecycle_alerts` (`resolved_at`, `severity`);
