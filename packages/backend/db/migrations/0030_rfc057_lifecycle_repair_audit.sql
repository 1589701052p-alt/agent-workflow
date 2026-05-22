-- RFC-057 lifecycle_repair_audit. One row per Diagnose-Panel repair action
-- (success or failure). Append-only: the table is consulted to reconstruct
-- "who fixed which wedge how", and downstream RFCs may surface a history UI
-- on top of it. No FK to tasks/lifecycle_alerts on purpose:
--   - tasks may be GC'd (RFC-053 P-2 NodeKindBehavior.gc) but the audit row
--     should outlive its task for post-mortem.
--   - lifecycle_alerts.resolved_at gets stamped immediately on repair, the
--     alert row may later be archived / pruned; the audit row stays.
-- before/after snapshots are scoped to the rows the option actually touched
-- (RepairOptionDef.apply returns them) — full row JSON keeps the audit
-- self-describing without joining back to live tables.
CREATE TABLE `lifecycle_repair_audit` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `alert_id` text,
  `alert_rule` text NOT NULL,
  `alert_detail_json` text NOT NULL,
  `option_id` text NOT NULL,
  `actor_user_id` text,
  `before_snapshot_json` text NOT NULL,
  `after_snapshot_json` text NOT NULL,
  `outcome` text NOT NULL,
  `outcome_message` text,
  `applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_repair_audit_task` ON `lifecycle_repair_audit` (`task_id`, `applied_at`);
--> statement-breakpoint
CREATE INDEX `idx_lifecycle_repair_audit_rule` ON `lifecycle_repair_audit` (`alert_rule`, `applied_at`);
