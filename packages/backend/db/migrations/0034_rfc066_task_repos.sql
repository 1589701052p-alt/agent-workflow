-- RFC-066 — Multi-Repo Task Launch. Introduces a new `task_repos` table that
-- holds one row per repo associated with a task. Single-repo tasks have a
-- length-1 row; multi-repo tasks (repos.length > 1 at launch) have N entries
-- sorted by `repo_index` ascending. The legacy `tasks.repo_path` /
-- `tasks.repo_url` / `tasks.worktree_path` / `tasks.base_branch` /
-- `tasks.branch` / `tasks.base_commit` columns are kept as mirrors of
-- `task_repos[0]` so existing API consumers continue to work without
-- knowing about the new table.
--
-- New columns added in this migration:
--   - `tasks.repo_count` — denormalized count of `task_repos` rows. NOT NULL
--     DEFAULT 1; backfilled to 1 for every existing task by virtue of the
--     1-row INSERT below.
--   - `node_runs.pre_snapshot_repos_json` — per-repo stash sha map serialized
--     as `{ "<worktree_dir_name>": "<git-stash-sha>", ... }`. Used by the
--     multi-repo resume path to roll back each per-repo worktree. NULL for
--     single-repo tasks (which continue to use the existing `pre_snapshot`
--     single-string column) and for read-only node runs in any task.
--
-- Backfill: every existing task gets a single `task_repos` row with
-- `repo_index = 0` mirroring the legacy `tasks.*` columns. `worktree_dir_name`
-- is the empty string for legacy single-repo tasks (where the worktree IS
-- the repo, no parent multi-repo dir is involved).
--
-- This migration is purely additive: no DROP, no rename, no schema-tightening
-- CHECK constraints. Roll-back is `DROP TABLE task_repos; ALTER TABLE tasks
-- DROP COLUMN repo_count; ALTER TABLE node_runs DROP COLUMN
-- pre_snapshot_repos_json;`.
--
-- See design/RFC-066-multi-repo-task-launch/design.md §1 for the full
-- rationale and §6 for the back-compat strategy.

CREATE TABLE `task_repos` (
  `task_id` text NOT NULL,
  `repo_index` integer NOT NULL,
  `repo_path` text NOT NULL,
  `repo_url` text,
  `base_branch` text NOT NULL DEFAULT '',
  `branch` text NOT NULL,
  `base_commit` text,
  `worktree_path` text NOT NULL,
  `worktree_dir_name` text NOT NULL DEFAULT '',
  `has_submodules` integer,
  `submodule_init_ok` integer,
  `submodule_init_error` text,
  `schema_version` integer NOT NULL DEFAULT 1,
  PRIMARY KEY (`task_id`, `repo_index`),
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_task_repos_repo_path` ON `task_repos` (`repo_path`);
--> statement-breakpoint
CREATE INDEX `idx_task_repos_repo_url` ON `task_repos` (`repo_url`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `repo_count` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
ALTER TABLE `node_runs` ADD COLUMN `pre_snapshot_repos_json` text;
--> statement-breakpoint
INSERT INTO `task_repos` (
  `task_id`, `repo_index`, `repo_path`, `repo_url`, `base_branch`,
  `branch`, `base_commit`, `worktree_path`, `worktree_dir_name`,
  `has_submodules`, `submodule_init_ok`, `submodule_init_error`,
  `schema_version`
)
SELECT
  `id`, 0, `repo_path`, `repo_url`, `base_branch`,
  `branch`, `base_commit`, `worktree_path`, '',
  NULL, NULL, NULL,
  1
FROM `tasks`;
