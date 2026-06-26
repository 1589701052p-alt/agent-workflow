-- RFC-108 T3 (AR-11) — recovery_events audit (additive, hand-written; the repo
-- stopped using drizzle-kit generate after 0012, so every migration since 0013
-- is authored by hand and registered in meta/_journal.json).
--
-- A unified append-only audit of EVERY system-initiated recovery action — boot
-- orphan-reap, graceful-shutdown survivor flip, resource-limit cancel,
-- snapshot-lost / live-child-survived escalation, and (when those land)
-- auto-resume / auto-repair / heartbeat-kill / quarantine. Before this, those
-- actors only `log.warn`'d, so a daemon that silently reaped 50 orphans every
-- restart looked identical to a healthy one. lifecycle_repair_audit covers only
-- MANUAL repair clicks; this is the system-actor counterpart.
CREATE TABLE `recovery_events` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text,
  `node_run_id` text,
  `actor` text NOT NULL,        -- 'system' or a user id
  `kind` text NOT NULL,         -- boot-reap | shutdown-flip | limit-cancel | snapshot-lost | live-child-survived | auto-resume | auto-repair | heartbeat-kill | quarantine | ...
  `reason` text,
  `before_json` text,
  `after_json` text,
  `created_at` integer NOT NULL
);
CREATE INDEX `idx_recovery_events_task` ON `recovery_events` (`task_id`, `created_at`);
CREATE INDEX `idx_recovery_events_kind` ON `recovery_events` (`kind`, `created_at`);
