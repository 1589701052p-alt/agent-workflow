-- RFC-122 — per-(task, asking-node) clarify directive override (hand-written;
-- additive; registered in meta/_journal.json). The two statements are separated
-- by the breakpoint marker below — REQUIRED or only the CREATE TABLE applies and
-- the index is silently dropped (RFC-108 0052/0053 incident; never write that
-- literal token inside a comment, or the migrator splits it off as an empty
-- statement).
--
-- task_node_clarify_directives : one row per (task, asking-agent node) the user
--   has toggled. directive='stop' makes the scheduler force the asking agent out
--   of mandatory ask-back AT DISPATCH (parallel to RFC-056 hasPersistentStop), so
--   a not-yet-run node and an error-retry's fresh run both pick up the latest
--   toggle for free. Absent row ⇒ 'continue' (legacy behavior, byte-for-byte).
--   set_by is the task-member user id (UI/audit only — never enters a prompt).
-- Additive; touches no existing table.
CREATE TABLE IF NOT EXISTS `task_node_clarify_directives` (
	`task_id` text NOT NULL,
	`node_id` text NOT NULL,
	`directive` text NOT NULL,
	`set_by` text,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`task_id`, `node_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_node_clarify_directives_task` ON `task_node_clarify_directives` (`task_id`);
