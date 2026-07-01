-- RFC-130 — per-node isolated worktree bookkeeping (design.md §3.2). Hand-written;
-- additive; registered in meta/_journal.json. Six ALTER statements, each separated
-- by the breakpoint marker on its own line (REQUIRED — without it only the first
-- ALTER applies; the marker must never appear inside a comment, per the RFC-108
-- 0052/0053 incident).
--
-- All columns default NULL. Legacy / non-isolated node_runs keep merge_state NULL,
-- which the scheduler's frontier / resume gates treat as "not an isolated run"
-- (golden-lock: byte-for-byte pre-RFC-130 behavior). No backfill needed.
ALTER TABLE `node_runs` ADD COLUMN `iso_worktree_path` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `iso_base_snapshot` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `iso_base_snapshot_repos_json` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `iso_node_tree` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `iso_node_tree_repos_json` text;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `merge_state` text;
