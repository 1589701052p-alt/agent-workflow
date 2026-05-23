-- RFC-061 PR-A T1 — Event-sourced execution model schema (foundation).
--
-- Establishes the storage layer for the new execution architecture per
-- design/RFC-061-execution-event-sourced/design.md §2:
--
--   events           append-only single source of truth
--   logical_runs     projection: one row per (scope, iter) entry
--   attempts         projection: one row per opencode subprocess
--   node_outputs     projection: structured outputs keyed by (scope, port)
--   suspensions      projection: open + resolved Suspensions
--   projection_meta  single-row cursor + rebuild bookkeeping
--
-- PR-A is **infrastructure only** — these tables exist but the hot path
-- still flows through node_runs / clarify_rounds / etc. PR-B switches the
-- backend to write into events + projections and DROPs the legacy tables.
--
-- shard_key encoding: design.md §2 documents shard_key as nullable. To make
-- the natural UNIQUE constraints work under SQLite's "NULL ≠ NULL" semantics
-- (which would otherwise let `(t, n, 0, NULL, 0)` coexist with itself), we
-- encode "non-fanout scope" as the empty string `''` rather than NULL. All
-- callers must use `''` for non-fanout scopes; fanout scopes carry the
-- shard key string (file path, group id, etc.) verbatim.
--
-- INV-1 (events append-only) is enforced by `events_no_update` trigger plus
-- a grep guard in test code that forbids raw `db.update(events).set(...)`
-- and `db.delete(events).where(...)` outside `writeEvents.ts`. We deliberately
-- do NOT add a DELETE trigger because tasks may CASCADE-delete events during
-- the launch-failure rollback path (task.ts:342) which fires before any
-- events exist for the task. The application-level immutability guarantee
-- is the contract; the DB trigger is belt-only for UPDATEs.
--
-- INV-3 / INV-4 / INV-5 enforced by partial unique / full unique indexes
-- below; the design.md §13 list of invariants matches one-for-one.

CREATE TABLE `events` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `ts` integer NOT NULL,
  `kind` text NOT NULL CHECK (`kind` IN (
    -- task-level
    'task-created',
    'task-started',
    'task-paused',
    'task-canceled',
    'task-completed',
    'task-failed',
    'task-resumed-after-daemon-restart',
    -- logical-run-level
    'logical-run-created',
    'logical-run-iter-bumped',
    'logical-run-completed',
    'logical-run-canceled',
    -- attempt-level
    'attempt-started',
    'attempt-finished-success',
    'attempt-finished-envelope-fail',
    'attempt-finished-crash',
    'attempt-finished-timeout',
    'attempt-canceled',
    'attempt-output-captured',
    'attempt-subagent-tool-use',
    'attempt-subagent-output',
    -- suspension-level
    'suspension-created',
    'suspension-resolved',
    'suspension-terminated',
    -- invariant
    'invariant-alert-detected',
    'invariant-alert-resolved'
  )),
  `node_id` text,
  `loop_iter` integer,
  `shard_key` text,
  `iter` integer,
  `attempt_id` text,
  `parent_event_id` text,
  `actor` text NOT NULL,
  `resolution_id` text,
  `payload` text NOT NULL DEFAULT '{}',
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_events_task_ts` ON `events` (`task_id`, `ts`);
--> statement-breakpoint
CREATE INDEX `idx_events_scope` ON `events` (`task_id`, `node_id`, `loop_iter`, `shard_key`, `iter`);
--> statement-breakpoint
CREATE INDEX `idx_events_kind` ON `events` (`task_id`, `kind`);
--> statement-breakpoint
CREATE INDEX `idx_events_parent` ON `events` (`parent_event_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_events_resolution` ON `events` (`resolution_id`) WHERE `resolution_id` IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `events_no_update`
BEFORE UPDATE ON `events`
BEGIN
  SELECT RAISE(ABORT, 'INV-1: events table is append-only; UPDATE forbidden');
END;
--> statement-breakpoint

CREATE TABLE `logical_runs` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `node_id` text NOT NULL,
  `loop_iter` integer NOT NULL DEFAULT 0,
  `shard_key` text NOT NULL DEFAULT '',
  `iter` integer NOT NULL,
  `status` text NOT NULL CHECK (`status` IN (
    'pending', 'running', 'suspended', 'done', 'failed', 'canceled'
  )),
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  `last_event_id` text NOT NULL,
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_logical_runs_scope` ON `logical_runs` (`task_id`, `node_id`, `loop_iter`, `shard_key`, `iter`);
--> statement-breakpoint
CREATE INDEX `idx_logical_runs_status` ON `logical_runs` (`task_id`, `status`);
--> statement-breakpoint
CREATE INDEX `idx_logical_runs_scope_query` ON `logical_runs` (`task_id`, `node_id`, `loop_iter`, `shard_key`);
--> statement-breakpoint

CREATE TABLE `attempts` (
  `id` text PRIMARY KEY NOT NULL,
  `logical_run_id` text NOT NULL,
  `attempt_seq` integer NOT NULL,
  `pid` integer,
  `opencode_session_id` text,
  `started_at` integer NOT NULL,
  `finished_at` integer,
  `outcome` text CHECK (`outcome` IS NULL OR `outcome` IN (
    'success', 'envelope-fail', 'crash', 'timeout', 'canceled'
  )),
  `exit_code` integer,
  `error_message` text,
  `pre_snapshot` text,
  FOREIGN KEY (`logical_run_id`) REFERENCES `logical_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_attempts_seq` ON `attempts` (`logical_run_id`, `attempt_seq`);
--> statement-breakpoint

CREATE TABLE `node_outputs` (
  `task_id` text NOT NULL,
  `node_id` text NOT NULL,
  `loop_iter` integer NOT NULL DEFAULT 0,
  `shard_key` text NOT NULL DEFAULT '',
  `iter` integer NOT NULL,
  `port_name` text NOT NULL,
  `content` text NOT NULL,
  `captured_at` integer NOT NULL,
  `source_event_id` text NOT NULL,
  PRIMARY KEY (`task_id`, `node_id`, `loop_iter`, `shard_key`, `iter`, `port_name`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE TABLE `suspensions` (
  `id` text PRIMARY KEY NOT NULL,
  `logical_run_id` text NOT NULL,
  `signal_kind` text NOT NULL CHECK (`signal_kind` IN (
    'self-clarify', 'cross-clarify', 'review',
    'retry-pending-auto', 'retry-pending-human', 'await-external-data'
  )),
  `awaits_actor` text NOT NULL,
  `payload` text NOT NULL,
  `created_at` integer NOT NULL,
  `resolved_at` integer,
  `resolved_by_event_id` text,
  FOREIGN KEY (`logical_run_id`) REFERENCES `logical_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_suspensions_open` ON `suspensions` (`logical_run_id`) WHERE `resolved_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_suspensions_kind` ON `suspensions` (`signal_kind`, `resolved_at`);
--> statement-breakpoint
CREATE INDEX `idx_suspensions_open` ON `suspensions` (`resolved_at`) WHERE `resolved_at` IS NULL;
--> statement-breakpoint

CREATE TABLE `projection_meta` (
  `id` integer PRIMARY KEY CHECK (`id` = 1),
  `last_processed_event_id` text,
  `rebuilt_at` integer NOT NULL
);
